// SPDX-License-Identifier: MIT
/** apps/toolhost/src/elpis-tools.ts — elpis-tools (`server/local_mcp_server.py`) lancé par l'hôte sur ses familles relayées, dans l'environnement de toolhost.json (`appliquerEnvironnement`, comme `python -m toolhost`) : service HTTP en loopback (`--elpis-tools`) ou stdio hérité (`--stdio`). */
import { spawn } from "node:child_process";
import { constants } from "node:os";
import path from "node:path";

import { racineDepot, rechargerConfig } from "@elpis/config";
import { interpreteurPython } from "@elpis/mcp";

import { fermerBaseHote, ouvrirBaseHote } from "./base-hote";
import { appliquerEnvironnement } from "./config";
import type { ToolhostConfig } from "./config";
import { journal as fabriqueJournal } from "./journal";
import type { Journal } from "./journal";
import { repartirFamilles } from "./mcp/natives";
import { FABRIQUES_NATIVES } from "./mcp/registre";

const SIGNAUX: readonly NodeJS.Signals[] = ["SIGTERM", "SIGINT", "SIGHUP"];
const PORT_ELPIS_TOOLS = "8767";

/** elpis-tools sur `familles` : base de l'hôte initialisée d'abord (le Python y crée ses tables AX, une base ainsi entamée serait refusée par l'hôte), environnement du process plus `env`, entrée et sortie héritées, signaux transmis ; rend son code de sortie. */
export async function lancerElpisTools(
  familles: readonly string[],
  env: Readonly<Record<string, string>>,
  journal: Journal,
): Promise<number> {
  await ouvrirBaseHote(fabriqueJournal);
  await fermerBaseHote();
  const enfant = spawn(interpreteurPython(), [path.join(racineDepot(), "server", "local_mcp_server.py")], {
    stdio: "inherit",
    env: { ...process.env, ...env, LOCAL_MCP_TOOL_FAMILIES: familles.join(",") },
  });
  const transmettre = (s: NodeJS.Signals): void => {
    enfant.kill(s);
  };
  for (const s of SIGNAUX) process.on(s, transmettre);
  return new Promise((fin) => {
    enfant.once("error", (e) => {
      journal.error(`elpis-tools non lancé (${e.message})`);
      fin(1);
    });
    enfant.once("exit", (code, signal) => {
      for (const s of SIGNAUX) process.off(s, transmettre);
      fin(code ?? (signal ? 128 + constants.signals[signal] : 1));
    });
  });
}

/** `--elpis-tools` : amont MCP de l'hôte en HTTP streamable sur 127.0.0.1:`ELPIS_TOOLS_PORT` (8767), familles relayées ; rien à relayer : sortie 0. */
export function servirElpisTools(tc: ToolhostConfig, journal: Journal): Promise<number> {
  const { relayees } = repartirFamilles(tc, FABRIQUES_NATIVES, journal);
  if (relayees.length === 0) {
    journal.info("elpis-tools : aucune famille relayée par l'hôte d'outils, rien à servir");
    return Promise.resolve(0);
  }
  appliquerEnvironnement(tc);
  rechargerConfig();
  return lancerElpisTools(
    relayees,
    {
      LOCAL_MCP_TRANSPORT: "streamable-http",
      LOCAL_MCP_HOST: "127.0.0.1",
      LOCAL_MCP_PORT: process.env["ELPIS_TOOLS_PORT"] || PORT_ELPIS_TOOLS,
    },
    journal,
  );
}
