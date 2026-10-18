// SPDX-License-Identifier: MIT
/** apps/core/src/images/http.ts — transport des moteurs d'images : TLS du système (+ CA collée), réponses lues en flux et plafonnées, codes HTTP traduits. */
import { randomBytes, X509Certificate } from "node:crypto";
import { createSecureContext, getCACertificates, rootCertificates } from "node:tls";
import type { SecureContext } from "node:tls";

import { Agent, request } from "undici";
import type { Dispatcher } from "undici";

import { chargerJsonPy, reprPy, stripPy, strPy, texteJsonPy, veritePy } from "@elpis/commun";

import {
  AGENT_UTILISATEUR,
  CancelledError,
  corpsJson,
  HTTPError,
  TimeoutException,
  traduireErreur,
} from "../llm/client-http";
import { estDict, lire, prefixePy } from "../python";
import { HINT_ADMIN, ImageError } from "./base";

/** Réponses de contrôle (capacités, état d'un job, liste de modèles). */
export const SMALL_BYTES = 2 * 1024 * 1024;
/** Réponses qui portent les images (base64 d'un lot). */
export const LARGE_BYTES = 160 * 1024 * 1024;
const CONNEXION_S = 10.0;

export type ContexteTls = { readonly autorites: readonly string[]; readonly contexte: SecureContext };

const contextes = new Map<string, ContexteTls>();

function magasinSysteme(): readonly string[] {
  try {
    return getCACertificates("system");
  } catch {
    return rootCertificates;
  }
}

const DEBUT_PEM = /^-----BEGIN (.+)-----$/;

/** `sanitize_line` d'OpenSSL : tout octet ≤ espace retiré en fin de ligne. */
function sansBlancsFinaux(l: string): string {
  let fin = l.length;
  while (fin > 0 && l.charCodeAt(fin - 1) <= 0x20) fin--;
  return l.slice(0, fin);
}
const BASE64_PEM = /^[A-Za-z0-9+/=\s]*$/;

/** `load_verify_locations(cadata=…)` d'OpenSSL : blocs lus dans l'ordre, un bloc de certificat illisible arrête tout, aucun certificat = erreur. */
export function certificatsPem(texte: string): string[] {
  const lignes = texte.split("\n").map(sansBlancsFinaux);
  const certificats: string[] = [];
  for (let i = 0; i < lignes.length; i++) {
    const nom = DEBUT_PEM.exec(lignes[i] ?? "")?.[1];
    if (nom === undefined) continue;
    const fin = lignes.indexOf(`-----END ${nom}-----`, i + 1);
    if (fin < 0) throw new Error("bad end line");
    const corps = lignes.slice(i + 1, fin).join("\n");
    i = fin;
    if (nom !== "CERTIFICATE" && nom !== "X509 CERTIFICATE") continue;
    if (!BASE64_PEM.test(corps)) throw new Error("bad base64 decode");
    const der = Buffer.from(corps.replace(/\s+/g, ""), "base64");
    new X509Certificate(der);
    certificats.push(`-----BEGIN CERTIFICATE-----\n${der.toString("base64")}\n-----END CERTIFICATE-----\n`);
  }
  if (certificats.length === 0) throw new Error("no start line: cadata does not contain a certificate");
  return certificats;
}

/** Contexte TLS : magasin du système (PKI interne) plus la CA de la console ; `false` si la vérification est décochée. */
export function tls(verify: boolean, caPem = ""): ContexteTls | false {
  if (!verify) return false;
  const ca = stripPy(caPem || "");
  const connu = contextes.get(ca);
  if (connu !== undefined) return connu;
  let autorites: readonly string[];
  try {
    autorites = ca ? [...magasinSysteme(), ...certificatsPem(ca)] : magasinSysteme();
  } catch (e) {
    throw new ImageError("Autorité de certification illisible. " + HINT_ADMIN, {
      code: "unavailable",
      detail: e instanceof Error ? `SSLError(${reprPy(e.message)})` : String(e),
      cause: e,
    });
  }
  const ctx = { autorites, contexte: createSecureContext({ ca: [...autorites] }) };
  if (contextes.size >= 8) contextes.delete(contextes.keys().next().value ?? "");
  contextes.set(ca, ctx);
  return ctx;
}

/** `httpx.AsyncClient(timeout=Timeout(t, connect=10))` : un pool par appel, fermé par `fermer()`. */
export class ClientImages {
  readonly delaiLecture: number;
  private readonly agent: Agent;

  constructor(delaiLecture: number, contexte: ContexteTls | false) {
    this.delaiLecture = delaiLecture;
    const securite =
      contexte === false ? { rejectUnauthorized: false } : { secureContext: contexte.contexte };
    this.agent = new Agent({ connect: { timeout: CONNEXION_S * 1000, ...securite }, allowH2: false });
  }

  get dispatcher(): Dispatcher {
    return this.agent;
  }

  async fermer(): Promise<void> {
    await this.agent.destroy().catch(() => undefined);
  }
}

export function client(timeout: number, options: { verify?: boolean; caPem?: string } = {}): ClientImages {
  return new ClientImages(timeout, tls(options.verify ?? true, options.caPem ?? ""));
}

/** `async with client(...) as c` : pool fermé quoi qu'il arrive. */
export async function avecClient<T>(
  timeout: number,
  options: { verify?: boolean; caPem?: string },
  fn: (c: ClientImages) => Promise<T>,
): Promise<T> {
  const c = client(timeout, options);
  try {
    return await fn(c);
  } finally {
    await c.fermer();
  }
}

/** Réponse lue en entier. */
export class Reply {
  readonly statusCode: number;
  readonly content: Uint8Array;

  constructor(statusCode: number, content: Uint8Array) {
    this.statusCode = statusCode;
    this.content = content;
  }

  /** `json.loads(content or b"null")` : NaN admis, flottants entiers en `FlottantPy` ; lève comme `ValueError`. */
  json(): unknown {
    return chargerJsonPy(this.content.length ? texteJsonPy(this.content) : "null");
  }

  get text(): string {
    return new TextDecoder("utf-8", { ignoreBOM: true }).decode(this.content);
  }
}

export type FichierMultipart = { nom: string; nomFichier: string; type: string; data: Uint8Array };
export type Multipart = {
  champs: readonly (readonly [string, string])[];
  fichiers: readonly FichierMultipart[];
};

const ECHAPPEMENTS_FORM: Readonly<Record<string, string>> = { '"': "%22", "\\": "\\\\" };

/** `_format_form_param` de httpx : guillemet, barre oblique inverse et contrôles (sauf ESC) échappés. */
function parametreForm(nom: string, valeur: string): string {
  let v = "";
  for (const c of valeur) {
    const code = c.charCodeAt(0);
    const e = ECHAPPEMENTS_FORM[c];
    if (e !== undefined) v += e;
    else if (code <= 0x1f && code !== 0x1b) v += "%" + code.toString(16).toUpperCase().padStart(2, "0");
    else v += c;
  }
  return `${nom}="${v}"`;
}

/** Corps `multipart/form-data` de httpx : champs puis fichiers, frontière de 32 caractères hexadécimaux. */
export function multipartHttpx(
  m: Multipart,
  frontiere = randomBytes(16).toString("hex"),
): { corps: Buffer; type: string } {
  const morceaux: Buffer[] = [];
  for (const [nom, valeur] of m.champs) {
    morceaux.push(
      Buffer.from(`--${frontiere}\r\nContent-Disposition: form-data; ${parametreForm("name", nom)}\r\n\r\n`),
    );
    morceaux.push(Buffer.from(valeur, "utf-8"), Buffer.from("\r\n"));
  }
  for (const f of m.fichiers) {
    const tete =
      `--${frontiere}\r\nContent-Disposition: form-data; ${parametreForm("name", f.nom)}; ` +
      `${parametreForm("filename", f.nomFichier)}\r\nContent-Type: ${f.type}\r\n\r\n`;
    morceaux.push(Buffer.from(tete), Buffer.from(f.data), Buffer.from("\r\n"));
  }
  morceaux.push(Buffer.from(`--${frontiere}--\r\n`));
  return { corps: Buffer.concat(morceaux), type: `multipart/form-data; boundary=${frontiere}` };
}

export type OptionsFetch = {
  limit?: number;
  headers?: Readonly<Record<string, string>>;
  json?: unknown;
  multipart?: Multipart;
  signal?: AbortSignal;
};

const enMs = (s: number): number => Math.max(1, Math.round(s * 1000));
const reprErreur = (e: unknown): string =>
  e instanceof Error ? `${e.name}(${reprPy(e.message)})` : reprPy(String(e));

/** Requête lue en flux, plafonnée à `limit` octets ; pannes réseau → `ImageError` (unavailable, timeout), Stop → `CancelledError`. */
export async function fetch(
  c: ClientImages,
  method: string,
  url: string,
  options: OptionsFetch = {},
): Promise<Reply> {
  const limit = options.limit ?? SMALL_BYTES;
  const signal = options.signal;
  const entetes: Record<string, string> = { accept: "*/*", "user-agent": AGENT_UTILISATEUR };
  let corps: Buffer | undefined;
  if (options.multipart !== undefined) {
    const m = multipartHttpx(options.multipart);
    corps = m.corps;
    entetes["content-type"] = m.type;
  } else if (options.json !== undefined) {
    corps = corpsJson(options.json);
    entetes["content-type"] = "application/json";
  }
  for (const [k, v] of Object.entries(options.headers ?? {})) entetes[k.toLowerCase()] = v;
  let entetesRecues = false;
  try {
    if (signal?.aborted) throw new CancelledError("requête annulée", { cause: signal.reason });
    const r = await request(url, {
      method: method as Dispatcher.HttpMethod,
      headers: entetes,
      body: corps,
      dispatcher: c.dispatcher,
      headersTimeout: enMs(c.delaiLecture),
      bodyTimeout: enMs(c.delaiLecture),
      signal,
    });
    entetesRecues = true;
    const annonce = r.headers["content-length"];
    const declare = Array.isArray(annonce) ? annonce[0] : annonce;
    if (declare !== undefined && /^[0-9]+$/.test(declare) && Number(declare) > limit) {
      r.body.destroy();
      throw new ImageError("Réponse du moteur trop volumineuse.", {
        code: "too_large",
        detail: `${url}: ${declare} octets annoncés`,
      });
    }
    const morceaux: Buffer[] = [];
    let total = 0;
    for await (const m of r.body) {
      const morceau = m as Buffer;
      total += morceau.length;
      morceaux.push(morceau);
      if (total > limit) {
        r.body.destroy();
        throw new ImageError("Réponse du moteur trop volumineuse.", {
          code: "too_large",
          detail: `${url}: plus de ${limit} octets`,
        });
      }
    }
    return new Reply(r.statusCode, Buffer.concat(morceaux));
  } catch (e) {
    if (e instanceof ImageError) throw e;
    if (signal?.aborted) throw new CancelledError("requête annulée", { cause: signal.reason });
    const t = traduireErreur(e, entetesRecues);
    if (t instanceof CancelledError) throw t;
    if (t instanceof TimeoutException)
      throw new ImageError("Le moteur d'images ne répond pas à temps.", {
        code: "timeout",
        detail: `${url}: ${reprErreur(t)}`,
        cause: e,
      });
    throw new ImageError("Moteur d'images injoignable. " + HINT_ADMIN, {
      code: "unavailable",
      detail: `${url}: ${reprErreur(t instanceof HTTPError ? t : e)}`,
      cause: e,
    });
  }
}

/** Message lisible d'une réponse en erreur (journal seulement) ; corps non JSON : son texte. */
export function errorExcerpt(reply: Reply): string {
  let body: unknown;
  try {
    body = reply.json();
  } catch {
    body = null;
  }
  if (estDict(body)) {
    const err = lire(body, "error");
    if (estDict(err) && veritePy(lire(err, "message"))) return prefixePy(strPy(lire(err, "message")), 300);
    if (typeof err === "string") return prefixePy(err, 300);
    for (const k of ["message", "detail"]) {
      const v = lire(body, k);
      if (veritePy(v)) return prefixePy(strPy(v), 300);
    }
  }
  return prefixePy(stripPy(reply.text), 300);
}

/** Code HTTP du moteur → `ImageError` avec le geste utile ; le détail du moteur va au journal. */
export function raiseForStatus(reply: Reply, what: string): void {
  const code = reply.statusCode;
  if (code < 400) return;
  const detail = `${what}: HTTP ${code}: ${errorExcerpt(reply)}`;
  if (code === 401 || code === 403)
    throw new ImageError("Clé API refusée par le moteur d'images. " + HINT_ADMIN, {
      code: "unavailable",
      detail,
      status: code,
    });
  if (code === 429)
    throw new ImageError("Moteur d'images saturé : réessayez dans un instant.", {
      code: "busy",
      detail,
      status: code,
    });
  if (code >= 500)
    throw new ImageError(`Moteur d'images en erreur (HTTP ${code}).`, {
      code: "engine",
      detail,
      status: code,
    });
  throw new ImageError(`Le moteur a refusé la demande (HTTP ${code}).`, {
    code: "refused",
    detail,
    status: code,
  });
}

export function jsonBody(reply: Reply, what: string): unknown {
  try {
    return reply.json();
  } catch (e) {
    throw new ImageError("Réponse illisible du moteur d'images.", {
      code: "engine",
      detail: `${what}: ${reprErreur(e)}`,
      cause: e,
    });
  }
}
