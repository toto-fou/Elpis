// SPDX-License-Identifier: MIT
/** packages/bac/src/montages.ts — montages de l'agent et du relais Git dans le conteneur (agent_client.py), communs à l'hôte et aux services Python. */
import { createHash } from "node:crypto";

import { pyJoin, racineDepot, realpathPy } from "@elpis/config";

/** `AGENT_DIR` monté en lecture seule. */
export const AGENT_MOUNT = "/opt/elpis/agent";
/** `<P>/.elpis-agent`, monté sur `/run/elpis`. */
export const AGENT_RUN_DIR = ".elpis-agent";
export const AGENT_SOCKET = "/run/elpis/agent.sock";
/** `<SANDBOX_DIR>/.elpis-relay` : sockets du relais Git de l'hôte. */
export const RELAY_DIR = ".elpis-relay";
/** `RELAIS_DOSSIER` de agent/server.py. */
export const RELAY_MOUNT = "/run/elpis-relay";

/** Surcharge de test du dossier de l'agent (`null` : celui du dépôt). */
export const reglagesMontages: { agentDir: string | null } = { agentDir: null };

/** `AGENT_DIR` : dossier résolu de `shared_infra/sandbox/agent`, même chaîne que le Python (étiquette `elpis.agent`). */
export function agentDir(): string {
  return reglagesMontages.agentDir ?? realpathPy(pyJoin(racineDepot(), "shared_infra/sandbox/agent"));
}

/** `_AGENT_EMPREINTE` : 12 hex du SHA-256 du chemin de l'agent ; le changer fait recréer les conteneurs. */
export function agentEmpreinte(): string {
  return createHash("sha256").update(agentDir(), "utf8").digest("hex").slice(0, 12);
}
