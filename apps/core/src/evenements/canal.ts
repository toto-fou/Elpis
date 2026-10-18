// SPDX-License-Identifier: MIT
/** apps/core/src/evenements/canal.ts — canal interne main → admin (décision 4) : SSE à tampon circulaire, reprise par `Last-Event-ID`. */
import { randomBytes } from "node:crypto";

import { pyJsonDumps } from "@elpis/commun";
import type { FastifyReply } from "fastify";

import type { Journal } from "../journal";
import type { StatutMain } from "./redemarrage";
import { AnalyseurSse, encoderCommentaireSse, encoderEvenementSse, ouvrirSortieSse } from "./sse";
import type { EvenementSse, OptionsSortie } from "./sse";
import type { Message, SystemEvents } from "./systeme";

export const CAPACITE_CANAL = 1000;
export const PING_CANAL_MS = 15_000;
export const EVENEMENT_PERTE = "perte";
const SEUIL_ALERTE_MS = 60_000;
const RAPPEL_ALERTE_MS = 600_000;

/** Ce que la console doit voir des diffusions de main (`frontend/src/features/auth/sse-systeme.ts`) ; les `log` passent par le journal commun. */
export const TYPES_CONSOLE: ReadonlySet<string> = new Set([
  "model_status",
  "model_changed",
  "notification",
  "restart",
  "app_restarting",
]);

interface Entree {
  readonly seq: number;
  readonly donnees: string;
}

/** Tampon circulaire des diffusions de main ; identifiants `<génération>-<n>`, la génération change à chaque démarrage. */
export class CanalInterne {
  readonly generation: string;
  readonly capacite: number;
  private seq = 0;
  private readonly tampon: Entree[] = [];
  private readonly enAttente = new Set<() => void>();

  constructor(options: { capacite?: number; generation?: string } = {}) {
    this.capacite = Math.max(1, options.capacite ?? CAPACITE_CANAL);
    this.generation = options.generation ?? randomBytes(6).toString("hex");
  }

  get dernierSeq(): number {
    return this.seq;
  }

  /** Flux de `servirCanal` en attente d'une publication. */
  get attentes(): number {
    return this.enAttente.size;
  }

  private get premierSeq(): number {
    return this.tampon[0]?.seq ?? this.seq + 1;
  }

  id(seq: number): string {
    return `${this.generation}-${seq}`;
  }

  publier(donnees: string): void {
    this.seq += 1;
    this.tampon.push({ seq: this.seq, donnees });
    if (this.tampon.length > this.capacite) this.tampon.shift();
    for (const reveiller of [...this.enAttente]) reveiller();
  }

  /** Point de reprise d'un abonné : exact dans le tampon, sinon perte signalée (autre génération : tout le tampon). */
  reprise(dernierId: string | undefined): { curseur: number; perte: boolean } {
    if (dernierId === undefined || dernierId === "") return { curseur: this.seq, perte: false };
    const m = /^([0-9a-f]+)-(\d{1,15})$/u.exec(dernierId);
    if (m === null || m[1] !== this.generation) return { curseur: this.premierSeq - 1, perte: true };
    const seq = Number(m[2]);
    if (seq > this.seq) return { curseur: this.seq, perte: true };
    if (seq < this.premierSeq - 1) return { curseur: this.premierSeq - 1, perte: true };
    return { curseur: seq, perte: false };
  }

  /** Entrées après `curseur` ; `perte` quand le tampon a déjà tourné au-delà (abonné trop lent). */
  lire(curseur: number): { entrees: readonly Entree[]; perte: boolean } {
    const premier = this.premierSeq;
    return { entrees: this.tampon.slice(Math.max(0, curseur + 1 - premier)), perte: curseur < premier - 1 };
  }

  /** Attend une publication postérieure à `curseur`, l'échéance ou l'abandon. */
  attendre(curseur: number, delaiMs: number, signal: AbortSignal): Promise<void> {
    if (this.seq > curseur || signal.aborted) return Promise.resolve();
    return new Promise((suite) => {
      const finir = (): void => {
        clearTimeout(minuterie);
        signal.removeEventListener("abort", finir);
        this.enAttente.delete(finir);
        suite();
      };
      const minuterie = setTimeout(finir, delaiMs);
      signal.addEventListener("abort", finir, { once: true });
      this.enAttente.add(finir);
    });
  }
}

export function tramePerte(canal: CanalInterne, curseur: number): string {
  return encoderEvenementSse("{}", canal.id(curseur), EVENEMENT_PERTE);
}

/** Identifiant seul (aucun événement) : l'abonné connaît sa position avant même le premier message. */
export function trameRepere(canal: CanalInterne, curseur: number): string {
  return `id: ${canal.id(curseur)}\r\n\r\n`;
}

/** `GET /api/internal/events` : repère ou perte, rejeu, puis direct ; ping après `pingMs` de silence ; fin sur `arret` ou déconnexion. */
export async function servirCanal(
  reponse: FastifyReply,
  canal: CanalInterne,
  dernierId: string | undefined,
  options: OptionsSortie & { pingMs?: number | undefined } = {},
): Promise<void> {
  const sortie = ouvrirSortieSse(reponse, options);
  const pingMs = options.pingMs ?? PING_CANAL_MS;
  const fin = new AbortController();
  const couper = (): void => fin.abort();
  sortie.signal.addEventListener("abort", couper, { once: true });
  options.arret?.addEventListener("abort", couper, { once: true });
  if (sortie.signal.aborted || options.arret?.aborted) fin.abort();
  const depart = canal.reprise(dernierId);
  let curseur = depart.curseur;
  try {
    if (depart.perte) {
      options.journal?.info(
        `canal interne : reprise impossible depuis « ${dernierId ?? ""} », perte signalée`,
      );
      await sortie.ecrire(tramePerte(canal, curseur));
    } else {
      await sortie.ecrire(trameRepere(canal, curseur));
    }
    let dernierEnvoi = Date.now();
    while (!fin.signal.aborted) {
      const lecture = canal.lire(curseur);
      if (lecture.perte) {
        curseur = (lecture.entrees[0]?.seq ?? canal.dernierSeq + 1) - 1;
        await sortie.ecrire(tramePerte(canal, curseur));
        dernierEnvoi = Date.now();
      }
      for (const entree of lecture.entrees) {
        if (fin.signal.aborted) break;
        await sortie.ecrire(encoderEvenementSse(entree.donnees, canal.id(entree.seq)));
        curseur = entree.seq;
        dernierEnvoi = Date.now();
      }
      if (fin.signal.aborted) break;
      const reste = pingMs - (Date.now() - dernierEnvoi);
      if (reste > 0) {
        await canal.attendre(curseur, reste, fin.signal);
        continue;
      }
      await sortie.ecrire(encoderCommentaireSse("ping"));
      dernierEnvoi = Date.now();
    }
  } catch (e) {
    options.journal?.warn({ err: e }, "canal interne : flux interrompu");
  } finally {
    sortie.signal.removeEventListener("abort", couper);
    options.arret?.removeEventListener("abort", couper);
    sortie.fermer();
  }
}

/** Attente croissante bornée : `initial`, ×2 à chaque échec, plafonnée à `max`. */
export function delaiReconnexion(tentative: number, initialMs: number, maxMs: number): number {
  return Math.min(maxMs, initialMs * 2 ** Math.min(tentative, 30));
}

function dormir(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((suite) => {
    const finir = (): void => {
      clearTimeout(minuterie);
      signal.removeEventListener("abort", finir);
      suite();
    };
    const minuterie = setTimeout(finir, ms);
    signal.addEventListener("abort", finir, { once: true });
  });
}

function urlInterne(base: string, chemin: string): string {
  return base.replace(/\/+$/u, "") + chemin;
}

export interface OptionsAbonnement {
  url: string;
  jeton: () => string;
  bus: SystemEvents;
  journal?: Journal;
  types?: Iterable<string>;
  delaiInitialMs?: number;
  delaiMaxMs?: number;
  inactiviteMs?: number;
  seuilAlerteMs?: number;
  rappelAlerteMs?: number;
  surPerte?: () => void;
  fetch?: typeof fetch;
}

/** Abonnement de l'admin : republie dans son bus ce que la console doit voir, se reconnecte avec attente croissante. */
export class AbonnementCanal {
  dernierId: string | undefined;
  connexions = 0;
  private debutPanne: number | undefined;
  private derniereAlerte: number | undefined;
  private enLigne = false;
  private readonly types: ReadonlySet<string>;
  private readonly options: OptionsAbonnement;

  constructor(options: OptionsAbonnement) {
    this.options = options;
    this.types = new Set(options.types ?? TYPES_CONSOLE);
  }

  get connecte(): boolean {
    return this.enLigne;
  }

  async executer(arret: AbortSignal): Promise<void> {
    const initial = this.options.delaiInitialMs ?? 1_000;
    const max = this.options.delaiMaxMs ?? 30_000;
    let tentative = 0;
    while (!arret.aborted) {
      if (await this.unePasse(arret)) tentative = 0;
      if (arret.aborted) break;
      await dormir(delaiReconnexion(tentative, initial, max), arret);
      tentative += 1;
    }
  }

  /** Configuration refusée : erreur tout de suite ; panne réseau : avertissement après le seuil ; rappel espacé, sinon débogage. */
  private echec(raison: string, configuration: boolean): void {
    const maintenant = Date.now();
    this.debutPanne ??= maintenant;
    const texte = `canal interne main → admin : ${raison}`;
    const rappel =
      this.derniereAlerte === undefined ||
      maintenant - this.derniereAlerte >= (this.options.rappelAlerteMs ?? RAPPEL_ALERTE_MS);
    const durable = maintenant - this.debutPanne >= (this.options.seuilAlerteMs ?? SEUIL_ALERTE_MS);
    if (rappel && configuration) this.options.journal?.error(`${texte} (configuration à vérifier)`);
    else if (rappel && durable)
      this.options.journal?.warn(
        `${texte} (injoignable depuis ${Math.round((maintenant - this.debutPanne) / 1000)} s)`,
      );
    else {
      this.options.journal?.debug(texte);
      return;
    }
    this.derniereAlerte = maintenant;
  }

  private retabli(): void {
    if (this.derniereAlerte !== undefined) this.options.journal?.info("canal interne main → admin rétabli");
    this.debutPanne = undefined;
    this.derniereAlerte = undefined;
  }

  /** Une connexion : vrai si le flux s'est ouvert (l'attente repart alors de zéro). */
  private async unePasse(arret: AbortSignal): Promise<boolean> {
    const coupure = new AbortController();
    const relayer = (): void => coupure.abort();
    arret.addEventListener("abort", relayer, { once: true });
    let inactivite: NodeJS.Timeout | undefined;
    const rearmer = (): void => {
      clearTimeout(inactivite);
      inactivite = setTimeout(() => coupure.abort(), this.options.inactiviteMs ?? 3 * PING_CANAL_MS);
    };
    let ouvert = false;
    try {
      const entetes: Record<string, string> = {
        accept: "text/event-stream",
        authorization: `Bearer ${this.options.jeton()}`,
      };
      if (this.dernierId !== undefined) entetes["last-event-id"] = this.dernierId;
      rearmer();
      const reponse = await (this.options.fetch ?? fetch)(
        urlInterne(this.options.url, "/api/internal/events"),
        {
          headers: entetes,
          signal: coupure.signal,
        },
      );
      const type = reponse.headers.get("content-type") ?? "";
      if (reponse.status !== 200 || reponse.body === null || !type.startsWith("text/event-stream")) {
        await reponse.body?.cancel().catch(() => undefined);
        const configuration = reponse.status < 500 || reponse.status === 503;
        this.echec(`HTTP ${reponse.status} ${type || "sans type"}`.trim(), configuration);
        return false;
      }
      ouvert = true;
      this.enLigne = true;
      this.connexions += 1;
      this.retabli();
      const analyseur = new AnalyseurSse();
      const decodeur = new TextDecoder();
      const lecteur = reponse.body.getReader();
      for (;;) {
        rearmer();
        const { value, done } = await lecteur.read();
        if (done) break;
        for (const evenement of analyseur.pousser(decodeur.decode(value, { stream: true }))) {
          this.traiter(evenement);
        }
        if (analyseur.dernierId !== "") this.dernierId = analyseur.dernierId;
      }
      if (!arret.aborted) this.options.journal?.debug("canal interne : flux fermé par main, reconnexion");
    } catch (e) {
      if (!arret.aborted) this.echec(e instanceof Error ? e.message : String(e), false);
    } finally {
      clearTimeout(inactivite);
      arret.removeEventListener("abort", relayer);
      this.enLigne = false;
      coupure.abort();
    }
    return ouvert;
  }

  private traiter(evenement: EvenementSse): void {
    if (evenement.type === EVENEMENT_PERTE) {
      this.options.journal?.info("canal interne : événements de main perdus, la console se resynchronise");
      this.options.surPerte?.();
      return;
    }
    if (evenement.type !== "message") return;
    let message: unknown;
    try {
      message = JSON.parse(evenement.donnees);
    } catch {
      this.options.journal?.debug("canal interne : événement illisible ignoré");
      return;
    }
    if (message === null || typeof message !== "object" || Array.isArray(message)) return;
    const type = (message as Message)["type"];
    if (typeof type !== "string" || !this.types.has(type)) return;
    this.options.bus.broadcast(message as Message, { relais: false, donnees: evenement.donnees });
  }
}

export interface AppelInterne {
  url: string;
  jeton: () => string;
  journal?: Journal;
  delaiMs?: number;
  fetch?: typeof fetch;
}

/** Admin → main sur la boucle locale (`POST /api/internal/events`) : révocation, bannière ; jamais d'exception. */
export async function publierVersMain(evenement: Message, appel: AppelInterne): Promise<boolean> {
  try {
    const reponse = await (appel.fetch ?? fetch)(urlInterne(appel.url, "/api/internal/events"), {
      method: "POST",
      headers: { authorization: `Bearer ${appel.jeton()}`, "content-type": "application/json" },
      body: pyJsonDumps(evenement),
      signal: AbortSignal.timeout(appel.delaiMs ?? 5_000),
    });
    await reponse.body?.cancel().catch(() => undefined);
    if (reponse.ok) return true;
    appel.journal?.warn(
      `publication vers main refusée (HTTP ${reponse.status}, type=${String(evenement["type"])})`,
    );
  } catch (e) {
    appel.journal?.warn({ err: e }, `publication vers main impossible (type=${String(evenement["type"])})`);
  }
  return false;
}

/** `GET /api/internal/status` de main ; `null` si main ne répond pas (redémarrage en cours) ou répond mal. */
export async function lireStatutMain(appel: AppelInterne): Promise<StatutMain | null> {
  try {
    const reponse = await (appel.fetch ?? fetch)(urlInterne(appel.url, "/api/internal/status"), {
      headers: { authorization: `Bearer ${appel.jeton()}` },
      signal: AbortSignal.timeout(appel.delaiMs ?? 5_000),
    });
    if (!reponse.ok) {
      await reponse.body?.cancel().catch(() => undefined);
      return null;
    }
    const statut = (await reponse.json()) as Partial<StatutMain> | null;
    return statut !== null && Array.isArray(statut.pending) ? (statut as StatutMain) : null;
  } catch (e) {
    appel.journal?.debug({ err: e }, "statut de main illisible");
    return null;
  }
}
