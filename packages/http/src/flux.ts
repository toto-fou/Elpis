// SPDX-License-Identifier: MIT
/** packages/http/src/flux.ts — réponse en flux écrite à la main (`StreamingResponse`) : en-têtes de la route et de sécurité, contre-pression, fin à la déconnexion ou à l'arrêt. */
import { once } from "node:events";

import type { FastifyReply } from "fastify";

import { entetesFlux } from "./entetes";

export interface SortieFlux {
  readonly signal: AbortSignal;
  ecrire(texte: string): Promise<void>;
  fermer(): void;
}

/** Prend la réponse en main ; `signal` s'arrête à la déconnexion du client ou à l'arrêt du process. */
export function ouvrirFlux(
  reponse: FastifyReply,
  entetes: Readonly<Record<string, string>>,
  arret?: AbortSignal,
): SortieFlux {
  const brut = reponse.raw;
  const fin = new AbortController();
  reponse.hijack();
  brut.on("close", () => fin.abort());
  brut.on("error", () => fin.abort());
  if (brut.destroyed) fin.abort();
  else {
    brut.writeHead(200, entetesFlux(reponse, { ...entetes }));
    brut.flushHeaders();
  }
  return {
    signal: arret ? AbortSignal.any([fin.signal, arret]) : fin.signal,
    async ecrire(texte) {
      if (fin.signal.aborted || brut.writableEnded) return;
      if (!brut.write(texte)) await once(brut, "drain", { signal: fin.signal }).catch(() => undefined);
    },
    fermer() {
      if (!brut.writableEnded) brut.end();
    },
  };
}
