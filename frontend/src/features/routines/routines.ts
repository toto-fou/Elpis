// SPDX-License-Identifier: MIT
/** frontend/src/features/routines/routines.ts — page des routines : liste, vue lecture, formulaire par groupes, planification, webhook, journal vivant des runs. */
import { computed, ref } from "vue";
import type { Ref } from "vue";
import type { ResumeSkill, RunRoutine } from "@elpis/contracts";
import { restaurerMarqueursTour } from "@elpis/commun/marqueurs-tour";

import { BUILTIN_AGENTS } from "../../utils/utils-purs";
import type { ApiRoutines, CorpsFiltreWebhook, RoutineListee } from "./api";
import {
  MAX_SKILLS_ROUTINE,
  arbreSkills,
  badgeDomaine,
  elaguerSkills,
  idsConnus,
  infobulleSkill,
  libelleFeuille,
  nombreDescendants,
} from "./competences";
import {
  apercuRun,
  classeStatut,
  fichiersRun,
  formaterDuree,
  formaterHeure,
  formaterRelatif,
  libelleStatut,
  nomDeFichier,
  runEstMarkdown,
  runEstTronque,
  texteDetailRun,
} from "./journal";
import {
  PUCES_JOURS,
  borner,
  cronDepuisPlanification,
  cronEnTexte,
  planificationDepuisCron,
  planificationParDefaut,
  resumerPlanification,
} from "./planification";
import type { Planification } from "./planification";

export const PLAFOND_CONSERVATION = 500;
export const MODES_NOTIFICATION: ReadonlyArray<{ id: string; label: string }> = [
  { id: "all", label: "Toutes" },
  { id: "error", label: "Échecs seulement" },
  { id: "none", label: "Aucune" },
];
export const ONGLETS_EDITION: ReadonlyArray<{ id: string; label: string; icon: string }> = [
  { id: "general", label: "Général", icon: "ph-textbox" },
  { id: "schedule", label: "Planification", icon: "ph-clock" },
  { id: "prompt", label: "Tâche", icon: "ph-chat-text" },
  { id: "tools", label: "Outils", icon: "ph-plugs-connected" },
];

type Identifiant = number | string;
type Declencheur = "ok" | "error" | "always";

export interface ServeurExterne {
  id?: unknown;
  name?: unknown;
  type?: unknown;
  shared?: unknown;
  [cle: string]: unknown;
}

export interface FormulaireRoutine {
  name: string;
  model: string;
  connector_id: Identifiant | null;
  system_prompt: string;
  task_prompt: string;
  thinking_mode: boolean;
  enabled: boolean;
  agents_enabled: boolean;
  localCats: string[];
  externalServers: ServeurExterne[];
  skills: string[];
  trigger_after_id: Identifiant | null;
  trigger_after_on: Declencheur;
  runs_keep: number | string;
  notify_on: string;
  notify_keep: number | string;
}

export interface CategorieMcp {
  name: string;
  label?: string;
  icon?: string;
  [cle: string]: unknown;
}

export type ModeleRoutine = string | { id?: string; name?: string };

/** Contexte fourni par la racine historique (app.js). */
export interface CtxRoutines {
  showToast(message: string, type?: string): void;
  openConfirm(titre: string, texte: string, danger?: boolean): Promise<boolean>;
  engineModels?: (connecteur: Identifiant | null) => ModeleRoutine[] | null | undefined;
  loadEngines?: () => unknown;
  openFile?: (chemin: string) => unknown;
}

export interface RefsRoutines {
  currentView: Ref<string>;
}

type Minuterie = ReturnType<typeof setTimeout>;

function formulaireVide(): FormulaireRoutine {
  return {
    name: "",
    model: "",
    connector_id: null,
    system_prompt: "",
    task_prompt: "",
    thinking_mode: false,
    enabled: true,
    agents_enabled: false,
    localCats: [],
    externalServers: [],
    skills: [],
    trigger_after_id: null,
    trigger_after_on: "ok",
    runs_keep: 0,
    notify_on: "all",
    notify_keep: 0,
  };
}

function libelleNotification(v: string): string {
  return MODES_NOTIFICATION.find((m) => m.id === v)?.label ?? "Toutes";
}

function libelleConservation(n: unknown): string {
  const k = parseInt(String(n), 10);
  return k > 0 ? `${k} dernières` : "Toutes";
}

/** Libellés des serveurs MCP d'un instantané : catégories locales (libellé du formulaire) puis noms externes. */
export function resumeMcp(instantane: unknown, cats: readonly CategorieMcp[] | null | undefined): string[] {
  const parNom: Record<string, string> = {};
  for (const c of cats || []) if (c && c.name) parNom[c.name] = c.label || c.name;
  const sortie: string[] = [];
  const liste = Array.isArray(instantane) ? (instantane as unknown[]) : [];
  for (const cfg of liste) {
    if (!cfg || typeof cfg !== "object") continue;
    const c = cfg as { command?: unknown; filter_categories?: unknown; name?: unknown };
    if (c.command === "DEFAULT_LOCAL_PYTHON") {
      const filtres = Array.isArray(c.filter_categories) ? (c.filter_categories as string[]) : [];
      for (const f of filtres) sortie.push(parNom[f] || f);
    } else if (c.name) sortie.push(String(c.name));
  }
  return sortie;
}

function analyserInstantane(instantane: unknown): { localCats: string[]; externalServers: ServeurExterne[] } {
  const localCats: string[] = [];
  const externalServers: ServeurExterne[] = [];
  const liste = Array.isArray(instantane) ? (instantane as unknown[]) : [];
  for (const cfg of liste) {
    if (!cfg || typeof cfg !== "object") continue;
    const c = cfg as ServeurExterne;
    if (c["command"] === "DEFAULT_LOCAL_PYTHON") {
      const filtres = c["filter_categories"];
      if (Array.isArray(filtres)) for (const f of filtres) localCats.push(String(f));
    } else externalServers.push(c);
  }
  return { localCats, externalServers };
}

export function creerRoutines(api: ApiRoutines, refs: RefsRoutines, ctx: CtxRoutines) {
  const { currentView } = refs;
  const { showToast, openConfirm } = ctx;

  const routinesLoading = ref(false);
  const routinesBusy = ref(false);
  const routinesError = ref("");
  const routines = ref<RoutineListee[]>([]);
  const routineSkills = ref<ResumeSkill[]>([]);
  const routineSkillsLoading = ref(false);
  const routineSkillsLoadedOk = ref(false);
  const routineEditMode = ref("");
  const selectedRoutineId = ref<number | null>(null);
  const routineForm = ref<FormulaireRoutine>(formulaireVide());
  const routineEditTab = ref("general");
  const routineIsEditing = computed(
    () => routineEditMode.value === "create" || routineEditMode.value === "edit",
  );
  const schedule = ref<Planification>(planificationParDefaut());
  const viewed = ref<RoutineListee | null>(null);
  const routineRuns = ref<RunRoutine[]>([]);
  const routineRunsLoading = ref(false);
  const expandedRunId = ref<number | null>(null);
  const collapsedSkillParents = ref<string[]>([]);
  const webhookEnabled = ref(false);
  const webhookSecret = ref<string | null>(null);
  const webhookBusy = ref(false);
  const webhookFilterForm = ref<CorpsFiltreWebhook>({ events: [], branch: "", repo: "" });
  const webhookEventsInput = ref("");
  const stoppingRunIds = ref(new Set<number>());

  let minuterieRuns: Minuterie | null = null;
  let minuterieListe: Minuterie | null = null;

  function arreterSondages(): void {
    if (minuterieRuns) {
      clearTimeout(minuterieRuns);
      minuterieRuns = null;
    }
    if (minuterieListe) {
      clearTimeout(minuterieListe);
      minuterieListe = null;
    }
  }

  function auRetourDePremierPlan(): void {
    if (document.hidden) {
      arreterSondages();
      return;
    }
    if (currentView.value === "routines") {
      void loadRoutines();
      const id = selectedRoutineId.value;
      if (id && (routineEditMode.value === "edit" || routineEditMode.value === "view")) void loadRuns(id);
    }
  }
  document.addEventListener("visibilitychange", auRetourDePremierPlan);

  function cronLisible(expr: string): string {
    const planif = planificationDepuisCron(expr);
    return planif.freq === "custom" ? expr : resumerPlanification(planif);
  }

  const builtCron = computed(() => cronDepuisPlanification(schedule.value));
  const scheduleSummary = computed(() => resumerPlanification(schedule.value));

  function isWeekday(n: number): boolean {
    return schedule.value.weekdays.includes(n);
  }
  function toggleWeekday(n: number): void {
    const w = schedule.value.weekdays;
    const i = w.indexOf(n);
    if (i >= 0) w.splice(i, 1);
    else w.push(n);
    schedule.value.weekdays = w;
  }

  const routineModelOptions = computed<Array<{ id: string; label: string }>>(() => {
    try {
      const liste = ctx.engineModels?.(routineForm.value.connector_id) || [];
      return liste.map((m) =>
        typeof m === "string" ? { id: m, label: m } : { id: m.id ?? "", label: m.name || m.id || "" },
      );
    } catch {
      return [];
    }
  });
  function onRoutineConnectorChange(): void {
    routineForm.value.model = "";
  }
  function routineNameById(id: Identifiant | null): string {
    const r = routines.value.find((x) => x.id === id);
    return r ? r.name : `#${id}`;
  }

  async function reloadRoutineSkills(): Promise<void> {
    routineSkillsLoading.value = true;
    const r = await api.skills();
    if (r.type === "ok") {
      routineSkills.value = r.valeur.skills.filter((s) => s && s.source !== "learned");
      routineSkillsLoadedOk.value = true;
    }
    routineSkillsLoading.value = false;
  }

  const aucunSkillPerso = computed(() => !routineSkills.value.some((s) => (s.source || "user") === "user"));
  const routineSkillTree = computed(() => arbreSkills(routineSkills.value));
  function isSkillExpanded(id: string): boolean {
    return !collapsedSkillParents.value.includes(id);
  }
  function toggleSkillExpand(id: string): void {
    const cur = collapsedSkillParents.value;
    collapsedSkillParents.value = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id];
  }
  const skillLeafLabel = libelleFeuille;
  function skillDescendantCount(id: string): number {
    return nombreDescendants(id, routineSkillsLoadedOk.value, routineSkills.value);
  }
  function elaguer(ids: readonly unknown[] | null | undefined): string[] {
    return elaguerSkills(ids, routineSkillsLoadedOk.value, routineSkills.value);
  }
  function isRoutineSkillOn(id: string): boolean {
    return routineForm.value.skills.includes(id);
  }
  function toggleRoutineSkill(id: string): void {
    const liste = routineForm.value.skills;
    const i = liste.indexOf(id);
    if (i >= 0) liste.splice(i, 1);
    else {
      if (elaguer(liste).length >= MAX_SKILLS_ROUTINE) {
        showToast(`Maximum ${MAX_SKILLS_ROUTINE} skills par routine`, "info");
        return;
      }
      liste.push(id);
    }
    routineForm.value.skills = liste;
  }
  const routineSkillsCount = computed(() => elaguer(routineForm.value.skills).length);
  function removeRoutineSkill(id: string): void {
    const liste = routineForm.value.skills;
    const i = liste.indexOf(id);
    if (i >= 0) liste.splice(i, 1);
  }
  const orphanRoutineSkills = computed(() => {
    if (!routineSkillsLoadedOk.value) return [];
    const connus = idsConnus(routineSkills.value);
    return routineForm.value.skills.filter((id) => !connus.has(id));
  });
  function isKnownSkill(id: string): boolean {
    if (!routineSkillsLoadedOk.value) return true;
    return idsConnus(routineSkills.value).has(id);
  }
  const skillDomainBadge = badgeDomaine;
  function skillTooltip(id: string): string {
    return infobulleSkill(id, routineSkillsLoadedOk.value, routineSkills.value);
  }

  function construireServeursMcp(): Array<Record<string, unknown>> {
    const arr: Array<Record<string, unknown>> = [];
    const cats = routineForm.value.localCats;
    if (cats.length) {
      arr.push({
        type: "stdio",
        name: "Outils Locaux",
        command: "DEFAULT_LOCAL_PYTHON",
        filter_categories: [...cats],
      });
    }
    for (const s of routineForm.value.externalServers) {
      arr.push({ id: s.id, name: s.name, type: s.type, ...(s.shared ? { shared: true } : {}) });
    }
    return arr;
  }
  function isLocalCatOn(name: string): boolean {
    return routineForm.value.localCats.includes(name);
  }
  function toggleRoutineLocalCat(name: string): void {
    const cats = routineForm.value.localCats;
    const i = cats.indexOf(name);
    if (i >= 0) cats.splice(i, 1);
    else cats.push(name);
    routineForm.value.localCats = cats;
  }
  function isExternalOn(id: unknown): boolean {
    return routineForm.value.externalServers.some((s) => s.id === id);
  }
  function toggleRoutineExternal(srv: ServeurExterne): void {
    const liste = routineForm.value.externalServers;
    const i = liste.findIndex((s) => s.id === srv.id);
    if (i >= 0) liste.splice(i, 1);
    else liste.push({ ...srv });
    routineForm.value.externalServers = liste;
  }

  function reinitialiserEditeur(): void {
    routineEditMode.value = "";
    selectedRoutineId.value = null;
    viewed.value = null;
    routineForm.value = formulaireVide();
    schedule.value = planificationParDefaut();
    routineRuns.value = [];
    expandedRunId.value = null;
    if (minuterieRuns) {
      clearTimeout(minuterieRuns);
      minuterieRuns = null;
    }
  }

  async function openRoutinesPage(): Promise<void> {
    currentView.value = "routines";
    reinitialiserEditeur();
    void reloadRoutineSkills();
    try {
      ctx.loadEngines?.();
    } catch {
      /* moteurs indisponibles : le sélecteur reste vide */
    }
    await loadRoutines();
    const premiere = routines.value[0];
    if (!selectedRoutineId.value && premiere) viewRoutine(premiere);
  }
  function closeRoutinesPage(): void {
    currentView.value = "chat";
    arreterSondages();
    reinitialiserEditeur();
    routines.value = [];
    routinesError.value = "";
  }

  async function loadRoutines(): Promise<void> {
    routinesLoading.value = true;
    routinesError.value = "";
    const lu = await api.lister();
    if (lu.ok) {
      routines.value = lu.items;
      if (viewed.value) {
        const idVu = viewed.value.id;
        const fraiche = routines.value.find((x) => x.id === idVu);
        if (fraiche) viewed.value = fraiche;
      }
    } else {
      routinesError.value = lu.echec === "reseau" ? "Erreur réseau." : "Chargement impossible.";
    }
    routinesLoading.value = false;
    if (minuterieListe) {
      clearTimeout(minuterieListe);
      minuterieListe = null;
    }
    const enCours = routines.value.some((r) => (r.running_count || 0) > 0);
    if (enCours && currentView.value === "routines" && !document.hidden) {
      minuterieListe = setTimeout(() => void loadRoutines(), 4000);
    }
  }

  function startCreateRoutine(): void {
    routineForm.value = formulaireVide();
    schedule.value = planificationParDefaut();
    selectedRoutineId.value = null;
    viewed.value = null;
    routineRuns.value = [];
    collapsedSkillParents.value = [];
    webhookEnabled.value = false;
    webhookSecret.value = null;
    webhookEventsInput.value = "";
    webhookFilterForm.value = { events: [], branch: "", repo: "" };
    routineEditTab.value = "general";
    routineEditMode.value = "create";
    memoriserFormulaire();
  }

  function viewRoutine(r: RoutineListee): void {
    viewed.value = r;
    selectedRoutineId.value = r.id;
    expandedRunId.value = null;
    routineEditMode.value = "view";
    void loadRuns(r.id);
  }

  function editRoutine(r: RoutineListee): void {
    const parsed = analyserInstantane(r.mcp_snapshot);
    routineForm.value = {
      name: r.name || "",
      model: r.model || "",
      connector_id: r.connector_id || null,
      system_prompt: r.system_prompt || "",
      task_prompt: r.task_prompt || "",
      thinking_mode: !!r.thinking_mode,
      enabled: !!r.enabled,
      agents_enabled: !!r.agents_enabled,
      localCats: parsed.localCats,
      externalServers: parsed.externalServers,
      skills: Array.isArray(r.skills) ? r.skills.filter((id) => typeof id === "string" && id.trim()) : [],
      trigger_after_id: r.trigger_after_id || null,
      trigger_after_on: r.trigger_after_on || "ok",
      runs_keep: borner(r.runs_keep, 0, PLAFOND_CONSERVATION, 0),
      notify_on: MODES_NOTIFICATION.some((m) => m.id === r.notify_on) ? r.notify_on : "all",
      notify_keep: borner(r.notify_keep, 0, PLAFOND_CONSERVATION, 0),
    };
    collapsedSkillParents.value = [];
    schedule.value = planificationDepuisCron(r.cron_expr || "");
    webhookEnabled.value = !!r.webhook_enabled;
    webhookSecret.value = null;
    const wf = (r.webhook_filter || {}) as { events?: unknown; branch?: unknown; repo?: unknown };
    webhookFilterForm.value = {
      events: Array.isArray(wf.events) ? wf.events.map(String) : [],
      branch: typeof wf.branch === "string" ? wf.branch : "",
      repo: typeof wf.repo === "string" ? wf.repo : "",
    };
    webhookEventsInput.value = webhookFilterForm.value.events.join(", ");
    selectedRoutineId.value = r.id;
    routineEditTab.value = "general";
    routineEditMode.value = "edit";
    memoriserFormulaire();
    void loadRuns(r.id);
  }

  /** Vrai si l'on peut quitter le formulaire : rien de modifié, ou abandon confirmé. */
  async function confirmerAbandon(): Promise<boolean> {
    if (!routineDirty.value) return true;
    return openConfirm(
      "Abandonner les modifications ?",
      "Les changements de cette routine ne sont pas enregistrés.",
      true,
    );
  }

  async function cancelRoutineEdit(): Promise<void> {
    if (!(await confirmerAbandon())) return;
    if (routineEditMode.value === "edit" && viewed.value) {
      viewRoutine(viewed.value);
      return;
    }
    const premiere = routines.value[0];
    if (premiere) viewRoutine(premiere);
    else reinitialiserEditeur();
  }

  const empreinteInitiale = ref("");
  const routineDirty = computed(
    () => routineIsEditing.value && empreinteInitiale.value !== empreinteFormulaire(),
  );
  function empreinteFormulaire(): string {
    return JSON.stringify([chargeUtile(), webhookFilterForm.value, webhookEventsInput.value]);
  }
  function memoriserFormulaire(): void {
    empreinteInitiale.value = empreinteFormulaire();
  }

  function chargeUtile() {
    const f = routineForm.value;
    const charge = {
      name: (f.name || "").trim(),
      cron_expr: builtCron.value,
      model: f.model || null,
      connector_id: f.connector_id || null,
      system_prompt: f.system_prompt || "",
      task_prompt: f.task_prompt || "",
      thinking_mode: !!f.thinking_mode,
      enabled: !!f.enabled,
      agents_enabled: !!f.agents_enabled,
      mcp_servers: construireServeursMcp(),
      skills: elaguer(f.skills),
      trigger_after_id: f.trigger_after_id || null,
      trigger_after_on: f.trigger_after_on || "ok",
      runs_keep: borner(f.runs_keep, 0, PLAFOND_CONSERVATION, 0),
      notify_on: MODES_NOTIFICATION.some((m) => m.id === f.notify_on) ? f.notify_on : "all",
      notify_keep: borner(f.notify_keep, 0, PLAFOND_CONSERVATION, 0),
    };
    return charge;
  }

  async function saveRoutine(): Promise<void> {
    const payload = chargeUtile();
    if (!payload.name) {
      routineEditTab.value = "general";
      showToast("Nom requis", "error");
      return;
    }
    if (!payload.task_prompt.trim()) {
      routineEditTab.value = "prompt";
      showToast("Tâche requise", "error");
      return;
    }
    const cron = (payload.cron_expr || "").trim();
    if (cron && cron.split(/\s+/).length !== 5) {
      routineEditTab.value = "schedule";
      showToast("Planification invalide (cron : 5 champs)", "error");
      return;
    }
    routinesBusy.value = true;
    const editionId = routineEditMode.value === "edit" ? selectedRoutineId.value : null;
    const editing = editionId !== null && editionId !== 0;
    const r = await api.enregistrer(editing ? editionId : null, payload);
    if (r.ok) {
      const savedId = editing ? selectedRoutineId.value : (r.valeur.id ?? selectedRoutineId.value);
      if (editing && webhookEnabled.value) await saveWebhookFilter({ silent: true });
      showToast(editing ? "Routine enregistrée" : "Routine créée");
      await loadRoutines();
      const saved = routines.value.find((x) => x.id === savedId);
      if (saved) viewRoutine(saved);
      else reinitialiserEditeur();
    } else if (r.echec === "reseau") showToast("Erreur réseau", "error");
    else showToast(r.detail || "Erreur sauvegarde", "error");
    routinesBusy.value = false;
  }

  async function deleteRoutine(r?: RoutineListee): Promise<void> {
    const cible =
      r ||
      (selectedRoutineId.value ? routines.value.find((x) => x.id === selectedRoutineId.value) : undefined);
    if (!cible) return;
    if (routinesBusy.value) return;
    routinesBusy.value = true;
    const ok = await openConfirm(
      "Supprimer cette routine ?",
      "Ses exécutions journalisées seront aussi supprimées.",
      true,
    );
    if (!ok) {
      routinesBusy.value = false;
      return;
    }
    const res = await api.supprimer(cible.id);
    if (res.ok) {
      showToast("Routine supprimée");
      if (selectedRoutineId.value === cible.id) reinitialiserEditeur();
      await loadRoutines();
      const premiere = routines.value[0];
      if (routineEditMode.value === "" && premiere) viewRoutine(premiere);
    } else if (res.echec === "reseau") showToast("Erreur réseau", "error");
    else showToast("Suppression impossible", "error");
    routinesBusy.value = false;
  }

  async function toggleRoutineEnabled(r: RoutineListee): Promise<void> {
    const res = await api.basculer(r.id, !r.enabled);
    if (res.ok) {
      r.enabled = !r.enabled;
      if (selectedRoutineId.value === r.id) routineForm.value.enabled = r.enabled;
      if (viewed.value && viewed.value.id === r.id) viewed.value.enabled = r.enabled;
    } else if (res.echec === "reseau") showToast("Erreur réseau", "error");
    else showToast("Action impossible", "error");
  }

  async function runRoutineNow(): Promise<void> {
    const id = selectedRoutineId.value;
    if (!id) return;
    routinesBusy.value = true;
    const res = await api.lancer(id);
    if (res.ok) {
      const d = res.valeur;
      if ("skipped" in d && d.skipped)
        showToast(`Non lancé : ${d.reason || "cap de runs simultanés atteint"}`, "info");
      else showToast("Exécution lancée");
      setTimeout(() => {
        if (selectedRoutineId.value !== null) void loadRuns(selectedRoutineId.value);
        void loadRoutines();
      }, 800);
    } else if (res.echec === "reseau") showToast("Erreur réseau", "error");
    else showToast(res.detail || "Lancement impossible", "error");
    routinesBusy.value = false;
  }

  function appliquerAuWebhook(patch: Partial<RoutineListee>): void {
    const id = selectedRoutineId.value;
    const cibles = [
      routines.value.find((x) => x.id === id),
      viewed.value && viewed.value.id === id ? viewed.value : null,
    ];
    for (const o of cibles) if (o) Object.assign(o, patch);
  }
  function webhookUrl(): string {
    if (!selectedRoutineId.value) return "";
    return `${window.location.origin}/api/webhooks/routines/${selectedRoutineId.value}`;
  }
  async function rotateWebhook(): Promise<void> {
    const id = selectedRoutineId.value;
    if (!id || webhookBusy.value) return;
    webhookBusy.value = true;
    const res = await api.tournerWebhook(id);
    if (res.ok) {
      webhookSecret.value = res.valeur.secret || null;
      webhookEnabled.value = true;
      appliquerAuWebhook({ webhook_enabled: true, webhook_has_secret: true });
      showToast("Webhook activé — copiez le secret maintenant, il ne sera plus affiché");
    } else if (res.echec === "reseau") showToast("Erreur réseau", "error");
    else showToast("Activation impossible", "error");
    webhookBusy.value = false;
  }
  async function disableWebhook(): Promise<void> {
    const id = selectedRoutineId.value;
    if (!id || webhookBusy.value) return;
    webhookBusy.value = true;
    const res = await api.couperWebhook(id);
    if (res.ok) {
      webhookEnabled.value = false;
      webhookSecret.value = null;
      appliquerAuWebhook({ webhook_enabled: false });
      showToast("Webhook désactivé");
    } else if (res.echec === "reseau") showToast("Erreur réseau", "error");
    else showToast("Désactivation impossible", "error");
    webhookBusy.value = false;
  }
  async function saveWebhookFilter(opts?: { silent?: boolean }): Promise<void> {
    const silent = !!(opts && opts.silent);
    const id = selectedRoutineId.value;
    if (!id || webhookBusy.value) return;
    webhookBusy.value = true;
    webhookFilterForm.value.events = String(webhookEventsInput.value || "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s);
    const res = await api.filtrerWebhook(id, { ...webhookFilterForm.value });
    if (res.ok) {
      appliquerAuWebhook({ webhook_filter: { ...webhookFilterForm.value } });
      if (!silent) showToast("Webhook enregistré");
    } else if (res.echec === "reseau") showToast("Erreur réseau", "error");
    else showToast(res.detail || "Enregistrement impossible", "error");
    webhookBusy.value = false;
  }
  async function copyWebhookText(t: string | null): Promise<void> {
    if (!t) return;
    try {
      await navigator.clipboard.writeText(t);
      showToast("Copié");
    } catch {
      showToast("Copie impossible", "error");
    }
  }

  function runStopping(run: RunRoutine | null | undefined): boolean {
    return !!run && stoppingRunIds.value.has(run.id);
  }
  function marquerArret(id: number, actif: boolean): void {
    const s = new Set(stoppingRunIds.value);
    if (actif) s.add(id);
    else s.delete(id);
    stoppingRunIds.value = s;
  }
  async function stopRoutineRun(run: RunRoutine): Promise<void> {
    const rid = (run && run.routine_id) || selectedRoutineId.value;
    if (!rid || !run || run.status !== "running" || runStopping(run)) return;
    marquerArret(run.id, true);
    const res = await api.arreter(rid, run.id);
    if (res.ok) {
      const d = res.valeur;
      if (d.stopping) showToast("Arrêt demandé");
      else if (d.status === "cancelled") showToast("Run arrêté (le processus exécutant était déjà mort)");
      else showToast("Run déjà terminé", "info");
      setTimeout(() => {
        void loadRuns(rid);
        void loadRoutines();
      }, 800);
    } else {
      marquerArret(run.id, false);
      showToast(res.echec === "reseau" ? "Erreur réseau" : "Arrêt impossible", "error");
    }
  }
  function stopActiveRun(): void {
    const run = routineRuns.value.find((r) => r.status === "running");
    if (run) void stopRoutineRun(run);
  }

  async function loadRuns(routineId: number | null): Promise<void> {
    if (!routineId) return;
    routineRunsLoading.value = true;
    const lu = await api.runs(routineId, 50);
    if (lu.ok) {
      if (selectedRoutineId.value !== routineId) {
        routineRunsLoading.value = false;
        return;
      }
      routineRuns.value = lu.items;
      if (stoppingRunIds.value.size) {
        const encore = new Set<number>();
        for (const r of routineRuns.value)
          if (r.status === "running" && stoppingRunIds.value.has(r.id)) encore.add(r.id);
        stoppingRunIds.value = encore;
      }
    }
    routineRunsLoading.value = false;
    if (minuterieRuns) {
      clearTimeout(minuterieRuns);
      minuterieRuns = null;
    }
    const enCours = routineRuns.value.some((r) => r.status === "running");
    if (
      enCours &&
      selectedRoutineId.value === routineId &&
      currentView.value === "routines" &&
      (routineEditMode.value === "edit" || routineEditMode.value === "view") &&
      !document.hidden
    ) {
      minuterieRuns = setTimeout(() => void loadRuns(routineId), 3000);
    }
  }

  const anyRunActive = computed(() => routineRuns.value.some((r) => r.status === "running"));
  const activeRunStopping = computed(() =>
    routineRuns.value.some((r) => r.status === "running" && stoppingRunIds.value.has(r.id)),
  );
  function toggleRunExpand(id: number): void {
    expandedRunId.value = expandedRunId.value === id ? null : id;
  }
  async function copyRunDetail(run: RunRoutine): Promise<void> {
    const t = restaurerMarqueursTour(texteDetailRun(run));
    if (!t) return;
    try {
      await navigator.clipboard.writeText(t);
      showToast("Réponse copiée");
    } catch {
      showToast("Copie impossible", "error");
    }
  }
  function openRunFile(path: string): void {
    if (!path) return;
    if (!ctx.openFile) {
      showToast("Éditeur indisponible", "error");
      return;
    }
    closeRoutinesPage();
    try {
      ctx.openFile(path);
    } catch {
      showToast("Ouverture impossible", "error");
    }
  }

  return {
    routinesLoading,
    routinesBusy,
    routinesError,
    routines,
    routineEditMode,
    selectedRoutineId,
    routineForm,
    viewed,
    routineEditTab,
    routineDirty,
    routineEditTabs: ONGLETS_EDITION,
    routineIsEditing,
    ROUTINE_BUILTIN_AGENTS: BUILTIN_AGENTS,
    ROUTINE_KEEP_MAX: PLAFOND_CONSERVATION,
    ROUTINE_NOTIFY_MODES: MODES_NOTIFICATION,
    notifyOnLabel: libelleNotification,
    keepLabel: libelleConservation,
    routineRuns,
    routineRunsLoading,
    expandedRunId,
    anyRunActive,
    activeRunStopping,
    schedule,
    builtCron,
    scheduleSummary,
    weekdayChips: PUCES_JOURS,
    toggleWeekday,
    isWeekday,
    openRoutinesPage,
    closeRoutinesPage,
    loadRoutines,
    startCreateRoutine,
    viewRoutine,
    editRoutine,
    cancelRoutineEdit,
    saveRoutine,
    deleteRoutine,
    toggleRoutineEnabled,
    runRoutineNow,
    loadRuns,
    stopRoutineRun,
    stopActiveRun,
    runStopping,
    webhookEnabled,
    webhookSecret,
    webhookBusy,
    webhookFilterForm,
    webhookEventsInput,
    webhookUrl,
    rotateWebhook,
    disableWebhook,
    saveWebhookFilter,
    copyWebhookText,
    routineNameById,
    routineModelOptions,
    onRoutineConnectorChange,
    isLocalCatOn,
    toggleRoutineLocalCat,
    isExternalOn,
    toggleRoutineExternal,
    routineSkills,
    aucunSkillPerso,
    confirmerAbandon,
    routineSkillsLoading,
    routineSkillsLoadedOk,
    reloadRoutineSkills,
    orphanRoutineSkills,
    routineSkillsCount,
    isRoutineSkillOn,
    toggleRoutineSkill,
    removeRoutineSkill,
    isKnownSkill,
    skillTooltip,
    skillDomainBadge,
    routineSkillTree,
    isSkillExpanded,
    toggleSkillExpand,
    skillLeafLabel,
    skillDescendantCount,
    runStatusClass: classeStatut,
    fmtRunTime: formaterHeure,
    fmtDuration: formaterDuree,
    cronToHuman: cronEnTexte,
    cronLisible,
    mcpSummary: resumeMcp,
    runStatusLabel: libelleStatut,
    runDetailText: texteDetailRun,
    fmtRelTime: formaterRelatif,
    toggleRunExpand,
    runIsMarkdown: runEstMarkdown,
    runIsTruncated: runEstTronque,
    copyRunDetail,
    runPreviewText: apercuRun,
    runFiles: fichiersRun,
    fileBaseName: nomDeFichier,
    openRunFile,
    _liberer: (): void => {
      arreterSondages();
      document.removeEventListener("visibilitychange", auRetourDePremierPlan);
    },
  };
}

export type SurfaceRoutines = ReturnType<typeof creerRoutines>;
