// SPDX-License-Identifier: MIT
/** apps/core/src/interface/statiques.ts — `/static/*` : fichiers de `frontend/`, build Vite haché et URL à la version du fichier immuables, autres JS/CSS/HTML revalidés, texte compressé (brotli, gzip). */
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import type { Stats } from "node:fs";
import { extname, relative, sep } from "node:path";

import { send } from "@fastify/send";
import type { FileSendResult } from "@fastify/send";
import type { FastifyReply, FastifyRequest } from "fastify";
import { HttpError } from "@elpis/commun";

import { COMPRESSIBLE, VariantesEnMemoire, encodageAccepte } from "./compression";
import type { Encodage } from "./compression";

const TYPES: Readonly<Record<string, string>> = {
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".cjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/vnd.microsoft.icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".eot": "application/vnd.ms-fontobject",
  ".json": "application/json",
  ".wasm": "application/wasm",
  ".gif": "image/gif",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".xml": "application/xml",
  ".webmanifest": "application/manifest+json",
  ".mp3": "audio/mpeg",
  ".mp4": "video/mp4",
  ".pdf": "application/pdf",
  ".zip": "application/zip",
  ".tar": "application/x-tar",
  ".yaml": "application/yaml",
  ".yml": "application/yaml",
  ".csv": "text/csv; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".ogg": "audio/ogg",
  ".webm": "video/webm",
  ".svgz": "image/svg+xml",
  ".ts": "text/vnd.trolltech.linguist; charset=utf-8",
  ".tiff": "image/tiff",
  ".wav": "audio/x-wav",
  ".otc": "font/collection",
  ".ttc": "font/collection",
};

/** Sources et outillage du workspace `@elpis/web`, et manifeste du build : jamais servis. */
const NON_SERVIS = /^(?:src\/|test\/|node_modules\/|dist\/\.vite\/|[^/]+\.(?:ts|mts|json)$)/;

const ENCODAGES = new Set([".gz", ".z", ".bz2", ".xz", ".br"]);

/** Type de `mimetypes` (Python 3.13, ajouts de server/app.py ; `x.js.gz` prend le type intérieur), charset sur les `text/*`. */
export function typeStatique(chemin: string): string {
  let ext = extname(chemin).toLowerCase();
  if (ENCODAGES.has(ext)) ext = extname(chemin.slice(0, -ext.length)).toLowerCase();
  return TYPES[ext] ?? "text/plain; charset=utf-8";
}

/** Version d'un fichier (`?v=` des pages) : change avec sa date de modification ou sa taille, donc à chaque mise à jour. */
export function empreinteFichier(st: Pick<Stats, "mtimeMs" | "size">): string {
  return createHash("sha256").update(`${st.mtimeMs}:${st.size}`).digest("hex").slice(0, 10);
}

/** Build Vite haché et URL à la version du fichier : immuables ; tout autre JS/CSS/HTML revalidé à chaque visite. */
export function cacheStatique(
  chemin: string,
  version: string | null,
  st: Pick<Stats, "mtimeMs" | "size">,
): string | undefined {
  if (chemin.startsWith("dist/assets/") || (version !== null && version === empreinteFichier(st)))
    return "public, max-age=31536000, immutable";
  return /\.(?:js|css|html|mjs)$/.test(chemin) ? "no-cache, must-revalidate" : undefined;
}

const SUFFIXES: Readonly<Record<Encodage, string>> = { br: ".br", gzip: ".gz" };

/** En-têtes du fichier servi : type, règle de cache, `Vary` d'un type compressible et encodage de la variante. */
function repondre(
  reponse: FastifyReply,
  r: FileSendResult,
  chemin: string,
  version: string | null,
  encodage: Encodage | null,
  corps?: Buffer,
): FastifyReply {
  const entetes: Record<string, string> = {};
  for (const [nom, valeur] of Object.entries(r.headers)) entetes[nom.toLowerCase()] = String(valeur);
  if (r.statusCode !== 304) entetes["content-type"] = typeStatique(chemin);
  const cache = cacheStatique(chemin, version, r.metadata.stat);
  if (cache) entetes["cache-control"] = cache;
  if (COMPRESSIBLE.test(chemin)) entetes["vary"] = "Accept-Encoding";
  if (encodage !== null && r.statusCode === 200) {
    entetes["content-encoding"] = encodage;
    delete entetes["accept-ranges"];
    if (corps) entetes["content-length"] = String(corps.length);
  }
  return reponse
    .code(r.statusCode)
    .headers(entetes)
    .send(corps ?? r.stream);
}

/** Le chemin brut (encodé) part à `send`, qui le décode une seule fois ; un lien qui sort de `frontend/` est refusé comme sous Starlette ; texte compressé selon `Accept-Encoding` (variante du build, sinon en mémoire), jamais une plage. */
export function servirStatique(frontend: string, prefixe = "/static") {
  const racineReelle = realpathSync(frontend);
  const variantes = new VariantesEnMemoire();
  const options = {
    root: frontend,
    index: false,
    dotfiles: "allow",
    cacheControl: false,
    contentType: false,
    etag: true,
    lastModified: true,
  } as const;
  /** Chemin relatif servi (sans le suffixe d'une variante) ; `null` hors de `frontend/` par un lien ou jamais servi. */
  const servi = (absolu: string, suffixe = ""): string | null => {
    let reel: string;
    try {
      reel = realpathSync(absolu);
    } catch {
      return null;
    }
    const chemin = relative(frontend, absolu).split(sep).join("/");
    const nu = chemin.slice(0, chemin.length - suffixe.length);
    return reel.startsWith(racineReelle + sep) && !NON_SERVIS.test(nu) ? nu : null;
  };
  return async (requete: FastifyRequest, reponse: FastifyReply): Promise<FastifyReply> => {
    const brut = requete.url.slice(prefixe.length);
    const q = brut.indexOf("?");
    const cheminBrut = q >= 0 ? brut.slice(0, q) : brut;
    const version = q >= 0 ? new URLSearchParams(brut.slice(q + 1)).get("v") : null;
    const encodage =
      requete.headers.range === undefined && COMPRESSIBLE.test(cheminBrut)
        ? encodageAccepte(requete.headers["accept-encoding"])
        : null;
    if (encodage !== null && cheminBrut.startsWith("/dist/assets/")) {
      const v = await send(requete.raw, cheminBrut + SUFFIXES[encodage], options);
      const chemin = v.type === "file" ? servi(v.metadata.path, SUFFIXES[encodage]) : null;
      if (v.type === "file" && chemin?.startsWith("dist/assets/"))
        return repondre(reponse, v, chemin, version, encodage);
      v.stream.destroy();
    }
    const r = await send(requete.raw, cheminBrut, options);
    if (r.type === "directory") throw new HttpError(404);
    if (r.type === "error") {
      if (r.statusCode >= 500) throw r.metadata.error;
      if (r.statusCode !== 412 && r.statusCode !== 416) throw new HttpError(404);
      return reponse.code(r.statusCode).headers(r.headers).send(r.stream);
    }
    const chemin = servi(r.metadata.path);
    if (chemin === null) {
      r.stream.destroy();
      throw new HttpError(404);
    }
    const taille = r.metadata.stat.size;
    if (
      encodage === null ||
      r.statusCode !== 200 ||
      chemin.startsWith("dist/assets/") ||
      taille < 1024 ||
      taille > 4 * 1024 * 1024
    )
      return repondre(reponse, r, chemin, version, null);
    r.stream.destroy();
    const corps = await variantes.obtenir(r.metadata.path, r.metadata.stat, encodage);
    return repondre(reponse, r, chemin, version, encodage, corps);
  };
}
