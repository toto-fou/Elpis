// SPDX-License-Identifier: MIT
/** apps/core/test/securite-connexion-indiscernable.test.ts — avec un annuaire actif, tout refus de `/api/login-lite` est le même 401 au même temps réel (nom inconnu, mot de passe d'annuaire faux, compte local), une exception interne n'est jamais un 500, un 429 ne lit ni coffre ni annuaire (SQLite, PostgreSQL si ELPIS_TEST_PG). */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createUser, dependancesParDefaut, revoquerOauthDuCompte } from "@elpis/auth";
import { configureAudit, oublierConfigurationAudit } from "@elpis/securite";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PAR_NOM_ET_ADRESSE } from "../src/comptes/debit-connexion";
import { composer } from "../src/composition";
import { MOTEURS } from "./identite/banc";
import { cookies } from "./identite/banc-oidc";
import { AnnuaireFactice, BASE, GROUPE, UUID } from "./identite/annuaire/annuaire-factice";
import { ouvrirBancAnnuaire } from "./identite/annuaire/banc-annuaire";
import type { BancAnnuaire } from "./identite/annuaire/banc-annuaire";
import { appTest, journalMuet, lignesAuditRecentes, lignesJournal } from "./aides";

const MDP = "Pl4nt3-Mdp-Reconnaissable";
const REFUS = { statusCode: 401, body: JSON.stringify({ detail: "invalid credentials" }) };

describe.each(MOTEURS)("refus indiscernables avec un annuaire actif (%s)", (moteur) => {
  let b: BancAnnuaire;
  let annuaire: AnnuaireFactice;
  let app: FastifyInstance;
  let racine: string;
  let audit: string;

  const essai = (
    username: string,
    password: string,
    ip: string,
    cookie = "",
  ): Promise<LightMyRequestResponse> =>
    app.inject({
      method: "POST",
      url: "/api/login-lite",
      remoteAddress: ip,
      ...(cookie === "" ? {} : { headers: { cookie } }),
      payload: { username, password },
    });
  const refuse = (r: LightMyRequestResponse): { statusCode: number; body: string } => ({
    statusCode: r.statusCode,
    body: r.body,
  });

  beforeEach(async () => {
    lignesJournal.length = 0;
    annuaire = new AnnuaireFactice();
    annuaire.ajouter({ uid: "jean", cle: UUID(1), mdp: MDP, groupes: [GROUPE] });
    b = await ouvrirBancAnnuaire(moteur, [{}], annuaire);
    audit = mkdtempSync(join(tmpdir(), "elpis-audit-ind-"));
    racine = mkdtempSync(join(tmpdir(), "elpis-racine-ind-"));
    const dep = {
      ...dependancesParDefaut(b.t.base),
      config: () => ({}),
      attributsCookie: () => ({
        cookie_name: "mcpwebui_session",
        same_site: "lax" as const,
        https_only: true,
        max_age: 86400,
      }),
      secret: () => "secret-de-test",
      jetonService: () => "",
      revoquerOauth: (uid: number) => revoquerOauthDuCompte(b.t.base, uid, 1),
    };
    app = await appTest({
      ...(await composer("main", b.t.base, journalMuet, dep, racine, {
        fabriqueAnnuaire: annuaire.fabrique,
      })),
    });
    configureAudit({ service: "main", auditDir: audit, hmacKeyPath: join(audit, "sans-cle") });
    await createUser(b.t.base, "alice", "mdp-alice-1");
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await app.close();
    oublierConfigurationAudit();
    rmSync(audit, { recursive: true, force: true });
    rmSync(racine, { recursive: true, force: true });
    await b.fermer();
  });

  const mediane = (v: number[]): number => [...v].sort((x, y) => x - y)[Math.floor(v.length / 2)] ?? 0;

  it("temps réel : nom inconnu, mauvais mot de passe d'annuaire et compte local à mot de passe se recouvrent (8 requêtes simultanées chacun)", async () => {
    const classes: [string, string][] = [
      ["inconnu", "faux"],
      ["jean", "faux"],
      ["alice", "faux"],
    ];
    const medianes: number[] = [];
    for (const [c, [nom, mdp]] of classes.entries()) {
      const durees = await Promise.all(
        Array.from({ length: 8 }, async (_, i) => {
          const debut = performance.now();
          const r = await essai(nom, mdp, `10.1.${c}.${i + 1}`);
          expect(refuse(r)).toEqual(REFUS);
          return performance.now() - debut;
        }),
      );
      medianes.push(mediane(durees));
    }
    expect(Math.max(...medianes) - Math.min(...medianes)).toBeLessThan(300);
    expect(Math.min(...medianes)).toBeGreaterThanOrEqual(480);
  }, 60_000);

  it("une exception pendant la liaison de l'utilisateur : le même 401, après le plancher, jamais un 500", async () => {
    annuaire.liaisonsEnErreur.set(`uid=jean,${BASE}`, new Error("boom"));
    const debut = performance.now();
    const r = await essai("jean", MDP, "10.2.0.1");
    expect(refuse(r)).toEqual(REFUS);
    expect(performance.now() - debut).toBeGreaterThanOrEqual(480);
    expect(r.headers["set-cookie"]).toBeUndefined();
    expect(lignesJournal.join("\n")).not.toContain(MDP);
  });

  it("une erreur de base APRÈS une liaison réussie : le même 401, jamais un 500 qui dirait que le mot de passe était bon", async () => {
    const reel = b.t.base.ecriture.bind(b.t.base);
    let appels = 0;
    vi.spyOn(b.t.base, "ecriture").mockImplementation((fn) => {
      appels++;
      return appels === 2 ? Promise.reject(new Error("base occupée")) : reel(fn);
    });
    const debut = performance.now();
    const r = await essai("jean", MDP, "10.2.0.2");
    expect(appels).toBeGreaterThanOrEqual(2);
    expect(refuse(r)).toEqual(REFUS);
    expect(performance.now() - debut).toBeGreaterThanOrEqual(480);
    expect(await b.t.base.valeurs("SELECT 1 FROM user_identities")).toEqual([]);
  });

  it("la révocation de l'ancienne session qui échoue après un mot de passe juste : le même 401, après le plancher, refus audité, aucune session", async () => {
    const ouverte = cookies(await essai("alice", "mdp-alice-1", "10.2.1.1"));
    expect(ouverte).toContain("mcpwebui_session=");
    const reel = b.t.base.run.bind(b.t.base);
    vi.spyOn(b.t.base, "run").mockImplementation((sql, ...reste) =>
      /revoked_sessions/u.test(sql) ? Promise.reject(new Error("base occupée")) : reel(sql, ...reste),
    );
    const debut = performance.now();
    const r = await essai("alice", "mdp-alice-1", "10.2.1.2", ouverte);
    expect(refuse(r)).toEqual(REFUS);
    expect(performance.now() - debut).toBeGreaterThanOrEqual(480);
    expect(String(r.headers["set-cookie"] ?? "")).not.toMatch(/mcpwebui_session=[^;"]+;/u);
    expect(lignesJournal.join("\n")).not.toContain("mdp-alice-1");
    expect(
      lignesAuditRecentes({ actionPrefix: "auth.login.denied" }).some(
        (e) => (e["details"] as Record<string, unknown>)["reason"] === "session_open_failed",
      ),
    ).toBe(true);
  });

  it("une requête en 429 ne coûte aucune lecture du coffre ni des états de fournisseur", async () => {
    for (let i = 0; i < PAR_NOM_ET_ADRESSE.capacite; i++) await essai("jean", "faux", "10.3.0.1");
    const lectures: string[] = [];
    const reel = b.t.base.get.bind(b.t.base);
    vi.spyOn(b.t.base, "get").mockImplementation((...a: Parameters<typeof reel>) => {
      lectures.push(a[0]);
      return reel(...a);
    });
    expect((await essai("jean", "faux", "10.3.0.1")).statusCode).toBe(429);
    expect(lectures.filter((s) => /vault_secrets|auth_provider_state/u.test(s))).toEqual([]);
  }, 60_000);
});
