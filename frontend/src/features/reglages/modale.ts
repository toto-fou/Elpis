// SPDX-License-Identifier: MIT
/** frontend/src/features/reglages/modale.ts — modale Paramètres : chargement du document avec ses défauts, ouverture (par onglet), fermeture avec confirmation, mot de passe et photo de profil recadrée. */
import { schemaReponseAvatar } from "@elpis/contracts";
import { shallowRef } from "vue";
import type { Ref } from "vue";

import { corpsJson, detailErreur, estObjet, lireSchema, objet } from "../../utils/lecture-json";
import { normaliserServeursMcp } from "./mcp";
import { clesDifferentes } from "./persistance";
import type { Persistance } from "./persistance";
import { ANCIENS_ONGLETS, entreeRail } from "./rail";
import type { CtxReglages, ReglagesApp, RefsReglages, VueReglages } from "./types";

const ENTETES_JSON = { "Content-Type": "application/json" };
const MOT_DE_PASSE_VIDE = { old_password: "", new_password: "", confirm_password: "" };

/** Services des autres familles que la modale pilote à l'ouverture, à la fermeture et au changement d'onglet. */
export interface DependancesModale {
  loadAppSkins(): Promise<boolean>;
  loadSharedMcpServers(): Promise<void>;
  reinitialiserEpingles(): void;
  loadSavedPrompts(): Promise<void>;
  loadPromptTemplates(): Promise<void>;
  loadArchives(): Promise<void>;
  loadLlmConnectors(): Promise<void>;
  loadUsageData(): Promise<void>;
  loadUserMemory(): Promise<void>;
  loadSandboxState(): Promise<void>;
  loadGitConnectors(): Promise<void>;
  loadConnexions(): Promise<void>;
  loadSecrets(): Promise<void>;
  cnxReset(): void;
  cancelMemoryEdit(): void;
  startNewTemplate(): void;
  stopSandboxPolling(): void;
  reinitialisations: readonly (() => void)[];
  /** États qui ne s'enregistrent pas seuls : la fermeture demande de confirmer leur abandon. */
  etatsSales: readonly { readonly value: boolean }[];
}

export function creerModale(
  vue: VueReglages,
  refs: RefsReglages,
  ctx: CtxReglages,
  persistance: Persistance,
  showSettingsModal: Ref<boolean>,
  dep: DependancesModale,
) {
  const { nextTick, ref } = vue;
  const { user, settings } = refs;
  const { showToast, fetchAuth, openConfirm } = ctx;
  const settingsDialogEl: Ref<HTMLElement | null> = ref(null);
  const settingsTab = ref("profile");
  // Dernière section ouverte de chaque onglet : la modale y revient (`settings.md`, « Restore the most recently viewed pane »).
  const settingsSections = ref<Record<string, string>>({});
  const showPasswordChange = ref(false);
  const passwordForm = ref({ ...MOT_DE_PASSE_VIDE });

  /** Défauts alignés sur `api_get_settings` : la valeur affichée ne dépend pas de qui du GET ou du PUT a peuplé la ligne. */
  function completerDefauts(data: ReglagesApp): ReglagesApp {
    const d = data;
    d.enable_editor ??= true;
    d.enable_preview ??= false;
    d.enable_rag ??= true;
    d.enable_mcp ??= true;
    d.enable_charts ??= false;
    d.auto_open_editor_on_write ??= true;
    d.dark_mode ??= false;
    d.dark_mode_auto ??= false;
    d.hide_thinking ??= false;
    d.hide_web_screenshots ??= false;
    d.live_shell_enabled ??= true;
    d.jobs_wake ??= true;
    d.voice_input_enabled ??= false;
    d.voice_reply_enabled ??= false;
    d.voice_reply_tools_enabled ??= false;
    d.memory_enabled ??= false;
    d.image_enabled ??= true;
    d.image_tool_enabled ??= true;
    d.routine_tool_enabled ??= true;
    if (!estObjet(d.image_prefs)) d.image_prefs = { ratio: "1:1", side: 1024, n: 1, enhance: false };
    d.agents_enabled ??= false;
    if (!estObjet(d.opencode_mcp_families)) d.opencode_mcp_families = {};
    d.compression_enabled ??= false;
    d.compression_threshold_pct ??= 0;
    d.compression_threshold_tokens ??= 0;
    d.compression_max_rounds ??= 0;
    if (!Array.isArray(d.custom_agents)) d.custom_agents = [];
    if (!Array.isArray(d.shared_mcp_visible)) d.shared_mcp_visible = [];
    d.skin ??= "";
    d.skin_palette ??= "";
    d.welcome_mascot ??= "";
    d.editor_font_size ??= 14;
    d.editor_font_family ??= "JetBrains Mono";
    d.editor_tab_size ??= 4;
    d.editor_insert_spaces ??= true;
    d.editor_word_wrap ??= "off";
    d.editor_minimap ??= false;
    d.editor_line_numbers ??= true;
    d.editor_edit_highlight ??= true;
    d.editor_auto_save ??= "off";
    d.editor_persist_tabs ??= true;
    d.editor_follow_active ??= false;
    d.editor_ratio ??= 50;
    d.chat_width ??= 60;
    d.assistant_name ??= "Assistant";
    delete d.assistant_icon;
    delete d.assistant_avatar;
    d.mcp_servers = normaliserServeursMcp(d.mcp_servers);
    return d;
  }

  // Compte dont le document est en mémoire : après un changement de compte, la fenêtre attend le sien.
  let compteDocument: string | null = null;

  /** Relit le document ; une clé changée depuis `base` (saisie pendant la lecture) garde sa valeur affichée. Rend le document reçu, ou null. */
  async function loadSettingsData(
    base = JSON.stringify(settings.value),
    modeles = true,
  ): Promise<string | null> {
    void dep.loadAppSkins();
    const compte = user.value?.username ?? null;
    try {
      const res = await fetchAuth("/api/settings", {}, true);
      if (!res?.ok) return null;
      const recu = completerDefauts(objet(await corpsJson(res)) as ReglagesApp);
      compteDocument = compte;
      const instantane = JSON.stringify(recu);
      const affiche = settings.value as Record<string, unknown>;
      for (const k of clesDifferentes(objet(JSON.parse(base)), affiche)) {
        if (affiche[k] === undefined) delete recu[k];
        else recu[k] = affiche[k];
      }
      if (JSON.stringify(recu) !== JSON.stringify(affiche)) {
        dep.reinitialiserEpingles();
        settings.value = recu;
      }
      // Sélecteur affiché ou non : le premier envoi a besoin du modèle et de ses réglages (ensuite : événements système et sondage).
      if (modeles) void ctx.loadAvailableModels?.();
      if (!window.__ADMIN_ONLY_MODE__) void dep.loadSharedMcpServers();
      return instantane;
    } catch {
      return null;
    }
  }

  const chargeursOnglet: Record<string, () => unknown> = {
    ai_models: () => dep.loadLlmConnectors(),
    usage: () => dep.loadUsageData(),
    memory: () => dep.loadUserMemory(),
    prompts: () => Promise.all([dep.loadSavedPrompts(), dep.loadPromptTemplates()]),
    archives: () => dep.loadArchives(),
    sandbox: () => dep.loadSandboxState(),
    connectors: () => dep.loadGitConnectors(),
    secrets: () => Promise.all([dep.loadSecrets(), dep.loadConnexions()]),
    skills: () => ctx.openSkillsTab?.(),
  };

  /** Relit les données d'un onglet (ouverture, choix dans le rail) ; un échec le laisse avec ses données précédentes. */
  async function chargerOnglet(id: string): Promise<void> {
    try {
      await chargeursOnglet[id]?.();
    } catch {
      /* onglet ouvert avec ses données précédentes */
    }
  }

  /** Montre la fenêtre aussitôt avec le document en mémoire ; document, modèles et onglet se relisent en parallèle, l'instantané suit le document reçu. */
  async function openSettings(): Promise<void> {
    if (showSettingsModal.value) return chargerOnglet(settingsTab.value);
    if (compteDocument !== (user.value?.username ?? null)) await loadSettingsData();
    const base = JSON.stringify(settings.value);
    persistance.snapshot.value = base;
    dep.cancelMemoryEdit();
    void dep.loadSavedPrompts();
    void dep.loadArchives();
    showSettingsModal.value = true;
    void nextTick(() => settingsDialogEl.value?.focus());
    if (settings.value.enable_model_selector) void ctx.loadAvailableModels?.();
    void chargerOnglet(settingsTab.value);
    const recu = await loadSettingsData(base, false);
    if (recu === null || !showSettingsModal.value) return;
    persistance.snapshot.value = recu;
    if (persistance.settingsDirty.value) void persistance.viderEnAttente();
  }

  /** Ouvre sur un onglet précis ; « onglet:vue » cible une section (« appearance:mascotte ») ou une sous-vue (« prompts:templates »). */
  async function openSettingsTab(tab?: string): Promise<void> {
    // L'ancien onglet Agents est devenu une page : la modale se referme (ou ne s'ouvre pas) et la page s'ouvre.
    if (tab === "agents") {
      if (showSettingsModal.value) await closeSettings();
      if (!showSettingsModal.value) await ctx.openAgentsPage?.();
      return;
    }
    if (!tab) return openSettings();
    const [brut = tab, sousBrut = ""] = tab.indexOf(":") > 0 ? tab.split(":") : [tab];
    const ancien = ANCIENS_ONGLETS[brut];
    const cible = ancien?.onglet ?? brut;
    const sous = sousBrut || ancien?.section || "";
    settingsTab.value = cible;
    if (sous && entreeRail(cible)?.sections?.some((x) => x.id === sous)) settingsSections.value[cible] = sous;
    const ouverture = openSettings();
    if (cible === "prompts" && sous === "templates") dep.startNewTemplate();
    await ouverture;
  }

  /** Ferme aussitôt, l'écriture en attente part derrière puis le document est relu ; seul `true` strict saute confirmation et relecture. */
  async function closeSettings(sauterRecharge?: unknown): Promise<void> {
    const saute = sauterRecharge === true;
    if (!saute && dep.etatsSales.some((e) => e.value)) {
      const ok = await openConfirm(
        "Abandonner les modifications ?",
        "Vos changements non enregistrés seront perdus.",
        true,
        "Abandonner",
      );
      if (!ok) return;
    }
    showSettingsModal.value = false;
    dep.stopSandboxPolling();
    showPasswordChange.value = false;
    passwordForm.value = { ...MOT_DE_PASSE_VIDE };
    dep.reinitialisations.forEach((f) => f());
    dep.cancelMemoryEdit();
    try {
      dep.cnxReset();
    } catch {
      /* au mieux */
    }
    void persistance.viderEnAttente().then(() => (saute ? null : loadSettingsData()));
  }

  async function changeMyPassword(): Promise<void> {
    if (persistance.passwordSaving.value) return;
    const f = passwordForm.value;
    if (!f.old_password || !f.new_password) return;
    if (f.new_password !== f.confirm_password) {
      showToast("Les mots de passe ne correspondent pas", "error");
      return;
    }
    persistance.passwordSaving.value = true;
    try {
      const res = await fetchAuth("/api/users/change-password", {
        method: "POST",
        headers: ENTETES_JSON,
        body: JSON.stringify({ old_password: f.old_password, new_password: f.new_password }),
      });
      if (res?.ok) {
        showToast("Mot de passe mis à jour !");
        passwordForm.value = { ...MOT_DE_PASSE_VIDE };
        showPasswordChange.value = false;
      } else {
        showToast(detailErreur(await corpsJson(res)) || "Erreur", "error");
      }
    } catch {
      showToast("Erreur réseau", "error");
    } finally {
      persistance.passwordSaving.value = false;
    }
  }

  const fichierChoisi = (event: Event): File | null =>
    (event.target instanceof HTMLInputElement ? event.target.files?.[0] : undefined) ?? null;

  const avatarARecadrer: Ref<File | null> = shallowRef(null);

  /** Le fichier choisi ouvre la fenêtre de recadrage ; le champ est vidé pour qu'un même fichier puisse être repris. */
  function uploadAvatar(event: Event): void {
    const file = fichierChoisi(event);
    if (event.target instanceof HTMLInputElement) event.target.value = "";
    if (file) avatarARecadrer.value = file;
  }
  function annulerRecadrageAvatar(): void {
    avatarARecadrer.value = null;
  }
  function erreurRecadrageAvatar(message: string): void {
    avatarARecadrer.value = null;
    showToast(message, "error");
  }
  /** Envoie l'image recadrée (carrée, redimensionnée par le navigateur) à la route de la photo de profil. */
  async function envoyerAvatar(file: File): Promise<void> {
    avatarARecadrer.value = null;
    const formData = new FormData();
    formData.append("file", file, file.name);
    try {
      const res = await fetchAuth("/api/settings/avatar", { method: "POST", body: formData });
      const d = await lireSchema(res, schemaReponseAvatar);
      if (d && user.value) user.value.avatar = d.avatar;
      else if (!d) showToast(detailErreur(await corpsJson(res)) || "Photo non enregistrée", "error");
    } catch {
      showToast("Erreur réseau", "error");
    }
  }
  async function removeAvatar(): Promise<void> {
    const ok = await openConfirm("Supprimer la photo de profil ?", "", true);
    if (!ok) return;
    try {
      const res = await fetchAuth("/api/settings/avatar", { method: "DELETE" });
      if (res?.ok && user.value) user.value.avatar = "";
    } catch {
      /* avatar inchangé */
    }
  }
  return {
    settingsDialogEl,
    settingsTab,
    settingsSections,
    showPasswordChange,
    passwordForm,
    loadSettingsData,
    openSettings,
    openSettingsTab,
    chargerOnglet,
    closeSettings,
    changeMyPassword,
    uploadAvatar,
    removeAvatar,
    avatarARecadrer,
    annulerRecadrageAvatar,
    erreurRecadrageAvatar,
    envoyerAvatar,
  };
}
