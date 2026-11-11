// SPDX-License-Identifier: MIT
/** apps/toolhost/test/git-appelant-coffre.test.ts — appelant d'un outil git signé comme l'hôte le signe (`_meta` de la boucle du core → identité de l'appel → compte du rappel) : politique du coffre (sous-agents, routines) appliquée par le core au jeton, à sa présence et à la PR, journal avec la conversation et le run, cache court séparé par appelant (SQLite, PostgreSQL si ELPIS_TEST_PG). */
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createUser, creerGardes, dependancesParDefaut, installerAuth } from "@elpis/auth";
import type { Dict } from "@elpis/commun";
import { surchargerConfig } from "@elpis/config";
import { initialiserBase } from "@elpis/db";
import { ouvrirBaseDeTest, PG_DE_TEST } from "@elpis/db/test";
import type { BaseDeTest } from "@elpis/db/test";
import type { CompteRappel } from "@elpis/fichiers";
import {
  avecIdentite,
  configurerCoffre,
  configureAudit,
  fromMeta,
  oublierConfigurationAudit,
} from "@elpis/securite";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildCallMeta } from "../../core/src/boucle/dispatch-outils";
import { creerFamilleInterneToolhost } from "../../core/src/familles/interne-toolhost";
import { createConnector, getConnector } from "../../core/src/git/connecteurs";
import { runChatKey } from "../../core/src/routines/planificateur";
import { modifierSecret } from "../../core/src/secrets/stockage";
import { appTest, journalMuet as journalCore } from "../../core/test/aides";
import { appelDe, CompteGit } from "../src/mcp/git/commun";
import { ClientRappel } from "../src/rappel";
import { journalMuet } from "./aides";

const MOTEURS = PG_DE_TEST ? (["sqlite", "postgres"] as const) : (["sqlite"] as const);
const SVC = "svc-appelant-git";
const URL_DEPOT = "https://forge.example/o/r.git";

describe.each(MOTEURS)("appelant d'un outil git signé comme l'hôte le signe (%s)", (moteur) => {
  let t: BaseDeTest;
  let app: FastifyInstance;
  let rappel: ClientRappel;
  let dossier = "";
  let journal = "";
  let bob = 0;
  let sid = 0;
  let restaurer: () => void = () => undefined;
  const acteur = (): { userId: number; username: string } => ({ userId: bob, username: "bob" });

  /** Événements du journal de sécurité d'une action. */
  const evenements = (action: string): Dict[] =>
    readdirSync(journal)
      .filter((n) => n.endsWith(".jsonl"))
      .flatMap((n) => readFileSync(join(journal, n), "utf8").split("\n"))
      .filter((l) => l.startsWith("{"))
      .map((l) => JSON.parse(l) as Dict)
      .filter((l) => l["action"] === action);

  const usages = async (): Promise<number> =>
    Number(
      (await t.base.get<{ n: number }>("SELECT use_count AS n FROM vault_secrets WHERE id = ?", [sid]))?.n,
    );

  /** `_meta` posé par la boucle du core pour un appel local (chat, sous-agent, run de routine). */
  const meta = (chatId: string, enfant: string | null = null): Dict =>
    buildCallMeta({
      isLocal: true,
      username: "bob",
      chatId,
      liveShell: false,
      callId: "call-1",
      runLogTok: "jeton-run",
      userId: bob,
      subagent: enfant === null ? null : { type: "explore", id: enfant, read_only: true },
    }) as Dict;

  /** Compte du rappel tel que l'hôte le construit : identité de l'appel posée depuis le `_meta`, appelant lu par la famille git. */
  const compte = (m: Dict): CompteRappel =>
    avecIdentite(fromMeta(m), () => new CompteGit("bob", null, rappel, appelDe({ meta: m })).compte(bob));

  const politique = (p: { subagents: boolean; routines: boolean }): Promise<unknown> =>
    modifierSecret(t.base, bob, sid, { policy: p }, acteur());

  beforeAll(async () => {
    dossier = mkdtempSync(join(tmpdir(), "elpis-git-appelant-"));
    journal = join(dossier, "journal");
    mkdirSync(journal);
    configurerCoffre({
      cleEnv: randomBytes(32).toString("base64"),
      systeme: join(dossier, "absente.key"),
      repli: join(dossier, ".vault.key"),
    });
    configureAudit({ service: "main", auditDir: journal, hmacKeyPath: "/nonexistent" });
    restaurer = surchargerConfig({ LOCAL_MCP_TOKEN: SVC });
    t = ouvrirBaseDeTest(moteur);
    await initialiserBase(t.base);
    bob = await createUser(t.base, "bob", "mdp-bob");
    const cid = await createConnector(
      t.base,
      bob,
      "generic",
      "forge.example",
      { token: "tok-appelant", username: "ci" },
      acteur(),
    );
    sid = Number((await getConnector(t.base, bob, cid))?.secret_id);
    const auth = { ...dependancesParDefaut(t.base, () => SVC) };
    app = await appTest({
      familles: [creerFamilleInterneToolhost({ auth, journal: journalCore })],
      gardes: creerGardes(auth),
      extensions: [(a) => installerAuth(a, auth)],
    });
    await app.listen({ port: 0, host: "127.0.0.1" });
    rappel = new ClientRappel({
      appUrl: `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`,
      jeton: SVC,
      journal: journalMuet,
    });
  });

  afterAll(async () => {
    restaurer();
    oublierConfigurationAudit();
    app.server.closeAllConnections();
    await app.close();
    await t.fermer();
    rmSync(dossier, { recursive: true, force: true });
  });

  it("sous-agents et routines refusés par la politique : ni jeton (l'entrée du parent en cache ne sert pas), ni présence ; refus journalisé avec le sous-agent et le run ; seul le chat compte un usage", async () => {
    await politique({ subagents: false, routines: false });
    const chat = compte(meta("chat-1"));
    const enfant = compte(meta("chat-1#task-a1", "a1"));
    const routine = compte(meta(runChatKey(4, 9)));
    const enfantDeRoutine = compte(meta(`${runChatKey(4, 9)}#task-b2`, "b2"));
    expect(chat).toEqual({ user_id: bob, username: "bob", chat_id: "chat-1" });
    expect(enfant).toMatchObject({ chat_id: "chat-1#task-a1", subagent: { type: "explore", id: "a1" } });
    expect(await rappel.gitCredential(chat, URL_DEPOT)).toMatchObject({
      token: "tok-appelant",
      username: "ci",
    });
    for (const c of [enfant, routine, enfantDeRoutine])
      expect(await rappel.gitCredential(c, URL_DEPOT), JSON.stringify(c)).toBeNull();
    expect(await usages()).toBe(1);
    expect(evenements("vault.secret.used").at(-1)).toMatchObject({
      user_id: bob,
      details: { usage: "git", chat_id: "chat-1", run: null, subagent: false },
    });
    const refus = evenements("vault.secret.refused").slice(-3);
    expect(refus.map((e) => e["details"])).toEqual([
      expect.objectContaining({
        code: "secret_not_attached",
        chat_id: "chat-1#task-a1",
        run: null,
        subagent: true,
      }),
      expect.objectContaining({
        code: "secret_not_attached",
        chat_id: "routine:4:run:9",
        run: "routine:4:run:9",
        subagent: false,
      }),
      expect.objectContaining({ code: "secret_not_attached", run: "routine:4:run:9", subagent: true }),
    ]);
    expect(await rappel.identifiantGitDisponible(chat, URL_DEPOT)).toBe(true);
    for (const c of [enfant, routine, enfantDeRoutine])
      expect(await rappel.identifiantGitDisponible(c, URL_DEPOT)).toBe(false);
    expect(await usages()).toBe(1);
  });

  it("PR ouverte pour un sous-agent refusé : repli sans jeton ; pour le chat : jeton lu (connecteur générique, pas d'API)", async () => {
    await politique({ subagents: false, routines: false });
    const demande = {
      remote_url: URL_DEPOT,
      head: "agent/x",
      base: "main",
      title: "t",
      body: "",
      draft: true,
    };
    const avant = await usages();
    expect(await rappel.ouvrirPr(compte(meta("chat-2#task-c3", "c3")), demande)).toMatchObject({
      outcome: "fallback",
    });
    expect(await usages()).toBe(avant);
    expect(await rappel.ouvrirPr(compte(meta("chat-2")), demande)).toMatchObject({ outcome: "no_api" });
    expect(await usages()).toBe(avant + 1);
  });

  it("politique qui les permet : sous-agent et routine lisent le jeton, journal avec le sous-agent et le run", async () => {
    await politique({ subagents: true, routines: true });
    rappel.viderCache();
    expect((await rappel.gitCredential(compte(meta("chat-3#task-d4", "d4")), URL_DEPOT))?.["token"]).toBe(
      "tok-appelant",
    );
    expect(evenements("vault.secret.used").at(-1)).toMatchObject({ details: { subagent: true, run: null } });
    expect((await rappel.gitCredential(compte(meta(runChatKey(5, 1))), URL_DEPOT))?.["token"]).toBe(
      "tok-appelant",
    );
    expect(evenements("vault.secret.used").at(-1)).toMatchObject({
      details: { subagent: false, run: "routine:5:run:1", chat_id: "routine:5:run:1" },
    });
  });
});
