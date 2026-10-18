// SPDX-License-Identifier: MIT
/** frontend/src/features/reglages/prompts.ts — Paramètres › Prompts : prompts sauvegardés, templates à raccourci, prompts partagés reçus, boîte de réception et fenêtre de partage. */
import {
  schemaReponseBoiteReception,
  schemaReponseComptesLite,
  schemaReponseModelesPrompt,
  schemaReponsePrompts,
  schemaReponsePromptsPartages,
  schemaReponseSuppressionPrompts,
} from "@elpis/contracts";
import type { ModelePrompt, Prompt, PromptPartage } from "@elpis/contracts";
import type { Ref } from "vue";

import { corpsJson, detailErreur, lireSchema, objet, texte } from "../../utils/lecture-json";
import { elpisTemplates } from "../chat/composeur/templates";
import type { AnalyseTemplate } from "../chat/composeur/templates";
import type { CtxReglages, RefsReglages, VueReglages } from "./types";

const ENTETES_JSON = { "Content-Type": "application/json" };

export type ModeTriPrompts = "recent" | "ancien" | "titre";

export interface FormulaireTemplate {
  id: number | null;
  name: string;
  title: string;
  content: string;
}

export interface CompteLite {
  id: number;
  username: string;
  groups: string;
}
export interface GroupeLite {
  id: number;
  name: string;
}
export interface GroupeAffiche {
  groupLabel: string | null;
  users: CompteLite[];
}

/** API des templates du composeur (analyse, validité d'un raccourci). */
export interface ApiTemplates {
  parse(contenu: string): AnalyseTemplate;
  validName(nom: string): boolean;
}

export interface LiensPrompts {
  closeSettings(): Promise<void>;
}

/** Insensible à la casse et aux accents, caractère par caractère (les index restent valables dans le texte d'origine). */
function normaliser(s: unknown): string {
  let sortie = "";
  for (const c of String(s ?? "")) {
    const d = c.normalize("NFD").replace(/[̀-ͯ]/g, "");
    sortie += d || c;
  }
  return sortie.toLowerCase();
}

/** Raccourci proposé depuis un titre : « Résumé d'un texte » devient « resume-d-un-texte ». */
function slugModele(s: string): string {
  return normaliser(s)
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-")
    .slice(0, 40)
    .replace(/-+$/, "");
}

const AIDE_SYNTAXE_TEMPLATE =
  'Variables : {{nom}} · {{nom | textarea}} · {{nom | select:options=["a","b"]}}\n' +
  'Options : :placeholder="…" :default="…" :required\n' +
  "Automatiques : {{date}} {{heure}} {{jour}} {{utilisateur}} {{presse_papier}}\n" +
  "Dans le chat : /template <raccourci>";

function signaler(nom: string): void {
  try {
    window.dispatchEvent(new Event(nom));
  } catch {
    /* pas de fenêtre */
  }
}

export function creerPrompts(
  vue: VueReglages,
  refs: RefsReglages,
  ctx: CtxReglages,
  showSettingsModal: Ref<boolean>,
  liens: LiensPrompts,
) {
  const { computed, nextTick, ref, watch } = vue;
  const { showToast, openConfirm, openPrompt, fetchAuth } = ctx;
  const { inputMessage, inputRef } = refs;

  const savedPromptsList: Ref<Prompt[]> = ref([]);
  const promptSearch = ref("");
  const promptSort: Ref<ModeTriPrompts> = ref("recent");
  const promptOpen: Ref<Record<string, boolean>> = ref({});

  const togglePrompt = (id: number | string): void => {
    promptOpen.value = { ...promptOpen.value, [id]: !promptOpen.value[id] };
  };

  async function loadSavedPrompts(): Promise<void> {
    try {
      const d = await lireSchema(await fetchAuth("/api/prompts", {}, true), schemaReponsePrompts);
      if (d) savedPromptsList.value = d.items;
    } catch {
      /* liste inchangée */
    }
  }

  /** Copie le prompt tel quel (texte source, jamais rendu en Markdown) ; repli `execCommand` hors contexte sécurisé. */
  async function copyPrompt(content: string): Promise<void> {
    if (!content) return;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(content);
      } else {
        const ta = document.createElement("textarea");
        ta.value = content;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
      }
      showToast("Prompt copié");
    } catch (e) {
      showToast("Impossible de copier : " + (e instanceof Error ? e.message : ""), "error");
    }
  }

  const promptsAffiches = computed(() => {
    const q = normaliser(promptSearch.value).trim();
    let items = savedPromptsList.value.slice();
    if (q) items = items.filter((p) => normaliser((p.title || "") + " " + (p.content || "")).includes(q));
    const mode = promptSort.value;
    items.sort((a, b) => {
      if (mode === "titre")
        return String(a.title || "").localeCompare(String(b.title || ""), "fr", { sensitivity: "base" });
      const ta = Number(a.created_at) || 0;
      const tb = Number(b.created_at) || 0;
      return mode === "ancien" ? ta - tb : tb - ta;
    });
    return items;
  });

  function promptDate(ts: unknown): string {
    if (!ts) return "";
    try {
      return new Date(Number(ts) * 1000).toLocaleDateString("fr-FR", {
        day: "2-digit",
        month: "short",
        year: "numeric",
      });
    } catch {
      return "";
    }
  }
  function promptDateFull(ts: unknown): string {
    if (!ts) return "";
    try {
      return new Date(Number(ts) * 1000).toLocaleString("fr-FR");
    } catch {
      return "";
    }
  }

  /** Extrait centré sur la correspondance (vide si trouvé par le titre ou si les longueurs divergent). */
  function promptExtrait(p: Pick<Prompt, "content"> | null | undefined): string {
    const q = normaliser(promptSearch.value).trim();
    if (!q) return "";
    const brut = String(p?.content ?? "");
    const norm = normaliser(brut);
    const i = norm.indexOf(q);
    if (i < 0 || norm.length !== brut.length) return "";
    const debut = Math.max(0, i - 35);
    const fin = Math.min(brut.length, i + q.length + 55);
    return (
      (debut > 0 ? "…" : "") +
      brut.slice(debut, fin).replace(/\s+/g, " ").trim() +
      (fin < brut.length ? "…" : "")
    );
  }

  async function saveThisPrompt(content: string): Promise<void> {
    const title = await openPrompt("Sauvegarder", "");
    if (!title) return;
    try {
      await fetchAuth("/api/prompts", {
        method: "POST",
        headers: ENTETES_JSON,
        body: JSON.stringify({ title, content }),
      });
      signaler("prompts:changed");
    } catch {
      /* au mieux */
    }
  }

  async function deleteSavedPrompt(id: number, title?: string): Promise<void> {
    const confirme = await openConfirm("Supprimer ce prompt ?", title || "", true, "Supprimer");
    if (!confirme) return;
    try {
      await fetchAuth(`/api/prompts/${id}`, { method: "DELETE" });
      void loadSavedPrompts();
      signaler("prompts:changed");
    } catch {
      /* au mieux */
    }
  }

  /** Ferme les Paramètres par le chemin officiel avant d'insérer ; refus d'abandonner : rien n'est inséré. */
  async function inserer(content: string): Promise<void> {
    inputMessage.value = content;
    void nextTick(() => {
      void ctx.autoResize?.();
      inputRef.value?.focus();
    });
  }
  async function usePrompt(content: string): Promise<void> {
    await liens.closeSettings();
    if (showSettingsModal.value) return;
    await inserer(content);
  }

  // ── Templates ────────────────────────────────────────────────────────────
  const promptsView: Ref<"saved" | "templates"> = ref("saved");
  const templatesList: Ref<ModelePrompt[]> = ref([]);
  const templateSearch = ref("");
  const templateOpen: Ref<Record<string, boolean>> = ref({});
  const templateForm: Ref<FormulaireTemplate | null> = ref(null);
  const templateFormSnap = ref("");
  const templateSaving = ref(false);
  const templateFormError = ref("");
  const templateDirty = computed(
    () => !!templateForm.value && JSON.stringify(templateForm.value) !== templateFormSnap.value,
  );
  const templateSyntaxHelp = AIDE_SYNTAXE_TEMPLATE;

  async function loadPromptTemplates(): Promise<void> {
    try {
      const d = await lireSchema(
        await fetchAuth("/api/prompt-templates", {}, true),
        schemaReponseModelesPrompt,
      );
      if (d) templatesList.value = d.items;
    } catch {
      /* liste inchangée */
    }
  }

  const templatesAffiches = computed(() => {
    const q = normaliser(templateSearch.value).trim();
    let items = templatesList.value.slice();
    if (q)
      items = items.filter((t) =>
        normaliser(t.name + " " + (t.title || "") + " " + (t.content || "")).includes(q),
      );
    return items.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  });

  function templateVarsOf(t: { content?: string } | null | undefined): AnalyseTemplate {
    const api: ApiTemplates = elpisTemplates;
    if (!t) return { vars: [], system: [] };
    return api.parse(t.content || "");
  }
  const templateFormVars = computed(() => templateVarsOf(templateForm.value));

  const toggleTemplate = (id: number | string): void => {
    templateOpen.value = { ...templateOpen.value, [id]: !templateOpen.value[id] };
  };

  function ouvrirFormulaireTemplate(data: Partial<FormulaireTemplate>): void {
    promptsView.value = "templates";
    templateForm.value = {
      id: data.id || null,
      name: data.name || "",
      title: data.title || "",
      content: data.content || "",
    };
    templateFormSnap.value = JSON.stringify(templateForm.value);
    templateFormError.value = "";
    void nextTick(() => {
      document.getElementById(data.id ? "tpl-content" : "tpl-name")?.focus();
    });
  }
  const startNewTemplate = (prefill?: Partial<FormulaireTemplate>): void =>
    ouvrirFormulaireTemplate(prefill ?? {});
  const editTemplate = (t: ModelePrompt | null | undefined): void => {
    if (t) ouvrirFormulaireTemplate(t);
  };
  function templateFromPrompt(p: Pick<Prompt, "title" | "content"> | null | undefined): void {
    if (!p) return;
    ouvrirFormulaireTemplate({
      name: slugModele(p.title || ""),
      title: p.title || "",
      content: p.content || "",
    });
  }
  function templateTitleBlur(): void {
    const f = templateForm.value;
    if (f && !f.id && !f.name.trim() && f.title.trim()) f.name = slugModele(f.title);
  }

  async function cancelTemplateEdit(): Promise<void> {
    if (templateDirty.value) {
      const ok = await openConfirm(
        "Abandonner ce template ?",
        "Les modifications seront perdues.",
        true,
        "Abandonner",
      );
      if (!ok) return;
    }
    templateForm.value = null;
    templateFormError.value = "";
  }

  async function saveTemplate(): Promise<void> {
    const f = templateForm.value;
    if (!f || templateSaving.value) return;
    const name = String(f.name || "")
      .trim()
      .replace(/^\//, "")
      .toLowerCase();
    const api: ApiTemplates = elpisTemplates;
    if (!api.validName(name)) {
      templateFormError.value = "Raccourci : minuscules, chiffres, - et _, sans espace.";
      return;
    }
    if (!String(f.content || "").trim()) {
      templateFormError.value = "Contenu requis.";
      return;
    }
    templateSaving.value = true;
    templateFormError.value = "";
    try {
      const res = await fetchAuth(f.id ? `/api/prompt-templates/${f.id}` : "/api/prompt-templates", {
        method: f.id ? "PUT" : "POST",
        headers: ENTETES_JSON,
        body: JSON.stringify({ name, title: f.title || "", content: f.content }),
      });
      if (res?.ok) {
        showToast(f.id ? "Template mis à jour" : "Template créé : /template " + name, "success");
        templateForm.value = null;
        await loadPromptTemplates();
        signaler("templates:changed");
      } else {
        templateFormError.value = detailErreur(await corpsJson(res)) || "Enregistrement refusé";
      }
    } catch {
      templateFormError.value = "Erreur réseau";
    } finally {
      templateSaving.value = false;
    }
  }

  async function deleteTemplate(t: ModelePrompt | null | undefined): Promise<void> {
    if (!t) return;
    const ok = await openConfirm("Supprimer ce template ?", "/template " + t.name, true, "Supprimer");
    if (!ok) return;
    try {
      const res = await fetchAuth(`/api/prompt-templates/${t.id}`, { method: "DELETE" });
      if (res?.ok) {
        if (templateForm.value?.id === t.id) templateForm.value = null;
        await loadPromptTemplates();
        signaler("templates:changed");
      } else showToast("Suppression refusée", "error");
    } catch {
      showToast("Erreur réseau", "error");
    }
  }

  /** « Insérer » : même chemin que « /template » dans le chat, après fermeture des Paramètres. */
  async function insertTemplate(t: ModelePrompt): Promise<void> {
    await liens.closeSettings();
    if (showSettingsModal.value) return;
    ctx.openTemplate?.(t);
  }

  // ── Prompts partagés reçus et boîte de réception ─────────────────────────
  const showSharedPrompts = ref(false);
  const sharedPromptsList: Ref<PromptPartage[]> = ref([]);
  const inboxCount = ref(0);
  const sharedSelectMode = ref(false);
  const sharedSelected: Ref<number[]> = ref([]);
  let minuterieBoite: ReturnType<typeof setInterval> | null = null;

  async function loadSharedPrompts(): Promise<void> {
    try {
      const d = await lireSchema(
        await fetchAuth("/api/prompts/shared", {}, true),
        schemaReponsePromptsPartages,
      );
      if (d) sharedPromptsList.value = d.items;
    } catch {
      /* liste inchangée */
    }
  }

  async function refreshInboxCount(): Promise<void> {
    try {
      const d = await lireSchema(await fetchAuth("/api/inbox/count", {}, true), schemaReponseBoiteReception);
      if (d) inboxCount.value = d.count || 0;
    } catch {
      /* compteur inchangé */
    }
  }

  function startInboxPolling(): void {
    void refreshInboxCount();
    if (minuterieBoite) clearInterval(minuterieBoite);
    minuterieBoite = setInterval(() => {
      if (document.visibilityState === "visible") void refreshInboxCount();
    }, 30000);
  }
  function stopInboxPolling(): void {
    if (minuterieBoite) {
      clearInterval(minuterieBoite);
      minuterieBoite = null;
    }
  }

  async function useSharedPrompt(content: string): Promise<void> {
    showSharedPrompts.value = false;
    if (showSettingsModal.value) {
      await liens.closeSettings();
      if (showSettingsModal.value) return;
    }
    await inserer(content);
  }

  async function deleteSharedPrompt(
    id: number,
    event: Event | null | undefined,
    title?: string,
  ): Promise<void> {
    if (event) event.stopPropagation();
    const confirme = await openConfirm("Supprimer ce partage ?", title || "", true, "Supprimer");
    if (!confirme) return;
    try {
      const res = await fetchAuth(`/api/prompts/shared/${id}`, { method: "DELETE" });
      if (res?.ok) {
        void loadSharedPrompts();
        void refreshInboxCount();
      }
    } catch {
      /* au mieux */
    }
  }

  async function clearAllSharedPrompts(): Promise<void> {
    const n = sharedPromptsList.value.length;
    const confirme = await openConfirm(
      "Vider les partages reçus ?",
      n ? `${n} partage(s) seront supprimés.` : "",
      true,
      "Vider",
    );
    if (!confirme) return;
    try {
      const res = await fetchAuth("/api/prompts/shared/all", { method: "DELETE" });
      if (res?.ok) {
        void loadSharedPrompts();
        void refreshInboxCount();
      }
    } catch {
      /* au mieux */
    }
  }

  const toggleSharedSelect = (id: number): void => {
    const i = sharedSelected.value.indexOf(id);
    if (i >= 0) sharedSelected.value.splice(i, 1);
    else sharedSelected.value.push(id);
  };

  async function deleteSelectedSharedPrompts(): Promise<void> {
    const confirme = await openConfirm(`Supprimer ${sharedSelected.value.length} prompt(s) ?`, "", true);
    if (!confirme) return;
    try {
      const res = await fetchAuth("/api/prompts/shared/delete-batch", {
        method: "POST",
        headers: ENTETES_JSON,
        body: JSON.stringify({ ids: sharedSelected.value }),
      });
      const d = await lireSchema(res, schemaReponseSuppressionPrompts);
      if (d) {
        showToast(`${d.deleted} prompt(s) supprimé(s)`);
        sharedSelected.value = [];
        sharedSelectMode.value = false;
        void loadSharedPrompts();
      }
    } catch {
      showToast("Erreur réseau", "error");
    }
  }

  // ── Fenêtre de partage ───────────────────────────────────────────────────
  const isShareModalOpen = ref(false);
  const promptToShare: Ref<Prompt | null> = ref(null);
  const allUsersLite: Ref<CompteLite[]> = ref([]);
  const myGroups: Ref<GroupeLite[]> = ref([]);
  const selectedGroupFilter: Ref<number | null> = ref(null);
  const shareTargetUsers: Ref<number[]> = ref([]);
  const selectAllUsers = ref(false);
  const shareSending = ref(false);

  /** `[{groupLabel, users}]` pour l'affichage groupé, ou une liste plate quand un filtre est actif. */
  const groupedShareUsers = computed<GroupeAffiche[]>(() => {
    const users = allUsersLite.value;
    if (selectedGroupFilter.value) {
      const gname = myGroups.value.find((g) => g.id === selectedGroupFilter.value)?.name;
      const filtres = gname ? users.filter((u) => u.groups && u.groups.split(", ").includes(gname)) : users;
      return [{ groupLabel: gname || "Groupe", users: filtres }];
    }
    if (!myGroups.value.length) return [{ groupLabel: null, users }];
    const groupes: Record<string, CompteLite[]> = {};
    const sansGroupe: CompteLite[] = [];
    users.forEach((u) => {
      const gs = u.groups ? u.groups.split(", ").filter(Boolean) : [];
      if (!gs.length) {
        sansGroupe.push(u);
        return;
      }
      gs.forEach((g) => (groupes[g] ??= []).push(u));
    });
    const resultat: GroupeAffiche[] = Object.entries(groupes)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([label, us]) => ({
        groupLabel: label,
        users: us.sort((a, b) => a.username.localeCompare(b.username)),
      }));
    if (sansGroupe.length) resultat.push({ groupLabel: "Sans groupe", users: sansGroupe });
    return resultat;
  });
  const filteredShareUsers = computed(() => groupedShareUsers.value.flatMap((g) => g.users));

  async function openShareModal(prompt: Prompt): Promise<void> {
    promptToShare.value = prompt;
    shareTargetUsers.value = [];
    selectAllUsers.value = false;
    selectedGroupFilter.value = null;
    isShareModalOpen.value = true;
    try {
      const d = await lireSchema(await fetchAuth("/api/users/lite", {}, true), schemaReponseComptesLite);
      if (d) {
        allUsersLite.value = d.users;
        myGroups.value = d.my_groups;
      }
    } catch {
      /* listes inchangées */
    }
  }

  function toggleSelectAllUsers(): void {
    shareTargetUsers.value = selectAllUsers.value ? filteredShareUsers.value.map((u) => u.id) : [];
  }
  watch(shareTargetUsers, (valeur) => {
    selectAllUsers.value =
      filteredShareUsers.value.length > 0 && valeur.length === filteredShareUsers.value.length;
  });

  async function confirmShare(): Promise<void> {
    if (shareTargetUsers.value.length === 0 || !promptToShare.value || shareSending.value) return;
    shareSending.value = true;
    try {
      const res = await fetchAuth("/api/prompts/share", {
        method: "POST",
        headers: ENTETES_JSON,
        body: JSON.stringify({ prompt_id: promptToShare.value.id, user_ids: shareTargetUsers.value }),
      });
      if (res?.ok) {
        showToast("Prompt partagé");
        isShareModalOpen.value = false;
      } else {
        const err = res ? objet(await corpsJson(res)) : {};
        showToast(texte(err["detail"]) || "Échec du partage", "error");
      }
    } catch {
      showToast("Erreur réseau — partage non effectué", "error");
    } finally {
      shareSending.value = false;
    }
  }

  /** Remise à plat à la fermeture des Paramètres (recherche, dépliages, sélection). */
  function reinitialiserAFermeture(): void {
    sharedSelectMode.value = false;
    sharedSelected.value = [];
    promptSearch.value = "";
    promptOpen.value = {};
  }

  return {
    savedPromptsList,
    promptSearch,
    promptSort,
    promptOpen,
    promptsAffiches,
    togglePrompt,
    promptDate,
    promptDateFull,
    promptExtrait,
    copyPrompt,
    loadSavedPrompts,
    saveThisPrompt,
    deleteSavedPrompt,
    usePrompt,
    promptsView,
    templatesList,
    templateSearch,
    templateOpen,
    templateForm,
    templateSaving,
    templateFormError,
    templateDirty,
    templateSyntaxHelp,
    templatesAffiches,
    templateFormVars,
    templateVarsOf,
    toggleTemplate,
    loadPromptTemplates,
    startNewTemplate,
    editTemplate,
    templateFromPrompt,
    templateTitleBlur,
    cancelTemplateEdit,
    saveTemplate,
    deleteTemplate,
    insertTemplate,
    showSharedPrompts,
    sharedPromptsList,
    inboxCount,
    sharedSelectMode,
    sharedSelected,
    loadSharedPrompts,
    useSharedPrompt,
    deleteSharedPrompt,
    clearAllSharedPrompts,
    refreshInboxCount,
    startInboxPolling,
    stopInboxPolling,
    toggleSharedSelect,
    deleteSelectedSharedPrompts,
    isShareModalOpen,
    promptToShare,
    allUsersLite,
    myGroups,
    selectedGroupFilter,
    shareTargetUsers,
    selectAllUsers,
    shareSending,
    groupedShareUsers,
    filteredShareUsers,
    openShareModal,
    toggleSelectAllUsers,
    confirmShare,
    reinitialiserAFermeture,
  };
}
