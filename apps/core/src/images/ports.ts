// SPDX-License-Identifier: MIT
/** apps/core/src/images/ports.ts — dépendances des images pas encore portées (appel LLM, portée d'usage) et file commune des créneaux : interfaces et pose. */
import { reduireCapture } from "@elpis/images";

import { LLMQueue } from "../llm/ordonnanceur";
import type { Politique, ServerId } from "../llm/ordonnanceur";
import type { PortImages } from "../llm/ports";

/** Préfixe des serveurs d'images dans la file commune (un serveur par adresse de moteur). */
export const PREFIXE_SERVEUR_IMAGES = "image:";

const capacites = new Map<ServerId, number>();

/** Politique d'un serveur d'images : `max_concurrent` du moteur, un seul « modèle » ; `null` pour un autre serveur. */
export function politiqueServeurImages(server: ServerId): Politique | null {
  if (!server.startsWith(PREFIXE_SERVEUR_IMAGES)) return null;
  return { maxModels: 1, maxConcurrency: capacites.get(server) ?? 1 };
}

let file: LLMQueue | (() => LLMQueue) | null = null;

/** Pose la file du process (B1-20), ou son accesseur (relu à chaque usage) ; ses sources doivent rendre `politiqueServeurImages(server)` pour les serveurs `image:`. */
export function installerFileImages(q: LLMQueue | (() => LLMQueue) | null): void {
  file = q;
}

/** File des créneaux d'images : celle posée par la composition, sinon une file propre à ces serveurs. */
export function fileImages(): LLMQueue {
  if (typeof file === "function") return file();
  file ??= new LLMQueue({
    politique: (server) => politiqueServeurImages(server) ?? { maxModels: 1, maxConcurrency: 1 },
  });
  return file;
}

/** Capacité lue dans la configuration à chaque génération ; un changement s'applique tout de suite à la file. */
export function reglerCapacite(server: ServerId, cap: number): void {
  const n = Number.isFinite(cap) ? Math.max(1, Math.trunc(cap)) : 1;
  if (capacites.get(server) === n) return;
  capacites.set(server, n);
  fileImages().setPolicy(server, { maxModels: 1, maxConcurrency: n });
}

export type MessageLlm = { role: string; content: string };

/** `llama_chat_stream_tokens(msgs, user_id="image_prompt", thinking_mode=False, temperature 0.5, max_tokens 400)` sur la cible LLM courante (B1-17). */
export type AppelLlmEnrichissement = (
  messages: readonly MessageLlm[],
  options: { model: string | null; chatId: string; signal: AbortSignal },
) => Promise<string>;

let appelLlm: AppelLlmEnrichissement | null = null;

export function installerAppelEnrichissement(f: AppelLlmEnrichissement | null): void {
  appelLlm = f;
}

export function appelEnrichissement(): AppelLlmEnrichissement | null {
  return appelLlm;
}

/** `usage_scope(kind, origin_id=…)` de l'observabilité : les tokens de l'appel sont comptés sous cette origine. */
export type PorteeUsage = <T>(kind: string, originId: string, fn: () => Promise<T>) => Promise<T>;

let porteeUsage: PorteeUsage | null = null;

export function installerPorteeUsage(f: PorteeUsage | null): void {
  porteeUsage = f;
}

/** Sans observabilité posée, l'appel s'exécute tel quel. */
export function dansPorteeUsage<T>(kind: string, originId: string, fn: () => Promise<T>): Promise<T> {
  return porteeUsage === null ? fn() : porteeUsage(kind, originId, fn);
}

/** Implémentation du port `images()` de `llm/ports.ts` (B1-16), à poser par la composition. */
export const traitementImages: PortImages = { reduireCapture };
