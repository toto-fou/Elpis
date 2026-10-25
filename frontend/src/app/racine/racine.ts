// SPDX-License-Identifier: MIT
/** frontend/src/app/racine/racine.ts — racine de la page (chat ou console) : état partagé, session et HTTP, montage des modules, liens entre modules, cycle de vie ; rend l'objet que les domaines injectés lisent. */
import * as Vue from "vue";
import { computed, nextTick, onMounted, onUnmounted, proxyRefs, reactive, ref, watch } from "vue";
import type { Ref } from "vue";

import { setupAdmin } from "../../features/admin/console";
import { setupAdminRuns } from "../../features/admin/executions";
import { NAV_ADMIN } from "../../features/admin/registre";
import { setupAdminSkins } from "../../features/admin/skins";
import { setupAuth } from "../../features/auth/auth";
import { GestionnaireSession } from "../../features/auth/session";
import { setupChat } from "../../features/chat/coeur/chat";
import { LOGO_ELPIS } from "../../features/communs/logo";
import type { CtxChat, MessageChat, RefsRacineChat } from "../../features/chat/coeur/types";
import { purificateur } from "../../features/chat/rendu/instance";
import { creerImportSandbox } from "../../features/editor/import-sandbox";
import { creerApiImages } from "../../features/images/api";
import { creerImages } from "../../features/images/images";
import { setupEchantillonnage } from "../../features/reglages/echantillonnage";
import { setupReglages } from "../../features/reglages/reglages";
import { creerVoix } from "../../features/voix/voix";
import { ClientHttp } from "../../platform/http/client";
import { journal } from "../../platform/journal";
import { creerHttpLegacy } from "../../platform/http/legacy";
import { escapeHtml } from "../../utils/utils-purs";
import { creerAnnonceur, creerFenetre, creerMenuContextuel, creerToasts } from "./chrome";
import type { ElementMenu } from "./chrome";
import { creerClavier } from "./clavier";
import { creerClicExterieur } from "./clic-exterieur";
import { creerDefilementChat } from "./defilement";
import { creerNotifications } from "./notifications";
import { creerOpencode } from "./opencode";
import { EVT_OUVRIR_ROUTINE } from "../../features/chat/outils/actions-resultat";
import { pageConsole } from "../page";
import { creerSessionOnglet } from "./session-onglet";
import type { Modules } from "./types";

/** Préréglages d'icône de l'écran d'accueil (console). */
const APP_ICON_PRESETS = [
  "ph-robot",
  "ph-brain",
  "ph-cpu",
  "ph-magic-wand",
  "ph-sparkle",
  "ph-star",
  "ph-lightning",
  "ph-rocket",
  "ph-planet",
  "ph-alien",
  "ph-ghost",
  "ph-bug",
  "ph-flower",
  "ph-tree",
  "ph-leaf",
  "ph-sun",
  "ph-moon",
  "ph-cloud",
  "ph-fire",
  "ph-snowflake",
  "ph-heart",
  "ph-diamond",
  "ph-crown",
  "ph-trophy",
  "ph-medal",
  "ph-shield",
  "ph-lock",
  "ph-key",
  "ph-eye",
  "ph-compass",
  "ph-map",
  "ph-globe",
  "ph-anchor",
  "ph-airplane",
  "ph-car",
  "ph-bicycle",
  "ph-train",
  "ph-boat",
  "ph-buildings",
  "ph-house",
  "ph-database",
  "ph-hard-drives",
  "ph-code",
  "ph-terminal",
  "ph-git-branch",
  "ph-chat",
  "ph-chats",
  "ph-envelope",
  "ph-bell",
  "ph-bookmark",
] as const;

// La couleur d'un indicateur porte du sens (rose = alerte) : toute la palette des fournisseurs est couverte.
const COULEURS_KPI: Readonly<Record<string, string>> = {
  blue: "bg-blue-50 text-blue-600",
  sky: "bg-sky-50 text-sky-600",
  cyan: "bg-cyan-50 text-cyan-600",
  teal: "bg-teal-50 text-teal-600",
  green: "bg-emerald-50 text-emerald-600",
  emerald: "bg-emerald-50 text-emerald-600",
  purple: "bg-violet-50 text-violet-600",
  violet: "bg-violet-50 text-violet-600",
  indigo: "bg-indigo-50 text-indigo-600",
  red: "bg-red-50 text-red-500",
  rose: "bg-rose-50 text-rose-600",
  orange: "bg-orange-50 text-orange-500",
  amber: "bg-amber-50 text-amber-600",
  yellow: "bg-yellow-50 text-yellow-600",
  slate: "bg-slate-100 text-slate-600",
};

export function kpiIconClass(couleur: string | null | undefined): string {
  return COULEURS_KPI[(couleur || "").toLowerCase()] ?? "bg-slate-100 text-slate-600";
}

/** Utilisateur connecté tel que la page le lit (compte de la session et champs du serveur). */
export interface UtilisateurRacine {
  id?: number;
  user_id?: unknown;
  username?: string;
  display_name?: string;
  role?: string;
  is_admin?: boolean;
  avatar?: string | null;
  [cle: string]: unknown;
}

export interface ReglagesRacine {
  enable_editor: boolean;
  enable_preview: boolean;
  editor_ratio: number;
  chat_width: number;
  assistant_name: string;
  skin: string;
  system_prompt: string;
  mcp_servers: unknown[];
  sandbox_path_display: string;
  enable_model_selector: boolean;
  [cle: string]: unknown;
}

export interface ConfigRacine {
  active_mcp_ids: unknown[];
  [cle: string]: unknown;
}

/** Les refs partagées passées à chaque module. */
export interface RefsRacine {
  user: Ref<UtilisateurRacine | null>;
  settings: Ref<ReglagesRacine>;
  config: Ref<ConfigRacine>;
  messages: Ref<MessageChat[]>;
  currentChatId: Ref<string | null>;
  inputMessage: Ref<string>;
  inputRef: Ref<HTMLTextAreaElement | null>;
  isStreaming: Ref<boolean>;
  isAdminView: Ref<boolean>;
  isUserScrolling: Ref<boolean>;
  currentView: Ref<string>;
  showSidebar: Ref<boolean>;
  features: Ref<Record<string, boolean>>;
}

/** Ce que reçoit la fabrique d'un module facultatif. */
export interface ContexteModule {
  readonly session: GestionnaireSession;
  readonly http: ClientHttp;
  readonly refs: RefsRacine;
  readonly ctx: CtxRacine;
}

/** Modules que seule la page de chat monte : la console ne les embarque pas. */
export interface ModulesFacultatifs {
  editeur?(c: ContexteModule): NonNullable<Modules["editeur"]>;
  skills?(c: ContexteModule): NonNullable<Modules["skills"]>;
  routines?(c: ContexteModule): NonNullable<Modules["routines"]>;
  code?(c: ContexteModule): NonNullable<Modules["code"]>;
  mascotte?(c: ContexteModule): NonNullable<Modules["mascotte"]>;
  rag?(c: ContexteModule): NonNullable<Modules["rag"]>;
  studio?(c: ContexteModule): NonNullable<Modules["studio"]>;
  studioChat?(c: ContexteModule, menu: Modules["studio"]): NonNullable<Modules["studioChat"]>;
  studioAuto?(
    c: ContexteModule,
    menu: Modules["studio"],
    dialogue: Modules["studioChat"],
  ): NonNullable<Modules["studioAuto"]>;
}

export type CtxRacine = ReturnType<typeof creerCtx>;

const MODULES_VIDES = (): Modules => ({
  auth: null,
  chat: null,
  editeur: null,
  admin: null,
  adminSkins: null,
  adminRuns: null,
  reglages: null,
  skills: null,
  routines: null,
  studio: null,
  studioChat: null,
  studioAuto: null,
  code: null,
  mascotte: null,
  rag: null,
});

/** Monte un module ; une exception le laisse absent sans empêcher la page de démarrer. */
function monter<T>(nom: string, fabrique: (() => T) | undefined): T | null {
  if (!fabrique) return null;
  try {
    return fabrique();
  } catch (e) {
    journal.erreur("[app] " + nom + " a levé une exception, module absent :", e);
    return null;
  }
}

interface LiensCtx {
  readonly m: Modules;
  readonly refs: RefsRacine;
  readonly chrome: ReturnType<typeof creerToasts> &
    ReturnType<typeof creerAnnonceur> &
    ReturnType<typeof creerFenetre>;
  readonly http: ReturnType<typeof creerHttpLegacy>;
  readonly etat: {
    systemAlert: Ref<string>;
    liveLogs: Ref<unknown[]>;
    appInfo: Ref<Record<string, unknown>>;
    showExportMenu: Ref<boolean>;
    adminAppUrl: Ref<string>;
    mainAppUrl: Ref<string>;
  };
  readonly notifs: () => ReturnType<typeof creerNotifications>;
  readonly session: () => ReturnType<typeof creerSessionOnglet>;
  readonly ouvrirChat: (id: unknown) => void;
  readonly verrouDefilement: { appliquer: () => void };
}

// Contexte transmis aux modules : les modules sont lus à l'appel (ils n'existent pas encore à sa création).
function creerCtx(l: LiensCtx) {
  const { m, refs, chrome, http, etat } = l;
  const sortirPleinEcran = (): void => {
    if (m.editeur?.editorFullscreen.value) m.editeur.exitEditorFullscreen();
  };
  return {
    showToast: chrome.showToast,
    fetchAuth: http.fetchAuth,
    fetchJsonAuth: http.fetchJsonAuth,
    announce: chrome.announce,
    openConfirm: chrome.openConfirm,
    openPrompt: chrome.openPrompt,
    openChoice: chrome.openChoice,
    openTypedConfirm: chrome.openTypedConfirm,
    nextTick,
    /** Texte inséré après le brouillon du composeur, curseur à la fin (sortie du plein écran de l'éditeur). */
    insertIntoChat(texte: string): void {
      if (!texte) return;
      refs.currentView.value = "chat";
      sortirPleinEcran();
      const cur = refs.inputMessage.value || "";
      refs.inputMessage.value = cur ? cur.replace(/\s+$/, "") + "\n\n" + texte : texte;
      void nextTick(() => {
        const el = refs.inputRef.value;
        if (el) {
          try {
            el.focus();
            el.setSelectionRange(el.value.length, el.value.length);
          } catch {
            /* champ non focalisable */
          }
        }
        m.chat?.autoResize();
      });
    },
    /** Fichier du bac joint au prochain message (même puce que la mention « @ »). */
    attachFileToChat(chemin: string): unknown {
      if (!chemin || !m.chat) return undefined;
      refs.currentView.value = "chat";
      sortirPleinEcran();
      return m.chat.selectMention({ path: chemin, name: String(chemin).split("/").pop() ?? "" });
    },
    openInEditor(chemin: string, ligne?: number, colonne?: number): unknown {
      return m.editeur?.openPathFromChat(chemin, ligne, colonne);
    },
    get user() {
      return refs.user;
    },
    get showSidebar() {
      return refs.showSidebar;
    },
    get systemAlert() {
      return etat.systemAlert;
    },
    get liveLogs() {
      return etat.liveLogs;
    },
    get appInfo() {
      return etat.appInfo;
    },
    get showExportMenu() {
      return etat.showExportMenu;
    },
    get adminAppUrl() {
      return etat.adminAppUrl;
    },
    get mainAppUrl() {
      return etat.mainAppUrl;
    },
    get features() {
      return refs.features;
    },
    get welcomeConfig() {
      return m.auth ? m.auth.welcomeConfig : null;
    },
    get showNewUserModal() {
      return m.auth ? m.auth.showNewUserModal : undefined;
    },
    get themeApi() {
      const r = m.reglages;
      return r
        ? { toggleThemeMode: r.toggleThemeMode, setAppSkin: r.setAppSkin, skins: r.APP_SKINS.value }
        : null;
    },
    get skinCourant() {
      return m.reglages ? m.reglages.skinCourant : null;
    },
    reloadAppSkins(): unknown {
      return m.reglages ? m.reglages.loadAppSkins() : Promise.resolve(false);
    },
    get pinnedServers() {
      return m.reglages ? m.reglages.pinnedServers : undefined;
    },
    get chats() {
      return m.chat ? m.chat.chats : undefined;
    },
    get currentChatTitle() {
      return m.chat ? m.chat.currentChatTitle : null;
    },
    get fileInput() {
      return m.editeur ? m.editeur.fileInput : null;
    },
    openFile(chemin: string): unknown {
      return m.editeur ? m.editeur.openFile(chemin) : null;
    },
    get showEditor() {
      return m.editeur ? m.editeur.showEditor : undefined;
    },
    get monacoRef() {
      return m.editeur ? m.editeur.monacoRef : undefined;
    },
    get models() {
      return m.editeur ? m.editeur.models : undefined;
    },
    get openTabs() {
      return m.editeur ? m.editeur.openTabs : undefined;
    },
    get availableModels() {
      return m.chat ? m.chat.availableModels : null;
    },
    get activeModelIds() {
      return m.chat ? m.chat.activeModelIds : null;
    },
    get selectedModel() {
      return m.chat ? m.chat.selectedModel : null;
    },
    addCodeCopyButtons(complet: boolean, racine: HTMLElement): unknown {
      return m.chat ? m.chat.addCodeCopyButtons(complet, racine) : null;
    },
    checkAuth(): Promise<unknown> {
      return m.auth ? m.auth.checkAuth() : Promise.resolve();
    },
    loadChatsList(): unknown {
      return m.chat ? m.chat.loadChatsList() : Promise.resolve();
    },
    openChatById(id: unknown): void {
      l.ouvrirChat(id);
    },
    loadAvailableModels(): Promise<unknown> {
      return m.chat ? m.chat.loadAvailableModels() : Promise.resolve();
    },
    autoResize(): void {
      m.chat?.autoResize();
    },
    loadSandboxFiles(): unknown {
      return m.editeur ? m.editeur.loadSandboxFiles() : Promise.resolve();
    },
    updateEditor(chemin: string, contenu: string, disque?: unknown): Promise<unknown> {
      return m.editeur ? m.editeur.updateEditor(chemin, contenu, disque as never) : Promise.resolve();
    },
    editorIsViewerPath(chemin: string): boolean {
      return m.editeur ? m.editeur.officeIsViewerPath(chemin) : false;
    },
    editorRefreshViewer(chemin: string): Promise<unknown> {
      return m.editeur ? Promise.resolve(m.editeur.editorRefreshViewer(chemin)) : Promise.resolve();
    },
    capturePreWrite(chemin: string): string | null {
      return m.editeur ? m.editeur.capturePreWrite(chemin) : null;
    },
    showDiffForMessage(chemin: string, avant: unknown): unknown {
      return m.editeur?.showDiffForMessage(chemin, avant as never);
    },
    showToolDiff(chemin: string, avant: unknown): unknown {
      return m.editeur?.showToolDiff(chemin, avant as never);
    },
    streamOpenForWrite(
      chemin: string,
      o: { append: boolean; preloadContent: string | null },
    ): Promise<boolean> {
      return m.editeur ? m.editeur.streamOpenForWrite(chemin, o) : Promise.resolve(false);
    },
    streamLocateEdit(chemin: string, o: Record<string, unknown>): Promise<boolean> {
      return m.editeur ? m.editeur.streamLocateEdit(chemin, o as never) : Promise.resolve(false);
    },
    streamWriteChunk(chemin: string, morceau: string): void {
      m.editeur?.streamWriteChunk(chemin, morceau);
    },
    streamFinalize(
      chemin: string,
      o: { success: boolean; finalContent?: string | null; disk?: unknown },
    ): unknown {
      return m.editeur ? m.editeur.streamFinalize(chemin, o as never) : Promise.resolve();
    },
    isStreamActive(chemin: string): boolean {
      return m.editeur ? m.editeur.isStreamActive(chemin) : false;
    },
    checkExternalModsSoon(delai?: number): void {
      m.editeur?.checkExternalModsSoon(delai);
    },
    getStreamPreSnapshot(chemin: string): string | null {
      return m.editeur ? m.editeur.getStreamPreSnapshot(chemin) : null;
    },
    loadUsers(): unknown {
      return m.admin ? m.admin.loadUsers() : Promise.resolve();
    },
    loadSettingsData(): unknown {
      return m.reglages ? m.reglages.loadSettingsData() : Promise.resolve();
    },
    closeSettings(sansConfirmer?: boolean): unknown {
      return m.reglages?.closeSettings(sansConfirmer);
    },
    openSettingsTab(onglet: string): unknown {
      return m.reglages?.openSettingsTab(onglet);
    },
    openHelp(doc?: string): unknown {
      return m.reglages?.openHelp(doc);
    },
    /** Commande `/rag` du module RAG, lue par le menu « / » du composeur. */
    get ragCommande() {
      return m.rag ? m.rag.commande : null;
    },
    /** Ce que le RAG lit du chat : collections actives, pièces jointes, fil. */
    chatPourRag() {
      const c = m.chat;
      return c
        ? {
            ragChat: c.ragChat,
            attachedFiles: c.attachedFiles,
            messages: refs.messages,
            defilerEnBas: () => c.scrollToBottom(true),
          }
        : null;
    },
    /** La visionneuse de source prend la place de l'éditeur de la sandbox. */
    fermerEditeur(): void {
      if (m.editeur) m.editeur.showEditor.value = false;
    },
    enGeneration(): boolean {
      return refs.isStreaming.value;
    },
    onMemoryChanged(): unknown {
      return m.reglages?.loadUserMemory();
    },
    stopSpeaking(): unknown {
      return m.chat?.stopSpeaking();
    },
    openTemplate(t: unknown): unknown {
      return m.chat?.openTemplate(t as never);
    },
    loadMcpUserCategories(): unknown {
      return m.chat ? m.chat.loadMcpUserCategories() : Promise.resolve();
    },
    openSkillsTab(): unknown {
      return m.skills ? m.skills.openSkillsTab() : Promise.resolve();
    },
    loadPublicConfig(): unknown {
      return m.auth ? m.auth.loadPublicConfig() : Promise.resolve();
    },
    /** Départ volontaire (`explicite`) : la génération en cours s'arrête ; une expiration la laisse finir. */
    resetChatOnLogout(explicite?: boolean): unknown {
      return m.chat?.resetOnLogout(explicite);
    },
    /** Instantané de reprise du compte courant (clé par compte) et clé historique sans compte. */
    clearSavedSession(): void {
      l.session().purgerSession(refs.user.value);
    },
    rescueEditorBuffers(): unknown {
      return m.editeur ? m.editeur.rescueDirtyBuffers() : 0;
    },
    resetEditorOnLogout(): unknown {
      return m.editeur?.resetOnLogout();
    },
    /** Point d'entrée unique « session morte » : un toast, puis l'écran de connexion (purge par l'observateur de `user`). */
    handleSessionExpired(): void {
      http.handleSessionExpired();
    },
    onNotificationEvent(data: unknown): void {
      l.notifs().onNotificationEvent(data);
    },
    /** Rattrapage après reconnexion du flux système : liste complète si le panneau est ouvert, sinon le compteur. */
    refreshNotifBadge(): void {
      if (pageConsole()) return;
      const n = l.notifs();
      void (n.showNotifPanel.value ? n.loadNotifications() : n.refreshNotifUnread());
    },
    notifyChatDone(id: string, titre: string): void {
      l.notifs().notifyChatDone(id, titre);
    },
    notifyChatError(id: string, titre: string, detail?: unknown): void {
      l.notifs().notifyChatError(id, titre, detail);
    },
    onAnnotationFrame(data: unknown): unknown {
      return m.studio?.applyFrame(data as never);
    },
    currentModelId(): string | null {
      return m.chat ? m.chat.selectedModel.value : null;
    },
    currentConnectorId(): string | number | null {
      return m.chat?.selectedConnector.value || null;
    },
    /** Modèles d'un serveur d'inférence (Studio, routines) ; le serveur du chat sans identifiant. */
    engineModels(connecteur: unknown): unknown[] {
      if (!m.chat) return [];
      if (!connecteur) return m.chat.availableModels.value || [];
      const parConnecteur = (m.chat.pickerConnModels.value || {}) as Record<string, unknown[] | undefined>;
      return parConnecteur[String(connecteur)] || [];
    },
    // Jamais branché : le chat n'expose pas de chargeur des connecteurs (no-op conservé).
    loadEngines(): void {},
    _lockAutoScroll(): void {
      l.verrouDefilement.appliquer();
    },
  };
}

export interface OptionsRacine {
  readonly modules?: ModulesFacultatifs;
}

export function creerRacine(options: OptionsRacine = {}) {
  const facultatifs = options.modules ?? {};
  const consoleSeule = pageConsole();

  // ── État partagé ────────────────────────────────────────────────────────
  const user = ref<UtilisateurRacine | null>(null);
  const settings = ref<ReglagesRacine>({
    enable_editor: true,
    enable_preview: false,
    editor_ratio: 50,
    chat_width: 70,
    assistant_name: "Elpis",
    skin: "elpis",
    system_prompt: "",
    mcp_servers: [],
    sandbox_path_display: "",
    enable_model_selector: false,
  });
  const config = ref<ConfigRacine>({
    active_mcp_ids: [],
  });
  const messages = ref<MessageChat[]>([]) as Ref<MessageChat[]>;
  const currentChatId = ref<string | null>(null);
  const inputMessage = ref("");
  const inputRef: Ref<HTMLTextAreaElement | null> = ref(null);
  const isStreaming = ref(false);
  const isAdminView = ref(false);
  const isUserScrolling = ref(false);
  const currentView = ref("chat");
  // Repliée sous 1024 px : sinon la barre latérale en surimpression masque tout le chat au démarrage.
  const showSidebar = ref(typeof window === "undefined" || window.innerWidth >= 1024);
  const systemAlert = ref("");
  const showInfoModal = ref(false);
  const showExportMenu = ref(false);
  // Sous-menu « Plus » du volet latéral (RAG, Studio, Remote code) : la cascade d'Échap le referme.
  const menuPagesOuvert = ref(false);
  const imgZoom = ref<string | null>(null);
  // Un seul journal en direct : le flux système y écrit, la console le lit.
  const liveLogs = ref<unknown[]>([]);
  const appInfo = ref<Record<string, unknown>>({
    name: "Elpis",
    version: "0.1.1",
    teamName: "",
    engine: "llama.cpp",
    description: "",
    iconType: "phosphor",
    icon: "ph-robot",
    iconColor: "#ffffff",
    iconBg: "#0f172a",
    logoBb64: "",
    logoUrl: LOGO_ELPIS,
  });
  // Avatar de l'assistant partout : logo de l'application (console › Général), sinon celui d'Elpis.
  const logoApp = computed(() =>
    typeof appInfo.value["logoUrl"] === "string" && appInfo.value["logoUrl"]
      ? appInfo.value["logoUrl"]
      : LOGO_ELPIS,
  );

  const toasts = creerToasts();
  const annonceur = creerAnnonceur();
  const fenetre = creerFenetre();
  const menu = creerMenuContextuel();

  // ── Navigation entre les processus (mode séparé) ────────────────────────
  const adminAppUrl = ref(typeof window.__ADMIN_APP_URL__ === "string" ? window.__ADMIN_APP_URL__ : "");
  const mainAppUrl = ref(typeof window.__MAIN_APP_URL__ === "string" ? window.__MAIN_APP_URL__ : "");
  // Drapeaux de l'instance (/api/public-config) ; la voix est fausse par défaut (pas de bouton qui apparaît puis disparaît).
  const features = ref<Record<string, boolean>>({
    opencode: true,
    agents: true,
    office_preview: true,
    voice_stt: false,
    voice_tts: false,
  });

  const m = MODULES_VIDES();
  const session = new GestionnaireSession();
  const http = new ClientHttp(session);
  const httpLegacy = creerHttpLegacy({
    session,
    showToast: toasts.showToast,
    deconnecterAffichage() {
      user.value = null;
    },
    exigerMotDePasse() {
      const doit = m.auth?.mustChangePassword;
      if (!doit || doit.value) return false;
      doit.value = true;
      return true;
    },
  });
  const fetchAuth = httpLegacy.fetchAuth;

  // Mode séparé sans adresse connue : même déduction que le serveur (port apparié, sinon /admin du mandataire).
  function adresseConsoleDeduite(): string {
    try {
      const u = new URL(window.location.href);
      if (u.port === "8001") return `${u.protocol}//${u.hostname}:8002/admin`;
      return `${u.origin}/admin`;
    } catch {
      return "";
    }
  }

  /** Bouton « Admin » : autre processus en mode séparé, sinon la console dans la page (onglet facultatif). */
  function goToAdmin(onglet?: unknown): void {
    const t = typeof onglet === "string" && onglet ? onglet : "";
    const ancre = t ? "#" + t : "";
    if (adminAppUrl.value) {
      window.location.href = adminAppUrl.value + ancre;
      return;
    }
    const mode = typeof window.__APP_MODE__ === "string" ? window.__APP_MODE__ : "";
    if (mode === "main" || mode === "admin") {
      const deduite = adresseConsoleDeduite();
      if (deduite) {
        window.location.href = deduite + ancre;
        return;
      }
    }
    void m.admin?.loadUsers();
    if (t) void m.admin?.goAdminPage(t);
    isAdminView.value = true;
  }

  /** « Retour au chat » : garde de sortie de la console, puis repli dans la page ou retour à l'autre processus. */
  async function goToMainApp(): Promise<void> {
    if (m.admin && !(await m.admin.adminConfirmLeave())) return;
    if (!consoleSeule) {
      isAdminView.value = false;
      return;
    }
    window.location.href = mainAppUrl.value || "/";
  }

  const refs: RefsRacine = {
    user,
    settings,
    config,
    messages,
    currentChatId,
    inputMessage,
    inputRef,
    isStreaming,
    isAdminView,
    isUserScrolling,
    currentView,
    showSidebar,
    features,
  };

  const verrouDefilement = { appliquer: (): void => {} };
  // Créés après le contexte, qui les lit à l'appel.
  let notifs: ReturnType<typeof creerNotifications> | null = null;
  let sessionOnglet: ReturnType<typeof creerSessionOnglet> | null = null;

  function ouvrirChat(id: unknown): void {
    if (id == null) return;
    if (notifs) notifs.showNotifPanel.value = false;
    if (isAdminView.value) isAdminView.value = false;
    currentView.value = "chat";
    void m.chat?.loadChat(String(id as string));
  }

  const ctx = creerCtx({
    m,
    refs,
    chrome: { ...toasts, ...annonceur, ...fenetre },
    http: httpLegacy,
    etat: { systemAlert, liveLogs, appInfo, showExportMenu, adminAppUrl, mainAppUrl },
    notifs: () => notifs as ReturnType<typeof creerNotifications>,
    session: () => sessionOnglet as ReturnType<typeof creerSessionOnglet>,
    ouvrirChat,
    verrouDefilement,
  });
  const contexte: ContexteModule = { session, http, refs, ctx };

  // ── Modules ─────────────────────────────────────────────────────────────
  // Les modules typent chacun leurs refs : la racine leur passe les mêmes refs partagées.
  const refsChat = refs as unknown as RefsRacineChat;
  m.auth = monter("setupAuth", () =>
    setupAuth(
      refs as unknown as Parameters<typeof setupAuth>[0],
      ctx as unknown as Parameters<typeof setupAuth>[1],
      {
        session,
        http,
      },
    ),
  );
  m.chat = monter("setupChat", () =>
    setupChat(session, refsChat, ctx as unknown as CtxChat, {
      echantillonnage: (r, c) => setupEchantillonnage(Vue, r, c),
      voix: (r, c) => creerVoix(r, c),
      images: (r, c) => creerImages(creerApiImages(http), r, c),
    }),
  );
  m.editeur =
    monter("setupEditor", facultatifs.editeur && (() => facultatifs.editeur?.(contexte) ?? null)) ?? null;
  m.admin = monter("setupAdmin", () =>
    setupAdmin(
      Vue,
      refs as unknown as Parameters<typeof setupAdmin>[1],
      ctx as unknown as Parameters<typeof setupAdmin>[2],
      http,
    ),
  );
  m.reglages = monter("setupSettings", () =>
    setupReglages(
      Vue,
      refs as unknown as Parameters<typeof setupReglages>[1],
      ctx as unknown as Parameters<typeof setupReglages>[2],
      http,
    ),
  );
  m.adminSkins = monter("setupAdminSkins", () => setupAdminSkins(ctx, http));
  m.adminRuns = monter("setupAdminRuns", () => setupAdminRuns(http));
  m.skills =
    monter("setupSkillsMenu", facultatifs.skills && (() => facultatifs.skills?.(contexte) ?? null)) ?? null;
  m.routines =
    monter("setupRoutinesMenu", facultatifs.routines && (() => facultatifs.routines?.(contexte) ?? null)) ??
    null;
  m.studio =
    monter("setupStudioMenu", facultatifs.studio && (() => facultatifs.studio?.(contexte) ?? null)) ?? null;
  m.code = monter("setupCodeMenu", facultatifs.code && (() => facultatifs.code?.(contexte) ?? null)) ?? null;
  m.mascotte =
    monter("setupMascotte", facultatifs.mascotte && (() => facultatifs.mascotte?.(contexte) ?? null)) ?? null;
  m.rag = monter("setupRag", facultatifs.rag && (() => facultatifs.rag?.(contexte) ?? null)) ?? null;
  m.studioChat =
    monter(
      "setupStudioChat",
      facultatifs.studioChat && (() => facultatifs.studioChat?.(contexte, m.studio) ?? null),
    ) ?? null;
  m.studioAuto =
    monter(
      "setupStudioAutomation",
      facultatifs.studioAuto && (() => facultatifs.studioAuto?.(contexte, m.studio, m.studioChat) ?? null),
    ) ?? null;

  // Quitter le Studio par n'importe quel chemin coupe son mini-chat et un glisser armé ; quitter Code coupe son flux.
  watch(currentView, (v, avant) => {
    if (avant === "studio" && v !== "studio") {
      try {
        m.studioChat?.studioChatStop();
      } catch {
        /* déjà arrêté */
      }
      try {
        m.studioChat?.cancelStudioDrag();
      } catch {
        /* rien d'armé */
      }
    }
    if (avant === "code" && v !== "code") {
      try {
        m.code?.codeDisconnectStream();
      } catch {
        /* flux déjà fermé */
      }
    }
  });

  const opencode = creerOpencode({ fetchAuth, showToast: toasts.showToast });

  // ── Menu contextuel : actions (chats, fichiers, dossiers, fond de l'explorateur) ──
  function handleContextAction(action: string): void {
    const item: ElementMenu | null = menu.contextMenu.value.item;
    const type = menu.contextMenu.value.type;
    menu.closeContextMenu();
    if (!item) return;
    if (type === "chat") {
      const c = m.chat;
      const id = String(item.id ?? "");
      if (action === "rename") void c?.renameChat(id, String(item.title ?? ""));
      if (action === "archive") void c?.archiveChat(id);
      if (action === "delete") void c?.deleteChat(id);
      return;
    }
    const ed = m.editeur;
    if (!ed) return;
    const chemin = String(item.path ?? "");
    let parent = "";
    if (type === "folder") parent = chemin;
    else if (type === "file" && chemin.includes("/")) parent = chemin.substring(0, chemin.lastIndexOf("/"));
    if (action === "new_file") void ed.createFile(parent);
    if (action === "new_folder") void ed.createFolder(parent);
    if (action === "rename") void ed.renameItem(chemin);
    if (action === "copy_path") void ed.copyTabPath(chemin);
    if (action === "download") void ed.downloadFile(chemin);
    if (action === "delete") void ed.deleteFile(chemin);
    if (action === "duplicate") void ed.duplicateItem(chemin);
    if (action === "attach_chat") void ed.attachToChat(chemin);
    if (action === "terminal_here") void ed.openTerminalHere(type === "folder" ? chemin : parent);
    if (action === "collapse_all") ed.collapseAllFolders();
  }

  const importBac = creerImportSandbox({
    session,
    fetchAuth,
    showToast: toasts.showToast,
    handleSessionExpired: httpLegacy.handleSessionExpired,
    editeur: () => m.editeur,
  });

  // ── Console : chargeurs de la page affichée (registre de la console) ────
  function chargerPageAdmin(onglet: string): void {
    const a = m.admin;
    if (!a) return;
    // Seuls le tableau de bord et la vue d'ensemble interrogent périodiquement le serveur.
    if (onglet === "dashboard") a.startDashboardPolling();
    else a.stopDashboardPolling();
    if (onglet === "overview") a.startOverviewPolling();
    else a.stopOverviewPolling();
    const page = NAV_ADMIN.pages[onglet];
    const sources = [a, m.adminSkins, m.adminRuns] as readonly (object | null)[];
    for (const [nom, ...args] of page?.loaders ?? []) {
      for (const src of sources) {
        const f = src ? (src as Record<string, unknown>)[nom] : undefined;
        if (typeof f === "function") {
          void (f as (...a: unknown[]) => unknown)(...args);
          break;
        }
      }
    }
  }
  // Ouverture de la console : chargement de la page courante (lien profond déjà résolu) et bandeau de redémarrage.
  watch(isAdminView, (actif) => {
    const a = m.admin;
    if (!a) return;
    if (!actif) {
      a.stopDashboardPolling();
      a.stopOverviewPolling();
      return;
    }
    chargerPageAdmin(a.adminTab.value);
    void a.loadRestartStatus();
  });
  watch(
    () => m.admin?.adminTab.value,
    (onglet) => {
      if (isAdminView.value && onglet) chargerPageAdmin(onglet);
    },
  );

  const defilement = creerDefilementChat({
    conteneur: () => m.chat?.chatContainer.value,
    isUserScrolling,
    onChatScroll: () => m.chat?.onChatScroll(),
  });
  verrouDefilement.appliquer = defilement.verrouillerDefilementAuto;

  notifs = creerNotifications({
    fetchAuth,
    user,
    showToast: toasts.showToast,
    announce: annonceur.announce,
    goToAdmin,
    openChatById: ouvrirChat,
    routines: () => m.routines,
  });
  const n = notifs;

  sessionOnglet = creerSessionOnglet({ user, messages, currentChatId, fetchAuth, chat: () => m.chat });
  const so = sessionOnglet;

  const onGlobalClick = creerClicExterieur({
    modules: m,
    menuOuvert: () => menu.contextMenu.value.isOpen,
    fermerMenu: menu.closeContextMenu,
    showExportMenu,
    showNotifPanel: n.showNotifPanel,
    notifDropdownRef: n.notifDropdownRef,
  });
  const clavier = creerClavier({
    modules: m,
    modalState: fenetre.modalState,
    contextMenu: menu.contextMenu,
    showInfoModal,
    showOpenCodeModal: opencode.showOpenCodeModal,
    imgZoom,
    showNotifPanel: n.showNotifPanel,
    menuPagesOuvert,
    currentView,
    inputMessage,
    inputRef,
    handleModalCancel: fenetre.handleModalCancel,
    closeContextMenu: menu.closeContextMenu,
  });

  // ── Cycle de vie ────────────────────────────────────────────────────────
  const avantDechargement = (): void => so.sauverSession();
  const surOuvrirRoutine = (ev: Event): void =>
    void n.ouvrirRoutine((ev as CustomEvent<{ id?: unknown }>).detail?.id);
  onMounted(async () => {
    document.addEventListener("click", onGlobalClick);
    // Capture : avant les gestionnaires du navigateur et des composants (cascade d'Échap).
    document.addEventListener("keydown", clavier.onGlobalKeydown, { capture: true });
    window.addEventListener("beforeunload", avantDechargement);
    window.addEventListener(EVT_OUVRIR_ROUTINE, surOuvrirRoutine);
    document.addEventListener("dragend", importBac.finDeGlisser);
    // Capture : avant tout stopPropagation des lignes de l'arbre.
    document.addEventListener("drop", importBac.finDeGlisser, true);
    document.addEventListener("visibilitychange", n.appliquerBadgeTitre);
    await m.auth?.loadPublicConfig();
    await m.auth?.checkAuth();
    if (so.reprendreOAuth()) return;
    if (!user.value) return;
    m.chat?.connectSystemEvents();
    // Console seule : ni boîte de réception, ni notifications, ni reprise (routes absentes du port d'administration).
    if (consoleSeule) return;
    m.reglages?.startInboxPolling();
    void n.loadNotifications();
    so.restaurerSession();
  });

  onUnmounted(() => {
    document.removeEventListener("click", onGlobalClick);
    document.removeEventListener("keydown", clavier.onGlobalKeydown, { capture: true });
    window.removeEventListener("beforeunload", avantDechargement);
    window.removeEventListener(EVT_OUVRIR_ROUTINE, surOuvrirRoutine);
    document.removeEventListener("dragend", importBac.finDeGlisser);
    document.removeEventListener("drop", importBac.finDeGlisser, true);
    document.removeEventListener("visibilitychange", n.appliquerBadgeTitre);
    m.chat?.disconnectSystemEvents();
    m.admin?.stopDashboardPolling();
    m.admin?.stopOverviewPolling();
    m.reglages?.stopInboxPolling();
  });

  const essayer = (f: () => unknown): void => {
    try {
      void f();
    } catch {
      /* module absent ou déjà nettoyé */
    }
  };

  // Connexion : flux système, boîte de réception, notifications, reprise. Déconnexion (volontaire ou subie) : purge complète.
  watch(user, (val, avant) => {
    if (val && so.reprendreOAuth()) return;
    if (val) {
      m.chat?.connectSystemEvents();
      if (consoleSeule) return;
      m.reglages?.startInboxPolling();
      void n.loadNotifications();
      so.restaurerSession();
      return;
    }
    m.reglages?.stopInboxPolling();
    n.viderNotifications();
    messages.value = [];
    if (m.chat) m.chat.chats.value = [];
    currentChatId.value = null;
    isAdminView.value = false;
    // Modifications non enregistrées mises de côté avant la purge, restaurables à la reconnexion.
    essayer(() => m.editeur?.rescueDirtyBuffers());
    const ed = m.editeur;
    if (ed) {
      ed.showEditor.value = false;
      ed.openTabs.value = [];
      for (const modele of Object.values(ed.models)) {
        try {
          modele?.dispose();
        } catch {
          /* déjà libéré */
        }
      }
      for (const k of Object.keys(ed.models)) delete ed.models[k];
    }
    essayer(() => ctx.resetChatOnLogout());
    essayer(() => ctx.resetEditorOnLogout());
    isStreaming.value = false;
    essayer(() => m.admin?.stopDashboardPolling());
    essayer(() => m.admin?.stopOverviewPolling());
    // Les fenêtres hors des blocs « connecté » seraient peintes au-dessus de la carte de connexion.
    const f = fenetre.modalState.value;
    if (f.isOpen) {
      essayer(() => f.resolve?.(false));
      f.isOpen = false;
    }
    essayer(() => ctx.closeSettings(true));
    // Page Code : flux coupé, état vidé ; vue neutre pour le compte suivant.
    essayer(() => m.code?.codeResetOnLogout());
    opencode.showOpenCodeModal.value = false;
    currentView.value = "chat";
    essayer(() => m.studio?.clearStudio());
    essayer(() => m.studioAuto?.resetAutomation());
    // Zoom de diagramme (hors Vue) et d'image : ils survivaient au-dessus de l'écran de connexion.
    try {
      document
        .querySelectorAll<HTMLElement & { _elpisClose?: () => void }>(".elpis-diagram-zoom-overlay")
        .forEach((el) => {
          try {
            if (el._elpisClose) el._elpisClose();
            else el.remove();
          } catch {
            el.remove();
          }
        });
    } catch {
      /* DOM indisponible */
    }
    imgZoom.value = null;
    essayer(() => m.admin?.closeTransferModal());
    // Instantané du compte sortant (clé dérivée de l'ancien compte, pas du nouveau `null`).
    so.purgerSession(avant);
  });

  // Historique de la barre latérale, regroupé par date (le drapeau de renommage suit la projection).
  const groupedHistory = computed(() => {
    const liste = m.chat?.chats.value ?? [];
    const items = liste.map((ch) => ({
      id: ch.id,
      title: ch.title,
      updated_at: ch.updated_at,
      kind: "chat",
      _renamed: ch._renamed || false,
    }));
    if (!items.length) return [];
    const norm = (ts: unknown): number => {
      const v = Number(ts) || 0;
      return !v ? 0 : v > 1e12 ? v : v * 1000;
    };
    items.sort((a, b) => norm(b.updated_at) - norm(a.updated_at));
    const now = new Date();
    const aujourdhui = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const hier = aujourdhui - 86400000;
    const semaine = aujourdhui - 7 * 86400000;
    const tranches = [
      { key: "today", label: "Aujourd'hui", items: [] as typeof items },
      { key: "yesterday", label: "Hier", items: [] as typeof items },
      { key: "week", label: "7 derniers jours", items: [] as typeof items },
      { key: "older", label: "Plus ancien", items: [] as typeof items },
    ];
    for (const it of items) {
      const ts = norm(it.updated_at);
      const t = ts >= aujourdhui ? 0 : ts >= hier ? 1 : ts >= semaine ? 2 : 3;
      tranches[t]?.items.push(it);
    }
    return tranches.filter((b) => b.items.length);
  });

  // Ordre voulu : modules de faible priorité d'abord, état de la racine en dernier (il l'emporte toujours).
  const racine = {
    ...m.admin,
    ...m.adminSkins,
    ...m.adminRuns,
    ...m.reglages,
    ...m.skills,
    ...m.routines,
    ...m.studio,
    ...m.code,
    ...m.mascotte,
    ragPage: m.rag ? reactive(m.rag) : null,
    openRagPage: m.rag ? m.rag.ouvrir : () => undefined,
    closeRagPage: m.rag ? m.rag.fermer : () => undefined,
    ragAllowed: m.rag ? m.rag.autorise : ref(false),
    ...m.studioChat,
    ...m.studioAuto,
    ...m.editeur,
    ...m.chat,
    groupedHistory,
    ...m.auth,
    user,
    settings,
    config,
    messages,
    currentChatId,
    inputMessage,
    inputRef,
    isStreaming,
    isAdminView,
    isUserScrolling,
    chatAwayFromBottom: defilement.chatAwayFromBottom,
    currentView,
    showSidebar,
    systemAlert,
    showInfoModal,
    ...opencode,
    appInfo,
    logoApp,
    imgZoom,
    liveLogs,
    showExportMenu,
    menuPagesOuvert,
    notifications: n.notifications,
    notifUnread: n.notifUnread,
    showNotifPanel: n.showNotifPanel,
    notifDropdownRef: n.notifDropdownRef,
    toggleNotifPanel: n.toggleNotifPanel,
    openNotifPanel: n.openNotifPanel,
    loadNotifications: n.loadNotifications,
    markNotifRead: n.markNotifRead,
    markAllNotifsRead: n.markAllNotifsRead,
    deleteNotif: n.deleteNotif,
    clearNotifs: n.clearNotifs,
    openNotifItem: n.openNotifItem,
    notifTimeAgo: n.notifTimeAgo,
    notifyOSEnabled: n.notifyOSEnabled,
    notifyOSSupported: n.notifyOSSupported,
    notifyOSSecure: n.notifyOSSecure,
    toggleNotifyOS: n.toggleNotifyOS,
    notifLoading: n.notifLoading,
    notifError: n.notifError,
    notifHasMore: n.notifHasMore,
    notifNowTick: n.notifNowTick,
    loadMoreNotifs: n.loadMoreNotifs,
    toggleNotifReadState: n.toggleNotifReadState,
    notifIcon: n.notifIcon,
    notifColor: n.notifColor,
    isNotifNew: n.isNotifNew,
    groupedNotifications: n.groupedNotifications,
    closeNotifPanel: n.closeNotifPanel,
    adminAppUrl,
    mainAppUrl,
    features,
    goToAdmin,
    goToMainApp,
    ...toasts,
    ...annonceur,
    modalState: fenetre.modalState,
    modalInputRef: fenetre.modalInputRef,
    modalCancelRef: fenetre.modalCancelRef,
    modalDialogRef: fenetre.modalDialogRef,
    onModalTabKey: fenetre.onModalTabKey,
    handleModalSubmit: fenetre.handleModalSubmit,
    handleModalChoice: fenetre.handleModalChoice,
    modalTypedBlocked: fenetre.modalTypedBlocked,
    handleModalCancel: fenetre.handleModalCancel,
    contextMenu: menu.contextMenu,
    openContextMenu: menu.openContextMenu,
    onContextMenuKeydown: menu.onContextMenuKeydown,
    handleContextAction,
    handleExplorerDrop: importBac.handleExplorerDrop,
    onExplorerDragOver: importBac.onExplorerDragOver,
    onExplorerDragLeave: importBac.onExplorerDragLeave,
    explorerDragOver: importBac.explorerDragOver,
    uploadFilesToSandbox: importBac.uploadFilesToSandbox,
    uploadProgress: importBac.uploadProgress,
    cancelSandboxUpload: importBac.cancelSandboxUpload,
    kpiIconClass,
    appIconPresets: APP_ICON_PRESETS,
    elpisSanitize: purificateur(),
    elpisEscape: escapeHtml,
    // Socle de la page (session et client HTTP), lu par les parcours réels.
    sessionPage: session,
    httpPage: http,
  };
  return proxyRefs(racine);
}

export type Racine = ReturnType<typeof creerRacine>;
