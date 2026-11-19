// SPDX-License-Identifier: MIT
/** packages/contracts/src/rest/admin-identite-oidc.ts — console › essai à blanc d'un fournisseur SSO : lancement (étapes puis adresse d'autorisation) et dernier résultat. */
import { z } from "zod";

/** Étapes du test préalable ; `url` n'est rendue que si toutes passent : l'administrateur s'y connecte dans un nouvel onglet. */
export const schemaReponseLancementEssai = z.object({
  ok: z.boolean(),
  steps: z.array(
    z.object({
      id: z.string(),
      label: z.string(),
      level: z.enum(["ok", "warn", "fail"]),
      detail: z.string(),
      target: z.string().nullable(),
    }),
  ),
  url: z.string().nullable(),
});
export type ReponseLancementEssai = z.infer<typeof schemaReponseLancementEssai>;

/** Résultat d'un essai à blanc : revendications d'une liste blanche (groupes tronqués à 50, `null` quand ils ne se lisent pas) et décision qui serait prise. */
export const schemaResultatEssaiBlanc = z.object({
  /** Secondes depuis l'époque. */
  at: z.number(),
  /** Le parcours est allé au bout et les groupes se lisent : le test du fournisseur est alors retenu. */
  ok: z.boolean(),
  claims: z
    .object({
      iss: z.string(),
      subject: z.string(),
      identifier: z.string(),
      name: z.string(),
      email: z.string(),
      email_verified: z.boolean(),
      acr: z.string().nullable(),
      amr: z.array(z.string()),
      groups: z.array(z.string()).nullable(),
    })
    .nullable(),
  decision: z.object({
    outcome: z.enum(["login", "create", "refuse", "error"]),
    username: z.string().nullable(),
    /** Code de refus ou cause (liste fermée), jamais un message du fournisseur. */
    reason: z.string().nullable(),
  }),
  warnings: z.array(z.string()),
});
export type ResultatEssaiBlanc = z.infer<typeof schemaResultatEssaiBlanc>;

export const schemaReponseDernierEssai = z.object({ result: schemaResultatEssaiBlanc.nullable() });
export type ReponseDernierEssai = z.infer<typeof schemaReponseDernierEssai>;
export const schemaCorpsLancementEssai = z.object({}).strict().optional();
