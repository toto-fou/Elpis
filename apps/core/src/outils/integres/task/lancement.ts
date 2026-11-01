// SPDX-License-Identifier: MIT
/** apps/core/src/outils/integres/task/lancement.ts — appel `task` : lecture et refus avant lancement, cadre de l'enfant (lecture seule, session web, échéances), inscription parmi les runs actifs, puis run attendu ou détaché en fond. */
import {
  estDict,
  estErreurAnnulation,
  intPy,
  longueurPy,
  prefixePy,
  pyJsonDumps,
  strPy,
  stripPy,
  texteOu,
} from "@elpis/commun";
import type { SessionNavigateur } from "@elpis/securite";

import { emit } from "../../../boucle/evenements";
import { tokenHex } from "../../../boucle/ports";
import { TASK_CHILD_TIMEOUT_S } from "../../../llm/constantes";
import type { Priorite } from "../../../llm/ordonnanceur";
import type { Dict } from "../../../python";
import type { AppelIntegre } from "../../catalogue";
import { err } from "../../erreur-outil";
import { lireArgsTache } from "./arguments";
import type { ArgsTache } from "./arguments";
import { bilanRefus } from "./bilan";
import type { Bilan } from "./bilan";
import { debutTrace } from "./concurrence";
import { rendreSiTourAnnule } from "./conclusion";
import { bilanDe, creerRun } from "./enfant";
import type { Cadre, RunEnfant } from "./enfant";
import { reserveSouple } from "./echeances";
import { emitFinalStep } from "./evenements";
import { executer } from "./execution";
import { inscrireFond, lancerEnFond, relaisEnFond } from "./fond";
import { preparerEnfant } from "./preparation";
import { ACTIFS, ANNULES, marquerDernier } from "./registre";
import { lectureSeuleEffective, reglagesAgents, typeReglable } from "./reglages";
import { pruneResumeStore, resumeLookup } from "./reprise";
import type { AgentSpec } from "./roster";
import { legendeSousLesYeux, plafondAtteint } from "./tour";
import type { TourTaches } from "./tour";

/** Ce que l'appel demande, lu sans rien valider encore ; `agentType` devient celui de l'agent repris. */
interface Demande {
  readonly debutMs: number;
  readonly debutS: number;
  readonly callId: string | null;
  agentType: string;
  readonly prompt: string;
  readonly taskId: string;
  readonly description: string;
  readonly fond: boolean;
  readonly delaiMaxS: number;
  readonly prioriteRun: Priorite;
}

/** Lecture brute de l'appel (entrée dans `task` en temps monotone et mural, champs texte, fond). */
function lireDemande(t: TourTaches, args: Dict, appel: AppelIntegre | undefined): Demande {
  const debutMs = performance.now();
  const debutS = Date.now() / 1000;
  const brut = estDict(args) ? args : {};
  const agentType = stripPy(texteOu(brut["subagent_type"], ""));
  const fond = brut["background"] === true;
  return {
    debutMs,
    debutS,
    callId: appel?.callId ?? null,
    agentType,
    prompt: stripPy(texteOu(brut["prompt"], "")),
    taskId: stripPy(texteOu(brut["task_id"], "")),
    description: prefixePy(stripPy(texteOu(brut["description"], "")), 90) || agentType,
    fond,
    delaiMaxS: fond ? reglagesAgents().background_timeout_s : TASK_CHILD_TIMEOUT_S,
    prioriteRun: fond ? "low" : t.priority,
  };
}

/** Refus avant lancement : la ligne de l'appel est close par une étape finale (même `call_id`), le run échoué inscrit à l'usage du tour, puis l'enveloppe rendue au modèle. */
async function refuser(
  t: TourTaches,
  d: Demande,
  enveloppe: Dict,
  bilan: Bilan,
  ascii = true,
): Promise<string> {
  await emitFinalStep(t.o.onEvent, "", d.agentType, "failed", 0, {}, 0, { callId: d.callId, harness: bilan });
  const sink = t.o.usageSink;
  if (sink) {
    if (!Array.isArray(sink["runs"])) sink["runs"] = [];
    (sink["runs"] as Dict[]).push({
      id: "",
      agent: d.agentType,
      label: d.description,
      prompt: longueurPy(d.prompt) <= 2000 ? d.prompt : prefixePy(d.prompt, 2000) + "…",
      result: "",
      state: "failed",
      steps_total: 0,
      context_tokens: 0,
      input_tokens: 0,
      output_tokens: 0,
      think_tokens: 0,
      duration_ms: 0,
      tools: [],
      transcript: [],
      depth: 0,
      resumed: false,
      harness: bilan,
    });
  }
  return pyJsonDumps(enveloppe, { ensureAscii: ascii });
}

/** Refus d'un appel mal formé ou impossible (`error`). */
function refusSimple(
  t: TourTaches,
  d: Demande,
  code: string,
  message: string,
  extra: Parameters<typeof err>[2] = {},
): Promise<string> {
  return refuser(t, d, err(code, message, extra), bilanRefus("error"));
}

/** Plafond du tour atteint : refus avant tout lancement, les enfants déjà partis continuent. */
function refusBudget(t: TourTaches, d: Demande, raison: string): Promise<string> {
  return refuser(
    t,
    d,
    err("task_budget_exhausted", raison, { fix: "finish with what you have, or ask the user" }),
    bilanRefus("unavailable"),
  );
}

/** Cadre de l'enfant : lecture seule (celle du lancement pour une reprise), session web du compte si le réglage actuel de l'agent et l'administrateur la permettent (une reprise ne fait que la resserrer), budget, échéances depuis l'entrée dans `task`. */
function cadrer(t: TourTaches, d: Demande, s: AgentSpec, lus: ArgsTache, resumed: Dict | null): Cadre {
  const o = t.o;
  const lectureSeule = lectureSeuleEffective(typeReglable(d.agentType), {
    task: resumed !== null ? resumed["read_only"] === true : lus.readOnly,
    utilisateur: s.readOnlyUser,
  });
  const sessionCompte = s.userBrowser && (resumed === null || resumed["browser_session"] === "user");
  const sessionNavigateur: SessionNavigateur =
    sessionCompte && reglagesAgents().user_browser_session_allowed ? "user" : "isolated";
  const dureeMax = Math.min(d.delaiMaxS, lus.maxSeconds ?? d.delaiMaxS);
  const echeanceDureMs = d.debutMs + dureeMax * 1000;
  const reserveS = reserveSouple(dureeMax);
  const signalTour = d.fond ? undefined : o.signal;
  return {
    t,
    debutMs: d.debutMs,
    debutS: d.debutS,
    callId: d.callId,
    agentType: d.agentType,
    prompt: d.prompt,
    taskId: d.taskId,
    description: d.description,
    fond: d.fond,
    prioriteRun: d.prioriteRun,
    resumed,
    s,
    lus,
    sa: { type: d.agentType, read_only: lectureSeule, browser_session: sessionNavigateur },
    sessionNavigateur,
    aNavigateur: s.filterCategories === null || s.filterCategories.includes("browser"),
    budget: s.maxIters,
    dureeMax,
    echeanceDureMs,
    echeanceSoupleMs: echeanceDureMs - reserveS * 1000,
    travailS: dureeMax - reserveS,
    appelsAvant: intPy(resumed?.["tool_calls_total"] || 0),
    signalTour,
    tourAnnule: d.fond ? null : o.isCancelled,
    compte: { username: o.username, userId: o.userId ?? null, chatId: o.chatId, signal: signalTour },
  };
}

/** Agent `web` : refus si le service navigateur ne répond pas ou n'a plus de place pour lui ; `null` s'il peut partir. */
async function refusNavigateur(c: Cadre, d: Demande): Promise<string | null> {
  let sante: Awaited<ReturnType<TourTaches["hote"]["santeNavigateur"]>>;
  try {
    sante = await c.t.hote.santeNavigateur({ ...c.compte, isolee: c.sessionNavigateur === "isolated" });
  } catch (e) {
    if (estErreurAnnulation(e)) throw e;
    sante = `health check failed: ${prefixePy(String(e), 200)}`;
  }
  if (sante === null) return null;
  const raison = typeof sante === "string" ? sante : sante.raison;
  const bilan = bilanDe(c, { status: "unavailable" });
  return refuser(
    c.t,
    d,
    err("task_unavailable", `sub-agent 'web' is unavailable: ${raison}`, {
      fix:
        typeof sante === "string"
          ? "do not launch it again now: answer without the browser, or tell the user the browser service is down"
          : sante.fix,
      harness: bilan,
    }),
    bilan,
    false,
  );
}

/** Lancement de l'enfant prêt : plafonds relus, compteurs du tour, inscription en fond, run actif, étape `spawned` ; rend son enveloppe (ou son `task_id` en fond). */
async function lancer(
  t: TourTaches,
  d: Demande,
  r: RunEnfant,
  appel: AppelIntegre | undefined,
): Promise<string> {
  const { compte } = t;
  if (ACTIFS.has(r.k))
    return refusSimple(t, d, "task_busy", `agent '${r.childId}' is still running`, {
      fix: "wait for its result or start a fresh agent",
    });
  const repris = r.resumed === null ? null : d.taskId;
  const pleinAuDepart = plafondAtteint(t, repris);
  if (pleinAuDepart !== null) return refusBudget(t, d, pleinAuDepart);
  if (repris === null) compte.lancements++;
  else compte.reprises.set(repris, (compte.reprises.get(repris) ?? 0) + 1);
  if (r.fond) {
    const refus = await inscrireFond(r);
    if (refus !== null) {
      if (repris === null) compte.lancements--;
      else compte.reprises.set(repris, Math.max(0, (compte.reprises.get(repris) ?? 1) - 1));
      return refuser(t, d, err(refus.code, refus.message, { fix: refus.fix }), bilanRefus("unavailable"));
    }
  }
  ACTIFS.set(r.k, { agent: r.agentType, chatId: t.o.chatId, t0: Date.now() / 1000, arret: r.arret });
  marquerDernier(r.k, r.arret);
  try {
    await emit(r.relais, {
      type: "task_step",
      child_id: r.childId,
      agent: r.agentType,
      call_id: r.callId,
      status: "spawned",
      resumed: r.resumed !== null,
      depth: 0,
      ...(r.fond ? { background: true } : {}),
    });
  } catch (e) {
    ACTIFS.delete(r.k);
    ANNULES.delete(r.k);
    throw e;
  }
  if (!r.fond) appel?.rendreSiAnnule?.(() => rendreSiTourAnnule(r));
  debutTrace(t.o.username, `${t.o.username}:${t.o.chatId || ""}`, r.childId, r.saRun);
  if (!r.fond || r.inscrit === null) return executer(r);
  return lancerEnFond(r, () => executer(r));
}

/** Handler de `task` : refus avant lancement, cadre et préparation de l'enfant, puis son lancement. */
export async function handleTask(t: TourTaches, args: Dict, appel?: AppelIntegre): Promise<string> {
  const d = lireDemande(t, args, appel);
  t.legende.vue ??= legendeSousLesYeux(appel);
  const o = t.o;
  if (!estDict(args)) return refusSimple(t, d, "bad_args", "task expects an object argument");
  if (!d.prompt)
    return refusSimple(t, d, "empty_prompt", "the task prompt is empty", {
      fix: "pass a complete, autonomous brief in `prompt`",
    });
  let resumed: Dict | null = null;
  if (d.taskId) {
    pruneResumeStore();
    resumed = resumeLookup(o.username, d.taskId);
    if (resumed === null)
      return refusSimple(
        t,
        d,
        "unknown_task_id",
        `no resumable agent '${d.taskId}' on this server (expired or never existed)`,
        { fix: "omit task_id and start a fresh agent with a complete, autonomous brief" },
      );
    d.agentType = strPy(resumed["agent"]);
  }
  const s = t.agents.get(d.agentType);
  if (s === undefined && resumed !== null)
    return refusSimple(
      t,
      d,
      "agent_unavailable",
      `agent '${d.taskId}' cannot be resumed: its type '${d.agentType}' was deleted or switched off`,
      { fix: "start a fresh agent of one of the listed types with a complete brief" },
    );
  if (s === undefined)
    return refusSimple(t, d, "unknown_agent", `'${d.agentType}' is not a valid subagent_type`, {
      fix: "pick one of the listed agent types",
      valid_choices: [...t.agents.keys()],
    });
  const lus = lireArgsTache(args, { maxSecondsCap: d.delaiMaxS });
  if ("erreur" in lus) return refusSimple(t, d, "bad_args", lus.erreur, { fix: lus.fix });
  const plein = plafondAtteint(t, resumed === null ? null : d.taskId);
  if (plein !== null) return refusBudget(t, d, plein);
  const c = cadrer(t, d, s, lus, resumed);
  if (d.agentType === "web") {
    const refus = await refusNavigateur(c, d);
    if (refus !== null) return refus;
  }
  const childId = resumed !== null ? d.taskId : `t${++t.compteur}-${tokenHex(3)}`;
  const preparation = await preparerEnfant(c, childId, appel);
  const r = creerRun(c, preparation, (x) => (x.fond ? relaisEnFond(x) : o.onEvent));
  return lancer(t, d, r, appel);
}
