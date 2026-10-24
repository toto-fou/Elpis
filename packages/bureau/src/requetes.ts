// SPDX-License-Identifier: MIT
/** packages/bureau/src/requetes.ts — `requests.post` du client d'annotation : encodages, validations, redirections, CA et décodage de requests ; exceptions nommées comme requests. */
import { randomBytes } from "node:crypto";
import { statSync } from "node:fs";
import { createSecureContext } from "node:tls";
import type { SecureContext } from "node:tls";

import { Agent, request } from "undici";
import type { Dispatcher } from "undici";

import {
  BLANC_PY,
  CancelledError,
  chargerJsonPy,
  hostname,
  lstripPy,
  port,
  pyJsonDumps,
  quotePy,
  reprPy,
  rstripPy,
  urljoin,
  urlparse,
  urlunparse,
} from "@elpis/commun";
import { autoritesTls } from "@elpis/http";

import { agentUtilisateur } from "./ports";

/** Exception de requests (`ConnectionError`, `ReadTimeout`, `MissingSchema`…) : `name` porte la classe Python. */
export class ErreurRequests extends Error {
  constructor(nom: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = nom;
  }
}

export type RequetePost = {
  url: string;
  corps: Uint8Array;
  typeContenu: string;
  entetes: Readonly<Record<string, string>>;
  delai: number;
  signal?: AbortSignal;
};
export type ReponsePost = { statut: number; corps: Uint8Array; typeContenu: string | null };
/** Transport d'une requête préparée ; lève `ErreurRequests` comme requests, `CancelledError` sur Stop. */
export type Poster = (r: RequetePost) => Promise<ReponsePost>;

/** Requête vue par l'adaptateur (`HTTPAdapter.send`) : en-têtes en minuscules, sans les défauts de la session. */
export type RequeteHttp = {
  methode: string;
  url: string;
  corps: Uint8Array | null;
  entetes: Readonly<Record<string, string>>;
  delai: number;
  signal?: AbortSignal;
};
/** Réponse de l'adaptateur ; `location` telle que lue sur le fil (latin-1). */
export type ReponseHttp = ReponsePost & { location: string | null };
export type Envoi = (q: RequeteHttp) => Promise<ReponseHttp>;

/** `json=` de requests : `json.dumps(…, allow_nan=False)` (séparateurs par défaut, ASCII), en UTF-8. */
export function corpsJsonRequests(valeur: unknown): Buffer {
  let texte: string;
  try {
    texte = pyJsonDumps(valeur, { ensureAscii: true, separators: [", ", ": "], allowNan: false });
  } catch (e) {
    throw new ErreurRequests("InvalidJSONError", e instanceof Error ? e.message : String(e), { cause: e });
  }
  return Buffer.from(texte, "utf-8");
}

export type FichierRequests = { champ: string; nom: string; type: string; data: Uint8Array };

/** `format_multipart_header_param` d'urllib3 2 : seuls `\n`, `\r` et `"` sont encodés. */
const parametre = (nom: string, valeur: string): string =>
  `${nom}="${valeur.replaceAll("\n", "%0A").replaceAll("\r", "%0D").replaceAll('"', "%22")}"`;

/** `files=` + `data=` de requests : champs puis fichiers, frontière de 32 caractères hexadécimaux. */
export function multipartRequests(
  champs: readonly (readonly [string, string])[],
  fichiers: readonly FichierRequests[],
  frontiere = randomBytes(16).toString("hex"),
): { corps: Buffer; typeContenu: string } {
  const morceaux: Buffer[] = [];
  for (const [nom, valeur] of champs)
    morceaux.push(
      Buffer.from(`--${frontiere}\r\nContent-Disposition: form-data; ${parametre("name", nom)}\r\n\r\n`),
      Buffer.from(valeur, "utf-8"),
      Buffer.from("\r\n"),
    );
  for (const f of fichiers)
    morceaux.push(
      Buffer.from(
        `--${frontiere}\r\nContent-Disposition: form-data; ${parametre("name", f.champ)}; ` +
          `${parametre("filename", f.nom)}\r\nContent-Type: ${f.type}\r\n\r\n`,
      ),
      Buffer.from(f.data),
      Buffer.from("\r\n"),
    );
  morceaux.push(Buffer.from(`--${frontiere}--\r\n`));
  return { corps: Buffer.concat(morceaux), typeContenu: `multipart/form-data; boundary=${frontiere}` };
}

const SCHEMA = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;
const AUTORITE = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//;

/** `prepare_url` de requests (adresse sans schéma ou sans hôte) ; renvoie l'adresse sans blancs de tête. */
export function validerUrl(brute: string): string {
  const url = lstripPy(brute);
  if (url.includes(":") && !url.toLowerCase().startsWith("http")) return url;
  if (!SCHEMA.test(url))
    throw new ErreurRequests(
      "MissingSchema",
      `Invalid URL ${reprPy(url)}: No scheme supplied. Perhaps you meant https://${url}?`,
    );
  if (!AUTORITE.test(url))
    throw new ErreurRequests("InvalidURL", `Invalid URL ${reprPy(url)}: No host supplied`);
  let hote: string;
  try {
    hote = new URL(url).hostname;
  } catch (e) {
    throw new ErreurRequests("InvalidURL", `Invalid URL '${url}'`, { cause: e });
  }
  if (!hote) throw new ErreurRequests("InvalidURL", `Invalid URL ${reprPy(url)}: No host supplied`);
  if (hote.startsWith("*") || hote.startsWith("."))
    throw new ErreurRequests("InvalidURL", "URL has an invalid label.");
  return url;
}

/** `get_adapter` : seuls `http://` et `https://` ont un transport. */
export function verifierSchema(url: string): void {
  const bas = url.toLowerCase();
  if (!bas.startsWith("http://") && !bas.startsWith("https://"))
    throw new ErreurRequests("InvalidSchema", `No connection adapters were found for '${url}'`);
}

const NOM_ENTETE = new RegExp(`^[^:${BLANC_PY.slice(1, -1)}][^:\\r\\n]*\\n?$`);
const VALEUR_ENTETE = new RegExp(`^(?:[^${BLANC_PY.slice(1, -1)}][^\\r\\n]*)?\\n?$`);

/** `check_header_validity` : nom et valeur sans blanc de tête ni retour à la ligne. */
export function validerEntetes(entetes: Readonly<Record<string, string>>): void {
  for (const [nom, valeur] of Object.entries(entetes)) {
    if (!NOM_ENTETE.test(nom))
      throw new ErreurRequests("InvalidHeader", `Invalid header name ${JSON.stringify(nom)}`);
    if (!VALEUR_ENTETE.test(valeur))
      throw new ErreurRequests(
        "InvalidHeader",
        `Invalid leading whitespace, reserved character(s), or return character(s) in header value: ${JSON.stringify(valeur)}`,
      );
  }
}

/** `s.strip(caracteres)` de Python, en temps linéaire. */
const sansBords = (s: string, caracteres: string): string => lstripPy(rstripPy(s, caracteres), caracteres);

/** `_parse_content_type_header` puis `get_encoding_from_headers`. */
export function encodageReponse(typeContenu: string | null): string | null {
  if (!typeContenu) return null;
  const [tete = "", ...params] = typeContenu.split(";");
  const type = tete.trim();
  let charset: string | undefined;
  for (const brut of params) {
    const p = brut.trim();
    if (!p) continue;
    const i = p.indexOf("=");
    const cle = sansBords(i === -1 ? p : p.slice(0, i), "\"' ").toLowerCase();
    if (cle === "charset" && i !== -1) charset = sansBords(p.slice(i + 1), "\"' ");
  }
  if (charset !== undefined) return sansBords(charset, "\"'");
  if (type.includes("text")) return "ISO-8859-1";
  if (type.includes("application/json")) return "utf-8";
  return null;
}

const UTF8 = new Set(["utf8", "u8", "utf", "cp65001"]);
const LATIN1 = new Set(["latin1", "iso88591", "iso885911987", "l1", "cp819", "8859", "latin"]);
const ASCII = new Set(["ascii", "usascii", "646", "us"]);

/** `str(contenu, encodage, errors="replace")` ; encodage inconnu : UTF-8, comme le repli de requests. */
export function decoderRemplacement(corps: Uint8Array, encodage: string): string {
  const n = encodage.toLowerCase().replace(/[-_ ]/g, "");
  if (LATIN1.has(n)) return Buffer.from(corps).toString("latin1");
  if (ASCII.has(n)) {
    let s = "";
    for (const o of corps) s += o < 0x80 ? String.fromCharCode(o) : String.fromCharCode(0xfffd);
    return s;
  }
  if (n === "utf8sig") return new TextDecoder("utf-8").decode(corps);
  if (!UTF8.has(n)) {
    try {
      return new TextDecoder(encodage).decode(corps);
    } catch {
      return new TextDecoder("utf-8", { ignoreBOM: true }).decode(corps);
    }
  }
  return new TextDecoder("utf-8", { ignoreBOM: true }).decode(corps);
}

/** `Response.text` ; sans charset déclaré ni type texte ou JSON, UTF-8 au lieu de la détection de charset_normalizer. */
export function texteReponse(r: ReponsePost): string {
  if (!r.corps.length) return "";
  return decoderRemplacement(r.corps, encodageReponse(r.typeContenu) ?? "utf-8");
}

/** `guess_json_utf`. */
function devinerUtfJson(d: Uint8Array): string | null {
  const [a, b, c, e] = [d[0], d[1], d[2], d[3]];
  if ((a === 0xff && b === 0xfe && c === 0 && e === 0) || (a === 0 && b === 0 && c === 0xfe && e === 0xff))
    return "utf-32";
  if (a === 0xef && b === 0xbb && c === 0xbf) return "utf-8-sig";
  if ((a === 0xff && b === 0xfe) || (a === 0xfe && b === 0xff)) return "utf-16";
  const nuls = [a, b, c, e].filter((x) => x === 0).length;
  if (nuls === 0) return "utf-8";
  if (nuls === 2) {
    if (a === 0 && c === 0) return "utf-16-be";
    if (b === 0 && e === 0) return "utf-16-le";
  }
  if (nuls === 3) {
    if (a === 0 && b === 0 && c === 0) return "utf-32-be";
    if (b === 0 && c === 0 && e === 0) return "utf-32-le";
  }
  return null;
}

/** Décodage strict (UnicodeDecodeError → exception) des encodages que devine requests. */
function decoderStrict(d: Uint8Array, encodage: string): string {
  if (encodage === "utf-8") return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(d);
  if (encodage === "utf-8-sig") return new TextDecoder("utf-8", { fatal: true }).decode(d);
  if (encodage.startsWith("utf-16")) {
    const bom = encodage === "utf-16";
    const le = bom ? d[0] === 0xff : encodage === "utf-16-le";
    return new TextDecoder(le ? "utf-16le" : "utf-16be", { fatal: true, ignoreBOM: true }).decode(
      d.subarray(bom ? 2 : 0),
    );
  }
  const bom = encodage === "utf-32";
  const le = bom ? d[0] === 0xff : encodage === "utf-32-le";
  const vue = new DataView(d.buffer, d.byteOffset, d.byteLength);
  if (d.length % 4) throw new RangeError("truncated data");
  let s = "";
  for (let i = bom ? 4 : 0; i < d.length; i += 4) {
    const cp = vue.getUint32(i, le);
    if (cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) throw new RangeError("code point not in range");
    s += String.fromCodePoint(cp);
  }
  return s;
}

/** Texte JSON de `Response.json()` : encodage deviné sans charset déclaré (UTF-8/16/32), sinon `Response.text`. */
export function texteJsonRequests(r: ReponsePost): string {
  if (encodageReponse(r.typeContenu) === null && r.corps.length > 3) {
    const devine = devinerUtfJson(r.corps);
    if (devine !== null)
      try {
        return decoderStrict(r.corps, devine);
      } catch {
        return texteReponse(r);
      }
  }
  return texteReponse(r);
}

/** `Response.json()` : lève (SyntaxError, comme `ValueError`) si le corps n'est pas du JSON. */
export function jsonReponse(r: ReponsePost): unknown {
  if (encodageReponse(r.typeContenu) === null && r.corps.length > 3) {
    const devine = devinerUtfJson(r.corps);
    if (devine !== null) {
      let texte: string | null;
      try {
        texte = decoderStrict(r.corps, devine);
      } catch {
        texte = null;
      }
      if (texte !== null) return chargerJsonPy(texte);
    }
  }
  return chargerJsonPy(texteReponse(r));
}

/** Levée hors de requests, comme en Python : une `Location` qui n'est pas de l'UTF-8 valide. */
export class ErreurDecodage extends Error {
  override name = "UnicodeDecodeError";
}

const NON_RESERVE = /^[A-Za-z0-9\-._~]$/;
const DECIMAL = /^\p{Nd}$/u;

/** `int(h, 16)` de deux caractères : chiffres hexadécimaux ASCII ou chiffres décimaux Unicode ; `null` sinon. */
function hexPy(h: string): number | null {
  let v = 0;
  for (const c of h) {
    let d = /^[0-9a-fA-F]$/.test(c) ? parseInt(c, 16) : -1;
    if (d < 0 && DECIMAL.test(c)) {
      let debut = c.codePointAt(0) ?? 0;
      const code = debut;
      while (debut > 0 && DECIMAL.test(String.fromCodePoint(debut - 1))) debut--;
      d = (code - debut) % 10;
    }
    if (d < 0) return null;
    v = v * 16 + d;
  }
  return v;
}

/** `requote_uri` de requests : `%XX` non réservés décodés puis requote ; séquence invalide : tout requoté, `%` compris. */
function requoteUri(uri: string): string {
  const parties = uri.split("%");
  let valide = true;
  for (let i = 1; i < parties.length && valide; i++) {
    const partie = parties[i] ?? "";
    const h = [...partie].slice(0, 2).join("");
    if ([...h].length !== 2 || !/^[\p{L}\p{N}]{2}$/u.test(h)) {
      parties[i] = "%" + partie;
      continue;
    }
    const v = hexPy(h);
    if (v === null) valide = false;
    else {
      const c = String.fromCharCode(v);
      parties[i] = NON_RESERVE.test(c) ? c + partie.slice(h.length) : "%" + partie;
    }
  }
  return valide ? quotePy(parties.join(""), "!#$%&'()*+,/:;=?@[]~") : quotePy(uri, "!#$&'()*+,/:;=?@[]~");
}

const PORTS_DEFAUT: Readonly<Record<string, number>> = { http: 80, https: 443 };

/** `should_strip_auth` : autre hôte, ou autre port ou schéma (sauf http → https sur les ports standard). */
function retirerAutorisation(ancienne: string, nouvelle: string): boolean {
  const [a, n] = [urlparse(ancienne), urlparse(nouvelle)];
  if (hostname(a) !== hostname(n)) return true;
  const [pa, pn] = [port(a), port(n)];
  if (
    a.scheme === "http" &&
    (pa === 80 || pa === null) &&
    n.scheme === "https" &&
    (pn === 443 || pn === null)
  )
    return false;
  const defaut = [PORTS_DEFAUT[a.scheme] ?? null, null];
  if (a.scheme === n.scheme && defaut.includes(pa) && defaut.includes(pn)) return false;
  return pa !== pn || a.scheme !== n.scheme;
}

const REDIRECTIONS = new Set([301, 302, 303, 307, 308]);
export const MAX_REDIRECTIONS = 30;

/** `get_redirect_target` : `Location` relue en UTF-8 strict (les octets lus en latin-1 par le transport). */
function cibleRedirection(r: ReponseHttp): string | null {
  if (!REDIRECTIONS.has(r.statut) || r.location === null) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      Buffer.from(r.location, "latin1"),
    );
  } catch (e) {
    throw new ErreurDecodage("'utf-8' codec can't decode the Location header", { cause: e });
  }
}

const sans = (entetes: Readonly<Record<string, string>>, noms: readonly string[]): Record<string, string> =>
  Object.fromEntries(Object.entries(entetes).filter(([k]) => !noms.includes(k)));

/** `Session.send` puis `resolve_redirects` de requests 2.34 : 301 (POST), 302, 303 → GET sans corps ; Authorization retiré hors de l'hôte ; 30 redirections au plus. */
export async function suivreRedirections(envoi: Envoi, r: RequetePost): Promise<ReponsePost> {
  const entetes: Record<string, string> = { "content-type": r.typeContenu };
  for (const [k, v] of Object.entries(r.entetes)) entetes[k.toLowerCase()] = v;
  let q: RequeteHttp = {
    methode: "POST",
    url: r.url,
    corps: r.corps,
    entetes,
    delai: r.delai,
    signal: r.signal,
  };
  let rep = await envoi(q);
  let fragment = urlparse(q.url).fragment;
  for (let sauts = 0; ; sauts++) {
    let url = cibleRedirection(rep);
    if (!url) return { statut: rep.statut, corps: rep.corps, typeContenu: rep.typeContenu };
    if (sauts >= MAX_REDIRECTIONS)
      throw new ErreurRequests("TooManyRedirects", `Exceeded ${MAX_REDIRECTIONS} redirects.`);
    if (url.startsWith("//")) url = `${urlparse(q.url).scheme}:${url}`;
    const p = urlparse(url);
    if (p.fragment === "" && fragment) p.fragment = fragment;
    else if (p.fragment) fragment = p.fragment;
    url = p.netloc ? requoteUri(urlunparse(p)) : urljoin(q.url, requoteUri(urlunparse(p)));
    const versGet = (rep.statut === 302 || rep.statut === 303) && q.methode !== "HEAD";
    const methode = versGet || (rep.statut === 301 && q.methode === "POST") ? "GET" : q.methode;
    const rejoue = rep.statut === 307 || rep.statut === 308;
    let suite = sans(
      q.entetes,
      rejoue ? ["cookie"] : ["content-length", "content-type", "transfer-encoding", "cookie"],
    );
    if ("authorization" in suite && retirerAutorisation(q.url, url)) suite = sans(suite, ["authorization"]);
    verifierSchema(url);
    q = { ...q, methode, url, corps: rejoue ? q.corps : null, entetes: suite };
    rep = await envoi(q);
  }
}

const contextes = new WeakMap<readonly string[], SecureContext>();

/** CA de requests : `REQUESTS_CA_BUNDLE`, sinon `CURL_CA_BUNDLE` (fichier ou dossier), sinon le magasin embarqué (certifi ↔ Node). */
export function contexteRequests(): SecureContext {
  const chemin = process.env["REQUESTS_CA_BUNDLE"] || process.env["CURL_CA_BUNDLE"] || "";
  let dossier: boolean;
  try {
    dossier = chemin !== "" && statSync(chemin).isDirectory();
  } catch {
    dossier = false;
  }
  const autorites = autoritesTls(
    chemin === "" ? {} : dossier ? { SSL_CERT_DIR: chemin } : { SSL_CERT_FILE: chemin },
  );
  let ctx = contextes.get(autorites);
  if (ctx === undefined) {
    ctx = createSecureContext({ ca: [...autorites] });
    contextes.set(autorites, ctx);
  }
  return ctx;
}

function code(e: unknown): string {
  const c = (e as { code?: unknown } | null)?.code;
  const sous = (e as { cause?: { code?: unknown } } | null)?.cause?.code;
  return typeof c === "string" ? c : typeof sous === "string" ? sous : "";
}

const CONNEXION = new Set([
  "ECONNREFUSED",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EADDRNOTAVAIL",
  "EHOSTDOWN",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ECONNRESET",
  "EPIPE",
  "ETIMEDOUT",
  "ECONNABORTED",
  "UND_ERR_SOCKET",
  "UND_ERR_CLOSED",
  "UND_ERR_DESTROYED",
  "UND_ERR_RES_CONTENT_LENGTH_MISMATCH",
]);

/** Erreur undici → exception de requests (avant ou pendant la lecture du corps). */
export function traduire(e: unknown, entetesRecues: boolean): unknown {
  const c = code(e);
  const message = e instanceof Error ? e.message : String(e);
  const nom = (n: string): ErreurRequests => new ErreurRequests(n, message, { cause: e });
  if (c === "UND_ERR_CONNECT_TIMEOUT") return nom("ConnectTimeout");
  if (c === "UND_ERR_HEADERS_TIMEOUT") return nom("ReadTimeout");
  if (c === "UND_ERR_BODY_TIMEOUT") return nom("ConnectionError");
  if (/CERT|SSL|TLS|SELF_SIGNED|UNABLE_TO_|EPROTO/.test(c)) return nom("SSLError");
  if (CONNEXION.has(c) || (c.startsWith("UND_ERR") && c !== "UND_ERR_INVALID_ARG"))
    return nom(entetesRecues ? "ChunkedEncodingError" : "ConnectionError");
  return e;
}

/** `HTTPAdapter.send` : une requête sur le fil, corps lu en entier ; adresse illisible → `InvalidURL`. */
async function envoyerUndici(agent: Agent, ms: number, q: RequeteHttp): Promise<ReponseHttp> {
  if (q.signal?.aborted) throw new CancelledError("requête annulée", { cause: q.signal.reason });
  try {
    new URL(q.url);
  } catch (e) {
    throw new ErreurRequests("InvalidURL", `Invalid URL '${q.url}'`, { cause: e });
  }
  let entetesRecues = false;
  try {
    const rep = await request(q.url, {
      method: q.methode as Dispatcher.HttpMethod,
      headers: { accept: "*/*", "user-agent": agentUtilisateur(), ...q.entetes },
      body: q.corps ?? undefined,
      dispatcher: agent,
      headersTimeout: ms,
      bodyTimeout: ms,
      signal: q.signal,
    });
    entetesRecues = true;
    const corps = Buffer.from(await rep.body.arrayBuffer());
    const un = (v: string | string[] | undefined): string | null =>
      v === undefined ? null : Array.isArray(v) ? v.join(", ") : v;
    return {
      statut: rep.statusCode,
      corps,
      typeContenu: un(rep.headers["content-type"]),
      location: un(rep.headers["location"]),
    };
  } catch (e) {
    if (q.signal?.aborted) throw new CancelledError("requête annulée", { cause: q.signal.reason });
    throw traduire(e, entetesRecues);
  }
}

/** Transport par défaut : un pool par appel, comme `requests.post` (session jetable), redirections comprises, fermé quoi qu'il arrive. */
export const posterUndici: Poster = async (r) => {
  const ms = Math.max(1, Math.round(r.delai * 1000));
  const agent = new Agent({ connect: { timeout: ms, secureContext: contexteRequests() }, allowH2: false });
  try {
    return await suivreRedirections((q) => envoyerUndici(agent, ms, q), r);
  } finally {
    await agent.destroy().catch(() => undefined);
  }
};
