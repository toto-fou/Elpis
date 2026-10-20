// SPDX-License-Identifier: MIT
/** frontend/src/features/auth/sse-systeme.ts — flux SSE `/api/system-events` (`setupChatSystemSSE`) : décodé par les schémas C1, ressources liées à la session. */
import { decoderEvenementSysteme } from "@elpis/contracts";
import type { EtatModeles, EvenementSysteme, NotificationDirecte } from "@elpis/contracts";
import type { Ref } from "vue";

import { journal } from "../../platform/journal";
import type { GestionnaireSession, Proprietaire } from "./session";

/** Ce que le module lit d'un `EventSource` (injectable dans les tests). */
export interface SourceEvenements {
  readonly readyState: number;
  onopen: ((e: Event) => void) | null;
  onerror: ((e: Event) => void) | null;
  onmessage: ((e: MessageEvent<string>) => void) | null;
  close(): void;
}

export interface RefsSse {
  readonly user: Ref<unknown>;
  readonly isLoadingModel: Ref<boolean>;
  readonly isStreaming?: Ref<boolean>;
}

export interface EntreeJournal {
  id: string;
  ts: unknown;
  message: string;
  level: unknown;
  category?: unknown;
  service?: unknown;
}

export interface CtxSse {
  readonly systemAlert: Ref<unknown>;
  readonly liveLogs: Ref<EntreeJournal[] | null>;
  handleSessionExpired?(): void;
}

export type ChatJobData = Extract<EvenementSysteme, { type: "chat_job" }>["data"];
export type ChatWakeData = Extract<EvenementSysteme, { type: "chat_wake" }>["data"];

export interface RappelsSse {
  onChatJob?(data: ChatJobData): void;
  onChatWake?(data: ChatWakeData): void;
  onReconnect?(): void;
  onModelStatus?(data: EtatModeles): void;
  onModelChanged?(): void;
  onNotification?(data: NotificationDirecte): void;
  pollModels?(): void;
}

export interface DependancesSse {
  readonly session: GestionnaireSession;
  readonly creerSource?: (url: string) => SourceEvenements;
  readonly fetch?: (url: string, init?: RequestInit) => Promise<Response>;
  readonly recharger?: () => void;
  readonly document?: Document;
}

const DELAI_MAX = 30000;
const TAMPON_JOURNAL = 800;

export function setupChatSystemSSE(
  refs: RefsSse,
  ctx: CtxSse,
  rappels: RappelsSse = {},
  dep: DependancesSse,
) {
  const { user, isLoadingModel } = refs;
  const isStreaming = refs.isStreaming ?? { value: false };
  const { session } = dep;
  const doc = dep.document ?? document;
  const creerSource =
    dep.creerSource ?? ((url: string) => new EventSource(url, { withCredentials: true }) as SourceEvenements);
  const sonder = dep.fetch ?? ((u: string, i?: RequestInit) => globalThis.fetch(u, i));
  const recharger = dep.recharger ?? (() => window.location.reload());

  let proprio: Proprietaire | null = null;
  let source: SourceEvenements | null = null;
  let annulerReconnexion: (() => void) | null = null;
  let annulerVidage: (() => void) | null = null;
  let arreterSondage: (() => void) | null = null;
  let tentative = 0;
  let dejaOuvert = false;
  let sondeRedemarrage = false;
  let numeroLog = 0;
  let tampon: EntreeJournal[] = [];

  const visible = (): boolean => doc.visibilityState === "visible";

  /** Ressources de la connexion courante : libérées par `disconnectSystemEvents` ou par la fin de la session. */
  function possesseur(): Proprietaire {
    if (proprio?.actif) return proprio;
    const p = session.proprietaire("sse-systeme");
    p.ajouter(() => {
      if (source) source.close();
      source = null;
      annulerReconnexion = null;
      annulerVidage = null;
      arreterSondage = null;
      tampon = [];
      dejaOuvert = false;
    });
    p.ecouter(doc, "visibilitychange", surVisibilite);
    proprio = p;
    return p;
  }

  function surVisibilite(): void {
    if (visible() && (!source || source.readyState === 2)) {
      tentative = 0;
      if (annulerReconnexion) annulerReconnexion();
      annulerReconnexion = null;
      connectSystemEvents();
    }
  }

  function viderJournal(): void {
    annulerVidage = null;
    if (!tampon.length) return;
    const suite = (ctx.liveLogs.value ?? []).concat(tampon);
    tampon = [];
    ctx.liveLogs.value = suite.length > TAMPON_JOURNAL ? suite.slice(-TAMPON_JOURNAL) : suite;
  }

  function demarrerSondageModeles(): void {
    if (arreterSondage) arreterSondage();
    arreterSondage = possesseur().intervalle(() => {
      if (user.value && !isLoadingModel.value && visible()) rappels.pollModels?.();
    }, 60000);
  }

  function stopModelPolling(): void {
    if (arreterSondage) arreterSondage();
    arreterSondage = null;
  }

  function connectSystemEvents(): void {
    if (source) source.close();
    source = null;
    if (annulerReconnexion) annulerReconnexion();
    annulerReconnexion = null;
    if (!user.value) return;
    const p = possesseur();
    demarrerSondageModeles();
    let s: SourceEvenements;
    try {
      s = creerSource("/api/system-events");
    } catch {
      planifierReconnexion();
      return;
    }
    source = s;
    s.onopen = () => {
      if (!p.actif || source !== s) return;
      if (tentative > 0 || dejaOuvert) {
        journal.info(`[sse] Reconnecté après ${tentative} tentative(s)`);
        if (user.value) rappels.onReconnect?.();
      }
      tentative = 0;
      dejaOuvert = true;
    };
    s.onerror = () => {
      if (!p.actif || source !== s) return;
      if (s.readyState === 2) {
        s.close();
        source = null;
        planifierReconnexion();
      }
    };
    s.onmessage = (e) => {
      if (!p.actif || source !== s) return;
      const d = decoderEvenementSysteme(typeof e.data === "string" ? e.data : "");
      if (d.statut === "invalide") {
        journal.avertir("[sse] événement système invalide ignoré :", d.erreur);
        return;
      }
      if (d.statut === "inconnu") {
        journal.info("[sse] événement système inconnu ignoré :", d.type);
        return;
      }
      appliquer(d.evenement, p);
    };
  }

  function appliquer(ev: EvenementSysteme, p: Proprietaire): void {
    switch (ev.type) {
      case "session_expired":
        disconnectSystemEvents();
        ctx.handleSessionExpired?.();
        return;
      case "worker_recycling":
        if (source) source.close();
        source = null;
        if (annulerReconnexion) annulerReconnexion();
        tentative = 1;
        annulerReconnexion = p.minuterie(() => {
          annulerReconnexion = null;
          connectSystemEvents();
        }, 750);
        return;
      case "restart":
      case "app_restarting":
        ctx.systemAlert.value = ev.message || "Le serveur redémarre…";
        if (ev.type === "app_restarting" && ev.force_logout) {
          disconnectSystemEvents();
          ctx.handleSessionExpired?.();
        }
        sonderRedemarrage();
        return;
      case "log": {
        const id = typeof ev.ts === "number" ? `${ev.ts}-${++numeroLog}` : `${Date.now()}-${++numeroLog}`;
        const entree: EntreeJournal = {
          id,
          ts: ev.ts || Date.now() / 1000,
          message: ev.message,
          level: ev.level,
        };
        if (ev.category) entree.category = ev.category;
        if (ev.service) entree.service = ev.service;
        tampon.push(entree);
        if (!annulerVidage) annulerVidage = p.minuterie(viderJournal, 200);
        return;
      }
      case "model_status":
        rappels.onModelStatus?.(ev.data);
        return;
      case "model_changed":
        rappels.onModelChanged?.();
        return;
      case "notification":
        rappels.onNotification?.(ev.data);
        return;
      case "chat_job":
        rappels.onChatJob?.(ev.data);
        return;
      case "chat_wake":
        rappels.onChatWake?.(ev.data);
        return;
      case "rag_job":
        // Progression d'une indexation : la page RAG l'écoute sur `window`, sans rappel à câbler dans le chat.
        doc.defaultView?.dispatchEvent(new CustomEvent("rag:job", { detail: ev.data }));
        return;
    }
  }

  /** Une seule chaîne de sondes `/api/health` par redémarrage ; jamais de rechargement pendant un streaming. */
  function sonderRedemarrage(): void {
    if (sondeRedemarrage) return;
    sondeRedemarrage = true;
    const essayer = async (n: number): Promise<void> => {
      try {
        const r = await sonder("/api/health", { cache: "no-store" });
        if (r.ok) {
          if (isStreaming.value) {
            setTimeout(() => void essayer(n), 3000);
            return;
          }
          recharger();
          return;
        }
      } catch {
        /* serveur encore à terre */
      }
      setTimeout(() => void essayer(n + 1), n > 20 ? 5000 : 1000);
    };
    setTimeout(() => void essayer(0), 6000);
  }

  function planifierReconnexion(): void {
    if (annulerReconnexion) return;
    const delai = Math.min(1000 * Math.pow(2, tentative), DELAI_MAX);
    tentative += 1;
    journal.avertir(`[sse] Déconnecté -- reconnexion dans ${delai / 1000}s (tentative ${tentative})`);
    annulerReconnexion = possesseur().minuterie(() => {
      annulerReconnexion = null;
      if (visible()) connectSystemEvents();
    }, delai);
  }

  function disconnectSystemEvents(): void {
    const p = proprio;
    proprio = null;
    if (p) p.liberer();
    if (source) source.close();
    source = null;
    tampon = [];
    dejaOuvert = false;
  }

  possesseur();
  demarrerSondageModeles();

  return {
    connectSystemEvents,
    disconnectSystemEvents,
    stopModelPolling,
    _modelPollTimer: null,
  };
}
