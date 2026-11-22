// SPDX-License-Identifier: MIT
/** apps/core/test/securite-compte-suspendu.test.ts — un compte suspendu est refusé par tous les chemins d'accès (session, flux, connexion, jetons, OAuth, hôte d'outils, aperçu, routines, webhooks), un autre compte n'en souffre pas, réactivé il repasse (sauf ses anciennes sessions). */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  compteSuspendu,
  creerGardes,
  creerJeton,
  createUser,
  dependancesParDefaut,
  dependancesSession,
  ErreurOAuth,
  exchangeCode,
  getClient,
  installerAuth,
  issueCode,
  ligneUtilisateur,
  refresh,
  registerClient,
  resoudreJeton,
  revaliderFlux,
  Session,
  validerSession,
  verifyAccessToken,
} from "@elpis/auth";
import type { ClientOAuth, DependancesOAuth } from "@elpis/auth";
import { HttpError } from "@elpis/commun";
import { surchargerConfig } from "@elpis/config";
import { initialiserBase } from "@elpis/db";
import { ouvrirBaseDeTest, PG_DE_TEST } from "@elpis/db/test";
import type { BaseDeTest } from "@elpis/db/test";
import {
  configureAudit,
  configurerCoffre,
  creerIdentite,
  IDENTITY_HEADER,
  oublierConfigurationAudit,
  sign,
} from "@elpis/securite";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { createHash, randomBytes } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { PortBac } from "../src/admin/bac";
import { reactiver, suspendre } from "../src/comptes/etat";
import { creerFamilleAdminComptes } from "../src/familles/admin-comptes";
import { creerFamilleInterneToolhost } from "../src/familles/interne-toolhost";
import { creerFamilleWebhooks } from "../src/familles/webhooks";
import { createRoutine, setRoutineWebhook } from "../src/routines/magasin";
import { Planificateur } from "../src/routines/planificateur";
import {
  arreterToursDuCompte,
  getActiveChatTask,
  registerChatTask,
  unregisterChatTask,
} from "../src/tour/etat";
import { installerCrochetJournal } from "../src/journal";
import { appTest, journalMuet, lignesAuditRecentes } from "./aides";

const MOTEURS = PG_DE_TEST ? (["sqlite", "postgres"] as const) : (["sqlite"] as const);
const T0 = 1_800_000_000;
configurerCoffre({
  cleEnv: randomBytes(32).toString("base64"),
  systeme: "/nonexistent/vault.key",
  repli: "/nonexistent/.vault.key",
});
const SVC = "jeton-de-service-de-test-suspension";

describe.each(MOTEURS)("compte suspendu : chemins d'accès (%s)", (moteur) => {
  let t: BaseDeTest;
  let alice = 0;
  let bob = 0;
  let horloge = T0;
  let dep: ReturnType<typeof dependancesParDefaut>;

  const suspendreSql = (uid: number): Promise<unknown> =>
    t.base.run("UPDATE users SET suspended_at=?, suspended_by='admin' WHERE id=?", [T0, uid]);
  const reactiverSql = (uid: number): Promise<unknown> =>
    t.base.run("UPDATE users SET suspended_at=0, suspended_by=NULL WHERE id=?", [uid]);

  beforeAll(async () => {
    t = ouvrirBaseDeTest(moteur);
    await initialiserBase(t.base);
    alice = await createUser(t.base, "alice", "mdp-alice", { maintenant: T0 });
    bob = await createUser(t.base, "bob", "mdp-bob", { maintenant: T0 });
    dep = { ...dependancesParDefaut(t.base), maintenant: () => horloge, config: () => ({}) };
  });

  afterAll(async () => t?.fermer());

  beforeEach(async () => {
    horloge = T0;
    await reactiverSql(alice);
    await reactiverSql(bob);
  });

  it("compteSuspendu : nul, 0 ou absent = actif ; toute autre valeur (négative, illisible) = suspendu", () => {
    expect(compteSuspendu({ suspended_at: T0 })).toBe(true);
    expect(compteSuspendu({ suspended_at: 0 })).toBe(false);
    expect(compteSuspendu({ suspended_at: null })).toBe(false);
    expect(compteSuspendu({})).toBe(false);
    expect(compteSuspendu(undefined)).toBe(false);
    expect(compteSuspendu({ suspended_at: "abc" })).toBe(true);
    expect(compteSuspendu({ suspended_at: -5 })).toBe(true);
    expect(compteSuspendu({ suspended_at: "" })).toBe(true);
    expect(compteSuspendu({ suspended_at: " " })).toBe(true);
    for (const actif of ["0", "0.0"]) expect(compteSuspendu({ suspended_at: actif })).toBe(false);
    for (const suspendu of ["1", "0.5", "-0", "x0", "00"])
      expect(compteSuspendu({ suspended_at: suspendu })).toBe(true);
  });

  it("1. session : refusée comme révoquée, l'autre compte passe, réactivée elle repasse", async () => {
    const ouverte = (uid: number): Session => {
      const s = new Session({ user_id: uid, _login_ts: T0 - 10, _sid: `sid-${uid}` });
      return s;
    };
    const verifier = async (uid: number): Promise<boolean> =>
      (await validerSession(ouverte(uid), uid, dependancesSession(dep))).valide;
    expect(await verifier(alice)).toBe(true);
    await suspendreSql(alice);
    expect(await verifier(alice)).toBe(false);
    expect(await verifier(bob)).toBe(true);
    await reactiverSql(alice);
    expect(await verifier(alice)).toBe(true);
  });

  it("2. flux ouvert : coupé dès la suspension, l'autre compte garde le sien", async () => {
    const encore = (uid: number): Promise<boolean> => revaliderFlux(dep, uid, T0 - 10, `sid-${uid}`);
    expect(await encore(alice)).toBe(true);
    await suspendreSql(alice);
    expect(await encore(alice)).toBe(false);
    expect(await encore(bob)).toBe(true);
    await reactiverSql(alice);
    expect(await encore(alice)).toBe(true);
  });

  it("4. jeton d'API : refusé tant que l'état est suspendu (outils comme vision), l'autre compte passe, l'état levé à la main sans passer par suspendre le rend", async () => {
    const [jetonAlice] = await creerJeton(dep, alice, "tools", "t", ["fs"], 5);
    const [visionAlice] = await creerJeton(dep, alice, "vision");
    const [jetonBob] = await creerJeton(dep, bob, "tools", "t", ["fs"], 5);
    const ok = async (jeton: string, type: "tools" | "vision"): Promise<boolean> =>
      (await resoudreJeton(dep, jeton, [type], false)) !== null;
    expect(await ok(jetonAlice, "tools")).toBe(true);
    await suspendreSql(alice);
    expect(await ok(jetonAlice, "tools")).toBe(false);
    expect(await ok(visionAlice, "vision")).toBe(false);
    expect(await ok(jetonBob, "tools")).toBe(true);
    await reactiverSql(alice);
    expect(await ok(jetonAlice, "tools")).toBe(true);
    expect(await ok(visionAlice, "vision")).toBe(true);
  });

  it("5. OAuth MCP : échange du code, rafraîchissement et jeton d'accès refusés (invalid_grant, null), jetons non touchés par l'état seul", async () => {
    let n = 0;
    const od: DependancesOAuth = {
      base: t.base,
      config: () => ({}),
      maintenant: () => horloge,
      jetonUrl: (k) => `U${String(++n).padStart(4, "0")}`.padEnd(Math.ceil((4 * k) / 3), "u"),
      jetonHex: (k) => `H${String(++n).padStart(4, "0")}`.padEnd(2 * k, "0"),
      resoudre: async () => [],
      telecharger: async () => Buffer.from(""),
    };
    const cree = (await registerClient(
      od,
      { redirect_uris: ["https://c.example/cb"], client_name: "C" },
      "dcr",
      1000,
    )) as Record<string, string>;
    const client = (await getClient(t.base, cree["client_id"])) as ClientOAuth;
    const verifier = "v".repeat(50);
    const defi = createHash("sha256").update(verifier).digest("base64url");
    const code = (uid: number): Promise<string> =>
      issueCode(od, {
        client_id: client.client_id,
        user_id: uid,
        redirect_uri: "https://c.example/cb",
        code_challenge: defi,
        resource: "",
        families: ["fs"],
      });
    const echange = (c: string): Promise<Record<string, unknown>> =>
      exchangeCode(od, {
        code: c,
        client,
        redirectUri: "https://c.example/cb",
        codeVerifier: verifier,
        resource: "",
        appUrl: "https://app.lan",
      });
    const rafraichir = (r: string): Promise<Record<string, unknown>> =>
      refresh(od, { refreshToken: r, client, scope: null, resource: "", appUrl: "https://app.lan" });
    const motif = async (f: () => Promise<unknown>): Promise<string> => {
      try {
        await f();
        return "ok";
      } catch (e) {
        if (e instanceof ErreurOAuth) return e.error;
        throw e;
      }
    };
    const paire = await echange(await code(alice));
    const paireBob = await echange(await code(bob));
    expect(await verifyAccessToken(od, paire["access_token"])).not.toBeNull();
    await suspendreSql(alice);
    expect(await verifyAccessToken(od, paire["access_token"])).toBeNull();
    expect(await verifyAccessToken(od, paireBob["access_token"])).not.toBeNull();
    expect(await motif(() => rafraichir(String(paire["refresh_token"])))).toBe("invalid_grant");
    expect(await motif(async () => echange(await code(alice)))).toBe("invalid_grant");
    const description = async (f: () => Promise<unknown>): Promise<string> =>
      f().then(
        () => "",
        (e: unknown) => (e instanceof ErreurOAuth ? e.description : ""),
      );
    expect(await description(() => rafraichir(String(paire["refresh_token"])))).toBe(
      "Jeton de rafraîchissement inconnu.",
    );
    expect(await description(async () => echange(await code(alice)))).toBe("Code inconnu.");
    expect(await motif(() => rafraichir(String(paireBob["refresh_token"])))).toBe("ok");
    await reactiverSql(alice);
    expect(await verifyAccessToken(od, paire["access_token"])).not.toBeNull();
    expect(await motif(() => rafraichir(String(paire["refresh_token"])))).toBe("ok");
    expect(await motif(async () => echange(await code(alice)))).toBe("ok");
  });

  it("8. routines : une routine d'un compte suspendu est sautée (run « skipped »), pas celle d'un autre ; runs en vol coupés", async () => {
    const lancees: number[] = [];
    const p = new Planificateur({
      base: t.base,
      meneur: { tenu: true, essayer: async () => true, rendre: async () => undefined },
      llmJoignable: async () => true,
      runner: async (o) => {
        lancees.push(Number(o.userId ?? 0));
        await new Promise<void>((fin, ko) => {
          const a = (o as { signal?: AbortSignal }).signal;
          if (a === undefined) return fin();
          a.addEventListener("abort", () => ko(a.reason), { once: true });
          setTimeout(fin, 50);
        });
        return ["ok", [], {}];
      },
    });
    const champs = {
      name: "r",
      cron_expr: "* * * * *",
      model: null,
      system_prompt: "",
      task_prompt: "t",
      mcp_servers: [],
    };
    const ra = await createRoutine(t.base, alice, champs);
    const rb = await createRoutine(t.base, bob, champs);
    const routine = async (id: number): Promise<Record<string, unknown>> =>
      (await t.base.get<Record<string, unknown>>("SELECT * FROM editor_routines WHERE id=?", [id])) as Record<
        string,
        unknown
      >;
    const statuts = async (id: number): Promise<string[]> =>
      (
        await t.base.valeurs<[string]>(
          "SELECT status FROM editor_routine_runs WHERE routine_id=? ORDER BY id",
          [id],
        )
      ).map(([s]) => s);
    await suspendreSql(alice);
    expect(await p.lancerRun(await routine(ra), { trigger: "manual" })).toBeNull();
    expect(await statuts(ra)).toEqual(["skipped"]);
    expect(await p.lancerRun(await routine(ra), { trigger: "schedule" })).toBeNull();
    expect(await statuts(ra)).toEqual(["skipped"]);
    const autre = await p.lancerRun(await routine(rb), { trigger: "manual" });
    expect(autre).not.toBeNull();
    await vi.waitFor(async () => expect(lancees).toEqual([bob]));
    await vi.waitFor(async () => expect(await statuts(rb)).not.toEqual(["running"]));
    await p.drainer();
    await reactiverSql(alice);
    expect(await p.lancerRun(await routine(ra), { trigger: "manual" })).not.toBeNull();
    await vi.waitFor(async () => expect(lancees).toEqual([bob, alice]));
    await vi.waitFor(async () => expect(await statuts(ra)).not.toContain("running"));
    await p.drainer();
    expect(await statuts(ra)).toHaveLength(2);
    expect(lancees).toEqual([bob, alice]);
    expect(p.arreterCompte(alice)).toBe(0);
  });

  it("suspendre : les lignes de session du fournisseur du compte sont supprimées dans la même écriture, celles des autres comptes restent", async () => {
    const ligne = (sid: string, uid: number): Promise<unknown> =>
      t.base.run(
        "INSERT INTO auth_ext_sessions(sid, user_id, provider_id, idp_sid, subject, id_token_enc, expires_at) VALUES(?,?,?,?,?,?,?)",
        [sid, uid, "sso", null, `sub-${sid}`, null, 9e9],
      );
    await ligne("s-alice", alice);
    await ligne("s-bob", bob);
    const d = {
      base: t.base,
      acces: dependancesParDefaut(t.base),
      maintenant: () => T0,
      publierSuspension: async () => true,
      journal: journalMuet,
    };
    expect((await suspendre(d, alice, "admin")).change).toBe(true);
    expect(await t.base.valeurs("SELECT sid FROM auth_ext_sessions")).toEqual([["s-bob"]]);
  });

  it("suspendre : état posé une fois (premier auteur gardé), min de session levé, bac détruit, publication faite ; réactiver ne baisse pas le min", async () => {
    const publies: number[] = [];
    const appels: unknown[][] = [];
    const bac: PortBac = {
      retirerConteneur: async () => undefined,
      purgerTravail: async () => undefined,
      detruireConteneur: async (uid, nom) => void appels.push([uid, nom]),
    };
    const d = {
      base: t.base,
      acces: dependancesParDefaut(t.base),
      maintenant: () => horloge,
      publierSuspension: async (uid: number) => {
        publies.push(uid);
        return true;
      },
      bac,
      journal: journalMuet,
    };
    expect((await suspendre(d, alice, "admin")).change).toBe(true);
    horloge += 100;
    expect((await suspendre(d, alice, "provider:x")).change).toBe(false);
    const ligne = await ligneUtilisateur(t.base, alice);
    expect([Number(ligne?.suspended_at), ligne?.suspended_by, Number(ligne?.session_min_ts) > 0]).toEqual([
      T0,
      "admin",
      true,
    ]);
    expect(publies).toEqual([alice]);
    expect(appels.map((a) => a[0])).toEqual([alice]);
    expect(compteSuspendu(await ligneUtilisateur(t.base, bob))).toBe(false);
    const min = Number((await ligneUtilisateur(t.base, alice))?.session_min_ts);
    horloge += 50;
    expect(await reactiver({ base: t.base, maintenant: () => horloge }, alice)).toBe(true);
    expect(await reactiver({ base: t.base, maintenant: () => horloge }, alice)).toBe(false);
    const apres = await ligneUtilisateur(t.base, alice);
    expect([compteSuspendu(apres), apres?.suspended_by ?? null, Number(apres?.session_min_ts)]).toEqual([
      false,
      null,
      horloge,
    ]);
    expect(min).toBe(T0);
    const ancienne = new Session({ user_id: alice, _login_ts: T0 - 10, _sid: "s" });
    expect((await validerSession(ancienne, alice, dependancesSession(dep))).valide).toBe(false);
  });

  it("suspendre : un bac ou une publication en échec ne bloque pas la suspension", async () => {
    const d = {
      base: t.base,
      acces: dependancesParDefaut(t.base),
      maintenant: () => horloge,
      publierSuspension: async () => {
        throw new Error("main injoignable");
      },
      bac: {
        retirerConteneur: async () => undefined,
        purgerTravail: async () => undefined,
        detruireConteneur: async () => {
          throw new Error("docker absent");
        },
      } satisfies PortBac,
      journal: journalMuet,
    };
    expect(await suspendre(d, bob, "admin")).toMatchObject({
      change: true,
      propage: false,
      bacArrete: false,
    });
    expect(compteSuspendu(await ligneUtilisateur(t.base, bob))).toBe(true);
  });
});

describe("compte suspendu : tours de chat en vol", () => {
  afterEach(() => {
    unregisterChatTask(1, "c1");
    unregisterChatTask(2, "c2");
  });

  it("arreterToursDuCompte coupe ceux du compte seulement", () => {
    const a = new AbortController();
    const b = new AbortController();
    registerChatTask(1, a, "c1", { presenceLock: false });
    registerChatTask(2, b, "c2", { presenceLock: false });
    expect(arreterToursDuCompte(1)).toBe(1);
    expect([a.signal.aborted, b.signal.aborted]).toEqual([true, false]);
    expect(getActiveChatTask(2, "c2")).toBe(b);
  });
});

describe("compte suspendu : routes et hôtes (SQLite)", () => {
  let t: BaseDeTest;
  let alice = 0;
  let bob = 0;
  let racine: string;
  let audit: string;
  let restaurer: () => void;
  const auditAvant = process.env["ELPIS_AUDIT_DIR"];

  const suspendreSql = (uid: number): Promise<unknown> =>
    t.base.run("UPDATE users SET suspended_at=?, suspended_by='admin' WHERE id=?", [T0, uid]);
  const reactiverSql = (uid: number): Promise<unknown> =>
    t.base.run("UPDATE users SET suspended_at=0, suspended_by=NULL WHERE id=?", [uid]);

  beforeAll(async () => {
    audit = mkdtempSync(join(tmpdir(), "elpis-audit-susp-"));
    racine = mkdtempSync(join(tmpdir(), "elpis-racine-susp-"));
    process.env["ELPIS_AUDIT_DIR"] = audit;
    oublierConfigurationAudit();
    restaurer = surchargerConfig({ LOCAL_MCP_TOKEN: SVC });
    vi.stubEnv("APP_MCP_MANIFEST", join(racine, "absent.json"));
    t = ouvrirBaseDeTest("sqlite");
    await initialiserBase(t.base);
    alice = await createUser(t.base, "alice", "mdp-alice");
    bob = await createUser(t.base, "bob", "mdp-bob");
  });

  afterAll(async () => {
    restaurer();
    vi.unstubAllEnvs();
    if (auditAvant === undefined) delete process.env["ELPIS_AUDIT_DIR"];
    else process.env["ELPIS_AUDIT_DIR"] = auditAvant;
    oublierConfigurationAudit();
    await t.fermer();
    rmSync(audit, { recursive: true, force: true });
    rmSync(racine, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await reactiverSql(alice);
    await reactiverSql(bob);
  });

  describe("6. hôte d'outils : introspection, identité, enveloppe signée", () => {
    let app: FastifyInstance;

    beforeAll(async () => {
      const auth = { ...dependancesParDefaut(t.base, () => SVC), config: () => ({}) };
      app = await appTest({
        familles: [creerFamilleInterneToolhost({ auth, journal: journalMuet })],
        gardes: creerGardes(auth),
        extensions: [(a) => installerAuth(a, auth)],
      });
    });

    afterAll(async () => app.close());

    const identite = async (
      nom: string,
    ): Promise<{ statusCode: number; json: () => Record<string, unknown> }> =>
      app.inject({
        method: "GET",
        url: `/api/internal/identity?username=${nom}`,
        headers: { authorization: `Bearer ${SVC}` },
      }) as never;
    const hotes = (uid: number, nom: string): Promise<LightMyRequestResponse> =>
      app.inject({
        method: "GET",
        url: "/api/internal/git/connector-hosts",
        headers: {
          authorization: `Bearer ${SVC}`,
          [IDENTITY_HEADER]: sign(creerIdentite({ user_id: uid, username: nom }), SVC),
        },
      });

    it("GET /api/internal/identity : « inconnu » pour un compte suspendu, l'autre répond, réactivé il répond", async () => {
      expect((await identite("alice")).json()).toMatchObject({ ok: true, user_id: alice });
      await suspendreSql(alice);
      expect((await identite("alice")).json()).toEqual({ ok: false });
      expect((await identite("bob")).json()).toMatchObject({ ok: true, user_id: bob });
      await reactiverSql(alice);
      expect((await identite("alice")).json()).toMatchObject({ ok: true, user_id: alice });
    });

    it("compteSigne : enveloppe d'un compte suspendu refusée (403), celle d'un autre acceptée", async () => {
      expect((await hotes(alice, "alice")).statusCode).toBe(200);
      await suspendreSql(alice);
      const r = await hotes(alice, "alice");
      expect([r.statusCode, r.json()]).toEqual([403, { detail: "unknown account" }]);
      expect((await hotes(bob, "bob")).statusCode).toBe(200);
      await reactiverSql(alice);
      expect((await hotes(alice, "alice")).statusCode).toBe(200);
    });

    it("POST /api/internal/tokens/introspect : jeton d'un compte suspendu inactif", async () => {
      const auth = { ...dependancesParDefaut(t.base, () => SVC), config: () => ({}) };
      const [jeton] = await creerJeton(auth, alice, "tools", "t", ["fs"], 5);
      const introspecter = async (): Promise<unknown> =>
        (
          await app.inject({
            method: "POST",
            url: "/api/internal/tokens/introspect",
            headers: { authorization: `Bearer ${SVC}`, "content-type": "application/json" },
            payload: { token: jeton },
          })
        ).json();
      expect(await introspecter()).toMatchObject({ ok: true, user_id: alice });
      await suspendreSql(alice);
      expect(await introspecter()).toEqual({ ok: false });
    });
  });

  describe("3. connexion : même 401 qu'un mauvais mot de passe, audit account_suspended", () => {
    let app: FastifyInstance;

    beforeAll(async () => {
      const { composer } = await import("../src/composition");
      const dep = {
        ...dependancesParDefaut(t.base),
        config: () => ({}),
        attributsCookie: () => ({
          cookie_name: "mcpwebui_session",
          same_site: "lax" as const,
          https_only: false,
          max_age: 86400,
        }),
        secret: () => "secret-de-test",
        jetonService: () => "",
        maintenant: () => T0,
      };
      app = await appTest({ ...(await composer("main", t.base, journalMuet, dep, racine)) });
    });

    afterAll(async () => app.close());

    const connexion = (nom: string, mdp: string, ip: string): Promise<LightMyRequestResponse> =>
      app.inject({
        method: "POST",
        url: "/api/login-lite",
        remoteAddress: ip,
        payload: { username: nom, password: mdp },
      });

    it("compte actif : connexion et dernière connexion écrite ; suspendu : 401 identique à un mauvais mot de passe, sans session ; réactivé : connexion", async () => {
      const bon = await connexion("alice", "mdp-alice", "10.1.0.1");
      expect(bon.statusCode).toBe(200);
      expect(Number((await ligneUtilisateur(t.base, alice))?.last_login_at)).toBe(T0);
      await suspendreSql(alice);
      const faux = await connexion("alice", "mauvais", "10.1.0.2");
      const suspendu = await connexion("alice", "mdp-alice", "10.1.0.3");
      expect([suspendu.statusCode, suspendu.body]).toEqual([faux.statusCode, faux.body]);
      expect(suspendu.statusCode).toBe(401);
      expect(suspendu.headers["set-cookie"]).toBeUndefined();
      const refus = lignesAuditRecentes({ actionPrefix: "auth.login.denied" }).find(
        (l) => (l["details"] as Record<string, unknown>)["reason"] === "account_suspended",
      );
      expect(refus).toMatchObject({ user_id: alice, username: "alice" });
      expect((await connexion("bob", "mdp-bob", "10.1.0.4")).statusCode).toBe(200);
      await reactiverSql(alice);
      expect((await connexion("alice", "mdp-alice", "10.1.0.5")).statusCode).toBe(200);
    });

    it("session déjà ouverte : refusée dès la suspension, et ne revit pas à la réactivation", async () => {
      const ouverte = await connexion("bob", "mdp-bob", "10.1.0.6");
      const cookie = String(ouverte.headers["set-cookie"] ?? "").split(";")[0] ?? "";
      const moi = async (): Promise<unknown> =>
        (await app.inject({ method: "GET", url: "/api/me-lite", headers: { cookie } })).json();
      expect(await moi()).toMatchObject({ logged_in: true, username: "bob" });
      await t.base.run("UPDATE users SET suspended_at=?, suspended_by='admin', session_min_ts=? WHERE id=?", [
        T0,
        T0 + 5,
        bob,
      ]);
      expect(await moi()).toEqual({ logged_in: false });
      await reactiverSql(bob);
      expect(await moi()).toEqual({ logged_in: false });
    });
  });

  describe("webhooks (8) : aucune livraison ne se distingue d'un webhook inconnu", () => {
    it("routine d'un compte suspendu : même 202 qu'une routine inconnue, rien lancé ; l'autre compte lance", async () => {
      const p = new Planificateur({
        base: t.base,
        meneur: { tenu: false, essayer: async () => false, rendre: async () => undefined },
      });
      const lancer = vi.spyOn(p, "lancerRun").mockResolvedValue(7);
      const app = await appTest({ familles: [creerFamilleWebhooks({ base: t.base, planificateur: p })] });
      try {
        const champs = {
          name: "w",
          cron_expr: "",
          model: null,
          system_prompt: "",
          task_prompt: "t",
          mcp_servers: [],
        };
        const secret = "s".repeat(32);
        const ra = await createRoutine(t.base, alice, champs);
        const rb = await createRoutine(t.base, bob, champs);
        for (const [rid, uid] of [
          [ra, alice],
          [rb, bob],
        ] as const)
          await setRoutineWebhook(t.base, rid, uid, { enabled: true, secret });
        const livrer = async (rid: number): Promise<[number, string]> => {
          const r = await app.inject({
            method: "POST",
            url: `/api/webhooks/routines/${rid}?token=${secret}`,
            headers: { "content-type": "application/json", "x-webhook-event": "push" },
            payload: { ref: "refs/heads/main" },
          });
          return [r.statusCode, r.body];
        };
        const inconnu = await livrer(999_999);
        expect((await livrer(ra))[0]).toBe(202);
        expect(lancer).toHaveBeenCalledTimes(1);
        await suspendreSql(alice);
        expect(await livrer(ra)).toEqual(inconnu);
        expect(lancer).toHaveBeenCalledTimes(1);
        expect((await livrer(rb))[0]).toBe(202);
        expect(lancer).toHaveBeenCalledTimes(2);
        await reactiverSql(alice);
        expect((await livrer(ra))[1]).not.toBe(inconnu[1]);
        expect(lancer).toHaveBeenCalledTimes(3);
        await suspendreSql(alice);
        const lignes: string[] = [];
        installerCrochetJournal((_n, m) => void lignes.push(m));
        try {
          const faux = await app.inject({
            method: "POST",
            url: `/api/webhooks/routines/${ra}?token=${"x".repeat(32)}`,
            headers: { "content-type": "application/json", "x-webhook-event": "push" },
            payload: {},
          });
          expect(faux.body).toBe(inconnu[1]);
          expect(lignes.join("\n")).toContain(`secret invalide routine=${ra}`);
        } finally {
          installerCrochetJournal(null);
        }
        expect(lancer).toHaveBeenCalledTimes(3);
      } finally {
        await app.close();
      }
    });
  });

  describe("routes d'administration : suspendre et réactiver", () => {
    let app: FastifyInstance;
    let chef = 0;
    let modo = 0;
    const revoques: unknown[] = [];
    const suspensions: number[] = [];
    const detruits: number[] = [];
    let propage = true;

    beforeAll(async () => {
      chef = await createUser(t.base, "chef", "mdp-chef", { isAdmin: 1 });
      modo = await createUser(t.base, "modo", "mdp-modo", { isAdmin: 2 });
      configureAudit({
        service: "admin",
        auditDir: audit,
        hmacKeyPath: join(racine, "sans-cle"),
        maintenant: () => T0,
      });
      const auth = { ...dependancesParDefaut(t.base), maintenant: () => T0 };
      app = await appTest({
        mode: "admin",
        familles: [
          creerFamilleAdminComptes({
            base: t.base,
            auth,
            journal: journalMuet,
            revoquer: async (uid) => void revoques.push(uid),
            publierSuspension: async (uid) => {
              suspensions.push(uid);
              return propage;
            },
            bac: {
              retirerConteneur: async () => undefined,
              purgerTravail: async () => undefined,
              detruireConteneur: async (uid) => void detruits.push(uid),
            },
          }),
        ],
        gardes: {
          admin: async (req) => {
            const uid = req.headers["x-uid"];
            if (!uid) throw new HttpError(401, "not logged in");
            const ligne = await ligneUtilisateur(t.base, Number(uid));
            req.utilisateur = { id: Number(uid), username: ligne ? String(ligne.username) : null };
            if (!ligne || Number(ligne.is_admin) !== 1) throw new HttpError(403, "Admin required");
          },
        },
      });
    });

    afterAll(async () => {
      await app.close();
      oublierConfigurationAudit();
    });

    beforeEach(async () => {
      revoques.length = 0;
      suspensions.length = 0;
      detruits.length = 0;
      propage = true;
      await t.base.run("UPDATE users SET suspended_at=0, suspended_by=NULL, is_admin=1 WHERE id=?", [chef]);
    });

    const appel = (qui: number, action: string, cible: number): Promise<LightMyRequestResponse> =>
      app.inject({
        method: "POST",
        url: `/api/admin/users/${cible}/${action}`,
        headers: { "x-uid": String(qui) },
      });

    it("suspend : propage, détruit le bac, audite, idempotente ; la liste rend l'état ; unsuspend rend l'accès", async () => {
      const r = await appel(chef, "suspend", alice);
      expect(r.statusCode).toBe(200);
      expect(r.json()).toMatchObject({
        ok: true,
        propagated: true,
        tokens_revoked: expect.any(Number),
        oauth_revoked: expect.any(Number),
      });
      expect(suspensions).toEqual([alice]);
      expect(detruits).toEqual([alice]);
      expect(revoques).toEqual([]);
      const ligne = await ligneUtilisateur(t.base, alice);
      expect([compteSuspendu(ligne), ligne?.suspended_by]).toEqual([true, "admin"]);
      expect((await appel(chef, "suspend", alice)).statusCode).toBe(200);
      expect(compteSuspendu(await ligneUtilisateur(t.base, bob))).toBe(false);
      const liste = (
        await app.inject({
          method: "GET",
          url: "/api/admin/users-with-groups",
          headers: { "x-uid": String(chef) },
        })
      ).json<{ users: { id: number; suspended_at: number; suspended_by: string | null }[] }>().users;
      const parId = new Map(liste.map((u) => [u.id, u]));
      expect(parId.get(alice)?.suspended_at).toBe(T0);
      expect(parId.get(alice)?.suspended_by).toBe("admin");
      expect([parId.get(bob)?.suspended_at, parId.get(bob)?.suspended_by]).toEqual([0, null]);
      const actions = lignesAuditRecentes({ actionPrefix: "admin.user." }).map((l) => l["action"]);
      expect(actions).toContain("admin.user.suspend");
      const r2 = await appel(chef, "unsuspend", alice);
      expect([r2.statusCode, r2.json()]).toEqual([200, { ok: true }]);
      expect(compteSuspendu(await ligneUtilisateur(t.base, alice))).toBe(false);
      expect((await appel(chef, "unsuspend", alice)).statusCode).toBe(200);
      expect(lignesAuditRecentes({ actionPrefix: "admin.user.unsuspend" }).length).toBeGreaterThan(0);
    });

    it("publication vers main en échec : la réponse et l'audit disent propagated=false, la suspension tient", async () => {
      propage = false;
      const r = await appel(chef, "suspend", alice);
      expect(r.statusCode).toBe(200);
      expect(r.json()).toMatchObject({
        ok: true,
        propagated: false,
        tokens_revoked: expect.any(Number),
        oauth_revoked: expect.any(Number),
      });
      expect(compteSuspendu(await ligneUtilisateur(t.base, alice))).toBe(true);
      const ligne = lignesAuditRecentes({ actionPrefix: "admin.user.suspend" })[0];
      expect(ligne?.["details"]).toMatchObject({ propagated: false, sandbox_stopped: true });
    });

    it("gardes : soi-même 400, inconnu 404, modérateur 403", async () => {
      expect((await appel(chef, "suspend", chef)).statusCode).toBe(400);
      expect((await appel(chef, "unsuspend", chef)).statusCode).toBe(400);
      expect((await appel(chef, "suspend", 987_654)).statusCode).toBe(404);
      expect((await appel(chef, "unsuspend", 987_654)).statusCode).toBe(404);
      expect((await appel(modo, "suspend", alice)).statusCode).toBe(403);
      expect(compteSuspendu(await ligneUtilisateur(t.base, alice))).toBe(false);
    });

    it("dernier administrateur actif : 409 et aucun état posé ; avec un autre administrateur actif, accepté", async () => {
      await t.base.run("UPDATE users SET is_admin=1 WHERE id=?", [alice]);
      try {
        await t.base.run("UPDATE users SET suspended_at=?, suspended_by='x' WHERE id=?", [T0, chef]);
        const refus = await appel(chef, "suspend", alice);
        expect([refus.statusCode, compteSuspendu(await ligneUtilisateur(t.base, alice))]).toEqual([
          409,
          false,
        ]);
        expect(suspensions).toEqual([]);
        await t.base.run("UPDATE users SET suspended_at=0, suspended_by=NULL WHERE id=?", [chef]);
        expect((await appel(chef, "suspend", alice)).statusCode).toBe(200);
      } finally {
        await t.base.run("UPDATE users SET is_admin=0 WHERE id=?", [alice]);
      }
    });
  });
});
