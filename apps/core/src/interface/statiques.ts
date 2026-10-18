// SPDX-License-Identifier: MIT
/** apps/core/src/interface/statiques.ts — `/static/*` : fichiers de `frontend/`, JS/CSS/HTML revalidés, vendor versionné et build Vite haché immuables. */
import { realpathSync } from "node:fs";
import { extname, relative, sep } from "node:path";

import { send } from "@fastify/send";
import type { FastifyReply, FastifyRequest } from "fastify";
import { HttpError } from "@elpis/commun";

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

/** JS/CSS/HTML : revalidation à chaque visite, sauf un vendor dont l'URL porte sa version et le build Vite, haché (immuables). */
export function cacheStatique(chemin: string, requeteBrute: string): string | undefined {
  if (chemin.startsWith("dist/assets/")) return "public, max-age=31536000, immutable";
  if (!/\.(?:js|css|html|mjs)$/.test(chemin)) return undefined;
  return chemin.startsWith("vendor/") && requeteBrute.includes("v=")
    ? "public, max-age=31536000, immutable"
    : "no-cache, must-revalidate";
}

/** Le chemin brut (encodé) part à `send`, qui le décode une seule fois ; un lien qui sort de `frontend/` est refusé comme sous Starlette. */
export function servirStatique(frontend: string, prefixe = "/static") {
  const racineReelle = realpathSync(frontend);
  return async (requete: FastifyRequest, reponse: FastifyReply): Promise<FastifyReply> => {
    const brut = requete.url.slice(prefixe.length);
    const q = brut.indexOf("?");
    const cheminBrut = q >= 0 ? brut.slice(0, q) : brut;
    const requeteBrute = q >= 0 ? brut.slice(q + 1) : "";
    const r = await send(requete.raw, cheminBrut, {
      root: frontend,
      index: false,
      dotfiles: "allow",
      cacheControl: false,
      contentType: false,
      etag: true,
      lastModified: true,
    });
    if (r.type === "directory") throw new HttpError(404);
    if (r.type === "error") {
      if (r.statusCode >= 500) throw r.metadata.error;
      if (r.statusCode !== 412 && r.statusCode !== 416) throw new HttpError(404);
      return reponse.code(r.statusCode).headers(r.headers).send(r.stream);
    }
    let reel: string;
    try {
      reel = realpathSync(r.metadata.path);
    } catch {
      throw new HttpError(404);
    }
    if (!reel.startsWith(racineReelle + sep)) {
      r.stream.destroy();
      throw new HttpError(404);
    }
    const chemin = relative(frontend, r.metadata.path).split(sep).join("/");
    if (NON_SERVIS.test(chemin)) {
      r.stream.destroy();
      throw new HttpError(404);
    }
    const entetes: Record<string, string> = { ...r.headers };
    if (r.statusCode !== 304) entetes["content-type"] = typeStatique(chemin);
    const cache = cacheStatique(chemin, requeteBrute);
    if (cache) entetes["cache-control"] = cache;
    return reponse.code(r.statusCode).headers(entetes).send(r.stream);
  };
}
