// SPDX-License-Identifier: MIT
/** apps/core/test/identite/banc-fournisseur.ts — base, config.json et coffre prêts : un ou plusieurs fournisseurs OIDC actifs (test réussi, secret rangé) sur l'un des deux moteurs. */
import { createUser } from "@elpis/auth";
import { initialiserBase } from "@elpis/db";
import { ouvrirBaseDeTest } from "@elpis/db/test";
import type { BaseDeTest } from "@elpis/db/test";

import { enregistrerSecret, enregistrerTestReussi } from "../../src/identite/fournisseurs";
import { validerFournisseur } from "../../src/identite/reglages";
import type { Fournisseur } from "../../src/identite/reglages";
import { cleCoffreDeTest, configDeTest, oidcValide } from "./aides";
import type { ConfigDeTest } from "./aides";

export const URL_PUBLIQUE = "https://elpis.exemple.lan";
const ACTEUR = { userId: null, username: null, ip: null };

export interface BancFournisseur {
  readonly t: BaseDeTest;
  readonly cfg: ConfigDeTest;
  readonly fournisseurs: Fournisseur[];
  /** Horloge en secondes, réglable. */
  horloge: number;
  fermer(): Promise<void>;
}

/** Fournisseurs OIDC actifs (`extra` par fournisseur, `id` sso, sso2…) et un administrateur local `chef`. */
export async function ouvrirBancFournisseur(
  moteur: "sqlite" | "postgres",
  extras: Record<string, unknown>[] = [{}],
): Promise<BancFournisseur> {
  const t = ouvrirBaseDeTest(moteur);
  await initialiserBase(t.base);
  await createUser(t.base, "chef", "mdp-chef-1", { isAdmin: 1 });
  cleCoffreDeTest();
  const cfg = configDeTest({ https: true });
  const fournisseurs: Fournisseur[] = [];
  for (const [i, extra] of extras.entries()) {
    const f = validerFournisseur(
      oidcValide({
        id: i === 0 ? "sso" : `sso${i + 1}`,
        enabled: true,
        required_groups: ["elpis"],
        issuer: `https://idp${i === 0 ? "" : i + 1}.exemple.lan/realms/elpis`,
        ...extra,
      }),
    );
    fournisseurs.push(f);
    await enregistrerSecret(t.base, f, "secret-client-de-test", ACTEUR);
    await enregistrerTestReussi(t.base, f, URL_PUBLIQUE);
  }
  cfg.ecrire({ auth: { public_url: URL_PUBLIQUE, providers: fournisseurs } });
  return {
    t,
    cfg,
    fournisseurs,
    horloge: 1_800_000_000,
    async fermer() {
      cfg.fermer();
      await t.fermer();
    },
  };
}
