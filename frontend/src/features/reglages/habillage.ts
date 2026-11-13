// SPDX-License-Identifier: MIT
/** frontend/src/features/reglages/habillage.ts — habillage posé sur la page : feuilles de l'habillage actif seulement (chargées avant la bascule), classes du body, et dernier état connu gardé dans le navigateur, relu avant le premier rendu par le script de apps/core/src/interface/pages.ts. */
import { PREFIXE_PERSO } from "@elpis/contracts";

/** Clé du stockage local ; sa forme (`MemoireHabillage`) est celle que lit le script d'avant le premier rendu. */
export const CLE_HABILLAGE = "elpis-habillage";

export type ModeTheme = "system" | "light" | "dark";

/** Habillage tel que la page le porte. */
export interface Habillage {
  readonly id: string;
  readonly palette: string;
  readonly mode: ModeTheme;
  readonly sombre: boolean;
  /** Skin à base sombre (`darkBase`). */
  readonly base: boolean;
  /** Feuilles servies par le cœur : skin importé ou habillage personnel. */
  readonly feuilles: readonly string[];
}

/** Forme gardée dans le navigateur : id du skin, palette, mode, base sombre, feuilles servies. */
export interface MemoireHabillage {
  id: string;
  p: string;
  m: ModeTheme;
  b: boolean;
  f: string[];
}

const MOTIF_PALETTE = /^[a-z][a-z0-9_-]{1,31}$/;
const GEREES = /^elpis-(?:skin-|palette-|app-dark$|dark-surface$)/;
const MODES: readonly unknown[] = ["system", "light", "dark"];
/** Modèle inerte des feuilles des skins intégrés (index.html, admin.html). */
const ID_MODELE = "elpis-habillages";
const ID_SERVIE = "elpis-plugin-skin";

const chargements = new WeakMap<HTMLLinkElement, Promise<void>>();
const actifs = new Set<HTMLLinkElement>();
let dernier: Habillage | null = null;

/** Nom de classe du body pour un id de skin ; un habillage personnel n'expose jamais son id dans la classe. */
export function classeSkin(id: string): string {
  return id.startsWith(PREFIXE_PERSO) ? "perso" : id;
}

/** Dernier habillage posé dans ce navigateur ; `null` sans stockage ou valeur illisible. */
export function lireMemoire(): MemoireHabillage | null {
  try {
    const brut: unknown = JSON.parse(localStorage.getItem(CLE_HABILLAGE) ?? "null");
    if (!brut || typeof brut !== "object") return null;
    const o = brut as Record<string, unknown>;
    if (typeof o["id"] !== "string") return null;
    const f = o["f"];
    return {
      id: o["id"],
      p: typeof o["p"] === "string" ? o["p"] : "",
      m: MODES.includes(o["m"]) ? (o["m"] as ModeTheme) : "light",
      b: o["b"] === true,
      f: Array.isArray(f) ? f.filter((x): x is string => typeof x === "string") : [],
    };
  } catch {
    return null;
  }
}

/** Réglages d'apparence de départ : ceux du dernier habillage posé, sinon Elpis clair. */
export function reglagesHabillage(m: MemoireHabillage | null = lireMemoire()) {
  return {
    skin: m?.id ?? "elpis",
    skin_palette: m?.p ?? "",
    dark_mode: m?.m === "dark",
    dark_mode_auto: m?.m === "system",
  };
}

/** Lien de la tête pour `href` et `rel`, posé au besoin juste après le modèle ; chargé, il reste inerte tant qu'il n'est pas actif. */
function lien(href: string, rel: string, modele?: Element): HTMLLinkElement {
  for (const l of document.head.querySelectorAll<HTMLLinkElement>("link[data-habillage]"))
    if (l.getAttribute("href") === href && l.rel === rel) return l;
  const l = modele ? (document.importNode(modele) as HTMLLinkElement) : document.createElement("link");
  if (!modele) {
    l.rel = rel;
    l.setAttribute("href", href);
    l.dataset["habillage"] = "";
  }
  chargements.set(
    l,
    new Promise<void>((fin) => {
      const finir = (): void => {
        chargements.delete(l);
        if (l.sheet && !actifs.has(l)) l.sheet.disabled = true;
        fin();
      };
      l.addEventListener("load", finir, { once: true });
      l.addEventListener("error", finir, { once: true });
    }),
  );
  const ancre = document.getElementById(ID_MODELE);
  if (ancre) ancre.after(l);
  else document.head.append(l);
  return l;
}

/** Liens d'un habillage : ceux du modèle de la page pour un skin intégré (feuilles, police), puis ses feuilles servies. */
function liens(id: string, feuilles: readonly string[]): HTMLLinkElement[] {
  const classe = classeSkin(id);
  const modele = document.getElementById(ID_MODELE);
  const integres =
    classe && modele instanceof HTMLTemplateElement
      ? Array.from(modele.content.querySelectorAll("link")).filter((m) => m.dataset["habillage"] === classe)
      : [];
  return [
    ...integres.map((m) => lien(m.getAttribute("href") ?? "", m.rel, m)),
    ...feuilles.map((f) => lien(f, "stylesheet")),
  ];
}

/** Chargements encore en cours parmi ces liens. */
function attentes(poses: readonly HTMLLinkElement[]): Promise<void>[] {
  return poses.map((l) => chargements.get(l)).filter((p) => p !== undefined);
}

/** Classes du body d'un habillage, sans retoucher celles qui restent : aucun recalcul de style si rien ne change. */
function poserClasses(h: Habillage): void {
  const cls = document.body.classList;
  const voulues = new Set<string>();
  if (h.id) voulues.add("elpis-skin-" + classeSkin(h.id));
  if (MOTIF_PALETTE.test(h.palette)) voulues.add("elpis-palette-" + h.palette);
  if (h.sombre) voulues.add("elpis-app-dark");
  if (h.sombre || h.base) voulues.add("elpis-dark-surface");
  for (const c of Array.from(cls)) if (GEREES.test(c) && !voulues.has(c)) cls.remove(c);
  for (const c of voulues) if (!cls.contains(c)) cls.add(c);
}

/** Feuilles et classes basculées ensemble ; les feuilles des autres habillages sont désactivées, celles servies retirées. */
function basculer(h: Habillage, poses: readonly HTMLLinkElement[]): void {
  actifs.clear();
  for (const l of poses) {
    actifs.add(l);
    if (l.sheet) l.sheet.disabled = false;
  }
  poserClasses(h);
  for (const l of document.head.querySelectorAll<HTMLLinkElement>("link[data-habillage]")) {
    if (actifs.has(l)) continue;
    if (l.getAttribute("href")?.startsWith("/api/")) l.remove();
    else if (l.sheet) l.sheet.disabled = true;
  }
  const servie = poses.find((l) => l.getAttribute("href")?.startsWith("/api/"));
  if (servie) servie.id = ID_SERVIE;
  try {
    const m: MemoireHabillage = { id: h.id, p: h.palette, m: h.mode, b: h.base, f: [...h.feuilles] };
    localStorage.setItem(CLE_HABILLAGE, JSON.stringify(m));
  } catch {
    /* stockage indisponible */
  }
}

/** Pose l'habillage et le garde pour le prochain chargement ; une feuille absente est chargée avant la bascule, le dernier demandé l'emporte. */
export async function poserHabillage(h: Habillage): Promise<void> {
  if (!document.body) return;
  dernier = h;
  const poses = liens(h.id, h.feuilles);
  const attente = attentes(poses);
  if (attente.length) await Promise.all(attente);
  if (dernier === h) basculer(h, poses);
}

/** Lit sous les feuilles d'un skin intégré, chargées au besoin, sans changer l'habillage posé (éditeur d'habillages de la console). */
export async function avecFeuilles<T>(id: string, lire: () => T): Promise<T> {
  const poses = liens(id, []);
  await Promise.all(attentes(poses));
  for (const l of poses) if (l.sheet) l.sheet.disabled = false;
  try {
    return lire();
  } finally {
    for (const l of poses) if (l.sheet) l.sheet.disabled = !actifs.has(l);
  }
}
