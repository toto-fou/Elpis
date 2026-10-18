// SPDX-License-Identifier: MIT
/** packages/commun/src/url.ts — `urllib.parse.urlsplit` / `urlunsplit` de CPython 3.13 (la classe URL de JS normalise, Python non). */
import { isIP } from "node:net";

import { ErreurPython } from "./python";

export interface UrlDecoupee {
  scheme: string;
  netloc: string;
  path: string;
  query: string;
  fragment: string;
}

const CARACTERES_SCHEMA = /^[A-Za-z0-9+\-.]+$/;
const USES_NETLOC = new Set([
  "",
  "ftp",
  "http",
  "gopher",
  "nntp",
  "telnet",
  "imap",
  "wais",
  "file",
  "mms",
  "https",
  "shttp",
  "snews",
  "prospero",
  "rtsp",
  "rtsps",
  "rtspu",
  "rsync",
  "svn",
  "svn+ssh",
  "sftp",
  "nfs",
  "git",
  "git+ssh",
  "ws",
  "wss",
  "itms-services",
]);

function sansEspacesC0EnTete(s: string): string {
  let i = 0;
  while (i < s.length && s.charCodeAt(i) <= 0x20) i++;
  return s.slice(i);
}

function estAscii(s: string): boolean {
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) > 0x7f) return false;
  return true;
}

function partition(s: string, sep: string): [string, string, string] {
  const i = s.indexOf(sep);
  return i < 0 ? [s, "", ""] : [s.slice(0, i), sep, s.slice(i + sep.length)];
}

function rpartition(s: string, sep: string): [string, string, string] {
  const i = s.lastIndexOf(sep);
  return i < 0 ? ["", "", s] : [s.slice(0, i), sep, s.slice(i + sep.length)];
}

/** `ipaddress.ip_address` : une zone IPv6 (`%eth0`) est admise si elle est non vide et sans `%`. */
function versionIp(hote: string): number {
  const i = hote.indexOf("%");
  if (i < 0) return isIP(hote);
  const zone = hote.slice(i + 1);
  return zone && !zone.includes("%") && isIP(hote.slice(0, i)) === 6 ? 6 : 0;
}

function verifierHoteCrochets(hote: string): void {
  if (hote.startsWith("v")) {
    if (!/^v[a-fA-F0-9]+\..+$/s.test(hote)) throw new RangeError("IPvFuture address is invalid");
    return;
  }
  const version = versionIp(hote);
  if (version === 0) throw new RangeError(`'${hote}' does not appear to be an IPv4 or IPv6 address`);
  if (version === 4) throw new RangeError("An IPv4 address cannot be in brackets");
}

function verifierNetlocCrochets(netloc: string): void {
  const [avant, crochet, entre] = partition(rpartition(netloc, "@")[2], "[");
  if (!crochet) return verifierHoteCrochets(partition(avant, ":")[0]);
  if (avant) throw new RangeError("Invalid IPv6 URL");
  const [hote, , port] = partition(entre, "]");
  if (port && !port.startsWith(":")) throw new RangeError("Invalid IPv6 URL");
  verifierHoteCrochets(hote);
}

function verifierNetloc(netloc: string): void {
  if (!netloc || estAscii(netloc)) return;
  const n = netloc.replace(/[@:#?]/g, "");
  const normalise = n.normalize("NFKC");
  if (n === normalise) return;
  if (/[/?#@:]/.test(normalise))
    throw new RangeError(`netloc '${netloc}' contains invalid characters under NFKC normalization`);
}

/** `urlsplit(url)` ; lève `RangeError` là où Python lève `ValueError`. */
export function urlsplit(entree: string): UrlDecoupee {
  let url = sansEspacesC0EnTete(entree).replace(/[\t\r\n]/g, "");
  let scheme = "";
  let netloc = "";
  let query = "";
  let fragment = "";
  const i = url.indexOf(":");
  if (i > 0 && /^[A-Za-z]/.test(url) && CARACTERES_SCHEMA.test(url.slice(0, i))) {
    scheme = url.slice(0, i).toLowerCase();
    url = url.slice(i + 1);
  }
  if (url.startsWith("//")) {
    const fins = ["/", "?", "#"].map((c) => url.indexOf(c, 2)).filter((p) => p >= 0);
    const fin = fins.length ? Math.min(...fins) : url.length;
    netloc = url.slice(2, fin);
    url = url.slice(fin);
    if (netloc.includes("[") !== netloc.includes("]")) throw new RangeError("Invalid IPv6 URL");
    if (netloc.includes("[")) verifierNetlocCrochets(netloc);
  }
  if (url.includes("#")) [url, , fragment] = partition(url, "#");
  if (url.includes("?")) [url, , query] = partition(url, "?");
  verifierNetloc(netloc);
  return { scheme, netloc, path: url, query, fragment };
}

/** `urlunsplit((scheme, netloc, path, query, fragment))`. */
export function urlunsplit(u: UrlDecoupee): string {
  let url = u.path;
  if (u.netloc) {
    if (url && !url.startsWith("/")) url = "/" + url;
    url = "//" + u.netloc + url;
  } else if (url.startsWith("//")) {
    url = "//" + url;
  } else if (u.scheme && USES_NETLOC.has(u.scheme) && (!url || url.startsWith("/"))) {
    url = "//" + url;
  }
  if (u.scheme) url = u.scheme + ":" + url;
  if (u.query) url += "?" + u.query;
  if (u.fragment) url += "#" + u.fragment;
  return url;
}

function infoHote(netloc: string): [string, string | null] {
  const infos = rpartition(netloc, "@")[2];
  const [, crochet, entre] = partition(infos, "[");
  let hote: string;
  let port: string;
  if (crochet) {
    let reste: string;
    [hote, , reste] = partition(entre, "]");
    port = partition(reste, ":")[2];
  } else {
    [hote, , port] = partition(infos, ":");
  }
  return [hote, port ? port : null];
}

/** Propriété `.hostname` : en minuscules sauf l'identifiant de zone IPv6, `null` si vide. */
export function hostname(u: UrlDecoupee): string | null {
  const hote = infoHote(u.netloc)[0];
  if (!hote) return null;
  const [nom, pourcent, zone] = partition(hote, "%");
  return nom.toLowerCase() + pourcent + zone;
}

/** Propriété `.port` : entier ou `null` ; lève comme Python pour un port non numérique ou hors 0–65535. */
export function port(u: UrlDecoupee): number | null {
  const brut = infoHote(u.netloc)[1];
  if (brut === null) return null;
  if (!/^[0-9]+$/.test(brut)) throw new RangeError(`Port could not be cast to integer value as '${brut}'`);
  const n = Number(brut);
  if (n > 65_535) throw new RangeError("Port out of range 0-65535");
  return n;
}

const TOUJOURS_SURS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_.-~";

/** `urllib.parse.quote(texte, safe)` : octets UTF-8 hors des caractères sûrs écrits `%XX` ; une demi-paire isolée lève. */
export function quotePy(texte: string, safe = "/"): string {
  if (/\p{Surrogate}/u.test(texte.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, ""))) {
    throw new RangeError("'utf-8' codec can't encode character: surrogates not allowed");
  }
  const surs = new Set(TOUJOURS_SURS + [...safe].filter((c) => c.charCodeAt(0) < 128).join(""));
  let sortie = "";
  for (const octet of Buffer.from(texte, "utf-8")) {
    const c = String.fromCharCode(octet);
    sortie += octet < 128 && surs.has(c) ? c : "%" + octet.toString(16).toUpperCase().padStart(2, "0");
  }
  return sortie;
}

const USES_RELATIVE = new Set(["", "ftp", "http", "gopher", "nntp", "imap", "wais", "file", "https", "shttp", "mms", "prospero", "rtsp", "rtsps", "rtspu", "sftp", "svn", "svn+ssh", "ws", "wss"]); // prettier-ignore

const USES_PARAMS = new Set(["", "ftp", "hdl", "prospero", "http", "imap", "https", "shttp", "rtsp", "rtsps", "rtspu", "sip", "sips", "mms", "sftp", "tel"]); // prettier-ignore

const PONCTUATION = "!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~";

const ALPHANUM = /[A-Za-z0-9]/u;

export interface UrlParsee extends UrlDecoupee {
  params: string;
}

/** `urlparse(url, schema)` : `urlsplit` puis `;params` du dernier segment. */
export function urlparse(url: string, schemaParDefaut = ""): UrlParsee {
  const s = urlsplit(url);
  const scheme = s.scheme || schemaParDefaut;
  let path = s.path;
  let params = "";
  if (USES_PARAMS.has(scheme) && path.includes(";")) {
    const i = path.includes("/") ? path.indexOf(";", path.lastIndexOf("/")) : path.indexOf(";");
    if (i >= 0) {
      params = path.slice(i + 1);
      path = path.slice(0, i);
    }
  }
  return { ...s, scheme, path, params };
}

export function urlunparse(u: UrlParsee): string {
  return urlunsplit({ ...u, path: u.params ? `${u.path};${u.params}` : u.path });
}

/** `urljoin` de CPython 3.13. */
export function urljoin(base: string, url: string): string {
  if (!base) return url;
  if (!url) return base;
  const b = urlparse(base);
  const u = urlparse(url, b.scheme);
  if (u.scheme !== b.scheme || !USES_RELATIVE.has(u.scheme)) return url;
  let netloc = u.netloc;
  if (USES_NETLOC.has(u.scheme)) {
    if (netloc) return urlunparse(u);
    netloc = b.netloc;
  }
  if (!u.path && !u.params) {
    return urlunparse({ ...u, netloc, path: b.path, params: b.params, query: u.query || b.query });
  }
  const baseParts = b.path.split("/");
  if (baseParts[baseParts.length - 1] !== "") baseParts.pop();
  let segments: string[];
  if (u.path.startsWith("/")) segments = u.path.split("/");
  else {
    segments = [...baseParts, ...u.path.split("/")];
    if (segments.length > 2)
      segments = [segments[0] ?? "", ...segments.slice(1, -1).filter(Boolean), segments.at(-1) ?? ""];
  }
  const resolu: string[] = [];
  for (const seg of segments) {
    if (seg === "..") resolu.pop();
    else if (seg !== ".") resolu.push(seg);
  }
  const dernier = segments.at(-1);
  if (dernier === "." || dernier === "..") resolu.push("");
  return urlunparse({ ...u, netloc, path: resolu.join("/") || "/" });
}

/** `quote(url, encoding="iso-8859-1", safe=string.punctuation)` d'un en-tête lu en latin-1. */
export function quoteLatin1(url: string): string {
  let sortie = "";
  for (const c of url) {
    const code = c.codePointAt(0) ?? 0;
    if (code > 0xff) throw new ErreurPython("ValueError", "'latin-1' codec can't encode character");
    sortie +=
      code < 0x80 && (ALPHANUM.test(c) || "_.-~".includes(c) || PONCTUATION.includes(c))
        ? c
        : "%" + code.toString(16).toUpperCase().padStart(2, "0");
  }
  return sortie;
}
