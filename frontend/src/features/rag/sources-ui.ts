// SPDX-License-Identifier: MIT
/** frontend/src/features/rag/sources-ui.ts — sources d'une réponse côté interface : résolution des renvois [n] d'un message de l'assistant, bulle au survol, visionneuse en volet ; un seul objet pour les pastilles, le pied de sources et les notices du fil. */
import type { CollectionVueRag, SourceCiteeRag } from "@elpis/contracts";

import type { ApiRag } from "./api";
import { creerBulle } from "./bulle";
import type { DepsBulle } from "./bulle";
import type { RenvoisMessage } from "./renvois";
import { sourceDuRenvoi } from "./sources";
import { creerVisionneuse } from "./visionneuse";

type FetchAuth = (url: string, init?: RequestInit, soft?: boolean) => Promise<Response | null>;

/** Ce que les sources lisent d'un message du fil. */
export interface MessageSources {
  readonly role?: string;
  readonly rag_sources?: readonly SourceCiteeRag[] | null;
}

export interface DepsSources {
  readonly api: ApiRag;
  readonly fetchAuth: FetchAuth;
  readonly messages: () => readonly MessageSources[];
  /** Collections lisibles du chat (rôle, ouverture des sources). */
  readonly collections: () => readonly CollectionVueRag[];
  /** Une collection au moins est active dans le chat : un renvoi sans source y est alors « inconnu ». */
  readonly ragActif: () => boolean;
  readonly fermerEditeur?: () => void;
  readonly annoncer?: (message: string) => void;
  readonly delais?: DepsBulle["delais"];
}

export function creerSources(dep: DepsSources) {
  const bulle = creerBulle(dep.delais === undefined ? {} : { delais: dep.delais });
  const visionneuse = creerVisionneuse({
    api: dep.api,
    fetchAuth: dep.fetchAuth,
    collections: dep.collections,
    ...(dep.fermerEditeur === undefined ? {} : { fermerEditeur: dep.fermerEditeur }),
    ...(dep.annoncer === undefined ? {} : { annoncer: dep.annoncer }),
  });

  /** Sources entre lesquelles on navigue depuis `s` : celles citées du message qui la porte, plus `s` elle-même. */
  function ensembleDe(s: SourceCiteeRag, idx: number): SourceCiteeRag[] {
    const msgs = dep.messages();
    for (let i = Math.min(idx, msgs.length - 1); i >= 0; i--) {
      const liste = msgs[i]?.rag_sources;
      if (liste?.some((x) => x.n === s.n)) return liste.filter((x) => x.cited);
    }
    return [];
  }

  /** Ouvre la visionneuse sur une source du message `idx` (la bulle se ferme). */
  function voir(s: SourceCiteeRag, idx: number): Promise<void> {
    bulle.fermer();
    return visionneuse.ouvrir(s, ensembleDe(s, idx));
  }

  /** Ouvre la visionneuse sur un ensemble donné (passages d'une notice de recherche). */
  function voirEnsemble(s: SourceCiteeRag, ensemble: readonly SourceCiteeRag[]): Promise<void> {
    bulle.fermer();
    return visionneuse.ouvrir(s, ensemble);
  }

  /** Renvois du message `idx` : `null` quand il n'a rien à voir avec le RAG (un `[1]` y reste du texte). */
  function renvoisPour(idx: number): RenvoisMessage | null {
    const msgs = dep.messages();
    const msg = msgs[idx];
    if (msg === undefined || msg.role !== "assistant") return null;
    const avant = msgs.slice(0, idx);
    const concerne =
      (msg.rag_sources?.length ?? 0) > 0 || avant.some((m) => (m.rag_sources?.length ?? 0) > 0);
    // Sans source dans la conversation, seule la dernière réponse d'un chat à collections actives peut citer un [n] sans source.
    const derniere = msgs.findLastIndex((m) => m.role === "assistant") === idx;
    if (!concerne && !(derniere && dep.ragActif())) return null;
    const resoudre = (n: number): SourceCiteeRag | null => sourceDuRenvoi(n, msg, avant);
    return {
      resoudre,
      survol(n, ancre) {
        const s = resoudre(n);
        if (s !== null) bulle.survol(s, ancre, () => void voir(s, idx));
      },
      sortie: () => bulle.sortie(),
      ouvrir(n) {
        const s = resoudre(n);
        if (s !== null) void voir(s, idx);
      },
      courante: () => bulle.etat.value?.source.n ?? visionneuse.numero.value,
    };
  }

  /** Échap : la bulle d'abord, puis la visionneuse ; vrai si l'un des deux était ouvert. */
  function echap(): boolean {
    return bulle.echap() || visionneuse.echap();
  }

  function fermer(): void {
    bulle.fermer();
    visionneuse.fermer();
  }

  return { bulle, visionneuse, collections: dep.collections, renvoisPour, voir, voirEnsemble, echap, fermer };
}

export type SurfaceSources = ReturnType<typeof creerSources>;
