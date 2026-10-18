// SPDX-License-Identifier: MIT
/** frontend/src/features/terminal/connexion.ts — WebSocket d'une session de terminal : battement, reconnexion, fin de session (4001) liées à la génération de session. */
import type { GestionnaireSession, Proprietaire } from "../auth/session";

export type StatutTerminal = "connecting" | "reconnecting" | "open" | "closed";

export interface RappelsConnexion {
  statut(s: StatutTerminal): void;
  sortie(octets: Uint8Array): void;
  /** Taille de la grille envoyée à l'ouverture. */
  taille(): { rows: number; cols: number };
  /** Message d'information à écrire dans le terminal. */
  ecrire(texte: string): void;
  /** Session inconnue du serveur (4004 avant ouverture) : vrai si l'appelant l'a traitée (onglet retiré). */
  inconnue(): boolean;
  /** Échec avant toute ouverture (proxy, pare-feu) : vrai si un repli a pris le relais. */
  echecInitial(): boolean;
  /** Le panneau est encore affiché et monté : une coupure se reconnecte. */
  doitReconnecter(): boolean;
  /** Ouverture réussie (réarmement des avertissements de l'appelant). */
  ouverte?(): void;
}

export interface OptionsConnexion {
  url(): string;
  battementMs: number;
  reconnexionMs: number;
  fabrique?: (url: string) => WebSocket;
}

const MESSAGE_NOUVEAU_SHELL =
  "\r\n\x1b[33m── session précédente terminée (serveur redémarré) : nouveau shell ──\x1b[0m\r\n";
const MESSAGE_FIN = "\r\n\x1b[90m[session terminée -- reconnexion...]\x1b[0m\r\n";

/** Connexion d'une session ; ses timers et sa socket appartiennent à un propriétaire de la génération de session. */
export class ConnexionTerminal {
  ws: WebSocket | null = null;
  dejaOuverte = false;
  private shellVu = false;
  private expiree = false;
  private battement: (() => void) | null = null;
  private reprise: (() => void) | null = null;
  private proprio: Proprietaire | null = null;
  private generation = -1;

  private readonly session: GestionnaireSession;
  private readonly opts: OptionsConnexion;
  private readonly rappels: RappelsConnexion;

  constructor(session: GestionnaireSession, opts: OptionsConnexion, rappels: RappelsConnexion) {
    this.session = session;
    this.opts = opts;
    this.rappels = rappels;
  }

  get ouvert(): boolean {
    return this.ws !== null && this.ws.readyState === 1;
  }

  /** Propriétaire de la génération courante (recréé après un changement de compte). */
  private proprietaire(): Proprietaire {
    if (!this.proprio || !this.proprio.actif || this.proprio.generation !== this.session.generation) {
      this.proprio?.liberer();
      this.proprio = this.session.proprietaire("terminal");
      this.generation = this.proprio.generation;
      this.proprio.ajouter(() => this.couper(1000, "session"));
    }
    return this.proprio;
  }

  private arreterTimers(): void {
    this.battement?.();
    this.battement = null;
    this.reprise?.();
    this.reprise = null;
  }

  /** Ferme la socket courante sans reconnexion (démontage, fin de génération). */
  couper(code?: number, raison?: string): void {
    this.arreterTimers();
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      try {
        ws.close(code, raison);
      } catch {
        /* déjà fermée */
      }
    }
  }

  /** Libère la connexion et son propriétaire. */
  liberer(): void {
    this.couper(1000, "unmount");
    this.proprio?.liberer();
    this.proprio = null;
  }

  envoyer(donnees: string | Uint8Array<ArrayBuffer>): boolean {
    const ws = this.ws;
    if (!ws || ws.readyState !== 1) return false;
    try {
      ws.send(typeof donnees === "string" ? new TextEncoder().encode(donnees) : donnees);
      return true;
    } catch {
      return false;
    }
  }

  redimensionner(rows: number, cols: number): boolean {
    const ws = this.ws;
    if (!ws || ws.readyState !== 1) return false;
    try {
      ws.send(JSON.stringify({ op: "resize", rows, cols }));
      return true;
    } catch {
      return false;
    }
  }

  /** Ouvre la socket ; vrai si un transport est actif (WebSocket, ou repli signalé par `echecInitial`). */
  connecter(): Promise<boolean> {
    this.couper();
    const proprio = this.proprietaire();
    return new Promise((resolve) => {
      this.rappels.statut(this.dejaOuverte ? "reconnecting" : "connecting");
      let ws: WebSocket;
      try {
        const url = this.opts.url();
        ws = this.opts.fabrique ? this.opts.fabrique(url) : new WebSocket(url);
      } catch {
        const repli = this.rappels.echecInitial();
        if (!repli) this.rappels.statut("closed");
        resolve(repli);
        return;
      }
      ws.binaryType = "arraybuffer";
      this.ws = ws;
      let ouverteUneFois = false;
      let regle = false;
      const regler = (v: boolean): void => {
        if (regle) return;
        regle = true;
        resolve(v);
      };

      ws.onopen = () => {
        if (this.ws !== ws) {
          try {
            ws.close();
          } catch {
            /* déjà fermée */
          }
          return;
        }
        ouverteUneFois = true;
        this.dejaOuverte = true;
        this.rappels.ouverte?.();
        this.rappels.statut("open");
        const { rows, cols } = this.rappels.taille();
        this.redimensionner(rows, cols);
        this.battement = proprio.intervalle(() => {
          if (this.ws !== ws || ws.readyState !== 1) return;
          try {
            ws.send(JSON.stringify({ op: "ping" }));
          } catch {
            /* coupure en cours */
          }
        }, this.opts.battementMs);
        regler(true);
      };

      ws.onmessage = (ev: MessageEvent<unknown>) => {
        if (this.ws !== ws) return;
        const data = ev.data;
        if (data instanceof ArrayBuffer) {
          this.rappels.sortie(new Uint8Array(data));
          return;
        }
        if (typeof data !== "string") return;
        let obj: unknown;
        try {
          obj = JSON.parse(data);
        } catch {
          return;
        }
        if (!obj || typeof obj !== "object") return;
        const message = obj as { type?: unknown; fresh_shell?: unknown };
        if (message.type === "hello") {
          // Shell neuf après un recyclage du serveur : le défilement est intact mais cwd et processus ont disparu.
          if (message.fresh_shell && this.shellVu) this.rappels.ecrire(MESSAGE_NOUVEAU_SHELL);
          this.shellVu = true;
        } else if (message.type === "session_expired") {
          this.expiree = true;
        } else if (message.type === "exit") {
          this.rappels.ecrire(MESSAGE_FIN);
          try {
            ws.close();
          } catch {
            /* déjà fermée */
          }
        }
      };

      ws.onclose = (ev: CloseEvent) => {
        if (this.ws !== ws) return;
        this.ws = null;
        this.battement?.();
        this.battement = null;
        // 4001 : session expirée ou révoquée ; ni repli ni reconnexion, et seulement pour la génération de la socket.
        if (ev.code === 4001 || this.expiree) {
          this.expiree = false;
          this.session.signalerExpiration(this.generation);
          regler(false);
          return;
        }
        if (!ouverteUneFois) {
          if (ev.code === 4004 && this.rappels.inconnue()) {
            regler(false);
            return;
          }
          const repli = this.rappels.echecInitial();
          if (!repli) this.rappels.statut("closed");
          regler(repli);
          return;
        }
        const reprendre = proprio.actif && this.rappels.doitReconnecter();
        this.rappels.statut(reprendre ? "reconnecting" : "closed");
        if (reprendre) {
          this.reprise = proprio.minuterie(() => {
            this.reprise = null;
            if (this.rappels.doitReconnecter()) void this.connecter();
          }, this.opts.reconnexionMs);
        }
      };
    });
  }
}
