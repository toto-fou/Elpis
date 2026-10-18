// SPDX-License-Identifier: MIT
/** apps/core/src/contexte/ports.ts — dépendances du contexte pas encore portées (comptes, bac à sable, mémoire AX, prompts, index, usage) : interfaces et pose. */
import { ErreurPortAbsent } from "../llm/ports";

/** Identifiant du profil retenu (celui demandé, même absent de la configuration) et mode du profil appliqué. */
export type ProfilEffectif = { id: string; mode: unknown };

/** Profil réseau effectif du compte (`get_user` + `resolve_network_profile_id` + `load_admin_config().get_profile`). */
export interface PortProfilReseau {
  profilReseau(username: string): ProfilEffectif | Promise<ProfilEffectif>;
}

/** `shared_infra.memory.ax` : détection des sites, URL de la session navigateur, rendu de la carte d'un site. */
export interface PortMemoireAx {
  detectSitesFromText(text: string): string[];
  detectSessionUrl(messages: readonly unknown[], owner: string): Promise<string | null>;
  normalizeUrl(url: string): [string, string];
  renderSiteContextual(
    site: string,
    options: { currentPath: string | null; iteration: number; owner: string },
  ): string | Promise<string>;
}

/** `llm_core._system_prompts` (B1-19b) : runtime_context et fragments de capacité. */
export interface PortPromptsCapacites {
  capabilityWantsRuntimeContext(activeCategories: ReadonlySet<string>): boolean;
  buildCapabilityBlock(activeCategories: ReadonlySet<string>): string | null | Promise<string | null>;
}

/** Ligne de l'index de session (`shared_infra.memory.store.session_index_messages`). */
export interface LigneIndexSession {
  user_id: number;
  app: string;
  session_id: string;
  scope_key: string;
  role: string;
  content: string;
  ts: number;
}

/** Compte, index de recherche d'historique et registre d'usage, utilisés par le compresseur. */
export interface PortCompresseur {
  userIdParNom(username: string): Promise<number | null>;
  sessionIndexMessages(rows: LigneIndexSession[]): Promise<number>;
  recordTurnUsage(
    usage: unknown,
    options: { model: string; path: string; durationMs: number; iterations: number },
  ): void;
}

let profil: PortProfilReseau | null = null;
let ax: PortMemoireAx | null = null;
let prompts: PortPromptsCapacites | null = null;
let compresseur: PortCompresseur | null = null;

export function installerProfilReseau(impl: PortProfilReseau | null): void {
  profil = impl;
}

export function installerMemoireAx(impl: PortMemoireAx | null): void {
  ax = impl;
}

export function installerPromptsCapacites(impl: PortPromptsCapacites | null): void {
  prompts = impl;
}

export function installerPortCompresseur(impl: PortCompresseur | null): void {
  compresseur = impl;
}

export function portProfilReseau(): PortProfilReseau {
  if (profil === null) throw new ErreurPortAbsent("profil réseau du compte non installé");
  return profil;
}

export function portMemoireAx(): PortMemoireAx {
  if (ax === null) throw new ErreurPortAbsent("mémoire AX non installée");
  return ax;
}

export function portPromptsCapacites(): PortPromptsCapacites {
  if (prompts === null) throw new ErreurPortAbsent("prompts de capacité non installés");
  return prompts;
}

/** Ligne « active jobs » de l'ancre de compaction (tâches de fond de la conversation), `""` sans job actif. */
export type LigneJobsActifs = (username: string, chatId: string) => Promise<string>;

let jobsActifs: LigneJobsActifs | null = null;

export function installerJobsActifs(f: LigneJobsActifs | null): void {
  jobsActifs = f;
}

export function ligneJobsActifs(): LigneJobsActifs | null {
  return jobsActifs;
}

export function portCompresseur(): PortCompresseur {
  if (compresseur === null) throw new ErreurPortAbsent("comptes, index de session et usage non installés");
  return compresseur;
}
