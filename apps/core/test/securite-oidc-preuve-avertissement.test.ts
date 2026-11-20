// SPDX-License-Identifier: MIT
/** apps/core/test/securite-oidc-preuve-avertissement.test.ts — la session ouverte après la preuve du titulaire avertit le journal quand le jeton d'identité ne peut pas être gardé (SQLite, PostgreSQL si ELPIS_TEST_PG). */
import type * as Securite from "@elpis/securite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { lignesJournal } from "./aides";
import { MOTEURS } from "./identite/banc";
import { adresseNeuve, ELPIS, HOTE_PUBLIC, ouvrirBancOidc } from "./identite/banc-oidc";
import type { BancOidc } from "./identite/banc-oidc";
import { OPENSSL_DISPONIBLE } from "./identite/pki-openssl";
import { ancreIdentite } from "../src/identite/ancre";
import { preparerRattachement } from "../src/identite/rattachement";
import { createUser } from "@elpis/auth";

vi.mock("@elpis/securite", async (original) => {
  const m = await original<typeof Securite>();
  return {
    ...m,
    chiffrerSecret: (t: string, contexte: string) => {
      if (contexte.startsWith("auth-ext-session:")) throw new Error("clé du coffre absente");
      return m.chiffrerSecret(t, contexte);
    },
  };
});

describe.skipIf(!OPENSSL_DISPONIBLE).each(MOTEURS)(
  "preuve du titulaire sans clé du coffre (%s)",
  (moteur) => {
    let b: BancOidc;
    beforeEach(async () => {
      lignesJournal.length = 0;
      b = await ouvrirBancOidc(moteur);
    });
    afterEach(async () => {
      await b.fermer();
    });

    it("session ouverte après la preuve : avertissement au journal, jeton d'identité non gardé", async () => {
      const jean = await createUser(b.t.base, "jean-dupont", "mdp-local-1");
      await b.t.base.ecriture((x) =>
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
      const { session: cookie } = await b.connecter(ELPIS("sub-jd", { preferred_username: "jean.dupont" }));
      const r = await b.main.inject({
        method: "POST",
        url: "/api/auth/oidc/link-proof",
        remoteAddress: adresseNeuve(),
        headers: { host: HOTE_PUBLIC, "sec-fetch-site": "same-origin", cookie },
        payload: { password: "mdp-local-1" },
      });
      expect(r.statusCode, r.body).toBe(200);
      expect(lignesJournal.some((l) => l.includes("jeton d'identité non gardé"))).toBe(true);
      expect(await b.t.base.valeurs("SELECT id_token_enc FROM auth_ext_sessions")).toEqual([[null]]);
    });
  },
);
