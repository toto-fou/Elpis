// SPDX-License-Identifier: MIT
/** frontend/src/features/auth/sse-systeme.ts — flux SSE `/api/system-events` (`setupChatSystemSSE`) : décodé par les schémas C1, tenu par un seul onglet du compte (`meneur.ts`), ressources liées à la session. */
import { decoderEvenementSysteme } from "@elpis/contracts";
import type { EtatModeles, EvenementSysteme, NotificationDirecte } from "@elpis/contracts";
import type { Ref } from "vue";

import { journal } from "../../platform/journal";
import { creerMeneur, nomCanal } from "./meneur";
import type { CanalOnglets, Meneur } from "./meneur";
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

export interface CtxSse {
  readonly systemAlert: Ref<unknown>;
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
  /** Canal entre onglets du compte ; `null` : un flux par onglet (repli sans `BroadcastChannel`). */
  readonly creerCanal?: ((nom: string) => CanalOnglets) | null;
  readonly fetch?: (url: string, init?: RequestInit) => Promise<Response>;
  readonly recharger?: () => void;
  readonly document?: Document;
}

const DELAI_MAX = 30000;

const canalNatif =
  typeof BroadcastChannel === "function" ? (nom: string): CanalOnglets => new BroadcastChannel(nom) : null;

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
  const creerCanal = dep.creerCanal === undefined ? canalNatif : dep.creerCanal;
  const sonder = dep.fetch ?? ((u: string, i?: RequestInit) => globalThis.fetch(u, i));
  const recharger = dep.recharger ?? (() => window.location.reload());

  let proprio: Proprietaire | null = null;
  let source: SourceEvenements | null = null;
  let annulerReconnexion: (() => void) | null = null;
  let arreterSondage: (() => void) | null = null;
  let tentative = 0;
  let dejaOuvert = false;
  let sondeRedemarrage = false;
  // Coordination entre onglets du compte : `null` quand l'onglet tient son propre flux (repli) ou n'est pas connecté.
  let meneur: Meneur | null = null;
  // Prochaine ouverture du flux : resynchroniser (rôle de meneur repris d'un autre onglet).
  let rattrapage = false;
  // Page masquée (`pagehide`) : l'onglet a quitté les autres, il les rejoint à son retour.
  let parti = false;
  let volontaire = false;

  const visible = (): boolean => doc.visibilityState === "visible";

  /** Ressources de la connexion : libérées par `disconnectSystemEvents`, ou par la fin de la session, alors signalée aux onglets du compte. */
  function possesseur(): Proprietaire {
    if (proprio?.actif) return proprio;
    const p = session.proprietaire("sse-systeme");
    p.ajouter(() => {
      quitterOnglets(!volontaire);
      fermerFlux();
      arreterSondage = null;
      parti = false;
    });
    p.ecouter(doc, "visibilitychange", surVisibilite);
    if (doc.defaultView) p.ecouter(doc.defaultView, "pagehide", surMasquage);
    proprio = p;
    return p;
  }

  function surVisibilite(): void {
    if (!visible()) return;
    if (parti) {
      parti = false;
      rejoindre(true);
      return;
    }
    if (meneur && !meneur.estMeneur) {
      meneur.veiller();
      return;
    }
    if (!source || source.readyState === 2) {
      tentative = 0;
      if (annulerReconnexion) annulerReconnexion();
      annulerReconnexion = null;
      ouvrirFlux();
    }
  }

  /** Page quittée ou mise en cache : le meneur cède tout de suite son rôle. */
  function surMasquage(): void {
    if (!meneur) return;
    quitterOnglets(false);
    fermerFlux();
    parti = true;
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

  /** Rejoint les onglets du compte (un seul tient le flux), sinon ouvre le sien ; déjà fait : rien. */
  function connectSystemEvents(): void {
    if (!user.value || meneur) return;
    parti = false;
    if (!rejoindre(false)) ouvrirFlux();
  }

  function rejoindre(rattraper: boolean): boolean {
    const uid = session.compte?.id;
    if (!creerCanal || uid === undefined) return false;
    let canal: CanalOnglets;
    try {
      canal = creerCanal(nomCanal(uid));
    } catch {
      return false;
    }
    const p = possesseur();
    demarrerSondageModeles();
    meneur = creerMeneur({
      canal,
      id: `${Date.now().toString(36).padStart(9, "0")}-${Math.random().toString(36).slice(2, 10)}`,
      rattrapage: rattraper,
      minuterie: (fn, ms) => p.minuterie(fn, ms),
      intervalle: (fn, ms) => p.intervalle(fn, ms),
      maintenant: () => Date.now(),
      prendre(r) {
        fermerFlux();
        rattrapage = r;
        ouvrirFlux();
      },
      lacher: fermerFlux,
      recevoir(texte) {
        const ev = decoder(texte);
        if (ev && ev.type !== "worker_recycling") appliquer(ev, p);
      },
      resynchroniser() {
        journal.info("[sse] Flux d'un autre onglet repris : resynchronisation");
        if (user.value) rappels.onReconnect?.();
      },
      verifierSession,
    });
    return true;
  }

  function quitterOnglets(fin: boolean): void {
    const m = meneur;
    meneur = null;
    m?.quitter(fin);
  }

  function fermerFlux(): void {
    if (source) source.close();
    source = null;
    if (annulerReconnexion) annulerReconnexion();
    annulerReconnexion = null;
    tentative = 0;
    dejaOuvert = false;
    rattrapage = false;
  }

  /** Un onglet du compte a perdu sa session : même cookie, donc relue ici ; terminée, elle l'est aussi pour cet onglet. */
  function verifierSession(): void {
    void sonder("/api/me-lite", { cache: "no-store" })
      .then((r) => (r.ok ? (r.json() as Promise<unknown>) : null))
      .then((d) => {
        if (!d || typeof d !== "object" || (d as { logged_in?: unknown }).logged_in) return;
        disconnectSystemEvents();
        ctx.handleSessionExpired?.();
      })
      .catch(() => undefined);
  }

  /** Ouvre le flux de l'onglet (relayé s'il est meneur, sauf le recyclage) ; déjà ouvert ou en ouverture : rien. */
  function ouvrirFlux(): void {
    if (source && source.readyState !== 2) return;
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
      if (tentative > 0 || dejaOuvert || rattrapage) {
        journal.info(`[sse] Reconnecté après ${tentative} tentative(s)`);
        if (user.value) rappels.onReconnect?.();
      }
      tentative = 0;
      dejaOuvert = true;
      rattrapage = false;
      meneur?.fluxOuvert();
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
      const texte = typeof e.data === "string" ? e.data : "";
      const ev = decoder(texte);
      if (ev?.type !== "worker_recycling") meneur?.relayer(texte);
      if (ev) appliquer(ev, p);
    };
  }

  function decoder(texte: string): EvenementSysteme | null {
    const d = decoderEvenementSysteme(texte);
    if (d.statut === "invalide") {
      journal.avertir("[sse] événement système invalide ignoré :", d.erreur);
      return null;
    }
    if (d.statut === "inconnu") {
      journal.info("[sse] événement système inconnu ignoré :", d.type);
      return null;
    }
    return d.evenement;
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
          ouvrirFlux();
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
      case "log":
      case "log_unavailable":
      case "log_replaced":
        // Le journal en direct a son propre flux (page Journaux de la console) : rien à faire ici.
        return;
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

  /** Reconnexion avec recul ; onglet caché : au retour, sauf pour le meneur dont les autres onglets dépendent. */
  function planifierReconnexion(): void {
    if (annulerReconnexion) return;
    const delai = Math.min(1000 * Math.pow(2, tentative), DELAI_MAX);
    tentative += 1;
    journal.avertir(`[sse] Déconnecté -- reconnexion dans ${delai / 1000}s (tentative ${tentative})`);
    annulerReconnexion = possesseur().minuterie(() => {
      annulerReconnexion = null;
      if (visible() || meneur) ouvrirFlux();
    }, delai);
  }

  function disconnectSystemEvents(): void {
    const p = proprio;
    proprio = null;
    volontaire = true;
    p?.liberer();
    volontaire = false;
    quitterOnglets(false);
    fermerFlux();
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
