// SPDX-License-Identifier: MIT
/** packages/mcp/src/origines.ts — contrôle de l'en-tête `Origin` des requêtes MCP (anti DNS rebinding), règle commune au relais et au service d'outils. */
import { strPy, stripPy } from "@elpis/commun";
import { liveConfigValue } from "@elpis/config";

import { isdigitPy } from "./outils";

function normaliser(origin: unknown): string {
  return stripPy(strPy(origin ?? "") || "")
    .replace(/\/+$/, "")
    .toLowerCase();
}

/** Texte « a, b » ou liste → éléments non vides (`str(x).strip()`). */
function enListe(v: unknown): string[] {
  if (typeof v === "string")
    return v
      .split(",")
      .map((x) => stripPy(x))
      .filter((x) => x !== "");
  if (Array.isArray(v) || v instanceof Set)
    return [...v].map((x) => stripPy(strPy(x))).filter((x) => x !== "");
  return [];
}

/** Origines autorisées : `mcp.allowed_origins` et `app.cors_origins` (relus à chaud) + `LOCAL_MCP_ALLOWED_ORIGINS`. */
export function allowedOrigins(): Set<string> {
  const out = new Set<string>();
  try {
    for (const o of enListe(liveConfigValue("mcp.allowed_origins", []))) out.add(normaliser(o));
    for (const o of enListe(liveConfigValue("app.cors_origins", []))) out.add(normaliser(o));
  } catch {
    // config illisible : seules les origines de l'environnement comptent
  }
  for (const o of enListe(process.env["LOCAL_MCP_ALLOWED_ORIGINS"] ?? "")) out.add(normaliser(o));
  out.delete("");
  out.delete("null");
  return out;
}

function correspond(origin: string, motifs: Set<string>): boolean {
  if (motifs.has(origin)) return true;
  for (const p of motifs) {
    if (!p.endsWith(":*")) continue;
    const base = p.slice(0, -2);
    if (origin.startsWith(base + ":") && isdigitPy(origin.slice(base.length + 1))) return true;
  }
  return false;
}

/** `true` si la requête peut passer au vu de son `Origin` : absent = client natif accepté ; `null` jamais autorisé. */
export function originAllowed(origin: string | null | undefined): boolean {
  if (origin === null || origin === undefined || stripPy(origin) === "") return true;
  const o = normaliser(origin);
  if (o === "null" || !o.includes("://")) return false;
  return correspond(o, allowedOrigins());
}
