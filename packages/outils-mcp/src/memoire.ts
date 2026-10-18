// SPDX-License-Identifier: MIT
/** packages/outils-mcp/src/memoire.ts — service MCP en processus : paire de transports en mémoire (`InMemoryTransport`), sans saut réseau. */
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

import type { JetonAcces } from "./contexte";
import type { ServeurOutils } from "./serveur";

export interface ConnexionEnMemoire {
  /** Côté client, à donner à un `Client` du SDK. */
  readonly transport: Transport;
  fermer(): Promise<void>;
}

/** Session en mémoire : portée `famille` (toutes si `null`), jeton imposé (`null` : client de confiance, identité par `_meta`). */
export async function ouvrirEnMemoire(
  serveur: ServeurOutils,
  o: { famille?: string | null; jeton?: JetonAcces | null } = {},
): Promise<ConnexionEnMemoire> {
  const [client, cote] = InMemoryTransport.createLinkedPair();
  const s = await serveur.connecter(cote, {
    famille: o.famille ?? null,
    niveau: null,
    jetonDefaut: o.jeton ?? null,
  });
  return {
    transport: client,
    fermer: async () => {
      await client.close();
      await s.close();
    },
  };
}
