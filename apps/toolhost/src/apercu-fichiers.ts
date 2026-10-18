// SPDX-License-Identifier: MIT
/** apps/toolhost/src/apercu-fichiers.ts — aperçu « Web » des fichiers du bac (routes_files.py `api_preview_sandbox`) : `/api/sandbox/pv/{token}/…`, identité de l'enveloppe, HTML et CSS réécrits, CORS `*`. */
import { agentFor, estErreurAgent, racineTravail } from "@elpis/bac";
import type { AgentBac } from "@elpis/bac";
import { getPy, guessTypePy, HttpError, lowerPy, stripPy } from "@elpis/commun";
import type { Dict } from "@elpis/commun";
import { agentHttp, parAgent } from "@elpis/fichiers";
import { cheminDecode } from "@elpis/http";
import { stripWorkPrefix, usernameFor } from "@elpis/securite";
import type { FastifyReply, FastifyRequest } from "fastify";

import type { Famille } from "./app";
import {
  MAX_REWRITE_BYTES,
  RESOLVER,
  resolverBase,
  rewriteCss,
  rewriteHtml,
  splitResolver,
} from "./apercu-reecriture";
import { entetesSecurite, fichierAgent, relEditeur, reponseAgent, typeAvecCharset } from "./reponse-agent";
import type { AgentLecture } from "./reponse-agent";

export const CHEMIN_PV = "/api/sandbox/pv/:token/*";
// `{token}` = `[^/]+`, `{path:path}` = `.*` sans DOTALL, `$` admis avant un saut de ligne final (`re` de Python).
const MOTIF_PV = /^\/api\/sandbox\/pv\/([^/]+)\/([^\n]*)\n?$/u;
export const PREVIEW_URL_PREFIX = "/api/sandbox/pv/";
const ROOT_WALK_MAX = 8;
const INTROUVABLE_A_LA_LECTURE = new Set(["not_found", "is_dir", "not_file", "too_large", "outside_root"]);
const CORS: Readonly<Record<string, string>> = { "access-control-allow-origin": "*" };
const UTF8 = new TextDecoder("utf-8", { ignoreBOM: true });
// Forme émise par main (`makePreviewToken`) ; main accepte aussi blancs et chiffres Unicode (`int()`), jamais réinjectés ici.
const JETON_CANONIQUE = /^[0-9]+-[0-9]+-[0-9a-f]{32}$/u;

/** Dossier de travail du compte sur l'hôte (`_get_work_path`) et agent de son conteneur (`agent_for`). */
export interface BacDuCompte {
  racine(uid: number): Promise<string>;
  agent(uid: number): Promise<AgentLecture>;
}

/** L'agent de la fabrique posée par la composition (`AgentClient`) lit aussi les fichiers (`stat`, `read`). */
function agentLecture(agent: AgentBac): AgentLecture {
  const a = agent as Partial<AgentLecture>;
  if (typeof a.stat !== "function" || typeof a.read !== "function")
    throw new Error("agent du bac sans stat/read : fabrique d'agent de l'hôte non posée");
  return agent as unknown as AgentLecture;
}

/** Bac du compte selon @elpis/bac : `P/work` du nom résolu (enveloppe, base, `user_<id>`) et `agent_for`. */
export const BAC_DU_COMPTE: BacDuCompte = {
  racine: async (uid) => racineTravail(await usernameFor(uid)),
  agent: async (uid) => agentLecture(await agentFor(uid)),
};

/** Jeton du chemin réinjecté dans la page (résolveur, Location) seulement sous la forme émise par main ; sinon 403 comme un jeton refusé. */
export function exigerJetonCanonique(jeton: string): void {
  if (!JETON_CANONIQUE.test(jeton)) throw new HttpError(403, "Aperçu expiré : rechargez-le");
}

/** `PurePosixPath(p).parts` sans « », « . » ni « / » (un `//` de tête reste une partie, comme en Python). */
function parties(p: string): string[] {
  const tete = /^\/\/(?!\/)/u.test(p) ? ["//"] : [];
  return [...tete, ...p.split("/").filter((x) => x !== "" && x !== ".")];
}

/** `_resolve_from` : `voulu` cherché dans le dossier du document puis en remontant (8 niveaux au plus), candidats vérifiés en une requête à l'agent. */
async function resoudreDepuis(
  bac: BacDuCompte,
  uid: number,
  dossier: string,
  voulu: string,
): Promise<[AgentLecture, string, Dict] | null> {
  const racine = await bac.racine(uid);
  const p = parties(stripWorkPrefix(dossier));
  const candidats: string[] = [];
  for (let n = p.length; n >= Math.max(0, p.length - ROOT_WALK_MAX); n--) {
    try {
      candidats.push(relEditeur(racine, [...p.slice(0, n), voulu].join("/")));
    } catch (e) {
      if (!(e instanceof HttpError)) throw e;
    }
  }
  if (candidats.length === 0) return null;
  const agent = await bac.agent(uid);
  const entrees = await parAgent(agent, "Lecture", (a) => a.stat(candidats));
  for (const [i, e] of entrees.slice(0, candidats.length).entries())
    if (getPy(e, "kind") === "file") return [agent, candidats[i] ?? "", e];
  return null;
}

async function servirApercu(
  bac: BacDuCompte,
  requete: FastifyRequest,
  reponse: FastifyReply,
): Promise<FastifyReply> {
  const m = MOTIF_PV.exec(cheminDecode(requete)) as RegExpExecArray;
  const [jeton, chemin] = [m[1] ?? "", m[2] ?? ""];
  exigerJetonCanonique(jeton);
  const uid = Math.trunc(requete.identite?.user_id ?? 0);
  let trouve: [AgentLecture, string, Dict] | null = null;
  if (chemin.startsWith(`${RESOLVER}/`)) {
    const s = splitResolver(chemin.slice(RESOLVER.length + 1));
    if (s) trouve = await resoudreDepuis(bac, uid, ...s);
  } else {
    trouve = await fichierAgent(await bac.racine(uid), () => bac.agent(uid), chemin);
  }
  if (trouve === null) throw new HttpError(404, "Not found");
  const [agent, rel, e] = trouve;
  const mt = guessTypePy(rel.slice(rel.lastIndexOf("/") + 1))[0] ?? "text/plain";
  const genre = lowerPy(stripPy(mt.split(";")[0] ?? ""));
  const taille = getPy(e, "size");
  if ((genre !== "text/html" && genre !== "text/css") || Number(taille || 0) > MAX_REWRITE_BYTES)
    return reponseAgent(requete, reponse, agent, rel, e, mt, () => CORS);
  let data: Buffer;
  try {
    data = (await agent.read(rel, { maxBytes: MAX_REWRITE_BYTES })).data;
  } catch (ex) {
    if (!estErreurAgent(ex)) throw ex;
    if (INTROUVABLE_A_LA_LECTURE.has(ex.code)) throw new HttpError(404, "Not found");
    throw agentHttp(ex, "Lecture");
  }
  const dossier = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "";
  const base = resolverBase(`${PREVIEW_URL_PREFIX}${jeton}/`, dossier);
  const texte = UTF8.decode(data);
  const entetes: Record<string, string> = {
    "content-type": typeAvecCharset(mt),
    "cache-control": "no-cache, must-revalidate",
  };
  entetesSecurite(entetes, mt);
  return reponse
    .code(200)
    .headers({ ...entetes, ...CORS })
    .send(genre === "text/html" ? rewriteHtml(texte, base) : rewriteCss(texte, base));
}

export function creerFamilleApercuFichiers(bac: BacDuCompte): Famille {
  return {
    nom: "apercu-fichiers",
    routes: [
      {
        methode: "GET",
        chemin: CHEMIN_PV,
        motifsStarlette: [MOTIF_PV],
        processus: ["toolhost"],
        acces: "enveloppe",
        traiter: (req, rep) => servirApercu(bac, req, rep),
      },
    ],
  };
}
