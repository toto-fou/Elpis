// SPDX-License-Identifier: MIT
/** frontend/src/features/reglages/modale.ts — modale Paramètres : chargement du document avec ses défauts, ouverture (par onglet), fermeture avec confirmation, mot de passe et photo de profil recadrée. */
import { schemaReponseAvatar } from "@elpis/contracts";
import { shallowRef } from "vue";
import type { Ref } from "vue";

import { corpsJson, detailErreur, estObjet, lireSchema, objet } from "../../utils/lecture-json";
import { normaliserServeursMcp } from "./mcp";
import type { Persistance } from "./persistance";
import type { CtxReglages, ReglagesApp, RefsReglages, VueReglages } from "./types";

const ENTETES_JSON = { "Content-Type": "application/json" };
const MOT_DE_PASSE_VIDE = { old_password: "", new_password: "", confirm_password: "" };

/** Services des autres familles que la modale pilote à l'ouverture, à la fermeture et au changement d'onglet. */
export interface DependancesModale {
  loadAppSkins(): Promise<boolean>;
  loadSharedMcpServers(): Promise<void>;
  reinitialiserEpingles(): void;
  loadSavedPrompts(): Promise<void>;
  loadSharedPrompts(): Promise<void>;
  loadPromptTemplates(): Promise<void>;
  loadArchives(): Promise<void>;
  loadLlmConnectors(): Promise<void>;
  loadUsageData(): Promise<void>;
  loadUserMemory(): Promise<void>;
  loadSandboxState(): Promise<void>;
  loadGitConnectors(): Promise<void>;
  loadConnexions(): Promise<void>;
  cnxReset(): void;
  cancelMemoryEdit(): void;
  startNewTemplate(): void;
  stopSandboxPolling(): void;
  reinitialisations: readonly (() => void)[];
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
    d.classic_ui ??= false;
    d.voice_input_enabled ??= false;
    d.voice_reply_enabled ??= false;
    d.voice_reply_tools_enabled ??= false;
    d.memory_enabled ??= false;
    d.image_enabled ??= true;
    d.image_tool_enabled ??= true;
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
    d.welcome_mascot ??= "boite_or";
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

  async function loadSettingsData(): Promise<void> {
    void dep.loadAppSkins();
    try {
      const res = await fetchAuth("/api/settings", {}, true);
      if (res?.ok) {
        const brut = objet(await corpsJson(res));
        dep.reinitialiserEpingles();
        settings.value = completerDefauts(brut as ReglagesApp);
        if (settings.value.enable_model_selector) await ctx.loadAvailableModels?.();
        if (!window.__ADMIN_ONLY_MODE__) void dep.loadSharedMcpServers();
      }
    } catch {
      /* réglages inchangés */
    }
  }

  /** Une table littérale alignée sur les boutons de la barre latérale : chaque onglet relit ses données. */
  function chargeursOnglet(): Record<string, () => unknown> {
    return {
      ai_models: () => dep.loadLlmConnectors(),
      usage: () => dep.loadUsageData(),
      memory: () => dep.loadUserMemory(),
      prompts: () => Promise.all([dep.loadSavedPrompts(), dep.loadPromptTemplates()]),
      archives: () => dep.loadArchives(),
      sandbox: () => dep.loadSandboxState(),
      connectors: () => dep.loadGitConnectors(),
      connexions: () => dep.loadConnexions(),
      agents: () => ctx.loadMcpUserCategories?.(),
      skills: () => ctx.openSkillsTab?.(),
    };
  }

  async function openSettings(): Promise<void> {
    await loadSettingsData();
    persistance.snapshot.value = JSON.stringify(settings.value);
    dep.cancelMemoryEdit();
    void dep.loadSavedPrompts();
    void dep.loadSharedPrompts();
    void dep.loadArchives();
    const rouvert = chargeursOnglet()[settingsTab.value];
    if (rouvert) {
      try {
        await rouvert();
      } catch {
        /* au mieux */
      }
    }
    showSettingsModal.value = true;
    try {
      await nextTick();
      settingsDialogEl.value?.focus();
    } catch {
      /* focus indisponible */
    }
  }

  /** Ouvre sur un onglet précis ; « onglet:vue » cible une sous-vue (« prompts:templates »). */
  async function openSettingsTab(tab?: string): Promise<void> {
    await openSettings();
    if (!tab) return;
    const [cible = tab, sous = ""] = tab.indexOf(":") > 0 ? tab.split(":") : [tab];
    settingsTab.value = cible;
    const charger = chargeursOnglet()[cible];
    if (charger) {
      try {
        await charger();
      } catch {
        /* onglet ouvert quand même */
      }
    }
    if (cible === "prompts" && sous === "templates") dep.startNewTemplate();
  }

  /** Seul `true` strict signifie « ne pas recharger » (un événement DOM, truthy, ne le signifie pas). */
  async function closeSettings(sauterRecharge?: unknown): Promise<void> {
    const saute = sauterRecharge === true;
    await persistance.viderEnAttente();
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
    if (!saute) {
      try {
        void loadSettingsData();
      } catch {
        /* au mieux */
      }
    }
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
    showPasswordChange,
    passwordForm,
    loadSettingsData,
    openSettings,
    openSettingsTab,
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
