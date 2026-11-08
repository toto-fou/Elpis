// SPDX-License-Identifier: MIT
/** apps/core/src/journal-securite/diff-config.ts — différence feuille par feuille de deux config.json pour le journal de sécurité, secrets masqués à toute profondeur (clés, `env`, `headers`, lignes de commande, URL) et valeurs longues résumées. */
import { createHash } from "node:crypto";

import { estDict, pyJsonDumps } from "@elpis/commun";
import type { Dict } from "@elpis/commun";
import { masquerArgv, masquerCommandeShell } from "@elpis/securite";

import { estSecretMasque, MASQUE_SECRET, SECRETS_MASQUES, sameValue } from "../admin/config";

export const DIFF_MAX = 50;
/** Budget des changements sérialisés (octets UTF-8) : la ligne du journal reste sous 4096 octets avec son enveloppe. */
export const DIFF_OCTETS_MAX = 3000;
const LONGUEUR_MAX = 200;
const CLES_SECRETES = new Set(SECRETS_MASQUES.map((c) => c.at(-1) ?? ""));
const NOMS_SECRETS =
  "password|passwd|pwd|mot_?de_?passe|secret|token|api[_-]?key|key_enc|private[_-]?key|passphrase|credential|authorization|bindpw";
const MOTIF_SECRET = new RegExp(`${NOMS_SECRETS}|_pw$`, "iu");
/** Nom qui finit par le nom d'un secret (`bind_password`, `api_token`, `bindDN_pw`) : toute valeur masquée ; pas `buffer_tokens` ni `token_on`. */
const FIN_SECRETE = new RegExp(`(?:${NOMS_SECRETS}|credentials|_pw)$`, "iu");
/** Règles sur un secret, pas un secret (`security.password_policy`) : parcourues et lisibles. */
const REGLES = /_polic(?:y|ies)$/iu;
/** Objets dont chaque valeur est masquée, clés lisibles (variables d'environnement, en-têtes HTTP). */
const CONTENEURS_SECRETS = new Set(["env", "environment", "headers"]);
/** Listes ou textes lus comme une ligne de commande (`--token X`, `--password=X`). */
const COMMANDES = new Set(["args", "argv", "command", "cmd"]);
/** Paramètre d'URL (`?token=…`, `&api_key=…`, `#access_token=…`), et noms courts de secrets propres aux URL. */
const PARAMETRE_URL = /([?&#;])([^=&#?;\s]+)=([^&#;\s]*)/gu;
const PARAMETRE_SECRET = /^(?:key|sig|signature)$/iu;

/** Masquage : 2 = toute valeur non vide, 1 = textes, listes et objets non vides, 0 = aucun. */
type Niveau = 0 | 1 | 2;

export interface ChangementConfig {
  path: string;
  before: unknown;
  after: unknown;
}

export interface DiffConfig {
  changes: ChangementConfig[];
  more?: number;
}

const json = (v: unknown): string => pyJsonDumps(v, { ensureAscii: false, sortKeys: true });
const octets = (v: unknown): number =>
  Buffer.byteLength(pyJsonDumps(v, { ensureAscii: false, sortKeys: true, separators: [",", ":"] }), "utf8");

/** Clé dont la valeur est un secret : dernière clé d'un secret connu, ou nom qui ressemble à un secret. */
const cleSecrete = (cle: string): boolean => CLES_SECRETES.has(cle) || MOTIF_SECRET.test(cle);
const conteneurSecrets = (cle: string | undefined): boolean =>
  cle !== undefined && CONTENEURS_SECRETS.has(cle.toLowerCase());

/** Niveau de masquage d'une clé : 2 pour un secret connu, un nom qui finit par un secret ou une valeur sous `env`/`headers` ; 1 pour un nom qui contient un secret. */
function niveauCle(cle: string, parties: readonly string[], sousConteneur: boolean): Niveau {
  if (sousConteneur || estSecretMasque(parties) || CLES_SECRETES.has(cle) || FIN_SECRETE.test(cle)) return 2;
  return MOTIF_SECRET.test(cle) && !REGLES.test(cle) ? 1 : 0;
}

/** Valeur d'un secret : vide et null montrés ; texte, liste ou objet masqués en bloc ; nombre et booléen masqués au niveau 2 seulement. */
function masquer(v: unknown, niveau: Niveau): unknown {
  if (v === null || v === undefined || v === "") return v;
  if (Array.isArray(v)) return v.length ? MASQUE_SECRET : v;
  if (estDict(v)) return Object.keys(v).length ? MASQUE_SECRET : v;
  return typeof v === "string" || niveau === 2 ? MASQUE_SECRET : v;
}

/** Texte sans identifiants d'URL : userinfo remplacé par `***` si l'URL se lit, texte entier masqué sinon. */
function sansIdentifiants(s: string): string {
  if (!/:\/\/.*@/su.test(s)) return s;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return MASQUE_SECRET;
  }
  const identifiants = u.username !== "" || u.password !== "";
  u.username = "";
  u.password = "";
  if (/:\/\/[^/?#]*@/u.test(u.href)) return MASQUE_SECRET;
  return identifiants ? u.href.replace("://", "://***@") : s;
}

/** Nom de paramètre décodé (`api%5Fkey`), tel quel s'il ne se décode pas. */
function nomDecode(nom: string): string {
  try {
    return decodeURIComponent(nom.replace(/\+/gu, " "));
  } catch {
    return nom;
  }
}

/** Texte présentable : identifiants d'URL retirés, valeur des paramètres d'URL au nom de secret remplacée par `***`. */
function textePresentable(s: string): string {
  return sansIdentifiants(s).replace(PARAMETRE_URL, (tout, sep: string, nom: string, valeur: string) => {
    const n = nomDecode(nom);
    return valeur && (cleSecrete(n) || PARAMETRE_SECRET.test(n)) ? `${sep}${nom}=***` : tout;
  });
}

/** Copie présentable : à toute profondeur, secrets masqués selon leur clé, valeurs de `env`/`headers` masquées, lignes de commande et URL nettoyées. */
function nettoyer(v: unknown, parties: readonly string[], sousConteneur = false): unknown {
  if (estDict(v))
    return Object.fromEntries(
      Object.entries(v).map(([k, x]) => {
        const p = [...parties, k];
        const n = niveauCle(k, p, sousConteneur);
        return [k, n ? masquer(x, n) : nettoyer(x, p, conteneurSecrets(k))];
      }),
    );
  if (sousConteneur) return masquer(v, 2);
  const commande = COMMANDES.has(parties.at(-1) ?? "");
  if (typeof v === "string") return textePresentable(commande ? masquerCommandeShell(v) : v);
  if (!Array.isArray(v)) return v;
  if (commande && v.every((x) => typeof x === "string")) return masquerArgv(v).map(textePresentable);
  return v.map((x) => nettoyer(x, parties));
}

/** Valeur présentable : secret masqué selon son niveau, sinon nettoyée ; longue, réduite à sa longueur et son empreinte ; absence vue comme null. */
function presenter(v: unknown, niveau: Niveau, parties: readonly string[]): unknown {
  if (v === undefined) return null;
  const propre = niveau ? masquer(v, niveau) : nettoyer(v, parties, conteneurSecrets(parties.at(-1)));
  const texte = json(propre);
  if (texte.length <= LONGUEUR_MAX) return propre;
  return { len: texte.length, sha256: createHash("sha256").update(texte, "utf8").digest("hex").slice(0, 12) };
}

/** Chemin pointé coupé au premier secret connu (les clés des jetons clients du pont MCP sont des jetons) ou à la première clé de secret suivie d'une sous-clé, borné à `LONGUEUR_MAX` caractères. */
export function cheminLisible(parties: readonly string[]): string {
  const n = parties.findIndex(
    (c, i) =>
      estSecretMasque(parties.slice(0, i + 1)) ||
      (i < parties.length - 1 && niveauCle(c, parties.slice(0, i + 1), conteneurSecrets(parties[i - 1])) > 0),
  );
  const p = (n < 0 ? parties : parties.slice(0, n + 1)).join(".");
  return p.length <= LONGUEUR_MAX ? p : `${p.slice(0, LONGUEUR_MAX)}…`;
}

/** Au plus `DIFF_MAX` changements et `DIFF_OCTETS_MAX` octets, dans l'ordre ; le reste compté dans `more`. */
function plafonner(tous: readonly ChangementConfig[]): DiffConfig {
  const changes: ChangementConfig[] = [];
  let total = 0;
  for (const c of tous) {
    const n = octets(c) + 1;
    if (changes.length >= DIFF_MAX || total + n > DIFF_OCTETS_MAX) break;
    changes.push(c);
    total += n;
  }
  const more = tous.length - changes.length;
  return more ? { changes, more } : { changes };
}

/** Parcours des dicts ; un secret (connu, ou nom de secret dont la valeur est un objet) est comparé en bloc, ses clés jamais écrites ; sous `env`/`headers`, chaque valeur masquée. */
function parcourir(
  avant: unknown,
  apres: unknown,
  parties: string[],
  sousConteneur: boolean,
  sortie: ChangementConfig[],
): void {
  const cle = parties.at(-1);
  const niveau = cle === undefined ? 0 : niveauCle(cle, parties, sousConteneur);
  const dA = estDict(avant);
  const dB = estDict(apres);
  const dictContreAbsent = (dA && apres === undefined) || (dB && avant === undefined);
  const plein = (dA && Object.keys(avant).length > 0) || (dB && Object.keys(apres).length > 0);
  if (!niveau && ((dA && dB) || (dictContreAbsent && plein))) {
    const a = dA ? avant : {};
    const b = dB ? apres : {};
    for (const k of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort())
      parcourir(a[k], b[k], [...parties, k], conteneurSecrets(cle), sortie);
    return;
  }
  if (avant === undefined && apres === undefined) return;
  if (avant !== undefined && apres !== undefined && sameValue(avant, apres)) return;
  sortie.push({
    path: cheminLisible(parties),
    before: presenter(avant, niveau, parties),
    after: presenter(apres, niveau, parties),
  });
}

/** Changements entre deux configs (dicts parcourus, listes et scalaires comparés en bloc, présentés masqués) : bornés en nombre et en octets, le reste compté dans `more`. */
export function diffConfig(avant: Dict, apres: Dict): DiffConfig {
  const tous: ChangementConfig[] = [];
  parcourir(avant, apres, [], false, tous);
  return plafonner(tous);
}
