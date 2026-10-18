// SPDX-License-Identifier: MIT
/** apps/core/src/relais/placement.ts — placement `by_user` des comptes sur les hôtes d'outils (lecture et affectation automatique de placement.py). */
import { intPy, strPy, stripPy } from "@elpis/commun";

import { base } from "../base";
import { journal } from "../journal";
import { lire, texteOu } from "./dict";
import type { Spec } from "./dict";

/** Hôte affecté au compte, ou `null` (aucune affectation, base illisible). */
export async function placementOf(uid: number): Promise<string | null> {
  try {
    const ligne = await base().get<{ host_id: unknown }>(
      "SELECT host_id FROM sandbox_placements WHERE user_id=?",
      [uid],
    );
    return ligne ? strPy(ligne.host_id) : null;
  } catch {
    return null;
  }
}

/** Nombre de comptes par hôte ; vide si la base est illisible. */
export async function countsByHost(): Promise<Map<string, number>> {
  try {
    const lignes = await base().all<{ host_id: unknown; n: unknown }>(
      "SELECT host_id, COUNT(*) AS n FROM sandbox_placements GROUP BY host_id",
    );
    return new Map(lignes.map((l) => [strPy(l.host_id), intPy(l.n)]));
  } catch {
    return new Map();
  }
}

/** Hôte le moins peuplé, l'ordre de déclaration départageant ; `defaut` si aucun hôte n'a d'URL. */
export async function leastLoaded(hotes: ReadonlyMap<string, Spec>, defaut = ""): Promise<string> {
  const ids = [...hotes].filter(([, spec]) => stripPy(texteOu(lire(spec, "url"), ""))).map(([id]) => id);
  if (ids.length === 0) return defaut;
  if (ids.length === 1) return ids[0] ?? defaut;
  const comptes = await countsByHost();
  let choisi = ids[0] ?? defaut;
  for (const id of ids) if ((comptes.get(id) ?? 0) < (comptes.get(choisi) ?? 0)) choisi = id;
  return choisi;
}

/** Affecte (ou réaffecte) le compte à un hôte. */
export async function assign(uid: number, hostId: string): Promise<void> {
  const maintenant = Date.now() / 1000;
  await base().run(
    "INSERT INTO sandbox_placements(user_id, host_id, created_at, updated_at) VALUES(?,?,?,?) " +
      "ON CONFLICT(user_id) DO UPDATE SET host_id=excluded.host_id, updated_at=excluded.updated_at",
    [uid, hostId, maintenant, maintenant],
  );
}

/** `host_for_user` : affectation existante si l'hôte est encore déclaré, sinon le moins chargé, ENREGISTRÉ (effet de bord voulu). */
export async function hostForUser(
  uid: number,
  hotes: ReadonlyMap<string, Spec>,
  defaut = "",
): Promise<string> {
  const actuel = await placementOf(uid);
  if (actuel && hotes.has(actuel)) return actuel;
  const choisi = (await leastLoaded(hotes, defaut)) || defaut;
  if (choisi && hotes.has(choisi)) {
    try {
      await assign(uid, choisi);
    } catch (e) {
      journal("placement").warn({ err: e }, `affectation de ${uid} → ${choisi} non persistée`);
    }
  }
  return choisi;
}
