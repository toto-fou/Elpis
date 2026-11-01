// SPDX-License-Identifier: MIT
/** apps/core/src/outils/integres/task/reprise.ts — reprises par `task_id` : enregistrements en mémoire (TTL, plafonds) relus contre le magasin disque, points de reprise d'un enfant en cours, état gardé à sa fin. */
import { estDict, longueurPy, strPy } from "@elpis/commun";

import { toolMsgWeight } from "../../../boucle/run";
import { journal } from "../../../journal";
import {
  TASK_CHECKPOINT_S,
  TASK_RESUME_MAX,
  TASK_RESUME_MAX_BYTES,
  TASK_RESUME_TTL_S,
} from "../../../llm/constantes";
import type { Dict } from "../../../python";
import type { RunEnfant } from "./enfant";
import * as Store from "./magasin-reprise";
import { cle, estLeDernier } from "./registre";

const log = journal("outils.taches-agents");

const REPRISES = new Map<string, Dict>();

const TAILLES = new WeakMap<Dict, number>();

/** Taille JSON approchée d'un enregistrement de reprise : contenus, arguments d'appels et réflexion de ses messages. */
function tailleReprise(rec: Dict): number {
  const memo = TAILLES.get(rec);
  if (memo !== undefined) return memo;
  let n = 256;
  for (const m of Array.isArray(rec["messages"]) ? rec["messages"] : [])
    n += 64 + (estDict(m) ? toolMsgWeight(m) + longueurPy(strPy(m["reasoning_content"] ?? "")) : 0);
  TAILLES.set(rec, n);
  return n;
}

/** Store de reprise : TTL depuis le plus ancien, cap d'entrées, cap en octets de la mémoire (le dernier enregistrement reste), puis le store disque. */
export function pruneResumeStore(maintenant = Date.now() / 1000): void {
  for (const [k, v] of REPRISES) {
    if (maintenant - Number(v["ts"] || 0) > TASK_RESUME_TTL_S) REPRISES.delete(k);
    else break;
  }
  while (REPRISES.size > TASK_RESUME_MAX) REPRISES.delete(REPRISES.keys().next().value as string);
  let octets = 0;
  for (const v of REPRISES.values()) octets += tailleReprise(v);
  for (const [k, v] of REPRISES) {
    if (octets <= TASK_RESUME_MAX_BYTES || REPRISES.size <= 1) break;
    octets -= tailleReprise(v);
    REPRISES.delete(k);
  }
  try {
    Store.prune(TASK_RESUME_TTL_S, TASK_RESUME_MAX, maintenant);
  } catch {
    // ramasse-miettes best-effort
  }
}

/** Enregistrement de reprise : la mémoire, sauf si le disque en porte une version plus récente. */
export function resumeLookup(username: string, childId: string): Dict | null {
  const k = cle(username, childId);
  const rec = REPRISES.get(k) ?? null;
  if (rec !== null) {
    let tsDisque: number | null;
    try {
      tsDisque = Store.peekTs(username, childId);
    } catch {
      tsDisque = null;
    }
    if (tsDisque === null || tsDisque <= Number(rec["ts"] || 0) + 1e-3) return rec;
  }
  let disque: Dict | null;
  try {
    disque = Store.get(username, childId, TASK_RESUME_TTL_S);
  } catch {
    disque = null;
  }
  if (disque === null) return rec;
  if (rec !== null && Number(disque["ts"] || 0) <= Number(rec["ts"] || 0)) return rec;
  REPRISES.delete(k);
  REPRISES.set(k, disque);
  return disque;
}

/** Enregistrement de reprise posé en mémoire, le plus récent en dernier. */
export function memoriserReprise(username: string, childId: string, rec: Dict): void {
  const k = cle(username, childId);
  REPRISES.delete(k);
  REPRISES.set(k, rec);
}

/** Messages de travail de la boucle en forme canonique, lus maintenant (la boucle peut tourner) ; `null` sans lecteur ou si la lecture échoue. */
export function travailCourant(r: RunEnfant): Dict[] | null {
  try {
    return r.lireTravail ? r.lireTravail() : null;
  } catch (e) {
    log.warn(`[task_tool] messages de travail illisibles pour la reprise (${String(e)})`);
    return null;
  }
}

/** Historique de reprise = messages de travail de la boucle (la boucle est finie, lu une fois) ; sans lecteur, l'entrée seule. */
function historique(r: RunEnfant): Dict[] {
  r.travailFige ??= travailCourant(r) ?? [...r.childMessages];
  return r.travailFige;
}

/** Vrai si ces messages portent au moins un résultat d'outil obtenu par CE run (hors historique repris). */
export function aEchange(r: RunEnfant, messages: readonly Dict[]): boolean {
  return messages.some((m) => m["role"] === "tool" && !r.dejaRepondus.has(m["tool_call_id"]));
}

/** Vrai si l'enfant peut être repris : déjà repris, ou un échange obtenu par ce run. */
export function avecReprise(r: RunEnfant): boolean {
  return r.resumed !== null || aEchange(r, historique(r));
}

/** Enregistrement de reprise de cet enfant ; `point` : état pris en cours de route, que seul un arrêt brutal (redémarrage du core) laisse en place. */
export function enregistrement(r: RunEnfant, messages: Dict[], point: boolean): Dict {
  return {
    agent: r.agentType,
    messages,
    ts: Date.now() / 1000,
    tool_calls_total: r.appelsAvant + r.appelsVus,
    read_only: r.sa.read_only,
    browser_session: r.sessionNavigateur,
    ...(point ? { checkpoint: true } : {}),
  };
}

/** Écrit sur disque le dernier point en attente (jamais bloquant). */
function ecrirePoint(r: RunEnfant): void {
  const points = r.points;
  if (points.minuterie !== null) clearTimeout(points.minuterie);
  points.minuterie = null;
  const rec = points.enAttente;
  points.enAttente = null;
  if (rec === null || points.clos) return;
  points.dernierMs = Date.now();
  void Store.putAsync(r.t.o.username, r.childId, rec);
  try {
    pruneResumeStore();
  } catch {
    // ramasse-miettes best-effort
  }
}

/** Point de reprise après un lot d'outils fini : en mémoire tout de suite, sur disque au plus toutes les `TASK_CHECKPOINT_S` s (la dernière demande part à l'échéance). */
export function pointDeReprise(r: RunEnfant): void {
  const points = r.points;
  if (points.clos || points.resultats === 0) return;
  points.resultats = 0;
  const lu = travailCourant(r);
  if (lu === null || !aEchange(r, lu)) return;
  const rec = enregistrement(r, lu, true);
  memoriserReprise(r.t.o.username, r.childId, rec);
  points.enAttente = rec;
  const attente = TASK_CHECKPOINT_S * 1000 - (Date.now() - points.dernierMs);
  if (attente <= 0) ecrirePoint(r);
  else if (points.minuterie === null) {
    points.minuterie = setTimeout(() => ecrirePoint(r), attente);
    points.minuterie.unref();
  }
}

/** Plus aucun point de reprise : celui en attente est abandonné. */
export function clorePoints(r: RunEnfant): void {
  const points = r.points;
  points.clos = true;
  points.enAttente = null;
  if (points.minuterie !== null) clearTimeout(points.minuterie);
  points.minuterie = null;
}

/** État repris à la fin du run (sauf si un run plus récent de la clé l'a remplacé) : historique et rapport final, en mémoire et sur disque. */
export async function storeResumeState(r: RunEnfant): Promise<void> {
  clorePoints(r);
  if (!estLeDernier(r.k, r.arret)) return;
  const fini = r.etat === "completed" || r.etat === "incomplete";
  let suivants: Dict[] | null = null;
  if (aEchange(r, historique(r)) || (fini && r.finalText)) {
    suivants = [...historique(r)];
    const dernier = suivants[suivants.length - 1];
    const dejaLa =
      dernier?.["role"] === "assistant" && !dernier["tool_calls"] && dernier["content"] === r.finalText;
    if (fini && r.finalText && !dejaLa) suivants.push({ role: "assistant", content: r.finalText });
  }
  if (suivants !== null) {
    const rec = enregistrement(r, suivants, false);
    memoriserReprise(r.t.o.username, r.childId, rec);
    try {
      await Store.putAsync(r.t.o.username, r.childId, rec);
    } catch {
      // reprise limitée à la mémoire
    }
    pruneResumeStore();
  }
}
