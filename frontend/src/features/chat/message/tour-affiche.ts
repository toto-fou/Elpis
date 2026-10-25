// SPDX-License-Identifier: MIT
/** frontend/src/features/chat/message/tour-affiche.ts — état d'affichage d'un tour commun aux déroulés (chronologie, en bloc, journal) : horloge, blocs, replis, détail d'outil, texte vivant, captures, graphiques, agents, tâches de fond. */
import { computed, inject, onUnmounted, ref, watch } from "vue";

import type { ResumeJob } from "@elpis/contracts";

import { preferencesChat } from "../../reglages/affichage-chat.ts";
import { CLE_MODALES } from "../modales/domaine.ts";
import { fmtCompression, fmtDuree } from "../outils/format.ts";
import type { EtapeOutil } from "../outils/types.ts";
import { CLE_FIL, CLE_PAGE, domaine } from "../page/domaines.ts";
import { capturesDuTour, visionneuseCaptures } from "./captures-tour.ts";
import { chronologieTour } from "./chronologie.ts";
import type { BlocFil } from "./chronologie.ts";
import { graphiquesNonCites } from "./graphiques-tour.ts";
import { jobDeLEtape } from "./taches-fond.ts";
import type { EntreeMessage } from "./types.ts";

export type BlocJob = Extract<BlocFil, { k: "job" }>;
export type BlocAgents = Extract<BlocFil, { k: "agents" }>;

/** Résumé d'une compression de contexte : gain et durée, ou son état. */
export function resumeCompression(s: EtapeOutil): string {
  if (s.status === "running") return "en cours…";
  if (s.status === "skipped") return s.reasonLabel || "non appliquée";
  const gain = fmtCompression(s.stats);
  const ms = s.stats?.duration_ms;
  return [gain, typeof ms === "number" && ms > 0 ? fmtDuree(ms) : ""].filter(Boolean).join(" · ");
}

/** État d'affichage d'un tour (dans le `setup` d'un déroulé) ; les réflexions suivent la préférence du compte. */
export function utiliserTour(entree: () => EntreeMessage) {
  const fil = domaine(CLE_FIL);
  const pref = preferencesChat();
  const modales = inject(CLE_MODALES, null);
  // Tâches de fond de la conversation (page du chat) ; absentes quand le fil est monté seul.
  const page = inject(CLE_PAGE, null);
  const msg = () => entree().msg;

  // Horloge des étapes vivantes : une seconde, seulement pendant le flux.
  const maintenant = ref(Date.now());
  let minuterie: ReturnType<typeof globalThis.setInterval> | null = null;
  watch(
    () => !!msg().isStreaming,
    (vivant) => {
      if (minuterie) globalThis.clearInterval(minuterie);
      minuterie = vivant ? globalThis.setInterval(() => (maintenant.value = Date.now()), 1000) : null;
      maintenant.value = Date.now();
    },
    { immediate: true },
  );
  onUnmounted(() => {
    if (minuterie) globalThis.clearInterval(minuterie);
  });

  const blocs = computed(() => {
    const b = chronologieTour(msg(), maintenant.value);
    return pref.reflexions === "hidden" ? b.filter((x) => x.k !== "reflexion") : b;
  });
  const ouverts = computed(() => msg()._filOuverts ?? {});
  const detail = computed(() => msg()._activeToolStep ?? null);
  const lignesMemoire = computed(() => fil.effectLinesFor(msg(), entree().idx));
  const dernier = computed(() => entree().idx === fil.lastAssistantIdx);

  const vivant = computed(() => {
    const m = msg();
    const texte = m._pendingPreContent || "";
    if (!texte.trim() || !dernier.value) return null;
    return m._ppBlocks || m._ppActiveHtml
      ? {
          isStreaming: true,
          content: texte,
          _mdBlocks: m._ppBlocks ?? null,
          _mdActiveHtml: m._ppActiveHtml ?? "",
        }
      : { content: texte };
  });

  const captures = computed(() => (pref.captures ? capturesDuTour(msg()) : []));
  const visionneuse = computed(() => visionneuseCaptures(captures.value));
  const graphiques = computed(() => graphiquesNonCites(msg()));

  function voirCapture(rang: number): void {
    fil.openImageViewer(visionneuse.value.items, rang, { captures: true });
  }

  // Pendant la navigation : la dernière capture sous le dernier groupe d'étapes, tant que rien d'autre ne le suit.
  const apercu = computed(() => {
    const c = captures.value[captures.value.length - 1];
    if (!c || !msg().isStreaming || !dernier.value || vivant.value) return null;
    const i = blocs.value.findLastIndex((b) => b.k !== "reflexion");
    const b = blocs.value[i];
    if (b?.k !== "etapes") return null;
    const lie = b.etapes.some(
      (e) => e.flat === c.flat || (e.etape.status === "running" && (e.etape.name ?? "").startsWith("pw_")),
    );
    return lie ? { cle: b.cle, url: c.url, attente: c.attente } : null;
  });

  function basculer(cle: string): void {
    fil.setMsgUi(entree(), { _filOuverts: { ...ouverts.value, [cle]: !ouverts.value[cle] } });
  }
  // Une réflexion s'ouvre par défaut quand le compte les veut dépliées ; un clic l'inverse.
  function reflexionOuverte(cle: string): boolean {
    const o = ouverts.value[cle];
    return o === undefined ? pref.reflexions === "expanded" : !!o;
  }
  function basculerReflexion(cle: string): void {
    fil.setMsgUi(entree(), { _filOuverts: { ...ouverts.value, [cle]: !reflexionOuverte(cle) } });
  }
  function basculerDetail(flat: number): void {
    fil.setMsgUi(entree(), { _activeToolStep: detail.value === flat ? null : flat });
  }

  function agentsDe(b: BlocAgents) {
    const runs = msg().taskRuns ?? [];
    return b.agents.flatMap((a) => {
      const run = runs[a.ri];
      return run ? [{ run, ri: a.ri, callId: a.etape.callId ?? null }] : [];
    });
  }
  function jobDe(b: BlocJob): ResumeJob | null {
    return page ? jobDeLEtape(b.etape, page.jobsChat) : null;
  }
  // Journal dans l'éditeur, sinon le volet des tâches de fond ; job inconnu : détail de l'appel.
  function ouvrirJob(b: BlocJob): void {
    const job = jobDe(b);
    if (!page || !job) basculerDetail(b.flat);
    else if (fil.settings.enable_editor) page.jobsOuvrirJournal(job);
    else page.jobsBasculer(true);
  }
  // Agent dont le volet est ouvert : sa ligne reste marquée.
  const agentActif = computed(() => {
    const tm = modales?.taskModal;
    return tm && tm.idx === entree().idx ? tm.ri : null;
  });

  return {
    fil,
    pref,
    maintenant,
    blocs,
    ouverts,
    detail,
    lignesMemoire,
    dernier,
    vivant,
    captures,
    visionneuse,
    graphiques,
    apercu,
    voirCapture,
    basculer,
    reflexionOuverte,
    basculerReflexion,
    basculerDetail,
    agentsDe,
    jobDe,
    ouvrirJob,
    agentActif,
  };
}
