// SPDX-License-Identifier: MIT
/** apps/core/src/admin/comptes.ts — machines desktop d'un compte et accès aux serveurs d'inférence vus de la console (admin/users.py, groups.py). */
import { getUserGroups, ligneUtilisateur } from "@elpis/auth";
import {
  cleHashPy,
  comparePointsDeCode,
  copieProfondePy,
  estDict,
  getPy,
  HttpError,
  iterExige,
  poserCle,
  strPy,
  stripPy,
  veritePy,
} from "@elpis/commun";
import type { Dict } from "@elpis/commun";
import {
  getDesktopTargets,
  lireConfigDisque,
  reloadDesktopConfigFromDisk,
  sousVerrouConfigJson,
  writeConfigJson,
} from "@elpis/config";
import type { Executeur } from "@elpis/db";
import type { FastifyRequest } from "fastify";

import { journal } from "../journal";
import { getPolicy, normalizeEngineKeys, resolveAccess, ValeurInvalide } from "../llm/acces-moteurs";
import type { Politique } from "../llm/acces-moteurs";
import { corpsJsonValeurs } from "@elpis/http";

const log = journal("admin");

/** `_desktop_targets_view` : machines déclarées, relues sur disque (une relecture qui échoue garde la vue en mémoire). */
export function vueCiblesBureau(): Dict[] {
  try {
    reloadDesktopConfigFromDisk();
  } catch (e) {
    log.debug({ err: e }, "[admin] relecture de la config desktop en échec");
  }
  return getDesktopTargets(false).map((t) => ({
    name: t.name,
    os: t.os,
    access: t.access,
    allowed_users: [...t.allowed_users],
  }));
}

/** `_set_desktop_membership` : `username` ajouté aux machines `noms` en accès `list`, retiré des autres ; rend les machines modifiées. */
export async function definirAccesBureau(username: string, noms: ReadonlySet<string>): Promise<unknown[]> {
  const modifiees = await sousVerrouConfigJson(() => {
    const cfg = copieProfondePy(lireConfigDisque() ?? {});
    const bureau = getPy(cfg, "desktop", null);
    const cibles = getPy(veritePy(bureau) ? bureau : {}, "targets", null);
    if (!Array.isArray(cibles)) return [];
    const changees: unknown[] = [];
    for (const t of cibles) {
      if (!estDict(t)) continue;
      const acces = getPy(t, "access", null);
      if (strPy(veritePy(acces) ? acces : "all") !== "list") continue;
      const autorises = getPy(t, "allowed_users", null);
      const actuels = new Set(
        iterExige(veritePy(autorises) ? autorises : [])
          .map((u) => strPy(u))
          .filter((u) => stripPy(u)),
      );
      const nom = getPy(t, "name", null);
      const voulus = new Set(actuels);
      if (noms.has(cleHashPy(nom) as string)) voulus.add(username);
      else voulus.delete(username);
      if (voulus.size !== actuels.size || [...voulus].some((u) => !actuels.has(u))) {
        poserCle(t, "allowed_users", [...voulus].sort(comparePointsDeCode));
        changees.push(nom);
      }
    }
    if (changees.length) writeConfigJson(cfg);
    return changees;
  });
  if (modifiees.length) reloadDesktopConfigFromDisk(true);
  return modifiees;
}

/** `_user_llm_access_view` : réglage propre du compte et accès effectif (hérité des groupes, administrateur = tout). */
export async function vueAccesLlm(base: Executeur, cibleId: number): Promise<Dict> {
  const cible = await ligneUtilisateur(base, cibleId);
  const propre = await getPolicy(base, "user", cibleId);
  const groupes: Politique[] = [];
  for (const g of await getUserGroups(base, cibleId))
    groupes.push(await getPolicy(base, "group", Number(g.id)));
  const res = resolveAccess(propre, groupes, {
    isAdmin: cible !== undefined && Number(cible.is_admin) === 1,
  });
  return {
    engine_keys: propre.engine_keys,
    can_manage_models: propre.can_manage_models,
    effective_engine_keys: res.engine_keys === null ? null : [...res.engine_keys].sort(comparePointsDeCode),
    engine_source: res.engine_source,
    effective_can_manage_models: res.can_manage_models,
    manage_source: res.manage_source,
  };
}

/** `_read_llm_access_body` : une clé absente du corps garde la valeur actuelle ; serveurs inconnus ou valeur invalide = 400. */
export async function lireCorpsAccesLlm(
  base: Executeur,
  requete: FastifyRequest,
  actuelle: Politique,
): Promise<{ engine_keys: string[] | null; can_manage_models: unknown }> {
  let data: unknown;
  try {
    data = corpsJsonValeurs(requete);
  } catch {
    throw new HttpError(400, "Corps JSON attendu");
  }
  if (!estDict(data)) throw new HttpError(400, "Corps JSON attendu");
  let keys = actuelle.engine_keys;
  let gestion: unknown = actuelle.can_manage_models;
  if (Object.hasOwn(data, "engine_keys")) {
    try {
      keys = await normalizeEngineKeys(base, data["engine_keys"], { checkExists: true });
    } catch (e) {
      if (e instanceof ValeurInvalide) throw new HttpError(400, e.message);
      throw e;
    }
  }
  if (Object.hasOwn(data, "can_manage_models")) {
    gestion = data["can_manage_models"];
    if (gestion !== null && typeof gestion !== "boolean")
      throw new HttpError(400, "can_manage_models doit être null, true ou false");
  }
  return { engine_keys: keys, can_manage_models: gestion };
}
