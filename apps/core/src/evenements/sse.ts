// SPDX-License-Identifier: MIT
/** apps/core/src/evenements/sse.ts — trames SSE de sse-starlette (`\r\n`), flux écrit à la main et analyseur côté client. */
import type { FastifyReply } from "fastify";

import type { Journal } from "../journal";
import { entetesFlux } from "@elpis/http";

/** En-têtes d'`EventSourceResponse` (sse-starlette 3.4.4) ; les en-têtes de sécurité s'y ajoutent. */
export const ENTETES_SSE: Readonly<Record<string, string>> = {
  "cache-control": "no-store",
  connection: "keep-alive",
  "x-accel-buffering": "no",
  "content-type": "text/event-stream; charset=utf-8",
};

export const PING_SSE_MS = 15_000;

const FIN_DE_LIGNE = /\r\n|\r|\n/u;

function lignes(prefixe: string, valeur: string): string {
  return valeur
    .split(FIN_DE_LIGNE)
    .map((l) => `${prefixe}${l}\r\n`)
    .join("");
}

/** `data: …` après l'adaptateur de routes_events.py : les `\n` finaux tombent, chaque ligne devient un champ `data`. */
export function encoderDonneeSse(donnees: string): string {
  return lignes("data: ", donnees.replace(/\n+$/u, "")) + "\r\n";
}

export function encoderCommentaireSse(commentaire: string): string {
  return lignes(": ", commentaire) + "\r\n";
}

/** Trame complète dans l'ordre de `ServerSentEvent.encode` : `id`, `event`, puis `data`. */
export function encoderEvenementSse(donnees: string, id?: string, evenement?: string): string {
  const tete =
    (id === undefined ? "" : `id: ${id.replace(/[\r\n]/gu, "")}\r\n`) +
    (evenement === undefined ? "" : `event: ${evenement.replace(/[\r\n]/gu, "")}\r\n`);
  return tete + encoderDonneeSse(donnees);
}

function deux(n: number): string {
  return String(n).padStart(2, "0");
}

/** `str(datetime.now(timezone.utc))` à la milliseconde près : la fraction disparaît quand elle est nulle. */
export function horodatagePing(date: Date): string {
  const annee = String(date.getUTCFullYear()).padStart(4, "0");
  const jour = `${annee}-${deux(date.getUTCMonth() + 1)}-${deux(date.getUTCDate())}`;
  const heure = `${deux(date.getUTCHours())}:${deux(date.getUTCMinutes())}:${deux(date.getUTCSeconds())}`;
  const ms = date.getUTCMilliseconds();
  return `${jour} ${heure}${ms === 0 ? "" : "." + String(ms * 1000).padStart(6, "0")}+00:00`;
}

export function tramePing(date = new Date()): string {
  return encoderCommentaireSse(`ping - ${horodatagePing(date)}`);
}

export const GRACE_ARRET_MS = 2_000;

export interface SortieFlux {
  readonly signal: AbortSignal;
  ecrire(texte: string): Promise<void>;
  pousser(texte: string): void;
  fermer(): void;
}

export interface OptionsSortie {
  journal?: Journal | undefined;
  arret?: AbortSignal | undefined;
  graceMs?: number | undefined;
}

/** Prend la réponse en main : en-têtes SSE et de sécurité, contre-pression, fin à la déconnexion et, après une grâce, à l'arrêt. */
export function ouvrirSortieSse(reponse: FastifyReply, options: OptionsSortie = {}): SortieFlux {
  const brut = reponse.raw;
  const fin = new AbortController();
  const { arret } = options;
  reponse.hijack();
  let coupure: NodeJS.Timeout | undefined;
  const surArret = (): void => {
    coupure = setTimeout(() => {
      if (!brut.writableFinished) brut.destroy();
    }, options.graceMs ?? GRACE_ARRET_MS);
  };
  fin.signal.addEventListener(
    "abort",
    () => {
      clearTimeout(coupure);
      arret?.removeEventListener("abort", surArret);
    },
    { once: true },
  );
  brut.on("close", () => fin.abort());
  brut.on("error", (e: unknown) => {
    options.journal?.debug({ err: e }, "flux SSE : erreur d'écriture");
    fin.abort();
  });
  if (brut.destroyed) fin.abort();
  else if (arret?.aborted) surArret();
  else arret?.addEventListener("abort", surArret, { once: true });
  if (!fin.signal.aborted) {
    brut.writeHead(200, entetesFlux(reponse, { ...ENTETES_SSE }));
    brut.flushHeaders();
  }
  return {
    signal: fin.signal,
    async ecrire(texte: string): Promise<void> {
      if (fin.signal.aborted || brut.destroyed || brut.writableEnded) return;
      if (brut.write(texte) || arret?.aborted) return;
      await new Promise<void>((suite) => {
        const finir = (): void => {
          brut.off("drain", finir);
          fin.signal.removeEventListener("abort", finir);
          arret?.removeEventListener("abort", finir);
          suite();
        };
        brut.on("drain", finir);
        fin.signal.addEventListener("abort", finir, { once: true });
        arret?.addEventListener("abort", finir, { once: true });
      });
    },
    pousser(texte: string): void {
      if (!fin.signal.aborted && !brut.destroyed && !brut.writableEnded) brut.write(texte);
    },
    fermer(): void {
      if (!brut.writableEnded) brut.end();
    },
  };
}

/** `EventSourceResponse(…, ping=15)` : une trame `data` par élément, un ping toutes les 15 s depuis l'ouverture. */
export async function servirFluxSse(
  reponse: FastifyReply,
  source: (signal: AbortSignal) => AsyncIterable<string>,
  options: OptionsSortie & { pingMs?: number | undefined } = {},
): Promise<void> {
  const sortie = ouvrirSortieSse(reponse, options);
  const ping = setInterval(() => sortie.pousser(tramePing()), options.pingMs ?? PING_SSE_MS);
  try {
    for await (const donnees of source(sortie.signal)) {
      if (sortie.signal.aborted) break;
      await sortie.ecrire(encoderDonneeSse(donnees));
    }
  } catch (e) {
    options.journal?.warn({ err: e }, "flux SSE interrompu");
  } finally {
    clearInterval(ping);
    sortie.fermer();
  }
}

export interface EvenementSse {
  readonly type: string;
  readonly donnees: string;
  readonly id: string;
}

/** Analyseur `text/event-stream` (algorithme WHATWG) : CRLF, CR ou LF, commentaires, `id` validé à la ligne vide. */
export class AnalyseurSse {
  private reste = "";
  private crEnSuspens = false;
  private donnees: string[] = [];
  private type = "";
  private idTampon = "";
  private idValide = "";
  retry: number | undefined;

  get dernierId(): string {
    return this.idValide;
  }

  pousser(morceau: string): EvenementSse[] {
    let texte = morceau;
    if (this.crEnSuspens && texte.startsWith("\n")) texte = texte.slice(1);
    this.crEnSuspens = false;
    texte = this.reste + texte;
    const sortie: EvenementSse[] = [];
    let debut = 0;
    for (let i = 0; i < texte.length; i++) {
      const c = texte.charCodeAt(i);
      if (c !== 0x0a && c !== 0x0d) continue;
      this.ligne(texte.slice(debut, i), sortie);
      if (c === 0x0d) {
        if (i + 1 === texte.length) this.crEnSuspens = true;
        else if (texte.charCodeAt(i + 1) === 0x0a) i++;
      }
      debut = i + 1;
    }
    this.reste = texte.slice(debut);
    return sortie;
  }

  private ligne(ligne: string, sortie: EvenementSse[]): void {
    if (ligne === "") {
      this.idValide = this.idTampon;
      if (this.donnees.length > 0) {
        sortie.push({ type: this.type || "message", donnees: this.donnees.join("\n"), id: this.idValide });
      }
      this.donnees = [];
      this.type = "";
      return;
    }
    if (ligne.startsWith(":")) return;
    const deuxPoints = ligne.indexOf(":");
    const champ = deuxPoints < 0 ? ligne : ligne.slice(0, deuxPoints);
    let valeur = deuxPoints < 0 ? "" : ligne.slice(deuxPoints + 1);
    if (valeur.startsWith(" ")) valeur = valeur.slice(1);
    if (champ === "data") this.donnees.push(valeur);
    else if (champ === "event") this.type = valeur;
    else if (champ === "id" && !valeur.includes("\0")) this.idTampon = valeur;
    else if (champ === "retry" && /^\d+$/u.test(valeur)) this.retry = Number(valeur);
  }
}
