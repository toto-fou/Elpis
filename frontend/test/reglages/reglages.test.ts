// SPDX-License-Identifier: MIT
/** frontend/test/reglages/reglages.test.ts — surface plate de `setupReglages` : toutes les clés de l'ancien `setupSettings`, document complété de ses défauts, enregistrement ciblé et instantané. */
import { nextTick, ref } from "vue";
import * as Vue from "vue";
import { describe, expect, it } from "vitest";

import { GestionnaireSession } from "../../src/features/auth/session";
import { setupReglages } from "../../src/features/reglages/reglages";
import type { CtxReglages, RefsReglages, ReglagesApp } from "../../src/features/reglages/types";
import { ClientHttp } from "../../src/platform/http/client";
import { json } from "../aides";

const CLES_ANCIENNE_SURFACE = [
  "persistAgentsEnabled",
  "persistLiveShell",
  "persistCompressionEnabled",
  "persistVoiceInput",
  "persistVoiceReply",
  "persistVoiceReplyTools",
  "voiceMicSupported",
  "voiceReadSupported",
  "voiceCompatInfo",
  "opencodeFamilyOn",
  "toggleOpencodeFamily",
  "compactionUnit",
  "compactionPct",
  "compactionTokensLabel",
  "compactionThresholdHint",
  "setCompactionUnit",
  "setCompactionPct",
  "setCompactionTokens",
  "persistCompactionThreshold",
  "compactionRoundsMode",
  "compactionRoundsHint",
  "setCompactionRoundsMode",
  "setCompactionRounds",
  "persistCompactionMaxRounds",
  "agentForm",
  "agentFormError",
  "startCreateAgent",
  "startEditAgent",
  "cancelAgentForm",
  "leaveAgentForm",
  "toggleAgentCat",
  "toggleAgentMcp",
  "saveAgentForm",
  "deleteCustomAgent",
  "CUSTOM_ITERS_MAX",
  "CUSTOM_AGENTS_MAX",
  "agentTemplates",
  "loadAgentTemplates",
  "agentBank",
  "agentCustomCount",
  "restoreTemplatePrompt",
  "agentFormPromptDiffers",
  "duplicateAgent",
  "toggleAgentEnabled",
  "resetAgentToTemplate",
  "insertAgentTemplate",
  "showSettingsModal",
  "showMcpManagerModal",
  "settingsTab",
  "savedPromptsList",
  "archivesList",
  "mcpSearch",
  "promptSearch",
  "promptSort",
  "promptOpen",
  "promptsAffiches",
  "togglePrompt",
  "promptDate",
  "promptDateFull",
  "promptExtrait",
  "copyPrompt",
  "archiveSelectMode",
  "archiveSelected",
  "unarchiveSelectedArchives",
  "showPasswordChange",
  "passwordForm",
  "APP_SKINS",
  "skinsDefaut",
  "loadAppSkins",
  "skinCourant",
  "nomMarque",
  "appDark",
  "themeMode",
  "applyThemeMode",
  "setThemeMode",
  "toggleThemeMode",
  "setAppSkin",
  "showSharedPrompts",
  "sharedPromptsList",
  "inboxCount",
  "sharedSelectMode",
  "sharedSelected",
  "isShareModalOpen",
  "promptToShare",
  "shareSending",
  "allUsersLite",
  "myGroups",
  "selectedGroupFilter",
  "filteredShareUsers",
  "groupedShareUsers",
  "shareTargetUsers",
  "selectAllUsers",
  "showHelpModal",
  "readmeContent",
  "isLoadingReadme",
  "helpDoc",
  "helpBodyRef",
  "switchHelpDoc",
  "pinnedServers",
  "agentMcpChoices",
  "sharedMcpServers",
  "loadSharedMcpServers",
  "isSharedVisible",
  "mcpAddPair",
  "mcpRemovePair",
  "loadSettingsData",
  "openSettings",
  "openSettingsTab",
  "closeSettings",
  "saveSettings",
  "changeMyPassword",
  "settingsSaving",
  "settingsDirty",
  "passwordSaving",
  "settingsDialogEl",
  "closeMcpManager",
  "openMcpManager",
  "mcpSel",
  "mcpForm",
  "mcpSale",
  "mcpGarde",
  "mcpConfirmer",
  "mcpErreurs",
  "mcpErreur",
  "mcpOccupe",
  "mcpFlash",
  "mcpTests",
  "mcpListePerso",
  "mcpListePartages",
  "mcpEstEpingle",
  "mcpBasculerPanneau",
  "mcpChoisir",
  "mcpNouveau",
  "mcpAppliquerModele",
  "mcpSetType",
  "mcpSetPortee",
  "mcpEffacerErreur",
  "mcpEnregistrer",
  "mcpTester",
  "mcpDemanderSuppression",
  "mcpAnnulerSuppression",
  "mcpSupprimer",
  "mcpAbandonner",
  "mcpGardeEnregistrer",
  "activateExternalServer",
  "uploadAvatar",
  "removeAvatar",
  "loadSavedPrompts",
  "saveThisPrompt",
  "deleteSavedPrompt",
  "usePrompt",
  "promptsView",
  "templatesList",
  "templateSearch",
  "templateOpen",
  "templateForm",
  "templateSaving",
  "templateFormError",
  "templateDirty",
  "templateSyntaxHelp",
  "templatesAffiches",
  "templateFormVars",
  "templateVarsOf",
  "toggleTemplate",
  "loadPromptTemplates",
  "startNewTemplate",
  "editTemplate",
  "templateFromPrompt",
  "templateTitleBlur",
  "cancelTemplateEdit",
  "saveTemplate",
  "deleteTemplate",
  "insertTemplate",
  "loadSharedPrompts",
  "useSharedPrompt",
  "deleteSharedPrompt",
  "clearAllSharedPrompts",
  "refreshInboxCount",
  "openShareModal",
  "toggleSelectAllUsers",
  "confirmShare",
  "loadArchives",
  "restoreArchive",
  "deleteArchive",
  "openHelp",
  "clearSandbox",
  "clearAllChats",
  "toggleArchiveSelect",
  "deleteSelectedArchives",
  "toggleSharedSelect",
  "deleteSelectedSharedPrompts",
  "startInboxPolling",
  "stopInboxPolling",
  "sandboxState",
  "sandboxBusy",
  "sandboxStatus",
  "sandboxTone",
  "transitionState",
  "activeNetProfile",
  "netMenuOpen",
  "toggleNetMenu",
  "pickNetProfile",
  "onNetMenuKeydown",
  "closeNetMenu",
  "netProfileMode",
  "netProfileDetail",
  "onChangeProfile",
  "loadSandboxState",
  "changeSandboxMode",
  "restartSandboxContainer",
  "destroySandboxContainer",
] as const;

function monter(route: (url: string, init?: RequestInit) => Response) {
  const appels: { url: string; methode: string; corps: string; brut?: unknown }[] = [];
  const fetchFaux = (url: string, init?: RequestInit): Promise<Response> => {
    appels.push({
      url,
      methode: init?.method ?? "GET",
      corps: typeof init?.body === "string" ? init.body : "",
      brut: init?.body,
    });
    return Promise.resolve(route(url, init));
  };
  const toasts: string[] = [];
  const settings = ref<ReglagesApp>({});
  const refs: RefsReglages = {
    user: ref({ username: "alice" }),
    settings,
    config: ref({ active_mcp_ids: [] }),
    inputMessage: ref(""),
    inputRef: ref(null),
  };
  const ctx: CtxReglages = {
    showToast: (m) => toasts.push(m),
    fetchAuth: (url, options) => fetchFaux(url, options),
    openConfirm: () => Promise.resolve(true),
    openPrompt: () => Promise.resolve(null),
  };
  const R = setupReglages(Vue, refs, ctx, new ClientHttp(new GestionnaireSession(), fetchFaux));
  return { R, appels, toasts, settings };
}

/** Champ fichier portant `fichier`, comme le `<input type="file">` de Paramètres › Profil. */
function champFichier(fichier: File): Event {
  const champ = document.createElement("input");
  champ.type = "file";
  Object.defineProperty(champ, "files", { value: [fichier] });
  return { target: champ } as unknown as Event;
}

describe("setupReglages", () => {
  it("expose toutes les clés de l'ancienne surface de setupSettings", () => {
    const { R } = monter(() => json({}));
    const absentes = CLES_ANCIENNE_SURFACE.filter((k) => !(k in R));
    expect(absentes).toEqual([]);
  });

  it("complète les défauts au chargement et leur applique le défaut serveur", async () => {
    const { R, settings } = monter((url) =>
      url === "/api/settings" ? json({ assistant_name: "Zoe" }) : json({}),
    );
    await R.loadSettingsData();
    expect(settings.value).toMatchObject({
      assistant_name: "Zoe",
      enable_mcp: true,
      voice_input_enabled: false,
      editor_font_size: 14,
      welcome_mascot: "",
      mcp_servers: [],
      custom_agents: [],
    });
  });

  it("réveil par les tâches de fond : actif par défaut, l'interrupteur n'envoie que jobs_wake", async () => {
    const { R, appels, settings } = monter((url) =>
      url === "/api/settings" ? json({}) : json({ ok: true }),
    );
    await R.loadSettingsData();
    expect(settings.value.jobs_wake).toBe(true);
    settings.value.jobs_wake = false;
    await R.persistJobsWake();
    const put = appels.filter((a) => a.methode === "PUT").at(-1);
    expect(JSON.parse(put?.corps ?? "{}")).toEqual({ jobs_wake: false });
  });

  it("une écriture ciblée n'envoie que ses clés, met l'instantané à jour et rejoue le retour arrière en cas d'échec", async () => {
    let refuser = false;
    const { R, appels, settings, toasts } = monter((url, init) => {
      if (url === "/api/settings" && init?.method === "PUT")
        return refuser ? json({ detail: "non" }, 500) : json({ ok: true });
      if (url === "/api/settings") return json({ skin: "elpis" });
      return json({});
    });
    await R.loadSettingsData();
    await R.openSettings();
    expect(R.settingsDirty.value).toBe(false);
    expect(await R.setAppSkin("inconnu")).toBe(false);
    refuser = true;
    expect(await R.setThemeMode("dark")).toBe(false);
    expect(settings.value.dark_mode).toBe(false);
    expect(toasts.at(-1)).toContain("Erreur serveur");
    refuser = false;
    expect(await R.setThemeMode("dark")).toBe(true);
    const put = appels.filter((a) => a.methode === "PUT").at(-1);
    expect(JSON.parse(put?.corps ?? "{}")).toEqual({ dark_mode: true, dark_mode_auto: false });
    await nextTick();
    expect(R.settingsDirty.value).toBe(false);
  });

  it("après « Ajouter » un serveur MCP perso, la liste relue du core remplace les secrets saisis", async () => {
    let stockes: Record<string, unknown>[] = [];
    let relectureKo = false;
    const { R, appels, settings } = monter((url, init) => {
      if (url !== "/api/settings") return json({});
      if (init?.method === "PUT") {
        const corps = JSON.parse(String(init.body)) as { mcp_servers?: Record<string, unknown>[] };
        if (corps.mcp_servers) stockes = corps.mcp_servers;
        return json({ ok: true });
      }
      if (relectureKo) return json({ detail: "non" }, 500);
      return json({
        mcp_servers: stockes.map(({ auth_secret, headers, ...s }) => ({
          ...s,
          has_auth: !!auth_secret,
          headers: ((headers ?? []) as { name: string; value: string }[]).map((h) => ({
            name: h.name,
            value: "",
            has_value: !!h.value,
          })),
        })),
      });
    });
    await R.loadSettingsData();
    await R.openSettings();
    const saisir = (nom: string): void => {
      R.mcpNouveau();
      Object.assign(R.mcpForm.value ?? {}, {
        name: nom,
        type: "http",
        url: "http://lan:4445/mcp",
        auth_mode: "bearer",
        auth_secret: "LE-BEARER",
        headers: [{ name: "X-Api-Key", value: "LA-CLE-API", has_value: false }],
      });
    };
    saisir("Wiki");
    expect(await R.mcpEnregistrer()).toBe(true);
    const put = appels.filter((a) => a.methode === "PUT").at(-1);
    expect(put?.corps).toContain("LE-BEARER");
    expect(put?.corps).toContain("LA-CLE-API");
    expect(JSON.stringify(settings.value)).not.toMatch(/LE-BEARER|LA-CLE-API/);
    await nextTick();
    expect(R.settingsDirty.value).toBe(false);
    const id = settings.value.mcp_servers?.[0]?.id ?? "";
    expect(R.mcpSel.value).toBe("p:" + id);
    expect(R.mcpForm.value).toMatchObject({ portee: "perso", id, has_auth: true, auth_secret: "" });
    expect(R.mcpForm.value?.headers).toEqual([{ name: "X-Api-Key", value: "", has_value: true }]);
    expect(R.mcpSale.value).toBe(false);
    relectureKo = true;
    saisir("Wiki 2");
    await R.mcpEnregistrer();
    expect(settings.value.mcp_servers).toHaveLength(2);
    expect(JSON.stringify(settings.value)).not.toMatch(/LE-BEARER|LA-CLE-API/);
    expect(settings.value.mcp_servers?.[1]).toMatchObject({ has_auth: true });
    await nextTick();
    expect(R.settingsDirty.value).toBe(false);
  });

  it("photo de profil : le choix ouvre le recadrage sans rien envoyer ; l'image validée part seule à la route existante", async () => {
    const { R, appels, toasts } = monter((url) =>
      url === "/api/settings/avatar" ? json({ ok: true, avatar: "1_5.png" }) : json({}),
    );
    const brute = new File([new Uint8Array(64)], "photo.jpg", { type: "image/jpeg" });
    R.uploadAvatar(champFichier(brute));
    expect(R.avatarARecadrer.value).toBe(brute);
    expect(appels.filter((a) => a.url === "/api/settings/avatar")).toEqual([]);
    R.annulerRecadrageAvatar();
    expect(R.avatarARecadrer.value).toBeNull();
    R.uploadAvatar(champFichier(brute));
    const recadree = new File([new Uint8Array(16)], "avatar.webp", { type: "image/webp" });
    await R.envoyerAvatar(recadree);
    expect(R.avatarARecadrer.value).toBeNull();
    const envoi = appels.find((a) => a.url === "/api/settings/avatar");
    expect(envoi?.methode).toBe("POST");
    const part = envoi?.brut instanceof FormData ? envoi.brut.get("file") : null;
    expect(part instanceof File && [part.name, part.size, part.type]).toEqual([
      "avatar.webp",
      16,
      "image/webp",
    ]);
    expect(toasts).toEqual([]);
    R.uploadAvatar(champFichier(brute));
    R.erreurRecadrageAvatar("Image illisible.");
    expect([R.avatarARecadrer.value, toasts]).toEqual([null, ["Image illisible."]]);
  });

  it("avatar de l'assistant : plus de choix d'icône ni d'image, valeurs héritées du serveur ignorées", async () => {
    const { R, settings } = monter((url) =>
      url === "/api/settings"
        ? json({ assistant_name: "Iris", assistant_icon: "ph-cat", assistant_avatar: "bot_1_2.png" })
        : json({}),
    );
    expect("uploadAssistantAvatar" in R || "removeAssistantAvatar" in R).toBe(false);
    await R.loadSettingsData();
    expect(settings.value.assistant_name).toBe("Iris");
    expect(settings.value).not.toHaveProperty("assistant_icon");
    expect(settings.value).not.toHaveProperty("assistant_avatar");
  });
});
