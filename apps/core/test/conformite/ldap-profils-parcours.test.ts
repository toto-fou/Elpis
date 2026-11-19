// SPDX-License-Identifier: MIT
/** apps/core/test/conformite/ldap-profils-parcours.test.ts — parcours complet (service, recherche, état, appartenance, liaison, profil) contre chaque annuaire du marché sur un vrai LDAPS local : verdict par produit (SQLite, PostgreSQL si ELPIS_TEST_PG). */
import { createHash } from "node:crypto";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { authentifierParAnnuaire } from "../../src/identite/annuaire/connexion";
import type { BancAnnuaire } from "../identite/annuaire/banc-annuaire";
import { MOTEURS } from "../identite/banc";
import { OPENSSL_DISPONIBLE } from "../identite/pki-openssl";
import { demarrerHote, ouvrirBancReel } from "./banc-reel";
import type { Hote } from "./banc-reel";
import { MDP_PERSONNE, PROFILS } from "./profils-annuaire";
import type { ProfilAnnuaire } from "./profils-annuaire";

describe.skipIf(!OPENSSL_DISPONIBLE).each(MOTEURS)("parcours par annuaire du marché (%s)", (moteur) => {
  let hote: Hote;
  beforeAll(async () => {
    hote = await demarrerHote();
  });
  afterAll(async () => {
    await hote.fermer();
  });

  describe.each(PROFILS.map((f) => f()))("$libelle", (profil: ProfilAnnuaire) => {
    let b: BancAnnuaire;
    beforeEach(async () => {
      b = await ouvrirBancReel(moteur, hote, profil);
    });
    afterEach(async () => {
      expect(hote.serveur.erreursLecture()).toBe(0);
      await b.fermer();
    });
    const liaisons = (): string[] =>
      hote.serveur.requetes.filter((q) => q.type === "bind").map((q) => q.dn ?? "");

    it.each(profil.personnes.map((p) => [p.uid, p] as const))(
      "RFC 4513 §5.1.3 + produit : %s, une liaison de personne seulement pour une entrée active et membre",
      async (_uid, p) => {
        const r = await authentifierParAnnuaire(b.dep(), p.uid, p.mdp);
        if (p.attendu === null)
          expect(r).toMatchObject({
            type: "ok",
            appartenance: "oui",
            profil: { subject: p.cle, extUsername: p.uid },
          });
        else expect(r).toMatchObject({ type: "refus", raison: p.attendu });
        const personneLiee = liaisons().includes(p.dn);
        const attendueLiee = p.attendu === null || p.attendu === "bad_password";
        expect(personneLiee).toBe(attendueLiee);
      },
    );

    it("mauvais mot de passe : refus bad_password, le mot de passe du service n'est jamais envoyé pour la personne", async () => {
      const jean = profil.personnes.find((x) => x.attendu === null);
      if (jean === undefined) {
        expect(profil.personnes.every((x) => x.attendu !== null)).toBe(true);
        return;
      }
      expect(await authentifierParAnnuaire(b.dep(), jean.uid, `${MDP_PERSONNE}-faux`)).toMatchObject({
        type: "refus",
        raison: "bad_password",
      });
      const aLaPersonne = hote.serveur.requetes.filter((q) => q.type === "bind" && q.dn === jean.dn);
      const dusService = createHash("sha256").update(profil.serviceMdp).digest("hex");
      expect(aLaPersonne).toHaveLength(1);
      expect(aLaPersonne[0]?.empreinteMdp).not.toBe(dusService);
      expect(aLaPersonne[0]?.empreinteMdp).toBe(
        createHash("sha256").update(`${MDP_PERSONNE}-faux`).digest("hex"),
      );
    });

    it("identifiant inconnu : absent, aucune liaison de personne", async () => {
      expect(await authentifierParAnnuaire(b.dep(), "personne-ici", MDP_PERSONNE)).toEqual({
        type: "absent",
      });
      expect(liaisons()).toEqual([profil.serviceDn]);
    });
  });
});
