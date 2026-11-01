// SPDX-License-Identifier: MIT
/** apps/core/src/outils/ports.ts — dépendances des outils posées par main (manifeste `mcp.json`, sous-agents en fond sur le service des jobs) : interfaces et pose. */
import { ErreurPortAbsent } from "../llm/ports";
import type { Dict } from "../python";

/** Chargement du manifeste `mcp.json` (`@elpis/mcp`) tel que le registre des catégories l'appelle. */
export interface PortManifesteMcp {
  defaultOnCategories(): Iterable<string>;
}

let portManifeste: PortManifesteMcp | null = null;

export function installerManifesteMcp(impl: PortManifesteMcp | null): void {
  portManifeste = impl;
}

export function manifesteMcp(): PortManifesteMcp {
  if (portManifeste === null) throw new ErreurPortAbsent("manifeste MCP non installé");
  return portManifeste;
}

/** Inscription d'un sous-agent en fond : son job, ou un refus rendu au modèle. */
export type InscriptionFond =
  | { readonly ok: true; readonly jobId: string; readonly runId: string }
  | { readonly ok: false; readonly error: string; readonly message: string; readonly fix: string };

/** Fin d'un sous-agent en fond : état du job, déclencheur (`exit` réveille, `killed` non), enveloppe de `task`, détail final. */
export interface FinFond {
  readonly etat: "exited" | "killed" | "lost";
  readonly declencheur: "exit" | "killed" | "lost";
  readonly taskId: string;
  readonly agent: string;
  readonly enveloppe: string;
  readonly detail: Dict;
  readonly resume: string;
  readonly dureeS: number;
}

/** Sous-agents lancés en fond vus par `task` : inscription parmi les jobs, progression publiée, fin livrée comme un événement de job, rapport pris pour un résultat d'outil. */
export interface PortTachesFond {
  inscrire(
    uid: number,
    chatId: string,
    d: { callId: string; label: string; max: number; detail: Dict },
  ): Promise<InscriptionFond>;
  progresser(uid: number, jobId: string, detail: Dict, ligne: string): Promise<void>;
  terminer(uid: number, jobId: string, fin: FinFond): Promise<void>;
  /** Rapport d'un enfant fini pris pour le résultat d'outil du tour en cours, rendu en `<job_event>` ; `null` s'il a déjà été remis, ou si `signal` est levé (rien n'est alors pris). */
  prendreRapport(uid: number, chatId: string, jobId: string, signal?: AbortSignal): Promise<string | null>;
  /** Le tour `runId` de la conversation tourne-t-il encore ? */
  tourActif(uid: number, chatId: string, runId: string): boolean;
}

let portFond: PortTachesFond | null = null;

export function installerTachesFond(impl: PortTachesFond | null): void {
  portFond = impl;
}

/** `null` hors de main (routines d'un autre process, tests) : `task(background=true)` y est refusé. */
export function tachesFond(): PortTachesFond | null {
  return portFond;
}
