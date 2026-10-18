// SPDX-License-Identifier: MIT
/** apps/core/src/outils/ports.ts — dépendances des outils pas encore portées (manifeste `mcp.json`) : interfaces et pose. */
import { ErreurPortAbsent } from "../llm/ports";

/** `shared_infra.mcp.manifest.load()` tel que le registre des catégories l'appelle. */
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
