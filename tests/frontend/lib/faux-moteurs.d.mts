// SPDX-License-Identifier: MIT
/** tests/frontend/lib/faux-moteurs.d.mts — types du faux vLLM / SGLang pour les tests vitest. */

export interface OptionsFauxMoteur {
  type?: "vllm" | "sglang";
  port?: number;
  modele?: string;
  contexte?: number;
  cleApi?: string;
  metriques?: boolean;
  detailsJetons?: boolean;
  parseurReflexion?: string | null;
  parseurOutils?: string | null;
  maxRequetes?: number;
  jetonsKv?: number;
  blocsKv?: number;
  tailleBloc?: number;
  priorites?: boolean;
  parDefaut?: string | null;
}

export type ReponseScriptee =
  | string
  | { contenu?: string; reflexion?: string; delaiMs?: number }
  | ((corps: Record<string, unknown>) => string | { contenu?: string; reflexion?: string; delaiMs?: number });

export interface RequeteVue {
  methode: string;
  url: string;
  corps: Record<string, unknown> | null;
  autorisation: string;
}

export interface EtatFauxMoteur {
  requetes: RequeteVue[];
  script: ReponseScriptee[];
  completions: number;
  enCours: number;
  enAttente: number;
  maxEnCours: number;
  kvRatio: number;
  prefixRequetes: number;
  prefixSucces: number;
  jetonsPrompt: number;
  jetonsGeneres: number;
  debit: number;
  tauxCache: number;
}

export interface FauxMoteur {
  type: "vllm" | "sglang";
  options: Required<OptionsFauxMoteur>;
  etat: EtatFauxMoteur;
  port: number;
  url: string;
  arreter(): Promise<void>;
}

export function demarrerFauxMoteur(options?: OptionsFauxMoteur): Promise<FauxMoteur>;
