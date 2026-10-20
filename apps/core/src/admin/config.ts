// SPDX-License-Identifier: MIT
/** apps/core/src/admin/config.ts — propriété des sections de config.json et écritures champ par champ de la console (admin/config.py). */
import { egalPy, estDict, FlottantPy, poserCle, pyJsonDumps } from "@elpis/commun";
import type { Dict } from "@elpis/commun";
import { CHEMINS_SECRETS_CONFIG } from "@elpis/contracts";

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

/** Secrets de `config.json` jamais rendus à la console : remplacés par `MASQUE_SECRET`, restaurés à l'écriture (liste de @elpis/contracts, commune au front) ; le jeton de scrape Prometheus en est exclu, sa page le montre à l'administrateur. */
export const SECRETS_MASQUES: readonly (readonly string[])[] = CHEMINS_SECRETS_CONFIG.map((c) =>
  c.split("."),
);
export const MASQUE_SECRET = "********";

/** Repli d'un `config.json` illisible : toute valeur non vide d'une clé de secret est masquée au texte. */
export const CLES_SECRETES_TEXTE = new RegExp(
  `("(?:${[...new Set(SECRETS_MASQUES.map((c) => c.at(-1)))].join("|")})"\\s*:\\s*")(?:[^"\\\\]|\\\\.)+(")`,
  "gu",
);

/** Secrets rangés dans un objet (jetons clients du pont MCP) : l'objet entier, sans accolade imbriquée, est masqué au texte. */
const OBJETS_SECRETS_TEXTE = /("local_client_tokens"\s*:\s*)\{[^{}]*\}/gu;

/** Texte d'un `config.json` illisible avec les valeurs de secrets masquées, chaînes comme objets. */
export function masquerSecretsTexte(contenu: string): string {
  return contenu
    .replace(CLES_SECRETES_TEXTE, `$1${MASQUE_SECRET}$2`)
    .replace(OBJETS_SECRETS_TEXTE, `$1"${MASQUE_SECRET}"`);
}

/** Copie où chaque secret masqué non vide vaut `MASQUE_SECRET` (seul le chemin est copié : flottants et grands entiers intacts). */
export function masquerSecrets(cfg: Dict): [Dict, boolean] {
  let sortie = cfg;
  for (const chemin of SECRETS_MASQUES) {
    const [trouve, valeur] = dig(sortie, chemin);
    const garni =
      typeof valeur === "string" ? valeur !== "" : estDict(valeur) && Object.keys(valeur).length > 0;
    if (trouve && garni) sortie = avecValeur(sortie, chemin, MASQUE_SECRET);
  }
  return [sortie, sortie !== cfg];
}

function avecValeur(d: Dict, chemin: readonly string[], valeur: unknown): Dict {
  const [tete = "", ...reste] = chemin;
  const copie: Dict = { ...d };
  poserCle(copie, tete, reste.length ? avecValeur(copie[tete] as Dict, reste, valeur) : valeur);
  return copie;
}

/** Chemin d'un secret masqué ? */
export function estSecretMasque(parties: readonly string[]): boolean {
  return SECRETS_MASQUES.some((c) => c.length === parties.length && c.every((p, i) => p === parties[i]));
}

/** Secret revenu masqué de la console : la valeur du disque est gardée (supprimé si le disque n'en a pas). */
export function restaurerSecretsMasques(entrant: Dict, disque: Dict): void {
  for (const chemin of SECRETS_MASQUES) {
    const [trouve, valeur] = dig(entrant, chemin);
    if (!trouve || valeur !== MASQUE_SECRET) continue;
    const [surDisque, ancienne] = dig(disque, chemin);
    if (surDisque) plant(entrant, chemin, ancienne);
    else removePath(entrant, chemin);
  }
}
