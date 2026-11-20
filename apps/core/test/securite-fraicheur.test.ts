// SPDX-License-Identifier: MIT
/** apps/core/test/securite-fraicheur.test.ts — un accès sans session interactive d'un compte externe exige une vérification récente (jeton d'API, OAuth MCP, routine, webhook) ; un compte local n'est jamais gêné (SQLite, PostgreSQL si ELPIS_TEST_PG). */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";

import {
  accesPerime,
  accesPerimeDe,
  creerJeton,
  createExternalUser,
  createUser,
  dependancesParDefaut,
  ErreurOAuth,
  exchangeCode,
  getClient,
  issueCode,
  lireFraicheurs,
  refresh,
  registerClient,
  resoudreJeton,
  verifyAccessToken,
} from "@elpis/auth";
import type { ClientOAuth, DependancesOAuth } from "@elpis/auth";
import { configureAudit, configurerCoffre, oublierConfigurationAudit } from "@elpis/securite";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { creerFamilleWebhooks } from "../src/familles/webhooks";
import { ancreIdentite } from "../src/identite/ancre";
import { fraicheursDe, lecteurActifs } from "../src/identite/fraicheur";
import { supprimerSecretFournisseur } from "../src/identite/fournisseurs";
import { createRoutine, setRoutineWebhook } from "../src/routines/magasin";
import { Planificateur } from "../src/routines/planificateur";
import { appTest } from "./aides";
import { MOTEURS } from "./identite/banc";
import { ouvrirBancFournisseur } from "./identite/banc-fournisseur";
import type { BancFournisseur } from "./identite/banc-fournisseur";

const JOUR = 86_400;
configurerCoffre({
  cleEnv: randomBytes(32).toString("base64"),
  systeme: "/nonexistent/vault.key",
  repli: "/nonexistent/.vault.key",
});

describe("accesPerime : fonction pure", () => {
  const table = (...e: [string, number][]): Map<string, number> => new Map(e);
  const ligne = (id: unknown, vu: unknown): { ident_provider_id: unknown; ident_checked_at: unknown } => ({
    ident_provider_id: id,
    ident_checked_at: vu,
  });
  const T = 1_800_000_000;
  const frais = table(["a", 3]);

  it("compte local (sans identité) : jamais concerné, quelle que soit la table", () => {
    expect(accesPerime(ligne(null, null), frais, T)).toBe(false);
    expect(accesPerime(ligne(undefined, undefined), table(), T)).toBe(false);
    expect(accesPerime(undefined, table(), T)).toBe(false);
    expect(accesPerime(null, table(), T)).toBe(false);
  });

  it("frais jusqu'à la fraîcheur du fournisseur incluse, périmé au-delà", () => {
    expect(accesPerime(ligne("a", T - 3 * JOUR), frais, T)).toBe(false);
    expect(accesPerime(ligne("a", T - 3 * JOUR - 1), frais, T)).toBe(true);
  });

  it("jamais vérifiée (0, nul, illisible) : périmé", () => {
    for (const vu of [0, null, undefined, "x", -5]) expect(accesPerime(ligne("a", vu), frais, T)).toBe(true);
  });

  it("fournisseur absent de la table (supprimé, éteint, invalide, inactif, inconnu) : périmé tout de suite", () => {
    expect(accesPerime(ligne("a", T), table(), T)).toBe(true);
    expect(accesPerime(ligne("a", T), table(["b", 3]), T)).toBe(true);
    expect(accesPerime(ligne(12, T), frais, T)).toBe(true);
  });

  it("durée hors de 1 à 90 jours dans la table : périmé", () => {
    for (const j of [0, -1, 91, 1e9, Number.NaN, Infinity])
      expect(accesPerime(ligne("a", T), table(["a", j]), T)).toBe(true);
    expect(accesPerime(ligne("a", T - 90 * JOUR), table(["a", 90]), T)).toBe(false);
  });

  it("sans dépendance de fraîcheur (ou en panne) : tout compte externe est périmé, un compte local jamais", async () => {
    const ext = ligne("a", T);
    expect(await accesPerimeDe({}, ext, T)).toBe(true);
    expect(
      await accesPerimeDe(
        {
          fraicheursFournisseurs: () => Promise.reject(new Error("panne")),
        },
        ext,
        T,
      ),
    ).toBe(true);
    expect(await accesPerimeDe({}, ligne(null, null), T)).toBe(false);
    expect(await accesPerimeDe({ fraicheursFournisseurs: async () => frais }, ext, T)).toBe(false);
  });
});

describe.each(MOTEURS)("fraîcheur des accès non interactifs (%s)", (moteur) => {
  let b: BancFournisseur;
  let audit: string;
  let maintenant: number;
  let dep: ReturnType<typeof dependancesParDefaut>;

  let tic = 0;
  const auth = () => ({
    ...dependancesParDefaut(b.t.base),
    maintenant: () => b.horloge,
    fraicheursFournisseurs: fraicheursDe(
      lecteurActifs(
        b.t.base,
        () => true,
        () => (tic += 5000),
      ),
    ),
  });
  const externe = async (nom: string, n: number, vu: number): Promise<number> => {
    const uid = await createExternalUser(b.t.base, nom, { maintenant: b.horloge - 100 * JOUR });
    await b.t.base.run(
      "INSERT INTO user_identities(user_id, provider_id, subject, issuer, linked_by, linked_at, checked_at) VALUES(?,?,?,?,?,?,?)",
      [
        uid,
        "sso",
        `sujet-${n}`,
        ancreIdentite(b.fournisseurs[0] as never),
        "auto",
        b.horloge - 100 * JOUR,
        vu,
      ],
    );
    return uid;
  };
  const verifier = (uid: number, vu: number): Promise<unknown> =>
    b.t.base.run("UPDATE user_identities SET checked_at=? WHERE user_id=?", [vu, uid]);
  const eteindre = (): void =>
    b.cfg.ecrire({
      auth: {
        public_url: "https://elpis.exemple.lan",
        providers: [{ ...b.fournisseurs[0], enabled: false }],
      },
    });

  beforeEach(async () => {
    b = await ouvrirBancFournisseur(moteur);
    maintenant = Math.floor(Date.now() / 1000);
    b.horloge = maintenant;
    dep = auth();
    audit = mkdtempSync(join(tmpdir(), "elpis-audit-fraicheur-"));
    configureAudit({ service: "main", auditDir: audit, hmacKeyPath: join(audit, "sans-cle") });
  });
  afterEach(async () => {
    oublierConfigurationAudit();
    rmSync(audit, { recursive: true, force: true });
    await b.fermer();
  });

  describe("jetons d'API", () => {
    const ok = async (jeton: string, type: "tools" | "vision" = "tools"): Promise<boolean> =>
      (await resoudreJeton(dep, jeton, [type], false)) !== null;

    it("compte externe frais : accepté ; périmé : refusé ; local : jamais concerné", async () => {
      const frais = await externe("frais", 1, maintenant - JOUR);
      const perime = await externe("perime", 2, maintenant - 15 * JOUR);
      const local = await createUser(b.t.base, "locale", "mdp-locale-1", {
        maintenant: maintenant - 400 * JOUR,
      });
      const [jf] = await creerJeton(dep, frais, "tools", "t", ["fs"], 5);
      const [jp] = await creerJeton(dep, perime, "tools", "t", ["fs"], 5);
      const [vp] = await creerJeton(dep, perime, "vision");
      const [jl] = await creerJeton(dep, local, "tools", "t", ["fs"], 5);
      expect(await ok(jf as string)).toBe(true);
      expect(await ok(jp as string)).toBe(false);
      expect(await ok(vp as string, "vision")).toBe(false);
      expect(await ok(jl as string)).toBe(true);
    });

    it("fournisseur éteint : les jetons de ses comptes sont périmés, ceux d'un compte local restent", async () => {
      const uid = await externe("jean", 1, maintenant);
      const local = await createUser(b.t.base, "locale", "mdp-locale-1");
      const [j] = await creerJeton(dep, uid, "tools", "t", ["fs"], 5);
      const [jl] = await creerJeton(dep, local, "tools", "t", ["fs"], 5);
      expect(await ok(j as string)).toBe(true);
      eteindre();
      expect(await ok(j as string)).toBe(false);
      expect(await ok(jl as string)).toBe(true);
    });

    it("fournisseur tenu pour inactif (secret supprimé, réglage invalide) : les jetons de ses comptes sont périmés tout de suite", async () => {
      const uid = await externe("jean", 1, maintenant);
      const [j] = await creerJeton(dep, uid, "tools", "t", ["fs"], 5);
      expect(await ok(j as string)).toBe(true);
      b.cfg.ecrire({
        auth: {
          public_url: "https://elpis.exemple.lan",
          providers: [{ ...b.fournisseurs[0], freshness_days: 1e9 }],
        },
      });
      expect(await ok(j as string)).toBe(false);
      b.cfg.ecrire({ auth: { public_url: "https://elpis.exemple.lan", providers: [b.fournisseurs[0]] } });
      expect(await ok(j as string)).toBe(true);
      await supprimerSecretFournisseur(b.t.base, "sso", { userId: null, username: null, ip: null });
      expect(await ok(j as string)).toBe(false);
    });

    it("la table des fraîcheurs est gardée une seconde par process", async () => {
      let ms = 1000;
      const lire = fraicheursDe(
        lecteurActifs(
          b.t.base,
          () => true,
          () => ms,
        ),
      );
      expect([...(await lire())]).toEqual([["sso", 14]]);
      eteindre();
      ms += 999;
      expect([...(await lire())]).toEqual([["sso", 14]]);
      ms += 2;
      expect([...(await lire())]).toEqual([]);
    });

    it("la vérification est faite sur la ligne déjà lue : la fraîcheur se perd avec le temps et revient avec une vérification", async () => {
      const uid = await externe("jean", 1, maintenant);
      const [j] = await creerJeton(dep, uid, "tools", "t", ["fs"], 90);
      expect(await ok(j as string)).toBe(true);
      b.horloge = maintenant + 15 * JOUR;
      expect(await ok(j as string)).toBe(false);
      await verifier(uid, b.horloge);
      expect(await ok(j as string)).toBe(true);
    });
  });

  describe("OAuth MCP", () => {
    it("jeton d'accès, échange du code et rafraîchissement : refusés pour un compte périmé, pas pour un frais ni un local", async () => {
      const frais = await externe("frais", 1, maintenant - JOUR);
      const perime = await externe("perime", 2, maintenant - 1 * JOUR);
      const local = await createUser(b.t.base, "locale", "mdp-locale-1", {
        maintenant: maintenant - 400 * JOUR,
      });
      let n = 0;
      const od: DependancesOAuth = {
        base: b.t.base,
        config: () => ({}),
        fraicheursFournisseurs: () => lireFraicheurs(dep),
        maintenant: () => b.horloge,
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
      const client = (await getClient(b.t.base, cree["client_id"] as string)) as ClientOAuth;
      const verifierPkce = "v".repeat(50);
      const defi = createHash("sha256").update(verifierPkce).digest("base64url");
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
          codeVerifier: verifierPkce,
          resource: "",
          appUrl: "https://app.lan",
        });
      const rafraichir = (r: string): Promise<Record<string, unknown>> =>
        refresh(od, { refreshToken: r, client, scope: null, resource: "", appUrl: "https://app.lan" });
      const motif = async (f: () => Promise<unknown>): Promise<string> =>
        f().then(
          () => "ok",
          (e: unknown) => {
            if (e instanceof ErreurOAuth) return e.error;
            throw e;
          },
        );
      const pf = await echange(await code(frais));
      const pp = await echange(await code(perime));
      const pl = await echange(await code(local));
      for (const p of [pf, pp, pl]) expect(await verifyAccessToken(od, p["access_token"])).not.toBeNull();
      await verifier(perime, maintenant - 15 * JOUR);
      expect(await verifyAccessToken(od, pp["access_token"])).toBeNull();
      expect(await motif(() => rafraichir(String(pp["refresh_token"])))).toBe("invalid_grant");
      expect(await motif(async () => echange(await code(perime)))).toBe("invalid_grant");
      expect(await verifyAccessToken(od, pf["access_token"])).not.toBeNull();
      expect(await motif(() => rafraichir(String(pf["refresh_token"])))).toBe("ok");
      expect(await motif(() => rafraichir(String(pl["refresh_token"])))).toBe("ok");
      await verifier(perime, maintenant);
      expect(await verifyAccessToken(od, pp["access_token"])).not.toBeNull();
    });
  });

  describe("routines et webhooks", () => {
    let lancees: number[];
    let p: Planificateur;
    const champs = {
      name: "r",
      cron_expr: "* * * * *",
      model: null,
      system_prompt: "",
      task_prompt: "t",
      mcp_servers: [],
    };
    const routine = async (id: number): Promise<Record<string, unknown>> =>
      (await b.t.base.get<Record<string, unknown>>("SELECT * FROM editor_routines WHERE id=?", [
        id,
      ])) as Record<string, unknown>;
    const runs = async (id: number): Promise<[string, string | null][]> =>
      (
        await b.t.base.valeurs<[string, string | null]>(
          "SELECT status, error FROM editor_routine_runs WHERE routine_id=? ORDER BY id",
          [id],
        )
      ).map(([s, e]) => [s, e]);
    const notifications = async (uid: number): Promise<number> =>
      Number(
        (
          await b.t.base.valeurs<[number]>(
            "SELECT COUNT(*) FROM notifications WHERE owner_user_id=? AND kind='account_recheck'",
            [uid],
          )
        )[0]?.[0],
      );

    beforeEach(() => {
      lancees = [];
      p = new Planificateur({
        base: b.t.base,
        meneur: { tenu: true, essayer: async () => true, rendre: async () => undefined },
        llmJoignable: async () => true,
        fraicheurs: () => lireFraicheurs(dep),
        runner: async (o) => {
          lancees.push(Number(o.userId ?? 0));
          return ["ok", [], {}];
        },
      });
    });

    it("compte périmé : routine sautée avec une raison propre, une seule notification pour plusieurs déclenchements", async () => {
      const uid = await externe("jean", 1, maintenant - 15 * JOUR);
      const r = await routine(await createRoutine(b.t.base, uid, champs));
      const id = Number(r["id"]);
      expect(await p.lancerRun(r, { trigger: "schedule" })).toBeNull();
      expect(await p.lancerRun(r, { trigger: "schedule" })).toBeNull();
      expect(await p.lancerRun(r, { trigger: "webhook", context: "x" })).toBeNull();
      expect(await p.lancerRun(r, { trigger: "chain" })).toBeNull();
      expect(await runs(id)).toEqual([
        ["skipped", "compte à reconnecter"],
        ["skipped", "compte à reconnecter"],
        ["skipped", "compte à reconnecter"],
      ]);
      expect(await notifications(uid)).toBe(1);
      expect(lancees).toEqual([]);
    });

    it("la notification lue, un nouveau constat en crée une autre", async () => {
      const uid = await externe("jean", 1, maintenant - 15 * JOUR);
      const r = await routine(await createRoutine(b.t.base, uid, champs));
      await p.lancerRun(r, { trigger: "schedule" });
      await b.t.base.run("UPDATE notifications SET read_at=? WHERE owner_user_id=?", [maintenant, uid]);
      await p.lancerRun(r, { trigger: "schedule" });
      expect(await notifications(uid)).toBe(2);
    });

    it("compte frais, compte local et lancement manuel d'un compte périmé : jamais gênés", async () => {
      const frais = await externe("frais", 1, maintenant - JOUR);
      const perime = await externe("perime", 2, maintenant - 15 * JOUR);
      const local = await createUser(b.t.base, "locale", "mdp-locale-1", {
        maintenant: maintenant - 400 * JOUR,
      });
      for (const uid of [frais, local]) {
        const r = await routine(await createRoutine(b.t.base, uid, champs));
        expect(await p.lancerRun(r, { trigger: "schedule" })).not.toBeNull();
        await vi.waitFor(async () => expect(lancees).toContain(uid));
        await p.drainer();
      }
      const rp = await routine(await createRoutine(b.t.base, perime, champs));
      expect(await p.lancerRun(rp, { trigger: "manual" })).not.toBeNull();
      await p.drainer();
      expect(await notifications(frais)).toBe(0);
      expect(await notifications(local)).toBe(0);
      expect(await notifications(perime)).toBe(0);
    });

    it("webhook : compte périmé → livraison sautée, run « skipped » ; vérification rafraîchie → run lancé", async () => {
      const uid = await externe("jean", 1, maintenant - 15 * JOUR);
      const id = await createRoutine(b.t.base, uid, { ...champs, cron_expr: "" });
      const secret = "s".repeat(32);
      await setRoutineWebhook(b.t.base, id, uid, { enabled: true, secret });
      const app: FastifyInstance = await appTest({
        familles: [creerFamilleWebhooks({ base: b.t.base, planificateur: p })],
      });
      try {
        const livrer = async (): Promise<Record<string, unknown>> =>
          (
            await app.inject({
              method: "POST",
              url: `/api/webhooks/routines/${id}?token=${secret}`,
              headers: { "content-type": "application/json", "x-webhook-event": "push" },
              payload: { ref: "refs/heads/main" },
            })
          ).json();
        expect(await livrer()).toMatchObject({ skipped: true });
        expect(await runs(id)).toEqual([["skipped", "compte à reconnecter"]]);
        expect(await notifications(uid)).toBe(1);
        await verifier(uid, Math.floor(Date.now() / 1000));
        expect(await livrer()).toHaveProperty("run_id");
        await vi.waitFor(() => expect(lancees).toEqual([uid]));
        await p.drainer();
      } finally {
        await app.close();
      }
    });

    it("fournisseur éteint : le planning d'un compte externe est sauté", async () => {
      const uid = await externe("jean", 1, Math.floor(Date.now() / 1000));
      const r = await routine(await createRoutine(b.t.base, uid, champs));
      eteindre();
      expect(await p.lancerRun(r, { trigger: "schedule" })).toBeNull();
    });
  });
});
