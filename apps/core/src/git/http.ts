// SPDX-License-Identifier: MIT
/** apps/core/src/git/http.ts — client JSON des API git (shared_infra/git/_http.py) : GET ou POST JSON, redirections suivies comme urllib, garde SSRF à chaque saut sur des adresses épinglées, identifiants jamais transmis à un autre hôte ; ne lève jamais. */
import type { LookupFunction } from "node:net";
import { createSecureContext } from "node:tls";
import type { SecureContext } from "node:tls";

import { Agent, request } from "undici";
import type { Dispatcher } from "undici";

import {
  ErreurPython,
  hostname,
  port,
  prefixePy,
  pyJsonDumps,
  pyJsonLoads,
  quoteLatin1,
  stripPy,
  urljoin,
  urlparse,
  urlsplit,
  urlunparse,
} from "@elpis/commun";
import type { Dict } from "@elpis/commun";
import { autoritesTls } from "@elpis/http";
import { cibleNonAmbigue } from "@elpis/securite";
import type { Resolveur } from "@elpis/securite";

import { gardeGit } from "./garde";

const REDIRECTIONS: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);
// En-têtes de contenu retirés quand une redirection change un POST en GET (`CONTENT_HEADER` d'urllib).
const ENTETES_CONTENU: ReadonlySet<string> = new Set(["content-length", "content-type"]);
const MAX_REDIRECTIONS = 10;
const MAX_REPETITIONS = 4;
const INF_MSG =
  "The HTTP server returned a redirect error that would lead to an infinite loop.\nThe last 30x error message was:\n";
// En-têtes porteurs d'un identifiant : retirés si une redirection change d'hôte ou passe de https à http.
const ENTETES_SECRETS: ReadonlySet<string> = new Set(["authorization", "private-token"]);
const DECODEUR = new TextDecoder("utf-8", { ignoreBOM: true });
export const PLAFOND_CORPS = 8 * 1024 * 1024;

let contexte: SecureContext | null = null;

/** Contexte TLS des appels sortants : CA de `autoritesTls()` (PKI interne, E21), construit une fois. */
function contexteTls(): SecureContext {
  contexte ??= createSecureContext({ ca: [...autoritesTls()] });
  return contexte;
}

/** Cible lue par undici (WHATWG) : refusée si elle ne désigne pas le même hôte et le même port que `urlsplit` (garde contre un écart d'analyse). */
function cibleWhatwg(url: string): URL | string {
  const p = urlsplit(url);
  if (p.scheme !== "http" && p.scheme !== "https") return `Network: unknown url type: ${p.scheme}`;
  return cibleNonAmbigue(url) ?? "Network: URL refusée (hôte ambigu)";
}

/** Une redirection qui change d'hôte, de port effectif (hors montée http:80 → https:443) ou passe de https à http ne transporte plus d'identifiant. */
export function retirerIdentifiants(courante: string, nouvelle: string): boolean {
  const a = urlsplit(courante);
  const b = urlsplit(nouvelle);
  const pa = port(a) || (a.scheme === "https" ? 443 : 80);
  const pb = port(b) || (b.scheme === "https" ? 443 : 80);
  const montee = a.scheme === "http" && b.scheme === "https" && pa === 80 && pb === 443;
  return (
    hostname(a) !== hostname(b) || (pa !== pb && !montee) || (a.scheme === "https" && b.scheme === "http")
  );
}

/** Corps lu en flux, `null` au-delà de `PLAFOND_CORPS` (lecture interrompue). */
async function lireCorps(corps: Dispatcher.ResponseData["body"]): Promise<Buffer | null> {
  const morceaux: Buffer[] = [];
  let total = 0;
  for await (const m of corps as AsyncIterable<Buffer>) {
    total += m.length;
    if (total > PLAFOND_CORPS) {
      corps.destroy();
      return null;
    }
    morceaux.push(m);
  }
  return Buffer.concat(morceaux);
}

/** `lookup` de la connexion : les seules adresses validées par la garde pour ce nom, sans nouvelle résolution. */
function rechercheEpinglee(epingles: ReadonlyMap<string, readonly string[]>): LookupFunction {
  return (hote, options, rappel) => {
    const adresses = (epingles.get(hote.toLowerCase()) ?? []).map((a) => ({
      address: a,
      family: a.includes(":") ? 6 : 4,
    }));
    const premiere = adresses[0];
    if (premiere === undefined)
      rappel(Object.assign(new Error(`getaddrinfo ENOTFOUND ${hote}`), { code: "ENOTFOUND" }), "", 0);
    else if (options.all) rappel(null, adresses);
    else rappel(null, premiere.address, premiere.family);
  };
}

function texte(octets: Buffer): string {
  return DECODEUR.decode(octets);
}

/** `json.loads(raw) if raw else {}`, `{"_raw": raw[:500]}` si ce n'est pas du JSON. */
function corpsJson(octets: Buffer): unknown {
  const brut = texte(octets);
  if (!brut) return {};
  try {
    return pyJsonLoads(brut);
  } catch {
    return { _raw: prefixePy(brut, 500) };
  }
}

function erreurHttp(code: number, raison: string, octets: Buffer): Dict {
  return { ok: false, status: code, body: prefixePy(texte(octets), 500), error: `HTTP ${code}: ${raison}` };
}

const RESEAU: Readonly<Record<string, string>> = {
  ENOTFOUND: "[Errno -2] Name or service not known",
  EAI_AGAIN: "[Errno -3] Temporary failure in name resolution",
  ECONNREFUSED: "[Errno 111] Connection refused",
  EHOSTUNREACH: "[Errno 113] No route to host",
  ENETUNREACH: "[Errno 101] Network is unreachable",
  UND_ERR_CONNECT_TIMEOUT: "timed out",
};

function code(e: unknown): string {
  const c = (e as { code?: unknown } | null)?.code;
  return typeof c === "string" ? c : "";
}

/** Erreur d'undici → message de `http_json` (`Network: …` pour une URLError, `Type: message` sinon). */
function erreurReseau(e: unknown): Dict {
  const c = code(e) || code((e as { cause?: unknown } | null)?.cause);
  const reseau = Object.hasOwn(RESEAU, c) ? RESEAU[c] : undefined;
  if (reseau !== undefined) return { ok: false, status: 0, error: `Network: ${reseau}` };
  if (/CERT|SSL|TLS|SELF_SIGNED|UNABLE_TO_|HOSTNAME|ALTNAME/u.test(c))
    return {
      ok: false,
      status: 0,
      error: `Network: [SSL: CERTIFICATE_VERIFY_FAILED] certificate verify failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  if (c === "UND_ERR_HEADERS_TIMEOUT" || c === "UND_ERR_BODY_TIMEOUT")
    return { ok: false, status: 0, error: "TimeoutError: timed out" };
  if (c === "ECONNRESET")
    return { ok: false, status: 0, error: "ConnectionResetError: [Errno 104] Connection reset by peer" };
  if (c === "UND_ERR_SOCKET")
    return {
      ok: false,
      status: 0,
      error: "RemoteDisconnected: Remote end closed connection without response",
    };
  const nom =
    e instanceof ErreurPython
      ? e.type
      : e instanceof RangeError
        ? "ValueError"
        : e instanceof Error
          ? e.name
          : "Error";
  return { ok: false, status: 0, error: `${nom}: ${e instanceof Error ? e.message : String(e)}` };
}

function premiere(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

export interface OptionsHttp {
  readonly method?: "GET" | "POST";
  /** Corps JSON (`json.dumps`), `Content-Type: application/json` par défaut. */
  readonly body?: Dict;
  readonly headers?: Readonly<Record<string, string>>;
  readonly timeout?: number;
  readonly ssrfAllowHosts?: Iterable<string>;
  readonly ssrfAllowSchemes?: Iterable<string>;
  /** Premier saut jugé en `critical_only` (api_base d'un connecteur déjà validée, LAN permis) ; les redirections restent strictes. */
  readonly ssrfCriticalOnly?: boolean;
  /** Résolution DNS (défaut : système), une fois par requête, adresses épinglées pour la connexion. */
  readonly resoudre?: Resolveur;
}

const TROP_GROS: Dict = { ok: false, status: 0, error: "Network: réponse de plus de 8 Mio refusée" };

/** `http_json` : `{ok, status, body}` ou `{ok: false, status, body?, error}` ; garde SSRF avant chaque requête, redirections comprises ; un POST redirigé en 301-303 devient un GET sans corps, en 307-308 une erreur HTTP (urllib). */
export async function httpJson(url: string, options: OptionsHttp = {}): Promise<Dict> {
  const garde = {
    allowSchemes: [...(options.ssrfAllowSchemes ?? ["https"])],
    allowHosts: [...(options.ssrfAllowHosts ?? [])],
    ...(options.resoudre ? { resoudre: options.resoudre } : {}),
  };
  let entetes: Record<string, string> = {
    Accept: "application/json",
    "User-Agent": "elpis-git/1",
    ...options.headers,
  };
  let methode = options.method ?? "GET";
  let charge: string | undefined;
  if (options.body !== undefined) {
    charge = pyJsonDumps(options.body);
    if (!Object.keys(entetes).some((k) => k.toLowerCase() === "content-type"))
      entetes["Content-Type"] = "application/json";
  }
  const ms = (options.timeout ?? 12) * 1000;
  const epingles = new Map<string, readonly string[]>();
  const visites = new Map<string, number>();
  let courante = url;
  let agent: Agent | undefined;
  try {
    let verdict = await gardeGit(courante, { ...garde, criticalOnly: options.ssrfCriticalOnly === true });
    if (verdict.motif) return { ok: false, status: 0, error: `blocked: ${verdict.motif}` };
    agent = new Agent({
      connect: { timeout: ms, secureContext: contexteTls(), lookup: rechercheEpinglee(epingles) },
      headersTimeout: ms,
      bodyTimeout: ms,
      allowH2: false,
    });
    for (;;) {
      const cible = cibleWhatwg(courante);
      if (typeof cible === "string") return { ok: false, status: 0, error: cible };
      if (verdict.adresses !== null) epingles.set(cible.hostname.toLowerCase(), verdict.adresses);
      const r = await request(cible, {
        method: methode,
        headers: entetes,
        ...(charge === undefined ? {} : { body: charge }),
        dispatcher: agent,
      });
      const octets = await lireCorps(r.body);
      if (octets === null) return TROP_GROS;
      const raison = stripPy(r.statusText || "");
      if (r.statusCode >= 200 && r.statusCode < 300)
        return { ok: true, status: r.statusCode, body: corpsJson(octets) };
      const location = REDIRECTIONS.has(r.statusCode)
        ? (premiere(r.headers["location"]) ?? premiere(r.headers["uri"]))
        : undefined;
      if (location === undefined) return erreurHttp(r.statusCode, raison, octets);
      const parties = urlparse(location);
      if (!["http", "https", "ftp", ""].includes(parties.scheme))
        return erreurHttp(
          r.statusCode,
          `${raison} - Redirection to url '${location}' is not allowed`,
          octets,
        );
      if (!parties.path && parties.netloc) parties.path = "/";
      const nouvelle = urljoin(courante, quoteLatin1(urlunparse(parties)));
      verdict = await gardeGit(nouvelle, garde);
      if (verdict.motif) return erreurHttp(r.statusCode, `SSRF blocked redirect: ${verdict.motif}`, octets);
      if (methode === "POST") {
        if (r.statusCode === 307 || r.statusCode === 308) return erreurHttp(r.statusCode, raison, octets);
        methode = "GET";
        charge = undefined;
        entetes = Object.fromEntries(
          Object.entries(entetes).filter(([k]) => !ENTETES_CONTENU.has(k.toLowerCase())),
        );
      }
      if (retirerIdentifiants(courante, nouvelle))
        entetes = Object.fromEntries(
          Object.entries(entetes).filter(([k]) => !ENTETES_SECRETS.has(k.toLowerCase())),
        );
      if (
        visites.size > 0 &&
        ((visites.get(nouvelle) ?? 0) >= MAX_REPETITIONS || visites.size >= MAX_REDIRECTIONS)
      )
        return erreurHttp(r.statusCode, INF_MSG + raison, octets);
      visites.set(nouvelle, (visites.get(nouvelle) ?? 0) + 1);
      courante = nouvelle;
    }
  } catch (e) {
    return erreurReseau(e);
  } finally {
    await agent?.close().catch(() => undefined);
  }
}
