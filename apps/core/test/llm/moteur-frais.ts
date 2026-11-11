// SPDX-License-Identifier: MIT
/** apps/core/test/llm/moteur-frais.ts — modules du moteur rechargés à neuf (caches du process vides), réglages posés, clients fermés après. */
import { vi } from "vitest";

import type { Reglages } from "@elpis/config";

/** Graphe du moteur importé à neuf, `config` surchargée avant tout usage. */
export async function moteurFrais(reglages: Partial<Reglages> = {}) {
  vi.resetModules();
  const config = await import("@elpis/config");
  config.surchargerConfig(reglages);
  const client = await import("../../src/llm/client-http");
  const http = await import("../../src/llm/llama-http");
  const ports = await import("../../src/llm/ports");
  const cible = await import("../../src/llm/cible");
  const moteurs = await import("../../src/llm/moteurs");
  const constantes = await import("../../src/llm/constantes");
  const caps = await import("../../src/llm/fournisseurs/llama-capacites");
  const sante = await import("../../src/llm/sante");
  const modeles = await import("../../src/llm/modeles");
  const fenetre = await import("../../src/llm/fenetre-contexte");
  const cycle = await import("../../src/llm/cycle-modeles");
  const capacites = await import("../../src/llm/capacites");
  const vision = await import("../../src/llm/vision");
  const inventaire = await import("../../src/llm/fournisseurs/llama-modeles");
  const flux = await import("../../src/llm/fournisseurs/llama-flux");
  const cacheModeles = await import("../../src/llm/cache-modeles");
  const parametres = await import("../../src/llm/parametres");
  const reprises = await import("../../src/llm/reprises");
  const tokens = await import("../../src/contexte/tokens");
  const raisonnement = await import("../../src/llm/jetons-raisonnement");
  const infill = await import("../../src/llm/infill");
  const llamacpp = await import("../../src/llm/fournisseurs/llamacpp");
  const openai = await import("../../src/llm/fournisseurs/openai-compat");
  const anthropic = await import("../../src/llm/fournisseurs/anthropic");
  const decouverte = await import("../../src/llm/fournisseurs/decouverte");
  return {
    config,
    client,
    http,
    ports,
    cible,
    moteurs,
    constantes,
    caps,
    sante,
    modeles,
    fenetre,
    cycle,
    capacites,
    vision,
    inventaire,
    flux,
    cacheModeles,
    parametres,
    reprises,
    tokens,
    raisonnement,
    infill,
    llamacpp,
    openai,
    anthropic,
    decouverte,
    /** Ferme les clients partagés et la sonde des modèles (fin de test). */
    async fermer(): Promise<void> {
      cacheModeles.arreterSondeModeles();
      await client.closeLlmClient();
      await http.closeAdminClient();
    },
  };
}

export type Moteur = Awaited<ReturnType<typeof moteurFrais>>;

/** `LLAMA_URL` d'un faux llama-server. */
export function urlLlama(base: string): Partial<Reglages> {
  return { LLAMA_URL: `${base}/v1/chat/completions` };
}
