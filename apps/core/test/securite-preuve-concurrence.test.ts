// SPDX-License-Identifier: MIT
/** apps/core/test/securite-preuve-concurrence.test.ts — jamais plus de cinq mots de passe vérifiés pour une même ligne préparée, quel que soit le nombre de requêtes simultanées, d'adresses ou de connexions à la base, et aucune réponse ne distingue un mot de passe juste qui n'aboutit pas (SQLite, PostgreSQL si ELPIS_TEST_PG). */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createUser, dependancesParDefaut, verifyUser } from "@elpis/auth";
import { initialiserBase, ouvrirBase } from "@elpis/db";
import type { Base } from "@elpis/db";
import { ouvrirBaseDeTest, reglagesPgDeTest } from "@elpis/db/test";
import type { BaseDeTest } from "@elpis/db/test";
import { configureAudit, oublierConfigurationAudit } from "@elpis/securite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { LightMyRequestResponse } from "fastify";

import { ancreIdentite } from "../src/identite/ancre";
import { preparerRattachement, prouverEtRattacher } from "../src/identite/rattachement";
import type { ResultatPreuve } from "../src/identite/rattachement";
import type { DependancesProvisionnement } from "../src/identite/provisionnement";
import { validerFournisseur } from "../src/identite/reglages";
import type { FournisseurOidc } from "../src/identite/reglages";
import { journalMuet } from "./aides";
import { oidcValide } from "./identite/aides";
import { MOTEURS } from "./identite/banc";
import { adresseNeuve, cookies, ELPIS, HOTE_PUBLIC, ouvrirBancOidc } from "./identite/banc-oidc";
import type { BancOidc } from "./identite/banc-oidc";
import { OPENSSL_DISPONIBLE } from "./identite/pki-openssl";

describe.each(MOTEURS)("preuve : deux connexions réelles à la base (%s)", (moteur) => {
  let t: BaseDeTest;
  let seconde: Base;
  let dossier: string;
  let dep: DependancesProvisionnement;
  let dep2: DependancesProvisionnement;
  const fournisseur = validerFournisseur(
    oidcValide({ id: "sso", required_groups: ["elpis"] }),
  ) as FournisseurOidc;
  const profil = {
    subject: "sub-1",
    issuer: ancreIdentite(fournisseur),
    extUsername: "jean.dupont",
    extEmail: "",
    extName: "",
  };

  beforeEach(async () => {
    t = ouvrirBaseDeTest(moteur);
    await initialiserBase(t.base);
    seconde = ouvrirBase(
      moteur === "sqlite"
        ? { backend: "sqlite", path: t.emplacement, lockTimeoutMs: 20_000 }
        : reglagesPgDeTest(t.emplacement),
    );
    dossier = mkdtempSync(join(tmpdir(), "elpis-conc-"));
    configureAudit({ service: "admin", auditDir: dossier, hmacKeyPath: join(dossier, "sans-cle") });
    const commun = {
      maintenant: () => 1_800_000_000,
      publierSuspension: async () => true,
      revoquer: async () => undefined,
      journal: journalMuet,
    };
    dep = { ...commun, base: t.base, acces: dependancesParDefaut(t.base) };
    dep2 = { ...commun, base: seconde, acces: dependancesParDefaut(seconde) };
  });
  afterEach(async () => {
    await seconde.fermer();
    await t.fermer();
    oublierConfigurationAudit();
    rmSync(dossier, { recursive: true, force: true });
  });

  const preparer = async (uid: number): Promise<number> => {
    const chef = await createUser(t.base, "chef", "mdp-chef-1", { isAdmin: 1 });
    const r = await t.base.ecriture((x) =>
      preparerRattachement(x, {
        uid,
        fournisseurId: "sso",
        ancre: ancreIdentite(fournisseur),
        attendu: "jean.dupont",
        dispense: false,
        confirmeAdmin: false,
        par: chef,
        t: 1_800_000_000,
      }),
    );
    if ("raison" in r) throw new Error(r.raison);
    return r.id;
  };
  const tenter = (d: DependancesProvisionnement, id: number, motDePasse: string): Promise<ResultatPreuve> =>
    prouverEtRattacher(d, {
      fournisseur,
      prelinkId: id,
      profil,
      appartenance: "oui",
      motDePasse,
      ip: null,
    });

  it("seize preuves à mauvais mot de passe sur deux connexions : cinq vérifications au plus, les autres refusées avant toute vérification", async () => {
    const jean = await createUser(t.base, "jean-dupont", "mdp-local-1");
    const id = await preparer(jean);
    const r = await Promise.all(
      Array.from({ length: 16 }, (_, n) => tenter(n % 2 === 0 ? dep : dep2, id, `faux-${n}`)),
    );
    const verifies = r.filter((x) => x.type === "mot_de_passe");
    expect(verifies.length).toBeLessThanOrEqual(5);
    expect(verifies.length).toBeGreaterThan(0);
    expect(r.filter((x) => x.type === "refus")).toHaveLength(16 - verifies.length);
    expect(await t.base.valeurs("SELECT COUNT(*) FROM auth_prelinks")).toEqual([[0]]);
    expect((await tenter(dep, id, "mdp-local-1")).type).toBe("refus");
    expect(await verifyUser(t.base, "jean-dupont", "mdp-local-1")).toBe(jean);
    expect(await t.base.valeurs("SELECT COUNT(*) FROM user_identities")).toEqual([[0]]);
  });

  it.each([0, 4, 9])(
    "neuf mauvais mots de passe et le bon (en position %i) en parallèle : jamais de réponse propre au bon mot de passe quand il n'aboutit pas",
    async (rang) => {
      const jean = await createUser(t.base, "jean-dupont", "mdp-local-1");
      const id = await preparer(jean);
      const mots = Array.from({ length: 10 }, (_, n) => `faux-${n}`);
      mots[rang] = "mdp-local-1";
      const r = await Promise.all(mots.map((m, n) => tenter(n % 2 === 0 ? dep : dep2, id, m)));
      const bon = r[rang] as ResultatPreuve;
      const verifies = r.filter((x) => x.type !== "refus");
      expect(verifies.length).toBeLessThanOrEqual(5);
      expect(["compte", "mot_de_passe", "refus"]).toContain(bon.type);
      for (const x of r)
        if (x.type === "refus") expect(x).toEqual({ type: "refus", raison: "prelink_invalid", uid: jean });
      const lie = (await t.base.valeurs("SELECT COUNT(*) FROM user_identities"))[0]?.[0];
      expect(Number(lie)).toBe(bon.type === "compte" ? 1 : 0);
      if (bon.type !== "compte") expect(await verifyUser(t.base, "jean-dupont", "mdp-local-1")).toBe(jean);
    },
  );
});

describe.skipIf(!OPENSSL_DISPONIBLE).each(MOTEURS)(
  "preuve : requêtes simultanées par la route (%s)",
  (moteur) => {
    let b: BancOidc;
    let jean: number;

    const prouver = (cookie: string, motDePasse: string): Promise<LightMyRequestResponse> =>
      b.main.inject({
        method: "POST",
        url: "/api/auth/oidc/link-proof",
        remoteAddress: adresseNeuve(),
        headers: { host: HOTE_PUBLIC, "sec-fetch-site": "same-origin", cookie },
        payload: { password: motDePasse },
      });

    beforeEach(async () => {
      b = await ouvrirBancOidc(moteur);
      jean = await createUser(b.t.base, "jean-dupont", "mdp-local-1");
      const r = await b.t.base.ecriture((x) =>
        preparerRattachement(x, {
          uid: jean,
          fournisseurId: "sso",
          ancre: ancreIdentite(b.fournisseur),
          attendu: "jean.dupont",
          dispense: false,
          confirmeAdmin: false,
          par: b.chef,
          t: Date.now() / 1000,
        }),
      );
      if ("raison" in r) throw new Error(r.raison);
    });
    afterEach(async () => {
      await b.fermer();
    });

    const cookieDeJean = async (): Promise<string> =>
      (await b.connecter(ELPIS("sub-jd", { preferred_username: "jean.dupont" }))).session;

    it("seize preuves fausses depuis seize adresses : cinq au plus reçoivent 401, les autres 409, le bon mot de passe ne sert plus", async () => {
      const cookie = await cookieDeJean();
      const r = await Promise.all(Array.from({ length: 16 }, (_, n) => prouver(cookie, `faux-${n}`)));
      const codes = r.map((x) => x.statusCode);
      expect(codes.filter((c) => c === 401).length).toBeLessThanOrEqual(5);
      expect(codes.filter((c) => c === 401).length + codes.filter((c) => c === 409).length).toBe(16);
      expect((await prouver(cookie, "mdp-local-1")).statusCode).toBe(409);
      expect(await b.t.base.valeurs("SELECT COUNT(*) FROM user_identities")).toEqual([[0]]);
    });

    it("neuf fausses et la bonne en parallèle : la bonne reçoit 200, 401 ou 409 sans que 409 dépende du mot de passe ; la session n'existe que pour le 200", async () => {
      const cookie = await cookieDeJean();
      const mots = [...Array.from({ length: 9 }, (_, n) => `faux-${n}`), "mdp-local-1"];
      const r = await Promise.all(mots.map((m) => prouver(cookie, m)));
      const bon = r[9] as LightMyRequestResponse;
      expect([200, 401, 409]).toContain(bon.statusCode);
      expect(r.filter((x) => x.statusCode === 200 || x.statusCode === 401).length).toBeLessThanOrEqual(5);
      expect(r.slice(0, 9).every((x) => x.statusCode === 401 || x.statusCode === 409)).toBe(true);
      const lies = await b.t.base.valeurs("SELECT COUNT(*) FROM user_identities");
      expect(lies).toEqual([[bon.statusCode === 200 ? 1 : 0]]);
      if (bon.statusCode === 200) {
        const moi = await b.main.inject({
          method: "GET",
          url: "/api/me-lite",
          headers: { cookie: cookies(bon, cookie) },
        });
        expect(moi.json()).toMatchObject({ logged_in: true, username: "jean-dupont" });
      } else {
        expect(String(bon.headers["set-cookie"] ?? "")).not.toContain("mcpwebui_session");
      }
    });
  },
);
