// SPDX-License-Identifier: MIT
/** frontend/src/features/chat/etat-flux.ts — reducer pur du flux d'un tour : état de rendu, garde de génération et de conversation. */
import type { EvenementDe, EvenementFlux, StreamEventType } from "@elpis/contracts";

import { sourcesRag } from "./affichage";
import type { Decode } from "./evenements";

export type TypeIgnore =
  | "tool_history_partial"
  | "llm_user_suffix"
  | "prune_state"
  | "compression_state"
  | "tool_limit"
  | "log"
  | "ping";

/** Événements reçus sans effet sur l'état de rendu, avec leur raison. */
export const IGNORES: Readonly<Record<TypeIgnore, string>> = {
  tool_history_partial: "interne au tour (EVENEMENTS_INTERNES), jamais sur le fil",
  llm_user_suffix: "interne au tour (EVENEMENTS_INTERNES), jamais sur le fil",
  prune_state: "interne au tour (EVENEMENTS_INTERNES), jamais sur le fil",
  compression_state: "interne au tour (EVENEMENTS_INTERNES), lu par la route",
  tool_limit: "la limite d'outils arrive aussi dans `final.tool_limit_reached`, seul affiché",
  log: "journal du serveur, destiné aux journaux et non à la conversation",
  ping: "maintien de la connexion pendant un rattachement",
};

export interface Outil {
  readonly callId: string;
  readonly nom: string;
  readonly args: Readonly<Record<string, unknown>>;
  readonly interne: boolean;
  readonly statut: "en_cours" | "fait";
  readonly resultat: string | null;
  readonly dureeMs: number | null;
  readonly progression: number | null;
  readonly journaux: number;
  readonly sortie: string;
  readonly codeRetour: number | null;
}

export interface SousAgent {
  readonly agent: string;
  readonly statut: string;
  readonly etapes: number;
  readonly texte: string;
}

export interface ChargementModele {
  readonly modele: string;
  readonly pct: number | null;
  readonly etape: string;
}

export interface FileAttente {
  readonly kind: "waiting" | "loading" | "ready";
  readonly modele: string;
  readonly position: number;
  readonly actives: number;
  readonly estMs: number | null;
}

export interface Avis {
  readonly niveau: "info" | "warning" | "notice";
  readonly texte: string;
}

export type Perte = "journal" | "worker" | "session";

export interface EtatRendu {
  readonly generation: number;
  readonly chatId: string | null;
  readonly runId: string | null;
  readonly suite: boolean;
  readonly rejeu: boolean;
  readonly mode: string;
  readonly image: boolean;
  readonly iteration: { readonly n: number; readonly max: number } | null;
  readonly reflexionEnCours: boolean;
  readonly reflexion: string;
  readonly contenu: string;
  readonly outils: readonly Outil[];
  readonly appelsPartiels: Readonly<Record<string, { readonly nom: string; readonly args: string }>>;
  readonly outilsExecutes: boolean;
  readonly sousAgents: Readonly<Record<string, SousAgent>>;
  readonly todos: readonly { readonly content: string; readonly status: string }[];
  readonly preRemplissagePct: number | null;
  readonly kv: { readonly used: number; readonly total: number; readonly pct: number } | null;
  readonly compression: "en_cours" | "faite" | "plafonnee" | null;
  readonly file: FileAttente | null;
  readonly chargementModele: ChargementModele | null;
  readonly sourcesRag: readonly string[];
  readonly journalTronque: boolean;
  readonly images: number;
  readonly imageProgressionPct: number | null;
  readonly imagePrompt: string;
  readonly erreurImage: string | null;
  readonly annotation: string | null;
  readonly avis: readonly Avis[];
  readonly erreur: { readonly message: string; readonly kind: string | null } | null;
  readonly final: {
    readonly persiste: boolean;
    readonly titre: string | null;
    readonly tronque: boolean;
    readonly annule: boolean;
    readonly limiteOutils: boolean;
    readonly runIds: readonly string[];
  } | null;
  readonly terminal: "final" | "error" | null;
  readonly fin: EvenementDe<"run_end">["status"] | null;
  readonly perte: Perte | null;
  readonly horsContrat: number;
  readonly ignores: number;
}

export interface Entree {
  readonly generation: number;
  readonly decode: Decode;
}

export function etatInitial(generation: number, chatId: string | null, rejeu = false): EtatRendu {
  return {
    generation,
    chatId,
    runId: null,
    suite: false,
    rejeu,
    mode: "",
    image: false,
    iteration: null,
    reflexionEnCours: false,
    reflexion: "",
    contenu: "",
    outils: [],
    appelsPartiels: {},
    outilsExecutes: false,
    sousAgents: {},
    todos: [],
    preRemplissagePct: null,
    kv: null,
    compression: null,
    file: null,
    chargementModele: null,
    sourcesRag: [],
    journalTronque: false,
    images: 0,
    imageProgressionPct: null,
    imagePrompt: "",
    erreurImage: null,
    annotation: null,
    avis: [],
    erreur: null,
    final: null,
    terminal: null,
    fin: null,
    perte: null,
    horsContrat: 0,
    ignores: 0,
  };
}

export type Refus = "generation" | "conversation" | "decodage" | null;

/** Raison pour laquelle l'entrée ne doit pas être appliquée (ni ici ni à la vue), ou `null`. */
export function refus(etat: EtatRendu, entree: Entree): Refus {
  if (entree.generation !== etat.generation) return "generation";
  const d = entree.decode;
  if (d.statut === "inconnu" || d.statut === "invalide") return "decodage";
  if (d.statut === "valide" && etat.chatId !== null) {
    const ev = d.ev;
    if ((ev.type === "final" || ev.type === "run_started") && ev.chat_id !== etat.chatId)
      return "conversation";
  }
  return null;
}

/** Applique une entrée : jamais d'effet si elle est refusée ; une charge hors contrat ne compte que pour la fin du tour. */
export function reduire(etat: EtatRendu, entree: Entree): EtatRendu {
  if (refus(etat, entree) !== null) return etat;
  const d = entree.decode;
  if (d.statut === "hors_contrat") {
    const terminal = d.type === "final" || d.type === "error" ? d.type : etat.terminal;
    return { ...etat, terminal, horsContrat: etat.horsContrat + 1 };
  }
  if (d.statut !== "valide") return etat;
  return appliquer(etat, d.ev);
}

function majOutil(
  outils: readonly Outil[],
  callId: string | null,
  nom: string,
  f: (o: Outil) => Outil,
): readonly Outil[] {
  let i = -1;
  for (let k = outils.length - 1; k >= 0; k--) {
    const o = outils[k];
    if (
      o &&
      (callId !== null && callId !== "" ? o.callId === callId : o.nom === nom && o.statut === "en_cours")
    ) {
      i = k;
      break;
    }
  }
  if (i < 0) return outils;
  return outils.map((o, k) => (k === i ? f(o) : o));
}

function nouvelOutil(
  callId: string,
  nom: string,
  args: Readonly<Record<string, unknown>>,
  interne: boolean,
): Outil {
  return {
    callId,
    nom,
    args,
    interne,
    statut: "en_cours",
    resultat: null,
    dureeMs: null,
    progression: null,
    journaux: 0,
    sortie: "",
    codeRetour: null,
  };
}

function borne(pct: number): number {
  return Math.max(0, Math.min(100, pct));
}

function preRemplissage(ev: EvenementDe<"prompt_progress">): number | null {
  if (ev.total <= 0) return null;
  const cache = Math.min(Math.max(0, ev.cache), ev.total);
  const utile = ev.total - cache;
  const fait = Math.max(0, ev.processed - cache);
  return utile > 0 ? Math.min(100, Math.round((fait / utile) * 100)) : 100;
}

function file(ev: EvenementDe<"queue_status">): FileAttente {
  return {
    kind: ev.kind,
    modele: ev.model ?? "",
    position: ev.position ?? 1,
    actives: ev.active ?? 1,
    estMs: ev.est_ms ?? null,
  };
}

function ignorer(etat: EtatRendu, _type: TypeIgnore): EtatRendu {
  return { ...etat, ignores: etat.ignores + 1 };
}

function inattendu(ev: never): never {
  throw new Error(`événement non traité : ${(ev as { type: StreamEventType }).type}`);
}

function appliquer(etat: EtatRendu, ev: EvenementFlux): EtatRendu {
  switch (ev.type) {
    case "mode":
      return { ...etat, mode: ev.text, image: etat.image || ev.kind === "image" };
    case "iteration":
      return { ...etat, iteration: { n: ev.n, max: ev.max } };
    case "thinking":
      return { ...etat, reflexionEnCours: true, mode: ev.text };
    case "thinking_token":
      return { ...etat, reflexionEnCours: true, reflexion: etat.reflexion + ev.text };
    case "thinking_content":
      return { ...etat, reflexion: ev.text };
    case "content_token":
      return { ...etat, reflexionEnCours: false, preRemplissagePct: null, contenu: etat.contenu + ev.text };
    case "content_replace":
      return { ...etat, contenu: ev.text };
    case "tool_call": {
      const parti = etat.outils.some((o) => o.callId === ev.call_id);
      const outils = parti
        ? etat.outils
        : [...etat.outils, nouvelOutil(ev.call_id, ev.name, ev.args, ev.internal === true)];
      return { ...etat, outils, outilsExecutes: true, appelsPartiels: {} };
    }
    case "tool_call_delta": {
      const prefixe = `${ev.iter}:`;
      if (ev.reset === true) {
        const reste = Object.fromEntries(
          Object.entries(etat.appelsPartiels).filter(([k]) => !k.startsWith(prefixe)),
        );
        return { ...etat, appelsPartiels: reste };
      }
      const cle = `${ev.iter}:${ev.index}`;
      const prec = etat.appelsPartiels[cle] ?? { nom: "", args: "" };
      const suiv = { nom: prec.nom + (ev.name_delta ?? ""), args: prec.args + (ev.args_delta ?? "") };
      return { ...etat, appelsPartiels: { ...etat.appelsPartiels, [cle]: suiv } };
    }
    case "tool_result": {
      const fini = (o: Outil): Outil => ({
        ...o,
        statut: "fait",
        resultat: ev.result,
        dureeMs: ev.duration_ms,
      });
      const connu = etat.outils.some((o) => o.callId === ev.call_id);
      const outils = connu
        ? majOutil(etat.outils, ev.call_id, ev.name, fini)
        : [...etat.outils, fini(nouvelOutil(ev.call_id, ev.name, {}, ev.internal === true))];
      return { ...etat, outils, outilsExecutes: true };
    }
    case "tool_progress": {
      const pct =
        ev.total !== null && ev.total > 0 ? borne(Math.round((ev.progress / ev.total) * 100)) : null;
      return {
        ...etat,
        outils: majOutil(etat.outils, ev.call_id ?? null, ev.name, (o) => ({ ...o, progression: pct })),
      };
    }
    case "tool_log":
      return {
        ...etat,
        outils: majOutil(etat.outils, ev.call_id ?? null, ev.name, (o) => ({
          ...o,
          journaux: o.journaux + 1,
        })),
      };
    case "shell_output":
      return {
        ...etat,
        outils: majOutil(etat.outils, ev.call_id, ev.name, (o) => ({
          ...o,
          sortie: o.sortie + (ev.chunk ?? ""),
          codeRetour: ev.done ? (ev.returncode ?? o.codeRetour) : o.codeRetour,
        })),
      };
    case "task_step": {
      const prec = etat.sousAgents[ev.child_id] ?? {
        agent: ev.agent,
        statut: "spawned",
        etapes: 0,
        texte: "",
      };
      const etapes =
        ev.status === "running" || ev.status === "done" || ev.status === "error" ? ev.step : prec.etapes;
      const statut =
        ev.status === "final"
          ? ev.state
          : ev.status === "tick" || ev.status === "text"
            ? prec.statut
            : ev.status;
      const texte =
        ev.status === "text" ? prec.texte + ev.text : ev.status === "final" ? ev.result : prec.texte;
      return {
        ...etat,
        sousAgents: { ...etat.sousAgents, [ev.child_id]: { agent: ev.agent, statut, etapes, texte } },
      };
    }
    case "todo_updated":
      return { ...etat, todos: ev.todos.map((t) => ({ content: t.content, status: t.status })) };
    case "annotation_frame":
      return { ...etat, annotation: ev.sig };
    case "prompt_progress":
      return { ...etat, preRemplissagePct: preRemplissage(ev) };
    case "kv_cache":
      return { ...etat, kv: { used: ev.used, total: ev.total, pct: ev.pct } };
    case "compression_start":
      return { ...etat, compression: "en_cours" };
    case "compression_done":
      return { ...etat, compression: "faite" };
    case "compression_capped":
      return { ...etat, compression: "plafonnee" };
    case "queue_status": {
      const chargementModele =
        ev.kind === "loading"
          ? {
              modele: ev.model ?? "",
              pct: typeof ev.progress_pct === "number" ? borne(ev.progress_pct) : null,
              etape: ev.stage ?? "",
            }
          : null;
      return { ...etat, file: file(ev), chargementModele };
    }
    case "queue_cleared":
      return { ...etat, file: null, chargementModele: null };
    case "rag_sources":
      return {
        ...etat,
        sourcesRag: [...new Set([...etat.sourcesRag, ...sourcesRag(ev.sources)])],
      };
    case "image_progress":
      return { ...etat, image: true, imageProgressionPct: ev.pct };
    case "image":
      return { ...etat, image: true, images: etat.images + ev.items.length, imageProgressionPct: null };
    case "image_prompt":
      return { ...etat, imagePrompt: ev.text };
    case "image_error":
      return { ...etat, erreurImage: ev.code, imageProgressionPct: null };
    case "info":
    case "warning":
      return { ...etat, avis: [...etat.avis, { niveau: ev.type, texte: ev.text }] };
    case "notice":
      return { ...etat, avis: [...etat.avis, { niveau: "notice", texte: ev.message }] };
    case "error":
      return {
        ...etat,
        erreur: { message: ev.text, kind: ev.kind ?? null },
        terminal: "error",
        chargementModele: null,
      };
    case "final":
      return {
        ...etat,
        chatId: etat.chatId ?? ev.chat_id,
        contenu: ev.assistant,
        reflexion: ev.thinking ?? etat.reflexion,
        reflexionEnCours: false,
        file: null,
        chargementModele: null,
        preRemplissagePct: null,
        terminal: "final",
        final: {
          persiste: ev.persisted,
          titre: ev.title ?? null,
          tronque: ev.truncated === true,
          annule: ev.cancelled === true,
          limiteOutils: ev.tool_limit_reached === true,
          runIds: ev.run_ids,
        },
      };
    case "run_started":
      return { ...etat, runId: ev.run_id, chatId: etat.chatId ?? ev.chat_id, suite: ev.is_continue };
    case "replay_done":
      return { ...etat, rejeu: false };
    case "run_end":
      return { ...etat, fin: ev.status };
    case "run_lost":
      return { ...etat, perte: ev.reason };
    case "journal_truncated":
      return { ...etat, journalTronque: true };
    case "session_expired":
      return { ...etat, perte: "session" };
    case "tool_history_partial":
    case "llm_user_suffix":
    case "prune_state":
    case "compression_state":
    case "tool_limit":
    case "log":
    case "ping":
      return ignorer(etat, ev.type);
    default:
      return inattendu(ev);
  }
}

/** Le tour peut-il être renvoyé après une coupure ? Jamais si un outil a pu agir ou si c'est un tour image. */
export function peutRejouer(etat: EtatRendu): boolean {
  return !etat.outilsExecutes && !etat.image;
}
