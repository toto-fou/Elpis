// SPDX-License-Identifier: MIT
/** apps/core/test/secrets/attachement.test.ts — secrets attachés à une conversation : `GET`/`PUT /api/chats/:chat_id/secrets` (secrets du compte, web-login et http-auth vérifiés, journal attaché/détaché), résolution qui exige une conversation signée du compte (sous-agent, run de routine, contexte inconnu), recherche sans valeur (`/match`), reprise des anciens identifiants AX (`/import-ax`, migration 0030 et VACUUM, clé du coffre absente). */
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { creerGardes, dependancesParDefaut, installerAuth } from "@elpis/auth";
import { surchargerConfig } from "@elpis/config";
import { initialiserBase, ouvrirBase } from "@elpis/db";
import { ouvrirBaseDeTest } from "@elpis/db/test";
import type { BaseDeTest } from "@elpis/db/test";
import {
  configurerChiffrement,
  configurerCoffre,
  configureAudit,
  creerIdentite,
  encrypt,
  IDENTITY_HEADER,
  oublierConfigurationAudit,
  sign,
} from "@elpis/securite";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { getChat, upsertChat } from "../../src/chats/stockage";
import { creerFamilleSecrets } from "../../src/familles/secrets";
import { nomDeLOrigine, origineDeCle, repriseAxDuCore } from "../../src/secrets/import-ax";
import { creerSecret } from "../../src/secrets/stockage";
import { appTest } from "../aides";

const SVC = "jeton-de-service-des-essais-de-l-attachement";
const VALEUR = "Mot-De-Passe-Attache-9";
const ORIGINE = "https://intranet.lan:8443";

let t: BaseDeTest;
let app: FastifyInstance;
let dossier: string;
let journal: string;
let restaurer: () => void;
let alice = 0;
let bob = 0;
const cle = randomBytes(32).toString("base64");

beforeAll(async () => {
  restaurer = surchargerConfig({ LOCAL_MCP_TOKEN: SVC });
  t = ouvrirBaseDeTest("sqlite");
  await initialiserBase(t.base);
  const compte = (nom: string): Promise<number> =>
    t.base.insertId("INSERT INTO users(username, pass_salt, pass_hash, created_at) VALUES (?, '', '', 0)", [
      nom,
    ]);
  alice = await compte("alice");
  bob = await compte("bob");
  const auth = { ...dependancesParDefaut(t.base, () => SVC) };
  app = await appTest({
    familles: [creerFamilleSecrets({ base: t.base, auth })],
    gardes: {
      ...creerGardes(auth),
      session: (req) => {
        const uid = Number(req.headers["x-uid"]);
        req.utilisateur = { id: uid, username: uid === alice ? "alice" : "bob" };
      },
    },
    extensions: [(a) => installerAuth(a, auth)],
  });
});

afterAll(async () => {
  await app.close();
  await t.fermer();
  restaurer();
});

beforeEach(async () => {
  dossier = mkdtempSync(join(tmpdir(), "elpis-coffre-attache-"));
  journal = mkdtempSync(join(tmpdir(), "elpis-coffre-attache-journal-"));
  configureAudit({ service: "main", auditDir: journal, hmacKeyPath: "/nonexistent" });
  configurerCoffre({
    cleEnv: cle,
    systeme: join(dossier, "absente.key"),
    repli: join(dossier, ".vault.key"),
  });
  for (const table of ["vault_secrets", "chats", "editor_routine_runs", "editor_routines", "ax_credentials"])
    await t.base.run(`DELETE FROM ${table}`);
  await upsertChat(t.base, alice, "c1", "T", [], 1);
  await upsertChat(t.base, bob, "cb", "T", [], 1);
});

afterEach(() => {
  oublierConfigurationAudit();
  rmSync(dossier, { recursive: true, force: true });
  rmSync(journal, { recursive: true, force: true });
});

const evenements = (prefixe = "vault."): Record<string, unknown>[] =>
  readdirSync(journal)
    .flatMap((n) => readFileSync(join(journal, n), "utf8").split("\n"))
    .filter((l) => l.startsWith("{"))
    .map((l) => JSON.parse(l) as Record<string, unknown>)
    .filter((l) => String(l["action"]).startsWith(prefixe));

const texteJournal = (): string =>
  readdirSync(journal)
    .map((n) => readFileSync(join(journal, n), "utf8"))
    .join("");

const ajouter = (uid: number, d: { name: string } & Record<string, unknown>) =>
  creerSecret(
    t.base,
    uid,
    { kind: "web-login", value: VALEUR, scope: { origins: [ORIGINE] }, username: "admin", ...d },
    { userId: uid, username: null },
  );

const session = (uid: number, methode: "GET" | "PUT", chat: string, corps?: unknown) =>
  app.inject({
    method: methode,
    url: `/api/chats/${encodeURIComponent(chat)}/secrets`,
    headers: { "x-uid": String(uid), ...(corps === undefined ? {} : { "content-type": "application/json" }) },
    ...(corps === undefined ? {} : { payload: JSON.stringify(corps) }),
  });

const signe = (uid: number, nom: string, champs: Record<string, unknown> = {}): string =>
  sign(creerIdentite({ user_id: uid, username: nom, ...champs }), SVC);

const interne = (chemin: string, corps: unknown, identite: string) =>
  app.inject({
    method: "POST",
    url: `/api/internal/secrets/${chemin}`,
    headers: {
      authorization: `Bearer ${SVC}`,
      "content-type": "application/json",
      [IDENTITY_HEADER]: identite,
    },
    payload: JSON.stringify(corps),
  });

const code = (r: { statusCode: number; json: () => unknown }): [number, unknown] => [
  r.statusCode,
  (r.json() as { code?: unknown }).code,
];

describe("secrets attachés à une conversation (REST)", () => {
  it("PUT remplace l'ensemble (ordre gardé), GET rend les métadonnées, jamais la valeur ; journal attaché puis détaché", async () => {
    const web = await ajouter(alice, { name: "intranet" });
    const proxy = await ajouter(alice, {
      name: "proxy",
      kind: "http-auth",
      scope: { origins: ["https://srv.lan"] },
    });
    const r = await session(alice, "PUT", "c1", { ids: [proxy.id, web.id] });
    expect(r.statusCode, r.body).toBe(200);
    expect((r.json() as { secrets: { name: string }[] }).secrets.map((s) => s.name)).toEqual([
      "proxy",
      "intranet",
    ]);
    expect(r.body).not.toContain(VALEUR);
    expect((await getChat(t.base, alice, "c1"))?.["secrets"]).toEqual([proxy.id, web.id]);
    const g = await session(alice, "GET", "c1");
    expect(g.json()).toEqual(r.json());
    const double = await session(alice, "PUT", "c1", { ids: [proxy.id, web.id, proxy.id] });
    expect(double.json()).toEqual(r.json());
    expect((await getChat(t.base, alice, "c1"))?.["secrets"]).toEqual([proxy.id, web.id]);
    expect((await session(alice, "PUT", "c1", { ids: [web.id] })).statusCode).toBe(200);
    expect((await session(alice, "PUT", "c1", { ids: [] })).json()).toEqual({ secrets: [] });
    const ev = evenements().filter((e) => /attached|detached/u.test(String(e["action"])));
    expect(ev.map((e) => [e["action"], (e["details"] as { name: string }).name])).toEqual([
      ["vault.secret.attached", "proxy"],
      ["vault.secret.attached", "intranet"],
      ["vault.secret.detached", "proxy"],
      ["vault.secret.detached", "intranet"],
    ]);
    expect(ev[0]).toMatchObject({ user_id: alice, details: { chat_id: "c1", kind: "http-auth" } });
  });

  it("refus : secret d'un autre compte ou inconnu, autre genre, non vérifié, trop nombreux, conversation inconnue ou d'autrui", async () => {
    const forge = await ajouter(alice, { name: "forge", kind: "git", scope: { host: "git.lan" } });
    const vieux = await ajouter(alice, { name: "vieux", state: "unverified" });
    const deBob = await ajouter(bob, { name: "de-bob" });
    const web = await ajouter(alice, { name: "web" });
    expect(code(await session(alice, "PUT", "c1", { ids: [deBob.id] }))).toEqual([404, "secret_unknown"]);
    expect(code(await session(alice, "PUT", "c1", { ids: [999_999] }))).toEqual([404, "secret_unknown"]);
    expect(code(await session(alice, "PUT", "c1", { ids: [forge.id] }))).toEqual([
      422,
      "secret_type_mismatch",
    ]);
    expect(code(await session(alice, "PUT", "c1", { ids: [vieux.id] }))).toEqual([422, "secret_unverified"]);
    expect(
      code(await session(alice, "PUT", "c1", { ids: Array.from({ length: 11 }, (_, i) => i + 1) })),
    ).toEqual([400, "secret_request_invalid"]);
    expect(code(await session(alice, "PUT", "c1", { ids: ["1"] }))).toEqual([400, "secret_request_invalid"]);
    expect((await session(alice, "PUT", "cb", { ids: [web.id] })).statusCode).toBe(404);
    expect((await session(alice, "GET", "absente")).statusCode).toBe(404);
    expect((await session(alice, "GET", "c1#task-t1")).statusCode).toBe(404);
    expect((await getChat(t.base, alice, "c1"))?.["secrets"]).toBeUndefined();
  });
});

describe("résolution : conversation signée du compte exigée", () => {
  const attacher = async (...ids: number[]): Promise<void> => {
    expect((await session(alice, "PUT", "c1", { ids })).statusCode).toBe(200);
  };
  const resoudre = (corps: Record<string, unknown>, identite: string) =>
    interne("resolve", { usage: "web-login", origin: ORIGINE, ...corps }, identite);

  it("attaché à la conversation signée : valeur rendue ; sans conversation signée, ou celle du corps seule : refus", async () => {
    const web = await ajouter(alice, { name: "intranet" });
    await attacher(web.id);
    const ok = await resoudre({ name: "intranet" }, signe(alice, "alice", { chat_id: "c1" }));
    expect([ok.statusCode, (ok.json() as { secret: string }).secret]).toEqual([200, VALEUR]);
    expect(code(await resoudre({ name: "intranet" }, signe(alice, "alice")))).toEqual([
      422,
      "secret_not_attached",
    ]);
    expect(code(await resoudre({ chat_id: "c1" }, signe(alice, "alice")))).toEqual([
      400,
      "secret_request_invalid",
    ]);
    expect(code(await resoudre({ chat_id: "autre" }, signe(alice, "alice", { chat_id: "c1" })))).toEqual([
      400,
      "secret_request_invalid",
    ]);
    const refus = evenements().filter((e) => e["action"] === "vault.secret.refused");
    expect(refus.map((e) => (e["details"] as { code: string }).code)).toEqual(["secret_not_attached"]);
  });

  it("conversation d'un autre compte, inconnue ou de forme inconnue : refus ; détaché : refus", async () => {
    const web = await ajouter(alice, { name: "intranet" });
    await attacher(web.id);
    for (const chat_id of ["cb", "absente", "c1#autre", "c1#task-", `c1#task-t1#task-t2`])
      expect(code(await resoudre({}, signe(alice, "alice", { chat_id }))), chat_id).toEqual([
        422,
        "secret_not_attached",
      ]);
    await attacher();
    expect(code(await resoudre({}, signe(alice, "alice", { chat_id: "c1" })))).toEqual([
      422,
      "secret_not_attached",
    ]);
  });

  it("sous-agent : hérite de la conversation racine si la politique le permet, par la conversation `#task-` ou par l'enveloppe", async () => {
    const web = await ajouter(alice, { name: "intranet" });
    const prive = await ajouter(alice, {
      name: "prive",
      scope: { origins: ["https://rh.lan"] },
      policy: { subagents: false },
    });
    await attacher(web.id, prive.id);
    const enfant = signe(alice, "alice", { chat_id: "c1#task-t1-abc" });
    expect((await resoudre({ name: "intranet" }, enfant)).statusCode).toBe(200);
    expect(code(await resoudre({ name: "prive", origin: "https://rh.lan" }, enfant))).toEqual([
      422,
      "secret_not_attached",
    ]);
    const parEnveloppe = signe(alice, "alice", { chat_id: "c1", subagent: { type: "web", id: "t1" } });
    expect(code(await resoudre({ origin: "https://rh.lan" }, parEnveloppe))).toEqual([
      422,
      "secret_not_attached",
    ]);
    expect(
      (await resoudre({ name: "prive", origin: "https://rh.lan" }, signe(alice, "alice", { chat_id: "c1" })))
        .statusCode,
    ).toBe(200);
    const utilise = evenements().filter((e) => e["action"] === "vault.secret.used")[0];
    expect(utilise).toMatchObject({ details: { chat_id: "c1#task-t1-abc", subagent: true } });
  });

  it("run de routine : seulement un run en cours du compte, et seulement si la politique permet les routines", async () => {
    const permis = await ajouter(alice, { name: "routine-ok", policy: { routines: true } });
    await ajouter(alice, { name: "routine-non", scope: { origins: ["https://rh.lan"] } });
    const rid = await t.base.insertId(
      "INSERT INTO editor_routines(owner_user_id, name, cron_expr, created_at, updated_at) VALUES (?, 'r', '* * * * *', 0, 0)",
      [alice],
    );
    const run = await t.base.insertId(
      "INSERT INTO editor_routine_runs(routine_id, owner_user_id, status, started_at) VALUES (?, ?, 'running', 0)",
      [rid, alice],
    );
    const cleRun = `routine:${rid}:run:${run}`;
    const ok = await resoudre({ name: "routine-ok" }, signe(alice, "alice", { chat_id: cleRun }));
    expect([ok.statusCode, (ok.json() as { name: string }).name]).toEqual([200, permis.name]);
    expect((await resoudre({}, signe(alice, "alice", { chat_id: cleRun }))).statusCode).toBe(200);
    expect(
      code(
        await resoudre(
          { name: "routine-non", origin: "https://rh.lan" },
          signe(alice, "alice", { chat_id: cleRun }),
        ),
      ),
    ).toEqual([422, "secret_not_attached"]);
    expect(code(await resoudre({}, signe(bob, "bob", { chat_id: cleRun })))).toEqual([
      422,
      "secret_not_attached",
    ]);
    expect(
      code(await resoudre({}, signe(alice, "alice", { chat_id: `routine:${rid}:run:${run + 1}` }))),
    ).toEqual([422, "secret_not_attached"]);
    await t.base.run("UPDATE editor_routine_runs SET status='ok' WHERE id=?", [run]);
    expect(code(await resoudre({}, signe(alice, "alice", { chat_id: cleRun })))).toEqual([
      422,
      "secret_not_attached",
    ]);
  });

  it("/match : secrets attachés qui couvrent l'origine (origines, TLS, politique des sous-agents), sans valeur ni usage compté ; par nom, refus codés, un secret inconnu, d'un autre genre ou d'autrui comme un non attaché", async () => {
    const web = await ajouter(alice, { name: "intranet" });
    const proxy = await ajouter(alice, {
      name: "proxy",
      kind: "http-auth",
      policy: { tls: "insecure", subagents: false },
    });
    await ajouter(alice, { name: "non-attache" });
    await ajouter(alice, { name: "forge", kind: "git", scope: { host: "git.lan" } });
    await ajouter(bob, { name: "de-bob" });
    await attacher(web.id, proxy.id);
    const r = await interne(
      "match",
      { origin: `${ORIGINE}/login?x=1` },
      signe(alice, "alice", { chat_id: "c1" }),
    );
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toEqual({
      secrets: [
        {
          name: "intranet",
          kind: "web-login",
          username: "admin",
          origins: [ORIGINE],
          tls: "strict",
          subagents: true,
        },
        {
          name: "proxy",
          kind: "http-auth",
          username: "admin",
          origins: [ORIGINE],
          tls: "insecure",
          subagents: false,
        },
      ],
    });
    expect(r.body).not.toContain(VALEUR);
    const un = await interne(
      "match",
      { origin: ORIGINE, name: "proxy" },
      signe(alice, "alice", { chat_id: "c1" }),
    );
    expect((un.json() as { secrets: unknown[] }).secrets).toHaveLength(1);
    const c1 = signe(alice, "alice", { chat_id: "c1" });
    const refus = await Promise.all(
      ["non-attache", "absent", "forge", "de-bob"].map((name) =>
        interne("match", { origin: ORIGINE, name }, c1),
      ),
    );
    expect(refus.map((x) => [x.statusCode, x.json()])).toEqual(
      ["non-attache", "absent", "forge", "de-bob"].map((name) => [
        422,
        { detail: `Secret '${name}' is not attached to this conversation.`, code: "secret_not_attached" },
      ]),
    );
    expect(code(await interne("match", { origin: "https://ailleurs.lan", name: "proxy" }, c1))).toEqual([
      422,
      "secret_scope_mismatch",
    ]);
    expect(code(await interne("match", { origin: ORIGINE }, signe(alice, "alice")))).toEqual([
      422,
      "secret_not_attached",
    ]);
    expect(
      (await interne("match", { origin: "https://autre.lan" }, c1)).json() as { secrets: unknown[] },
    ).toEqual({ secrets: [] });
    const compte = await t.base.get<{ n: number }>("SELECT SUM(use_count) AS n FROM vault_secrets");
    expect(Number(compte?.n)).toBe(0);
    expect(evenements().filter((e) => e["action"] === "vault.secret.used")).toHaveLength(0);
  });
});

describe("reprise des anciens identifiants AX", () => {
  it("origines et noms tirés des clés", () => {
    expect(origineDeCle("https://Intranet.LAN:8443")).toBe("https://intranet.lan:8443");
    expect(origineDeCle("http://192.0.2.10:8080")).toBe("http://192.0.2.10:8080");
    expect(origineDeCle("intranet.lan:8443")).toBeNull();
    expect(origineDeCle(":8080")).toBeNull();
    expect(origineDeCle("https://intranet.lan/chemin")).toBeNull();
    expect(nomDeLOrigine("https://intranet.lan:8443")).toBe("intranet.lan-8443");
    expect(nomDeLOrigine("http://[::1]:3000")).toBe("1-3000");
    expect(nomDeLOrigine(`https://${"a".repeat(70)}.lan`)).toHaveLength(48);
  });

  it("/import-ax pour le compte de l'enveloppe : importé (à vérifier), déjà là, écartés listés, noms libres ; journal sans valeur", async () => {
    await ajouter(alice, { name: "intranet.lan-8443", kind: "http-auth", username: "autre" });
    await ajouter(alice, {
      name: "deja",
      kind: "http-auth",
      scope: { origins: ["https://srv.lan"] },
      username: "svc",
    });
    const rows = [
      { site: ORIGINE, username: "admin", password: "mdp-un" },
      { site: "https://srv.lan", username: "svc", password: "mdp-deux" },
      { site: "vieux.lan:8080", username: "x", password: "mdp-trois" },
      { site: "https://vide.lan", username: "x", password: "" },
      { site: ORIGINE, username: "admin", password: "mdp-un" },
    ];
    const r = await interne("import-ax", { rows }, signe(alice, "alice"));
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toEqual({
      ok: true,
      results: [
        { site: ORIGINE, status: "imported", name: "intranet.lan-8443-2" },
        { site: "https://srv.lan", status: "exists", name: "deja" },
        { site: "vieux.lan:8080", status: "skipped", reason: "no_origin" },
        { site: "https://vide.lan", status: "skipped", reason: "empty_value" },
        { site: ORIGINE, status: "exists", name: "intranet.lan-8443-2" },
      ],
    });
    expect(r.body).not.toContain("mdp-un");
    const cree = await t.base.get<Record<string, unknown>>(
      "SELECT kind, state, scope_json, username, meta_json FROM vault_secrets WHERE name = 'intranet.lan-8443-2'",
    );
    expect(cree).toMatchObject({ kind: "http-auth", state: "unverified", username: "admin" });
    expect(JSON.parse(String(cree?.["scope_json"]))).toEqual({ origins: [ORIGINE] });
    expect(JSON.parse(String(cree?.["meta_json"]))).toEqual({ source: "ax_credentials" });
    const bilan = evenements().find((e) => e["action"] === "vault.ax.imported");
    expect(bilan).toMatchObject({
      user_id: alice,
      details: {
        source: "toolhost",
        imported: 1,
        existing: 2,
        skipped: 2,
        failed: 0,
        skipped_sites: [
          { site: "vieux.lan:8080", reason: "no_origin" },
          { site: "https://vide.lan", reason: "empty_value" },
        ],
      },
    });
    expect(texteJournal()).not.toMatch(/mdp-(un|deux|trois)/u);
    expect(
      code(await interne("import-ax", { rows: [{ ...rows[0], extra: 1 }] }, signe(alice, "alice"))),
    ).toEqual([400, "secret_request_invalid"]);
  });

  it("reprise au démarrage : lignes du core reprises (clair et Fernet, propriétaire assaini), compte disparu et valeur indéchiffrable effacés sans trace, clé sans origine listée ; rien au second passage", async () => {
    const chemin = join(dossier, "core.db");
    const b = ouvrirBase({ backend: "sqlite", path: chemin });
    try {
      await initialiserBase(b);
      const idAlice = await b.insertId(
        "INSERT INTO users(username, pass_salt, pass_hash, created_at) VALUES ('jean.dupont', '', '', 0)",
      );
      configurerChiffrement({ cleEnv: "cle-fernet-des-essais", fichierCle: join(dossier, "fernet.key") });
      const fernet = encrypt("mdp-chiffre-77");
      configurerChiffrement({ cleEnv: "autre-cle-fernet", fichierCle: join(dossier, "fernet.key") });
      const illisible = encrypt("mdp-perdu-55");
      configurerChiffrement({ cleEnv: "cle-fernet-des-essais", fichierCle: join(dossier, "fernet.key") });
      const lignes: [string, string, string, string][] = [
        ["jeandupont", "https://intranet.lan:8443", "admin", "mdp-clair-11"],
        ["jeandupont", "https://srv.lan", "svc", fernet],
        ["jeandupont", "https://perdu.lan", "x", illisible],
        ["jeandupont", "vieux.lan:8080", "x", "mdp-vieux-33"],
        ["disparu", "https://ailleurs.lan", "y", "mdp-orphelin-44"],
      ];
      for (const l of lignes)
        await b.run(
          "INSERT INTO ax_credentials(owner, site, username, password, use_count) VALUES (?, ?, ?, ?, 1)",
          l,
        );
      expect(await repriseAxDuCore(b)).toEqual({ retirees: 5, gardees: 0, propre: true });
      const secrets = await b.all<Record<string, unknown>>(
        "SELECT user_id, kind, name, state, username FROM vault_secrets ORDER BY name",
      );
      expect(secrets).toEqual([
        {
          user_id: idAlice,
          kind: "http-auth",
          name: "intranet.lan-8443",
          state: "unverified",
          username: "admin",
        },
        { user_id: idAlice, kind: "http-auth", name: "srv.lan", state: "unverified", username: "svc" },
      ]);
      expect(await b.all("SELECT owner, site FROM ax_credentials")).toEqual([]);
      const octets = ["", "-wal"]
        .filter((x) => existsSync(chemin + x))
        .map((x) => readFileSync(chemin + x).toString("latin1"))
        .join("");
      for (const v of ["mdp-clair-11", "mdp-vieux-33", "mdp-orphelin-44", fernet, illisible])
        expect(octets).not.toContain(v);
      const bilans = evenements().filter((e) => e["action"] === "vault.ax.imported");
      expect(bilans.map((e) => e["details"])).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            source: "core",
            skipped: 1,
            skipped_sites: [{ site: "https://ailleurs.lan", reason: "owner_unknown" }],
          }),
          expect.objectContaining({
            source: "core",
            imported: 2,
            undecryptable: 1,
            skipped_sites: [{ site: "vieux.lan:8080", reason: "no_origin" }],
          }),
        ]),
      );
      expect(evenements().filter((e) => e["action"] === "vault.secret.created")).toHaveLength(2);
      expect(texteJournal()).not.toMatch(/mdp-/u);
      expect(await repriseAxDuCore(b)).toEqual({ retirees: 0, gardees: 0, propre: true });
    } finally {
      await b.fermer();
    }
  });

  it("clé du coffre absente alors que des secrets existent : /import-ax 503 `secret_key_unavailable`, reprise du core en échec sans rien effacer ni journaliser, puis reprise au démarrage suivant", async () => {
    await ajouter(alice, { name: "existant" });
    configurerCoffre({ systeme: join(dossier, "absente.key"), repli: join(dossier, ".vault.key") });
    const rows = [{ site: "https://srv.lan", username: "svc", password: "mdp-deux" }];
    const r = await interne("import-ax", { rows }, signe(alice, "alice"));
    expect(code(r)).toEqual([503, "secret_key_unavailable"]);
    expect(r.body).not.toContain("mdp-deux");
    await t.base.run(
      "INSERT INTO ax_credentials(owner, site, username, password) VALUES ('alice', 'https://srv.lan', 'svc', 'mdp-deux')",
    );
    const avant = evenements().length;
    await expect(repriseAxDuCore(t.base)).rejects.toMatchObject({ code: "secret_key_unavailable" });
    expect(await t.base.all("SELECT site FROM ax_credentials")).toEqual([{ site: "https://srv.lan" }]);
    expect(
      evenements()
        .slice(avant)
        .filter((e) => e["action"] === "vault.secret.created"),
    ).toEqual([]);
    expect(existsSync(join(dossier, ".vault.key"))).toBe(false);
    configurerCoffre({
      cleEnv: cle,
      systeme: join(dossier, "absente.key"),
      repli: join(dossier, ".vault.key"),
    });
    expect(await repriseAxDuCore(t.base)).toMatchObject({ retirees: 1, gardees: 0 });
    expect(await t.base.all("SELECT site FROM ax_credentials")).toEqual([]);
    expect(await t.base.all("SELECT name, state FROM vault_secrets ORDER BY name")).toEqual([
      { name: "existant", state: "active" },
      { name: "srv.lan", state: "unverified" },
    ]);
  });

  it("sans clé Fernet : les lignes chiffrées attendent le démarrage suivant, les lignes en clair passent ; clé revenue : reprises", async () => {
    const b = ouvrirBase({ backend: "sqlite", path: join(dossier, "sans-cle.db") });
    try {
      await initialiserBase(b);
      await b.run(
        "INSERT INTO users(username, pass_salt, pass_hash, created_at) VALUES ('alice', '', '', 0)",
      );
      configurerChiffrement({ cleEnv: "cle-fernet-des-essais", fichierCle: join(dossier, "fernet.key") });
      const fernet = encrypt("mdp-chiffre-77");
      configurerChiffrement({ cleEnv: "", cleConfig: 42, fichierCle: join(dossier, "fernet.key") });
      await b.run(
        "INSERT INTO ax_credentials(owner, site, username, password) VALUES ('alice', 'https://a.lan', 'u', 'clair-1')",
      );
      await b.run(
        "INSERT INTO ax_credentials(owner, site, username, password) VALUES ('alice', 'https://b.lan', 'u', ?)",
        [fernet],
      );
      expect(await repriseAxDuCore(b)).toMatchObject({ retirees: 1, gardees: 1 });
      expect(await b.all("SELECT site FROM ax_credentials")).toEqual([{ site: "https://b.lan" }]);
      expect(await b.all("SELECT name FROM vault_secrets")).toEqual([{ name: "a.lan" }]);
      configurerChiffrement({ cleEnv: "cle-fernet-des-essais", fichierCle: join(dossier, "fernet.key") });
      expect(await repriseAxDuCore(b)).toMatchObject({ retirees: 1, gardees: 0 });
      expect(await b.all("SELECT name FROM vault_secrets ORDER BY name")).toEqual([
        { name: "a.lan" },
        { name: "b.lan" },
      ]);
    } finally {
      await b.fermer();
    }
  });
});

describe("déclencheur d'une session sécurisée, http-auth sans nom d'utilisateur", () => {
  it("tripwire : secret détaché de la conversation racine (même par un sous-agent), refus journalisé `reason: tripwire` ; déjà détaché : faux ; corps invalide : refus", async () => {
    const web = await ajouter(alice, { name: "intranet" });
    const autre = await ajouter(alice, { name: "autre", scope: { origins: ["https://autre.lan"] } });
    expect((await session(alice, "PUT", "c1", { ids: [web.id, autre.id] })).statusCode).toBe(200);
    const sousAgent = signe(alice, "alice", {
      chat_id: "c1#task-t1-ab",
      subagent: { type: "web", id: "t1-ab" },
    });
    const r = await interne("tripwire", { name: "intranet" }, sousAgent);
    expect([r.statusCode, r.json()]).toEqual([200, { ok: true, detached: true }]);
    expect((await getChat(t.base, alice, "c1"))?.["secrets"]).toEqual([autre.id]);
    expect(
      evenements()
        .filter((e) => e["action"] === "vault.secret.refused")
        .at(-1),
    ).toMatchObject({
      outcome: "failure",
      details: {
        code: "secret_session_closed",
        reason: "tripwire",
        name: "intranet",
        chat_id: "c1#task-t1-ab",
        subagent: true,
        detached: true,
      },
    });
    expect(evenements().some((e) => e["action"] === "vault.secret.detached")).toBe(true);
    const c1 = signe(alice, "alice", { chat_id: "c1" });
    expect((await interne("tripwire", { name: "intranet" }, c1)).json()).toEqual({
      ok: true,
      detached: false,
    });
    expect(code(await interne("tripwire", { name: "intranet", extra: 1 }, c1))).toEqual([
      400,
      "secret_request_invalid",
    ]);
  });

  it("http-auth sans nom d'utilisateur : `secret_username_required` avant tout usage (rien compté, refus journalisé)", async () => {
    const p = await ajouter(alice, { name: "proxy", kind: "http-auth", username: null });
    expect((await session(alice, "PUT", "c1", { ids: [p.id] })).statusCode).toBe(200);
    const r = await interne(
      "resolve",
      { usage: "http-auth", origin: ORIGINE, name: "proxy" },
      signe(alice, "alice", { chat_id: "c1" }),
    );
    expect(code(r)).toEqual([422, "secret_username_required"]);
    expect(r.body).not.toContain(VALEUR);
    const n = await t.base.get<{ n: number }>("SELECT use_count AS n FROM vault_secrets WHERE id = ?", [
      p.id,
    ]);
    expect(Number(n?.n)).toBe(0);
    expect(evenements().filter((e) => e["action"] === "vault.secret.used")).toEqual([]);
    expect(
      evenements().find((e) => (e["details"] as { code?: string })["code"] === "secret_username_required"),
    ).toBeDefined();
  });
});
