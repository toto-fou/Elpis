// SPDX-License-Identifier: MIT
/** frontend/src/features/chat/modales/domaine.ts — domaine injecté des fenêtres du chat et des fenêtres communes (transfert, détails d'exécution) : surface du chat portée plus les clés de la racine historique (app.js, console) que leurs gabarits lisent. */
import { inject, onMounted, provide } from "vue";
import type { InjectionKey } from "vue";

import { journal } from "../../../platform/journal";
import type { SurfaceChat } from "../coeur/chat";
import type { MessageChat } from "../coeur/types";

export interface ModaleTransfert {
  active: boolean;
  title: string;
  filename?: string;
  mode?: string;
  error?: string;
  done?: boolean;
  waiting?: boolean;
  waitLabel?: string;
  elapsed: number;
  indeterminate?: boolean;
  percent: number;
  loaded: number;
  total?: number;
}

/** Clés de la racine historique lues par les fenêtres communes (chat et console). */
export interface RacineCommune {
  readonly transferModal: ModaleTransfert;
  closeTransferModal(): void;
  fmtBytes(n: number): string;
  fmtElapsed(sec: number): string;
}

export type DomaineModalesCommunes = RacineCommune &
  Pick<
    SurfaceChat,
    | "runDetails"
    | "closeRunDetails"
    | "showRunDetails"
    | "toggleRunEvent"
    | "runDuration"
    | "runEventLabel"
    | "runEventMeta"
    | "runEventState"
    | "runClock"
    | "runExportHref"
    | "runInput"
    | "runOutput"
    | "runTokensTitle"
  >;

export interface InfoApplication {
  name: string;
  version: string;
  teamName: string;
  engine: string;
  description: string;
  iconType: string;
  logoBb64?: string;
  logoUrl?: string;
}

export interface FamilleOpenCode {
  name: string;
  label?: string;
}

export interface SiteAx {
  site: string;
  elements?: number;
  paths?: number;
  transitions?: number;
}

/** Clés de la racine historique (app.js, app-settings.js, app-admin.js) lues par les petites fenêtres du chat. */
export interface RacineDivers {
  showInfoModal: boolean;
  readonly appInfo: InfoApplication;
  readonly logoApp: string;
  showOpenCodeModal: boolean;
  openCodePlatform: string;
  readonly openCodeCopied: string;
  readonly openCodeFamilies: readonly FamilleOpenCode[];
  readonly openCodeCommand: string;
  readonly openCodeSyncCommand: string;
  copyOpenCodeCommand(kind: string): unknown;
  downloadOpenCodeBundle(): unknown;
  opencodeFamilyOn(name: string): boolean;
  toggleOpencodeFamily(name: string): unknown;
  readonly features: { readonly opencode?: boolean };
  showHelpModal: boolean;
  readonly helpDoc: string;
  readonly isLoadingReadme: boolean;
  readonly readmeContent: string;
  helpBodyRef: unknown;
  switchHelpDoc(doc: string): unknown;
  imgZoom: string | null;
  showAxModal: boolean;
  readonly axSites: readonly SiteAx[];
  readonly axExpanded: Readonly<Record<string, boolean>>;
  readonly axTrees: Readonly<Record<string, string>>;
  readonly axTreeLoading: Readonly<Record<string, boolean>>;
  readonly axLoading: boolean;
  loadAxSites(): unknown;
  toggleAxSite(site: string): unknown;
  goToAdmin(tab?: string): unknown;
  readonly user: { readonly role?: string } | null;
  readonly currentChatId: string | null;
}

export type DomaineModalesChat = DomaineModalesCommunes &
  RacineDivers &
  Pick<
    SurfaceChat,
    | "templateFill"
    | "cancelTemplateFill"
    | "submitTemplateFill"
    | "templateFillKeydown"
    | "fmtPropVal"
    | "taskModalStep"
    | "closeTaskModal"
    | "taskModalRun"
    | "fmtTokens"
    | "fmtToolMs"
    | "toolInfo"
    | "closeToolInfo"
    | "assistantForm"
    | "lancerAssistantForm"
    | "renderMarkdown"
    | "handleMarkdownClick"
    | "imageViewer"
    | "imageViewerCurrent"
    | "imageViewerInfo"
    | "imageViewerPrompt"
    | "imageViewerNamePrompt"
    | "imageViewerStep"
    | "imageViewerKeydown"
    | "closeImageViewer"
    | "imageCanEdit"
    | "editGeneratedImage"
    | "downloadImage"
    | "copyImageText"
    | "openImageChat"
    | "removeImage"
    | "imageGallery"
    | "closeImageGallery"
    | "imageGalleryKeydown"
    | "setGalleryFilter"
    | "onGalleryScroll"
    | "imageCellState"
    | "openGalleryItem"
    | "markImageExpired"
  > & {
    showModelProps: boolean;
    readonly modelPropsLoading: boolean;
    readonly modelPropsData: unknown;
    readonly taskModal: { idx: number; ri: number; cid: string | null; snap: unknown } | null;
    readonly messages: readonly MessageChat[];
  };

export const CLE_MODALES: InjectionKey<DomaineModalesChat> = Symbol("elpis:chat:modales");

const CLES_COMMUNES: Readonly<Record<keyof DomaineModalesCommunes, true>> = {
  transferModal: true,
  closeTransferModal: true,
  fmtBytes: true,
  fmtElapsed: true,
  runDetails: true,
  closeRunDetails: true,
  showRunDetails: true,
  toggleRunEvent: true,
  runDuration: true,
  runEventLabel: true,
  runEventMeta: true,
  runEventState: true,
  runClock: true,
  runExportHref: true,
  runInput: true,
  runOutput: true,
  runTokensTitle: true,
};

const CLES_CHAT: Readonly<Record<Exclude<keyof DomaineModalesChat, keyof DomaineModalesCommunes>, true>> = {
  templateFill: true,
  cancelTemplateFill: true,
  submitTemplateFill: true,
  templateFillKeydown: true,
  fmtPropVal: true,
  taskModalStep: true,
  closeTaskModal: true,
  taskModalRun: true,
  fmtTokens: true,
  fmtToolMs: true,
  toolInfo: true,
  closeToolInfo: true,
  assistantForm: true,
  lancerAssistantForm: true,
  renderMarkdown: true,
  handleMarkdownClick: true,
  imageViewer: true,
  imageViewerCurrent: true,
  imageViewerInfo: true,
  imageViewerPrompt: true,
  imageViewerNamePrompt: true,
  imageViewerStep: true,
  imageViewerKeydown: true,
  closeImageViewer: true,
  imageCanEdit: true,
  editGeneratedImage: true,
  downloadImage: true,
  copyImageText: true,
  openImageChat: true,
  removeImage: true,
  imageGallery: true,
  closeImageGallery: true,
  imageGalleryKeydown: true,
  setGalleryFilter: true,
  onGalleryScroll: true,
  imageCellState: true,
  openGalleryItem: true,
  markImageExpired: true,
  showInfoModal: true,
  appInfo: true,
  logoApp: true,
  showOpenCodeModal: true,
  openCodePlatform: true,
  openCodeCopied: true,
  openCodeFamilies: true,
  openCodeCommand: true,
  openCodeSyncCommand: true,
  copyOpenCodeCommand: true,
  downloadOpenCodeBundle: true,
  opencodeFamilyOn: true,
  toggleOpencodeFamily: true,
  features: true,
  showHelpModal: true,
  helpDoc: true,
  isLoadingReadme: true,
  readmeContent: true,
  helpBodyRef: true,
  switchHelpDoc: true,
  imgZoom: true,
  showAxModal: true,
  axSites: true,
  axExpanded: true,
  axTrees: true,
  axTreeLoading: true,
  axLoading: true,
  loadAxSites: true,
  toggleAxSite: true,
  goToAdmin: true,
  user: true,
  currentChatId: true,
  showModelProps: true,
  modelPropsLoading: true,
  modelPropsData: true,
  taskModal: true,
  messages: true,
};

/** Lit le domaine fourni par la racine ; son absence est une erreur de montage. */
export function domaineModales(): DomaineModalesChat {
  const v = inject(CLE_MODALES, null);
  if (v === null) throw new Error("domaine des fenêtres du chat non fourni");
  return v;
}

/** Clés attendues absentes de la racine (`console` : fenêtres communes seulement). */
export function clesAbsentesModales(racine: object, console: boolean): string[] {
  const cles = Object.keys(CLES_COMMUNES).concat(console ? [] : Object.keys(CLES_CHAT));
  return cles.filter((k) => !(k in racine));
}

/** Fournit le domaine depuis la racine historique ; à appeler dans son `setup`. */
export function fournirDomaineModales(racine: object, console = false): void {
  provide(CLE_MODALES, racine as DomaineModalesChat);
  onMounted(() => {
    const absentes = clesAbsentesModales(racine, console);
    if (absentes.length)
      journal.avertir(`[chat] domaine « fenêtres » : absent de la racine : ${absentes.join(", ")}`);
  });
}
