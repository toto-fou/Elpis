// SPDX-License-Identifier: MIT
/** packages/contracts/test/toolhost/aides.ts — appels à l'hôte d'outils réel (enveloppe signée) et vérification des réponses contre le registre `CONTRATS_REST_TOOLHOST`. */
import { expect } from "vitest";

import { CONTRATS_REST_TOOLHOST, contratToolhostDe, schemaErreurApi } from "../../src";
import type { ContratToolhost } from "../../src";
import { entetes, hoteTest } from "../../../../apps/toolhost/test/aides";
import type { HoteTest } from "../../../../apps/toolhost/test/aides";

export function cleToolhost(r: ContratToolhost): string {
  return `${r.methode} ${r.chemin}`;
}

export interface Reponse {
  readonly statut: number;
  readonly texte: string;
}

/** Réponse validée : succès par le contrat (rien d'ajouté ni de retiré), flux NDJSON ligne à ligne, erreur par `{detail}`. */
export function verifierToolhost(methode: string, url: string, r: Reponse, couvertes: Set<string>): unknown {
  const contrat = contratToolhostDe(methode, url);
  expect(contrat, `${methode} ${url} sans contrat`).toBeDefined();
  if (contrat === undefined) return undefined;
  couvertes.add(cleToolhost(contrat));
  if (r.statut >= 400) {
    const erreur: unknown = JSON.parse(r.texte);
    expect(schemaErreurApi.safeParse(erreur).success, `${methode} ${url} : ${r.texte}`).toBe(true);
    return erreur;
  }
  expect(r.statut, `${methode} ${url} : ${r.texte.slice(0, 300)}`).toBe(200);
  if (contrat.flux !== undefined) {
    const evenements = r.texte
      .split("\n")
      .filter((l) => l !== "")
      .map((l): unknown => JSON.parse(l));
    for (const e of evenements) {
      const v = contrat.flux.safeParse(e);
      expect(v.success ? null : v.error.issues, `${methode} ${url} : ${JSON.stringify(e)}`).toBeNull();
      expect(v.data, `${methode} ${url} : champ hors contrat`).toEqual(e);
    }
    return evenements;
  }
  const corps: unknown = JSON.parse(r.texte);
  expect(contrat.reponse, `${methode} ${url}`).not.toBeNull();
  const v = contrat.reponse?.safeParse(corps);
  expect(v?.success ? null : v?.error.issues, `${methode} ${url} : ${r.texte.slice(0, 400)}`).toBeNull();
  expect(v?.data, `${methode} ${url} : champ hors contrat`).toEqual(corps);
  return corps;
}

/** Appel de l'hôte avec l'enveloppe du compte 7 (`hugo`). */
export async function appelerHote(
  h: HoteTest,
  methode: string,
  url: string,
  corps?: unknown,
  plus: Record<string, string> = {},
): Promise<Reponse> {
  const brut =
    corps === undefined
      ? undefined
      : typeof corps === "string" || Buffer.isBuffer(corps)
        ? corps
        : JSON.stringify(corps);
  const r = await h.app.inject({
    method: methode as "GET",
    url,
    headers: {
      ...entetes(),
      ...(corps !== undefined && typeof corps !== "string" && !Buffer.isBuffer(corps)
        ? { "content-type": "application/json" }
        : {}),
      ...plus,
    },
    ...(brut !== undefined ? { payload: brut } : {}),
  });
  return { statut: r.statusCode, texte: r.body };
}

/** Routes du registre, par famille, que les tests d'un domaine doivent toutes avoir interrogées. */
export function routesDuDomaine(domaine: string): string[] {
  return CONTRATS_REST_TOOLHOST.filter((r) => r.domaine === domaine).map(cleToolhost);
}

export { hoteTest };
export type { HoteTest };
