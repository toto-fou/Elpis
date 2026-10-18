// SPDX-License-Identifier: MIT
/** packages/commun/src/mimetypes.ts — `mimetypes` de CPython 3.13 : tables par défaut, fichiers `mime.types` du système lus comme `init()`, `guess_type`. */
import { readFileSync, statSync } from "node:fs";

import { lowerPy, splitPy } from "./python";
import { urlparse } from "./url";

// Tables de mimetypes (CPython 3.13.5)
const SUFFIXES = new Map(Object.entries({ ".svgz": ".svg.gz", ".tgz": ".tar.gz", ".taz": ".tar.gz", ".tz": ".tar.gz", ".tbz2": ".tar.bz2", ".txz": ".tar.xz" })); // prettier-ignore
const ENCODAGES = new Map(Object.entries({ ".gz": "gzip", ".Z": "compress", ".bz2": "bzip2", ".xz": "xz", ".br": "br" })); // prettier-ignore
const TYPES = new Map(Object.entries({ ".js": "text/javascript", ".mjs": "text/javascript", ".json": "application/json", ".webmanifest": "application/manifest+json", ".doc": "application/msword", ".dot": "application/msword", ".wiz": "application/msword", ".nq": "application/n-quads", ".nt": "application/n-triples", ".bin": "application/octet-stream", ".a": "application/octet-stream", ".dll": "application/octet-stream", ".exe": "application/octet-stream", ".o": "application/octet-stream", ".obj": "application/octet-stream", ".so": "application/octet-stream", ".oda": "application/oda", ".pdf": "application/pdf", ".p7c": "application/pkcs7-mime", ".ps": "application/postscript", ".ai": "application/postscript", ".eps": "application/postscript", ".trig": "application/trig", ".m3u": "application/vnd.apple.mpegurl", ".m3u8": "application/vnd.apple.mpegurl", ".xls": "application/vnd.ms-excel", ".xlb": "application/vnd.ms-excel", ".ppt": "application/vnd.ms-powerpoint", ".pot": "application/vnd.ms-powerpoint", ".ppa": "application/vnd.ms-powerpoint", ".pps": "application/vnd.ms-powerpoint", ".pwz": "application/vnd.ms-powerpoint", ".wasm": "application/wasm", ".bcpio": "application/x-bcpio", ".cpio": "application/x-cpio", ".csh": "application/x-csh", ".dvi": "application/x-dvi", ".gtar": "application/x-gtar", ".hdf": "application/x-hdf", ".h5": "application/x-hdf5", ".latex": "application/x-latex", ".mif": "application/x-mif", ".cdf": "application/x-netcdf", ".nc": "application/x-netcdf", ".p12": "application/x-pkcs12", ".pfx": "application/x-pkcs12", ".ram": "application/x-pn-realaudio", ".pyc": "application/x-python-code", ".pyo": "application/x-python-code", ".sh": "application/x-sh", ".shar": "application/x-shar", ".swf": "application/x-shockwave-flash", ".sv4cpio": "application/x-sv4cpio", ".sv4crc": "application/x-sv4crc", ".tar": "application/x-tar", ".tcl": "application/x-tcl", ".tex": "application/x-tex", ".texi": "application/x-texinfo", ".texinfo": "application/x-texinfo", ".roff": "application/x-troff", ".t": "application/x-troff", ".tr": "application/x-troff", ".man": "application/x-troff-man", ".me": "application/x-troff-me", ".ms": "application/x-troff-ms", ".ustar": "application/x-ustar", ".src": "application/x-wais-source", ".xsl": "application/xml", ".rdf": "application/xml", ".wsdl": "application/xml", ".xpdl": "application/xml", ".zip": "application/zip", ".3gp": "audio/3gpp", ".3gpp": "audio/3gpp", ".3g2": "audio/3gpp2", ".3gpp2": "audio/3gpp2", ".aac": "audio/aac", ".adts": "audio/aac", ".loas": "audio/aac", ".ass": "audio/aac", ".au": "audio/basic", ".snd": "audio/basic", ".mp3": "audio/mpeg", ".mp2": "audio/mpeg", ".opus": "audio/opus", ".aif": "audio/x-aiff", ".aifc": "audio/x-aiff", ".aiff": "audio/x-aiff", ".ra": "audio/x-pn-realaudio", ".wav": "audio/x-wav", ".avif": "image/avif", ".bmp": "image/bmp", ".gif": "image/gif", ".ief": "image/ief", ".jpg": "image/jpeg", ".jpe": "image/jpeg", ".jpeg": "image/jpeg", ".heic": "image/heic", ".heif": "image/heif", ".png": "image/png", ".svg": "image/svg+xml", ".tiff": "image/tiff", ".tif": "image/tiff", ".ico": "image/vnd.microsoft.icon", ".webp": "image/webp", ".ras": "image/x-cmu-raster", ".pnm": "image/x-portable-anymap", ".pbm": "image/x-portable-bitmap", ".pgm": "image/x-portable-graymap", ".ppm": "image/x-portable-pixmap", ".rgb": "image/x-rgb", ".xbm": "image/x-xbitmap", ".xpm": "image/x-xpixmap", ".xwd": "image/x-xwindowdump", ".eml": "message/rfc822", ".mht": "message/rfc822", ".mhtml": "message/rfc822", ".nws": "message/rfc822", ".css": "text/css", ".csv": "text/csv", ".html": "text/html", ".htm": "text/html", ".md": "text/markdown", ".markdown": "text/markdown", ".n3": "text/n3", ".txt": "text/plain", ".bat": "text/plain", ".c": "text/plain", ".h": "text/plain", ".ksh": "text/plain", ".pl": "text/plain", ".srt": "text/plain", ".rtx": "text/richtext", ".rtf": "text/rtf", ".tsv": "text/tab-separated-values", ".vtt": "text/vtt", ".py": "text/x-python", ".rst": "text/x-rst", ".etx": "text/x-setext", ".sgm": "text/x-sgml", ".sgml": "text/x-sgml", ".vcf": "text/x-vcard", ".xml": "text/xml", ".mp4": "video/mp4", ".mpeg": "video/mpeg", ".m1v": "video/mpeg", ".mpa": "video/mpeg", ".mpe": "video/mpeg", ".mpg": "video/mpeg", ".mov": "video/quicktime", ".qt": "video/quicktime", ".webm": "video/webm", ".avi": "video/x-msvideo", ".movie": "video/x-sgi-movie" })); // prettier-ignore
const TYPES_COURANTS = new Map(Object.entries({ ".rtf": "application/rtf", ".midi": "audio/midi", ".mid": "audio/midi", ".jpg": "image/jpg", ".pict": "image/pict", ".pct": "image/pict", ".pic": "image/pict", ".xul": "text/xul" })); // prettier-ignore

/** `mimetypes.knownfiles` (hors Windows). */
export const FICHIERS_CONNUS: readonly string[] = [
  "/etc/mime.types",
  "/etc/httpd/mime.types",
  "/etc/httpd/conf/mime.types",
  "/etc/apache/mime.types",
  "/etc/apache2/mime.types",
  "/usr/local/etc/httpd/conf/mime.types",
  "/usr/local/lib/netscape/mime.types",
  "/usr/local/etc/httpd/conf/mime.types",
  "/usr/local/etc/mime.types",
];

/** `posixpath.splitext` : les points de tête du nom ne comptent pas. */
function splitext(p: string): [string, string] {
  const barre = p.lastIndexOf("/");
  const point = p.lastIndexOf(".");
  if (point > barre) {
    for (let i = barre + 1; i < point; i++) if (p[i] !== ".") return [p.slice(0, point), p.slice(point)];
  }
  return [p, ""];
}

/** Base `mimetypes.MimeTypes` : tables par défaut, `mime.types` ajoutés par `lire`. */
export class TypesMime {
  private readonly strict = new Map(TYPES);
  private readonly courants = new Map(TYPES_COURANTS);

  /** `readfp` : `type ext…` par ligne (sauts de ligne universels), `#` ouvre un commentaire ; une extension connue change de type. */
  lire(contenu: string, strict = true): void {
    for (const ligne of contenu.split(/\r\n|\r|\n/u)) {
      const mots = splitPy(ligne);
      const diese = mots.findIndex((m) => m.startsWith("#"));
      if (diese >= 0) mots.length = diese;
      const [type, ...suffixes] = mots;
      if (!type) continue;
      for (const s of suffixes) (strict ? this.strict : this.courants).set(`.${s}`, type);
    }
  }

  /** `guess_type(url, strict)` : `[type, encodage]` ; URL `data:` lue, schéma d'au moins deux lettres retiré (`urlparse`, qui lève `RangeError` comme Python `ValueError`). */
  devinerType(url: string, strict = true): [string | null, string | null] {
    const p = urlparse(url);
    if (p.scheme.length <= 1) return this.typeDeFichier(url, strict);
    if (p.scheme !== "data") return this.typeDeFichier(p.path, strict);
    const virgule = p.path.indexOf(",");
    if (virgule < 0) return [null, null];
    const pv = p.path.indexOf(";");
    const type = p.path.slice(0, pv >= 0 && pv < virgule ? pv : virgule);
    return [type.includes("=") || !type.includes("/") ? "text/plain" : type, null];
  }

  private typeDeFichier(chemin: string, strict: boolean): [string | null, string | null] {
    let [base, ext] = splitext(chemin);
    for (let s = SUFFIXES.get(lowerPy(ext)); s !== undefined; s = SUFFIXES.get(lowerPy(ext)))
      [base, ext] = splitext(base + s);
    const encodage = ENCODAGES.get(ext) ?? null;
    if (encodage !== null) [, ext] = splitext(base);
    ext = lowerPy(ext);
    const type = this.strict.get(ext) ?? (strict ? undefined : this.courants.get(ext));
    return [type ?? null, encodage];
  }
}

function estFichier(chemin: string): boolean {
  try {
    return statSync(chemin).isFile();
  } catch {
    return false;
  }
}

let systeme: TypesMime | undefined;

/** `mimetypes.guess_type` : base du process, fichiers connus lus au premier appel comme `init()`. */
export function guessTypePy(url: string, strict = true): [string | null, string | null] {
  if (systeme === undefined) {
    systeme = new TypesMime();
    for (const f of FICHIERS_CONNUS) if (estFichier(f)) systeme.lire(readFileSync(f, "utf-8"));
  }
  return systeme.devinerType(url, strict);
}
