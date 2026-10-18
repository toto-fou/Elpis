// SPDX-License-Identifier: MIT
/** frontend/src/features/chat/coeur/segments-vue.ts — segments texte/outils d'un message pour l'affichage (portés d'`app-chat.js`) : groupes par narration, console shell par segment, conteneur « Travail de l'assistant », sous-agents (modale « œil », annulation). */
import { fmtElapsedMs } from "../../../utils/utils-purs.ts";
import { getToolPillsFor, mdSnippet, toolKeyArg } from "./formats.ts";
import type { Pastilles } from "./formats.ts";
import type { CoeurChat, EntreeAffichee } from "./liens.ts";
import type { EtapeChat, ExecutionTache, MessageChat } from "./types.ts";

export interface MetaShell {
  n: number;
  running: boolean;
  nFail: number;
  title: string;
  chip: string;
  dot: string;
  truncated: boolean;
}

export interface GroupeAffiche {
  gi: number;
  text: string;
  steps: EtapeChat[];
  disp: { step: EtapeChat; flat: number; shell: boolean }[];
  nTools: number;
  nComp: number;
  pills: Pastilles | null;
  running: boolean;
  shellRuns: { step: EtapeChat; flat: number }[];
  shellMeta: MetaShell | null;
}

export type ConteneurTravail =
  | { show: false }
  | { show: boolean; nTools: number; nComp: number; running: boolean; label: string; summary: string };

const AUCUNE_ETAPE: EtapeChat[] = [];
const EXCLUS_LIBELLE = new Set(["memory", "todo", "task"]);

function metaShell(runs: { step: EtapeChat; flat: number }[]): MetaShell {
  const n = runs.length;
  const enCours = runs.some((x) => x.step.status === "running");
  const echecs = runs.filter(
    (x) => x.step.shellDone && typeof x.step.shellRc === "number" && x.step.shellRc !== 0,
  ).length;
  const totalMs = runs.reduce((a, x) => a + (x.step.shellMs || 0), 0);
  const dernier = runs[n - 1]?.step;
  const a0 = runs[0]?.step.args;
  const cmd0 = (a0 && (a0["command"] || a0["cmd"])) || "shell";
  let puce = "";
  if (enCours) puce = "en cours…";
  else if (n === 1 && typeof dernier?.shellRc === "number")
    puce = "code " + dernier.shellRc + " · " + fmtElapsedMs(totalMs, { precise: true });
  else if (n > 1)
    puce = echecs ? echecs + " échec" + (echecs > 1 ? "s" : "") : fmtElapsedMs(totalMs, { precise: true });
  return {
    n,
    running: enCours,
    nFail: echecs,
    title: n === 1 ? String(cmd0).slice(0, 96) : n + " commandes",
    chip: puce,
    dot: enCours ? "is-running" : echecs ? "is-err" : "is-ok",
    truncated: runs.some((x) => x.step.shellLiveTruncated),
  };
}

export function creerSegmentsVue(
  c: CoeurChat,
  afficherEtapes: (s: readonly EtapeChat[]) => readonly unknown[],
) {
  const { r, ctx, e, l } = c;
  // Cache par identité de (toolSteps, segTexts) : la ligne vivante remplace le message ~25×/s sans les toucher.
  const cacheGroupes = new WeakMap<EtapeChat[], { segTexts: string[] | null; groups: GroupeAffiche[] }>();
  const cacheConteneur = new WeakMap<GroupeAffiche[], ConteneurTravail>();

  /** Groupes du message par segment (narration puis outils du segment), dérivés et mis en cache. */
  function segGroupsFor(msg: MessageChat | null | undefined): GroupeAffiche[] {
    if (!msg) return [];
    const steps = Array.isArray(msg.toolSteps) ? msg.toolSteps : AUCUNE_ETAPE;
    const brut = Array.isArray(msg.segTexts) && msg.segTexts.length ? msg.segTexts : null;
    const ent = cacheGroupes.get(steps);
    if (ent && ent.segTexts === brut) return ent.groups;
    const segTexts = brut || (steps.length ? [""] : []);
    const groups: GroupeAffiche[] = segTexts.map((t, gi) => ({
      gi,
      text: t || "",
      steps: [],
      disp: [],
      nTools: 0,
      nComp: 0,
      pills: null,
      running: false,
      shellRuns: [],
      shellMeta: null,
    }));
    for (let flat = 0; flat < steps.length; flat++) {
      const s = steps[flat];
      if (!s || !groups.length) continue;
      const g = groups[Math.min(Math.max(s.seg || 0, 0), groups.length - 1)];
      if (!g) continue;
      g.steps.push(s);
      // Une console par segment : commandes shell au premier plan avec des données de console.
      const shell =
        s.name === "execute_shell" &&
        !(s.args && s.args["background"]) &&
        (s.status === "running" || !!s.shellDone || s.shellOut != null);
      if (afficherEtapes([s]).length) {
        g.disp.push({ step: s, flat, shell });
        if (s._kind === "compression") g.nComp++;
        else g.nTools++;
        if (s.status === "running") g.running = true;
      }
      if (shell) g.shellRuns.push({ step: s, flat });
    }
    for (const g of groups) {
      g.pills = getToolPillsFor(g.steps);
      if (g.shellRuns.length) g.shellMeta = metaShell(g.shellRuns);
    }
    cacheGroupes.set(steps, { segTexts: brut, groups });
    return groups;
  }

  /** Agrégat du conteneur « Travail de l'assistant » : compteurs, outil en cours, dernière narration figée. */
  function pipelineFor(msg: MessageChat | null | undefined): ConteneurTravail {
    if (!msg) return { show: false };
    const groups = segGroupsFor(msg);
    if (!groups.length) return { show: false };
    const cache = cacheConteneur.get(groups);
    if (cache) return cache;
    let nTools = 0;
    let nComp = 0;
    let enCours = false;
    for (const g of groups) {
      nTools += g.nTools;
      nComp += g.nComp;
      if (g.running) enCours = true;
    }
    let label = "";
    if (enCours) {
      const steps = msg.toolSteps || [];
      for (let i = steps.length - 1; i >= 0; i--) {
        const s = steps[i];
        if (!s || s.status !== "running" || EXCLUS_LIBELLE.has(s._kind || "")) continue;
        if (s._kind === "compression") label = "compression du contexte";
        else if ((s.name || "").startsWith("rag_")) label = s.ragLabel || "consultation documentaire";
        else {
          const a = toolKeyArg(s);
          label = a ? s.name + " · " + a : s.name || "outil";
        }
        break;
      }
    }
    let resume = "";
    const st = Array.isArray(msg.segTexts) ? msg.segTexts : [];
    for (let i = st.length - 1; i >= 0; i--)
      if ((st[i] || "").trim()) {
        resume = st[i] || "";
        break;
      }
    const out: ConteneurTravail = {
      show: groups.some((g) => g.text || g.disp.length),
      nTools,
      nComp,
      running: enCours,
      label,
      summary: mdSnippet(resume, 140),
    };
    cacheConteneur.set(groups, out);
    return out;
  }

  function toggleToolDetail(entry: EntreeAffichee | null | undefined, flat: number): void {
    const ouvrir = !entry || !entry.msg || entry.msg["_activeToolStep"] !== flat;
    l.setMsgUi(entry, { _activeToolStep: ouvrir ? flat : null });
  }

  // Run localisé dans le flux et remplacé (repli par appel `task`, puis par id, si l'objet a changé entre le rendu et le clic).
  function patcherSousAgent(run: ExecutionTache, p: Partial<ExecutionTache>): ExecutionTache | null {
    const msgs = l.getStreamMsgs();
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      const runs = m?.taskRuns;
      if (!m || !runs || !runs.length) continue;
      let ri = runs.indexOf(run);
      if (ri < 0 && run.callId) ri = runs.findIndex((x) => x.callId === run.callId);
      if (ri < 0 && run.id) ri = runs.findIndex((x) => x.id === run.id);
      const src = runs[ri];
      if (ri < 0 || !src) continue;
      const suite = [...runs];
      const maj = { ...src, ...p };
      suite[ri] = maj;
      msgs[i] = Object.assign({}, m, { taskRuns: suite });
      return maj;
    }
    return null;
  }

  function openTaskModal(entry: EntreeAffichee | null | undefined, ri: number): void {
    const run = entry?.msg?.taskRuns?.[ri];
    if (!entry || !run) return;
    e.taskModalStep.value = null;
    e.taskModal.value = { idx: Number(entry.idx), ri, cid: run.id || null, snap: run };
  }

  function closeTaskModal(): void {
    e.taskModal.value = null;
    e.taskModalStep.value = null;
  }

  /** Run de la modale résolu à chaque rendu (les runs sont remplacés à chaque patch) ; photo d'ouverture en repli. */
  function taskModalRun(): ExecutionTache | null {
    const tm = e.taskModal.value;
    if (!tm) return null;
    const run = r.messages.value[tm.idx]?.taskRuns?.[tm.ri];
    if (run && (!tm.cid || !run.id || run.id === tm.cid)) return run;
    return (tm.snap as ExecutionTache | null) || null;
  }

  // Un enfant encore en file n'a pas d'id : l'annulation part à son événement `spawned`.
  async function cancelTaskRun(run: ExecutionTache | null | undefined): Promise<void> {
    if (!run || run.state !== "running" || run.cancelRequested) return;
    patcherSousAgent(run, { cancelRequested: true });
    if (!run.id) return;
    try {
      await ctx.fetchAuth("/api/chat/task-cancel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ child_id: run.id }),
      });
    } catch {
      /* au mieux */
    }
  }

  return {
    segGroupsFor,
    pipelineFor,
    toggleToolDetail,
    openTaskModal,
    closeTaskModal,
    taskModalRun,
    cancelTaskRun,
  };
}
