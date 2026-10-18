// SPDX-License-Identifier: MIT
/** packages/mcp/src/registre-local.ts — registre déprécié des serveurs MCP locaux (`mcp.local_servers`), façade vers le manifeste. */
import { strPy, stripPy, veritePy } from "@elpis/commun";
import { builtinLocalMcp, config } from "@elpis/config";

import { load, serviceUpstream as serviceUpstreamManifeste } from "./manifeste";
import { estDict, lire, poser, texteNet } from "./outils";
import type { Dict } from "./outils";

const TRANSPORTS_RESEAU = ["sse", "streamable-http"];
const TRANSPORTS_VALIDES = ["stdio", "sse", "streamable-http"];

function normaliserTransport(raw: unknown): string {
  const t = texteNet(raw).toLowerCase();
  if (["http", "streamable_http", "streamablehttp"].includes(t)) return "streamable-http";
  return TRANSPORTS_VALIDES.includes(t) ? t : "stdio";
}

/** Descripteur brut → forme normalisée, ou `null` s'il est inexploitable. */
function normaliser(name: string, raw: unknown): Dict | null {
  if (!estDict(raw)) return null;
  const d: Dict = { ...raw };
  poser(d, "name", name);
  poser(d, "transport", normaliserTransport(lire(d, "transport")));
  poser(d, "builtin", veritePy(lire(d, "builtin")));
  poser(d, "expose_opencode", veritePy(lire(d, "expose_opencode")));
  if (TRANSPORTS_RESEAU.includes(d["transport"] as string)) {
    if (!texteNet(lire(d, "url")) && !d["builtin"]) return null;
  } else if (!texteNet(lire(d, "command")) && !d["builtin"]) return null;
  return d;
}

function integre(): Dict {
  const d: Dict = { ...builtinLocalMcp() };
  poser(d, "name", "local-tools");
  poser(d, "transport", normaliserTransport(lire(d, "transport")));
  poser(d, "builtin", true);
  if (!Object.hasOwn(d, "expose_opencode")) poser(d, "expose_opencode", true);
  poser(d, "expose_opencode", veritePy(d["expose_opencode"]));
  return d;
}

/** Serveurs MCP locaux déclarés, nom → descripteur : « local-tools » toujours présent, les autres noms s'ajoutent. */
export function localServers(): Record<string, Dict> {
  const out: Record<string, Dict> = { "local-tools": integre() };
  const raw: unknown = config.LOCAL_MCP_SERVERS_RAW;
  if (estDict(raw)) {
    for (const [name, spec] of Object.entries(raw)) {
      if (!stripPy(name) || name === "local-tools") continue;
      const norm = normaliser(stripPy(name), spec);
      if (norm !== null) poser(out, stripPy(name), norm);
    }
  }
  return out;
}

/** `(url, jeton)` du service intégré pour le relais `/api/mcp-bridge` (source unique : le manifeste). */
export function serviceUpstream(): [string | null, string] {
  return serviceUpstreamManifeste();
}

/** Serveurs externes du manifeste publiés à opencode (`opencode.publish`) avec une URL réseau. */
export function opencodeLocalServers(): Dict[] {
  const out: Dict[] = [];
  for (const e of load().externals()) {
    if (!(e.opencode_publish && e.isNetwork)) continue;
    out.push({
      name: e.name,
      transport: e.type === "sse" ? "sse" : "streamable-http",
      url: e.url,
      headers: { ...e.headers },
      enabled: e.enabled,
      description: e.description,
      expose_opencode: true,
      builtin: false,
    });
  }
  return out;
}

/** Descripteur local réseau → entrée `opencode.json` (`type: remote`). */
export function opencodeEntryFor(d: Dict): Dict {
  const entry: Dict = {
    type: "remote",
    url: texteNet(lire(d, "url")),
    enabled: veritePy(Object.hasOwn(d, "enabled") ? d["enabled"] : true),
  };
  const hdrs = lire(d, "headers");
  if (estDict(hdrs) && Object.keys(hdrs).length > 0) {
    const h: Dict = {};
    for (const [k, v] of Object.entries(hdrs)) poser(h, k, strPy(v));
    entry["headers"] = h;
  }
  return entry;
}
