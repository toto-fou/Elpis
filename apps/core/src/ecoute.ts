// SPDX-License-Identifier: MIT
/** apps/core/src/ecoute.ts — adresse d'écoute d'un process du core. */
import { existsSync, readFileSync } from "node:fs";

import { stripPy, strPy, veritePy } from "@elpis/commun";
import { parseJsonPy } from "@elpis/config";

import type { Journal } from "./journal";
import type { ModeApp } from "./mode";

const PORTS: Readonly<Record<ModeApp, number>> = { main: 8001, admin: 8002 };

/** Règle de `_bind_host.host_for` : HTTPS → boucle locale ; `listen` absent → 0.0.0.0 ; « lan » → 0.0.0.0, sinon boucle locale. */
export function hotePourConfig(cfg: Record<string, unknown>): string {
  const brut = cfg["security"];
  const securite = veritePy(brut) ? brut : {};
  if (securite === null || typeof securite !== "object" || Array.isArray(securite)) {
    throw new TypeError("section security illisible");
  }
  const s = securite as Record<string, unknown>;
  const https = veritePy(s["https"]) ? s["https"] : {};
  if (https === null || typeof https !== "object" || Array.isArray(https))
    throw new TypeError("section https illisible");
  if (veritePy((https as Record<string, unknown>)["enabled"] ?? false)) return "127.0.0.1";
  const listen = s["listen"];
  if (listen === undefined || listen === null) return "0.0.0.0";
  return stripPy(strPy(listen)).toLowerCase() === "lan" ? "0.0.0.0" : "127.0.0.1";
}

/** Hôte par défaut selon `config.json` : absent ou illisible → boucle locale (prudence), `BIND` reste le recours. */
export function hoteParDefaut(cheminConfig: string, journal?: Journal): string {
  if (!existsSync(cheminConfig)) return "127.0.0.1";
  try {
    const cfg = parseJsonPy(readFileSync(cheminConfig, "utf-8"));
    if (cfg === null || typeof cfg !== "object" || Array.isArray(cfg))
      throw new TypeError("config.json n'est pas un objet");
    return hotePourConfig(cfg as Record<string, unknown>);
  } catch (e) {
    journal?.warn(
      `config.json illisible (${cheminConfig}: ${String(e)}) : écoute sur 127.0.0.1 par prudence. BIND=0.0.0.0:<port> pour forcer.`,
    );
    return "127.0.0.1";
  }
}

/** `BIND` = `hôte:port` (IPv6 entre crochets) ; par défaut l'hôte de la config et le port du mode. */
export function adresseEcoute(
  bind: string | undefined,
  mode: ModeApp,
  hoteDefaut = "127.0.0.1",
): { hote: string; port: number } {
  const brut = (bind ?? "").trim();
  if (!brut) return { hote: hoteDefaut, port: PORTS[mode] };
  const i = brut.lastIndexOf(":");
  const hote = (i > 0 ? brut.slice(0, i) : "127.0.0.1").replace(/^\[(.*)\]$/, "$1");
  const port = Number(i >= 0 ? brut.slice(i + 1) : brut);
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) throw new Error(`BIND invalide : ${brut}`);
  return { hote, port };
}
