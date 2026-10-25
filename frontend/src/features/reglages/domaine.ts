// SPDX-License-Identifier: MIT
/** frontend/src/features/reglages/domaine.ts — domaine des réglages injecté dans ses composants SFC : surfaces des familles portées plus les clés de la racine historique (app.js) que leurs gabarits lisent. */
import { inject, onMounted, provide } from "vue";
import type { InjectionKey, ShallowUnwrapRef } from "vue";

import { journal } from "../../platform/journal";
import type { SurfaceEchantillonnage } from "./echantillonnage";
import type { SurfaceReglages } from "./reglages";
import type { ConfigChat, ReglagesApp, UtilisateurReglages } from "./types";

export interface OutilCategorie {
  name: string;
  title?: string;
  description?: string;
  read_only?: boolean;
}
export interface CategorieOutilsRacine {
  name: string;
  label: string;
  icon: string;
  color: string;
  hidden?: boolean;
  default_on?: boolean;
  tools?: OutilCategorie[];
  [cle: string]: unknown;
}
export interface ServeurManifeste {
  name: string;
  description?: string;
  type?: string;
  default_on?: boolean;
}
export interface CibleBureau {
  name: string;
  os: string;
}
export interface EtatImage {
  tool_enabled?: boolean;
  enhance_enabled?: boolean;
  keep_per_user?: number;
  stored?: number;
  [cle: string]: unknown;
}
export interface AccueilConfig {
  type?: string;
  image_b64?: string;
  icon?: string;
  [cle: string]: unknown;
}
export interface FonctionsServeur {
  agents?: boolean;
  voice_stt?: boolean;
  voice_tts?: boolean;
  [cle: string]: unknown;
}

/** Clés de la racine (app.js, chat, images, studio, mascotte) lues par les gabarits des réglages. */
export interface RacineReglages {
  settings: ReglagesApp;
  config: ConfigChat;
  user: UtilisateurReglages;
  features: FonctionsServeur;
  fmtPropVal(valeur: unknown): string;
  selectedConnector: string;
  showMcpPanel: boolean;
  localTools: Record<string, boolean>;
  openToolCats: Record<string, boolean>;
  mcpUserCategories: CategorieOutilsRacine[];
  manifestServers: ServeurManifeste[];
  manifestTools: Record<string, boolean>;
  catToolsCount(cat: CategorieOutilsRacine): number;
  mcpCategoryBgClass(cat: CategorieOutilsRacine): string;
  mcpCategoryToggleClass(cat: CategorieOutilsRacine): string;
  toggleToolCatOpen(nom: string): void;
  openToolInfo(outil: OutilCategorie, cat: CategorieOutilsRacine): void;
  isToolOn(nom: string): boolean;
  toggleTool(nom: string): void;
  resetCatTools(cat: CategorieOutilsRacine): void;
  loadMcpUserCategories(): unknown;
  openSkillsTab(): unknown;
  ouvrirAssistant(id: string, pre?: Record<string, string>): void;
  openAxModal(): unknown;
  studioTargets: CibleBureau[];
  desktopActiveTarget: string;
  setDesktopActiveTarget(nom: string): void;
  ensureDesktopTargets(): unknown;
  notifyOSSupported: boolean;
  notifyOSSecure: boolean;
  notifyOSEnabled: boolean;
  toggleNotifyOS(): unknown;
  welcomeConfig: AccueilConfig | null;
  logoApp: string;
  mascotteId: string;
  mascottesOffertes: boolean;
  MASCOTTES: { id: string; label: string }[];
  mouvementReduit: boolean;
  imageStatus: EtatImage | null;
  imageMaxN: number;
  imageIsPortrait(ratio: string): boolean;
  imageFlipRatio(ratio: string): string;
  imageBaseRatio(ratio: string): string;
  imageBaseRatios: readonly string[];
  imageSides: readonly number[];
  imageFixedSizes: readonly string[];
  setPrefRatio(ratio: string): void;
  flipPrefRatio(): void;
  ratioBox(ratio: string): Record<string, string>;
  openImageGallery(mode?: string): unknown;
}

/** Surface vue des gabarits : refs déballées, fonctions internes (`_…`) retirées. */
type Surface<T> = ShallowUnwrapRef<Omit<T, `_${string}`>>;

export type DomaineReglages = Surface<SurfaceEchantillonnage> & Surface<SurfaceReglages> & RacineReglages;

export const CLE_REGLAGES: InjectionKey<DomaineReglages> = Symbol("elpis:reglages");

/** Clés de la racine, complètes à la compilation ; `showSamplingPanel` témoigne de la surface d'échantillonnage. */
const CLES: Readonly<Record<keyof RacineReglages | "showSamplingPanel", true>> = {
  settings: true,
  config: true,
  user: true,
  features: true,
  fmtPropVal: true,
  selectedConnector: true,
  showMcpPanel: true,
  localTools: true,
  openToolCats: true,
  mcpUserCategories: true,
  manifestServers: true,
  manifestTools: true,
  catToolsCount: true,
  mcpCategoryBgClass: true,
  mcpCategoryToggleClass: true,
  toggleToolCatOpen: true,
  openToolInfo: true,
  isToolOn: true,
  toggleTool: true,
  resetCatTools: true,
  loadMcpUserCategories: true,
  openSkillsTab: true,
  ouvrirAssistant: true,
  openAxModal: true,
  studioTargets: true,
  desktopActiveTarget: true,
  setDesktopActiveTarget: true,
  ensureDesktopTargets: true,
  notifyOSSupported: true,
  notifyOSSecure: true,
  notifyOSEnabled: true,
  toggleNotifyOS: true,
  welcomeConfig: true,
  logoApp: true,
  mascotteId: true,
  mascottesOffertes: true,
  MASCOTTES: true,
  mouvementReduit: true,
  imageStatus: true,
  imageMaxN: true,
  imageIsPortrait: true,
  imageFlipRatio: true,
  imageBaseRatio: true,
  imageBaseRatios: true,
  imageSides: true,
  imageFixedSizes: true,
  setPrefRatio: true,
  flipPrefRatio: true,
  ratioBox: true,
  openImageGallery: true,
  showSamplingPanel: true,
};

/** Lit le domaine fourni par un ancêtre ; son absence est une erreur de montage. */
export function domaineReglages(): DomaineReglages {
  const valeur = inject(CLE_REGLAGES, null);
  if (valeur === null) throw new Error("domaine des réglages non fourni");
  return valeur;
}

export function clesAbsentesReglages(racine: object): string[] {
  return Object.keys(CLES).filter((k) => !(k in racine));
}

/** Fournit le domaine depuis la racine historique ; à appeler dans son `setup`. */
export function fournirDomaineReglages(racine: object): void {
  provide(CLE_REGLAGES, racine as DomaineReglages);
  onMounted(() => {
    const absentes = clesAbsentesReglages(racine);
    if (absentes.length) journal.avertir(`[réglages] domaine : absent de la racine : ${absentes.join(", ")}`);
  });
}
