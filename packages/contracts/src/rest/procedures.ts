// SPDX-License-Identifier: MIT
/** packages/contracts/src/rest/procedures.ts — accords humains des gestes sensibles d'une procédure (`/api/procedures/approbations*`) : demandes en attente d'une conversation, décision du compte. */
import { z } from "zod";

import { entier, horodatage } from "./commun";

export const schemaDemandeApprobation = z.object({
  id: z.string(),
  chat_id: z.string(),
  procedure_id: z.string(),
  version: entier,
  path: z.string(),
  description: z.string(),
  /** Geste demandé : action, cibles et valeur après substitution des paramètres, URL visée. */
  gesture: z.object({
    act: z.string(),
    targets: z.array(z.string()),
    value: z.string(),
    url: z.string(),
  }),
  page: z.string(),
  /** Premier passage d'un geste ajouté ou modifié par une réparation. */
  once: z.boolean(),
  /** Le geste `once` vient d'une réparation (sinon d'un enregistrement). */
  repaired: z.boolean(),
  state: z.enum(["pending", "approved", "refused", "consumed"]),
  created_at: horodatage,
  expires_at: horodatage,
});
export type DemandeApprobation = z.infer<typeof schemaDemandeApprobation>;
export const schemaReponseApprobations = z.object({ items: z.array(schemaDemandeApprobation) });

export const schemaCorpsDecisionApprobation = z.object({ decision: z.enum(["approve", "refuse"]) });
export const schemaReponseDecisionApprobation = z.object({
  ok: z.literal(true),
  item: schemaDemandeApprobation,
});

export const schemaVersionProcedure = z.object({
  version: entier,
  created_at: horodatage,
  parent_version: entier.nullable(),
  repaired_path: z.string().nullable(),
  /** Approuvée par l'utilisateur ; seule une version approuvée s'exécute sans humain (routine, sous-agent). */
  approved_at: horodatage.nullable(),
});
export const schemaProcedureListee = z.object({
  id: z.string(),
  origin: z.string(),
  description: z.string(),
  versions: z.array(schemaVersionProcedure),
});
export type ProcedureListee = z.infer<typeof schemaProcedureListee>;
export const schemaReponseProcedures = z.object({ items: z.array(schemaProcedureListee) });
/** Résumé lisible d'une version : une ligne par nœud, indentée par profondeur. */
export const schemaChoixParametre = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("fixed"), value: z.union([z.string(), z.number()]) }),
  z.object({ mode: z.literal("free") }),
]);
export type ChoixParametre = z.infer<typeof schemaChoixParametre>;
/** Approbation d'une version : un choix pour CHAQUE paramètre déclaré hors `creds` (figé, ou libre), jamais implicite. */
export const schemaCorpsApprobationVersion = z.object({ params: z.record(z.string(), schemaChoixParametre) });
export const schemaReponseResumeProcedure = z.object({
  lines: z.array(z.string()),
  readable: z.boolean(),
  approved: z.boolean(),
  /** Paramètres déclarés ; `choice` : le choix de l'approbation (`null` : non approuvée ou approuvée sans choix). */
  params: z.array(
    z.object({
      name: z.string(),
      type: z.enum(["string", "number", "creds"]),
      choice: schemaChoixParametre.nullable(),
    }),
  ),
});
export const schemaReponseApprobationVersion = z.object({ ok: z.literal(true), approved_at: horodatage });
export const schemaReponseRetraitApprobation = z.object({ ok: z.literal(true) });
export const schemaReponseSuppressionProcedure = z.object({ ok: z.literal(true), deleted: entier });

/** Apprentissage : brouillon d'une conversation, aperçu et enregistrement d'une version NON approuvée. */
export const schemaNoeudBrouillon = z.object({
  id: entier,
  genre: z.enum(["act", "login"]),
  source: z.string(),
  /** Résumé lisible du nœud (jamais de valeur secrète). */
  libelle: z.string(),
  effet: z.boolean(),
  confirmSuggere: z.boolean(),
  /** Connexion : cible d'attente à fournir par l'utilisateur (jamais devinée). */
  waitForRequis: z.boolean(),
});
export const schemaParamSuggere = z.object({
  nom: z.string(),
  valeur: z.string(),
  noeuds: z.array(entier),
  champ: z.enum(["v", "url", "chemin"]),
  /** Jamais de littéral (champ ou clé sensible) : le paramètre n'est pas décochable. */
  impose: z.boolean(),
  /** La valeur n'est jamais montrée (`valeur` vide). */
  masque: z.boolean(),
});
export const schemaChoixApprentissage = z.object({
  id: z.string().max(64),
  description: z.string().max(500),
  params: z.record(z.string(), z.boolean()),
  confirm: z.record(z.string(), z.boolean()),
  retires: z.array(entier).max(200),
  wait_for: z.record(z.string(), z.string().max(200)),
});
export type ChoixApprentissageDto = z.infer<typeof schemaChoixApprentissage>;
export const schemaCorpsApprentissage = z.object({
  chat_id: z.string().min(1).max(200),
  origin: z.string().max(300).optional(),
  choix: schemaChoixApprentissage.optional(),
  /** Empreinte du brouillon relue à l'aperçu : l'enregistrement la compare à celle de la conversation actuelle. */
  empreinte: z.string().max(100).optional(),
});
export const schemaReponseBrouillon = z.object({
  origin: z.string(),
  origines: z.array(z.object({ origin: z.string(), gestes: entier })),
  noeuds: z.array(schemaNoeudBrouillon),
  params: z.array(schemaParamSuggere),
  ecartes: z.array(z.object({ raison: z.string(), quoi: z.string() })),
  empreinte: z.string(),
  choix: schemaChoixApprentissage,
  /** Procédures du compte de même identifiant : l'enregistrement crée alors une nouvelle version. */
  existantes: z.array(z.object({ id: z.string(), origin: z.string() })),
});
export type BrouillonDto = z.infer<typeof schemaReponseBrouillon>;
export const schemaReponseApercu = z.object({
  ok: z.boolean(),
  lines: z.array(z.string()),
  erreurs: z.array(z.string()),
  empreinte: z.string(),
});
export const schemaReponseEnregistrementProcedure = z.object({
  ok: z.literal(true),
  id: z.string(),
  version: entier,
});
