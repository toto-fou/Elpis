// SPDX-License-Identifier: MIT
/** apps/core/src/images/config.ts — bloc `image` de config.json relu à chaque appel (défauts, bornes), clé API scellée avec l'origine du moteur. */
import {
  arrondiEntierPy,
  ErreurPython,
  floatPy,
  hostname,
  port,
  pyJsonDumps,
  pyJsonLoads,
  stripPy,
  strPy,
  urlsplit,
  veritePy,
} from "@elpis/commun";
import { configView, mettreAJourConfigJson } from "@elpis/config";
import { decrypt } from "@elpis/securite";

import { SkinError } from "../apparence/skins";
import { entierPy, estDict, lire, longueurPy, lowerPy, poser } from "../python";
import type { Dict } from "../python";

export const PROVIDERS = ["sdcpp", "openai"] as const;
export const EDIT_MODES = ["init", "ref"] as const;
export const SIZE_POLICIES = ["free", "fixed"] as const;

export const IMAGE_DEFAULTS = {
  enabled: false,
  provider: "sdcpp",
  url: "",
  model: "",
  api_key_enc: "",
  verify: true,
  ca_pem: "",
  timeout_sec: 180,
  max_concurrent: 1,
  max_n: 4,
  max_side: 2048,
  default_side: 1024,
  size_policy: "free",
  sizes: [] as string[],
  edit_mode: "init",
  keep_per_user: 50,
  groups: [] as number[],
  tool_max_calls: 4,
  enhance_enabled: true,
} as const;

const BORNES: Readonly<Record<string, readonly [number, number]>> = {
  timeout_sec: [10, 1800],
  max_concurrent: [1, 8],
  max_n: [1, 8],
  max_side: [256, 4096],
  default_side: [256, 4096],
  keep_per_user: [1, 1000],
  tool_max_calls: [1, 20],
};

/** `\d` de `re` est Unicode : chaque chiffre est ensuite relu par `int()` (Unicode 15.1, comme Python 3.13). */
const SIZE_RE = /^(\p{Nd}{2,4})x(\p{Nd}{2,4})$/u;
export const SIZE_MIN = 64;
export const SIZE_MAX = 4096;
export const SIZE_STEP = 64;
export const RATIOS = ["1:1", "4:3", "3:4", "3:2", "2:3", "16:9", "9:16", "21:9", "9:21"] as const;
const ALIAS: Readonly<Record<string, string>> = { square: "1:1", portrait: "2:3", landscape: "3:2" };
export const SIDES = [512, 768, 1024, 1280, 1536, 2048] as const;
const FIXED_SIZES_DEFAUT = ["1024x1024", "1536x1024", "1024x1536"];
/** `^dall-e-3` sous `re.I`. */
const DALLE3 = /^dall-e-3/iu;
const CA_MAX = 64 * 1024;

/** Configuration coercée ; `api_key_enc` reste chiffrée (seul `apiKey` la déchiffre). */
export type ConfigImage = {
  enabled: boolean;
  provider: string;
  url: string;
  model: string;
  api_key_enc: string;
  verify: boolean;
  ca_pem: string;
  timeout_sec: number;
  max_concurrent: number;
  max_n: number;
  max_side: number;
  default_side: number;
  size_policy: string;
  sizes: string[];
  edit_mode: string;
  keep_per_user: number;
  groups: number[];
  tool_max_calls: number;
  enhance_enabled: boolean;
};

/** `str(x or "")`. */
const chaine = (x: unknown): string => strPy(veritePy(x) ? x : "");

function texte(valeur: unknown, defaut: string): string {
  if (valeur === null || valeur === undefined) return defaut;
  return stripPy(strPy(valeur)) || defaut;
}

function booleen(valeur: unknown, defaut: boolean): boolean {
  if (valeur === null || valeur === undefined) return defaut;
  if (typeof valeur === "boolean") return valeur;
  const t = lowerPy(stripPy(strPy(valeur)));
  if (!t) return defaut;
  return !["false", "0", "non", "no", "off"].includes(t);
}

/** `float()` puis `int()` (non fini : défaut), borné ; une valeur que `float()` refuse donne le défaut. */
function entier(cle: string, valeur: unknown, defaut: number): number {
  const [bas, haut] = BORNES[cle] ?? [Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY];
  let v: number;
  try {
    const f = floatPy(valeur);
    v = Number.isFinite(f) ? Math.trunc(f) : Math.trunc(defaut);
  } catch {
    v = Math.trunc(defaut);
  }
  return Math.max(bas, Math.min(haut, v));
}

/** `"1024x768"` → `[1024, 768]` ; `null` si la forme est invalide. */
export function parseSize(size: unknown): [number, number] | null {
  const m = SIZE_RE.exec(lowerPy(stripPy(chaine(size))));
  if (!m) return null;
  let w: number;
  let h: number;
  try {
    [w, h] = [entierPy(m[1] ?? ""), entierPy(m[2] ?? "")];
  } catch {
    return null;
  }
  if (!(SIZE_MIN <= w && w <= SIZE_MAX && SIZE_MIN <= h && h <= SIZE_MAX)) return null;
  return [w, h];
}

export function roundStep(v: number): number {
  return Math.max(SIZE_STEP, arrondiEntierPy(v / SIZE_STEP) * SIZE_STEP);
}

/** `a, b = (float(x) for x in r.split(":", 1))` ; deux membres positifs, sinon `(1, 1)`. */
function membresRatio(r: string): [number, number] {
  const deux = r.indexOf(":");
  if (deux < 0) return [1.0, 1.0];
  try {
    const [a, b] = [floatPy(r.slice(0, deux)), floatPy(r.slice(deux + 1))];
    return a <= 0 || b <= 0 ? [1.0, 1.0] : [a, b];
  } catch {
    return [1.0, 1.0];
  }
}

/** `("16:9", 1024)` → `[1024, 576]` ; ratio inconnu → carré. */
export function sizeForRatio(ratio: unknown, longSide: number): [number, number] {
  const brut = stripPy(chaine(ratio));
  const r = Object.hasOwn(ALIAS, lowerPy(brut)) ? (ALIAS[lowerPy(brut)] ?? brut) : brut;
  const [a, b] = membresRatio(r);
  if (a >= b) return [roundStep(longSide), roundStep((longSide * b) / a)];
  return [roundStep((longSide * a) / b), roundStep(longSide)];
}

function groupes(valeur: unknown): number[] {
  if (!Array.isArray(valeur)) return [];
  const out: number[] = [];
  for (const v of valeur.slice(0, 200)) {
    let g: number;
    try {
      g = entierPy(v);
    } catch (e) {
      if (e instanceof ErreurPython && e.type === "OverflowError") throw e;
      continue;
    }
    if (g > 0 && !out.includes(g)) out.push(g);
  }
  return out;
}

function tailles(valeur: unknown): string[] {
  if (!Array.isArray(valeur)) return [];
  const out: string[] = [];
  for (const v of valeur.slice(0, 20)) {
    const wh = parseSize(v);
    if (wh && !out.includes(`${wh[0]}x${wh[1]}`)) out.push(`${wh[0]}x${wh[1]}`);
  }
  return out;
}

/** `get_image_config()` : défauts et bornes appliqués à la lecture ; `enabled` strict ; sd-server : tailles libres, un créneau. */
export function getImageConfig(vue: unknown = configView()): ConfigImage {
  const section = estDict(vue) ? lire(vue, "image") : undefined;
  const brut: Dict = estDict(section) ? section : {};
  const d = IMAGE_DEFAULTS;
  let provider = lowerPy(texte(brut["provider"], d.provider));
  if (!(PROVIDERS as readonly string[]).includes(provider)) provider = d.provider;
  let editMode = lowerPy(texte(brut["edit_mode"], d.edit_mode));
  if (!(EDIT_MODES as readonly string[]).includes(editMode)) editMode = d.edit_mode;
  let policy = lowerPy(texte(brut["size_policy"], d.size_policy));
  if (!(SIZE_POLICIES as readonly string[]).includes(policy)) policy = d.size_policy;
  if (provider === "sdcpp") policy = "free";
  const maxSide = entier("max_side", brut["max_side"], d.max_side);
  const ca = stripPy(chaine(brut["ca_pem"]));
  const fixes = tailles(brut["sizes"]);
  return {
    enabled: brut["enabled"] === true,
    provider,
    url: texte(brut["url"], "").replace(/\/+$/, ""),
    model: texte(brut["model"], ""),
    api_key_enc: stripPy(chaine(brut["api_key_enc"])),
    verify: booleen(brut["verify"], d.verify),
    ca_pem: longueurPy(ca) <= CA_MAX ? ca : "",
    timeout_sec: entier("timeout_sec", brut["timeout_sec"], d.timeout_sec),
    max_concurrent:
      provider === "openai" ? entier("max_concurrent", brut["max_concurrent"], d.max_concurrent) : 1,
    max_n: entier("max_n", brut["max_n"], d.max_n),
    max_side: maxSide,
    default_side: Math.min(maxSide, entier("default_side", brut["default_side"], d.default_side)),
    size_policy: policy,
    sizes: fixes.length > 0 ? fixes : policy === "fixed" ? [...FIXED_SIZES_DEFAUT] : [],
    edit_mode: editMode,
    keep_per_user: entier("keep_per_user", brut["keep_per_user"], d.keep_per_user),
    groups: groupes(brut["groups"]),
    tool_max_calls: entier("tool_max_calls", brut["tool_max_calls"], d.tool_max_calls),
    enhance_enabled: booleen(brut["enhance_enabled"], d.enhance_enabled),
  };
}

/** `schéma://hôte:port` (port par défaut explicite, minuscules) ; `""` si ce n'est pas une adresse http(s). */
export function engineOrigin(url: unknown): string {
  let scheme: string;
  let host: string;
  let p: number | null;
  try {
    const parts = urlsplit(stripPy(chaine(url)));
    scheme = parts.scheme.toLowerCase();
    host = (hostname(parts) ?? "").toLowerCase();
    p = port(parts) || ({ http: 80, https: 443 } as Readonly<Record<string, number>>)[scheme] || null;
  } catch {
    return "";
  }
  if ((scheme !== "http" && scheme !== "https") || !host || !p) return "";
  return `${scheme}://${host}:${p}`;
}

/** Contenu à chiffrer : la clé et l'origine du moteur auquel elle est destinée. */
export function sealApiKey(key: string, url: string): string {
  return pyJsonDumps({ k: key, o: engineOrigin(url) }, { ensureAscii: false });
}

function scellee(cfg: Readonly<Dict>): { k: string; o: string } | null {
  const enc = chaine(cfg["api_key_enc"]);
  if (!enc) return null;
  let data: unknown;
  try {
    data = pyJsonLoads(decrypt(enc) || "null");
  } catch {
    return null;
  }
  if (!estDict(data) || typeof data["k"] !== "string" || typeof data["o"] !== "string") return null;
  return { k: data["k"], o: data["o"] };
}

/** Clé API en clair (côté hôte seulement) pour l'adresse de `cfg` ; `""` si absente, illisible ou scellée pour une autre origine. */
export function apiKey(cfg: Readonly<Dict>): string {
  const s = scellee(cfg);
  if (!s || !s.o || s.o !== engineOrigin(cfg["url"])) return "";
  return s.k;
}

export function keyState(cfg: Readonly<Dict>): { has_key: boolean; stale: boolean } {
  const usable = Boolean(apiKey(cfg));
  return { has_key: usable, stale: Boolean(cfg["api_key_enc"]) && !usable };
}

/** Moteur activé ET adresse renseignée ; sans configuration donnée, celle du disque. */
export function imageReady(cfg?: Readonly<Dict> | ConfigImage | null): boolean {
  const c = (veritePy(cfg) ? cfg : getImageConfig()) as Readonly<Dict>;
  return veritePy(c["enabled"]) && veritePy(c["url"]);
}

/** Ce que le moteur configuré comprend : l'interface n'offre que ça. */
export function features(cfg: Readonly<Dict> | ConfigImage): {
  seed: boolean;
  negative: boolean;
  steps: boolean;
  strength: boolean;
  edit: boolean;
} {
  const c = cfg as Readonly<Dict>;
  const sd = c["provider"] === "sdcpp";
  return { seed: sd, negative: sd, steps: sd, strength: sd && c["edit_mode"] === "init", edit: true };
}

/** Images par demande : borne de l'administrateur, 1 pour dall-e-3. */
export function effectiveMaxN(cfg: Readonly<Dict> | ConfigImage): number {
  const c = cfg as Readonly<Dict>;
  const modele = veritePy(c["model"]) ? c["model"] : "";
  if (c["provider"] === "openai") {
    if (typeof modele !== "string")
      throw new ErreurPython("TypeError", "expected string or bytes-like object");
    if (DALLE3.test(modele)) return 1;
  }
  return entierPy(veritePy(c["max_n"]) ? c["max_n"] : 1);
}

export function sidesFor(cfg: ConfigImage): number[] {
  const cotes = SIDES.filter((s) => s <= cfg.max_side);
  return cotes.length > 0 ? cotes : [cfg.max_side];
}

/** Ce que le navigateur a le droit de savoir : ni adresse, ni clé. */
export function publicStatus(cfg: ConfigImage): Dict {
  return {
    provider: cfg.provider,
    model: cfg.model,
    ratios: [...RATIOS],
    sides: sidesFor(cfg),
    default_side: cfg.default_side,
    max_side: cfg.max_side,
    step: SIZE_STEP,
    max_n: effectiveMaxN(cfg),
    size_policy: cfg.size_policy,
    sizes: cfg.size_policy === "fixed" ? [...cfg.sizes] : [],
    features: features(cfg),
    enhance_enabled: cfg.enhance_enabled,
    keep_per_user: cfg.keep_per_user,
  };
}

/** Écrit `image.api_key_enc` sous le verrou de config.json, relu sur disque ; un fichier illisible est refusé, jamais écrasé (Python : remplacé par `{}`). */
export async function writeApiKey(enc: string): Promise<void> {
  await mettreAJourConfigJson(
    (cfg) => {
      let section = lire(cfg, "image");
      if (!estDict(section)) {
        section = {};
        poser(cfg, "image", section);
      }
      poser(section as Dict, "api_key_enc", enc);
    },
    (message) => new SkinError(message),
  );
}
