// SPDX-License-Identifier: MIT
/** apps/core/src/admin/config.ts — propriété des sections de config.json et écritures champ par champ de la console (admin/config.py). */
import { egalPy, estDict, FlottantPy, poserCle, pyJsonDumps } from "@elpis/commun";
import type { Dict } from "@elpis/commun";

/** `_OWNED_PATHS` : un seul endpoint en est l'auteur, la valeur du disque gagne toujours. */
export const OWNED_PATHS: readonly (readonly string[])[] = [
  ["security", "https"],
  ["security", "session", "https_only"],
  ["security", "listen"],
  ["security", "session", "global_min_ts"],
  ["database"],
  ["image", "api_key_enc"],
  // Propre au TS : réglages des sous-agents, écrits et validés par `/api/admin/agents` seulement.
  ["agents"],
];

/** `_PRESERVE_IF_ABSENT` : restaurées seulement si le formulaire ne les porte pas (ou les porte vides). */
export const PRESERVE_IF_ABSENT: readonly (readonly string[])[] = [
  ["llm", "compression"],
  ["llm", "scheduling_mode"],
  ["llm", "allowed_provider_types"],
  ["executors"],
  ["backup"],
  ["skins"],
];

export const PATCH_PATH_RE = /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+){0,7}$/u;
export const PATCH_MAX_CHANGES = 200;

/** `_dig` : `[trouvé, valeur]` au chemin pointé. */
export function dig(noeud: unknown, chemin: readonly string[]): [boolean, unknown] {
  let cur = noeud;
  for (const cle of chemin) {
    if (!estDict(cur) || !Object.hasOwn(cur, cle)) return [false, null];
    cur = cur[cle];
  }
  return [true, cur];
}

/** `_plant` : valeur posée au chemin, dicts manquants (ou d'un autre type) remplacés. */
export function plant(noeud: Dict, chemin: readonly string[], valeur: unknown): void {
  let cur = noeud;
  for (const cle of chemin.slice(0, -1)) {
    let suivant = Object.hasOwn(cur, cle) ? cur[cle] : undefined;
    if (!estDict(suivant)) {
      suivant = {};
      poserCle(cur, cle, suivant);
    }
    cur = suivant as Dict;
  }
  poserCle(cur, chemin[chemin.length - 1] as string, valeur);
}

/** `_remove_path` : clé retirée si son parent existe. */
export function removePath(noeud: Dict, chemin: readonly string[]): void {
  let cur: unknown = noeud;
  for (const cle of chemin.slice(0, -1)) {
    cur = estDict(cur) ? (Object.hasOwn(cur, cle) ? cur[cle] : null) : null;
    if (!estDict(cur)) return;
  }
  delete (cur as Dict)[chemin[chemin.length - 1] as string];
}

type Nombre = { entier: bigint } | { flottant: number };

function nombre(v: unknown): Nombre | null {
  if (typeof v === "boolean") return { entier: v ? 1n : 0n };
  if (typeof v === "bigint") return { entier: v };
  if (v instanceof FlottantPy) return { flottant: v.valeur };
  if (typeof v === "number") return Number.isInteger(v) ? { entier: BigInt(v) } : { flottant: v };
  return null;
}

/** `v in (None, {}, [], "")`. */
function vide(v: unknown): boolean {
  return (
    v === null ||
    v === "" ||
    (Array.isArray(v) && v.length === 0) ||
    (estDict(v) && Object.keys(v).length === 0)
  );
}

/** `_apply_section_ownership` : sections dont le formulaire n'est pas l'auteur réinjectées depuis le disque ; rend les chemins restaurés. */
export function applySectionOwnership(entrant: Dict, disque: Dict): string[] {
  const restaures: string[] = [];
  for (const chemin of OWNED_PATHS) {
    const [surDisque, valeurDisque] = dig(disque, chemin);
    if (!surDisque) continue;
    const [present, valeur] = dig(entrant, chemin);
    if (present && egalPy(valeur, valeurDisque)) continue;
    plant(entrant, chemin, valeurDisque);
    restaures.push(chemin.join("."));
  }
  for (const chemin of PRESERVE_IF_ABSENT) {
    const [surDisque, valeurDisque] = dig(disque, chemin);
    if (!surDisque || vide(valeurDisque)) continue;
    const [present, valeur] = dig(entrant, chemin);
    if (present && !vide(valeur)) continue;
    plant(entrant, chemin, valeurDisque);
    restaures.push(chemin.join("."));
  }
  return restaures;
}

/** `_touches_owned` : le chemin est une zone possédée, est dedans, ou la contient. */
export function touchesOwned(parties: readonly string[]): boolean {
  return OWNED_PATHS.some((possede) => {
    const n = Math.min(possede.length, parties.length);
    return possede.slice(0, n).every((p, i) => p === parties[i]);
  });
}

/** `_same_value` : 1 et 1.0 égaux, True et 1 non ; le reste comparé en JSON trié. */
export function sameValue(a: unknown, b: unknown): boolean {
  if (typeof a === "boolean" || typeof b === "boolean") return a === b;
  const na = nombre(a);
  const nb = nombre(b);
  if (na !== null && nb !== null) {
    const f = (n: Nombre): number => ("entier" in n ? Number(n.entier) : n.flottant);
    return f(na) === f(nb);
  }
  const texte = (v: unknown): string => pyJsonDumps(v, { sortKeys: true, ensureAscii: false });
  return texte(a) === texte(b);
}
