// SPDX-License-Identifier: MIT
/** apps/core/test/mcp/familles-compte.test.ts — familles todo et memory servies en processus (SQLite et PostgreSQL) : client `inprocess` du pool, identité, validation, fichiers de la mémoire, liste du chat, plafond de mots, composition. */
import "../moteur-environnement";

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createUser, getUser } from "@elpis/auth";
import { config, invalidateConfigCache, surchargerConfig } from "@elpis/config";
import { initialiserBase } from "@elpis/db";
import { ouvrirBaseDeTest, PG_DE_TEST } from "@elpis/db/test";
import type { BaseDeTest } from "@elpis/db/test";
import { load, oublierManifeste } from "@elpis/mcp";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { getChatTodos, upsertChat } from "../../src/chats/stockage";
import { brancherFamillesDuCompte } from "../../src/composition";
import { familyCfg } from "../../src/outils/openapi";
import { installerComptesMemoire } from "../../src/memoire";
import { MAX_MOTS_REQUETE, sessionSearch } from "../../src/memoire/outil";
import { sessionIndexMessages } from "../../src/memoire/sessions";
import { executerOutilMcp, poolMcp, resoudreClientMcp } from "../../src/outils/mcp/clients";
import { toolTraits } from "../../src/outils/traits";
import {
  creerServeurEnProcessus,
  oublierServeurEnProcessus,
  serveurEnProcessus,
  serviceEnProcessus,
} from "../../src/outils/mcp/en-processus";

type Dict = Record<string, unknown>;

const MOTEURS = PG_DE_TEST ? (["sqlite", "postgres"] as const) : (["sqlite"] as const);

const texteDe = (r: unknown): string =>
  (((r as Dict)["content"] as Dict[] | undefined) ?? []).map((c) => String(c["text"])).join("");

describe.each(MOTEURS)("familles todo et memory servies en processus (%s)", (moteur) => {
  let t: BaseDeTest;
  let dossier: string;
  let restaurer: () => void;
  let uid = 0;
  let refBob = 0;

  beforeAll(async () => {
    t = ouvrirBaseDeTest(moteur);
    await initialiserBase(t.base);
    await createUser(t.base, "alice", "mdp-alice", { isAdmin: 0 });
    await createUser(t.base, "bob", "mdp-bob", { isAdmin: 0 });
    uid = (await getUser(t.base, "alice"))?.id ?? 0;
    const uidBob = (await getUser(t.base, "bob"))?.id ?? 0;
    await upsertChat(t.base, uid, "c1", "Projet Zéphyr", [], 1_700_000_000);
    await sessionIndexMessages(t.base, [
      {
        user_id: uid,
        app: "chat",
        session_id: "c1",
        role: "user",
        content: "Le déploiement de Zéphyr est prévu lundi",
        ts: 1_700_000_100,
      },
      {
        user_id: uid,
        app: "chat",
        session_id: "c1",
        role: "assistant",
        content: "Noté : déploiement lundi matin",
        ts: 1_700_000_200,
      },
      {
        user_id: uidBob,
        app: "chat",
        session_id: "b1",
        role: "user",
        content: "Le déploiement secret de bob",
        ts: 1_700_000_300,
      },
    ]);
    refBob =
      (await t.base.get<{ id: number }>("SELECT id FROM session_messages WHERE user_id=?", [uidBob]))?.id ??
      0;
    dossier = mkdtempSync(join(tmpdir(), "elpis-familles-compte-"));
    writeFileSync(join(dossier, "config.json"), "{}");
    writeFileSync(
      join(dossier, "mcp.json"),
      JSON.stringify({
        version: 1,
        mcpServers: {
          "elpis-todo": { "x-elpis": { role: "app", families: ["todo"] } },
          "elpis-memory": { "x-elpis": { role: "app", families: ["memory"] } },
        },
      }),
    );
    restaurer = surchargerConfig({
      CONFIG_JSON_PATH: join(dossier, "config.json"),
      MEMORY_DIR: join(dossier, "mem"),
      MEMORY_MD_CHAR_LIMIT: config.MEMORY_MD_CHAR_LIMIT,
      USER_MD_CHAR_LIMIT: config.USER_MD_CHAR_LIMIT,
    });
    invalidateConfigCache();
    vi.stubEnv("APP_MCP_MANIFEST", join(dossier, "mcp.json"));
    oublierManifeste();
    installerComptesMemoire({ idUtilisateur: async (nom) => (await getUser(t.base, nom))?.id ?? null });
    creerServeurEnProcessus({ limiteDebit: null, limiteConcurrence: null });
    brancherFamillesDuCompte(t.base);
  });

  afterAll(async () => {
    try {
      await poolMcp.reset({ keepPersistent: false });
      await serviceEnProcessus()?.fermer();
    } finally {
      oublierServeurEnProcessus();
      installerComptesMemoire(null);
      vi.unstubAllEnvs();
      oublierManifeste();
      restaurer?.();
      invalidateConfigCache();
      await t?.fermer();
      if (dossier) rmSync(dossier, { recursive: true, force: true });
    }
  });

  /** Client du pool pour l'entrée `inprocess` du manifeste de cette famille. */
  async function appeler(
    entree: string,
    outil: string,
    args: Dict,
    meta: Dict | null = { username: "alice", chat_id: "c1" },
  ): Promise<Dict> {
    const client = resoudreClientMcp(load().get(entree)?.clientCfg() ?? {});
    if (client === null) throw new Error(`entrée ${entree} sans client`);
    const signal = new AbortController().signal;
    await client.connecter(signal);
    try {
      return (await client.appelerOutil(outil, args, { meta: meta ?? undefined, signal })) as Dict;
    } finally {
      await client.fermer();
    }
  }

  it("composition : les deux familles sont enregistrées sur le serveur du process, l'entrée inprocess liste leurs outils figés par les goldens", async () => {
    expect(serveurEnProcessus()?.famillesActives).toEqual(["chart", "memory", "skill", "todo"]);
    const signal = new AbortController().signal;
    for (const [entree, attendus] of [
      ["elpis-todo", ["todowrite"]],
      ["elpis-memory", ["memory", "session_search"]],
    ] as const) {
      const client = resoudreClientMcp(load().get(entree)?.clientCfg() ?? {});
      await client?.connecter(signal);
      try {
        const outils = (await client?.listerOutils(signal)) ?? [];
        expect(outils.map((o) => o["name"])).toEqual(attendus);
        expect(outils.every((o) => o["outputSchema"] !== undefined && o["annotations"] !== undefined)).toBe(
          true,
        );
      } finally {
        await client?.fermer();
      }
    }
  });

  it("todowrite : résultat complet, `todos` gardé pour l'événement UI, liste enregistrée dans le chat du compte de l'appel", async () => {
    const r = await appeler("elpis-todo", "todowrite", {
      todos: [
        { content: "Écrire le plan", status: "in_progress" },
        "Tester",
        { content: "Livrer", status: "pending", x: 1 },
      ],
    });
    expect(r["isError"]).toBe(false);
    const sc = r["structuredContent"] as Dict;
    expect(Object.keys(sc)).toEqual([
      "ok",
      "done",
      "total",
      "remaining",
      "in_progress",
      "completed_now",
      "checklist",
      "notes",
      "persisted",
      "todos",
    ]);
    expect(sc["persisted"]).toBe(true);
    expect(sc["checklist"]).toBe("1. [in_progress] Écrire le plan\n2. [pending] Tester\n3. [pending] Livrer");
    expect(JSON.parse(texteDe(r))).toEqual(sc);
    expect(await getChatTodos(t.base, uid, "c1")).toEqual(sc["todos"]);
    const encore = await appeler("elpis-todo", "todowrite", {
      todos: [
        { content: "Écrire le plan", status: "completed" },
        { content: "Tester", status: "pending" },
        { content: "Livrer", status: "pending" },
      ],
    });
    expect((encore["structuredContent"] as Dict)["completed_now"]).toEqual(["Écrire le plan"]);
  });

  it("todowrite : compte et chat de l'identité seulement ; sans chat, chat inconnu ou compte inconnu → persisted faux", async () => {
    const avant = await getChatTodos(t.base, uid, "c1");
    for (const meta of [
      { username: "alice" },
      { username: "alice", chat_id: "inconnu" },
      { username: "zoe", chat_id: "c1" },
      null,
    ]) {
      const r = await appeler(
        "elpis-todo",
        "todowrite",
        { todos: [{ content: "x", status: "pending" }] },
        meta,
      );
      expect((r["structuredContent"] as Dict)["persisted"], JSON.stringify(meta)).toBe(false);
    }
    expect(await getChatTodos(t.base, uid, "c1")).toEqual(avant);
  });

  it("arguments validés comme pydantic avant l'appel : refus rendu en isError, rien d'écrit", async () => {
    const avant = await getChatTodos(t.base, uid, "c1");
    for (const [args, fragment] of [
      [{ todos: "x" }, "Input should be a valid list"],
      [{ todos: [5] }, "Input should be a valid dictionary or instance of TodoItem"],
      [{ todos: [{ content: "a", status: 1 }] }, "Input should be a valid string"],
      [{}, "Missing required argument"],
      [{ todos: [], extra: 1 }, "Unexpected keyword argument"],
    ] as const) {
      const r = await appeler("elpis-todo", "todowrite", args as Dict);
      expect(r["isError"], JSON.stringify(args)).toBe(true);
      expect(texteDe(r)).toContain(fragment);
      expect(texteDe(r)).toContain("validation error");
    }
    const r = await appeler("elpis-memory", "session_search", { query: "x", limit: "abc" });
    expect(texteDe(r)).toContain("unable to parse string as an integer");
    expect(await getChatTodos(t.base, uid, "c1")).toEqual(avant);
  });

  it("memory : écritures dans MEMORY_DIR du compte (pas SANDBOX_DIR), journal et audit, annulable ; identité du `_meta` nettoyée", async () => {
    const r = await appeler("elpis-memory", "memory", {
      action: "add",
      store: "memory",
      content: "Préférer des réponses concises",
      title: "Je retiens ta préférence",
    });
    const sc = (r["structuredContent"] as Dict)["result"] as Dict;
    expect(sc["ok"]).toBe(true);
    expect(sc["id"]).toMatch(/^[0-9a-f]{4}$/u);
    expect(String(sc["op"])).not.toBe("");
    const memDir = join(dossier, "mem", "alice", "memory");
    expect(readFileSync(join(memDir, "MEMORY.md"), "utf8")).toContain("Préférer des réponses concises");
    expect(readFileSync(join(memDir, ".journal.jsonl"), "utf8")).toContain(
      '"title": "Je retiens ta préférence"',
    );
    expect(readFileSync(join(memDir, ".journal.jsonl"), "utf8")).toContain('"chat_id": "c1"');
    expect(existsSync(join(memDir, ".audit.jsonl"))).toBe(true);
    const sandbox = join(config.SANDBOX_DIR, "alice", "memory");
    expect(existsSync(join(sandbox, "MEMORY.md"))).toBe(false);
    await appeler(
      "elpis-memory",
      "memory",
      { action: "add", store: "user", content: "Sans nom" },
      { username: "al/../ice" },
    );
    expect(readFileSync(join(dossier, "mem", "alice", "memory", "USER.md"), "utf8")).toContain("Sans nom");
    const rejet = await appeler("elpis-memory", "memory", { action: "frobnicate", store: "memory" });
    expect(rejet["isError"]).toBe(true);
    expect(texteDe(rejet)).toContain("Input should be 'add', 'replace', 'remove' or 'rewrite'");
  });

  it("session_search : extraits du compte seulement, lecture par ref, requête vide, limite en chaîne", async () => {
    const r = await appeler("elpis-memory", "session_search", { query: "déploiement", limit: "5" });
    const sc = (r["structuredContent"] as Dict)["result"] as {
      matches: Dict[];
      count: number;
      query: string;
    };
    expect(sc.query).toBe("déploiement");
    expect(sc.count).toBe(2);
    expect(sc.matches.every((m) => m["chat"] === "Projet Zéphyr")).toBe(true);
    expect(JSON.stringify(sc)).not.toContain("secret");
    const lu = await appeler("elpis-memory", "session_search", { ref: sc.matches[0]?.["ref"] });
    expect(
      ((lu["structuredContent"] as Dict)["result"] as { matches: Dict[] }).matches[0]?.["excerpt"],
    ).toContain("déploiement");
    const autre = await appeler("elpis-memory", "session_search", { ref: refBob });
    expect(texteDe(autre)).toContain("unknown_ref");
    expect(texteDe(await appeler("elpis-memory", "session_search", { query: "  " }))).toContain(
      "empty_query",
    );
    const zoe = await appeler(
      "elpis-memory",
      "session_search",
      { query: "déploiement" },
      { username: "zoe" },
    );
    expect(((zoe["structuredContent"] as Dict)["result"] as Dict)["count"]).toBe(0);
  });

  it(`requête de session_search plafonnée à ${MAX_MOTS_REQUETE} mots : le 1000e mot est cherché, le 1001e non, la requête rendue reste entière`, async () => {
    const dep = {
      base: t.base,
      idUtilisateur: async (nom: string) => (await getUser(t.base, nom))?.id ?? null,
    };
    const requete = (rang: number, total: number): string =>
      Array.from({ length: total }, (_, i) => (i === rang ? "déploiement" : `mot${i}`)).join(" ");
    const chercher = (query: string): Promise<Dict> =>
      sessionSearch(dep, { username: "alice", chatId: "" }, { query });
    const trouve = await chercher(requete(MAX_MOTS_REQUETE - 1, 6000));
    expect(trouve["count"]).toBe(2);
    const perdu = await chercher(requete(MAX_MOTS_REQUETE, 6000));
    expect(perdu["count"]).toBe(0);
    expect(String(perdu["query"])).toBe(requete(MAX_MOTS_REQUETE, 6000));
    expect((await chercher(requete(MAX_MOTS_REQUETE, MAX_MOTS_REQUETE + 1)))["count"]).toBe(0);
    expect((await chercher(requete(MAX_MOTS_REQUETE - 1, MAX_MOTS_REQUETE)))["matches"]).toEqual(
      trouve["matches"],
    );
  });

  it("boucle : executerOutilMcp rend la charge utile JSON de chaque outil par le pool du process (todos gardés pour l'événement UI)", async () => {
    const cfg = (entree: string): Dict => load().get(entree)?.clientCfg() ?? {};
    const outils = new Map([
      ["todowrite", cfg("elpis-todo")],
      ["memory", cfg("elpis-memory")],
    ]);
    const meta = { username: "alice", chat_id: "c1" };
    const todo = JSON.parse(
      await executerOutilMcp(
        outils,
        "todowrite",
        { todos: [{ content: "Boucle", status: "in_progress" }] },
        { meta, timeoutS: 30 },
      ),
    ) as Dict;
    expect(todo).toMatchObject({ ok: true, total: 1, persisted: true, in_progress: "Boucle" });
    expect(todo["todos"]).toEqual([{ content: "Boucle", status: "in_progress", priority: "medium" }]);
    const memoire = JSON.parse(
      await executerOutilMcp(
        outils,
        "memory",
        { action: "add", store: "memory", content: "Vu par la boucle" },
        { meta, timeoutS: 30 },
      ),
    ) as Dict;
    expect(memoire).toMatchObject({ ok: true, action: "add", store: "memory" });
    const refus = JSON.parse(
      await executerOutilMcp(outils, "memory", { action: "add" }, { meta, timeoutS: 30 }),
    ) as Dict;
    expect(refus["ok"]).toBe(false);
    expect(String(refus["error"])).toContain("validation error");
    expect(toolTraits("todowrite")).toMatchObject({ serial: true, replaySafe: true, mutates: true });
    expect(toolTraits("memory")).toMatchObject({ serial: true, replaySafe: false, mutates: true });
    expect(toolTraits("session_search")).toMatchObject({ readOnly: true, mutates: false });
  });

  it("façade OpenAPI : todo et memory (role app) restent hors de la façade, comme en Python", () => {
    expect(familyCfg("memory")).toBeNull();
    expect(familyCfg("todo")).toBeNull();
  });
});
