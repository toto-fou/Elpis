// SPDX-License-Identifier: MIT
/** frontend/src/features/terminal/sessions.ts — panneau de terminaux de l'éditeur : sessions nommées (API REST, WebSocket par session), repli historique SSE + POST quand le WebSocket est bloqué, démarrage du conteneur, onglets et libération de chaque terminal. */
import {
  schemaReponseBacMoi,
  schemaReponseChoixBac,
  schemaReponseCreerSessionTerminal,
  schemaReponseSessionsTerminal,
} from "@elpis/contracts";
import type { SessionTerminal } from "@elpis/contracts";
import { nextTick, ref } from "vue";
import type { Ref } from "vue";
import type { ITerminalOptions } from "@xterm/xterm";
import type { z } from "zod";

import { journal } from "../../platform/journal";
import type { GestionnaireSession } from "../auth/session";
import { ConnexionTerminal } from "./connexion";
import type { StatutTerminal } from "./connexion";
import { chargerXterm, creerTerminal } from "./xterm";
import type { TerminalPossede } from "./xterm";

type FetchAuth = (url: string, init?: RequestInit, soft?: boolean) => Promise<Response | null>;
type Terminal = TerminalPossede["term"];
type Ajustement = TerminalPossede["fitAddon"];

export type EtatOnglet = StatutTerminal | "idle";

/** Onglet du panneau : une session du serveur, ou le terminal historique (SSE) quand le WebSocket est bloqué. */
export type OngletTerminal = Pick<SessionTerminal, "id" | "name" | "created_at">;

export interface EtatTerminal {
  sid: string;
  term: Terminal;
  fitAddon: Ajustement;
  container: HTMLElement;
  owned: TerminalPossede;
  conn: ConnexionTerminal | null;
  sse: EventSource | null;
  transport: "ws" | "sse" | null;
  inputBuffer: string;
  inputTimer: ReturnType<typeof setTimeout> | null;
  sseWatchdog: ReturnType<typeof setTimeout> | null;
  resizeObserver: ResizeObserver | null;
  lastInputSentAt?: number;
  inputDropWarned?: boolean;
}

export interface SuperpositionInit {
  visible: boolean;
  label: string;
  progress: number;
  error: string | null;
}

export interface RefsTerminal {
  user: Ref<unknown>;
  readonly monacoRef: { instance: { layout(): void } | null };
}

export interface CtxTerminal {
  fetchAuth: FetchAuth;
  showToast(message: string, type?: string): void;
  handleSessionExpired?: () => void;
}

export interface RappelsTerminal {
  verifierDisqueBientot(delai: number): void;
  liens(term: Terminal): void;
  apresCommande(): void;
}

/** Onglet synthétique du repli historique : jamais envoyé au serveur. */
const SID_HISTORIQUE = "__legacy__";
const RECONNEXION_MS = 1200;
const BATTEMENT_MS = 25000;
/** Fenêtre de coalescence des frappes : après un premier envoi immédiat en WS, debounce classique en POST. */
const _TERM_INPUT_COALESCE_MS = 30;

const LIBELLES: Readonly<Record<EtatOnglet, string>> = {
  idle: "Pas encore ouvert — cliquez pour démarrer le shell",
  connecting: "Connexion au shell…",
  open: "Connecté",
  reconnecting: "Connexion perdue — reconnexion…",
  closed: "Déconnecté",
};

const OPTIONS_XTERM: ITerminalOptions = {
  theme: {
    background: "#1e1e1e",
    foreground: "#d4d4d4",
    cursor: "#aeafad",
    cursorAccent: "#1e1e1e",
    selectionBackground: "#264f78",
    selectionForeground: "#ffffff",
    black: "#1e1e1e",
    red: "#f44747",
    green: "#6a9955",
    yellow: "#d7ba7d",
    blue: "#569cd6",
    magenta: "#c586c0",
    cyan: "#4ec9b0",
    white: "#d4d4d4",
    brightBlack: "#808080",
    brightRed: "#f14c4c",
    brightGreen: "#73c991",
    brightYellow: "#e2c08d",
    brightBlue: "#6cb6ff",
    brightMagenta: "#d2a8ff",
    brightCyan: "#58d1c9",
    brightWhite: "#e8e8e8",
  },
  fontFamily: '"JetBrains Mono", "Fira Code", "Cascadia Code", Consolas, monospace',
  fontSize: 13,
  lineHeight: 1.35,
  cursorBlink: true,
  cursorStyle: "bar",
  scrollback: 5000,
};

const attendre = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const maintenant = (): number => (typeof performance !== "undefined" ? performance.now() : Date.now());
const echapper = (v: string): string => (typeof CSS !== "undefined" && CSS.escape ? CSS.escape(v) : v);

/** Corps JSON validé par le contrat ; `null` (journalisé) s'il est illisible ou hors contrat. */
async function lire<S extends z.ZodType>(res: Response, schema: S): Promise<z.infer<S> | null> {
  let brut: unknown;
  try {
    brut = await res.json();
  } catch {
    return null;
  }
  const r = schema.safeParse(brut);
  if (!r.success) journal.avertir("[terminal] réponse hors contrat : " + res.url, r.error.issues);
  return r.success ? r.data : null;
}

function urlWs(sid: string): string {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  const base = proto + "//" + window.location.host;
  return sid === SID_HISTORIQUE ? base + "/ws/terminal" : base + "/ws/terminal/" + encodeURIComponent(sid);
}

export function setupEditorTerminal(
  session: GestionnaireSession,
  refs: RefsTerminal,
  ctx: CtxTerminal,
  r: RappelsTerminal,
) {
  const { fetchAuth, showToast } = ctx;
  const mettreEnPageEditeur = (): void => {
    void nextTick(() => refs.monacoRef.instance?.layout());
  };

  const showTerminal = ref(false);
  const terminalHeight = ref(250);
  const terminalInitOverlay = ref<SuperpositionInit>({ visible: false, label: "", progress: 0, error: null });
  const termSessions = ref<OngletTerminal[]>([]);
  const termActiveSid = ref<string | null>(null);
  const termMaxSessions = ref(4);
  const termMultiSession = ref(true);
  const termRenamingSid = ref<string | null>(null);
  const termRenameValue = ref("");
  const termSessionStatus = ref<Record<string, EtatOnglet>>({});
  // État de transport par session : non réactif, muté en place.
  const _termStatesBySid = new Map<string, EtatTerminal>();

  function poserStatut(sid: string, statut: EtatOnglet): void {
    if (!sid || termSessionStatus.value[sid] === statut) return;
    termSessionStatus.value = { ...termSessionStatus.value, [sid]: statut };
  }
  function effacerStatut(sid: string): void {
    if (!sid || !(sid in termSessionStatus.value)) return;
    const suivant = { ...termSessionStatus.value };
    delete suivant[sid];
    termSessionStatus.value = suivant;
  }
  function termSessionState(sid: string): EtatOnglet {
    return termSessionStatus.value[sid] || "idle";
  }
  function termSessionTitle(sid: string): string {
    const libelle = LIBELLES[termSessionState(sid)] || "";
    return termMultiSession.value ? libelle + " · double-clic pour renommer" : libelle;
  }
  function _activeTermState(): EtatTerminal | null {
    const sid = termActiveSid.value;
    return sid ? (_termStatesBySid.get(sid) ?? null) : null;
  }

  // Démarrage du conteneur partagé entre l'ouverture de l'éditeur et celle du terminal ; un échec permet de réessayer.
  let initBac: Promise<boolean> | null = null;
  async function sonderBac(): Promise<z.infer<typeof schemaReponseBacMoi> | null> {
    const res = await fetchAuth("/api/sandbox/me");
    return res && res.ok ? lire(res, schemaReponseBacMoi) : null;
  }
  async function demarrerBac(): Promise<boolean> {
    let etat: z.infer<typeof schemaReponseBacMoi> | null;
    try {
      etat = await sonderBac();
    } catch {
      etat = null;
    }
    if (etat?.container?.running) return true;
    terminalInitOverlay.value = {
      visible: true,
      label: "Démarrage du container Docker…",
      progress: 8,
      error: null,
    };
    try {
      const res = await fetchAuth("/api/sandbox/me", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "docker" }),
      });
      if (!res) throw new Error("Session expirée / erreur réseau");
      if (!res.ok) throw new Error((await res.text()) || `HTTP ${res.status}`);
      const data = await lire(res, schemaReponseChoixBac);
      const o = terminalInitOverlay.value;
      if (data?.bootstrap?.container?.running) {
        o.progress = 100;
        await attendre(300);
        o.visible = false;
        return true;
      }
      if (data?.bootstrap?.container?.error) throw new Error(data.bootstrap.container.error);
      o.label = "Préparation de l'image…";
      o.progress = 30;
      const debut = Date.now();
      while (Date.now() - debut < 60000) {
        await attendre(800);
        const res2 = await fetchAuth("/api/sandbox/me");
        if (!res2) throw new Error("Session expirée / erreur réseau");
        if (!res2.ok) continue;
        const s = await lire(res2, schemaReponseBacMoi);
        if (!s) continue;
        if (s.container?.running) {
          o.label = "Container prêt";
          o.progress = 100;
          await attendre(350);
          o.visible = false;
          return true;
        }
        o.progress = Math.min(95, o.progress + 3);
        if (o.progress > 60) o.label = "Démarrage du container…";
      }
      throw new Error("Timeout init container (60s)");
    } catch (e) {
      const o = terminalInitOverlay.value;
      o.error = e instanceof Error ? e.message : String(e);
      o.label = "Échec du démarrage";
      return false;
    }
  }
  async function _ensureSandboxContainerReady(): Promise<boolean> {
    if (initBac) return initBac;
    initBac = demarrerBac();
    let ok: boolean;
    try {
      ok = await initBac;
    } catch {
      ok = false;
    }
    if (!ok) initBac = null;
    return ok;
  }
  /** Préparation du conteneur oubliée : la prochaine ouverture le revérifie (bac redémarré, enregistrement en 503). */
  function invaliderConteneur(): void {
    initBac = null;
  }
  function dismissTerminalInitOverlay(): void {
    terminalInitOverlay.value.visible = false;
    showTerminal.value = false;
    initBac = null;
  }

  function _ensureXtermLoaded(): Promise<void> {
    return chargerXterm().then(() => undefined);
  }

  const urlSessions = "/api/terminal/sessions";
  async function listerSessions(): Promise<z.infer<typeof schemaReponseSessionsTerminal> | null> {
    const res = await fetchAuth(urlSessions, {}, true);
    return res && res.ok ? lire(res, schemaReponseSessionsTerminal) : null;
  }
  async function creerSession(
    nom?: string,
  ): Promise<Partial<z.infer<typeof schemaReponseCreerSessionTerminal>> & { error?: string }> {
    const res = await fetchAuth(urlSessions, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: nom ? JSON.stringify({ name: nom }) : "{}",
    });
    if (!res) return { error: "network" };
    if (res.status === 429) return { error: "limit" };
    if (!res.ok) return { error: "http_" + res.status };
    return (await lire(res, schemaReponseCreerSessionTerminal)) ?? { error: "parse" };
  }
  /** Vrai si le serveur a retiré la ligne (404 compris) : un échec ne doit pas faire disparaître l'onglet. */
  async function _apiDeleteSession(sid: string): Promise<boolean> {
    try {
      const res = await fetchAuth(urlSessions + "/" + encodeURIComponent(sid), { method: "DELETE" });
      return !!res && (res.ok || res.status === 404);
    } catch {
      return false;
    }
  }
  async function renommerSession(sid: string, nom: string): Promise<boolean> {
    try {
      const res = await fetchAuth(urlSessions + "/" + encodeURIComponent(sid), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: nom }),
      });
      return !!res && res.ok;
    } catch {
      return false;
    }
  }

  function redimensionnerHistorique(rows: number, cols: number): void {
    fetchAuth("/api/terminal/resize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rows, cols }),
    }).catch(() => {});
  }

  async function _mountSessionPane(sid: string): Promise<EtatTerminal | null> {
    const existant = _termStatesBySid.get(sid);
    if (existant) return existant;
    await nextTick();
    const conteneur = document.querySelector<HTMLElement>(`[data-term-sid="${echapper(sid)}"]`);
    if (!conteneur) return null;
    const owned = creerTerminal(OPTIONS_XTERM);
    const { term, fitAddon } = owned;
    term.open(conteneur);
    const state: EtatTerminal = {
      sid,
      term,
      fitAddon,
      container: conteneur,
      owned,
      conn: null,
      sse: null,
      transport: null,
      inputBuffer: "",
      inputTimer: null,
      sseWatchdog: null,
      resizeObserver: null,
    };
    _termStatesBySid.set(sid, state);
    r.liens(term);
    // Première frappe envoyée tout de suite en WS (écho sans latence), les suivantes regroupées.
    term.onData((data) => {
      if (data.indexOf("\r") >= 0) r.apresCommande();
      const wsReady = state.transport === "ws" && !!state.conn && state.conn.ouvert;
      if (
        wsReady &&
        !state.inputTimer &&
        maintenant() - (state.lastInputSentAt || 0) >= _TERM_INPUT_COALESCE_MS
      ) {
        state.lastInputSentAt = maintenant();
        _sendInputFor(state, data);
        return;
      }
      state.inputBuffer += data;
      if (!state.inputTimer) {
        state.inputTimer = setTimeout(() => {
          const tampon = state.inputBuffer;
          state.inputBuffer = "";
          state.inputTimer = null;
          state.lastInputSentAt = maintenant();
          if (tampon) _sendInputFor(state, tampon);
        }, _TERM_INPUT_COALESCE_MS);
      }
    });
    term.onResize(({ rows, cols }) => {
      if (state.transport === "ws" && state.conn && state.conn.redimensionner(rows, cols)) return;
      if (state.transport === "sse" || sid === SID_HISTORIQUE) redimensionnerHistorique(rows, cols);
    });
    // Panneau encore caché : grille 0 × 0, réajustée au changement d'onglet.
    setTimeout(() => {
      if (_termStatesBySid.get(sid) !== state) return;
      try {
        fitAddon.fit();
      } catch {
        /* terminal caché */
      }
    }, 100);
    state.resizeObserver = new ResizeObserver(() => {
      try {
        fitAddon.fit();
      } catch {
        /* terminal libéré */
      }
    });
    state.resizeObserver.observe(conteneur);
    return state;
  }

  function _unmountSessionPane(sid: string): void {
    effacerStatut(sid);
    const st = _termStatesBySid.get(sid);
    if (!st) return;
    st.conn?.liberer();
    st.conn = null;
    st.sse?.close();
    st.sse = null;
    if (st.sseWatchdog) clearTimeout(st.sseWatchdog);
    st.sseWatchdog = null;
    if (st.inputTimer) clearTimeout(st.inputTimer);
    st.inputTimer = null;
    st.resizeObserver?.disconnect();
    st.resizeObserver = null;
    try {
      st.owned.liberer();
    } catch {
      /* déjà libéré */
    }
    _termStatesBySid.delete(sid);
  }

  function _sendInputFor(state: EtatTerminal, data: string): void {
    if (!state.term) return;
    if (state.transport === "ws" && state.conn && state.conn.envoyer(data)) return;
    if (state.sid !== SID_HISTORIQUE) {
      // Session nommée sans WS : aucun repli serveur, la frappe est perdue ; on le dit une fois par coupure.
      if (!state.inputDropWarned) {
        state.inputDropWarned = true;
        try {
          state.term.write(
            "\r\n\x1b[33m── connexion au terminal perdue : les touches ne sont plus transmises. Reconnexion en cours…\x1b[0m\r\n",
          );
        } catch {
          /* terminal libéré */
        }
      }
      return;
    }
    fetchAuth("/api/terminal/input", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ data }),
    }).catch(() => {});
    if (!state.sse || state.sse.readyState === 2) {
      connecterSse(state);
      return;
    }
    if (state.sseWatchdog) clearTimeout(state.sseWatchdog);
    state.sseWatchdog = setTimeout(() => {
      state.sseWatchdog = null;
      if (showTerminal.value && state.sse && _termStatesBySid.get(state.sid) === state) connecterSse(state);
    }, 3000);
  }

  /** Ouvre le transport d'une session montée ; faux si le WS échoue sans repli possible (session nommée). */
  function _connectSessionTransport(state: EtatTerminal): Promise<boolean> {
    state.sse?.close();
    state.sse = null;
    if (state.sseWatchdog) clearTimeout(state.sseWatchdog);
    state.sseWatchdog = null;
    if (!state.conn) {
      const monte = (): boolean => _termStatesBySid.get(state.sid) === state;
      state.conn = new ConnexionTerminal(
        session,
        { url: () => urlWs(state.sid), battementMs: BATTEMENT_MS, reconnexionMs: RECONNEXION_MS },
        {
          statut: (s) => poserStatut(state.sid, s),
          sortie: (octets) => {
            try {
              state.term.write(octets);
            } catch {
              /* terminal libéré */
            }
            // Accalmie du terminal : une commande a pu toucher des fichiers ouverts (pas de quota : écho à chaque frappe).
            r.verifierDisqueBientot(1500);
          },
          taille: () => ({ rows: state.term.rows, cols: state.term.cols }),
          ecrire: (t) => {
            try {
              state.term.write(t);
            } catch {
              /* terminal libéré */
            }
          },
          ouverte: () => {
            state.inputDropWarned = false;
            state.transport = "ws";
          },
          inconnue: () => {
            if (state.sid === SID_HISTORIQUE) return false;
            showToast("Ce terminal n'existe plus côté serveur — onglet retiré.", "warning");
            retirerLocalement(state.sid);
            return true;
          },
          echecInitial: () => {
            if (state.sid !== SID_HISTORIQUE) return false;
            journal.avertir("[terminal] WS failed, falling back to SSE");
            connecterSse(state);
            return true;
          },
          doitReconnecter: () => showTerminal.value && monte(),
        },
      );
    }
    return state.conn.connecter();
  }

  /** Repli historique (onglet synthétique seulement) : sortie en SSE, entrée et taille en POST. */
  function connecterSse(state: EtatTerminal): void {
    if (state.sid !== SID_HISTORIQUE) return;
    poserStatut(state.sid, "open");
    state.sse?.close();
    state.sse = null;
    state.transport = "sse";
    redimensionnerHistorique(state.term.rows, state.term.cols);
    const sse = new EventSource("/api/terminal/stream", { withCredentials: true });
    state.sse = sse;
    const encoreMonte = (): boolean => _termStatesBySid.get(state.sid) === state;
    const connecte = (): boolean => !!refs.user.value;
    sse.onmessage = (event: MessageEvent<string>) => {
      if (state.sse !== sse) return;
      if (state.sseWatchdog) clearTimeout(state.sseWatchdog);
      state.sseWatchdog = null;
      const charge = event.data;
      if (charge === "[SESSION_EXPIRED]") {
        state.sse = null;
        sse.close();
        ctx.handleSessionExpired?.();
        return;
      }
      if (charge === "[EOF]") {
        try {
          state.term.write("\r\n\x1b[90m[session terminée -- reconnexion...]\x1b[0m\r\n");
        } catch {
          /* terminal libéré */
        }
        state.sse = null;
        sse.close();
        setTimeout(() => {
          if (connecte() && encoreMonte()) connecterSse(state);
        }, 1500);
        return;
      }
      try {
        const bin = atob(charge);
        const octets = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) octets[i] = bin.charCodeAt(i);
        state.term.write(octets);
        r.verifierDisqueBientot(1500);
      } catch {
        try {
          state.term.write(charge);
        } catch {
          /* terminal libéré */
        }
      }
    };
    sse.onerror = () => {
      if (state.sse !== sse) return;
      state.sse = null;
      sse.close();
      if (!encoreMonte()) return;
      // Garde de connexion : sans elle, une session expirée relançait un EventSource (401) toutes les 2 s.
      setTimeout(() => {
        if (connecte() && encoreMonte()) connecterSse(state);
      }, 2000);
    };
  }

  function passerEnHistorique(): void {
    termMultiSession.value = false;
    termSessions.value = [
      { id: SID_HISTORIQUE, name: "Terminal", created_at: Math.floor(Date.now() / 1000) },
    ];
    termActiveSid.value = SID_HISTORIQUE;
    void nextTick(async () => {
      const st = await _mountSessionPane(SID_HISTORIQUE);
      if (st) void _connectSessionTransport(st);
    });
  }

  /** Première ouverture : sessions du serveur (une créée s'il n'y en a pas), WS de la première ; repli historique sinon. */
  async function _initTerminalPanel(): Promise<void> {
    const liste = await listerSessions();
    if (liste) termMaxSessions.value = liste.max || 4;
    let lignes = liste?.sessions ?? [];
    let creeeIci = false;
    if (lignes.length === 0) {
      const cree = await creerSession();
      if (cree.session) {
        termMaxSessions.value = cree.max || termMaxSessions.value;
        lignes = [cree.session];
        creeeIci = true;
      } else {
        passerEnHistorique();
        return;
      }
    }
    const premiere = lignes[0] as OngletTerminal;
    termSessions.value = lignes;
    termActiveSid.value = premiere.id;
    termMultiSession.value = true;
    const st = await _mountSessionPane(premiere.id);
    if (!st) {
      passerEnHistorique();
      return;
    }
    const ok = await _connectSessionTransport(st);
    if (!ok) {
      // WS bloqué : la ligne créée à l'instant ne doit pas occuper un emplacement du quota.
      if (creeeIci) void _apiDeleteSession(premiere.id);
      _unmountSessionPane(premiere.id);
      termSessions.value = [];
      termActiveSid.value = null;
      passerEnHistorique();
    }
  }

  async function monterEtConnecter(sid: string): Promise<void> {
    const st = await _mountSessionPane(sid);
    if (st) void _connectSessionTransport(st);
  }

  async function toggleTerminal(): Promise<void> {
    if (showTerminal.value) {
      showTerminal.value = false;
      mettreEnPageEditeur();
      return;
    }
    showTerminal.value = true;
    await nextTick();
    try {
      await _ensureXtermLoaded();
    } catch (e) {
      journal.erreur("[terminal] xterm load failed:", e);
      showToast("Erreur chargement terminal", "error");
      showTerminal.value = false;
      return;
    }
    try {
      if (!(await _ensureSandboxContainerReady())) return;
    } catch (e) {
      journal.erreur("[terminal] sandbox container check failed:", e);
    }
    if (termSessions.value.length === 0) {
      await _initTerminalPanel();
    } else {
      const st = _activeTermState();
      if (!st) {
        if (termActiveSid.value) await monterEtConnecter(termActiveSid.value);
      } else {
        setTimeout(() => {
          try {
            st.fitAddon.fit();
          } catch {
            /* terminal caché */
          }
          refs.monacoRef.instance?.layout();
          setTimeout(() => {
            try {
              st.term.focus();
              st.term.refresh(0, st.term.rows - 1);
            } catch {
              /* terminal libéré */
            }
          }, 80);
        }, 50);
      }
    }
    mettreEnPageEditeur();
  }

  function ajusterEtFocaliser(sid: string | null, delai: number, rafraichir: boolean): void {
    setTimeout(() => {
      const st = sid ? _termStatesBySid.get(sid) : undefined;
      if (!st) return;
      try {
        st.fitAddon.fit();
      } catch {
        /* terminal caché */
      }
      try {
        st.term.focus();
        if (rafraichir) st.term.refresh(0, st.term.rows - 1);
      } catch {
        /* terminal libéré */
      }
    }, delai);
  }

  async function termNewSession(): Promise<void> {
    if (!termMultiSession.value) return;
    if (termSessions.value.length >= termMaxSessions.value) {
      showToast("Limite atteinte (" + termMaxSessions.value + " terminaux max)", "warning");
      return;
    }
    const res = await creerSession();
    if (res.error === "limit") {
      showToast("Limite atteinte (" + termMaxSessions.value + " max)", "warning");
      return;
    }
    if (res.error || !res.session) {
      showToast("Erreur création terminal", "error");
      return;
    }
    const nouvelle = res.session;
    termMaxSessions.value = res.max || termMaxSessions.value;
    termSessions.value = [...termSessions.value, nouvelle];
    termActiveSid.value = nouvelle.id;
    await monterEtConnecter(nouvelle.id);
    setTimeout(() => {
      try {
        _termStatesBySid.get(nouvelle.id)?.term.focus();
      } catch {
        /* terminal libéré */
      }
    }, 120);
  }

  /** L'onglet n'est retiré qu'après la confirmation du serveur (sinon un emplacement fantôme reste occupé). */
  async function termCloseSession(sid: string): Promise<void> {
    if (!termMultiSession.value || sid === SID_HISTORIQUE) return;
    const idx = termSessions.value.findIndex((s) => s.id === sid);
    if (idx < 0) return;
    const ok = await _apiDeleteSession(sid);
    if (!ok) {
      showToast("Fermeture impossible — le terminal est toujours ouvert côté serveur. Réessayez.", "error");
      return;
    }
    _unmountSessionPane(sid);
    const reste = termSessions.value.filter((s) => s.id !== sid);
    termSessions.value = reste;
    if (termActiveSid.value !== sid) return;
    const voisin = reste[Math.max(0, idx - 1)];
    if (voisin) {
      termActiveSid.value = voisin.id;
      if (!_termStatesBySid.has(voisin.id)) await monterEtConnecter(voisin.id);
      ajusterEtFocaliser(termActiveSid.value, 80, false);
    } else {
      termActiveSid.value = null;
      showTerminal.value = false;
      mettreEnPageEditeur();
    }
  }

  async function termSwitchTo(sid: string): Promise<void> {
    if (termActiveSid.value === sid) return;
    if (!termSessions.value.some((s) => s.id === sid)) return;
    termActiveSid.value = sid;
    if (!_termStatesBySid.has(sid)) await monterEtConnecter(sid);
    ajusterEtFocaliser(sid, 40, true);
  }

  function termStartRename(sid: string): void {
    if (!termMultiSession.value || sid === SID_HISTORIQUE) return;
    const s = termSessions.value.find((x) => x.id === sid);
    if (!s) return;
    termRenamingSid.value = sid;
    termRenameValue.value = s.name || "";
    void nextTick(() => {
      const el = document.querySelector<HTMLInputElement>(`[data-term-rename-sid="${echapper(sid)}"]`);
      try {
        el?.focus();
        el?.select();
      } catch {
        /* champ retiré */
      }
    });
  }

  async function termCommitRename(): Promise<void> {
    const sid = termRenamingSid.value;
    if (!sid) return;
    const nom = (termRenameValue.value || "").trim().slice(0, 64);
    termRenamingSid.value = null;
    termRenameValue.value = "";
    const s = termSessions.value.find((x) => x.id === sid);
    if (!s || !nom || nom === s.name) return;
    if (await renommerSession(sid, nom)) {
      termSessions.value = termSessions.value.map((x) => (x.id === sid ? { ...x, name: nom } : x));
    } else {
      showToast("Renommage échoué", "error");
    }
  }

  function termCancelRename(): void {
    termRenamingSid.value = null;
    termRenameValue.value = "";
  }

  /** Session inconnue du serveur (4004) : onglet retiré sans appel ni recréation. */
  function retirerLocalement(sid: string): void {
    const idx = termSessions.value.findIndex((s) => s.id === sid);
    if (idx < 0) return;
    _unmountSessionPane(sid);
    const reste = termSessions.value.filter((s) => s.id !== sid);
    termSessions.value = reste;
    if (termActiveSid.value !== sid) return;
    const voisin = reste[Math.max(0, idx - 1)];
    if (voisin) termActiveSid.value = voisin.id;
    else {
      termActiveSid.value = null;
      showTerminal.value = false;
    }
  }

  /** Déconnexion et libération : chaque terminal démonté (socket, minuteries, xterm), session historique tuée au mieux. */
  async function _destroyAllTerminals(opts?: { keepOpen?: boolean }): Promise<void> {
    for (const sid of Array.from(_termStatesBySid.keys())) _unmountSessionPane(sid);
    termSessions.value = [];
    termActiveSid.value = null;
    termRenamingSid.value = null;
    termRenameValue.value = "";
    termSessionStatus.value = {};
    termMultiSession.value = true;
    if (!opts?.keepOpen) showTerminal.value = false;
    try {
      await fetchAuth("/api/terminal/kill", { method: "POST" });
    } catch {
      /* au mieux */
    }
  }

  return {
    showTerminal,
    terminalHeight,
    terminalInitOverlay,
    dismissTerminalInitOverlay,
    _ensureSandboxContainerReady,
    invaliderConteneur,
    termSessions,
    termActiveSid,
    termMaxSessions,
    termMultiSession,
    termRenamingSid,
    termRenameValue,
    termSessionStatus,
    termSessionState,
    termSessionTitle,
    _activeTermState,
    _termStatesBySid,
    toggleTerminal,
    _ensureXtermLoaded,
    _initTerminalPanel,
    _mountSessionPane,
    _unmountSessionPane,
    _connectSessionTransport,
    _sendInputFor,
    _apiDeleteSession,
    termNewSession,
    termCloseSession,
    termSwitchTo,
    termStartRename,
    termCommitRename,
    termCancelRename,
    _destroyAllTerminals,
  };
}
