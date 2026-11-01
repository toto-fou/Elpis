// SPDX-License-Identifier: MIT
/** apps/core/src/outils/integres/task/evenements.ts — événements d'un enfant : relevé de ses appels, texte, messages du parent, consommation rapportée par le moteur, étapes vers l'interface (finale comprise). */
import {
  estDict,
  estErreurAnnulation,
  intPy,
  longueurPy,
  prefixePy,
  pyJsonDumps,
  splitPy,
  strPy,
  stripPy,
  texteOu,
  veritePy,
} from "@elpis/commun";
import { masquerSecretsTexte, neutraliserMarqueursTour } from "@elpis/securite";

import { resultIsToolFailure } from "../../../boucle/contrat-resultat";
import { emit } from "../../../boucle/evenements";
import type { SurEvenement } from "../../../boucle/evenements";
import type { UsageRun } from "../../../boucle/usage-requete";
import { neutraliserBalisesHarnais, truncateHeadTail } from "../../../contexte/elagage";
import { journal } from "../../../journal";
import type { Dict } from "../../../python";
import type { Bilan } from "./bilan";
import type { RunEnfant } from "./enfant";
import { pointDeReprise } from "./reprise";

const log = journal("outils.taches-agents");

/** Aperçu court d'arguments ou d'un résultat pour l'interface. */
export function preview(args: unknown, maxlen = 120): string {
  let s: string;
  try {
    s = typeof args === "string" ? args : pyJsonDumps(args, { ensureAscii: false, separators: [",", ":"] });
  } catch {
    s = strPy(args);
  }
  s = splitPy(s).join(" ");
  return longueurPy(s) <= maxlen ? s : prefixePy(s, maxlen - 1) + "…";
}

/** Aperçu de `maxlen` caractères au plus, secrets masqués sur un préfixe large avant la coupe (parent, interface, chat enregistré). */
function apercuMasque(v: unknown, maxlen = 120): string {
  return preview(masquerSecretsTexte(preview(v, 4000)).texte, maxlen);
}

/** Vrai si le résultat d'outil est un échec (contrat lu en fermant). */
const echecSur = (r: unknown): boolean => {
  try {
    return Boolean(resultIsToolFailure(r));
  } catch {
    return false;
  }
};

const CONSO_VIDE: UsageRun = { entree: 0, sortie: 0, cache: 0, reflexion: 0 };

/** Consommation d'un enfant pour la ligne, rapportée par le moteur : entrée (cache compris), sortie (réflexion comprise), part en cache, réflexion. */
export interface ChampsConso {
  input_tokens: number;
  output_tokens: number;
  cache_tokens: number;
  think_tokens: number;
}

/** Champs de consommation d'un enfant pour la ligne. */
export function champsConso(u: UsageRun): ChampsConso {
  return {
    input_tokens: Math.trunc(u.entree),
    output_tokens: Math.trunc(u.sortie),
    cache_tokens: Math.trunc(u.cache),
    think_tokens: Math.trunc(u.reflexion),
  };
}

/** Consommation finale : la plus grande des métriques du run et de l'usage publié (qui compte aussi les requêtes coupées, et seul existe après un délai dur ou une annulation) ; réflexion seulement si le moteur la rapporte, jamais estimée. */
export function consoFinale(metrics: Dict, u: UsageRun): ChampsConso {
  const m = metrics || {};
  return champsConso({
    entree: Math.max(intPy(m["input_tokens"] || 0), u.entree),
    sortie: Math.max(intPy(m["output_tokens"] || 0), u.sortie),
    cache: Math.max(intPy(m["cache_read_input_tokens"] || 0), u.cache),
    reflexion:
      (veritePy(m["thinking_tokens_estimated"]) ? 0 : intPy(m["thinking_tokens"] || 0)) || u.reflexion,
  });
}

/** Événement `task_step` FINAL : état, coût, durée, déroulé et résultat de l'enfant ; tout échec est tu. */
export async function emitFinalStep(
  onEvent: SurEvenement,
  childId: string,
  agentType: string,
  state: string,
  stepsTotal: number,
  metrics: Dict,
  dureeS: number,
  o: {
    callId?: string | null;
    contextTokens?: number;
    conso?: UsageRun;
    transcript?: Dict[];
    result?: string;
    harness?: Bilan;
  } = {},
): Promise<void> {
  if (!onEvent) return;
  try {
    await onEvent({
      type: "task_step",
      child_id: childId,
      agent: agentType,
      call_id: o.callId ?? null,
      status: "final",
      state,
      steps_total: stepsTotal,
      context_tokens: Math.trunc(o.contextTokens || 0),
      ...consoFinale(metrics, o.conso ?? CONSO_VIDE),
      duration_ms: Math.trunc(dureeS * 1000),
      transcript: o.transcript ?? [],
      result: o.result || "",
      ...(o.harness ? { harness: o.harness } : {}),
    });
  } catch (e) {
    if (estErreurAnnulation(e)) throw e;
  }
}

/** Étape `task_step` de l'enfant, complétée par `champs`. */
function etape(r: RunEnfant, champs: Dict): Dict {
  return { type: "task_step", child_id: r.childId, agent: r.agentType, call_id: r.callId, ...champs };
}

/** Texte reçu de l'enfant depuis son dernier appel : gardé au déroulé (borné) et, sauf `emettre` faux, envoyé ; ignoré s'il recoupe `dejaRendu`. */
export async function flushChat(r: RunEnfant, emettre = true, dejaRendu = ""): Promise<void> {
  let t = stripPy(r.tampon);
  r.tampon = "";
  if (!t) return;
  if (dejaRendu) {
    const [a, b] = [stripPy(t), stripPy(dejaRendu)];
    if (a && b && (b.includes(a) || a.includes(b))) return;
  }
  r.dernierTexte = t;
  if (longueurPy(t) > 1500) t = truncateHeadTail(t, 1500, "task transcript bound");
  if (r.chat.length < 120) r.chat.push({ text: t });
  if (emettre) await emit(r.relais, etape(r, { status: "text", text: t }));
}

/** Messages du parent remis à l'enfant : au déroulé et à l'interface, puis posés sous `<parent_instruction>` (balises et marqueurs neutralisés). */
export function recevoirParent(r: RunEnfant): string[] {
  return r.boite.splice(0).map((message) => {
    if (r.chat.length < 120) r.chat.push({ parent: message });
    void emit(r.relais, etape(r, { status: "parent", text: message }));
    return `<parent_instruction>\n${neutraliserBalisesHarnais(neutraliserMarqueursTour(message))}\n</parent_instruction>`;
  });
}

/** Place obtenue au moteur : l'horloge de l'enfant part, la ligne et sa tâche de fond l'apprennent (une fois). */
export function demarrer(r: RunEnfant): void {
  if (r.t0 > 0) return;
  r.t0 = Date.now() / 1000;
  const relais = r.relais;
  if (relais)
    void Promise.resolve(
      relais(etape(r, { status: "tick", started: true, tokens: r.tok.v, ...champsConso(r.conso) })),
    ).catch(() => undefined);
}

/** Jetons et consommation de l'enfant envoyés à la ligne. */
async function tick(r: RunEnfant): Promise<void> {
  r.conso.aJour = false;
  if (r.relais) await r.relais(etape(r, { status: "tick", tokens: r.tok.v, ...champsConso(r.conso) }));
}

/** Usage publié par la boucle de l'enfant : consommation à jour et jetons en cours du tour. */
export function surUsage(r: RunEnfant, u: UsageRun): void {
  Object.assign(r.conso, u, { aJour: true });
  const n = u.entree + u.sortie;
  const enCours = r.t.compte.enCours;
  if (n > (enCours.get(r.childId) ?? 0)) enCours.set(r.childId, n);
}

/** Itération de l'enfant : jetons en cours du tour, point de reprise, étape et budget, contexte s'il n'est pas mesuré. */
async function surIteration(r: RunEnfant, ev: Dict): Promise<void> {
  const enCours = r.t.compte.enCours;
  const cumul = intPy(ev["tokens_used"] || 0);
  if (cumul > (enCours.get(r.childId) ?? 0)) enCours.set(r.childId, cumul);
  try {
    pointDeReprise(r);
  } catch (e) {
    log.warn(`[task_tool] point de reprise de ${r.childId} non posé (${String(e)})`);
  }
  const n = intPy(ev["n"] || 0);
  if (n > 0) r.iters.n = n;
  const m = intPy(ev["max"] || 0);
  if (m > 0) r.iters.max = m;
  if (!r.tok.reel) {
    const c = intPy(ev["context_tokens"] || 0);
    if (c > 0) {
      r.tok.v = c;
      await tick(r);
    }
  }
}

/** Appel d'outil de l'enfant : compté, relevé (transcript, cinq derniers, déroulé) et envoyé. */
async function surAppel(r: RunEnfant, ev: Dict): Promise<void> {
  await flushChat(r);
  const step = ++r.pas;
  r.appelsVus = step;
  const nom = texteOu(ev["name"], "");
  r.suivi.appel(nom, ev["args"], ev["call_id"] ? strPy(ev["call_id"]) : "");
  if (nom.startsWith("pw_")) r.navigateurUtilise = true;
  const cid = ev["call_id"] ?? null;
  r.debutsAppels.set(cid ? strPy(cid) : nom, nom);
  const args = apercuMasque(ev["args"] ?? null);
  if (r.transcript.length < 50)
    r.transcript.push({
      tool: ev["name"] ?? null,
      call_id: cid,
      args_preview: args,
      status: "running",
    });
  r.recents.push({
    tool: ev["name"] ?? null,
    call_id: cid,
    args,
    status: "running",
  });
  if (r.recents.length > 5) r.recents.shift();
  if (r.chat.length < 120)
    r.chat.push({
      tool: ev["name"] ?? null,
      call_id: cid,
      args_preview: apercuMasque(ev["args"] ?? null, 200),
      status: "running",
      result_preview: "",
    });
  if (r.relais)
    await r.relais(
      etape(r, {
        step: r.iters.n || 1,
        max_steps: r.iters.max,
        calls: step,
        tool: ev["name"] ?? null,
        args_preview: args,
        tokens: r.tok.v,
        status: "running",
      }),
    );
}

/** Résultat d'outil de l'enfant : état de l'appel relevé partout, fichiers et git suivis, étape envoyée. */
async function surResultat(r: RunEnfant, ev: Dict): Promise<void> {
  r.points.resultats++;
  const st = echecSur(ev["result"]) ? "error" : "done";
  const nom = texteOu(ev["name"], "");
  const cid = ev["call_id"] ? strPy(ev["call_id"]) : "";
  const fichiers = r.sa.read_only || !Array.isArray(ev["files"]) ? [] : ev["files"];
  r.debutsAppels.delete(cid || nom);
  r.suivi.resultat(nom, ev["result"], st === "error", fichiers, cid);
  const apercu = apercuMasque(ev["result"] ?? null, 400);
  const correspond = (e: Dict): boolean => {
    if (e["status"] !== "running") return false;
    if (cid && e["call_id"]) return strPy(e["call_id"]) === cid;
    return e["tool"] === (ev["name"] ?? null);
  };
  for (let i = r.transcript.length - 1; i >= 0; i--)
    if (correspond(r.transcript[i]!)) {
      r.transcript[i]!["status"] = st;
      break;
    }
  for (let i = r.recents.length - 1; i >= 0; i--)
    if (correspond(r.recents[i]!)) {
      r.recents[i]!["status"] = st === "done" ? "ok" : "error";
      break;
    }
  for (let i = r.chat.length - 1; i >= 0; i--)
    if (correspond(r.chat[i]!)) {
      r.chat[i]!["status"] = st;
      r.chat[i]!["result_preview"] = apercu;
      break;
    }
  if (r.relais)
    await r.relais(
      etape(r, {
        step: r.iters.n || 1,
        max_steps: r.iters.max,
        calls: r.appelsVus,
        tool: ev["name"] ?? null,
        tokens: r.tok.v,
        status: st,
        result_preview: apercu,
        ...(Array.isArray(ev["files"]) && ev["files"].length ? { files: ev["files"] } : {}),
      }),
    );
}

/** Événement de la boucle de l'enfant (son `onEvent`). */
export async function surEvenementEnfant(r: RunEnfant, ev: Dict): Promise<void> {
  if (!estDict(ev)) return;
  const t = ev["type"];
  if (r.conso.aJour && t !== "kv_cache") await tick(r);
  if (t === "kv_cache") {
    const used = intPy(ev["used"] || 0);
    if (used > 0) {
      r.tok.v = used;
      r.tok.reel = true;
      await tick(r);
    }
  } else if (t === "iteration") await surIteration(r, ev);
  else if (t === "content_token") {
    if (longueurPy(r.tampon) < 6000) r.tampon += texteOu(ev["text"], "");
  } else if (t === "tool_call") await surAppel(r, ev);
  else if (t === "tool_result") await surResultat(r, ev);
}
