// SPDX-License-Identifier: MIT
/** apps/core/src/apparence/comptes-perso.ts — habillages personnels d'un compte : réglages admin, stockage `_comptes/<uid>/<id>/skin.json`, lecture revérifiée, feuille, suppression, résolution du skin choisi. */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";

import { decoderUtf8, pyJsonLoads } from "@elpis/commun";
import { PREFIXE_PERSO } from "@elpis/contracts";
import type { Dict } from "@elpis/commun";
import { liveConfigValue, pyJoin } from "@elpis/config";

import { estErreurOs, rmtree } from "../skills/chemins";
import { ecrireNouveauDossier } from "./ecritures";
import { evaluerSkinPerso } from "./perso";
import type { RapportPerso } from "./perso";
import { defaultSkin, estDossierPy, existePy, ID_RE, resolveUserSkin, skinsDir } from "./skins";

export const USER_MAX_DEFAUT = 10;
const DOSSIER_COMPTES = "_comptes";

export interface SkinPerso {
  id: string;
  label: string;
  desc: string;
  darkBase: boolean;
  sw: string[];
  rev: string;
}

/** `skins.user_custom` : la fonction est active sauf si l'administrateur l'a coupée (`false`). */
export function persoActif(): boolean {
  return liveConfigValue("skins.user_custom", true) !== false;
}

/** `skins.user_max` : plafond d'habillages par compte (entier ≥ 0), 10 par défaut. */
export function persoMax(): number {
  const v = liveConfigValue("skins.user_max", USER_MAX_DEFAUT);
  return typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : USER_MAX_DEFAUT;
}

/** Dossier d'un compte (l'identifiant numérique ne sort jamais d'un chemin arbitraire). */
export function dossierCompte(uid: number): string {
  if (!Number.isSafeInteger(uid) || uid < 0) throw new Error("identifiant de compte invalide");
  return pyJoin(pyJoin(skinsDir(), DOSSIER_COMPTES), String(uid));
}

interface Lu {
  manifeste: Record<string, unknown>;
  rapport: RapportPerso;
  rev: string;
}

/** Habillage relu sur disque et revérifié (un fichier modifié à la main n'est jamais servi) ; `null` si absent ou refusé. */
function lire(uid: number, id: string): Lu | null {
  if (!ID_RE.test(id)) return null;
  let octets: Buffer;
  try {
    octets = readFileSync(pyJoin(pyJoin(dossierCompte(uid), id), "skin.json"));
    const ev = evaluerSkinPerso(pyJsonLoads(decoderUtf8(octets)));
    if (!ev.rapport.ok || ev.manifeste === null || ev.manifeste["id"] !== id) return null;
    return {
      manifeste: ev.manifeste,
      rapport: ev.rapport,
      rev: createHash("sha1").update(octets).digest("hex").slice(0, 12),
    };
  } catch {
    return null;
  }
}

function vue({ manifeste, rev }: Lu): SkinPerso {
  const m = manifeste as Dict;
  return {
    id: String(m["id"]),
    label: String(m["label"]),
    desc: String(m["description"] ?? ""),
    darkBase: m["darkBase"] === true,
    sw: (m["swatch"] as string[]) ?? [],
    rev,
  };
}

/** Identifiants des dossiers valides du compte, triés. */
function identifiants(uid: number): string[] {
  const racine = dossierCompte(uid);
  if (!estDossierPy(racine)) return [];
  try {
    return readdirSync(racine)
      .filter((n) => ID_RE.test(n) && estDossierPy(pyJoin(racine, n)))
      .sort();
  } catch (e) {
    if (estErreurOs(e)) return [];
    throw e;
  }
}

/** Habillages valides du compte, par nom. */
export function listerPerso(uid: number): SkinPerso[] {
  return identifiants(uid)
    .map((id) => lire(uid, id))
    .filter((l): l is Lu => l !== null)
    .map(vue)
    .sort((a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id));
}

/** Feuille régénérée depuis le fichier du compte, avec sa révision ; `null` si l'habillage n'existe pas pour ce compte. */
export function feuillePerso(uid: number, id: string): { css: string; rev: string } | null {
  const l = lire(uid, id);
  return l === null ? null : { css: l.rapport.css, rev: l.rev };
}

/** Écrit l'habillage (manifeste déjà vérifié) de façon atomique ; renvoie `true` s'il en remplace un, `null` si le plafond (habillages lisibles seuls) est atteint. */
export async function enregistrerPerso(
  uid: number,
  manifeste: Record<string, unknown>,
  ecraser: boolean,
): Promise<boolean | null> {
  const id = String(manifeste["id"]);
  const existe = existePy(pyJoin(dossierCompte(uid), id));
  if (!existe && listerPerso(uid).length >= persoMax()) return null;
  return ecrireNouveauDossier(manifeste as Dict, null, new Map(), new Map(), ecraser, dossierCompte(uid));
}

/** Supprime un habillage du compte, lisible ou non (dossier à l'id valide) ; `false` s'il n'existait pas. */
export async function supprimerPerso(uid: number, id: string): Promise<boolean> {
  const d = pyJoin(dossierCompte(uid), id);
  if (!ID_RE.test(id) || !existePy(d)) return false;
  await rmtree(d, true);
  return true;
}

/** Retire tout le dossier d'un compte supprimé. */
export async function purgerPersoCompte(uid: number): Promise<void> {
  await rmtree(dossierCompte(uid), true);
}

/** Skin effectif d'un compte : `perso:<id>` si l'habillage est à lui et la fonction active, sinon la résolution commune. */
export function resolveSkinCompte(uid: number, valeur: unknown): string {
  if (typeof valeur === "string" && valeur.startsWith(PREFIXE_PERSO)) {
    const id = valeur.slice(PREFIXE_PERSO.length);
    return persoActif() && lire(uid, id) !== null ? valeur : defaultSkin();
  }
  return resolveUserSkin(valeur);
}
