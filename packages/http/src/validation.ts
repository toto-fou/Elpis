// SPDX-License-Identifier: MIT
/** packages/http/src/validation.ts — entrées typées d'une route (chemin, requête, corps) validées ensemble comme FastAPI 0.136. */
import type { FastifyRequest } from "fastify";

import { lireCorps } from "./corps";
import { erreurValidation, horsBornes, validerPy } from "./pydantic";
import type { Champs, ErreurPy, SchemaPy, SortieChamps } from "./pydantic";
import { analyserRequete } from "./url";

const requetesAnalysees = new WeakMap<FastifyRequest, [string, string][]>();

/** Chaîne de requête après le premier `?` et avant le fragment `#`, que le client n'envoie normalement pas. */
function parametresBruts(requete: FastifyRequest): [string, string][] {
  let paires = requetesAnalysees.get(requete);
  if (!paires) {
    const url = requete.raw.url ?? requete.url;
    const diese = url.indexOf("#");
    const sansFragment = diese < 0 ? url : url.slice(0, diese);
    const debut = sansFragment.indexOf("?");
    paires = analyserRequete(debut < 0 ? "" : sansFragment.slice(debut + 1));
    requetesAnalysees.set(requete, paires);
  }
  return paires;
}

/** Valeur brute d'un paramètre de requête : la dernière occurrence (liste entière pour un schéma de liste). */
function valeurDeRequete(requete: FastifyRequest, cle: string, schema: SchemaPy<unknown>): unknown {
  const valeurs = parametresBruts(requete)
    .filter(([nom]) => nom === cle)
    .map(([, v]) => v);
  if (schema.options.sequence) return valeurs.length > 0 ? valeurs : undefined;
  return valeurs[valeurs.length - 1];
}

function valeurDeChemin(requete: FastifyRequest, cle: string): unknown {
  const params = requete.params as Record<string, unknown> | undefined;
  return params && Object.hasOwn(params, cle) ? params[cle] : undefined;
}

interface Collecte {
  erreurs: ErreurPy[];
  horsBornes: boolean;
}

/** `_validate_value_with_model_field` : absent ⇒ défaut ou `missing` (`input: null`), sinon validation lax. */
function validerParametres(
  champs: Champs,
  emplacement: "path" | "query",
  lire: (cle: string, schema: SchemaPy<unknown>) => unknown,
  collecte: Collecte,
): Record<string, unknown> {
  const sortie: Record<string, unknown> = {};
  for (const [nom, schema] of Object.entries(champs)) {
    const cle = schema.options.alias ?? nom;
    const brute = lire(cle, schema);
    if (brute === undefined) {
      if (schema.options.defaut) sortie[nom] = schema.options.defaut();
      else
        collecte.erreurs.push({
          type: "missing",
          loc: [emplacement, cle],
          msg: "Field required",
          input: null,
        });
      continue;
    }
    const resultat = validerPy(schema, brute, [emplacement, cle]);
    collecte.horsBornes ||= resultat.horsBornes;
    if (resultat.ok) sortie[nom] = resultat.valeur;
    else collecte.erreurs.push(...resultat.erreurs);
  }
  return sortie;
}

export interface SpecEntrees {
  readonly path?: Champs;
  readonly query?: Champs;
  readonly body?: SchemaPy<unknown>;
}

type SortieOuVide<C> = C extends Champs ? SortieChamps<C> : Record<string, never>;

export interface Entrees<S extends SpecEntrees> {
  path: SortieOuVide<S extends { path: infer P } ? P : undefined>;
  query: SortieOuVide<S extends { query: infer Q } ? Q : undefined>;
  body: S extends { body: SchemaPy<infer T> } ? T : undefined;
}

/** Comme `solve_dependencies` : corps illisible d'abord, puis un seul 422 (chemin, requête, corps), puis 400 si un entier dépasse 2^53. */
export function entrees<const S extends SpecEntrees>(requete: FastifyRequest, spec: S): Entrees<S> {
  const corps = spec.body ? lireCorps(requete) : undefined;
  const collecte: Collecte = { erreurs: [], horsBornes: false };
  const path = validerParametres(spec.path ?? {}, "path", (cle) => valeurDeChemin(requete, cle), collecte);
  const query = validerParametres(
    spec.query ?? {},
    "query",
    (cle, schema) => valeurDeRequete(requete, cle, schema),
    collecte,
  );
  let body: unknown;
  if (spec.body && corps) {
    if (corps.present) {
      const resultat = validerPy(spec.body, corps.valeur, ["body"]);
      collecte.horsBornes ||= resultat.horsBornes;
      if (resultat.ok) body = resultat.valeur;
      else collecte.erreurs.push(...resultat.erreurs);
    } else if (spec.body.options.defaut) body = spec.body.options.defaut();
    else collecte.erreurs.push({ type: "missing", loc: ["body"], msg: "Field required", input: null });
  }
  if (collecte.erreurs.length > 0) throw erreurValidation(collecte.erreurs);
  if (collecte.horsBornes) throw horsBornes();
  return { path, query, body } as Entrees<S>;
}
