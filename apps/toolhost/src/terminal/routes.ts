// SPDX-License-Identifier: MIT
/** apps/toolhost/src/terminal/routes.ts — `/api/terminal/*` et `/ws/terminal[/{sid}]` (terminal/routes.py) sous jeton de service et enveloppe : session par défaut (frappe, taille, flux SSE, arrêt), sessions nommées, WebSocket. */
import { estInterSite } from "@elpis/auth";
import {
  estDict,
  reprPy,
  estErreurPython,
  getPy,
  HttpError,
  intPy,
  nomTypePy,
  pyJsonLoads,
  strPy,
  stripPy,
  texteJsonPy,
  utf8Remplace,
  veritePy,
} from "@elpis/commun";
import type { Base } from "@elpis/db";
import { ouvrirFlux } from "@elpis/http";
import { avecIdentite } from "@elpis/securite";
import type { FastifyReply, FastifyRequest } from "fastify";
import type WebSocket from "ws";

import type { DefinitionRoute, Famille } from "../app";
import { uidDe } from "../bac/routes-me";
import type { Journal } from "../journal";
import { introuvable } from "../porte";
import { reponseJson } from "../socle";
import { DEFAULT_SID, MAX_SESSIONS_PER_USER } from "./pty";
import type { Consommateur, Terminaux } from "./pty";
import { quotaOctets, usageBac } from "./quota";
import { nomBorne, nomParDefaut, sidValide } from "./sessions";
import type { SessionsTerminal } from "./sessions";
import { abandonner, boucleWs, fermer, tamponner } from "./ws";

export interface ContexteTerminal {
  readonly terminaux: Terminaux;
  readonly sessions: SessionsTerminal;
  readonly base: () => Promise<Base>;
  readonly journal: Journal;
  readonly arret?: AbortSignal | undefined;
}

const KEEPALIVE_MS = 15_000;
const SONDE_TOUS_LES = 33;

function attributManquant(v: unknown, nom: string): TypeError {
  return new TypeError(`'${nomTypePy(v)}' object has no attribute '${nom}'`);
}

/** `POST /api/terminal/input` : frappe vers le PTY par défaut (créé au besoin) ; rien d'envoyé pour un texte vide. */
async function entree(
  ctx: ContexteTerminal,
  requete: FastifyRequest,
  reponse: FastifyReply,
): Promise<FastifyReply> {
  const uid = uidDe(requete);
  const texte = getPy(corpsPy(requete), "data", "");
  if (!veritePy(texte)) return reponseJson(reponse, { ok: true });
  const term = await ctx.terminaux.obtenir(uid);
  if (typeof texte !== "string") throw attributManquant(texte, "encode");
  try {
    term.ecrire(utf8Remplace(texte));
  } catch {
    return reponseJson(reponse, { ok: false, error: "terminal closed" });
  }
  return reponseJson(reponse, { ok: true });
}

/** `POST /api/terminal/resize` : lignes et colonnes validées (400) avant la création éventuelle du PTY. */
async function taille(
  ctx: ContexteTerminal,
  requete: FastifyRequest,
  reponse: FastifyReply,
): Promise<FastifyReply> {
  const uid = uidDe(requete);
  const [lignes, colonnes] = lireTaille(corpsPy(requete));
  const term = await ctx.terminaux.obtenir(uid);
  term.redimensionner(lignes, colonnes);
  return reponseJson(reponse, { ok: true });
}

/** `GET /api/terminal/stream` : sortie du PTY par défaut en SSE (base64), battement toutes les 15 s, quota sondé toutes les 33 trames. */
async function flux(ctx: ContexteTerminal, requete: FastifyRequest, reponse: FastifyReply): Promise<void> {
  const uid = uidDe(requete);
  const term = await ctx.terminaux.obtenir(uid);
  const quota = await quotaOctets(ctx.base, uid);
  const sortie = ouvrirFlux(
    reponse,
    {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      "x-accel-buffering": "no",
    },
    ctx.arret,
  );
  const brut = reponse.raw;
  let fini = false;
  let trames = 0;
  let sondeEnCours = false;
  let battement: NodeJS.Timeout | undefined;

  const finir = (eof: boolean): void => {
    if (fini) return;
    fini = true;
    clearTimeout(battement);
    term.detacher(consommateur);
    if (eof) ecrire("data: [EOF]\n\n");
    sortie.fermer();
  };
  let drainAttendu = false;
  const ecrire = (texte: string): void => {
    if (brut.writableEnded || brut.destroyed) return;
    if (!brut.write(texte) && !drainAttendu) {
      drainAttendu = true;
      term.pause(consommateur, true);
      brut.once("drain", () => {
        drainAttendu = false;
        term.pause(consommateur, false);
      });
    }
  };
  const armer = (): void => {
    clearTimeout(battement);
    battement = setTimeout(() => {
      if (fini) return;
      ecrire(": keepalive\n\n");
      armer();
    }, KEEPALIVE_MS);
    battement.unref();
  };
  const sonder = async (): Promise<void> => {
    if (sondeEnCours) return;
    sondeEnCours = true;
    let utilise: number;
    try {
      utilise = await usageBac(uid, term.racine, quota);
    } catch {
      return;
    } finally {
      sondeEnCours = false;
    }
    if (fini || utilise <= quota) return;
    ecrire(
      `data: ${Buffer.from("\r\n\x1b[41;97m ⚠  QUOTA DÉPASSÉ \x1b[0m\r\n", "utf-8").toString("base64")}\n\n`,
    );
    term.tuer();
    finir(true);
  };
  const consommateur: Consommateur = {
    donnees: (morceau) => {
      if (fini) return;
      ecrire(`data: ${morceau.toString("base64")}\n\n`);
      armer();
      trames += 1;
      if (trames >= SONDE_TOUS_LES) {
        trames = 0;
        void sonder();
      }
    },
    fin: () => finir(true),
    remplace: () => finir(false),
  };

  sortie.signal.addEventListener("abort", () => finir(ctx.arret?.aborted === true), { once: true });
  if (sortie.signal.aborted) return finir(ctx.arret?.aborted === true);
  armer();
  term.attacher(consommateur);
}

/** `POST /api/terminal/sessions` : nom donné (64 caractères au plus) ou premier « Terminal N » libre ; 429 au-delà de 4. */
async function creerSession(
  ctx: ContexteTerminal,
  requete: FastifyRequest,
  reponse: FastifyReply,
): Promise<FastifyReply> {
  const uid = uidDe(requete);
  let nom = nomDeCreation(corpsOuVide(requete));
  if (!nom) {
    try {
      nom = nomParDefaut((await ctx.sessions.lister(uid)).map((r) => r.name));
    } catch {
      nom = "Terminal 1";
    }
  }
  const ligne = await ctx.sessions.inserer(uid, null, nom);
  return reponseJson(reponse, { ok: true, session: ligne, max: MAX_SESSIONS_PER_USER });
}

/** `await request.json()` : `json.loads` du corps (`1.0` reste un flottant) ; illisible : l'erreur remonte (500 du toolhost). */
function corpsPy(requete: FastifyRequest): unknown {
  return pyJsonLoads(texteJsonPy(requete.corpsBrut));
}

/** `await request.json()` sous `try` : corps illisible = `{}`. */
function corpsOuVide(requete: FastifyRequest): unknown {
  try {
    return corpsPy(requete);
  } catch {
    return {};
  }
}

/** Nom demandé à la création : `str(body.get("name") or "").strip()[:64]` (vide : nom par défaut). */
export function nomDeCreation(corps: unknown): string {
  const donne = estDict(corps) ? getPy(corps, "name", null) : null;
  return nomBorne(strPy(veritePy(donne) ? donne : ""));
}

/** `max(1, int(rows))`, `max(1, int(cols))` ; TypeError ou ValueError → 400, le reste remonte (500). */
export function lireTaille(data: unknown): [number, number] {
  try {
    return [Math.max(1, intPy(getPy(data, "rows", 24))), Math.max(1, intPy(getPy(data, "cols", 80)))];
  } catch (e) {
    if (estErreurPython(e, "TypeError", "ValueError"))
      throw new HttpError(400, "rows/cols doivent être des entiers positifs");
    throw e;
  }
}

function sidDe(requete: FastifyRequest): string {
  return (requete.params as { sid: string }).sid;
}

async function renommer(
  ctx: ContexteTerminal,
  requete: FastifyRequest,
  reponse: FastifyReply,
): Promise<FastifyReply> {
  const uid = uidDe(requete);
  const sid = sidDe(requete);
  if (!sidValide(sid)) throw new HttpError(400, "invalid sid");
  const corps = corpsPy(requete);
  let nom = "";
  if (estDict(corps)) {
    const donne = getPy(corps, "name", null);
    const brut = veritePy(donne) ? donne : "";
    if (typeof brut !== "string") throw attributManquant(brut, "strip");
    nom = stripPy(brut);
  }
  if (!nom) throw new HttpError(400, "name required");
  if (!(await ctx.sessions.renommer(sid, uid, nom))) throw new HttpError(404, "session not found");
  return reponseJson(reponse, { ok: true });
}

/** `DELETE /api/terminal/sessions/{sid}` : ligne supprimée puis PTY de ce process tué (même sans ligne). */
async function supprimer(
  ctx: ContexteTerminal,
  requete: FastifyRequest,
  reponse: FastifyReply,
): Promise<FastifyReply> {
  const uid = uidDe(requete);
  const sid = sidDe(requete);
  if (!sidValide(sid)) throw new HttpError(400, "invalid sid");
  const supprimee = await ctx.sessions.supprimer(sid, uid);
  ctx.terminaux.tuerSession(uid, sid);
  if (!supprimee) throw new HttpError(404, "session not found");
  return reponseJson(reponse, { ok: true });
}

/** `/ws/terminal[/{sid}]` : accepté puis fermé avec un code lisible (4003 inter-site, 4002 sid invalide, 4004 session inconnue, 1011 PTY impossible). */
async function terminalWs(
  ctx: ContexteTerminal,
  socket: WebSocket,
  requete: FastifyRequest,
  nomme: boolean,
): Promise<void> {
  const tampon = tamponner(socket);
  const uid = uidDe(requete);
  const refuser = (code: number, raison = ""): void => {
    abandonner(socket, tampon, uid, ctx);
    fermer(socket, code, raison);
  };
  if (estInterSite(requete.headers)) {
    ctx.journal.warn(`[PTY-WS] handshake cross-site refusé origin=${reprPy(requete.headers.origin ?? null)}`);
    return refuser(4003, "cross-site refused");
  }
  const sid = nomme ? sidDe(requete) : DEFAULT_SID;
  try {
    if (nomme) {
      if (!sidValide(sid)) return refuser(4002, "invalid sid");
      if ((await ctx.sessions.obtenir(sid, uid)) === null) return refuser(4004, "session not found");
    }
  } catch (e) {
    ctx.journal.warn(`[PTY-WS] session uid=${uid} sid=${sid} : ${(e as Error).message}`);
    return refuser(1011);
  }
  let term;
  try {
    term = await ctx.terminaux.obtenir(uid, sid);
  } catch (e) {
    ctx.journal.warn(
      `[PTY-WS] spawn failed uid=${uid}${nomme ? ` sid=${sid}` : ""}: ${(e as Error).message}`,
    );
    return refuser(1011);
  }
  if (nomme) await ctx.sessions.toucher(sid);
  await boucleWs(socket, term, ctx, tampon);
}

/** Requête HTTP ordinaire sur un chemin WebSocket : le montage `/` du service MCP répond 404 en texte. */
function pasUnWs(_requete: FastifyRequest, reponse: FastifyReply): FastifyReply {
  return introuvable(reponse);
}

export function creerFamilleTerminal(ctx: ContexteTerminal): Famille {
  const route = (
    methode: DefinitionRoute["methode"],
    chemin: string,
    traiter: (c: ContexteTerminal, q: FastifyRequest, r: FastifyReply) => unknown,
  ): DefinitionRoute => ({
    methode,
    chemin,
    processus: ["toolhost"],
    acces: "enveloppe",
    traiter: (q, r) => traiter(ctx, q, r),
  });
  return {
    nom: "terminal",
    routes: [
      route("POST", "/api/terminal/input", entree),
      route("POST", "/api/terminal/resize", taille),
      route("GET", "/api/terminal/stream", flux),
      route("POST", "/api/terminal/kill", (c, q, r) => {
        c.terminaux.tuerSession(uidDe(q), DEFAULT_SID);
        return reponseJson(r, { ok: true });
      }),
      route("POST", "/api/terminal/sessions", creerSession),
      route("GET", "/api/terminal/sessions", async (c, q, r) =>
        reponseJson(r, { sessions: await c.sessions.lister(uidDe(q)), max: MAX_SESSIONS_PER_USER }),
      ),
      route("PATCH", "/api/terminal/sessions/:sid", renommer),
      route("DELETE", "/api/terminal/sessions/:sid", supprimer),
      {
        ...route("GET", "/ws/terminal", (_c, q, r) => pasUnWs(q, r)),
        ws: (socket, q) => avecIdentite(q.identite, () => terminalWs(ctx, socket, q, false)),
      },
      {
        ...route("GET", "/ws/terminal/:sid", (_c, q, r) => pasUnWs(q, r)),
        ws: (socket, q) => avecIdentite(q.identite, () => terminalWs(ctx, socket, q, true)),
      },
    ],
  };
}
