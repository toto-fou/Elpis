// SPDX-License-Identifier: MIT
/** apps/toolhost/src/manifeste.ts — auto-description de l'hôte (`endpoints_view`, `export_mcp_servers` de toolhost/app.py) : comment joindre chaque famille depuis un applicatif tiers. */
import { lowerPy, rstripPy, stripPy } from "@elpis/commun";
import type { Dict } from "@elpis/commun";

import { HTTP_MOUNT_PATH, SSE_MOUNT_PATH } from "./porte";

export interface CommandeStdio {
  readonly command: string;
  readonly args: readonly string[];
}

export interface VueHote {
  readonly host: string;
  readonly port: number;
  /** Transports réseau servis (`http`, `sse`). */
  readonly transports: readonly string[];
  /** Transports d'une famille (native ou relayée) ; défaut : `transports`. */
  readonly transportsDe?: (famille: string) => readonly string[];
  /** Familles vivantes, ordre canonique. */
  readonly familles: readonly string[];
  /** Point d'entrée stdio d'une famille (`main.mjs --stdio --families <f>` ; `sys.executable -m toolhost --stdio …` en Python). */
  readonly stdio: (famille: string) => CommandeStdio;
}

/** `endpoints_view` : `{famille: {http, sse, stdio}}` ; `base_url` = origine publique de l'hôte, sinon celle du bind. */
export function endpointsView(vue: VueHote, baseUrl = ""): Dict {
  const base = rstripPy(baseUrl || `http://${vue.host}:${vue.port}`, "/");
  const out: Dict = {};
  for (const fam of vue.familles) {
    const ligne: Dict = {};
    const transports = vue.transportsDe?.(fam) ?? vue.transports;
    if (transports.includes("http")) ligne["http"] = `${base}${HTTP_MOUNT_PATH}/${fam}`;
    if (transports.includes("sse")) ligne["sse"] = `${base}${SSE_MOUNT_PATH}/${fam}`;
    const st = vue.stdio(fam);
    ligne["stdio"] = { command: st.command, args: [...st.args] };
    out[fam] = ligne;
  }
  return out;
}

/** `export_mcp_servers` : bloc `mcpServers` prêt à coller dans un autre applicatif ; le jeton n'y figure jamais. */
export function exportMcpServers(vue: VueHote, transport = "http", baseUrl = "", prefix = "elpis-"): Dict {
  let t = lowerPy(stripPy(transport || "http"));
  if (["streamable-http", "streamable_http", "remote"].includes(t)) t = "http";
  const servers: Dict = {};
  for (const [fam, eps] of Object.entries(endpointsView(vue, baseUrl)) as [string, Dict][]) {
    const nom = `${prefix}${fam.replaceAll("_", "-")}`;
    if (t === "stdio") {
      const st = eps["stdio"] as { command: string; args: string[] };
      servers[nom] = {
        type: "stdio",
        command: st.command,
        args: [...st.args],
        env: { LOCAL_MCP_TRANSPORT: "stdio" },
      };
    } else if (Object.hasOwn(eps, t) && eps[t]) {
      servers[nom] = { type: t, url: eps[t], headers: { Authorization: "Bearer <jeton de service>" } };
    }
  }
  return { mcpServers: servers };
}
