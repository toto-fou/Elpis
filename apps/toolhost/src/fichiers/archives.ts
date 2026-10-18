// SPDX-License-Identifier: MIT
/** apps/toolhost/src/fichiers/archives.ts — miroir des skills poussé par main et export / import de `/work` (routes_files.py `/skills-mirror`, `/export`, `/import`) : archive extraite sous le dossier du compte, ou produite et extraite par l'agent du conteneur. */
import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";

import { estErreurAgent, invalidateSandboxUsage } from "@elpis/bac";
import { getPy, HttpError, intPy, pyParent, strPy, veritePy } from "@elpis/commun";
import type { Dict } from "@elpis/commun";
import { agentHttp } from "@elpis/fichiers";
import { lireFormulaire, valeursFormulaire } from "@elpis/http";
import type { FichierRecu } from "@elpis/http";
import { invalidateSkillsScanCache } from "@elpis/skills";
import type { FastifyReply, FastifyRequest } from "fastify";

import type { DefinitionRoute } from "../app";
import { creerSnapshot } from "../bac/instantanes";
import { ouvrirArchive, relayer } from "./aides";
import { parAgent, reponseJson, uidDe } from "./commun";
import type { ContexteFichiers } from "./commun";
import { quotaOctetsImport } from "./quota";
import { ArchiveTropGrosse, ErreurTar, extraireTarBorne } from "./tar";

const MIO = 1024 * 1024;
const MIROIR_MAX = 32 * MIO;
export const IMPORT_MAX_BYTES = 2 * 1024 * MIO;
const WORK_MAX_BYTES = 8 * 1024 * MIO;
const WORK_MAX_ENTREES = 500_000;
const WORK_PARCOURS_S = 240.0;
const TROP_WORK = `/work trop volumineux pour une archive (> ${WORK_MAX_BYTES / (1024 * MIO)} Gio ou ${WORK_MAX_ENTREES} fichiers)`;

function route(
  methode: "GET" | "POST",
  chemin: string,
  traiter: (q: FastifyRequest, r: FastifyReply) => Promise<unknown>,
): DefinitionRoute {
  return { methode, chemin, processus: ["toolhost"], acces: "enveloppe", traiter };
}

/** `archive: UploadFile = File(...)` ; au-delà de `maxi`, le fichier reçu est tronqué (la route juge sa taille). */
async function archiveRecue(q: FastifyRequest, maxi: number): Promise<FichierRecu> {
  const f = await lireFormulaire(q, { limiteFichier: maxi + 1 });
  return valeursFormulaire(f, { archive: { type: "fichier", requis: true } }).archive;
}

/** `time.strftime("Avant import du %d/%m/%Y %H:%M")` à l'heure locale de l'hôte. */
export function nomInstantaneImport(d = new Date()): string {
  const deux = (n: number): string => String(n).padStart(2, "0");
  return `Avant import du ${deux(d.getDate())}/${deux(d.getMonth() + 1)}/${d.getFullYear()} ${deux(d.getHours())}:${deux(d.getMinutes())}`;
}

/** `api_sandbox_skills_mirror` : `<compte>/skills` (hors du montage /work) remplacé par l'archive tar(.gz) du store de skills de main ; skill_run_script le relit aussitôt (cache de scan vidé). */
async function miroirSkills(ctx: ContexteFichiers, q: FastifyRequest): Promise<Dict> {
  const uid = uidDe(q);
  const P = pyParent(await ctx.bac.racine(uid));
  const archive = await archiveRecue(q, MIROIR_MAX);
  if (archive.taille > MIROIR_MAX)
    throw new HttpError(413, `Fichier trop volumineux (plafond : ${MIROIR_MAX / MIO} Mo).`);
  const donnees = await readFile(archive.chemin);
  const cible = `${P}/skills`;
  const tmp = `${P}/.skills-mirror.tmp`;
  if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  let n: number;
  try {
    n = await extraireTarBorne(donnees, tmp, { maxTotal: 256 * MIO, maxMembres: 20_000 });
  } catch (e) {
    rmSync(tmp, { recursive: true, force: true });
    if (e instanceof ArchiveTropGrosse)
      throw new HttpError(413, "archive trop volumineuse une fois décompressée");
    if (e instanceof ErreurTar) throw new HttpError(400, "archive invalide");
    throw e;
  }
  if (existsSync(cible)) rmSync(cible, { recursive: true, force: true });
  renameSync(tmp, cible);
  invalidateSkillsScanCache();
  return { ok: true, files: n };
}

/** `api_sandbox_import` : un instantané d'abord (import annulé s'il échoue), puis `/work` remplacé par l'archive, extraite par l'agent dans les bornes du compte. */
async function importer(ctx: ContexteFichiers, q: FastifyRequest): Promise<Dict> {
  const uid = uidDe(q);
  const archive = await archiveRecue(q, IMPORT_MAX_BYTES);
  if (archive.taille > IMPORT_MAX_BYTES) throw new HttpError(413, "archive trop volumineuse");
  const maxTotal = await quotaOctetsImport(ctx.rappel, uid);
  let meta: Dict;
  try {
    meta = await creerSnapshot(uid, nomInstantaneImport());
  } catch (e) {
    if (!(e instanceof Error) || e.constructor !== Error) throw e;
    throw new HttpError(
      409,
      `Import annulé, /work inchangé : instantané préalable impossible : ${e.message}`,
    );
  }
  let res: Dict;
  try {
    const agent = await ctx.bac.agent(uid);
    res = await agent.extract(
      "",
      { chemin: archive.chemin },
      { maxBytes: maxTotal, maxFile: maxTotal, maxMembers: WORK_MAX_ENTREES },
    );
  } catch (e) {
    if (!estErreurAgent(e)) throw e;
    if (e.code === "too_large")
      throw new HttpError(
        413,
        "archive trop volumineuse une fois décompressée (quota du compte ou nombre de fichiers dépassé)",
      );
    if (e.code === "bad_archive") throw new HttpError(400, "archive invalide");
    throw agentHttp(e, "Import");
  }
  invalidateSandboxUsage(uid);
  const conflits = getPy(res, "conflict_paths");
  const liste = veritePy(conflits) && Array.isArray(conflits) ? conflits.slice(0, 50) : [];
  return {
    ok: true,
    files: intPy(veritePy(getPy(res, "files")) ? getPy(res, "files") : 0),
    conflicts: intPy(veritePy(getPy(res, "conflicts")) ? getPy(res, "conflicts") : 0),
    conflict_paths: liste.map((x: unknown) => Array.from(strPy(x)).slice(0, 512).join("")),
    snapshot: { id: getPy(meta, "id"), name: getPy(meta, "name") },
  };
}

export function routesArchives(ctx: ContexteFichiers): DefinitionRoute[] {
  return [
    route("POST", "/api/sandbox/skills-mirror", async (q, r) => reponseJson(r, await miroirSkills(ctx, q))),
    route("GET", "/api/sandbox/export", async (q, r) => {
      const uid = uidDe(q);
      const agent = await parAgent("Export", () => ctx.bac.agent(uid));
      const flux = await ouvrirArchive(agent, [""], "Export", TROP_WORK, {
        format: "tgz",
        maxBytes: WORK_MAX_BYTES,
        maxFiles: WORK_MAX_ENTREES,
        deadlineS: WORK_PARCOURS_S,
      });
      return relayer(r, flux, "work.tar.gz", "application/gzip", ctx.journal, {
        "cache-control": "no-store",
      });
    }),
    route("POST", "/api/sandbox/import", async (q, r) => reponseJson(r, await importer(ctx, q))),
  ];
}
