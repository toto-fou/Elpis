// SPDX-License-Identifier: MIT
/** apps/core/src/relais/hotes.ts — hôtes d'outils déclarés dans mcp.json (`sandboxHosts`/`toolHosts`, `placement`) et hôte d'un compte. */
import { readFileSync, statSync } from "node:fs";

import { hostname, stripPy, urlsplit } from "@elpis/commun";
import { parseJsonPy } from "@elpis/config";
import { manifestPath, stripMcpPath, substitute } from "@elpis/mcp";

import { estDict, lire, texteOu } from "./dict";
import type { Spec } from "./dict";
import { hostForUser, placementOf } from "./placement";

export { manifestPath, stripMcpPath, substitute as substituer };

export interface SandboxHost {
  readonly id: string;
  readonly url: string;
  readonly token: string;
  readonly relay: boolean;
}

export interface HotesDeclares {
  readonly hotes: ReadonlyMap<string, Spec>;
  readonly placement: Spec;
}

const UTF8_STRICT = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const AUCUN: HotesDeclares = { hotes: new Map(), placement: {} };

function aUneEntreeToolhost(racine: Spec): boolean {
  const serveurs = lire(racine, Object.hasOwn(racine, "mcpServers") ? "mcpServers" : "servers");
  if (!estDict(serveurs)) return false;
  return Object.entries(serveurs).some(([nom, spec]) => {
    if (!stripPy(nom) || !estDict(spec)) return false;
    const xe = lire(spec, "x-elpis");
    return (
      stripPy(texteOu(estDict(xe) ? lire(xe, "role") : undefined, "external")).toLowerCase() === "toolhost"
    );
  });
}

const JETONS_JSON = /"(?:[^"\\]|\\.)*"|[{}[\]:,]|[^\s{}[\]:,"]+/gu;

/** Clés des objets `sandboxHosts`/`toolHosts` dans l'ordre du texte : un objet JS met les clés numériques en tête, un dict Python non. */
export function ordreDesHotes(texte: string): Map<string, string[]> {
  const jetons = texte.match(JETONS_JSON) ?? [];
  const ordre = new Map<string, string[]>();
  let i = 0;
  const valeur = (parent: string | null, profondeur: number): void => {
    const jeton = jetons[i++];
    if (jeton === "[") {
      while (i < jetons.length && jetons[i] !== "]") {
        valeur(null, profondeur + 1);
        if (jetons[i] === ",") i++;
      }
      i++;
    } else if (jeton === "{") {
      const cles: string[] = [];
      while (i < jetons.length && jetons[i] !== "}") {
        const cle = JSON.parse(jetons[i] ?? '""') as string;
        i += 2;
        if (!cles.includes(cle)) cles.push(cle);
        valeur(profondeur === 0 ? cle : null, profondeur + 1);
        if (jetons[i] === ",") i++;
      }
      i++;
      if (profondeur === 1 && parent !== null) ordre.set(parent, cles);
    }
  };
  try {
    valeur(null, 0);
  } catch {
    ordre.clear();
  }
  return ordre;
}

/** `_build` restreint aux hôtes : fusion `sandboxHosts` puis `toolHosts`, surcharges `LOCAL_MCP_URL`/`LOCAL_MCP_TOKEN` sur l'hôte par défaut. */
function construire(brut: Spec, texte: string): HotesDeclares {
  const racine = substitute(brut) as Spec;
  const ordre = ordreDesHotes(texte);
  const hotes = new Map<string, Spec>();
  for (const cle of ["sandboxHosts", "toolHosts"]) {
    const declares = lire(racine, cle);
    if (!estDict(declares)) continue;
    const ids = ordre.get(cle)?.filter((id) => Object.hasOwn(declares, id)) ?? Object.keys(declares);
    for (const id of ids) {
      const spec = declares[id];
      if (!estDict(spec)) continue;
      const fusion = hotes.get(id) ?? (Object.create(null) as Spec);
      for (const [k, v] of Object.entries(spec)) fusion[k] = v;
      hotes.set(id, fusion);
    }
  }
  const pl = lire(racine, "placement");
  const placement: Spec = estDict(pl) ? pl : {};
  let defaut = "";
  for (const cle of [texteOu(lire(placement, "host"), ""), "main"]) {
    if (cle && hotes.has(cle)) {
      defaut = cle;
      break;
    }
  }
  if (!defaut) defaut = hotes.keys().next().value ?? "";
  const url = stripPy(process.env["LOCAL_MCP_URL"] ?? "");
  if (url && aUneEntreeToolhost(racine)) {
    const origine = stripMcpPath(url);
    const hote = hotes.get(defaut);
    if (hote) hote["url"] = origine;
  }
  const jeton = stripPy(process.env["LOCAL_MCP_TOKEN"] ?? "");
  const hote = hotes.get(defaut);
  if (jeton && hote) hote["token"] = jeton;
  return { hotes, placement };
}

let memoire: { cle: string; declares: HotesDeclares } | undefined;

/** Hôtes du manifeste, cache invalidé par le mtime ; fichier absent ou illisible : aucun hôte (lève si une surcharge est invalide). */
export function lireHotes(): HotesDeclares {
  const chemin = manifestPath();
  let mtime: number;
  try {
    const s = statSync(chemin);
    mtime = s.isFile() ? s.mtimeMs : 0;
  } catch {
    return AUCUN;
  }
  if (mtime <= 0) return AUCUN;
  const cle = `${chemin}\0${mtime}`;
  if (memoire?.cle === cle) return memoire.declares;
  let texte = "";
  let brut: unknown;
  try {
    texte = UTF8_STRICT.decode(readFileSync(chemin));
    brut = parseJsonPy(texte);
  } catch {
    brut = null;
  }
  const declares = estDict(brut) ? construire(brut, texte) : AUCUN;
  memoire = { cle, declares };
  return declares;
}

/** Oublie le manifeste en cache (relecture forcée). */
export function oublierHotes(): void {
  memoire = undefined;
}

/** `_is_loopback` : hôte vide, illisible, `localhost`, `127.0.0.1` ou `::1`. */
export function isLoopback(url: string): boolean {
  let hote: string;
  try {
    hote = (hostname(urlsplit(url)) ?? "").toLowerCase();
  } catch {
    return true;
  }
  return hote === "127.0.0.1" || hote === "localhost" || hote === "::1" || hote === "";
}

/** `host_from_spec` : `relay` explicite, sinon actif hors loopback ; `null` sans URL. */
export function hostFromSpec(id: string, spec: Spec): SandboxHost | null {
  const url = stripPy(texteOu(lire(spec, "url"), ""));
  if (!url) return null;
  const relay = lire(spec, "relay");
  return {
    id,
    url: url.replace(/\/+$/u, ""),
    token: texteOu(lire(spec, "token"), ""),
    relay: typeof relay === "boolean" ? relay : !isLoopback(url),
  };
}

/** `sandbox_host_for` : hôte du placement, `by_user` par la table (affectation enregistrée au premier passage, sauf `affecter` faux), sinon le premier déclaré. */
export async function sandboxHostFor(uid: number | null, affecter = true): Promise<SandboxHost | null> {
  let declares: HotesDeclares;
  try {
    declares = lireHotes();
  } catch {
    return null;
  }
  const { hotes, placement } = declares;
  if (hotes.size === 0) return null;
  let id = texteOu(lire(placement, "host"), "");
  if (texteOu(lire(placement, "strategy"), "single") === "by_user" && uid) {
    try {
      id = (affecter ? await hostForUser(uid, hotes, id) : await placementOf(uid)) || id;
    } catch {
      // placement illisible : hôte par défaut
    }
  }
  if (!id || !hotes.has(id)) id = hotes.keys().next().value ?? "";
  return hostFromSpec(id, hotes.get(id) ?? {});
}
