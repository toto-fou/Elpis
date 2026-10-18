// SPDX-License-Identifier: MIT
/** packages/bac/src/agent.ts — contrat entre le bac (cycle de vie) et le client de l'agent du conteneur (@elpis/fichiers, agent_client.py) : état, démarrage, archive, extraction, erreurs. */
import type { Dict } from "@elpis/commun";

/** `SandboxStatus` du Python. */
export interface EtatBac {
  readonly exists: boolean;
  readonly running: boolean;
  readonly container_id: string | null;
  readonly container_name: string | null;
  readonly image: string | null;
  readonly started_at: string | null;
  readonly error: string | null;
}

/** Ce que le client de l'agent demande au bac (`UserSandbox`). */
export interface BacPourAgent {
  /** `P/work`, monté sur `/work` ; le socket de l'agent est sous `P/.elpis-agent`. */
  readonly sandboxPath: string;
  status(): Promise<EtatBac>;
  ensureRunning(): Promise<EtatBac>;
  startAgent(replace: boolean): Promise<void>;
}

/** `AgentError` : `code` stable, `status` HTTP (0 = transport), `data` du refus. */
export interface ErreurAgent extends Error {
  readonly name: "AgentError";
  readonly code: string;
  readonly status: number;
  readonly data: Dict;
}

/** Archive en flux : `debut` (le plan), puis octets ou objets ; `fin` (le bilan) une fois lue en entier. */
export interface ArchiveAgent extends AsyncIterable<Buffer | Dict> {
  readonly debut: Dict;
  readonly fin: Dict | null;
  fermer(): Promise<void>;
}

export interface OptionsArchive {
  readonly maxBytes: number;
  readonly maxFiles: number;
  readonly format?: "zip" | "tgz" | "raw";
  readonly base?: string;
  readonly prefix?: string;
  readonly dirs?: boolean;
  readonly walk?: boolean;
  readonly strict?: boolean;
  readonly deadlineS?: number;
  readonly activity?: boolean;
}

/** Corps envoyé à l'agent (il exige sa taille) : octets, fichier de l'hôte, flux de taille connue, ou flux nu recopié d'abord. */
export type DonneesEnvoi =
  | Uint8Array
  | { readonly chemin: string; readonly debut?: number }
  | { readonly flux: AsyncIterable<Uint8Array>; readonly taille: number }
  | AsyncIterable<Uint8Array>;

export interface OptionsExtraction {
  readonly maxBytes: number;
  readonly maxFile: number;
  readonly maxMembers: number;
  readonly keep?: string;
  readonly leave?: string;
  readonly onSent?: (n: number) => void;
}

/** Client de l'agent d'UN bac, vu du cycle de vie et des instantanés. */
export interface AgentBac {
  hello(): Promise<Dict>;
  archive(paths: readonly string[], options: OptionsArchive): Promise<ArchiveAgent>;
  extract(path: string, donnees: DonneesEnvoi, options: OptionsExtraction): Promise<Dict>;
}

export type FabriqueAgent = (bac: BacPourAgent) => AgentBac;

let fabrique: FabriqueAgent | null = null;

/** Posée par la composition de l'hôte (`(bac) => new AgentClient(bac)`) ; `null` pour l'oublier. */
export function definirFabriqueAgent(f: FabriqueAgent | null): void {
  fabrique = f;
}

export function fabriqueAgent(): FabriqueAgent | null {
  return fabrique;
}

export function estErreurAgent(e: unknown): e is ErreurAgent {
  return e instanceof Error && e.name === "AgentError" && typeof (e as { code?: unknown }).code === "string";
}

/** Erreur conforme à `ErreurAgent`, pour ce module (agent absent) et les doublures de test. */
export function erreurAgent(code: string, message = "", status = 0, data: Dict = {}): ErreurAgent {
  const e = new Error(message ? `${code}: ${message}` : code) as Error & {
    code: string;
    status: number;
    data: Dict;
  };
  e.name = "AgentError";
  e.message = message;
  e.code = code;
  e.status = status;
  e.data = data;
  return e as ErreurAgent;
}

/** Pannes de l'agent ou du conteneur, pas un refus portant sur le chemin (exec_bridge.PANNES_AGENT). */
export const PANNES_AGENT: readonly string[] = [
  "agent_unavailable",
  "container_down",
  "transport",
  "bad_response",
  "timeout",
];
