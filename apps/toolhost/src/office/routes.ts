// SPDX-License-Identifier: MIT
/** apps/toolhost/src/office/routes.ts — aperçus Office et PDF de l'éditeur (sandbox/routes_office.py) : préparation (POST, sous CSRF côté main), PDF et morceaux de grille servis depuis le cache. */
import { estErreurAgent } from "@elpis/bac";
import { estDict, HttpError, pyJsonLoadsOctets, strPy } from "@elpis/commun";
import { featureEnabled } from "@elpis/config";
import { entrees, py, reponseFichier } from "@elpis/http";
import type { FastifyReply, FastifyRequest } from "fastify";
import path from "node:path";

import type { DefinitionRoute } from "../app";
import { reponseJson, uidDe } from "../fichiers/commun";
import type { ContexteFichiers } from "../fichiers/commun";
import { KEY_RE, kindOf, pdfFile, prepare, refusAgent, sheetChunk, wantSheet } from "./apercu";
import { ErreurOffice } from "./conversion";

const IMMUTABLE = "private, max-age=86400, immutable";

function http(e: ErreurOffice): HttpError {
  return new HttpError(e.status, { code: e.code, message: e.message });
}

/** `HTTPException` d'une `OfficeError` levée par `f`. */
async function traduire<T>(f: () => Promise<T>): Promise<T> {
  try {
    return await f();
  } catch (e) {
    if (e instanceof ErreurOffice) throw http(e);
    throw e;
  }
}

const invalide = (message: string): HttpError => new HttpError(400, { code: "invalid", message });

function entetesCache(): Record<string, string> {
  return {
    "cache-control": IMMUTABLE,
    "x-content-type-options": "nosniff",
    "referrer-policy": "same-origin",
  };
}

/** `FileResponse` ; flux coupé ou en échec après les en-têtes : connexion fermée et réponse détournée (l'enveloppe ne renvoie rien). */
async function servir(...args: Parameters<typeof reponseFichier>): Promise<FastifyReply> {
  const reponse = args[1];
  try {
    await reponseFichier(...args);
  } catch (e) {
    if (!reponse.raw.headersSent) throw e;
    reponse.raw.destroy(e instanceof Error ? e : undefined);
  }
  if (!reponse.sent && reponse.raw.headersSent) reponse.hijack();
  return reponse;
}

/** `_user_dir` : nom du dossier du compte (`P` de `P/work`). */
async function dossierCompte(ctx: ContexteFichiers, uid: number): Promise<string> {
  return path.basename(path.dirname(await ctx.bac.racine(uid)));
}

async function preparer(
  ctx: ContexteFichiers,
  requete: FastifyRequest,
  reponse: FastifyReply,
): Promise<FastifyReply> {
  const uid = uidDe(requete);
  let data: unknown;
  try {
    data = pyJsonLoadsOctets(requete.corpsBrut);
  } catch {
    throw invalide("Requête invalide");
  }
  if (!estDict(data)) throw invalide("Requête invalide");
  const chemin = Object.hasOwn(data, "path") ? data["path"] : null;
  const vue = Object.hasOwn(data, "view") ? data["view"] : null;
  if (typeof chemin !== "string" || !chemin || Array.from(chemin).length > 1024)
    throw invalide("Chemin invalide");
  if (vue !== null && vue !== "grid" && vue !== "pages") throw invalide("Vue invalide");
  const kind = kindOf(chemin);
  if (kind === null) throw http(new ErreurOffice("unsupported", 415, "Format non pris en charge"));
  if (kind !== "pdf" && !featureEnabled("office_preview"))
    throw http(new ErreurOffice("disabled", 403, "Aperçu Office désactivé"));
  const racine = await ctx.bac.racine(uid);
  let agent;
  try {
    agent = await ctx.bac.agent(uid);
  } catch (e) {
    if (estErreurAgent(e)) throw http(refusAgent(e));
    throw e;
  }
  const rendu = await traduire(() =>
    prepare({ uid, userDir: path.basename(path.dirname(racine)), racine, chemin, vue, agent }),
  );
  return reponseJson(reponse, rendu);
}

async function pdf(
  ctx: ContexteFichiers,
  requete: FastifyRequest,
  reponse: FastifyReply,
): Promise<FastifyReply> {
  const uid = uidDe(requete);
  const p = entrees(requete, { path: { key: py.str(), name: py.str() } }).path;
  if (!KEY_RE.test(p.key)) throw invalide("Clé d'aperçu invalide");
  const fichier = await traduire(async () => pdfFile(await dossierCompte(ctx, uid), p.key));
  if (fichier === null) throw http(new ErreurOffice("expired", 404, "Aperçu expiré"));
  const nom = p.name.toLowerCase().endsWith(".pdf") && !p.name.includes("/") ? p.name : "document.pdf";
  return servir(requete, reponse, fichier, {
    mediaType: "application/pdf",
    headers: {
      ...entetesCache(),
      "x-frame-options": "SAMEORIGIN",
      "content-security-policy": "frame-ancestors 'self'",
    },
    filename: nom,
    contentDispositionType: "inline",
  });
}

async function morceau(
  ctx: ContexteFichiers,
  requete: FastifyRequest,
  reponse: FastifyReply,
): Promise<FastifyReply> {
  const uid = uidDe(requete);
  const p = entrees(requete, { path: { key: py.str(), sheet: py.int(), chunk: py.int() } }).path;
  if (!KEY_RE.test(p.key)) throw invalide("Clé d'aperçu invalide");
  const [fichier, taille] = await traduire(async () => {
    const dossier = await dossierCompte(ctx, uid);
    wantSheet(dossier, p.key, p.sheet);
    return sheetChunk(dossier, p.key, p.sheet, p.chunk);
  });
  if (fichier === null) throw http(new ErreurOffice("expired", 404, "Aperçu expiré"));
  const entetes = entetesCache();
  if (taille) {
    entetes["x-office-rows"] = strPy(taille.rows ?? 0);
    entetes["x-office-cols"] = strPy(taille.cols ?? 0);
    entetes["x-office-complete"] = taille.complete ? "1" : "0";
  }
  return servir(requete, reponse, fichier, { mediaType: "application/json", headers: entetes });
}

export function routesOffice(ctx: ContexteFichiers): DefinitionRoute[] {
  const route = (
    methode: "GET" | "POST",
    chemin: string,
    f: (ctx: ContexteFichiers, q: FastifyRequest, r: FastifyReply) => Promise<FastifyReply>,
  ): DefinitionRoute => ({
    methode,
    chemin,
    processus: ["toolhost"],
    acces: "enveloppe",
    traiter: (q, r) => f(ctx, q, r),
  });
  return [
    route("POST", "/api/sandbox/office/prepare", preparer),
    route("GET", "/api/sandbox/office/pdf/:key/:name", pdf),
    route("GET", "/api/sandbox/office/sheet/:key/:sheet/:chunk", morceau),
  ];
}
