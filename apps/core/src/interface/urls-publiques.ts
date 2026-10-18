// SPDX-License-Identifier: MIT
/** apps/core/src/interface/urls-publiques.ts — URL publiques de main et admin vues par le navigateur (`/api/public-config`, `/admin`). */
import { hostname, port, urlsplit, urlunsplit } from "@elpis/commun";

import type { ModeApp } from "../mode";

export type Process = ModeApp;

export interface RequetePublique {
  entete: (nom: string) => string | undefined;
  hoteClient: string | undefined;
  schema: string;
}

export interface Https {
  actif: boolean;
  ports: { main: number; admin: number };
  /** Le core n'écoute que la boucle locale : ses ports directs sont injoignables pour un client distant. */
  bouclage?: boolean;
}

const HOTES_LOCAUX = new Set(["localhost", "127.0.0.1", "0.0.0.0", "::1", "[::1]"]);

function strip(s: string, car: string): string {
  let debut = 0;
  let fin = s.length;
  while (debut < fin && car.includes(s.charAt(debut))) debut++;
  while (fin > debut && car.includes(s.charAt(fin - 1))) fin--;
  return s.slice(debut, fin);
}

/** URL d'environnement en localhost : l'hôte devient celui du client, ou "" si on ne sait pas lequel. */
export function reecrireUrlLocale(envUrl: string, req: RequetePublique): string {
  if (!envUrl) return envUrl;
  try {
    const u = urlsplit(envUrl);
    if (!HOTES_LOCAUX.has((hostname(u) ?? "").toLowerCase())) return envUrl;
    const candidats: string[] = [];
    const xfh = req.entete("x-forwarded-host") ?? "";
    if (xfh) candidats.push((xfh.split(",")[0] ?? "").trim());
    const host = req.entete("host") ?? "";
    if (host) candidats.push(host.trim());
    if (req.hoteClient) candidats.push(req.hoteClient);
    let hoteClient = "";
    for (const c of candidats) {
      const h = c.startsWith("[") ? (c.split("]")[0] ?? "") + "]" : (c.split(":")[0] ?? "");
      if (h && !HOTES_LOCAUX.has(strip(h.toLowerCase(), "[]"))) {
        hoteClient = h;
        break;
      }
    }
    if (!hoteClient) return "";
    const p = port(u);
    return urlunsplit({ ...u, netloc: p !== null ? `${hoteClient}:${p}` : hoteClient });
  } catch {
    return "";
  }
}

export function schemaRequete(req: RequetePublique): string {
  const proto = ((req.entete("x-forwarded-proto") ?? "").split(",")[0] ?? "").trim().toLowerCase();
  if (proto === "http" || proto === "https") return proto;
  const s = req.schema.toLowerCase();
  return s === "http" || s === "https" ? s : "http";
}

function hotePublic(req: RequetePublique): string {
  const fwd = ((req.entete("x-forwarded-host") ?? "").split(",")[0] ?? "").trim();
  return fwd || req.entete("host") || "";
}

/** `hôte:port` d'un en-tête Host (IPv6 entre crochets) ; port vide s'il n'y en a pas. */
export function decouperHotePort(hote: string): [string, string] {
  if (!hote) return ["", ""];
  if (hote.startsWith("[")) {
    const fin = hote.indexOf("]");
    if (fin < 0) return [hote, ""];
    const reste = hote.slice(fin + 1);
    return [hote.slice(0, fin + 1), reste.startsWith(":") ? reste.slice(1) : ""];
  }
  const i = hote.lastIndexOf(":");
  return i >= 0 ? [hote.slice(0, i), hote.slice(i + 1)] : [hote, ""];
}

/** URL publique de l'autre process déduite de la requête (ports 8001/8002 ou ports HTTPS de Caddy). */
export function synthetiserUrlPublique(req: RequetePublique, cible: Process, https: Https): string {
  const hoteEntete = hotePublic(req);
  if (!hoteEntete) return "";
  const [hote, p] = decouperHotePort(hoteEntete);
  const schema = schemaRequete(req);
  const chemin = cible === "main" ? "/" : "/admin";
  if (https.actif) {
    const portCible = https.ports[cible];
    return `https://${portCible === 443 ? hote : `${hote}:${portCible}`}${chemin}`;
  }
  if (cible === "main") {
    if (p === "8002") return `${schema}://${hote}:8001/`;
    if (p === "8001") return `${schema}://${hoteEntete}/`;
  } else {
    if (p === "8001") return `${schema}://${hote}:8002/admin`;
    if (p === "8002") return `${schema}://${hoteEntete}/admin`;
  }
  return `${schema}://${hoteEntete}${chemin}`;
}

/** Variable d'environnement, puis réécriture du localhost, puis synthèse depuis la requête. */
export function resoudreUrlPublique(
  envUrl: string,
  req: RequetePublique,
  cible: Process,
  https: Https,
): string {
  if (https.actif) return synthetiserUrlPublique(req, cible, https);
  const reecrite = reecrireUrlLocale(envUrl, req);
  // Écart voulu au Python : derrière un frontal HTTPS d'un core en boucle locale, sans URL publique explicite, les ports du frontal.
  if (https.bouclage && schemaRequete(req) === "https" && (!envUrl || reecrite !== envUrl))
    return synthetiserUrlPublique(req, cible, { ...https, actif: true });
  return reecrite || synthetiserUrlPublique(req, cible, https);
}
