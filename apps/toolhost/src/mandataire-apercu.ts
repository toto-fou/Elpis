// SPDX-License-Identifier: MIT
/** apps/toolhost/src/mandataire-apercu.ts — aperçu d'un serveur lancé dans le conteneur du compte (routes_lifecycle.py `_preview_proxy`) : `/api/sandbox/preview/{port}/…` et `/api/sandbox/pvs/{token}/{port}/…`. */
import { Readable } from "node:stream";

import type { IpConteneurApercu } from "@elpis/bac";

import { HttpError, reprPy } from "@elpis/commun";
import {
  cheminDecode,
  corpsLu,
  decouperCible,
  erreurValidation,
  installerCorpsBorne,
  premierEntete,
  py,
  validerPy,
} from "@elpis/http";
import type { FastifyReply, FastifyRequest } from "fastify";
import { Client } from "undici";
import type { Dispatcher } from "undici";

import { exigerJetonCanonique } from "./apercu-fichiers";
import type { Famille } from "./app";
import type { Journal } from "./journal";

export interface ContexteMandataire {
  readonly journal: Journal;
  readonly ipConteneur: IpConteneurApercu;
}

export const CHEMIN_PREVIEW = "/api/sandbox/preview/:port/*";
export const CHEMIN_PVS = "/api/sandbox/pvs/:token/:port/*";
// `{x}` = `[^/]+`, `{path:path}` = `.*` sans DOTALL, `$` admis avant un saut de ligne final (`re` de Python).
const MOTIF_PREVIEW = /^\/api\/sandbox\/preview\/([^/]+)\/([^\n]*)\n?$/u;
const MOTIF_PVS = /^\/api\/sandbox\/pvs\/([^/]+)\/([^/]+)\/([^\n]*)\n?$/u;

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailers",
  "transfer-encoding",
  "upgrade",
  "content-length",
]);
// Agissent au niveau réseau sur l'origine réelle de l'app, hors de portée du `CSP: sandbox` (fixation de session…) ; les cinq derniers en plus du Python.
const RETIRES_DE_LA_REPONSE = new Set([
  "set-cookie",
  "set-cookie2",
  "clear-site-data",
  "strict-transport-security",
  "public-key-pins",
  "content-security-policy",
  "content-security-policy-report-only",
  "report-to",
  "reporting-endpoints",
  "access-control-allow-origin",
  "access-control-allow-credentials",
  "service-worker-allowed",
  "alt-svc",
  "accept-ch",
  "critical-ch",
  "set-login",
  "nel",
]);
const TRANSMIS = ["accept", "accept-language", "content-type", "range", "if-none-match", "if-modified-since"];
export const CORPS_MAX = 10 * 1024 * 1024;
// Caractères laissés tels quels par `quote` d'httpx 0.28 (non réservés + PATH_SAFE / QUERY_SAFE, `%` compris).
const A_CODER_CHEMIN = /[^\x21\x24-\x3b\x3d\x40-\x5f\x61-\x7a\x7c\x7e]/gu;
const A_CODER_REQUETE = /[^\x21\x24-\x3b\x3d\x3f-\x7e]/gu;

interface Segments {
  readonly jeton: string | null;
  readonly port: number;
  readonly chemin: string;
}

interface Demande extends Segments {
  readonly uid: number;
  readonly ip: string | null;
}

const demandes = new WeakMap<FastifyRequest, Promise<Demande>>();

function encoder(texte: string, motif: RegExp): string {
  return texte.replace(motif, (c) =>
    [...Buffer.from(c, "utf8")].map((o) => `%${o.toString(16).toUpperCase().padStart(2, "0")}`).join(""),
  );
}

/** `normalize_path` d'httpx : segments `.` et `..` retirés. */
function sansPoints(chemin: string): string {
  const parties = chemin.split("/");
  if (!parties.includes(".") && !parties.includes("..")) return chemin;
  const sortie: string[] = [];
  for (const p of parties) {
    if (p === "..") {
      if (sortie.length > 0 && !(sortie.length === 1 && sortie[0] === "")) sortie.pop();
    } else if (p !== ".") sortie.push(p);
  }
  return sortie.join("/");
}

/** Cible envoyée à l'amont pour `http://ip:port/{chemin}?{requête}` construite comme httpx (`?` et `#` du chemin décodé compris) ; caractère de contrôle : InvalidURL (500). */
export function cibleAmont(chemin: string, requete: string): string {
  const url = `/${chemin}${requete ? `?${requete}` : ""}`;
  const controle = /(?=\p{ASCII})\p{Cc}/u.exec(url);
  if (controle) throw new Error(`Invalid non-printable ASCII character in URL, ${reprPy(controle[0])}`);
  const m = /^([^?#]*)(?:\?([^#]*))?/u.exec(url) as RegExpExecArray;
  const p = encoder(sansPoints(m[1] ?? ""), A_CODER_CHEMIN) || "/";
  return m[2] === undefined ? p : `${p}?${encoder(m[2], A_CODER_REQUETE)}`;
}

const UTF8_STRICT = new TextDecoder("utf-8", { fatal: true });

/** `request.url.query` de Starlette : URL refaite du chemin décodé (un `?` décodé y ouvre la requête) puis `urlsplit` (tabulations et sauts de ligne retirés, fragment coupé). */
export function requeteStarlette(cheminDecode: string, brute: string): string {
  const requete = UTF8_STRICT.decode(Buffer.from(brute, "latin1"));
  const url = `${cheminDecode}${requete ? `?${requete}` : ""}`.replace(/[\t\r\n]/gu, "");
  const avant = url.split("#", 1)[0] ?? "";
  const i = avant.indexOf("?");
  return i < 0 ? "" : avant.slice(i + 1);
}

/** Segments du chemin décodé ; port validé comme le paramètre `port: int` de FastAPI (422), puis jeton de pvs sous la forme émise par main (403). */
function segments(requete: FastifyRequest): Segments {
  const decode = cheminDecode(requete);
  const pvs = MOTIF_PVS.exec(decode);
  const m = (pvs ?? MOTIF_PREVIEW.exec(decode)) as RegExpExecArray;
  const r = validerPy(py.int(), pvs ? pvs[2] : m[1], ["path", "port"]);
  if (!r.ok) throw erreurValidation(r.erreurs);
  if (pvs) exigerJetonCanonique(pvs[1] ?? "");
  return {
    jeton: pvs ? (pvs[1] ?? "") : null,
    port: r.horsBornes ? Infinity : r.valeur,
    chemin: (pvs ? pvs[3] : m[2]) ?? "",
  };
}

async function resoudre(ctx: ContexteMandataire, requete: FastifyRequest): Promise<Demande> {
  const s = segments(requete);
  if (!(s.port >= 1 && s.port <= 65535)) throw new HttpError(400, "Port invalide");
  const uid = Math.trunc(requete.identite?.user_id ?? 0);
  return { ...s, uid, ip: await ctx.ipConteneur.ip(uid, requete.identite?.username ?? `user_${uid}`) };
}

/** Port, compte et IP résolus une fois, avant la lecture du corps comme en Python (422, 400, 409 avant 413). */
function demande(ctx: ContexteMandataire, requete: FastifyRequest): Promise<Demande> {
  let d = demandes.get(requete);
  if (d === undefined) {
    d = resoudre(ctx, requete);
    demandes.set(requete, d);
  }
  return d;
}

/** `_preview_error_html` : page courte, jamais en cache. */
function page(
  reponse: FastifyReply,
  statut: number,
  titre: string,
  detail: string,
  cors: Record<string, string>,
): FastifyReply {
  return reponse
    .code(statut)
    .headers({ "cache-control": "no-store", ...cors })
    .type("text/html; charset=utf-8")
    .send(
      "<!doctype html><meta charset='utf-8'>" +
        '<body style="margin:0;display:flex;align-items:center;justify-content:center;' +
        "min-height:100vh;background:#f8fafc;color:#334155;" +
        'font:14px/1.6 system-ui,sans-serif">' +
        "<div style='max-width:420px;padding:24px;text-align:center'>" +
        `<div style='font-weight:600;margin-bottom:6px'>${titre}</div>` +
        `<div style='font-size:12.5px;color:#64748b'>${detail}</div>` +
        "</div></body>",
    );
}

/** En-têtes de l'amont relayés (doublons joints comme `Headers.items()` d'httpx), Location ramenée sous le préfixe, origine opaque imposée. */
function entetesRelayes(
  amont: Dispatcher.ResponseData["headers"],
  base: string,
  prefixe: string,
): Record<string, string> {
  const sortie: Record<string, string> = {};
  for (const [nom, brute] of Object.entries(amont)) {
    if (brute === undefined || HOP_BY_HOP.has(nom) || RETIRES_DE_LA_REPONSE.has(nom)) continue;
    let v = Array.isArray(brute) ? brute.join(", ") : brute;
    if (nom === "location") {
      if (v.startsWith(base)) v = prefixe + v.slice(base.length);
      else if (v.startsWith("/")) v = prefixe + v;
    }
    sortie[nom] = v;
  }
  sortie["content-security-policy"] = "sandbox allow-scripts allow-forms";
  sortie["x-content-type-options"] = "nosniff";
  sortie["cache-control"] = "no-store";
  sortie["x-robots-tag"] = "noindex";
  if ((sortie["content-type"] ?? "").includes("text/event-stream")) sortie["x-accel-buffering"] = "no";
  return sortie;
}

/** Corps de l'amont ; coupé en route (serveur arrêté, OOM…), le flux se termine proprement et la cause est journalisée. */
async function* relayer(corps: Readable, port: number, journal: Journal): AsyncGenerator<Buffer> {
  try {
    for await (const morceau of corps) yield morceau as Buffer;
  } catch (e) {
    journal.info(`[sandbox-preview] flux amont interrompu (port ${port}) : ${reprPy(String(e))}`);
  }
}

/** Requête relayée au serveur du conteneur ; en-tête non ASCII refusé comme httpx (500), amont injoignable : IP oubliée (le conteneur a pu changer d'adresse) et page 502 ; statut que Fastify refuse (hors 100–599) : flux et client fermés, 500. */
async function mandater(
  ctx: ContexteMandataire,
  requete: FastifyRequest,
  reponse: FastifyReply,
  d: Demande,
): Promise<FastifyReply> {
  const cors: Record<string, string> = d.jeton === null ? {} : { "access-control-allow-origin": "*" };
  if (!d.ip)
    return page(
      reponse,
      409,
      "Sandbox injoignable",
      "Le conteneur n'est pas démarré, ou son profil réseau est " +
        "« Isolé » (aucune adresse IP). Choisissez un profil réseau " +
        "connecté dans Paramètres → Sandbox, puis relancez le serveur.",
      cors,
    );
  const prefixe =
    d.jeton === null ? `/api/sandbox/preview/${d.port}` : `/api/sandbox/pvs/${d.jeton}/${d.port}`;
  const base = `http://${d.ip}:${d.port}`;
  const transmis: Record<string, string> = { accept: "*/*", "accept-encoding": "gzip, deflate" };
  for (const nom of TRANSMIS) {
    const v = premierEntete(requete, nom);
    if (v) transmis[nom] = v;
  }
  const corps = requete.method === "POST" ? corpsLu(requete) : undefined;
  const brute = decouperCible(requete.originalUrl).requete;
  const cible = cibleAmont(d.chemin, requeteStarlette(cheminDecode(requete), brute));
  if (Object.values(transmis).some((v) => /\P{ASCII}/u.test(v)))
    throw new Error("'ascii' codec can't encode characters in header value");
  const client = new Client(base, { connect: { timeout: 3_000 }, headersTimeout: 30_000, bodyTimeout: 0 });
  let amont: Dispatcher.ResponseData;
  try {
    amont = await client.request({
      path: cible,
      method: requete.method as Dispatcher.HttpMethod,
      headers: transmis,
      ...(corps !== undefined ? { body: corps } : {}),
    });
  } catch (e) {
    void client.destroy();
    if ((e as { code?: unknown }).code === "UND_ERR_INVALID_ARG") throw e;
    ctx.ipConteneur.oublier(d.uid);
    return page(
      reponse,
      502,
      `Aucun serveur sur le port ${d.port}`,
      "Rien ne répond à cette adresse dans la sandbox. Démarrez un " +
        "serveur (ex. python3 -m http.server) sur ce port, ou vérifiez " +
        "le numéro.",
      cors,
    );
  }
  const flux = Readable.from(relayer(amont.body, d.port, ctx.journal), { objectMode: false });
  flux.once("close", () => {
    amont.body.on("error", () => undefined).destroy();
    void client.destroy();
  });
  try {
    return reponse
      .code(amont.statusCode)
      .headers({ ...entetesRelayes(amont.headers, base, prefixe), ...cors })
      .send(flux);
  } catch (e) {
    flux.destroy();
    throw e;
  }
}

async function traiter(
  ctx: ContexteMandataire,
  requete: FastifyRequest,
  reponse: FastifyReply,
): Promise<FastifyReply> {
  if (requete.method === "OPTIONS") {
    segments(requete);
    return reponse
      .code(204)
      .headers({
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET, HEAD, POST",
        "access-control-allow-headers": (
          premierEntete(requete, "access-control-request-headers") ?? "content-type"
        ).slice(0, 500),
        "access-control-max-age": "600",
      })
      .send();
  }
  return mandater(ctx, requete, reponse, await demande(ctx, requete));
}

export function creerFamilleMandataireApercu(ctx: ContexteMandataire): Famille {
  return {
    nom: "mandataire-apercu",
    contexte: (app) =>
      installerCorpsBorne(app, (req) => {
        if (req.method === "OPTIONS") return { limite: 0, avant: () => false };
        if (req.method !== "POST") return null;
        return {
          limite: CORPS_MAX,
          message: "Corps de requête trop volumineux",
          avant: async () => (await demande(ctx, req)).ip !== null,
        };
      }),
    routes: [
      {
        methode: ["GET", "HEAD", "POST"],
        chemin: CHEMIN_PREVIEW,
        motifsStarlette: [MOTIF_PREVIEW],
        processus: ["toolhost"],
        acces: "enveloppe",
        traiter: (req, rep) => traiter(ctx, req, rep),
      },
      {
        methode: ["GET", "HEAD", "POST", "OPTIONS"],
        chemin: CHEMIN_PVS,
        motifsStarlette: [MOTIF_PVS],
        processus: ["toolhost"],
        acces: "enveloppe",
        traiter: (req, rep) => traiter(ctx, req, rep),
      },
    ],
  };
}
