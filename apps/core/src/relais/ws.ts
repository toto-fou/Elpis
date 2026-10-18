// SPDX-License-Identifier: MIT
/** apps/core/src/relais/ws.ts — relais WebSocket vers l'hôte (`_relay_ws`) : texte et binaire dans les deux sens, fermeture propagée et bornée, battement, contre-pression. */
import WebSocket from "ws";
import type { RawData } from "ws";

import type { Journal } from "../journal";
import { codeFermeture, raisonFermeture } from "./chemins";
import { decrire } from "./http";

export interface PreparationWs {
  readonly uid: number;
  readonly url: URL;
  readonly entetes: Record<string, string>;
  readonly chemin: string;
  /** Session du navigateur toujours valide ? Absente pour un aperçu, identifié par son jeton. */
  readonly revalider?: (() => Promise<boolean>) | undefined;
}

export interface OptionsWs {
  readonly journal: Journal;
  readonly delaiConnexionMs: number;
  readonly battementMs: number;
  /** `SESSION_RECHECK_S` : période de revalidation de la session. */
  readonly revalidationMs: number;
  /** `_CLOSE_TIMEOUT_S` : délai d'une fermeture avant la coupure du transport. */
  readonly delaiFermetureMs: number;
  readonly surFin: (connexion: ConnexionWs) => void;
}

/** `json.dumps({"type": "session_expired"})`. */
const SESSION_EXPIREE = '{"type": "session_expired"}';

/** Au-delà de ce qui attend l'écriture d'un côté, l'autre côté cesse d'être lu (même ordre que la limite d'écriture de `websockets`). */
const SEUIL_HAUT = 64 * 1024;
const SEUIL_BAS = 16 * 1024;
/** Messages du navigateur gardés pendant la connexion à l'hôte (`ws_max_queue` d'uvicorn). */
const FILE_MAX = 32;

/** Transport coupé si `ws` n'est pas fermée dans le délai. */
function couperApres(ws: WebSocket, delaiMs: number): void {
  const coupure = setTimeout(() => ws.terminate(), delaiMs);
  ws.once("close", () => clearTimeout(coupure));
}

/** `close` borné (ouverte), ou fermeture déjà engagée bornée (en cours de fermeture). */
export function fermerBorne(ws: WebSocket, code: number, raison: string, delaiMs: number): void {
  if (ws.readyState === WebSocket.OPEN) {
    if (ws.isPaused) ws.resume();
    ws.close(code, raison);
    couperApres(ws, delaiMs);
  } else if (ws.readyState === WebSocket.CLOSING) couperApres(ws, delaiMs);
}

/** Résolue quand `ws` est fermée (transport compris). */
export function fermee(ws: WebSocket): Promise<void> {
  if (ws.readyState === WebSocket.CLOSED) return Promise.resolve();
  return new Promise((fin) => ws.once("close", () => fin()));
}

export class ConnexionWs {
  private amont: WebSocket | undefined;
  private ouvert = false;
  private fini = false;
  private readonly enAttente: { donnees: RawData; binaire: boolean }[] = [];
  private battement: NodeJS.Timeout | undefined;
  private surveillance: NodeJS.Timeout | undefined;
  private clientVivant = true;
  private amontVivant = true;
  /** Les deux côtés fermés : ce qu'attend l'arrêt du relais. */
  fin: Promise<void> = Promise.resolve();

  readonly client: WebSocket;
  readonly preparation: PreparationWs;
  private readonly options: OptionsWs;

  constructor(client: WebSocket, preparation: PreparationWs, options: OptionsWs) {
    this.client = client;
    this.preparation = preparation;
    this.options = options;
  }

  get uid(): number {
    return this.preparation.uid;
  }

  demarrer(): void {
    const { client, preparation, options } = this;
    client.on("message", (donnees, binaire) => this.versAmont(donnees, binaire));
    client.on("close", () => this.clientFerme());
    client.on("error", (e) => options.journal.info(`WS ${preparation.chemin} terminé : ${decrire(e)}`));
    client.on("pong", () => {
      this.clientVivant = true;
    });
    const amont = new WebSocket(preparation.url, {
      headers: preparation.entetes,
      handshakeTimeout: options.delaiConnexionMs,
      maxPayload: 0,
      followRedirects: false,
    });
    this.amont = amont;
    amont.on("open", () => this.amontOuvert(amont));
    amont.on("message", (donnees, binaire) => this.versClient(amont, donnees, binaire));
    amont.on("close", (code, raison) => this.amontFerme(code, raison.toString("utf8")));
    amont.on("error", (e) => this.amontErreur(e));
    amont.on("pong", () => {
      this.amontVivant = true;
    });
    this.fin = Promise.all([fermee(client), fermee(amont)]).then(() => undefined);
    this.battement = setInterval(() => this.battre(), options.battementMs);
    this.battement.unref();
  }

  /** Ferme les deux côtés, l'hôte d'abord (1000) puis le navigateur (`code`), chacun en temps borné. */
  fermer(code: number, raison = ""): void {
    this.fermerAmont();
    this.fermerClient(code, raison);
    this.nettoyer();
  }

  private fermerClient(code: number, raison: string): void {
    fermerBorne(this.client, code, raison, this.options.delaiFermetureMs);
  }

  private fermerAmont(code = 1000, raison = ""): void {
    const amont = this.amont;
    if (amont?.readyState === WebSocket.CONNECTING) amont.terminate();
    else if (amont !== undefined) fermerBorne(amont, code, raison, this.options.delaiFermetureMs);
  }

  private nettoyer(): void {
    if (this.fini) return;
    this.fini = true;
    clearInterval(this.battement);
    clearTimeout(this.surveillance);
    this.enAttente.length = 0;
    this.options.surFin(this);
  }

  private relancer(source: WebSocket, cible: WebSocket): void {
    if (source.isPaused && cible.bufferedAmount < SEUIL_BAS) source.resume();
  }

  private versAmont(donnees: RawData, binaire: boolean): void {
    const amont = this.amont;
    if (!this.ouvert || amont === undefined) {
      if (this.fini) return;
      this.enAttente.push({ donnees, binaire });
      if (this.enAttente.length >= FILE_MAX) this.client.pause();
      return;
    }
    if (amont.readyState !== WebSocket.OPEN) return;
    amont.send(donnees, { binary: binaire }, () => this.relancer(this.client, amont));
    if (amont.bufferedAmount > SEUIL_HAUT) this.client.pause();
  }

  private versClient(amont: WebSocket, donnees: RawData, binaire: boolean): void {
    if (this.client.readyState !== WebSocket.OPEN) return;
    this.client.send(donnees, { binary: binaire }, () => this.relancer(amont, this.client));
    if (this.client.bufferedAmount > SEUIL_HAUT) amont.pause();
  }

  private amontOuvert(amont: WebSocket): void {
    if (this.fini) {
      fermerBorne(amont, 1000, "", this.options.delaiFermetureMs);
      return;
    }
    this.ouvert = true;
    this.amontVivant = true;
    for (const { donnees, binaire } of this.enAttente.splice(0)) amont.send(donnees, { binary: binaire });
    if (this.client.isPaused) this.client.resume();
    this.surveiller();
  }

  /** `_surveiller` : session revalidée à chaque période, une erreur la laissant valide (comme `_session_valide`). */
  private surveiller(): void {
    const revalider = this.preparation.revalider;
    if (revalider === undefined || this.fini) return;
    this.surveillance = setTimeout(() => {
      void revalider().then(
        (valide) => {
          if (this.fini) return;
          if (valide) this.surveiller();
          else this.expirer();
        },
        () => this.surveiller(),
      );
    }, this.options.revalidationMs);
    this.surveillance.unref();
  }

  /** Session expirée ou révoquée : `session_expired` puis 4001 au navigateur, et 4001 à l'hôte, qui tue alors les terminaux du compte. */
  expirer(): void {
    if (this.client.readyState === WebSocket.OPEN) this.client.send(SESSION_EXPIREE);
    this.fermerAmont(4001, "session expired");
    this.fermerClient(4001, "session expired");
    this.nettoyer();
  }

  private amontErreur(erreur: Error): void {
    if (this.ouvert) {
      this.options.journal.info(`WS ${this.preparation.chemin} terminé : ${decrire(erreur)}`);
      return;
    }
    if (this.fini) return;
    this.options.journal.warn(`WS amont ${this.preparation.url.href} : ${decrire(erreur)}`);
    this.fermerClient(1011, "tool host unreachable");
    this.nettoyer();
  }

  /** Le navigateur lit le code de l'hôte (4001 session expirée, 4004 session inconnue) ; un code réservé devient 1011. */
  private amontFerme(code: number, raison: string): void {
    if (!this.ouvert || this.fini) return;
    this.fermerClient(codeFermeture(code), raisonFermeture(raison));
    this.nettoyer();
  }

  private clientFerme(): void {
    this.fermerAmont();
    this.nettoyer();
  }

  /** Battement de `websockets` : un ping par période, et sans pong à la suivante le côté muet est coupé. */
  private battre(): void {
    const { client, amont } = this;
    if (!this.clientVivant) {
      client.terminate();
      return;
    }
    if (this.ouvert && amont !== undefined && !this.amontVivant) {
      amont.terminate();
      this.fermerClient(1011, "keepalive ping timeout");
      this.nettoyer();
      return;
    }
    this.clientVivant = false;
    if (client.readyState === WebSocket.OPEN) client.ping();
    if (this.ouvert && amont?.readyState === WebSocket.OPEN) {
      this.amontVivant = false;
      amont.ping();
    }
  }
}
