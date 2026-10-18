// SPDX-License-Identifier: MIT
/** frontend/src/features/code/code.ts — page « Code » : sessions opencode remontées et pilotables (transcript live par SSE, composer, /model, /session, agents, permissions, questions, appairage, jetons). */
import { computed, markRaw, nextTick, ref, watch } from "vue";
import type { Ref } from "vue";

import type { HttpLegacy } from "../../platform/http/legacy";
import { creerApiCode } from "./api";
import { creerSuiviRendu } from "./suivi";
import type { MessageOpencode, PartOpencode } from "./rendu";

type Dict = Record<string, unknown>;

export interface SessionCode {
  id: string;
  title?: string;
  connected?: boolean;
  busy?: boolean;
  client?: string;
  directory?: string;
  time?: { updated?: number };
  msg_count?: number;
  last_model?: string;
  [cle: string]: unknown;
}

export interface CommandeCode {
  name: string;
  description?: string;
  app?: boolean;
  action?: string;
  appFn?: string;
  toAgent?: string;
  [cle: string]: unknown;
}

export interface FournisseurModeles {
  id: string;
  name?: string;
  models?: Array<{ id: string; name?: string; limit?: { context?: number } }>;
}

export interface LigneModele {
  def?: boolean;
  providerID: string;
  modelID: string;
  name: string;
  provider: string;
}

export interface AgentCode {
  name: string;
  description?: string;
}

export interface QuestionCode {
  id: string;
  sessionID?: string;
  questions?: Array<{
    question?: string;
    header?: string;
    options?: Array<{ label: string; description?: string }>;
    multiple?: boolean;
    custom?: boolean;
  }>;
  [cle: string]: unknown;
}

export interface PermissionCode {
  id: string;
  [cle: string]: unknown;
}

export interface CtxCode {
  showToast(message: string, type?: string): void;
  fetchJsonAuth: HttpLegacy["fetchJsonAuth"];
  fetchAuth: HttpLegacy["fetchAuth"];
  openConfirm(titre: string, texte: string, danger?: boolean, ok?: string): Promise<boolean>;
  user?: Ref<unknown> | null;
  handleSessionExpired?: () => unknown;
}

export interface RefsCode {
  currentView: Ref<string>;
}

const COMMANDES_APP: CommandeCode[] = [
  { name: "model", description: "Choisir le modèle d'inférence de la session", app: true },
  { name: "session", description: "Reprendre une autre session de cette CLI", app: true },
  {
    name: "compact",
    description: "Résumer la conversation (libère du contexte)",
    app: true,
    action: "compact",
  },
  { name: "undo", description: "Annuler le dernier échange", app: true, action: "undo" },
  { name: "redo", description: "Rétablir l'échange annulé", app: true, action: "redo" },
  { name: "init", description: "Analyser le projet et créer AGENTS.md", app: true, action: "init" },
  { name: "share", description: "Partager la session (lien public)", app: true, action: "share" },
  { name: "unshare", description: "Désactiver le partage de la session", app: true, action: "unshare" },
  { name: "new", description: "Créer une nouvelle session sur cette CLI", app: true, appFn: "new" },
  { name: "exit", description: "Fermer opencode sur cette CLI", app: true, appFn: "exit" },
];

const SSE_MAX = 30000;
const JSON_ENTETES = { "Content-Type": "application/json" };

const dict = (v: unknown): Dict => (v && typeof v === "object" && !Array.isArray(v) ? (v as Dict) : {});
const liste = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
const fmtTk = (n: number): string =>
  n >= 1000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k` : String(n);
const libelleAgent = (name: string): string => (name ? name.charAt(0).toUpperCase() + name.slice(1) : "");

export function creerCode(refs: RefsCode, ctx: CtxCode) {
  const { currentView } = refs;
  const { showToast, fetchAuth, openConfirm } = ctx;
  const api = creerApiCode(ctx.fetchJsonAuth);
  const rendu = creerSuiviRendu();

  const codeAvailable = ref(true);
  const codeConnected = ref(false);
  const codeLoading = ref(false);
  const codeSessions = ref<SessionCode[]>([]);
  const codeActiveId = ref("");
  const codeMessages = ref<MessageOpencode[]>([]);
  const codeBusy = ref<Record<string, boolean>>({});
  const codeShowConnect = ref(false);
  const codeConfig = ref<{ app_url: string; token: string; plugin_url: string; [cle: string]: unknown }>({
    app_url: "",
    token: "",
    plugin_url: "",
  });
  const codePluginStale = ref(false);
  const codePluginVersion = ref(0);
  const codePerms = ref<PermissionCode[]>([]);
  const codeQuestions = ref<QuestionCode[]>([]);
  const codeQPick = ref<Record<string, string[][]>>({});
  const codeQText = ref<Record<string, string>>({});
  const codeRenamingId = ref("");
  const codeRenameText = ref("");
  const codePrompt = ref("");
  const codeSending = ref(false);
  const codeRefreshing = ref(false);
  const codeCommands = ref<CommandeCode[]>([]);
  const codeSlashIdx = ref(0);
  const codeSlashDismissed = ref(false);
  const transcriptEl = ref<HTMLElement | null>(null);
  const codeInputRef = ref<HTMLTextAreaElement | null>(null);
  const codeModels = ref<FournisseurModeles[]>([]);
  const codeModelsDefault = ref<Record<string, string>>({});
  const codeModelOpen = ref(false);
  const codeModelIdx = ref(0);
  const codeModelSel = ref<Record<string, { providerID: string; modelID: string; name: string }>>({});
  const codeAgents = ref<AgentCode[]>([]);
  const codeAgentDefault = ref("");
  const codeAgentSel = ref<Record<string, string>>({});
  const codeClients = ref<Array<{ id: string; directory?: string; plugin_version?: number }>>([]);
  const codeSessionOpen = ref(false);
  const codeSessionIdx = ref(0);
  const codePairCode = ref("");
  const codePairBusy = ref(false);

  let evtSource: EventSource | null = null;
  let tentativeSse = 0;
  let minuterieSse: ReturnType<typeof setTimeout> | null = null;
  let minuterieSante: ReturnType<typeof setInterval> | null = null;
  let sseDejaOuvert = false;
  // On ne colle au bas que si l'utilisateur y est déjà (à 120 px près) : il peut relire plus haut pendant le flux.
  let collerAuBas = true;

  const activeSession = computed(() => codeSessions.value.find((s) => s.id === codeActiveId.value) || null);

  const codeAgentLabel = libelleAgent;
  const codeAgentCmds = computed<CommandeCode[]>(() =>
    codeAgents.value.map((a) => ({
      name: a.name,
      description: a.description || `Basculer en mode ${libelleAgent(a.name)}`,
      app: true,
      appFn: "agent",
      toAgent: a.name,
    })),
  );
  const codeAppCmds = computed(() => [...COMMANDES_APP, ...codeAgentCmds.value]);
  const codeSlashQuery = computed(() => {
    const m = codePrompt.value.match(/^\/(\S*)$/);
    return m ? (m[1] ?? "") : null;
  });
  const codeSlashList = computed<CommandeCode[]>(() => {
    const q = (codeSlashQuery.value || "").toLowerCase();
    const parNom = (a: CommandeCode, b: CommandeCode): number => a.name.localeCompare(b.name);
    const apps = codeAppCmds.value.filter((c) => c.name.toLowerCase().includes(q));
    const tout = codeCommands.value;
    const debut = tout.filter((c) => c.name.toLowerCase().startsWith(q));
    const contient = q
      ? tout.filter((c) => !c.name.toLowerCase().startsWith(q) && c.name.toLowerCase().includes(q))
      : [];
    return [...apps.sort(parNom), ...debut.sort(parNom), ...contient.sort(parNom)];
  });
  const codeSlashOpen = computed(
    () =>
      codeSlashQuery.value !== null &&
      !codeSlashDismissed.value &&
      !codeModelOpen.value &&
      !codeSessionOpen.value &&
      codeSlashList.value.length > 0,
  );
  const codeRemoteCmd = computed(() => `/remote ${codeConfig.value.token || "<jeton>"}`);

  const codeModelList = computed<LigneModele[]>(() => {
    const sortie: LigneModele[] = [
      { def: true, providerID: "", modelID: "", name: "Modèle par défaut de la session", provider: "" },
    ];
    for (const p of codeModels.value) {
      for (const m of p.models || []) {
        sortie.push({ providerID: p.id, modelID: m.id, name: m.name || m.id, provider: p.name || p.id });
      }
    }
    return sortie;
  });
  const codeModelChip = computed(() => {
    const sel = codeModelSel.value[codeActiveId.value];
    return sel ? sel.name || sel.modelID : "";
  });
  const codeCanDrive = computed(() => !!activeSession.value && activeSession.value.connected !== false);

  function focusSaisie(): void {
    const el = codeInputRef.value;
    if (el) el.focus();
  }

  function defilerLigne(idListe: string, selecteur: string, idx: number): void {
    void nextTick(() => {
      const l = document.getElementById(idListe);
      const row = l && l.querySelectorAll(selecteur)[idx];
      if (row) row.scrollIntoView({ block: "nearest" });
    });
  }

  function openModelPicker(): void {
    if (!codeModels.value.length) void loadModels();
    codeSlashDismissed.value = true;
    codeModelOpen.value = true;
    const sel = codeModelSel.value[codeActiveId.value];
    const i = sel
      ? codeModelList.value.findIndex((r) => r.providerID === sel.providerID && r.modelID === sel.modelID)
      : 0;
    codeModelIdx.value = i >= 0 ? i : 0;
    void nextTick(() => {
      focusSaisie();
      defilerLigne("code-model-list", "li[data-code-model-row]", codeModelIdx.value);
    });
  }
  function selectModel(row: LigneModele | undefined): void {
    const sid = codeActiveId.value;
    if (!sid || !row) return;
    if (row.def) {
      const c = { ...codeModelSel.value };
      delete c[sid];
      codeModelSel.value = c;
    } else {
      codeModelSel.value = {
        ...codeModelSel.value,
        [sid]: { providerID: row.providerID, modelID: row.modelID, name: row.name },
      };
    }
    codeModelOpen.value = false;
    void nextTick(focusSaisie);
  }
  function clearModel(): void {
    const c = { ...codeModelSel.value };
    delete c[codeActiveId.value];
    codeModelSel.value = c;
  }

  const codeAgentLive = computed(() => {
    const msgs = codeMessages.value;
    for (let i = msgs.length - 1; i >= 0; i--) {
      const info = dict(msgs[i]?.info);
      if (info["agent"]) return String(info["agent"]);
    }
    return "";
  });
  const codeAgentCur = computed(
    () => codeAgentSel.value[codeActiveId.value] || codeAgentLive.value || codeAgentDefault.value || "",
  );
  const codeAgentShow = computed(() => codeAgents.value.length > 1);
  const codeAgentDesc = computed(() => {
    const cur = codeAgentCur.value;
    const a = codeAgents.value.find((x) => x.name === cur);
    const autres = codeAgents.value.filter((x) => x.name !== cur).map((x) => `/${x.name}`);
    return `Mode ${libelleAgent(cur)}${a && a.description ? ` — ${a.description}` : ""}${autres.length ? `\nChanger : ${autres.join(" ou ")}` : ""}`;
  });
  function selectAgent(name: string | undefined): void {
    const sid = codeActiveId.value;
    if (!sid || !name) return;
    const deja = codeAgentCur.value === name;
    codeAgentSel.value = { ...codeAgentSel.value, [sid]: name };
    showToast(
      deja
        ? `Déjà en mode ${libelleAgent(name)}.`
        : `Mode ${libelleAgent(name)} — appliqué au prochain message.`,
      deja ? "info" : "success",
    );
    void nextTick(focusSaisie);
  }
  function cycleAgent(): void {
    const l = codeAgents.value;
    if (l.length < 2) return;
    const i = l.findIndex((a) => a.name === codeAgentCur.value);
    selectAgent(l[(i + 1) % l.length]?.name);
  }

  const codeCtx = computed(() => {
    const msgs = codeMessages.value;
    for (let i = msgs.length - 1; i >= 0; i--) {
      const info = dict(msgs[i]?.info);
      const tk = dict(info["tokens"]);
      if (info["role"] !== "assistant" || !info["tokens"] || typeof info["tokens"] !== "object") continue;
      const cache = dict(tk["cache"]);
      const num = (v: unknown): number => (typeof v === "number" ? v : 0);
      const used =
        num(tk["input"]) +
        num(cache["read"]) +
        num(cache["write"]) +
        num(tk["output"]) +
        num(tk["reasoning"]);
      if (!used) continue;
      let limit = 0;
      if (info["providerID"] && info["modelID"]) {
        const prov = codeModels.value.find((p) => p.id === info["providerID"]);
        const mdl = prov && (prov.models || []).find((x) => x.id === info["modelID"]);
        if (mdl && mdl.limit && (mdl.limit.context ?? 0) > 0) limit = mdl.limit.context ?? 0;
      }
      const pct = limit ? Math.min(999, Math.round((used * 100) / limit)) : 0;
      const modele = info["modelID"] ? ` (${String(info["modelID"])})` : "";
      return {
        used,
        limit,
        pct,
        label: limit ? `${pct}% ctx` : `${fmtTk(used)} tk`,
        title: limit
          ? `${fmtTk(used)} / ${fmtTk(limit)} tokens${modele}`
          : `${fmtTk(used)} tokens — limite du modèle inconnue (plugin v5 requis)`,
      };
    }
    return null;
  });

  const codeIdleClients = computed(() => {
    const avecSession = new Set(codeSessions.value.map((s) => s.client).filter(Boolean));
    return codeClients.value.filter((c) => c && c.id && !avecSession.has(c.id));
  });

  const codeSessionGroups = computed(() => {
    const live: SessionCode[] = [];
    const past: SessionCode[] = [];
    for (const s of codeSessions.value) (s.connected !== false ? live : past).push(s);
    const sortie: Array<{ key: string; label: string; sessions: SessionCode[] }> = [];
    if (live.length) sortie.push({ key: "live", label: "Connectées", sessions: live });
    if (past.length) sortie.push({ key: "past", label: "Historique", sessions: past });
    return sortie;
  });

  const codeSessionPickList = computed(() => {
    const cur = activeSession.value;
    return codeSessions.value.filter(
      (s) =>
        s.id !== codeActiveId.value &&
        s.connected !== false &&
        (!cur || !cur.client || !s.client || s.client === cur.client),
    );
  });
  function openSessionPicker(): void {
    void loadSessions();
    codeSlashDismissed.value = true;
    codeModelOpen.value = false;
    codeSessionOpen.value = true;
    codeSessionIdx.value = 0;
    void nextTick(() => {
      focusSaisie();
      defilerLigne("code-session-list", "li[data-code-session-row]", 0);
    });
  }
  function pickSession(row: SessionCode | undefined): void {
    codeSessionOpen.value = false;
    if (row && row.id) void selectSession(row.id);
  }

  function startRename(s: SessionCode): void {
    codeRenamingId.value = s.id;
    codeRenameText.value = s.title || "";
    void nextTick(() => {
      const el = document.getElementById("code-rename-input") as HTMLInputElement | null;
      if (el) {
        el.focus();
        el.select();
      }
    });
  }
  function cancelRename(): void {
    codeRenamingId.value = "";
  }
  async function submitRename(): Promise<void> {
    const sid = codeRenamingId.value;
    const title = codeRenameText.value.trim();
    codeRenamingId.value = "";
    if (!sid || !title) return;
    if ((await api.renommer(sid, title))?.ok) showToast("Renommage envoyé à la CLI.", "info");
  }

  async function loadPermissions(sid: string): Promise<void> {
    const d = await api.permissions(sid);
    if (d && sid === codeActiveId.value) codePerms.value = d as PermissionCode[];
  }
  async function replyPermission(perm: PermissionCode, response: string): Promise<void> {
    const sid = codeActiveId.value;
    if (!sid || !perm || !perm.id) return;
    const r = await api.repondrePermission(sid, perm.id, response);
    if (r?.ok) codePerms.value = codePerms.value.filter((x) => x.id !== perm.id);
  }

  async function loadQuestions(sid: string): Promise<void> {
    const d = await api.questions(sid);
    if (d && sid === codeActiveId.value) codeQuestions.value = d as QuestionCode[];
  }
  const cleQuestion = (q: QuestionCode, i: number): string => `${q.id}:${i}`;
  function questionPicked(q: QuestionCode, i: number, label: string): boolean {
    return ((codeQPick.value[q.id] || [])[i] || []).includes(label);
  }
  function toggleAnswer(q: QuestionCode, i: number, label: string): void {
    const tout = { ...codeQPick.value };
    const rangs = (tout[q.id] || []).slice();
    const cur = (rangs[i] || []).slice();
    const sq = (q.questions || [])[i] || {};
    const at = cur.indexOf(label);
    if (at !== -1) cur.splice(at, 1);
    else if (sq.multiple) cur.push(label);
    else cur.splice(0, cur.length, label);
    rangs[i] = cur;
    tout[q.id] = rangs;
    codeQPick.value = tout;
  }
  function questionAnswers(q: QuestionCode): string[][] {
    return (q.questions || []).map((_sq, i) => {
      const choisies = ((codeQPick.value[q.id] || [])[i] || []).slice();
      const libre = String(codeQText.value[cleQuestion(q, i)] || "").trim();
      if (libre) choisies.push(libre);
      return choisies;
    });
  }
  function questionReady(q: QuestionCode): boolean {
    const a = questionAnswers(q);
    return a.length > 0 && a.every((x) => x.length > 0);
  }
  function retirerQuestion(qid: string): void {
    codeQuestions.value = codeQuestions.value.filter((x) => x.id !== qid);
    if (codeQPick.value[qid]) {
      const tout = { ...codeQPick.value };
      delete tout[qid];
      codeQPick.value = tout;
    }
    const txt = { ...codeQText.value };
    let change = false;
    for (const k of Object.keys(txt)) {
      if (k.startsWith(`${qid}:`)) {
        delete txt[k];
        change = true;
      }
    }
    if (change) codeQText.value = txt;
  }
  async function answerQuestion(q: QuestionCode, reject?: boolean): Promise<void> {
    const sid = codeActiveId.value;
    if (!sid || !q || !q.id) return;
    if (!reject && !questionReady(q)) return;
    const body = reject ? { reject: true } : { answers: questionAnswers(q) };
    const r = await api.repondreQuestion(
      sid,
      q.id,
      body,
      "Réponse non transmise — CLI déconnectée ou plugin à mettre à jour (/remote update côté CLI).",
    );
    if (r?.ok) retirerQuestion(q.id);
  }

  function codeAgo(t: number | null | undefined): string {
    if (!t) return "";
    if (t > 1e12) t = t / 1000;
    const s = Math.max(0, Math.floor(Date.now() / 1000 - t));
    if (s < 60) return "à l'instant";
    if (s < 3600) return `il y a ${Math.floor(s / 60)} min`;
    if (s < 86400) return `il y a ${Math.floor(s / 3600)} h`;
    return `il y a ${Math.floor(s / 86400)} j`;
  }

  function defilerBas(force?: boolean): void {
    if (!force && !collerAuBas) return;
    void nextTick(() => {
      const el = transcriptEl.value;
      if (el) el.scrollTop = el.scrollHeight;
    });
  }
  function onTranscriptScroll(): void {
    const el = transcriptEl.value;
    if (el) collerAuBas = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
  }

  /** Génération en cours : le drapeau du store ne suffit pas, un dernier message assistant terminé prouve que plus rien ne tourne. */
  const codeBusyActive = computed(() => {
    if (!codeBusy.value[codeActiveId.value]) return false;
    const msgs = codeMessages.value;
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      if (!m || m.role !== "assistant") continue;
      return !dict(m.info["time"])["completed"];
    }
    return true;
  });
  /** Index du message que la CLI écrit : c'est lui qui porte le statut d'activité ; -1 si aucun. */
  const codeLiveIdx = computed(() => {
    if (!codeBusyActive.value) return -1;
    const msgs = codeMessages.value;
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      if (!m || m.role === "note") continue;
      if (m.role !== "assistant") return -1;
      return dict(m.info["time"])["completed"] ? -1 : i;
    }
    return -1;
  });
  function codeMsgError(m: MessageOpencode | null | undefined): { name: string; message: string } | null {
    const e = m && m.info ? m.info["error"] : null;
    if (!e || typeof e !== "object") return null;
    const ed = dict(e);
    const data = dict(ed["data"]);
    const msg =
      typeof data["message"] === "string"
        ? data["message"]
        : typeof ed["message"] === "string"
          ? ed["message"]
          : "";
    const erreur = { name: String(ed["name"] || "Erreur"), message: msg };
    return erreur;
  }
  watch(codeBusyActive, (v) => rendu.codeClock(v));
  function setBusy(sid: string | undefined, v: boolean): void {
    if (sid && !!codeBusy.value[sid] !== !!v) codeBusy.value = { ...codeBusy.value, [sid]: !!v };
  }
  /** Parts stockées brutes : aucune n'est modifiée en place (une mise à jour la remplace), la réactivité profonde ne ferait qu'envelopper chaque sortie. */
  function brute(p: unknown): PartOpencode {
    return (p && typeof p === "object" ? markRaw(p as PartOpencode) : p) as PartOpencode;
  }
  function mapMessages(raw: unknown): MessageOpencode[] {
    return liste<Dict>(raw).map((m) => {
      const info = dict(m["info"]);
      return {
        id: (info["id"] as string) || "",
        role: (info["role"] as string) || "assistant",
        parts: liste(m["parts"]).map(brute),
        info,
      };
    });
  }

  async function loadHealth(): Promise<void> {
    const d = await api.sante();
    if (d) {
      codeAvailable.value = d.available;
      codeConnected.value = d.connected;
      codePluginVersion.value = d.plugin_version || 0;
      codePluginStale.value = !!(d.plugin_version && d.plugin_current && d.plugin_version < d.plugin_current);
    }
  }
  async function loadConfig(): Promise<void> {
    const d = await api.config();
    // Le serveur ne rend plus de jeton : celui créé dans cette page reste affiché jusqu'à ce qu'on la quitte.
    if (d) codeConfig.value = { ...codeConfig.value, ...d, token: codeConfig.value.token || "" };
  }
  let minuterieListe: ReturnType<typeof setTimeout> | null = null;
  /** `session.updated` arrive plusieurs fois par tour : un seul rechargement par rafale. */
  function rechargerSessionsBientot(): void {
    if (minuterieListe) clearTimeout(minuterieListe);
    minuterieListe = setTimeout(() => {
      minuterieListe = null;
      void loadSessions();
    }, 400);
  }
  async function loadSessions(): Promise<void> {
    const d = await api.sessions();
    if (d) {
      codeSessions.value = d as SessionCode[];
      const b: Record<string, boolean> = {};
      for (const s of d as SessionCode[]) if (s && s.id) b[s.id] = !!s.busy;
      const cur = codeBusy.value || {};
      const ks = Object.keys(b);
      if (ks.length !== Object.keys(cur).length || ks.some((k) => cur[k] !== b[k])) codeBusy.value = b;
    }
  }
  async function loadMessages(sid: string): Promise<void> {
    codeMessages.value = mapMessages(await api.messages(sid));
    defilerBas();
  }
  async function loadCommands(): Promise<void> {
    const d = await api.commandes();
    if (d) codeCommands.value = d as CommandeCode[];
  }
  async function loadModels(): Promise<void> {
    const d = await api.modeles();
    if (d) {
      codeModels.value = d.providers as FournisseurModeles[];
      codeModelsDefault.value = d.default as Record<string, string>;
    }
  }
  async function loadClients(): Promise<void> {
    const d = await api.clients();
    if (d) codeClients.value = d as typeof codeClients.value;
  }
  async function loadAgents(): Promise<void> {
    const d = await api.agents();
    if (d) {
      codeAgents.value = d.agents as AgentCode[];
      codeAgentDefault.value = d.default;
    }
  }

  async function openCodePage(): Promise<void> {
    currentView.value = "code";
    codeActiveId.value = "";
    codeMessages.value = [];
    codeModelOpen.value = false;
    codeSessionOpen.value = false;
    codePerms.value = [];
    codeQuestions.value = [];
    codeRenamingId.value = "";
    codeLoading.value = true;
    await loadHealth();
    // L'utilisateur a pu quitter la page pendant les await : armer le flux ici le laisserait orphelin.
    if (currentView.value !== "code") {
      codeLoading.value = false;
      return;
    }
    if (codeAvailable.value) {
      await Promise.all([
        loadConfig(),
        loadSessions(),
        loadCommands(),
        loadModels(),
        loadAgents(),
        loadClients(),
      ]);
      if (currentView.value !== "code") {
        codeLoading.value = false;
        return;
      }
      sseDejaOuvert = false;
      connectStream();
      codeShowConnect.value = !codeSessions.value.length && !codeConnected.value;
      if (!minuterieSante) {
        minuterieSante = setInterval(() => {
          if (document.visibilityState !== "visible") return;
          void loadHealth();
          void loadSessions();
          void loadClients();
        }, 15000);
      }
    }
    codeLoading.value = false;
  }

  /** Échap (chaîne globale, en capture) : ferme d'abord les popovers de la page ; vrai si consommé. */
  function handleEscape(): boolean {
    if (codeRenamingId.value) {
      codeRenamingId.value = "";
      return true;
    }
    if (codeSessionOpen.value) {
      codeSessionOpen.value = false;
      return true;
    }
    if (codeModelOpen.value) {
      codeModelOpen.value = false;
      return true;
    }
    if (codeSlashOpen.value) {
      codeSlashDismissed.value = true;
      return true;
    }
    if (codeShowConnect.value) {
      codeShowConnect.value = false;
      return true;
    }
    return false;
  }

  function backToList(): void {
    codeActiveId.value = "";
    codeMessages.value = [];
    codeModelOpen.value = false;
    codeSessionOpen.value = false;
    codePerms.value = [];
    codeQuestions.value = [];
    rendu.resetCodeUi();
    void loadSessions();
  }
  function closeCodePage(): void {
    if (codeActiveId.value) {
      backToList();
      return;
    }
    currentView.value = "chat";
    disconnectStream();
  }
  async function selectSession(sid: string): Promise<void> {
    codeActiveId.value = sid;
    codeModelOpen.value = false;
    codeSessionOpen.value = false;
    codePerms.value = [];
    codeQuestions.value = [];
    rendu.resetCodeUi();
    collerAuBas = true;
    await Promise.all([loadMessages(sid), loadPermissions(sid), loadQuestions(sid)]);
  }
  async function dismissSession(sid: string): Promise<void> {
    if ((await api.supprimer(sid)) !== null) {
      if (codeActiveId.value === sid) {
        codeActiveId.value = "";
        codeMessages.value = [];
      }
      await loadSessions();
    }
  }
  async function refreshSessions(): Promise<void> {
    if (codeRefreshing.value) return;
    codeRefreshing.value = true;
    try {
      const taches: Array<Promise<void>> = [loadHealth(), loadSessions(), loadCommands(), loadModels()];
      if (codeActiveId.value) {
        taches.push(
          loadMessages(codeActiveId.value),
          loadPermissions(codeActiveId.value),
          loadQuestions(codeActiveId.value),
        );
      }
      await Promise.all(taches);
    } finally {
      codeRefreshing.value = false;
    }
  }

  function autoGrow(): void {
    const el = codeInputRef.value;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }
  function promptInput(): void {
    codeSlashDismissed.value = false;
    codeSlashIdx.value = 0;
    autoGrow();
  }
  async function sendAction(action: string): Promise<void> {
    const sid = codeActiveId.value;
    if (!sid) return;
    if ((await api.action(sid, action))?.ok) showToast(`Commande /${action} envoyée à la CLI.`, "info");
  }

  const codeActiveClient = computed(() => String(activeSession.value?.client ?? ""));

  /** `cible` explicite depuis la landing (CLI connectée sans session) ; sinon la CLI propriétaire de la session ouverte. */
  async function sendNewSession(cible?: unknown): Promise<void> {
    const cid = (typeof cible === "string" && cible) || codeActiveClient.value;
    if ((await api.nouvelle(cid))?.ok) {
      showToast("Nouvelle session demandée à la CLI.", "info");
      setTimeout(() => {
        void loadSessions();
        void loadClients();
      }, 1200);
    }
  }
  async function sendExit(): Promise<void> {
    const cid = codeActiveClient.value;
    if (!cid) {
      showToast("CLI inconnue pour cette session.", "error");
      return;
    }
    const ok = await openConfirm(
      "Fermer opencode ?",
      "La CLI se ferme sur la machine distante ; les sessions restent dans l'historique.",
    );
    if (!ok) return;
    if ((await api.quitter(cid))?.ok) showToast("Fermeture demandée à la CLI.", "info");
  }
  function executerCommandeApp(c: CommandeCode): void {
    if (c.name === "model") openModelPicker();
    else if (c.name === "session") openSessionPicker();
    else if (c.appFn === "agent") selectAgent(c.toAgent);
    else if (c.appFn === "new") void sendNewSession();
    else if (c.appFn === "exit") void sendExit();
    else if (c.action) void sendAction(c.action);
  }
  function choisirSlash(c: CommandeCode | undefined): void {
    if (!c) return;
    if (c.app) {
      codePrompt.value = "";
      codeSlashDismissed.value = true;
      void nextTick(autoGrow);
      executerCommandeApp(c);
      return;
    }
    codePrompt.value = `/${c.name} `;
    codeSlashDismissed.value = true;
    void nextTick(() => {
      focusSaisie();
      autoGrow();
    });
  }

  /** Navigation clavier d'un menu déroulant (session, modèle, slash) ; vrai si la touche est prise. */
  function naviguerMenu(
    e: KeyboardEvent,
    idx: Ref<number>,
    taille: number,
    choisir: () => void,
    fermer: () => void,
    defiler: (i: number) => void,
  ): boolean {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      idx.value = Math.min(idx.value + 1, taille - 1);
      defiler(idx.value);
      return true;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      idx.value = Math.max(idx.value - 1, 0);
      defiler(idx.value);
      return true;
    }
    if (e.key === "Enter" || e.key === "Tab") {
      e.preventDefault();
      choisir();
      return true;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      fermer();
      return true;
    }
    return false;
  }
  function promptKeydown(e: KeyboardEvent): void {
    if (
      codeSessionOpen.value &&
      naviguerMenu(
        e,
        codeSessionIdx,
        codeSessionPickList.value.length,
        () => pickSession(codeSessionPickList.value[codeSessionIdx.value]),
        () => (codeSessionOpen.value = false),
        (i) => defilerLigne("code-session-list", "li[data-code-session-row]", i),
      )
    ) {
      return;
    }
    if (
      codeModelOpen.value &&
      naviguerMenu(
        e,
        codeModelIdx,
        codeModelList.value.length,
        () => selectModel(codeModelList.value[codeModelIdx.value]),
        () => (codeModelOpen.value = false),
        (i) => defilerLigne("code-model-list", "li[data-code-model-row]", i),
      )
    ) {
      return;
    }
    if (
      codeSlashOpen.value &&
      naviguerMenu(
        e,
        codeSlashIdx,
        codeSlashList.value.length,
        () => choisirSlash(codeSlashList.value[codeSlashIdx.value]),
        () => (codeSlashDismissed.value = true),
        (i) => defilerLigne("code-slash-list", "li[data-code-slash-row]", i),
      )
    ) {
      return;
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void sendPrompt();
    }
  }

  function retirerEchos(id?: string): void {
    codeMessages.value = codeMessages.value.filter((x) => !(x.pending && (!id || x.id === id)));
  }
  async function sendPrompt(): Promise<void> {
    const sid = codeActiveId.value;
    const text = codePrompt.value.trim();
    if (!sid || !text || codeSending.value) return;
    const m = text.match(/^\/(\S+)(?:\s+([\s\S]*))?$/);
    // Commande « app » tapée à la main : `codeAppCmds` et pas la liste statique (les modes /build, /plan en sont dérivés).
    const appCmd = m ? codeAppCmds.value.find((c) => c.name === m[1]) : undefined;
    if (appCmd) {
      codePrompt.value = "";
      void nextTick(autoGrow);
      executerCommandeApp(appCmd);
      return;
    }
    const connue = m ? codeCommands.value.find((c) => c.name === m[1]) : undefined;
    codeSending.value = true;
    const pending: MessageOpencode = {
      id: `pending-${Date.now()}`,
      role: "user",
      pending: true,
      info: { role: "user" },
      parts: [{ id: "p0", type: "text", text }],
    };
    codeMessages.value.push(pending);
    defilerBas(true);
    try {
      const sel = codeModelSel.value[sid];
      const agent = codeAgentSel.value[sid];
      // Modèle et agent ne partent que si l'utilisateur les a choisis : ne pas figer le mode que le TUI vient de changer.
      const r =
        connue && m
          ? await api.commande(sid, m[1] ?? "", m[2] || "")
          : await api.prompt(
              sid,
              Object.assign(
                { text },
                sel ? { model: { providerID: sel.providerID, modelID: sel.modelID } } : {},
                agent ? { agent } : {},
              ),
            );
      if (r?.ok) {
        codePrompt.value = "";
        void nextTick(autoGrow);
      } else {
        retirerEchos(pending.id);
      }
    } finally {
      codeSending.value = false;
    }
  }
  async function abortSession(): Promise<void> {
    const sid = codeActiveId.value;
    if (!sid) return;
    if ((await api.interrompre(sid))?.ok) showToast("Interruption demandée.", "info");
  }
  async function createToken(): Promise<void> {
    const d = await api.creerJeton();
    if (d?.token) {
      codeConfig.value = { ...codeConfig.value, token: d.token };
      showToast("Jeton créé : copiez-le maintenant, il ne sera plus affiché.", "success");
    }
  }
  async function rotateToken(): Promise<void> {
    const d = await api.tournerJeton();
    if (d?.token) {
      codeConfig.value = { ...codeConfig.value, token: d.token };
      showToast(
        "Tous les jetons opencode sont révoqués ; ré-appairez vos postes (/remote login ou ce nouveau jeton).",
        "success",
      );
    }
  }

  /** Confirme le code à 6 caractères affiché par `/remote login` : c'est ce qui rattache le poste au bon utilisateur. */
  async function submitPairCode(): Promise<void> {
    const code = String(codePairCode.value || "")
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, "");
    if (code.length !== 6) {
      showToast("Le code d'appairage fait 6 caractères.", "error");
      return;
    }
    codePairBusy.value = true;
    try {
      const res = await fetchAuth(
        "/api/code/pair/confirm",
        { method: "POST", headers: JSON_ENTETES, body: JSON.stringify({ code }) },
        true,
      );
      if (!res) return;
      if (res.ok) {
        codePairCode.value = "";
        showToast("Poste appairé — la session va apparaître.", "success");
        void refreshSessions();
      } else if (res.status === 404) showToast("Code inconnu ou expiré — relancez /remote login.", "error");
      else if (res.status === 429) showToast("Trop d'essais — réessayez dans quelques minutes.", "error");
      else showToast(`Appairage impossible (HTTP ${res.status}).`, "error");
    } finally {
      codePairBusy.value = false;
    }
  }
  /** navigator.clipboard n'existe pas en contexte non sécurisé (HTTP sur le LAN) : repli execCommand. */
  function copieSecours(text: string): boolean {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.cssText = "position:fixed;left:-9999px;top:0;opacity:0";
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(ta);
      return ok;
    } catch {
      return false;
    }
  }
  function copyText(t: string): void {
    const ok = (): void => showToast("Copié", "success");
    const echec = (): void => {
      if (copieSecours(t)) ok();
      else showToast("Copie impossible", "error");
    };
    if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(t).then(ok).catch(echec);
    else echec();
  }

  function upsertMessage(info: Dict | undefined): void {
    if (!info || !info["id"] || info["sessionID"] !== codeActiveId.value) return;
    if (info["role"] === "user") retirerEchos();
    const m = codeMessages.value.find((x) => x.id === info["id"]);
    if (!m)
      codeMessages.value.push({
        id: String(info["id"]),
        role: String(info["role"] || "assistant"),
        parts: [],
        info,
      });
    else {
      m.role = String(info["role"] || m.role);
      m.info = info;
      m._rev = (m._rev || 0) + 1;
    }
  }
  function synchroReflexion(): void {
    requestAnimationFrame(() => {
      const el = transcriptEl.value;
      if (!el) return;
      el.querySelectorAll("details[data-code-think][open] pre").forEach((p) => {
        p.scrollTop = p.scrollHeight;
      });
    });
  }
  function appliquerPart(part: PartOpencode | undefined): boolean {
    const mid = part?.["messageID"] as string | undefined;
    if (!part || !mid || part["sessionID"] !== codeActiveId.value) return false;
    let m = codeMessages.value.find((x) => x.id === mid);
    if (!m) {
      m = {
        id: mid,
        role: "assistant",
        parts: [],
        info: { id: mid, role: "assistant", sessionID: part["sessionID"] },
      };
      codeMessages.value.push(m);
    }
    const i = m.parts.findIndex((p) => p.id === part.id);
    if (i === -1) m.parts.push(brute(part));
    else m.parts.splice(i, 1, brute(part));
    // Le compteur de révision invalide le v-memo de cette ligne ; les autres ne re-diffent plus à chaque delta.
    m._rev = (m._rev || 0) + 1;
    return true;
  }
  let tamponParts: Array<PartOpencode | undefined> = [];
  let minuterieParts: ReturnType<typeof setTimeout> | null = null;
  function viderTamponParts(): void {
    minuterieParts = null;
    // Chaque événement porte la part complète : dans une rafale, seule sa dernière version compte.
    const derniere = new Map<unknown, PartOpencode | undefined>();
    for (const part of tamponParts) if (part && part.id) derniere.set(part.id, part);
    const buf = tamponParts.filter((part) => !(part && part.id) || derniere.get(part.id) === part);
    tamponParts = [];
    let applique = false;
    let reflexion = false;
    for (const part of buf) {
      if (appliquerPart(part)) {
        applique = true;
        if (part?.type === "reasoning") reflexion = true;
      }
    }
    if (!applique) return;
    if (reflexion) synchroReflexion();
    defilerBas();
  }
  function empilerPart(part: PartOpencode | undefined): void {
    tamponParts.push(part);
    if (minuterieParts === null) minuterieParts = setTimeout(viderTamponParts, 40);
  }
  function surEvenement(ev: Dict): void {
    const t = ev["type"] as string;
    const p = dict(ev["properties"]);
    if (t === "client.disconnected") {
      void loadHealth();
      void loadSessions();
      return;
    }
    codeConnected.value = true;
    if (t === "message.updated") {
      upsertMessage(p["info"] as Dict | undefined);
      const info = dict(p["info"]);
      if (info["role"] === "assistant" && info["sessionID"]) {
        setBusy(info["sessionID"] as string, !dict(info["time"])["completed"]);
      }
    } else if (t === "message.part.updated") {
      const part = p["part"] as PartOpencode | undefined;
      empilerPart(part);
      if (part && part["sessionID"]) setBusy(part["sessionID"] as string, true);
    } else if (t === "message.removed") {
      if (p["sessionID"] === codeActiveId.value && p["messageID"]) {
        codeMessages.value = codeMessages.value.filter((x) => x.id !== p["messageID"]);
        tamponParts = tamponParts.filter((x) => !x || x["messageID"] !== p["messageID"]);
      }
    } else if (t === "session.snapshot") {
      void loadSessions();
      const sid = dict(p["session"])["id"] as string | undefined;
      if (sid && sid === codeActiveId.value) void loadMessages(sid);
    } else if (t === "client.commands") {
      if (Array.isArray(p["commands"])) codeCommands.value = p["commands"] as CommandeCode[];
    } else if (t === "client.models") {
      if (Array.isArray(p["providers"])) codeModels.value = p["providers"] as FournisseurModeles[];
      if (p["default"] && typeof p["default"] === "object")
        codeModelsDefault.value = p["default"] as Record<string, string>;
    } else if (t === "client.agents") {
      if (Array.isArray(p["agents"])) codeAgents.value = p["agents"] as AgentCode[];
      if (p["default"]) codeAgentDefault.value = String(p["default"]);
    } else if (t === "code.note") {
      const note = dict(p["note"]);
      const ninfo = dict(note["info"]);
      if (
        Object.keys(ninfo).length &&
        p["sessionID"] === codeActiveId.value &&
        !codeMessages.value.some((x) => x.id === ninfo["id"])
      ) {
        codeMessages.value.push({ id: String(ninfo["id"]), role: "note", parts: [], info: ninfo });
        defilerBas();
      }
    } else if (t === "permission.updated") {
      if (p["id"] && p["sessionID"] === codeActiveId.value) {
        const i = codePerms.value.findIndex((x) => x.id === p["id"]);
        if (i === -1) codePerms.value.push(p as PermissionCode);
        else codePerms.value.splice(i, 1, p as PermissionCode);
      }
    } else if (t === "permission.replied") {
      if (p["sessionID"] === codeActiveId.value)
        codePerms.value = codePerms.value.filter((x) => x.id !== p["permissionID"]);
    } else if (t === "question.asked") {
      if (p["id"] && p["sessionID"] === codeActiveId.value) {
        const i = codeQuestions.value.findIndex((x) => x.id === p["id"]);
        if (i === -1) codeQuestions.value.push(p as QuestionCode);
        else codeQuestions.value.splice(i, 1, p as QuestionCode);
      }
    } else if (t === "question.replied" || t === "question.rejected") {
      if (p["sessionID"] === codeActiveId.value && p["questionID"])
        retirerQuestion(p["questionID"] as string);
    } else if (t === "session.idle")
      setBusy((p["sessionID"] as string) || (dict(p["info"])["id"] as string), false);
    else if (t === "session.created" || t === "session.updated" || t === "session.deleted")
      rechargerSessionsBientot();
    else if (t === "session.error") {
      setBusy((p["sessionID"] as string) || (dict(p["info"])["id"] as string), false);
      const err = dict(p["error"]);
      const msg = (dict(err["data"])["message"] as string) || (err["name"] as string) || "";
      if (msg) showToast(`opencode : ${msg}`, "error");
    }
  }
  function connectStream(): void {
    disconnectStream();
    // Garde d'auth : une session expirée bouclerait sur des 401 sans fin.
    if (ctx.user && !ctx.user.value) return;
    try {
      evtSource = new EventSource("/api/code/stream", { withCredentials: true });
    } catch {
      planifierReconnexion();
      return;
    }
    evtSource.onopen = () => {
      tentativeSse = 0;
      // Le bus n'a pas de rejeu : tout ce qui a été émis pendant une coupure est perdu, on relit l'état serveur.
      if (sseDejaOuvert) resynchroniser();
      sseDejaOuvert = true;
    };
    evtSource.onmessage = (e: MessageEvent<string>) => {
      let d: Dict;
      try {
        d = JSON.parse(e.data) as Dict;
      } catch {
        return;
      }
      if (d && d["__control"]) {
        surControle(dict(d["__control"]));
        return;
      }
      try {
        surEvenement(d);
      } catch {
        /* un événement mal formé ne doit pas couper le flux */
      }
    };
    evtSource.onerror = () => {
      if (evtSource && evtSource.readyState === 2) {
        try {
          evtSource.close();
        } catch {
          /* déjà fermé */
        }
        evtSource = null;
        if (currentView.value === "code") planifierReconnexion();
      }
    };
  }
  function fermerFlux(): void {
    if (evtSource) {
      try {
        evtSource.close();
      } catch {
        /* déjà fermé */
      }
      evtSource = null;
    }
  }
  function surControle(c: Dict): void {
    const t = c["type"];
    if (t === "session_expired") {
      disconnectStream();
      if (ctx.handleSessionExpired) ctx.handleSessionExpired();
    } else if (t === "worker_recycling") {
      fermerFlux();
      if (minuterieSse) clearTimeout(minuterieSse);
      minuterieSse = setTimeout(() => {
        minuterieSse = null;
        if (currentView.value === "code") connectStream();
      }, 750);
    } else if (t === "error") {
      fermerFlux();
      if (currentView.value === "code") planifierReconnexion();
    }
  }
  function resynchroniser(): void {
    void loadHealth();
    void loadSessions();
    if (codeActiveId.value) void loadMessages(codeActiveId.value);
  }
  function planifierReconnexion(): void {
    if (minuterieSse) return;
    const delai = Math.min(1000 * Math.pow(2, tentativeSse++), SSE_MAX);
    minuterieSse = setTimeout(() => {
      minuterieSse = null;
      if (currentView.value === "code") connectStream();
    }, delai);
  }
  function disconnectStream(): void {
    if (minuterieSse) {
      clearTimeout(minuterieSse);
      minuterieSse = null;
    }
    if (minuterieListe) {
      clearTimeout(minuterieListe);
      minuterieListe = null;
    }
    if (minuterieSante) {
      clearInterval(minuterieSante);
      minuterieSante = null;
    }
    fermerFlux();
    rendu.codeClock(false);
  }

  /** Purge de déconnexion : coupe le flux et vide tout l'état sensible (sessions, transcript, jeton) pour l'utilisateur suivant. */
  function codeResetOnLogout(): void {
    disconnectStream();
    codeSessions.value = [];
    codeMessages.value = [];
    codeActiveId.value = "";
    codeConnected.value = false;
    codeShowConnect.value = false;
    codePerms.value = [];
    codeBusy.value = {};
    codePrompt.value = "";
    codeSending.value = false;
    codeCommands.value = [];
    codeAgents.value = [];
    codeClients.value = [];
    codeAgentDefault.value = "";
    codeAgentSel.value = {};
    codePairCode.value = "";
    codeConfig.value = { app_url: "", token: "", plugin_url: "" };
    codePluginStale.value = false;
  }

  return {
    ...rendu,
    codeAvailable,
    codeConnected,
    codeLoading,
    codeSessions,
    codeActiveId,
    codeMessages,
    codeBusy,
    codeBusyActive,
    codeLiveIdx,
    codeMsgError,
    codeShowConnect,
    codeConfig,
    codePluginStale,
    codePrompt,
    codeSending,
    codeRefreshing,
    codeCommands,
    codeSlashIdx,
    codeSlashOpen,
    codeSlashList,
    codeSlashQuery,
    transcriptEl,
    codeInputRef,
    activeSession,
    codeRemoteCmd,
    codeModels,
    codeModelsDefault,
    codeModelOpen,
    codeModelIdx,
    codeModelList,
    codeModelChip,
    codeModelSel,
    codeCanDrive,
    codeAgo,
    codeCtx,
    codeClients,
    codeIdleClients,
    codeAgents,
    codeAgentDefault,
    codeAgentSel,
    codeAgentCur,
    codeAgentShow,
    codeAgentLabel,
    codeSelectAgent: selectAgent,
    codeAgentDesc,
    codeCycleAgent: cycleAgent,
    codePluginVersion,
    codePerms,
    codeQuestions,
    codeQPick,
    codeQText,
    codeSessionGroups,
    codeSessionPickList,
    codeSessionOpen,
    codeSessionIdx,
    codeRenamingId,
    codeRenameText,
    openCodePage,
    closeCodePage,
    codeBackToList: backToList,
    codeEscape: handleEscape,
    codeOpenModelPicker: openModelPicker,
    codeSelectModel: selectModel,
    codeClearModel: clearModel,
    codeSetModelIdx: (i: number): void => {
      codeModelIdx.value = i;
    },
    codeOpenSessionPicker: openSessionPicker,
    codePickSession: pickSession,
    codeSetSessionIdx: (i: number): void => {
      codeSessionIdx.value = i;
    },
    codeStartRename: startRename,
    codeCancelRename: cancelRename,
    codeSubmitRename: submitRename,
    codeReplyPermission: replyPermission,
    codeAnswerQuestion: answerQuestion,
    codeToggleAnswer: toggleAnswer,
    codeQuestionPicked: questionPicked,
    codeQuestionReady: questionReady,
    codeSelectSession: selectSession,
    codeDismissSession: dismissSession,
    codeSendPrompt: sendPrompt,
    codeAbortSession: abortSession,
    codeRefreshSessions: refreshSessions,
    codeTranscriptScroll: onTranscriptScroll,
    codePromptKeydown: promptKeydown,
    codePromptInput: promptInput,
    codeSelectSlash: choisirSlash,
    codeSetSlashIdx: (i: number): void => {
      codeSlashIdx.value = i;
    },
    codeRotateToken: rotateToken,
    codeCreateToken: createToken,
    codeCopy: copyText,
    codeActiveClient,
    codeNewSession: sendNewSession,
    codeExit: sendExit,
    codePairCode,
    codePairBusy,
    codeSubmitPairCode: submitPairCode,
    codeDisconnectStream: disconnectStream,
    codeResetOnLogout,
  };
}

export type SurfaceCode = ReturnType<typeof creerCode>;
