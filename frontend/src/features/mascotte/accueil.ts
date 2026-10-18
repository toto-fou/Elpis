// SPDX-License-Identifier: MIT
/** frontend/src/features/mascotte/accueil.ts — scène de l'écran d'accueil : le mot ELPIS (ou KIKI) en pixel art et la mascotte qui joue autour, dessinés sur un canevas à l'échelle entière. */
import { MOTIFS, MOT as MOT_ELPIS, MOTS, HAUT_LETTRE, MOTIF_RETENU } from "./motifs";
import type { Glyphe, Motif } from "./motifs";
import { SCENARIOS, SCENARIOS_TIRABLES } from "./scenes";
import type { Acte, Scenario } from "./scenes";
import { journal } from "../../platform/journal";

export interface DonneesSprite {
  format?: "sprite";
  palette?: Record<string, readonly number[]>;
  anims: Record<string, string[][]>;
  cadre?: string;
  cadence?: Record<string, number>;
}

export interface DonneesAtlas {
  format: "atlas";
  image: string;
  case: readonly [number, number];
  colonnes: number;
  perso: readonly [number, number];
  anims: Record<string, number[]>;
  grandir?: number;
  points?: Record<string, unknown>;
  points_images?: Record<string, ReadonlyArray<readonly [number, number]>>;
  unefois?: string[];
  associes?: string[];
  cadence?: Record<string, number>;
}

export type DonneesPerso = DonneesSprite | DonneesAtlas;

export interface PersoPret {
  anims: Record<string, HTMLCanvasElement[]>;
  cote: number;
  larg: number;
  caseW: number;
  caseH: number;
  cadence: Record<string, number> | null;
  lisse?: boolean;
  grandir?: number;
  points?: Record<string, unknown>;
  pointsImages?: Record<string, ReadonlyArray<readonly [number, number]>>;
  unefois?: Set<string>;
  associes?: string[];
}

export interface OptionsAccueil {
  base?: string;
  mot?: string;
  sousTitre?: string;
  graine?: unknown;
  perso?: string;
  motif?: string;
  scenario?: string;
  auFini?: ((nom: string) => void) | null;
  echelleMot?: unknown;
  echellePerso?: unknown;
  suffixe?: string;
  mouvement?: string;
  intro?: boolean;
  donnees?: DonneesPerso;
}

export interface SceneAccueil {
  choix: { perso: string; motif: string; scenario: string | undefined };
  readonly duree: number;
  readonly scenario: string | null;
  pret: Promise<void>;
  jouer(nom: string, opts?: { intro?: boolean }): void;
  pause(): void;
  reprendre(): void;
  rejouer(): void;
  aller(t: number, avecIntro?: boolean): void;
  detruire(): void;
}

interface Reperes {
  motX: number;
  motY: number;
  cote: number;
  larg: number;
  sol: number;
  socketX: number;
  socketY: number;
  sousE: number;
  sousL: number;
  sousP: number;
  sousI: number;
  sousS: number;
  posteTir: number;
  posteCoupe: number;
  centre: number;
  gauche: number;
  souffle: number;
  droite: number;
  horsGauche: number;
  horsDroite: number;
  [nom: string]: number | undefined;
}

function position(R: Reperes, x: string | number): number {
  return typeof x === "number" ? x : (R[x] ?? 0);
}

interface EtatScene {
  R: Reperes;
  acte: Acte;
  u: number;
  x: number;
  y: number;
  i: number;
  cible: number;
  source: number;
}

interface ImagePeinte {
  f: HTMLCanvasElement;
  cx: number;
  solY: number;
  tl: number;
  taille: number;
  lisse: boolean;
  tScene: number;
}

interface Pivot {
  img: ImagePeinte;
  t0: number;
  type: "pivot" | "fondu";
}

interface Point {
  x: number;
  y: number;
}

interface Teintes {
  encre: string;
  or: string;
  sourd: string;
}

const VIDE = ".";

const GLYPHE_Z: Glyphe = ["#####", "...#.", "..#..", ".#...", "#####"];

const COTE_NOMINAL = 22;

export const ECHELLE_MOT_DEFAUT = 1;
export const ECHELLE_PERSO_DEFAUT = 0.78;

export const PERSOS: readonly string[] = ["boite_or", "fantome", "flamme", "elpis"];

const CHUTE_LETTRE = 0.55,
  DECALAGE_LETTRE = 0.16;

const facilite = (u: number): number => 1 - Math.pow(1 - u, 3);

function condensat(texte: string): number {
  let h = 2166136261;
  for (let i = 0; i < texte.length; i++) {
    h ^= texte.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function tirer(graine?: unknown): { motif: string; scenario: string; perso: string } {
  const h = graine ? condensat(String(graine)) : Math.floor(Math.random() * 4294967296);
  const scenarios = SCENARIOS_TIRABLES;
  return {
    motif: MOTIF_RETENU,
    scenario: scenarios[(h >>> 9) % scenarios.length] ?? "repos",
    perso: PERSOS[(h >>> 18) % PERSOS.length] ?? "elpis",
  };
}

const _cache = new Map<string, Promise<PersoPret>>();

function chargerPerso(base: string, nom: string, donnees?: DonneesPerso): Promise<PersoPret> {
  if (donnees) return _preparer(donnees, base, nom);
  const cle = base + nom;
  let p = _cache.get(cle);
  if (!p) {
    p = _preparer(null, base, nom);
    _cache.set(cle, p);
  }
  return p;
}

async function _preparer(donnees: DonneesPerso | null, base: string, nom: string): Promise<PersoPret> {
  const d: DonneesPerso =
    donnees || ((await (await fetch(`${base}${nom}/source.json`)).json()) as DonneesPerso);
  if (d.format === "atlas") return _preparerAtlas(d, base, nom);
  const pal: Record<string, readonly number[]> = Object.assign(
    { O: [250, 120, 55], D: [26, 11, 18], L: [252, 169, 81] },
    d.palette || {},
  );

  let haut = 1e6,
    bas = -1,
    gauche = 1e6,
    droite = -1;
  for (const frames of Object.values(d.anims) as string[][][])
    for (const fr of frames)
      fr.forEach((ligne: string, y: number) =>
        [...ligne].forEach((c, x) => {
          if (c !== VIDE) {
            haut = Math.min(haut, y);
            bas = Math.max(bas, y);
            gauche = Math.min(gauche, x);
            droite = Math.max(droite, x);
          }
        }),
      );
  const h = bas - haut + 1,
    w = droite - gauche + 1;

  const large = d.cadre === "large";
  const cote = large ? h : Math.max(h, w);
  const lw = large ? w : cote,
    lh = cote;
  const dy = large ? 0 : (cote - h) >> 1,
    dx = large ? 0 : (cote - w) >> 1;

  const anims: Record<string, HTMLCanvasElement[]> = {};
  for (const [anim, frames] of Object.entries(d.anims)) {
    anims[anim] = frames.map((fr) => {
      const c = document.createElement("canvas");
      c.width = lw;
      c.height = lh;
      const g = c.getContext("2d") as CanvasRenderingContext2D;
      const img = g.createImageData(lw, lh);
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) {
          const ch = fr[haut + y]?.[gauche + x] ?? VIDE;
          const rgb = ch !== VIDE ? pal[ch] : undefined;
          if (!rgb) continue;
          const i = ((dy + y) * lw + dx + x) * 4;
          img.data[i] = rgb[0] ?? 0;
          img.data[i + 1] = rgb[1] ?? 0;
          img.data[i + 2] = rgb[2] ?? 0;
          img.data[i + 3] = 255;
        }
      g.putImageData(img, 0, 0);
      return c;
    });
  }
  return { anims, cote, larg: lw, caseW: lw, caseH: lh, cadence: d.cadence || null };
}

async function _preparerAtlas(d: DonneesAtlas, base: string, nom: string): Promise<PersoPret> {
  const img = new Image();
  img.src = `${base}${nom}/${d.image}`;
  await img.decode();
  const [cw, ch] = d.case,
    col = d.colonnes;
  const cache = new Map<number, HTMLCanvasElement>();
  const tranche = (i: number): HTMLCanvasElement => {
    let c = cache.get(i);
    if (!c) {
      c = document.createElement("canvas");
      c.width = cw;
      c.height = ch;
      (c.getContext("2d") as CanvasRenderingContext2D).drawImage(
        img,
        (i % col) * cw,
        Math.floor(i / col) * ch,
        cw,
        ch,
        0,
        0,
        cw,
        ch,
      );
      cache.set(i, c);
    }
    return c;
  };
  const anims: Record<string, HTMLCanvasElement[]> = {};
  for (const [a, idx] of Object.entries(d.anims)) anims[a] = idx.map(tranche);
  return {
    anims,
    cote: d.perso[1],
    larg: d.perso[0],
    caseW: cw,
    caseH: ch,
    lisse: true,
    grandir: Number(d.grandir) || 1,
    points: d.points || {},
    pointsImages: d.points_images || {},
    unefois: new Set(d.unefois || []),
    associes: d.associes || [],
    cadence: d.cadence || null,
  };
}

export function montrerAccueil(hote: HTMLElement, options: OptionsAccueil = {}): SceneAccueil {
  const base = options.base ?? "./";

  const MOT = MOTS[String(options.mot || "").toLowerCase()] || MOT_ELPIS;
  const sousTitre = options.sousTitre ?? "";

  const sort = tirer(options.graine);
  const auto = (v: string | undefined): boolean => !v || v === "auto";
  const nomPerso: string = (auto(options.perso) ? sort.perso : options.perso) ?? sort.perso;
  const motif: Motif =
    MOTIFS[(auto(options.motif) ? sort.motif : options.motif) ?? sort.motif] ?? (MOTIFS["bloc"] as Motif);
  const nomDepart: string = (auto(options.scenario) ? sort.scenario : options.scenario) ?? sort.scenario;

  const auFini = typeof options.auFini === "function" ? options.auFini : null;

  const nombre = (v: unknown, defaut: number, min: number, max: number): number => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : defaut;
  };
  const echelleMot = nombre(options.echelleMot, ECHELLE_MOT_DEFAUT, 0.4, 2);
  let echellePerso = nombre(options.echellePerso, ECHELLE_PERSO_DEFAUT, 0.3, 1.6);

  let ECART_SOL = Math.round(COTE_NOMINAL * echellePerso) + 2;
  let HAUT_SCENE = HAUT_LETTRE + ECART_SOL;

  let ACTES: Acte[] = [],
    DUREE = 0,
    nomCourant = "",
    tenirCourant = false;

  let perso: PersoPret | null = null;

  let persoPrincipal: PersoPret | null = null,
    persoVoulu: string | null = null,
    persoScene: string | null = null;

  let derniereImage: ImagePeinte | null = null,
    pivot: Pivot | null = null,
    tDessin = 0;
  const persosScene = new Map<string, PersoPret>();
  const requis = (): PersoPret => perso as PersoPret;

  function appliquerPerso(): void {
    if (!persoPrincipal) return;
    perso = (persoVoulu && persosScene.get(persoVoulu)) || persoPrincipal;
  }
  let acteVol: Acte | null = null,
    acteRendu: Acte | null = null,
    acteZzz: Acte | null = null;
  let tirs: Acte[] = [],
    acteRengaine: Acte | null = null,
    acteRebouche: Acte | null = null;
  let boucleCourante = false,
    tour = 0;
  let acteTranche: Acte | null = null,
    acteRecolle: Acte | null = null,
    cibleCoupe = 1;

  let enSortie = false,
    ensuite: string | null = null;
  let finAnnoncee = false;

  let origineX: number | null = null;

  const EXIGENCE: Record<string, string> = { souffle: "feu", foudre: "eclair" };

  function scenarioTenable(nom: string): boolean {
    const besoin = EXIGENCE[nom];

    return !besoin || !perso || !!perso.anims[besoin];
  }

  function poserScenario(nom: string, sortieDe?: string, sortieVers?: string): void {
    if (!sortieDe && !scenarioTenable(nom)) nom = "pouvoir";
    let s: Scenario = SCENARIOS[nom] ?? (SCENARIOS["vol"] as Scenario);
    nomCourant = SCENARIOS[nom] ? nom : "vol";

    if (sortieDe) {
      const src = SCENARIOS[sortieDe] as Scenario;
      s = {
        actes: (src.sortieVers && sortieVers && src.sortieVers[sortieVers]) || src.sortie || [],
        perso: src.perso,
      };
      nomCourant = `${sortieDe}:sortie`;
    }

    tenirCourant = !!s.tenir;
    boucleCourante = !!s.boucle;

    hote.dataset.scene = nomCourant;

    if (derniereImage) derniereImage.tScene = 0;
    pivot = null;
    persoScene = s.perso || null;
    persoVoulu = persoScene;
    appliquerPerso();

    ACTES = s.actes.map((a) =>
      typeof a.cible === "number" && a.cible < 0 ? { ...a, cible: MOT.length + a.cible } : { ...a },
    );

    const m0 = ACTES[0];

    if (m0 && m0.marche && m0.vitesse && ACTES[1] && perso) {
      const R = reperes();
      const src = origineX !== null ? origineX : ACTES.some((a) => a.x) ? R.horsGauche : R.sousS;
      const cible = position(R, m0.x ?? 0);
      const duree = Math.max(0.25, Math.abs(cible - src) / m0.vitesse);
      const delta = duree - (ACTES[1]!.t - m0.t);
      for (let j = 1; j < ACTES.length; j++) ACTES[j]!.t += delta;
    }
    DUREE = ACTES[ACTES.length - 1]!.t;
    acteVol = ACTES.find((a) => a.prend) || null;
    acteRendu = ACTES.find((a) => a.repose) || null;
    acteZzz = ACTES.find((a) => a.zzz) || null;
    tirs = ACTES.filter((a) => a.tir);
    acteRengaine = ACTES.find((a) => a.rengaine) || null;
    acteRebouche = ACTES.find((a) => a.rebouche) || null;
    acteTranche = ACTES.find((a) => a.tranche) || null;
    acteRecolle = ACTES.find((a) => a.recolle) || null;

    if (acteTranche) cibleCoupe = (cibleCoupe + 1) % MOT.length;
    finAnnoncee = false;
  }
  poserScenario(nomDepart);
  const scenario = SCENARIOS[nomCourant];

  const LARG_LETTRE = motif.larg,
    ECART_LETTRE = motif.ecart;
  const LARG_MOT = MOT.length * LARG_LETTRE + (MOT.length - 1) * ECART_LETTRE;

  const SUFFIXE = String(options.suffixe || "");
  const H_SUFFIXE = HAUT_LETTRE * 0.32;
  const ECART_SUFFIXE = 2;
  const policeSuffixe = (px: number): string => `italic 700 ${px}px Georgia, "Times New Roman", serif`;
  let largSuffixe = 0;
  if (SUFFIXE) {
    const m = document.createElement("canvas").getContext("2d") as CanvasRenderingContext2D;
    m.font = policeSuffixe(100);

    largSuffixe = (m.measureText(SUFFIXE).width / 100) * (H_SUFFIXE / 0.5) + ECART_SUFFIXE;
  }
  const LARG_TITRE = LARG_MOT + largSuffixe;

  const canevas = document.createElement("canvas");
  canevas.className = "accueil-toile";
  canevas.setAttribute("role", "img");
  canevas.setAttribute(
    "aria-label",
    `${MOT.join("")}${SUFFIXE ? " " + SUFFIXE : ""} — le mot en pixel art, avec une mascotte qui joue autour`,
  );
  hote.appendChild(canevas);

  let legende = null;
  if (sousTitre) {
    legende = document.createElement("p");
    legende.className = "accueil-soustitre";
    legende.textContent = sousTitre;
    hote.appendChild(legende);
  }

  const ctx = canevas.getContext("2d") as CanvasRenderingContext2D;

  const sobre =
    options.mouvement === "toujours" ? { matches: false } : matchMedia("(prefers-reduced-motion: reduce)");

  let k = 8,
    largeur = 0,
    hauteur = 0;

  let depart = performance.now() / 1000,
    enPause = false;
  let premier = options.intro !== false;
  let boucle: number | null = null,
    tPause = 0;
  let teintes: Teintes = { encre: "#262626", or: "#b88a3d", sourd: "#615c52" };

  function relireTeintes(): void {
    const s = getComputedStyle(hote);
    const lu = (n: string, d: string): string => (s.getPropertyValue(n) || "").trim() || d;
    teintes = {
      encre: lu("--cl-ink", "#262626"),
      or: lu("--cl-clay", "#b88a3d"),
      sourd: lu("--cl-muted", "#615c52"),
    };
  }

  function redimensionner(): void {
    const r = hote.getBoundingClientRect();
    const dpr = Math.min(devicePixelRatio || 1, 2);
    largeur = Math.max(1, Math.round(r.width));
    hauteur = Math.max(1, Math.round(r.height));
    canevas.width = Math.round(largeur * dpr);
    canevas.height = Math.round(hauteur * dpr);
    canevas.style.width = largeur + "px";
    canevas.style.height = hauteur + "px";
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.imageSmoothingEnabled = false;

    const confortable = Math.min((largeur * 0.6) / LARG_TITRE, (hauteur * 0.88) / HAUT_SCENE);

    const debordement = Math.min(largeur / LARG_TITRE, hauteur / HAUT_SCENE);
    k = Math.max(2, Math.min(36, Math.floor(Math.min(confortable * echelleMot, debordement))));
  }

  function kPerso(): number {
    const source = perso ? perso.cote : COTE_NOMINAL;

    const rel =
      persoPrincipal && perso !== persoPrincipal
        ? ((perso?.grandir ?? 1) || 1) / (persoPrincipal.grandir || 1)
        : 1;
    if (perso?.lisse) return ((k * echellePerso * COTE_NOMINAL) / source) * rel;
    return Math.max(1, Math.round((k * echellePerso * COTE_NOMINAL) / source));
  }

  function reperes(): Reperes {
    const motX = Math.round((largeur / k - LARG_TITRE) / 2);
    const motY = Math.round((hauteur / k - HAUT_SCENE) / 2);

    const cote = perso ? (perso.cote * kPerso()) / k : COTE_NOMINAL * echellePerso;

    const larg = perso ? (perso.larg * kPerso()) / k : cote;
    const pas = LARG_LETTRE + ECART_LETTRE;
    const sous = (n: number): number => motX + n * pas + LARG_LETTRE / 2;
    const N = MOT.length;
    return {
      motX,
      motY,
      cote,
      larg,
      sol: motY + HAUT_SCENE,
      socketX: motX + (N - 1) * pas,
      socketY: motY,
      sousE: sous(0),
      sousL: sous(1),
      sousP: sous(Math.min(2, N - 1)),
      sousI: sous(Math.max(0, N - 2)),
      sousS: sous(N - 1),

      posteTir: Math.max(larg * 0.55, motX - larg * 0.9),

      posteCoupe: sous(cibleCoupe) - larg * 0.32,
      centre: motX + LARG_MOT / 2,
      gauche: motX - larg * 0.35,

      souffle: Math.max(larg * 0.6, motX - larg * 1.15),

      droite: Math.min(motX + LARG_MOT + larg * 0.35, largeur / k - larg * 0.6),
      horsGauche: -larg,
      horsDroite: largeur / k + larg,
    };
  }

  function anim(prefs: readonly string[]): string {
    const anims = requis().anims;
    for (const a of prefs) if (anims[a]) return a;
    return Object.keys(anims)[0] ?? "idle";
  }

  function etat(t: number): EtatScene {
    const R = reperes();
    let i = 0;
    while (i + 1 < ACTES.length && ACTES[i + 1]!.t <= t) i++;
    const acte = ACTES[i] as Acte,
      suivant = ACTES[i + 1] || acte;
    const duree = Math.max(0.001, suivant.t - acte.t);
    const u = Math.min(1, (t - acte.t) / duree);

    let cible: number | null = acte.x ? position(R, acte.x) : null;
    let source: number | null = acte.depuis ? (R[acte.depuis] ?? 0) : null;
    if (cible === null) {
      cible = source = derniereCible(i, R);
    } else if (source === null) {
      source = derniereCible(i - 1, R);
    }
    const x = source + (cible - source) * (acte.x ? u : 1);

    const vise = (a: Acte | undefined): number => (a && a.vise ? hauteurVisee(R) : 0);
    const y = acte.saut
      ? -acte.saut * 4 * u * (1 - u)
      : vise(ACTES[i - 1]) + (vise(acte) - vise(ACTES[i - 1])) * facilite(u);

    return { R, acte, u, x, y, i, cible, source };
  }

  function hauteurVisee(R: Reperes): number {
    return R.motY + HAUT_LETTRE * 0.5 + R.cote * 0.58 - R.sol;
  }

  function pointeDuSouffle(t: number, R: Reperes): number {
    const j = ACTES.findIndex((a) => a.balaye);
    if (j < 0 || t < ACTES[j]!.t) return -Infinity;
    const fin = ACTES[j + 1] ? ACTES[j + 1]!.t : ACTES[j]!.t + 2.4;
    const u = Math.min(1, (t - ACTES[j]!.t) / Math.max(0.001, fin - ACTES[j]!.t));

    return R.motX - LARG_LETTRE * 0.6 + (LARG_MOT + LARG_LETTRE * 1.4) * Math.min(1, u * 1.15);
  }

  function derniereCible(i: number, R: Reperes): number {
    for (let j = i; j >= 0; j--) {
      const xj = ACTES[j]!.x;
      if (xj) return position(R, xj);
    }

    if (origineX !== null) return origineX;
    return ACTES.some((a) => a.x) ? R.horsGauche : R.sousS;
  }

  function animDeLActe(e: EtatScene): readonly string[] {
    if (!e.acte.marche) return e.acte.anim || ["idle"];
    if (Math.abs(e.cible - e.source) < 0.5) return ["idle"];
    return e.cible < e.source ? ["run-left", "running", "idle"] : ["run-right", "running", "idle"];
  }

  const CHUTE = 0.45,
    RETOUR = 0.75;

  function lettreVolee(t: number, e: EtatScene): Point | null {
    if (!acteRendu) return null;

    const tPrise = acteVol ? acteVol.t + (acteVol.delaiPrise ?? 0.55) : 0;
    const tRendu = acteRendu.revient ? acteRendu.t : acteRendu.t + 0.55;
    if (t < tPrise || t >= tRendu + RETOUR) return null;

    const devant = acteVol && acteVol.flanc === "droite";
    const solX = devant ? e.x - LARG_LETTRE / 2 + e.R.larg * 0.59 : e.x - LARG_LETTRE / 2 - e.R.larg * 0.59;
    const solY = e.R.sol - HAUT_LETTRE;

    if (acteVol && t < tPrise + CHUTE) {
      const u = (t - tPrise) / CHUTE;
      return { x: e.R.socketX + (solX - e.R.socketX) * u, y: e.R.socketY + (solY - e.R.socketY) * u * u };
    }
    if (t < tRendu) return { x: solX, y: solY };

    if (acteRendu.revient) {
      const u = Math.min(1, (t - tRendu) / CHUTE_LETTRE);
      return { x: e.R.socketX, y: e.R.socketY - (1 - facilite(u)) * (HAUT_LETTRE + 6) };
    }
    const u = facilite((t - tRendu) / RETOUR);
    return { x: solX + (e.R.socketX - solX) * u, y: solY + (e.R.socketY - solY) * u };
  }

  function glyphe(motifLignes: Glyphe, x: number, y: number, couleur: string, echelle = 1): void {
    const c = k * echelle;
    ctx.fillStyle = couleur;
    motifLignes.forEach((ligne, dy) => {
      let debut = -1;
      for (let dx = 0; dx <= ligne.length; dx++) {
        const plein = ligne[dx] === "#";
        if (plein && debut < 0) debut = dx;
        if (!plein && debut >= 0) {
          ctx.fillRect(
            Math.round(x * k + debut * c),
            Math.round(y * k + dy * c),
            Math.round((dx - debut) * c),
            Math.round(c),
          );
          debut = -1;
        }
      }
    });
  }

  function lettre(c: string, x: number, y: number, teinte?: string | null, sansOr?: boolean): void {
    glyphe(motif.glyphes[c] as Glyphe, x, y, teinte || teintes.encre);

    if (motif.eclats && !sansOr) glyphe(motif.eclats[c] as Glyphe, x, y, teintes.or);
  }

  function logement(x: number, y: number): void {
    ctx.fillStyle = teintes.or;
    ctx.globalAlpha = 0.45;
    for (let dy = 0; dy < HAUT_LETTRE; dy++)
      for (let dx = 0; dx < LARG_LETTRE; dx++) {
        const bord = dx === 0 || dy === 0 || dx === LARG_LETTRE - 1 || dy === HAUT_LETTRE - 1;
        if (bord && (dx + dy) % 2 === 0)
          ctx.fillRect(Math.round((x + dx) * k), Math.round((y + dy) * k), Math.round(k), Math.round(k));
      }
    ctx.globalAlpha = 1;
  }

  function spriteIncline(nomAnim: string, cx: number, solY: number, t: number, penche: number): void {
    const frames = requis().anims[nomAnim];
    if (!frames || !frames.length) return;
    const cad = cadence(nomAnim) / 1000;
    const f = frames[Math.floor(Math.max(0, t) / cad) % frames.length] as HTMLCanvasElement;
    const taille = Math.round(requis().caseH * kPerso());
    const tl = Math.round(requis().caseW * kPerso());
    const gx = cx * k - tl / 2,
      gy = solY * k - taille;
    ctx.imageSmoothingEnabled = !!requis().lisse;
    const B = 12;
    for (let i = 0; i < B; i++) {
      const sA = Math.round((i * f.height) / B);
      const sB = Math.round(((i + 1) * f.height) / B);
      const dA = Math.round(gy + (i * taille) / B);
      const dB = Math.round(gy + ((i + 1) * taille) / B);
      const u = 1 - i / (B - 1);
      const dx = Math.round(penche * u * k);
      ctx.drawImage(f, 0, sA, f.width, sB - sA, Math.round(gx) + dx, dA, tl, dB - dA);
    }
    ctx.imageSmoothingEnabled = false;
  }

  let boucheCourante: Point | null = null;

  const DUREE_PIVOT = 0.3;

  function indiceImage(nomAnim: string, t: number, n: number): number {
    const i = Math.floor(Math.max(0, t) / (cadence(nomAnim) / 1000));

    return requis().unefois?.has(nomAnim) ? Math.min(n - 1, i) : i % n;
  }

  function sprite(nomAnim: string, cx: number, solY: number, t: number, echelleX = 1): void {
    const frames = requis().anims[nomAnim];
    boucheCourante = null;
    if (!frames || !frames.length) return;
    const idx = indiceImage(nomAnim, t, frames.length);
    const f = frames[idx] as HTMLCanvasElement;
    const kp = kPerso();
    const pts = requis().pointsImages?.[nomAnim];
    if (pts && pts[idx])
      boucheCourante = {
        x: cx - (requis().caseW * kp) / 2 / k + (pts[idx][0] * kp) / k,
        y: solY - (requis().caseH * kp) / k + (pts[idx][1] * kp) / k,
      };
    const taille = Math.round(requis().caseH * kp);
    const tl = Math.round(requis().caseW * kp);
    if (requis().lisse) {
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
    }
    const lx = Math.max(1, Math.round(tl * echelleX));
    ctx.drawImage(f, Math.round(cx * k - lx / 2), Math.round(solY * k - taille), lx, taille);
    ctx.imageSmoothingEnabled = false;

    derniereImage = { f, cx, solY, tl, taille, lisse: !!requis().lisse, tScene: tDessin };
  }

  function zzz(t: number, e: EtatScene): void {
    if (!acteZzz) return;

    const fin = ACTES[ACTES.indexOf(acteZzz) + 1]?.t ?? Infinity;
    if (t < acteZzz.t || t >= fin) return;
    const tete = { x: e.x - e.R.cote * 0.1, y: e.R.sol - e.R.cote };
    for (let n = 0; n * 1.4 < t - acteZzz.t; n++) {
      const age = t - acteZzz.t - n * 1.4;
      if (age > 2.6) continue;
      const u = age / 2.6;
      ctx.globalAlpha = Math.min(1, (1 - u) * 1.7) * 0.8;
      glyphe(GLYPHE_Z, tete.x - u * 8, tete.y - 2 - u * 12, teintes.sourd, 0.55 + u * 0.75);
      ctx.globalAlpha = 1;
    }
  }

  function cadence(nomAnim: string): number {
    const p = perso?.cadence?.[nomAnim];
    return p || CADENCE[nomAnim] || 160;
  }

  function pouvoirDuPerso(): string | null {
    if (!perso) return null;
    if (requis().anims.eclair) return "eclair";
    if (requis().anims.feu) return "feu";
    if (requis().anims.espoir) return "espoir";
    return null;
  }

  function caseU(x: number, y: number, couleur: string): void {
    ctx.fillStyle = couleur;
    ctx.fillRect(Math.round(x * k), Math.round(y * k), Math.round(k), Math.round(k));
  }

  function traitBrise(
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    n: number,
    phase: number,
    couleur: string,
    epais: number,
  ): void {
    const dx = x1 - x0,
      dy = y1 - y0;
    const lg = Math.hypot(dx, dy) || 1;
    const nx = -dy / lg,
      ny = dx / lg;
    let px = x0,
      py = y0;
    for (let i = 1; i <= n; i++) {
      const u = i / n;
      const ec = (1 - u) * 3.2 * Math.sin(phase + i * 2.3) * (i % 2 ? 1 : -0.7);
      const qx = x0 + dx * u + nx * ec,
        qy = y0 + dy * u + ny * ec;
      const pas = Math.ceil(Math.hypot(qx - px, qy - py));
      for (let j = 0; j <= pas; j++) {
        const cx = px + ((qx - px) * j) / pas,
          cy = py + ((qy - py) * j) / pas;
        for (let w = 0; w < epais; w++) caseU(cx + w, cy, couleur);
      }
      px = qx;
      py = qy;
    }
  }

  function lettresFrappees(t: number): Set<number> {
    const n = Math.floor(t * 3.2);
    return new Set([n % MOT.length, (n * 3 + 2) % MOT.length]);
  }

  function foudroyer(t: number, e: EtatScene, R: Reperes, frappees: Set<number>): void {
    const tete = { x: e.x, y: R.sol + e.y - R.cote * 0.85 };
    let i = 0;
    for (const n of frappees) {
      const cible = {
        x: R.motX + n * (LARG_LETTRE + ECART_LETTRE) + LARG_LETTRE / 2,
        y: R.motY + HAUT_LETTRE,
      };
      const ph = t * 9 + i * 2.1;

      traitBrise(tete.x, tete.y, cible.x, cible.y, 6, ph, "#ffe24a", 2);
      traitBrise(tete.x, tete.y, cible.x, cible.y, 6, ph + 0.6, "#ffffff", 1);

      for (let d = -2; d <= 2; d++) {
        caseU(cible.x + d, cible.y, "#fffbe6");
        caseU(cible.x, cible.y + d, "#fffbe6");
      }
      i++;
    }
  }

  function embraser(t: number, e: EtatScene, R: Reperes, frappees: Set<number>): void {
    for (const n of frappees) {
      const x0 = R.motX + n * (LARG_LETTRE + ECART_LETTRE);
      for (let c = 0; c < LARG_LETTRE; c += 2) {
        const h = 4 + 6 * Math.abs(Math.sin(t * 6 + n + c * 0.7));
        for (let j = 0; j < h; j++) {
          const u = j / h;
          const dx = Math.sin(t * 7 + c + j * 0.5) * 1.6 * u;
          const col = u > 0.72 ? "#e23e1c" : u > 0.35 ? "#ffa824" : "#fff6be";
          caseU(x0 + c + dx, R.motY + HAUT_LETTRE - j, col);
        }
      }
    }
  }

  function eclore(t: number, e: EtatScene): Set<number> {
    const n = Math.floor((t - e.acte.t) * 3.4);
    const s = new Set<number>();
    for (let i = 0; i <= n && i < MOT.length; i++) s.add(i);
    return s;
  }

  function irradier(t: number, e: EtatScene, R: Reperes, frappees: Set<number>): void {
    for (const n of frappees) {
      const x0 = R.motX + n * (LARG_LETTRE + ECART_LETTRE);
      for (let c = 1; c < LARG_LETTRE; c += 3) {
        const h = 2 + 3 * Math.abs(Math.sin(t * 3 + n * 1.7 + c));
        for (let j = 0; j < h; j++) {
          const u = j / h;
          caseU(
            x0 + c + Math.sin(t * 2.4 + c) * u,
            R.motY + HAUT_LETTRE - j,
            u > 0.6 ? "#f0d089" : "#fff6d8",
          );
        }
      }
    }
  }

  function souffler(t: number, e: EtatScene, R: Reperes, indice: number, force: number, kind: string): void {
    const chaud: readonly [string, string, string] =
      kind === "feu" ? ["#fff6c8", "#ffa824", "#e23e1c"] : ["#ffffff", "#ffe24a", "#8fd0ff"];
    const bouche = { x: e.x + 1.5, y: R.sol + e.y - R.cote * 0.92 };
    const cible = {
      x: R.motX + indice * (LARG_LETTRE + ECART_LETTRE) + LARG_LETTRE / 2,
      y: R.motY + HAUT_LETTRE * 0.6,
    };
    const N = 26;
    for (let i = 0; i <= N; i++) {
      const u = i / N;
      const px = bouche.x + (cible.x - bouche.x) * u;
      const py = bouche.y + (cible.y - bouche.y) * u;

      const larg = (0.8 + 5.4 * u) * force;
      const onde = Math.sin(t * 13 + i * 0.7) * 1.3 * u;
      for (let d = -larg; d <= larg; d += 0.5) {
        const r = Math.abs(d) / (larg || 1);
        caseU(px + onde + d * 0.35, py + d, r < 0.34 ? chaud[0] : r < 0.72 ? chaud[1] : chaud[2]);
      }
    }
  }

  function braises(c: string, x: number, y: number, t: number, force: number): void {
    const g = motif.glyphes[c] as Glyphe;
    for (let dy = 0; dy < g.length; dy++)
      for (let dx = 0; dx < (g[dy]?.length ?? 0); dx++) {
        if (g[dy]?.[dx] !== "#") continue;

        const v = Math.sin(dx * 2.7 + dy * 1.9 + t * 5.5) * Math.sin(dy * 3.1 - dx * 1.3 + t * 3.7);
        if (v > 0.92 - force * 0.28) caseU(x + dx, y + dy, v > 0.985 ? "#ffcf6e" : "#c4441a");
      }
  }

  function souffleHorizontal(
    t: number,
    R: Reperes,
    museau: Point,
    pointe: number,
    force: number,
    pouvoir: string | null,
  ): void {
    const C: readonly [string, string, string, string] =
      pouvoir === "feu"
        ? ["#fffdf0", "#ffd645", "#ff8a1e", "#d8380f"]
        : pouvoir === "eclair"
          ? ["#ffffff", "#ffe24a", "#bfe8ff", "#6fb8f0"]
          : ["#fffdf0", "#ffe9b0", "#e8c374", "#b88a3d"];
    if (force <= 0.01 || pointe <= museau.x) return;
    const long = pointe - museau.x;
    const N = Math.max(8, Math.round(long * 1.6));
    for (let i = 0; i <= N; i++) {
      const u = i / N;
      const x = museau.x + long * u;

      const ep = force * (0.9 + 6.6 * Math.sin(Math.pow(u, 0.7) * Math.PI * 0.94));
      const ondu = Math.sin(t * 8.5 + u * 6.5) * 1.7 * u + Math.sin(t * 19 - u * 13) * 0.7 * u;
      for (let d = -ep; d <= ep; d += 0.5) {
        const r = Math.abs(d) / (ep || 1);

        if (r > 0.78 + 0.22 * Math.sin(t * 23 + i * 1.9 + d * 1.3)) continue;
        caseU(x, museau.y + ondu + d, r < 0.26 ? C[0] : r < 0.52 ? C[1] : r < 0.8 ? C[2] : C[3]);
      }

      if (i % 7 === 3) {
        const h = (2 + 5 * Math.abs(Math.sin(t * 6 + i))) * force;
        for (let j = 0; j < h; j++)
          caseU(
            x + Math.sin(t * 9 + j * 0.8 + i) * j * 0.32,
            museau.y + ondu - ep * 0.7 - j,
            j > h * 0.6 ? C[3] : C[1],
          );
      }
    }

    for (let n = 0; n < 10; n++) {
      const a = (t * 1.7 + n * 0.37) % 1;
      caseU(
        museau.x + long * (0.55 + a * 0.6),
        museau.y + Math.sin(t * 5 + n * 2.3) * (3 + a * 7),
        a > 0.6 ? C[3] : C[1],
      );
    }
  }

  function moitie(lignes: Glyphe, haut: boolean): Glyphe {
    const L = lignes[0]?.length ?? 0;
    return lignes.map((l, y) =>
      [...l]
        .map((ch, x) => {
          const dessus = y < 8 - 0.55 * (x - L / 2);
          return ch === "#" && dessus === haut ? "#" : ".";
        })
        .join(""),
    );
  }

  function trancher(c: string, n: number, x: number, t: number, R: Reperes): boolean {
    const coupe = acteTranche as Acte;
    const tCoupe = coupe.t + (coupe.tranche?.delai || 0.3);
    if (t < tCoupe) return false;
    const tRecolle = acteRecolle ? acteRecolle.t : Infinity;
    if (t >= tRecolle) {
      const u = Math.min(1, (t - tRecolle) / CHUTE_LETTRE);
      if (u >= 1) return false;
      lettre(c, x, R.motY - (1 - facilite(u)) * (HAUT_LETTRE + 6));
      return true;
    }
    logement(x, R.motY);
    const dt = t - tCoupe;
    const g = motif.glyphes[c] as Glyphe;
    for (const haut of [true, false]) {
      const lignes = moitie(g, haut);
      const rangs = lignes.map((l, i) => (l.includes("#") ? i : -1)).filter((i) => i >= 0);
      if (!rangs.length) continue;
      const bas = Math.max(...rangs);

      const glisse = haut ? Math.min(1, dt / 0.15) : 0;
      const chute = Math.max(0, dt - (haut ? 0.15 : 0.05));
      const sol = R.sol - R.motY - bas - 1;
      const dy = Math.min(sol, 30 * chute * chute) + glisse * 0.8;
      const dx = (haut ? 1.2 * glisse + 2.2 : -1.2) * Math.min(1, dt * 2);
      glyphe(lignes, x + dx, R.motY + dy, teintes.encre);
      if (motif.eclats) glyphe(moitie(motif.eclats[c] as Glyphe, haut), x + dx, R.motY + dy, teintes.or);
    }

    if (dt < 0.16) {
      const L = LARG_LETTRE;
      for (let xx = -1; xx <= L; xx += 0.5) {
        const yy = 8 - 0.55 * (xx - L / 2);
        caseU(x + xx, R.motY + yy, dt < 0.08 ? "#fff6f0" : "#ff3b2f");
      }
    }
    return true;
  }

  function cibleDe(a: Acte): number {
    return (((a.tir!.cible + tour) % MOT.length) + MOT.length) % MOT.length;
  }

  function caseTrou(c: string, gx: number, gy: number): [number, number] {
    const g = motif.glyphes[c] as Glyphe;
    let best: [number, number] = [gx, gy],
      d = 1e9;
    g.forEach((l, y) =>
      [...l].forEach((ch, x) => {
        const dd = (x - gx) ** 2 + (y - gy) ** 2;
        if (ch === "#" && dd < d) {
          d = dd;
          best = [x, y];
        }
      }),
    );
    return best;
  }

  function trous(n: number, c: string, x: number, y: number, t: number): void {
    let taille = 1;
    if (acteRebouche && t >= acteRebouche.t) taille = Math.max(0, 1 - (t - acteRebouche.t) / 1.2);
    if (taille <= 0) return;
    const g = motif.glyphes[c] as Glyphe;
    const plein = (gx: number, gy: number): boolean => g[gy]?.[gx] === "#";
    for (const a of tirs) {
      const tir = a.tir as NonNullable<Acte["tir"]>;
      if (cibleDe(a) !== n || t < a.t + 0.07) continue;
      const [gx, gy] = caseTrou(c, tir.trou[0], tir.trou[1]);

      if (taille > 0.6) {
        ctx.globalAlpha = 0.85;
        const bord: ReadonlyArray<readonly [number, number]> = [
          [-1, -1],
          [1, -1],
          [-1, 1],
          [1, 1],
          [0, -2],
          [2, 0],
          [0, 2],
          [-2, 0],
        ];
        for (const [dx, dy] of bord) if (plein(gx + dx, gy + dy)) caseU(x + gx + dx, y + gy + dy, "#9c8a78");
        ctx.globalAlpha = 1;
      }

      ctx.globalCompositeOperation = "destination-out";
      const croix: ReadonlyArray<readonly [number, number]> =
        taille > 0.35
          ? [
              [0, 0],
              [1, 0],
              [-1, 0],
              [0, 1],
              [0, -1],
            ]
          : [[0, 0]];
      for (const [dx, dy] of croix) caseU(x + gx + dx, y + gy + dy, "#000");
      ctx.globalCompositeOperation = "source-over";
    }
  }

  function effetsTir(t: number, e: EtatScene, R: Reperes): void {
    const bouche = boucheCourante || { x: e.x + R.larg * 0.44, y: R.sol + e.y - R.cote * 0.55 };
    for (const a of tirs) {
      const age = t - a.t;
      if (age < 0 || age > 1.2) continue;
      const m = cibleDe(a);
      const tir = a.tir as NonNullable<Acte["tir"]>;
      const [gx, gy] = caseTrou(MOT[m] ?? "", tir.trou[0], tir.trou[1]);
      const impact = { x: R.motX + m * (LARG_LETTRE + ECART_LETTRE) + gx + 0.5, y: R.motY + gy + 0.5 };
      const dir = Math.atan2(impact.y - bouche.y, impact.x - bouche.x);
      if (age < 0.09) {
        const r = 1 + 2.6 * (1 - age / 0.09);
        for (let d = -r; d <= r; d += 0.5) {
          caseU(bouche.x + Math.cos(dir) * (d + r), bouche.y + Math.sin(dir) * (d + r), "#ffd23f");
          caseU(bouche.x - Math.sin(dir) * d * 0.6, bouche.y + Math.cos(dir) * d * 0.6, "#ffb02e");
        }
        caseU(bouche.x, bouche.y, "#fff6d0");
      }
      if (age < 0.07) {
        const lg = Math.hypot(impact.x - bouche.x, impact.y - bouche.y);
        for (let i = 0; i <= lg; i += 0.8) {
          const u = i / lg;
          caseU(bouche.x + (impact.x - bouche.x) * u, bouche.y + (impact.y - bouche.y) * u, "#fff1b0");
        }
      }
      if (age >= 0.07 && age < 0.8) {
        const u = age - 0.07;
        for (let q = 0; q < 6; q++) {
          const vx = Math.cos(q * 1.05 + m) * 9,
            vy = -6 - (q % 3) * 3;
          caseU(impact.x + vx * u, impact.y + vy * u + 22 * u * u, q % 2 ? teintes.encre : teintes.or);
        }
      }
    }

    const dernier = tirs[tirs.length - 1];
    const fin = acteRengaine ? acteRengaine.t : Infinity;
    if (boucheCourante && dernier && t > dernier.t + 0.2 && t < fin) {
      ctx.globalAlpha = 0.5;
      for (let q = 0; q < 5; q++) {
        const age = ((t - dernier.t) * 0.8 + q * 0.2) % 1;
        caseU(bouche.x + Math.sin(age * 5 + q) * 1.2, bouche.y - age * 7, age > 0.5 ? "#b3aca2" : "#7d746a");
      }
      ctx.globalAlpha = 1;
    }
  }

  function aura(t: number, e: EtatScene, R: Reperes, force: number): void {
    const cx = e.x,
      cy = R.sol + e.y - R.cote * 0.45;
    for (let n = 0; n < 5; n++) {
      const ph = t * 3.4 + n * 1.256;
      const rx = R.larg * (0.55 + 0.12 * Math.sin(t * 5 + n)) * force;
      const ry = rx * 0.62;
      let px = cx + Math.cos(ph) * rx,
        py = cy + Math.sin(ph) * ry;
      for (let i = 1; i <= 5; i++) {
        const a = ph + i * 0.34;
        const qx = cx + Math.cos(a) * rx + Math.sin(t * 27 + i * 3.1) * 1.4;
        const qy = cy + Math.sin(a) * ry + Math.cos(t * 31 + i * 2.3) * 1.1;
        const pas = Math.ceil(Math.hypot(qx - px, qy - py));
        for (let j = 0; j <= pas; j++)
          caseU(px + ((qx - px) * j) / pas, py + ((qy - py) * j) / pas, i % 2 ? "#ffe24a" : "#ffffff");
        px = qx;
        py = qy;
      }
    }
  }

  function fumee(t: number, R: Reperes, indice: number): void {
    const x0 = R.motX + indice * (LARG_LETTRE + ECART_LETTRE) + LARG_LETTRE / 2;
    ctx.globalAlpha = 0.55;
    for (let n = 0; n < 7; n++) {
      const age = (t * 0.75 + n * 0.3) % 1;
      const y = R.motY - 1 - age * 16;
      const dx = Math.sin(age * 4.2 + n * 2.1) * (1.5 + age * 6);

      const r = 1.4 + age * 3.2;
      for (let a = -r; a <= r; a += 0.6)
        for (let b = -r; b <= r; b += 0.6)
          if (a * a + b * b <= r * r) caseU(x0 + dx + a, y + b, age > 0.6 ? "#b3aca2" : "#7d746a");
    }
    ctx.globalAlpha = 1;
  }

  function charger(t: number, e: EtatScene, R: Reperes, u: number): void {
    const cx = e.x,
      cy = R.sol + e.y - R.cote * 0.5;
    for (let n = 0; n < 9; n++) {
      const ang = n * 0.7 + t * 2.2;
      const d = (1 - ((t * 1.6 + n * 0.31) % 1)) * R.cote * 1.5 * (0.4 + u);
      const px = cx + Math.cos(ang) * d,
        py = cy + Math.sin(ang) * d * 0.8;
      caseU(px, py, n % 2 ? "#ffe24a" : "#ffffff");
      caseU(px + 1, py, "#ffe24a");
    }
  }

  function tonnerre(t: number, e: EtatScene, R: Reperes, indice: number, u: number): void {
    const x = R.motX + indice * (LARG_LETTRE + ECART_LETTRE) + LARG_LETTRE / 2;
    const bas = R.motY + HAUT_LETTRE * 0.5;
    const ph = Math.floor(t * 24);

    const couches: Array<[number, string]> = [
      [1.9, "#bfe8ff"],
      [1.0, "#ffe24a"],
      [0.45, "#ffffff"],
    ];
    for (const [ep, col] of couches) {
      let px = x,
        py = -2;
      for (let i = 1; i <= 9; i++) {
        const v = i / 9;
        const qx = x + Math.sin(ph * 1.7 + i * 2.3) * 3.4 * (1 - v * 0.6);
        const qy = -2 + (bas + 2) * v;
        const pas = Math.ceil(Math.hypot(qx - px, qy - py));
        for (let j = 0; j <= pas; j++) {
          const ax = px + ((qx - px) * j) / pas;
          const ay = py + ((qy - py) * j) / pas;
          for (let w = -ep * u; w <= ep * u; w += 0.5) caseU(ax + w, ay, col);
        }
        px = qx;
        py = qy;
      }
    }
  }

  function eclatBlanc(alpha: number): void {
    ctx.globalAlpha = alpha;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, largeur, hauteur);
    ctx.globalAlpha = 1;
  }

  function dessiner(t: number): void {
    ctx.clearRect(0, 0, largeur, hauteur);
    if (!perso) return;
    tDessin = t;

    {
      let i = 0;
      while (i + 1 < ACTES.length && ACTES[i + 1]!.t <= t) i++;
      const voulu = ACTES[i] && "perso" in ACTES[i]! ? (ACTES[i]!.perso ?? null) : persoScene;
      if (voulu !== persoVoulu) {
        const tr = ACTES[i] && (ACTES[i]!.pivot ? "pivot" : ACTES[i]!.fondu ? "fondu" : null);
        if (tr && derniereImage && t - derniereImage.tScene >= 0 && t - derniereImage.tScene < 0.25)
          pivot = { img: derniereImage, t0: t, type: tr };
        persoVoulu = voulu;
        appliquerPerso();
      }
    }
    const e = etat(t);
    const R = e.R;
    const volee = lettreVolee(t, e);

    const pouvoir = e.acte.eclat ? pouvoirDuPerso() : null;

    const frappees = !pouvoir ? null : pouvoir === "espoir" ? eclore(t, e) : lettresFrappees(t);

    const souffleActif = e.acte.souffle ? pouvoirDuPerso() : null;

    function electriseDe(n: number): number {
      let chaud = 0;
      for (const a of ACTES) {
        if (a.cible !== n || t < a.t) continue;
        if (a.tonnerre) chaud = Math.max(chaud, 1 - (t - a.t) / 1.6);
        else if (a.residu) chaud = Math.max(chaud, 0.45 - (t - a.t) / 3);
      }
      return Math.max(0, chaud);
    }

    const pointe = pointeDuSouffle(t, R);

    const scenarioBrule = pouvoirDuPerso() === "feu" && ACTES.some((a) => a.souffle || a.balaye);

    function atteinte(n: number): number {
      if (pointe <= -1e8) return 0;
      const xg = R.motX + n * (LARG_LETTRE + ECART_LETTRE);
      return Math.max(0, Math.min(1, (pointe - xg) / (LARG_LETTRE * 0.75)));
    }
    function brulureDe(n: number): number {
      if (!scenarioBrule) return 0;
      if (pointe > -1e8) return atteinte(n);
      if (e.acte.cible !== n) return 0;
      return e.acte.souffle ? Math.min(1, (t - e.acte.t) / 1.9) : pouvoirDuPerso() ? 1 : 0;
    }

    MOT.forEach((c, n) => {
      let x = R.motX + n * (LARG_LETTRE + ECART_LETTRE);
      if (n === MOT.length - 1 && volee) {
        logement(x, R.motY);
        return;
      }
      if (acteTranche && n === cibleCoupe && trancher(c, n, x, t, R)) return;

      for (const a of tirs)
        if (cibleDe(a) === n && t >= a.t + 0.07 && t < a.t + 0.27) x += Math.floor(t * 30) % 2 ? 1 : -1;
      let y = R.motY,
        alpha = 1;
      if (premier) {
        const t0 = n * DECALAGE_LETTRE;
        if (t < t0) return;
        const u = Math.min(1, (t - t0) / CHUTE_LETTRE);
        y = R.motY - (1 - facilite(u)) * (HAUT_LETTRE + 6);
        alpha = Math.min(1, u * 2.2);
      }

      const doree = !scenarioBrule && !!pouvoirDuPerso() && atteinte(n) > 0.25;
      const prise = doree || (frappees && frappees.has(n));

      if (prise && pouvoir !== "espoir") y += (Math.floor(t * 22) + n) % 2 ? -1 : 1;
      const brulure = brulureDe(n);
      const cuite = brulure > 0.08;

      const zap = electriseDe(n);
      if (zap > 0.02) {
        x += Math.round(Math.sin(t * 47 + n) * 2 * zap);
        y += Math.round(Math.cos(t * 53) * 2 * zap);
      }
      ctx.globalAlpha = alpha;
      lettre(
        c,
        x,
        y,
        cuite ? "#241d18" : zap > 0.55 ? "#fff0b4" : zap > 0.12 ? "#ffe24a" : prise ? teintes.or : null,
        cuite || zap > 0.12,
      );
      if (cuite) braises(c, x, y, t, 1 - brulure * 0.55);
      if (zap > 0.05) braises(c, x, y, t * 2.4, 0.35 + zap * 0.5);
      ctx.globalAlpha = 1;
      trous(n, c, x, y, t);
    });

    suffixe(R, t);

    zzz(t, e);
    if (volee) {
      const derniere = MOT[MOT.length - 1] ?? "";
      glyphe(motif.glyphes[derniere] as Glyphe, volee.x, volee.y, teintes.encre);
      if (motif.eclats) glyphe(motif.eclats[derniere] as Glyphe, volee.x, volee.y, teintes.or);
    }
    if (e.acte.cabre) {
      const p = e.acte.souffle ? e.acte.cabre * Math.min(1, e.u * 4) : e.acte.cabre * e.u;
      spriteIncline(anim(animDeLActe(e)), e.x, R.sol + e.y, t - e.acte.t, p);
    } else {
      const u = pivot ? (t - pivot.t0) / DUREE_PIVOT : 1;
      if (pivot && pivot.type === "fondu" && u >= 0 && u < 1) {
        const p = pivot.img;
        ctx.globalAlpha = 1 - u;
        ctx.imageSmoothingEnabled = p.lisse;
        ctx.drawImage(
          p.f,
          Math.round(p.cx * k - p.tl / 2),
          Math.round(p.solY * k - p.taille),
          p.tl,
          p.taille,
        );
        ctx.globalAlpha = u;
        sprite(anim(animDeLActe(e)), e.x, R.sol + e.y, t - e.acte.t);
        ctx.globalAlpha = 1;
      } else if (pivot && pivot.type === "pivot" && u >= 0 && u < 0.5) {
        const p = pivot.img,
          lx = Math.max(1, Math.round(p.tl * (1 - 2 * u)));
        ctx.imageSmoothingEnabled = p.lisse;
        ctx.drawImage(p.f, Math.round(p.cx * k - lx / 2), Math.round(p.solY * k - p.taille), lx, p.taille);
        ctx.imageSmoothingEnabled = false;
      } else {
        if (pivot && (u >= 1 || u < 0)) pivot = null;
        sprite(
          anim(animDeLActe(e)),
          e.x,
          R.sol + e.y,
          t - e.acte.t,
          pivot && pivot.type === "pivot" ? Math.max(0.02, 2 * u - 1) : 1,
        );
      }
    }

    if (souffleActif) {
      const f = Math.min(1, e.u * 5) * Math.min(1, (1 - e.u) * 4 + 0.35);
      souffler(t, e, R, e.acte.cible ?? 0, f, souffleActif);
    }
    if (e.acte.balaye && pouvoirDuPerso()) {
      const museau = { x: e.x + R.larg * 0.4, y: R.sol + e.y - R.cote * 0.58 };
      const f = Math.min(1, e.u * 6) * Math.min(1, (1 - e.u) * 5 + 0.3);
      souffleHorizontal(t, R, museau, pointe, f, pouvoirDuPerso());
    }
    if (e.acte.fumee) {
      if (pointe > -1e8)
        MOT.forEach((_, n) => {
          if (brulureDe(n) > 0.5 && n % 2 === 0) fumee(t, R, n);
        });
      else fumee(t, R, e.acte.cible ?? 0);
    }
    if (tirs.length) effetsTir(t, e, R);
    if (e.acte.charge) charger(t, e, R, e.u);
    if (e.acte.aura) aura(t, e, R, Math.min(1, 0.5 + e.u));
    if (e.acte.tonnerre) {
      const age = t - e.acte.t;
      if (age < 0.55) tonnerre(t, e, R, e.acte.cible ?? 0, Math.min(1, 1 - age / 0.55 + 0.3));

      if (age < 0.16) eclatBlanc(0.55 * (1 - age / 0.16));
    }

    if (frappees && pouvoir === "eclair") foudroyer(t, e, R, frappees);
    else if (frappees && pouvoir === "feu") embraser(t, e, R, frappees);
    else if (frappees && pouvoir === "espoir") irradier(t, e, R, frappees);
  }

  function suffixe(R: Reperes, t: number): void {
    if (!SUFFIXE) return;

    const fin = MOT.length * DECALAGE_LETTRE + CHUTE_LETTRE;
    const a = premier ? Math.max(0, Math.min(1, (t - fin) / 0.5)) : 1;
    if (a <= 0) return;
    ctx.save();
    ctx.globalAlpha = a;
    ctx.imageSmoothingEnabled = true;
    ctx.font = policeSuffixe((H_SUFFIXE / 0.5) * k);
    ctx.textBaseline = "alphabetic";
    ctx.fillStyle = teintes.or;
    ctx.fillText(SUFFIXE, (R.motX + LARG_MOT + ECART_SUFFIXE) * k, (R.motY + HAUT_LETTRE) * k);
    ctx.restore();
  }

  function fige(): void {
    ctx.clearRect(0, 0, largeur, hauteur);
    if (!perso) return;
    const R = reperes();
    MOT.forEach((c, n) => lettre(c, R.motX + n * (LARG_LETTRE + ECART_LETTRE), R.motY));

    suffixe(R, 99);
    sprite(anim(["idle"]), R.sousS, R.sol, 0);
  }

  function annoncerFin(): void {
    if (finAnnoncee || tenirCourant || !auFini) return;
    finAnnoncee = true;
    auFini(nomCourant);
  }

  let compteur = 0;
  function image(maintenant: number): void {
    boucle = requestAnimationFrame(image);
    if (enPause) return;
    if (compteur++ % 60 === 0) relireTeintes();
    const t = maintenant / 1000 - depart;
    if (t >= DUREE && enSortie) {
      enSortie = false;
      const n = ensuite;
      ensuite = null;
      if (n) jouer(n);
      dessiner(0);
      return;
    }
    if (t >= DUREE) {
      premier = false;
      annoncerFin();

      if (boucleCourante) {
        tour++;
        origineX = null;
        depart = maintenant / 1000;
        finAnnoncee = false;
        dessiner(0);
        return;
      }
    }
    dessiner(t);
  }

  function jouer(nom: string, opts: { intro?: boolean } = {}): void {
    if (!SCENARIOS[nom]) return;

    if (enSortie) {
      ensuite = nom;
      return;
    }
    const actuelle = SCENARIOS[nomCourant];
    if (actuelle && actuelle.sortie && nom !== nomCourant && perso && !sobre.matches) {
      const t = enPause ? tPause - depart : performance.now() / 1000 - depart;
      origineX = etat(Math.max(0, t)).x;
      poserScenario(nomCourant, nomCourant, nom);
      enSortie = true;
      ensuite = nom;
      premier = false;
      finAnnoncee = true;
      depart = performance.now() / 1000;
      return;
    }

    if (perso && ACTES.length) {
      const t = enPause ? tPause - depart : performance.now() / 1000 - depart;
      origineX = etat(Math.max(0, t)).x;
    }
    poserScenario(nom);
    premier = opts.intro === true;
    depart = performance.now() / 1000;
    tPause = depart;

    if (sobre.matches) {
      fige();
      annoncerFin();
    }
  }

  const surResize = () => {
    redimensionner();
    if (sobre.matches) fige();
  };
  addEventListener("resize", surResize);

  redimensionner();
  relireTeintes();
  let vivant = true;
  const pret = chargerPerso(base, nomPerso, options.donnees)
    .then((p) => {
      if (!vivant) return;
      perso = p;
      persoPrincipal = p;
      for (const nomA of p.associes || [])
        chargerPerso(base, nomA)
          .then((q) => {
            persosScene.set(nomA, q);
            appliquerPerso();
          })
          .catch((err) => journal.avertir(`[accueil] ${nomA} illisible : ${String(err)}`));
      appliquerPerso();

      if (p.grandir && p.grandir !== 1) {
        echellePerso = Math.min(1.6, echellePerso * p.grandir);
        ECART_SOL = Math.round(COTE_NOMINAL * echellePerso) + 2;
        HAUT_SCENE = HAUT_LETTRE + ECART_SOL;
        redimensionner();
      }

      poserScenario(nomCourant);
      depart = performance.now() / 1000;
      if (sobre.matches) {
        fige();
        annoncerFin();
      } else boucle = requestAnimationFrame(image);
    })
    .catch((err) => {
      hote.classList.add("accueil-erreur");
      hote.setAttribute("data-erreur", `mascotte « ${nomPerso} » illisible : ${err}`);
    });

  return {
    choix: { perso: nomPerso, motif: motif.etiquette, scenario: scenario?.etiquette },

    get duree() {
      return DUREE;
    },

    get scenario() {
      return enSortie ? ensuite : nomCourant;
    },

    pret,
    jouer,
    pause() {
      enPause = true;
      tPause = performance.now() / 1000;
    },
    reprendre() {
      if (!enPause) return;
      depart += performance.now() / 1000 - tPause;
      enPause = false;
    },
    rejouer() {
      premier = true;
      depart = performance.now() / 1000;
      finAnnoncee = false;
    },

    aller(t, avecIntro = true) {
      premier = avecIntro;
      enPause = true;
      tPause = performance.now() / 1000;
      depart = tPause - t;
      dessiner(t);
    },
    detruire() {
      vivant = false;
      if (boucle !== null) cancelAnimationFrame(boucle);
      removeEventListener("resize", surResize);
      canevas.remove();
      legende?.remove();
    },
  };
}

const CADENCE: Record<string, number> = {
  eclair: 90,
  feu: 120,

  espoir: 150,
  idle: 200,
  wave: 130,
  jump: 110,
  review: 170,
  waiting: 190,
  running: 110,
  failed: 160,
  "run-left": 110,
  "run-right": 110,
  dance: 120,
  sleep: 320,
  cheer: 120,
  wake: 150,
  bounce: 120,
  look: 220,
  headbang: 65,
  vol: 110,
};
