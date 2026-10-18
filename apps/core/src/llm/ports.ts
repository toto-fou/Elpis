// SPDX-License-Identifier: MIT
/** apps/core/src/llm/ports.ts — dépendances du moteur pas encore portées (connecteurs, exécutions, disjoncteur, accès, diffusion, images) : interfaces et pose. */
import type { EngineRef } from "./moteurs";

/** Ligne `_with_key` d'un connecteur (clé déchiffrée) : jamais sérialisée vers HTTP. */
export interface ConnecteurSecret {
  enabled?: boolean | number | null;
  scope?: string | null;
  provider_type?: string | null;
  wire?: string | null;
  base_url?: string | null;
  api_key?: string | null;
  default_model?: string | null;
}

/** Vue publique `_public` d'un connecteur (sans clé), limites de la migration 0019 comprises. */
export interface ConnecteurPublic {
  max_models?: number | null;
  max_concurrency?: number | null;
  context_window?: unknown;
  n_ctx?: unknown;
  ctx_size?: unknown;
  meta?: unknown;
}

/** `shared_infra/llm/connectors.py` tel que le moteur l'appelle. */
export interface PortConnecteurs {
  getSecretForUser(userId: number, connectorId: number): Promise<ConnecteurSecret | null>;
  bumpLastUsed(connectorId: number): Promise<void>;
  getMeta(connectorId: number): Promise<ConnecteurPublic | null>;
  /** Types cloud permis aux connecteurs personnels de ce compte (tous pour un administrateur). */
  allowedProviderTypes(userId: number): readonly string[] | Promise<readonly string[]>;
}

/** Port appelé avant d'être posé : les appelants le traitent comme l'échec d'import de Python. */
export class ErreurPortAbsent extends Error {
  override name = "ErreurPortAbsent";
}

let portConnecteurs: PortConnecteurs | null = null;

export function installerConnecteurs(impl: PortConnecteurs | null): void {
  portConnecteurs = impl;
}

export function connecteurs(): PortConnecteurs {
  if (portConnecteurs === null) throw new ErreurPortAbsent("connecteurs LLM non installés");
  return portConnecteurs;
}

// ── Fournisseurs, santé et tokens (B1-16) ───────────────────────────────────

/** `current_run().add_llm_call(timings)` de l'observabilité : l'exécution courante compte un appel abouti. */
export interface PortExecutions {
  ajouterAppelLlm(timings: unknown): void;
}

/** Disjoncteur de l'ordonnanceur : panne de transport vue hors du garde (complétion de l'éditeur). */
export interface PortDisjoncteur {
  signalerPanneTransport(engine: EngineRef, model: string | null): void;
}

/** `engine_access.can_use_engine(uid, clé)` : visibilité d'un moteur pour un compte. */
export interface PortAccesMoteurs {
  peutUtiliserMoteur(uid: number, cle: string): boolean;
}

/** `system_events.broadcast` : diffusion aux navigateurs abonnés (état des modèles). */
export interface PortDiffusion {
  diffuser(message: Record<string, unknown>): void;
}

/** Réduction d'une capture PNG en JPEG (Pillow en Python, `images/traitement.ts` ici). */
export interface PortImages {
  reduireCapture(png: Uint8Array, largeurMax: number, qualite: number): Promise<Uint8Array | null>;
}

let portExecutions: PortExecutions | null = null;
let portDisjoncteur: PortDisjoncteur | null = null;
let portAccesMoteurs: PortAccesMoteurs | null = null;
let portDiffusion: PortDiffusion | null = null;
let portImages: PortImages | null = null;

export function installerExecutions(impl: PortExecutions | null): void {
  portExecutions = impl;
}

export function executions(): PortExecutions {
  if (portExecutions === null) throw new ErreurPortAbsent("suivi des exécutions non installé");
  return portExecutions;
}

export function installerDisjoncteur(impl: PortDisjoncteur | null): void {
  portDisjoncteur = impl;
}

export function disjoncteur(): PortDisjoncteur {
  if (portDisjoncteur === null) throw new ErreurPortAbsent("disjoncteur de l'ordonnanceur non installé");
  return portDisjoncteur;
}

export function installerAccesMoteurs(impl: PortAccesMoteurs | null): void {
  portAccesMoteurs = impl;
}

export function accesMoteurs(): PortAccesMoteurs {
  if (portAccesMoteurs === null) throw new ErreurPortAbsent("accès aux moteurs non installé");
  return portAccesMoteurs;
}

export function installerDiffusion(impl: PortDiffusion | null): void {
  portDiffusion = impl;
}

export function diffusion(): PortDiffusion {
  if (portDiffusion === null) throw new ErreurPortAbsent("diffusion des événements non installée");
  return portDiffusion;
}

export function installerImages(impl: PortImages | null): void {
  portImages = impl;
}

export function images(): PortImages {
  if (portImages === null) throw new ErreurPortAbsent("traitement d'images non installé");
  return portImages;
}
