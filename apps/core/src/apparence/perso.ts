// SPDX-License-Identifier: MIT
/** apps/core/src/apparence/perso.ts — habillage personnel : jetons seuls, grammaire stricte des valeurs, dérivations, contraste bloquant et feuille générée côté serveur. */
import { estDict } from "@elpis/commun";
import {
  analyse,
  luminance,
  melanger,
  PAIRES_TEXTE,
  rapport,
  SEUIL_INTERFACE,
  SEUIL_TEXTE,
  sur,
  versCss,
} from "@elpis/commun/couleurs";
import type { Rgba } from "@elpis/commun/couleurs";

import {
  blocJetons,
  checkTokenValue,
  ID_RE,
  MAX_DESC_SKIN,
  MAX_LABEL_SKIN,
  SkinError,
  TOKEN_RE,
  validateManifest,
} from "./skins";

export const CLASSE_PERSO = "elpis-skin-perso";
export const MAX_PERSO_OCTETS = 16 * 1024;

/** Jetons qu'un habillage personnel peut poser, tous pris dans `frontend/css/style.css`. */
export const JETONS_PERSO: readonly string[] = [
  "--app-bg",
  "--surface",
  "--surface-2",
  "--surface-3",
  "--surface-4",
  "--surface-5",
  "--border",
  "--border-soft",
  "--text-900",
  "--text-800",
  "--text-700",
  "--text-600",
  "--text-500",
  "--text-400",
  "--accent",
  "--accent-strong",
  "--accent-fg",
  "--accent-text",
  "--accent-text-strong",
  "--accent-surface",
  "--accent-surface-2",
  "--accent-border",
  "--accent-ring",
  "--prose-link",
  "--rail-bg",
  "--rail-bg-2",
  "--rail-border",
  "--rail-text",
  "--rail-text-strong",
  "--rail-muted",
  "--rail-hover",
  "--rail-active-bg",
  "--code-bg",
  "--code-fg",
  "--radius",
];

/** Le cœur exigé en clair et en sombre (un seul jeu avec `darkBase`) ; tout le reste se dérive. */
export const JETONS_REQUIS: readonly string[] = [
  "--app-bg",
  "--surface",
  "--text-900",
  "--text-600",
  "--border",
  "--accent",
  "--rail-bg",
  "--rail-text",
];

/** Jetons communs aux deux modes : repris du jeu clair quand le jeu sombre ne les pose pas. */
const COMMUNS: readonly string[] = ["--radius", "--code-bg", "--code-fg"];

/** Les seuls jetons dont une transparence est admise (traits, teintes) ; fonds et textes restent opaques. */
const ALPHA_ADMIS: ReadonlySet<string> = new Set([
  "--border",
  "--border-soft",
  "--accent-surface",
  "--accent-surface-2",
  "--accent-border",
  "--accent-ring",
  "--rail-border",
  "--rail-hover",
  "--rail-active-bg",
]);

const CLES_HAUT: ReadonlySet<string> = new Set([
  "id",
  "label",
  "desc",
  "description",
  "darkBase",
  "tokens",
  "swatch",
  "sw",
]);
const CLES_REFUSEES: ReadonlySet<string> = new Set([
  "css",
  "assets",
  "brand",
  "mascot",
  "version",
  "author",
  "license",
]);

const CANAL = String.raw`(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.\d+)?|(?:100|\d{1,2})(?:\.\d+)?%)`;
const POURCENT = String.raw`(?:100|\d{1,2})(?:\.\d+)?%`;
const TEINTE = String.raw`\d{1,3}(?:\.\d+)?(?:deg)?`;
const ALPHA = String.raw`(?:0?\.\d+|0|1(?:\.0+)?|${POURCENT})`;
const GRAMMAIRE_COULEUR: readonly RegExp[] = [
  /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i,
  new RegExp(String.raw`^rgba?\(\s*${CANAL}\s*,\s*${CANAL}\s*,\s*${CANAL}(?:\s*,\s*${ALPHA})?\s*\)$`, "i"),
  new RegExp(String.raw`^rgba?\(\s*${CANAL}\s+${CANAL}\s+${CANAL}(?:\s*/\s*${ALPHA})?\s*\)$`, "i"),
  new RegExp(
    String.raw`^hsla?\(\s*${TEINTE}\s*,\s*${POURCENT}\s*,\s*${POURCENT}(?:\s*,\s*${ALPHA})?\s*\)$`,
    "i",
  ),
  new RegExp(String.raw`^hsla?\(\s*${TEINTE}\s+${POURCENT}\s+${POURCENT}(?:\s*/\s*${ALPHA})?\s*\)$`, "i"),
];
const LONGUEUR = /^(\d{1,2}(?:\.\d+)?)(px|rem)$/;

export type ModePerso = "light" | "dark";

export interface ContrastePerso {
  paire: string;
  mode: ModePerso;
  ratio: number;
  seuil: number;
  ok: boolean;
}

export interface RapportPerso {
  ok: boolean;
  erreurs: string[];
  avertissements: string[];
  contrastes: ContrastePerso[];
  css: string;
}

export interface EvaluationPerso {
  rapport: RapportPerso;
  /** Manifeste normalisé, au format de `skin.json` importé, prêt à écrire ; `null` s'il reste une erreur de structure. */
  manifeste: Record<string, unknown> | null;
}

type Jetons = Record<string, string>;

/** Valeur de couleur admise : hex ou rgb/hsl à arguments numériques, rien d'autre. */
export function couleurAdmise(valeur: string): boolean {
  return GRAMMAIRE_COULEUR.some((re) => re.test(valeur));
}

/** Rayon admis : `0`, ou 0 à 32 px (ou l'équivalent en rem). */
export function rayonAdmis(valeur: string): boolean {
  if (valeur === "0") return true;
  const m = LONGUEUR.exec(valeur);
  if (m === null) return false;
  const n = Number(m[1]);
  return m[2] === "px" ? n <= 32 : n <= 2;
}

/** Jetons d'un mode contrôlés un à un (liste blanche, valeur, alpha) ; les refus s'ajoutent à `erreurs`. */
function jetonsDuMode(brut: unknown, ou: string, erreurs: string[]): Jetons {
  const sortie: Jetons = {};
  if (brut === undefined || brut === null) return sortie;
  if (!estDict(brut)) {
    erreurs.push(`${ou} : objet {"--jeton": "valeur"} attendu.`);
    return sortie;
  }
  for (const [cle, v] of Object.entries(brut)) {
    if (!TOKEN_RE.test(cle) || !JETONS_PERSO.includes(cle)) {
      erreurs.push(`${ou} : jeton « ${cle.slice(0, 24)} » hors de la liste admise.`);
      continue;
    }
    try {
      const val = checkTokenValue(v, `${ou} ${cle}`).toLowerCase();
      if (cle === "--radius") {
        if (!rayonAdmis(val)) erreurs.push(`${ou} ${cle} : longueur de 0 à 32px (ou 2rem) attendue.`);
      } else if (!couleurAdmise(val) || analyse(val) === null) {
        erreurs.push(`${ou} ${cle} : couleur #hex, rgb() ou hsl() à valeurs numériques attendue.`);
      } else if (!ALPHA_ADMIS.has(cle) && (analyse(val)?.[3] ?? 1) < 1) {
        erreurs.push(`${ou} ${cle} : transparence interdite sur un fond ou un texte.`);
      } else sortie[cle] = val;
      if (cle === "--radius" && rayonAdmis(val)) sortie[cle] = val;
    } catch (e) {
      if (!(e instanceof SkinError)) throw e;
      erreurs.push(e.message);
    }
  }
  return sortie;
}

const rgba = (c: string): Rgba => analyse(c) ?? [0, 0, 0, 1];
const BLANC: Rgba = [255, 255, 255, 1];
const NOIR: Rgba = [0, 0, 0, 1];

/** Rapproche `couleur` de `vers` par dixièmes jusqu'à atteindre `seuil` sur `fond` (ou `vers` si rien ne suffit). */
function assurer(couleur: Rgba, fond: Rgba, seuil: number, vers: Rgba): Rgba {
  let c = couleur;
  for (let p = 0; p <= 10 && rapport(sur(c, fond), fond) < seuil; p++) c = melanger(vers, couleur, p / 10);
  return c;
}

/** Textes d'état du thème de base [jeton, valeur sur surface claire, valeur sur surface sombre] : rapprochés du texte principal jusqu'à 4,5:1 sur `--surface` et `--app-bg`. */
const TEXTES_ETAT: readonly (readonly [string, string, string])[] = [
  ["--ok-text", "#047857", "#34d399"],
  ["--ok-text-strong", "#065f46", "#6ee7b7"],
  ["--warn-text", "#b45309", "#fbbf24"],
  ["--warn-text-strong", "#92400e", "#fcd34d"],
  ["--danger-text", "#dc2626", "#fca5a5"],
  ["--danger-strong", "#b91c1c", "#fecaca"],
];
const OK_PLEIN = "#047857";

/** Jetons d'état et de teinte d'accent dérivés par le serveur, hors liste blanche : émis dans la feuille et mesurés. */
export const JETONS_DERIVES_ETAT: readonly string[] = [
  ...TEXTES_ETAT.map(([c]) => c),
  "--ok",
  "--ok-fg",
  "--accent-500",
  "--accent-400",
];

/** Jeu effectif d'un mode : valeurs posées, puis dérivations pour tout ce qui manque. */
export function deriver(explicite: Jetons): Jetons {
  const e = explicite;
  const bg = rgba(e["--app-bg"] ?? "#ffffff");
  const surf = rgba(e["--surface"] ?? "#ffffff");
  const t9 = rgba(e["--text-900"] ?? "#000000");
  const t6 = rgba(e["--text-600"] ?? "#000000");
  const accent = rgba(e["--accent"] ?? "#000000");
  const railBg = rgba(e["--rail-bg"] ?? "#000000");
  const railTexte = rgba(e["--rail-text"] ?? "#ffffff");
  const sombre = luminance(bg) < 0.18;
  const d: Jetons = {};
  const pose = (cle: string, c: Rgba | string): void => {
    d[cle] = e[cle] ?? (typeof c === "string" ? c : versCss(c));
  };
  const lu = (cle: string): Rgba => rgba(d[cle] ?? "#000000");
  pose("--surface-2", melanger(t9, surf, 0.03));
  pose("--surface-3", melanger(t9, surf, 0.06));
  pose("--surface-4", melanger(t9, surf, 0.12));
  pose("--surface-5", melanger(t9, surf, 0.2));
  const trait = rgba(e["--border"] ?? "#000000");
  pose("--border-soft", [trait[0], trait[1], trait[2], trait[3] * 0.5]);
  pose("--text-800", melanger(t9, t6, 2 / 3));
  pose("--text-700", melanger(t9, t6, 1 / 3));
  pose("--text-500", assurer(melanger(surf, t6, 0.12), surf, SEUIL_TEXTE, t6));
  pose("--text-400", assurer(melanger(surf, t6, 0.25), surf, SEUIL_TEXTE, t6));
  pose("--text-max", t9);
  pose("--prose-body", lu("--text-700"));
  pose("--prose-heading", t9);
  pose("--prose-strong", t9);
  const forte = melanger(sombre ? BLANC : NOIR, accent, 0.18);
  const sousTexte = (fg: Rgba): number => Math.min(rapport(fg, accent), rapport(fg, sur(forte, surf)));
  const fg = sousTexte(BLANC) >= sousTexte(NOIR) ? BLANC : NOIR;
  pose("--accent-fg", fg);
  pose("--accent-strong", assurer(forte, fg, SEUIL_TEXTE, accent));
  pose("--accent-500", assurer(accent, surf, SEUIL_INTERFACE, t9));
  pose("--accent-400", assurer(melanger(BLANC, accent, 0.25), surf, SEUIL_INTERFACE, t9));
  pose("--accent-text", assurer(assurer(accent, surf, SEUIL_TEXTE, t9), bg, SEUIL_TEXTE, t9));
  pose("--accent-text-strong", assurer(melanger(t9, lu("--accent-text"), 0.2), surf, SEUIL_TEXTE, t9));
  pose("--accent-surface", melanger(accent, surf, sombre ? 0.15 : 0.08));
  pose("--accent-surface-2", melanger(accent, surf, sombre ? 0.22 : 0.16));
  pose("--accent-border", melanger(accent, surf, 0.35));
  pose("--accent-ring", accent);
  pose("--prose-link", lu("--accent-text"));
  pose("--prose-link-hover", lu("--accent-text-strong"));
  pose("--code-inline-bg", lu("--surface-3"));
  pose("--code-inline-fg", lu("--accent-text-strong"));
  pose("--code-inline-border", rgba(e["--border"] ?? "#000000"));
  pose("--rail-bg-2", melanger(NOIR, railBg, 0.25));
  pose("--rail-text-strong", rapport(BLANC, railBg) >= rapport(NOIR, railBg) ? BLANC : NOIR);
  pose("--rail-border", melanger(railTexte, railBg, 0.15));
  pose("--rail-muted", assurer(melanger(railBg, railTexte, 0.3), railBg, SEUIL_TEXTE, railTexte));
  const fortRail = lu("--rail-text-strong");
  pose("--rail-hover", [fortRail[0], fortRail[1], fortRail[2], 0.1]);
  pose("--rail-chip", [fortRail[0], fortRail[1], fortRail[2], 0.08]);
  pose("--rail-input-bg", [fortRail[0], fortRail[1], fortRail[2], 0.06]);
  pose("--rail-input-border", [fortRail[0], fortRail[1], fortRail[2], 0.1]);
  pose("--rail-active-bg", [accent[0], accent[1], accent[2], 0.2]);
  const surfSombre = luminance(surf) < 0.18;
  for (const [cle, clair, fonce] of TEXTES_ETAT)
    pose(cle, assurer(assurer(rgba(surfSombre ? fonce : clair), surf, SEUIL_TEXTE, t9), bg, SEUIL_TEXTE, t9));
  pose("--ok", OK_PLEIN);
  pose("--ok-fg", rapport(BLANC, rgba(OK_PLEIN)) >= rapport(NOIR, rgba(OK_PLEIN)) ? BLANC : NOIR);
  if (e["--code-bg"] !== undefined || e["--code-fg"] !== undefined) {
    const cb = rgba(e["--code-bg"] ?? "#0d1117");
    const cf = rgba(e["--code-fg"] ?? "#c9d1d9");
    pose("--code-bg", cb);
    pose("--code-fg", cf);
    pose("--code-header-bg", melanger(cf, cb, 0.06));
    pose("--code-border", melanger(cf, cb, 0.18));
    pose("--code-header-fg", melanger(cf, cb, 0.65));
  }
  return { ...d, ...e };
}

/** Paires de jetons exigées en plus de celles du front (même liste `PAIRES_TEXTE`) : [premier plan, fond, seuil]. */
const PAIRES_PERSO: readonly (readonly [string, string, number])[] = [
  ["--text-900", "--surface", SEUIL_TEXTE],
  ["--text-900", "--app-bg", SEUIL_TEXTE],
  ["--text-800", "--surface", SEUIL_TEXTE],
  ["--text-700", "--surface", SEUIL_TEXTE],
  ["--text-600", "--surface", SEUIL_TEXTE],
  ["--text-600", "--app-bg", SEUIL_TEXTE],
  ["--prose-link", "--surface", SEUIL_TEXTE],
  ["--code-inline-fg", "--code-inline-bg", SEUIL_TEXTE],
  ["--rail-text", "--rail-bg", SEUIL_TEXTE],
  ["--rail-text-strong", "--rail-bg", SEUIL_TEXTE],
  ["--rail-muted", "--rail-bg", SEUIL_TEXTE],
  ["--rail-text", "--rail-bg-2", SEUIL_TEXTE],
  ["--code-fg", "--code-bg", SEUIL_TEXTE],
  ["--accent", "--surface", SEUIL_INTERFACE],
  ["--accent", "--app-bg", SEUIL_INTERFACE],
  ["--accent-ring", "--surface", SEUIL_INTERFACE],
  ["--accent-500", "--surface", SEUIL_INTERFACE],
  ["--accent-400", "--surface", SEUIL_INTERFACE],
  ["--accent-fg", "--accent-strong", SEUIL_TEXTE],
  ...TEXTES_ETAT.map(([c]) => [c, "--app-bg", SEUIL_TEXTE] as const),
  ["--danger-strong", "--surface", SEUIL_TEXTE],
];

/** Toutes les paires mesurées sur un jeu effectif, jetons d'état dérivés compris. */
export function mesurer(jeu: Jetons, mode: ModePerso): ContrastePerso[] {
  const sortie: ContrastePerso[] = [];
  const vues = new Set<string>();
  const liste = [...PAIRES_TEXTE.map(([a, b]) => [a, b, SEUIL_TEXTE] as const), ...PAIRES_PERSO];
  for (const [fg, fond, seuil] of liste) {
    const cle = `${fg} / ${fond}`;
    const a = jeu[fg];
    const b = jeu[fond];
    if (vues.has(cle) || a === undefined || b === undefined) continue;
    vues.add(cle);
    const arriere = sur(rgba(b), BLANC);
    const r = rapport(sur(rgba(a), arriere), arriere);
    sortie.push({ paire: cle, mode, ratio: Math.floor(r * 100) / 100, seuil, ok: r >= seuil });
  }
  return sortie;
}

/** Jeu explicite d'un mode : ses jetons, complétés des jetons communs du jeu clair. */
function explicitePour(mode: ModePerso, clair: Jetons, sombre: Jetons): Jetons {
  if (mode === "light") return clair;
  const communs: Jetons = {};
  for (const k of COMMUNS) if (clair[k] !== undefined) communs[k] = clair[k];
  return { ...communs, ...sombre };
}

/** Feuille générée : un bloc clair, un bloc sombre ; le rayon et ses dérivés ne sont posés qu'une fois. */
function feuille(id: string, clair: Jetons, sombre: Jetons, communsSombre: ReadonlySet<string>): string {
  const bloc = (selecteur: string, jeu: Jetons): string =>
    blocJetons(selecteur, Object.fromEntries(Object.entries(jeu).sort(([a], [b]) => (a < b ? -1 : 1))));
  const sansCommuns = Object.fromEntries(
    Object.entries(sombre).filter(([k]) => !COMMUNS.includes(k) || communsSombre.has(k)),
  );
  return [
    `/* Habillage personnel « ${id} » — feuille générée par Elpis. */\n`,
    bloc(`body.${CLASSE_PERSO}`, clair),
    bloc(`body.${CLASSE_PERSO}.elpis-app-dark`, sansCommuns),
  ].join("\n");
}

/** Octets du manifeste tel que reçu. */
function taille(m: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(m) ?? "", "utf8");
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/** Vérifie un habillage personnel : structure, jetons, dérivations, contraste, puis feuille ; `manifeste` est rendu quand tout est valide. */
export function evaluerSkinPerso(brut: unknown): EvaluationPerso {
  const erreurs: string[] = [];
  const avertissements: string[] = [];
  const vide = (): EvaluationPerso => ({
    rapport: { ok: false, erreurs, avertissements, contrastes: [], css: "" },
    manifeste: null,
  });
  if (!estDict(brut)) {
    erreurs.push("Habillage : objet JSON attendu.");
    return vide();
  }
  if (taille(brut) > MAX_PERSO_OCTETS) {
    erreurs.push(`Habillage : ${MAX_PERSO_OCTETS / 1024} Ko au plus.`);
    return vide();
  }
  for (const cle of Object.keys(brut)) {
    if (CLES_REFUSEES.has(cle))
      erreurs.push(`Clé « ${cle} » interdite : un habillage personnel ne contient que des jetons.`);
    else if (!CLES_HAUT.has(cle)) erreurs.push(`Clé « ${cle.slice(0, 24)} » inconnue.`);
  }
  const darkBase = brut["darkBase"] === true;
  if (brut["darkBase"] !== undefined && typeof brut["darkBase"] !== "boolean")
    erreurs.push("darkBase : booléen attendu.");
  const tokens = brut["tokens"];
  let clair: Jetons = {};
  let sombre: Jetons = {};
  if (!estDict(tokens)) erreurs.push("tokens : objet {light, dark} attendu.");
  else {
    for (const cle of Object.keys(tokens))
      if (cle !== "light" && cle !== "dark")
        erreurs.push("tokens : seules les clés light et dark sont admises.");
    clair = jetonsDuMode(tokens["light"], "Jetons clairs", erreurs);
    if (darkBase) {
      if (estDict(tokens["dark"]) && Object.keys(tokens["dark"]).length > 0)
        avertissements.push("darkBase : le jeu sombre est ignoré, le jeu clair sert aux deux modes.");
      sombre = clair;
    } else sombre = jetonsDuMode(tokens["dark"], "Jetons sombres", erreurs);
  }
  const modes: [ModePerso, Jetons][] = darkBase
    ? [["light", clair]]
    : [
        ["light", clair],
        ["dark", sombre],
      ];
  for (const [mode, jeu] of modes) {
    const manquants = JETONS_REQUIS.filter((k) => jeu[k] === undefined);
    if (manquants.length > 0)
      erreurs.push(
        `Jetons ${mode === "light" ? "clairs" : "sombres"} requis manquants : ${manquants.join(", ")}.`,
      );
  }
  const brutSw = brut["swatch"] ?? brut["sw"];
  let pastilles: string[] | null = null;
  if (brutSw !== undefined) {
    if (
      !Array.isArray(brutSw) ||
      brutSw.length !== 3 ||
      brutSw.some((c) => typeof c !== "string" || !couleurAdmise(c.trim()) || analyse(c.trim()) === null)
    )
      erreurs.push("Pastilles : trois couleurs #hex, rgb() ou hsl() attendues [rail, fond, accent].");
    else pastilles = brutSw.map((c: string) => c.trim().toLowerCase());
  }
  if (typeof brut["desc"] === "string" && brut["desc"].length > MAX_DESC_SKIN)
    erreurs.push(`Description : ${MAX_DESC_SKIN} caractères au plus.`);
  const requisClair = JETONS_REQUIS.every((k) => clair[k] !== undefined);
  const defaut =
    pastilles ?? (requisClair ? [clair["--rail-bg"], clair["--app-bg"], clair["--accent"]] : null);
  let manifeste: Record<string, unknown> | null = null;
  try {
    const norm = validateManifest({
      id: brut["id"],
      label: brut["label"],
      description: brut["description"] ?? brut["desc"],
      darkBase,
      swatch: defaut ?? ["#000000", "#000000", "#000000"],
      tokens: { light: clair, dark: darkBase ? {} : sombre },
    }) as Record<string, unknown>;
    for (const k of ["version", "author", "license"]) delete norm[k];
    if (typeof norm["id"] === "string" && !ID_RE.test(norm["id"]))
      throw new SkinError("Identifiant invalide.");
    if (String(norm["label"]).length > MAX_LABEL_SKIN) throw new SkinError("Nom trop long.");
    manifeste = norm;
  } catch (e) {
    if (!(e instanceof SkinError)) throw e;
    erreurs.push(e.message);
  }
  if (erreurs.length > 0) return vide();
  const contrastes: ContrastePerso[] = [];
  const effectifs: Partial<Record<ModePerso, Jetons>> = {};
  for (const [mode] of modes) {
    effectifs[mode] = deriver(explicitePour(mode, clair, sombre));
    contrastes.push(...mesurer(effectifs[mode], mode));
  }
  for (const c of contrastes)
    if (!c.ok)
      erreurs.push(
        `Contraste insuffisant (${c.mode === "light" ? "clair" : "sombre"}) : ${c.paire} = ${c.ratio}:1, ${c.seuil}:1 exigé.`,
      );
  const effClair = effectifs.light ?? {};
  const effSombre = darkBase ? effClair : (effectifs.dark ?? {});
  const css = feuille(
    String(manifeste?.["id"]),
    effClair,
    effSombre,
    new Set(darkBase ? COMMUNS : COMMUNS.filter((k) => sombre[k] !== undefined)),
  );
  if (manifeste !== null && darkBase) manifeste["tokens"] = { light: clair, dark: {} };
  const ok = erreurs.length === 0;
  return { rapport: { ok, erreurs, avertissements, contrastes, css }, manifeste: ok ? manifeste : null };
}

/** Rapport de vérification d'un habillage personnel (voir `evaluerSkinPerso` pour le manifeste normalisé). */
export function verifierSkinPerso(manifeste: unknown): RapportPerso {
  return evaluerSkinPerso(manifeste).rapport;
}
