// SPDX-License-Identifier: MIT
/** apps/core/src/admin/securite.ts — mode HTTPS, écoute et redémarrage vus de la console (admin/security.py). */
import { connect } from "node:net";

import { estDict, ErreurPython, getPy, intPy, nomTypePy, poserCle, stripPy, veritePy } from "@elpis/commun";
import type { Dict } from "@elpis/commun";
import type { FastifyRequest } from "fastify";

import { hotePourConfig } from "../ecoute";
import { decouperHotePort } from "../interface/urls-publiques";
import type { Journal } from "../journal";

const SONDE_MS = 1_500;
const DELAI_RECHARGEMENT_S = 5;

/** Ce que porte le lot du cycle de vie (B1-34) : redémarrage de main et rechargement de ce process. */
export interface PortCycleVie {
  /** POST `/api/admin/internal/restart-self` de main en boucle locale : vrai si main a répondu 200. */
  redemarrerMain(): Promise<boolean>;
  /** `schedule_self_reload` : rechargement de ce process après `delaiS` secondes. */
  programmerRechargement(delaiS: number): void;
}

export interface DependancesRedemarrage {
  readonly journal: Journal;
  readonly diffuser: (message: Dict) => Promise<unknown>;
  readonly cycleVie?: PortCycleVie;
  readonly maintenant: () => number;
}

/** `cfg.setdefault(cle, {})` suivi d'une méthode de dict : AttributeError (500) si la valeur gardée n'est pas un dict. */
export function sectionDict(parent: Dict, cle: string): Dict {
  if (!Object.hasOwn(parent, cle)) poserCle(parent, cle, {});
  const v = parent[cle];
  if (!estDict(v))
    throw new ErreurPython("AttributeError", `'${nomTypePy(v)}' object has no attribute 'setdefault'`);
  return v;
}

/** `(d.get(cle) or {})` puis `.get` : AttributeError si la valeur vraie n'est pas un dict. */
export function sousDict(d: unknown, cle: string): unknown {
  const v = getPy(d, cle, null);
  return veritePy(v) ? v : {};
}

/** `_https_cfg_ports` : ports du frontal Caddy, défauts du Caddyfile si une valeur ne se lit pas. */
export function portsHttps(cfg: Dict): Dict {
  const https = sousDict(sousDict(cfg, "security"), "https");
  try {
    return {
      main: intPy(getPy(https, "main_port", 443)),
      admin: intPy(getPy(https, "admin_port", 8443)),
      rag: intPy(getPy(https, "rag_port", 8444)),
    };
  } catch {
    return { main: 443, admin: 8443, rag: 8444 };
  }
}

export function httpsActif(cfg: Dict): boolean {
  return veritePy(getPy(sousDict(sousDict(cfg, "security"), "https"), "enabled", false));
}

/** `_bind_host` : hôte d'écoute que la config donnerait ; illisible = boucle locale. */
export function hoteDEcoute(cfg: Dict): string {
  try {
    return hotePourConfig(cfg);
  } catch {
    return "127.0.0.1";
  }
}

/** `_listen_mode` : « lan » ou « local » hors HTTPS, clé absente = « lan ». */
export function modeEcoute(cfg: Dict): string {
  const sec = sousDict(cfg, "security");
  return hoteDEcoute({ security: { listen: getPy(sec, "listen", null) } }) === "0.0.0.0" ? "lan" : "local";
}

/** `_public_host` : hôte (sans port) par lequel le client nous joint, X-Forwarded-Host d'abord. */
export function hotePublicDe(requete: FastifyRequest): string {
  const premier = (nom: string): string => {
    const v = requete.headers[nom];
    return (Array.isArray(v) ? v[0] : v) ?? "";
  };
  const fwd = stripPy(premier("x-forwarded-host").split(",")[0] ?? "");
  return decouperHotePort(fwd || premier("host"))[0] || "127.0.0.1";
}

/** `_https_urls` : adresses d'accès après bascule (443 implicite). */
export function urlsHttps(hote: string, actif: boolean, ports: Dict): Dict {
  if (actif) {
    const main = ports["main"] === 443 ? `https://${hote}/` : `https://${hote}:${String(ports["main"])}/`;
    return { main, admin: `https://${hote}:${String(ports["admin"])}/admin` };
  }
  return { main: `http://${hote}:8001/`, admin: `http://${hote}:8002/admin` };
}

/** `_caddy_listening` : quelque chose écoute-t-il sur `hote:port` (1,5 s) ; `APP_HTTPS_CHECK_SKIP=1` court-circuite. */
export function caddyEcoute(port: number, hote = "127.0.0.1"): Promise<boolean> {
  if (process.env["APP_HTTPS_CHECK_SKIP"] === "1") return Promise.resolve(true);
  return new Promise((resolve) => {
    let so: ReturnType<typeof connect>;
    try {
      so = connect({ host: hote, port, timeout: SONDE_MS });
    } catch {
      resolve(false);
      return;
    }
    const fin = (ok: boolean): void => {
      so.destroy();
      resolve(ok);
    };
    so.once("connect", () => fin(true));
    so.once("timeout", () => fin(false));
    so.once("error", () => fin(false));
  });
}

/** `_restart_app` : fenêtre de maintenance diffusée, redémarrage de main puis rechargement de ce process ; faux si main n'a pas accusé, ou sans cycle de vie (rien n'est diffusé). */
export async function redemarrerApp(dep: DependancesRedemarrage, message: string): Promise<boolean> {
  if (!dep.cycleVie) {
    dep.journal.warn("[security/https] cycle de vie non branché : redémarrage à faire à la main");
    return false;
  }
  try {
    await dep.diffuser({ type: "restart", message, started_at: dep.maintenant() });
  } catch (e) {
    dep.journal.warn(`[security/https] file broadcast failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  let ok: boolean;
  try {
    ok = await dep.cycleVie.redemarrerMain();
  } catch (e) {
    ok = false;
    dep.journal.warn(
      `[security/https] restart-self call failed: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  dep.cycleVie.programmerRechargement(DELAI_RECHARGEMENT_S);
  return ok;
}
