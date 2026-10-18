// SPDX-License-Identifier: MIT
/** apps/toolhost/src/fichiers/ecriture.ts — routes d'écriture de l'éditeur (routes_files.py) : envois (multiple, par morceaux, pré-contrôle), sauvegarde avec précondition, suppression, vidage, dossier, renommage, copie ; quota, verrous et historique de session. */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";

import {
  bumpSandboxUsage,
  estErreurAgent,
  invalidateSandboxUsage,
  sandboxUsageBytes,
  UPLOAD_TMP_SUFFIX,
} from "@elpis/bac";
import {
  comparePointsDeCode,
  ErreurValidation,
  estDict,
  estErreurPython,
  FlottantPy,
  fixePy,
  getPy,
  HttpError,
  intPy,
  lowerPy,
  poserCle,
  pyJsonLoadsOctets,
  veritePy,
} from "@elpis/commun";
import type { Dict, ErreurPydantic } from "@elpis/commun";
import { config } from "@elpis/config";
import {
  agentHttp,
  base64Strict,
  recordMove,
  sandboxAppendChunk,
  sandboxClear,
  sandboxCopy,
  sandboxDelete,
  sandboxMkdir,
  sandboxRename,
  sha256Bytes,
} from "@elpis/fichiers";
import type { AgentClient, ContenuHistorique } from "@elpis/fichiers";
import { entrees, lireFormulaire, py } from "@elpis/http";
import type { FichierRecu } from "@elpis/http";
import { resolveUsername } from "@elpis/securite";
import type { FastifyReply, FastifyRequest } from "fastify";

import type { DefinitionRoute } from "../app";
import {
  binaireExistant,
  cheminHote,
  DOWNLOAD_SHA_MAX,
  etatAgent,
  histAvant,
  histEcrire,
  mtimeF,
  sousVerrouFichier,
  statsLots,
} from "./aides";
import type { Etat } from "./aides";
import { entierDe, parAgent, relEditeur, reponseJson, statUn, uidDe } from "./commun";
import type { ContexteFichiers } from "./commun";
import { estNombre, suffixeDe, valeurNombre } from "./lecture";
import { capaciteImport, quotaMb, sousVerrouQuota } from "./quota";

const MIO = 1024 * 1024;
export const UPLOAD_CHUNK_HARD_CAP = 32 * MIO;
export const SAVE_MAX_BYTES = 50 * MIO;
const SAVE_MTIME_EPS = 0.0005;
const SHA_RE = /^[0-9a-f]{64}\n?$/u;
const UPLOAD_ID_RE = /^[A-Za-z0-9_-]{1,40}$/u;
const PRECHECK_MAX_ENTRIES = 20000;

/** Mesure d'une écriture (`log_metric`) : posée par la composition (base de l'hôte) ; absente, rien n'est noté. */
export type PortMetrique = (nom: string, valeur: number, etiquettes: Dict) => Promise<void>;
let metrique: PortMetrique | null = null;

export function installerMetrique(f: PortMetrique | null): void {
  metrique = f;
}

function route(
  methode: "GET" | "POST" | "DELETE",
  chemin: string,
  traiter: (q: FastifyRequest, r: FastifyReply) => Promise<unknown>,
): DefinitionRoute {
  return { methode, chemin, processus: ["toolhost"], acces: "enveloppe", traiter };
}

async function agentDe(ctx: ContexteFichiers, uid: number, libelle: string): Promise<AgentClient> {
  return parAgent(libelle, () => ctx.bac.agent(uid));
}

/** `await request.json()` du Python (illisible : panne 500). */
function corps(q: FastifyRequest): unknown {
  return pyJsonLoadsOctets(q.corpsBrut);
}

/** `data.get(cle)` d'un corps qui doit être un dict (sinon AttributeError, 500). */
function champ(d: unknown, cle: string, defaut: unknown = null): unknown {
  return getPy(d, cle, defaut);
}

/** `_upload_tmp_rel` : fichier provisoire d'un envoi par morceaux (avec ou sans identifiant d'envoi). */
export function uploadTmpRel(relPath: string, uploadId: string): string {
  if (uploadId) {
    if (!UPLOAD_ID_RE.test(uploadId)) throw new HttpError(400, "upload_id invalide");
    return `${relPath}.${uploadId}${UPLOAD_TMP_SUFFIX}`;
  }
  return relPath + UPLOAD_TMP_SUFFIX;
}

/** `_fmt_octets` : « 12,4 Go » / « 850 Mo » / « 42 Ko » / « 12 o ». */
export function fmtOctets(n: number): string {
  const v = Math.max(0, Math.trunc(n));
  for (const [seuil, unite] of [
    [1024 ** 3, "Go"],
    [1024 ** 2, "Mo"],
    [1024, "Ko"],
  ] as const)
    if (v >= seuil)
      return (
        fixePy(v / seuil, 1)
          .replace(".", ",")
          .replaceAll(",0", "") +
        " " +
        unite
      );
  return `${v} o`;
}

/** `_conflict_detail` : corps du 412 (contrat du front). */
export function conflictDetail(
  manquant: boolean,
  etat: Etat | null,
  message: string,
  extra: Dict = {},
): Dict {
  const st = (etat ?? {}) as Partial<Record<string, unknown>>;
  return {
    code: "conflict",
    missing: manquant,
    mtime: !manquant && st["mtime"] !== undefined ? new FlottantPy(st["mtime"] as number) : null,
    sha256: !manquant && st["sha256"] !== undefined ? st["sha256"] : null,
    message,
    ...extra,
  };
}

/** `_save_conflict` : `[statut, détail]` si le fichier a changé ou disparu depuis la version de l'onglet, sinon `null`. */
export function saveConflict(
  st: Etat,
  attenduMtime: number | null,
  attenduSha: string | null,
): [number, Dict] | null {
  if (st.kind === "missing") return [412, conflictDetail(true, null, "Le fichier a été supprimé du disque")];
  if (st.kind === "not_dir")
    return [409, { code: "not_dir", message: "Un élément du chemin est un fichier, pas un dossier" }];
  if (st.kind === "unreadable")
    return [
      412,
      conflictDetail(false, null, "Fichier illisible : impossible de vérifier qu'il n'a pas changé", {
        unreadable: true,
      }),
    ];
  if (st.kind === "dir") return [409, { code: "is_dir", message: "Un dossier porte ce nom" }];
  if (st.kind === "other")
    return [
      409,
      { code: "not_file", message: "Ce chemin n'est pas un fichier ordinaire (lien ou fichier spécial)" },
    ];
  if (attenduSha !== null) {
    if (st.sha256 === null && !st.readable)
      return [
        412,
        conflictDetail(false, st, "Fichier illisible : impossible de vérifier qu'il n'a pas changé", {
          unreadable: true,
        }),
      ];
    if (st.sha256 === attenduSha) return null;
    if (st.sha256 === null && attenduMtime !== null && Math.abs(st.mtime - attenduMtime) <= SAVE_MTIME_EPS)
      return null;
    return [412, conflictDetail(false, st, "Le fichier a changé sur le disque")];
  }
  if (Math.abs(st.mtime - (attenduMtime as number)) <= SAVE_MTIME_EPS) return null;
  return [412, conflictDetail(false, st, "Le fichier a changé sur le disque")];
}

/** `detail` d'un refus d'envoi : message (ou code) d'un détail structuré. */
function detailRefus(e: HttpError): unknown {
  const d = e.detail;
  if (estDict(d)) return veritePy(getPy(d, "message")) ? getPy(d, "message") : getPy(d, "code");
  return d;
}

/** `str(detail)` de Python pour le motif `exec_failed: …`. */
function texteDetail(d: unknown): string {
  return typeof d === "string" ? d : d === null || d === undefined ? "None" : String(d);
}

/** `read_upload_bounded` : contenu d'un fichier reçu, 413 au-delà de `maxi`. */
async function lireEnvoiBorne(f: FichierRecu, maxi: number): Promise<Buffer> {
  if (f.taille > maxi)
    throw new HttpError(413, `Fichier trop volumineux (plafond : ${Math.floor(maxi / MIO)} Mo).`);
  return readFile(f.chemin);
}

/** `files: List[UploadFile] = File(...)`, `paths: List[str] = Form(...)` : un 422 groupé comme FastAPI. */
async function formulaireEnvoi(q: FastifyRequest): Promise<{ fichiers: FichierRecu[]; chemins: string[] }> {
  const f = await lireFormulaire(q, { limiteFichier: config.MAX_UPLOAD_BYTES + 1 });
  const erreurs: ErreurPydantic[] = [];
  const fichiers = f.getAll("files").filter((v) => v !== "");
  const chemins = f.getAll("paths").filter((v) => v !== "");
  if (!fichiers.length)
    erreurs.push({ type: "missing", loc: ["body", "files"], msg: "Field required", input: null });
  else
    fichiers.forEach((v, i) => {
      if (typeof v === "string")
        erreurs.push({
          type: "value_error",
          loc: ["body", "files", i],
          msg: "Value error, Expected UploadFile, received: <class 'str'>",
          input: v,
          ctx: { error: {} },
        });
    });
  if (!chemins.length)
    erreurs.push({ type: "missing", loc: ["body", "paths"], msg: "Field required", input: null });
  else
    chemins.forEach((v, i) => {
      if (typeof v !== "string")
        erreurs.push({
          type: "string_type",
          loc: ["body", "paths", i],
          msg: "Input should be a valid string",
          input: { filename: v.filename, size: v.taille },
        });
    });
  if (erreurs.length) throw new ErreurValidation(erreurs);
  return { fichiers: fichiers as FichierRecu[], chemins: chemins as string[] };
}

/** `api_upload_sandbox_files` : chaque fichier écrit par l'agent (UID du conteneur), refusé seul (chemin, dossier, taille, quota) sans arrêter le lot. */
async function envoyer(ctx: ContexteFichiers, q: FastifyRequest): Promise<Dict> {
  const uid = uidDe(q);
  const racine = await ctx.bac.racine(uid);
  const { fichiers, chemins } = await formulaireEnvoi(q);
  const qMb = await quotaMb(ctx.rappel, uid);
  let enCours = qMb > 0 ? await sandboxUsageBytes(uid, racine, { quotaBytes: qMb * MIO }) : 0;
  let delta = 0;
  const agent = await agentDe(ctx, uid, "Upload");
  const rels = new Map<string, string | null>();
  for (const c of chemins) {
    try {
      rels.set(c, relEditeur(racine, c));
    } catch (e) {
      if (!(e instanceof HttpError)) throw e;
      rels.set(c, null);
    }
  }
  const valides = [...new Set([...rels.values()].filter((r): r is string => Boolean(r)))].sort(
    comparePointsDeCode,
  );
  const etats = new Map<string, Dict>();
  const lus = await parAgent("Upload", () => statsLots(agent, valides));
  valides.forEach((v, i) => {
    const e = lus[i];
    if (e !== undefined) etats.set(v, e);
  });
  let saved = 0;
  const skipped: Dict[] = [];
  const mtimes: Dict = {};
  const hashes: Dict = {};
  const n = Math.min(fichiers.length, chemins.length);
  for (let i = 0; i < n; i++) {
    const fichier = fichiers[i] as FichierRecu;
    const relPath = chemins[i] as string;
    const rel = rels.get(relPath);
    if (!rel) {
      skipped.push({ path: relPath, reason: "path_escape" });
      continue;
    }
    const e = etats.get(rel) ?? { kind: "missing" };
    if (getPy(e, "kind") === "dir") {
      skipped.push({ path: relPath, reason: "is_directory" });
      continue;
    }
    let octets: Buffer;
    try {
      octets = await lireEnvoiBorne(fichier, config.MAX_UPLOAD_BYTES);
    } catch (ex) {
      if (!(ex instanceof HttpError)) throw ex;
      skipped.push({ path: relPath, reason: "too_large" });
      continue;
    }
    await sousVerrouQuota(uid, async () => {
      const existant = getPy(e, "kind") === "file" ? entierDe(e, "size") : 0;
      if (qMb > 0 && enCours + octets.length - existant > qMb * MIO) {
        skipped.push({ path: relPath, reason: "quota_exceeded" });
        return;
      }
      let avant: ContenuHistorique;
      let r: Dict;
      try {
        [avant, r] = await sousVerrouFichier(cheminHote(racine, rel), async () => {
          const a = await histAvant(agent, rel, {
            kind: String(getPy(e, "kind")),
            size: entierDe(e, "size"),
          });
          return [a, await agent.write(rel, octets, { parents: true })] as const;
        });
      } catch (ex) {
        if (!estErreurAgent(ex) && !(ex instanceof HttpError)) throw ex;
        const refus = estErreurAgent(ex) ? agentHttp(ex, "Upload") : ex;
        skipped.push({ path: relPath, reason: `exec_failed: ${texteDetail(detailRefus(refus))}` });
        return;
      }
      if (veritePy(getPy(r, "mtime_ns"))) poserCle(mtimes, relPath, mtimeF(getPy(r, "mtime_ns")));
      poserCle(hashes, relPath, sha256Bytes(octets));
      saved += 1;
      delta += octets.length - existant;
      if (qMb > 0) enCours += octets.length - existant;
      await histEcrire(uid, rel, avant, octets, "upload");
    });
  }
  if (delta) bumpSandboxUsage(uid, delta);
  return { ok: true, saved, skipped, mtimes, sha256s: hashes };
}

/** `_ajouter_morceau` : un morceau ajouté au provisoire ; disque plein (507) : provisoire supprimé. */
async function ajouterMorceau(
  agent: AgentClient,
  uid: number,
  tmpRel: string,
  donnees: Buffer,
  truncate: boolean,
): Promise<number> {
  try {
    return await sandboxAppendChunk(agent, tmpRel, donnees, { truncate });
  } catch (e) {
    if (e instanceof HttpError && e.statusCode === 507) {
      try {
        await sandboxDelete(agent, tmpRel);
      } catch (ex) {
        if (!(ex instanceof HttpError)) throw ex;
      }
      invalidateSandboxUsage(uid);
    }
    throw e;
  }
}

/** `int(qp.get(cle, defaut))` d'un paramètre d'envoi par morceaux ; illisible : 400. */
function entierParametre(q: FastifyRequest, cle: string, defaut: string): number {
  const brut = (q.query as Record<string, unknown>)[cle];
  const v = typeof brut === "string" ? brut : Array.isArray(brut) ? String(brut[brut.length - 1]) : defaut;
  try {
    return intPy(v);
  } catch (e) {
    if (estErreurPython(e, "ValueError")) throw new HttpError(400, "Paramètres chunk invalides");
    throw e;
  }
}

/** Paramètre de requête texte (`qp.get(cle) or ""`, dernière valeur). */
function texteParametre(q: FastifyRequest, cle: string): string {
  const brut = (q.query as Record<string, unknown>)[cle];
  if (Array.isArray(brut)) return String(brut[brut.length - 1] ?? "");
  return typeof brut === "string" ? brut : "";
}

/** `api_upload_sandbox_chunk` : un gros fichier par morceaux (1er : contrôle de capacité sous le verrou, dernier : promotion du provisoire). */
async function envoyerMorceau(ctx: ContexteFichiers, q: FastifyRequest): Promise<Dict> {
  const uid = uidDe(q);
  const racine = await ctx.bac.racine(uid);
  const relPath = texteParametre(q, "path");
  const index = entierParametre(q, "index", "0");
  const total = entierParametre(q, "total", "1");
  const tailleTotale = entierParametre(q, "size", "0");
  if (!relPath || total < 1 || index < 0 || index >= total || tailleTotale < 0)
    throw new HttpError(400, "Paramètres chunk invalides");
  const rel = relEditeur(racine, relPath);
  const tmpRel = uploadTmpRel(relPath, texteParametre(q, "upload_id"));
  const tmp = relEditeur(racine, tmpRel);
  const donnees = q.corpsBrut;
  if (donnees.length > UPLOAD_CHUNK_HARD_CAP) throw new HttpError(413, "Chunk trop volumineux");
  const agent = await agentDe(ctx, uid, "Upload (chunk)");
  let recu: number;
  if (index === 0) {
    const [e, eTmp] = (await parAgent("Upload (chunk)", () => statsLots(agent, [rel, tmp]))) as [Dict, Dict];
    if (getPy(e, "kind") === "dir") throw new HttpError(409, "Un dossier porte déjà ce nom");
    recu = await sousVerrouQuota(uid, async () => {
      const cap = await capaciteImport(ctx.rappel, uid, racine, false);
      const net = tailleTotale - (getPy(e, "kind") === "file" ? entierDe(e, "size") : 0);
      const perime = getPy(eTmp, "kind") === "file" ? entierDe(eTmp, "size") : 0;
      if (cap.limit_bytes !== null && net > cap.limit_bytes)
        throw new HttpError(
          413,
          `Import trop volumineux (limite ${fmtOctets(cap.limit_bytes)}, ${cap.max_pct} % de la sandbox)`,
        );
      if (!cap.unlimited) {
        if (cap.used_bytes - perime + net > cap.quota_bytes)
          throw new HttpError(413, `Quota sandbox dépassé (${Math.floor(cap.quota_bytes / MIO)} Mo)`);
      } else if (cap.remaining_bytes !== null && net > cap.remaining_bytes)
        throw new HttpError(413, "Espace disque insuffisant");
      return ajouterMorceau(agent, uid, tmpRel, donnees, true);
    });
  } else {
    try {
      recu = await ajouterMorceau(agent, uid, tmpRel, donnees, false);
    } catch (e) {
      if (e instanceof HttpError && e.statusCode === 404) throw new HttpError(409, "Import interrompu");
      throw e;
    }
  }
  const dernier = index >= total - 1;
  if (recu > tailleTotale || (dernier && recu !== tailleTotale)) {
    try {
      await sandboxDelete(agent, tmpRel);
    } catch (ex) {
      if (!(ex instanceof HttpError)) throw ex;
    }
    invalidateSandboxUsage(uid);
    throw new HttpError(400, "Taille reçue incohérente — import du fichier annulé");
  }
  if (!dernier) return { ok: true, done: false };
  const [avant, st] = await sousVerrouFichier(cheminHote(racine, rel), async () => {
    const a = await histAvant(agent, rel, await etatAgent(agent, rel, 0));
    try {
      await sandboxRename(agent, tmpRel, relPath, { overwrite: true });
    } catch (e) {
      if (e instanceof HttpError) {
        try {
          await sandboxDelete(agent, tmpRel);
        } catch (ex) {
          if (!(ex instanceof HttpError)) throw ex;
        }
        invalidateSandboxUsage(uid);
      }
      throw e;
    }
    return [a, await etatAgent(agent, rel, DOWNLOAD_SHA_MAX)] as const;
  });
  await histEcrire(uid, rel, avant, await histAvant(agent, rel, st), "upload");
  invalidateSandboxUsage(uid);
  return {
    ok: true,
    done: true,
    path: relPath,
    mtime: "mtime" in st ? new FlottantPy(st.mtime) : null,
    sha256: st.kind === "file" ? st.sha256 : null,
  };
}

/** `api_upload_precheck` : un import tiendra-t-il ? Ce qu'il ajoute (écrasements déduits) comparé au plafond d'un import et à l'espace restant (usage exact). */
async function preControle(ctx: ContexteFichiers, q: FastifyRequest): Promise<Dict> {
  const uid = uidDe(q);
  const racine = await ctx.bac.racine(uid);
  let donnees: unknown;
  try {
    donnees = corps(q);
  } catch {
    throw new HttpError(400, "JSON invalide");
  }
  if (!estDict(donnees) || !Array.isArray(getPy(donnees, "files", [])))
    throw new HttpError(400, "Corps invalide");
  const brut = getPy(donnees, "files");
  const fichiers = veritePy(brut) ? (brut as unknown[]) : [];
  let declare: number;
  try {
    const t = getPy(donnees, "total_bytes");
    declare = Math.max(0, intPy(veritePy(t) ? t : 0));
  } catch (e) {
    if (estErreurPython(e, "TypeError", "ValueError")) throw new HttpError(400, "total_bytes invalide");
    throw e;
  }
  const detaille = fichiers.length > 0 && fichiers.length <= PRECHECK_MAX_ENTRIES;
  const demandes: [number, string][] = [];
  let echappes = 0;
  if (detaille)
    for (const f of fichiers) {
      if (!estDict(f) || typeof getPy(f, "path") !== "string") continue;
      let taille: number;
      try {
        const s = getPy(f, "size");
        taille = Math.max(0, intPy(veritePy(s) ? s : 0));
      } catch (e) {
        if (!estErreurPython(e, "TypeError", "ValueError")) throw e;
        taille = 0;
      }
      try {
        demandes.push([taille, relEditeur(racine, getPy(f, "path") as string)]);
      } catch (e) {
        if (!(e instanceof HttpError)) throw e;
        echappes += 1;
      }
    }
  const etats = demandes.length
    ? await parAgent("Pré-contrôle", async () =>
        statsLots(
          await ctx.bac.agent(uid),
          demandes.map(([, r]) => r),
        ),
      )
    : [];
  let total = 0;
  let besoin = 0;
  let ecrase = 0;
  if (detaille)
    demandes.forEach(([taille], i) => {
      const e = etats[i] ?? {};
      const existant = getPy(e, "kind") === "file" ? entierDe(e, "size") : 0;
      total += taille;
      ecrase += Math.min(existant, taille);
      besoin += Math.max(0, taille - existant);
    });
  else total = besoin = declare;
  const cap = await capaciteImport(ctx.rappel, uid, racine, true);
  const bornes = (
    [
      [cap.limit_bytes, "import_limit"],
      [cap.remaining_bytes, "remaining"],
    ] as const
  ).filter((b): b is readonly [number, "import_limit" | "remaining"] => b[0] !== null);
  let permis: number | null = null;
  let motif = "";
  for (const [b, pourquoi] of bornes)
    if (permis === null || b < permis) {
      permis = b;
      motif = pourquoi;
    }
  const tient = permis === null || besoin <= permis;
  return {
    fits: tient,
    reason: tient ? "" : motif,
    allowed_bytes: permis,
    needed_bytes: besoin,
    total_bytes: total,
    overwrite_bytes: ecrase,
    escaped: echappes,
    detailed: detaille,
    ...cap,
  };
}

/** `api_save_sandbox_file` : texte (ou binaire `content_b64`) écrit par l'agent sous les verrous du compte et du fichier, précondition revérifiée au remplacement. */
async function sauvegarder(ctx: ContexteFichiers, q: FastifyRequest): Promise<Dict> {
  const uid = uidDe(q);
  const longueurAnnoncee = /^\d+$/u.test(q.headers["content-length"] ?? "")
    ? Number(q.headers["content-length"])
    : 0;
  if (longueurAnnoncee > SAVE_MAX_BYTES * 2)
    throw new HttpError(413, `Contenu trop volumineux pour l'éditeur (${SAVE_MAX_BYTES / MIO} Mo max)`);
  const donnees = corps(q);
  if (!estDict(donnees)) throw new HttpError(400, "Corps JSON (objet) requis");
  const relPath = getPy(donnees, "path");
  const contenu = getPy(donnees, "content");
  let binaire: Buffer | null = null;
  const b64 = getPy(donnees, "content_b64");
  if (contenu === null && typeof b64 === "string") {
    binaire = base64Strict(b64);
    if (binaire === null) throw new HttpError(400, "content_b64 invalide");
    if (binaire.length > 8 * MIO) throw new HttpError(413, "contenu binaire trop volumineux (8 Mo max)");
  }
  if (!veritePy(relPath) || typeof relPath !== "string") throw new HttpError(400, "Path required");
  if (binaire === null && typeof contenu !== "string") throw new HttpError(400, "Content (string) required");
  if (binaire === null && !(contenu as string).isWellFormed())
    throw new HttpError(400, "Contenu invalide (caractère non encodable)");
  const charge = binaire ?? Buffer.from(contenu as string, "utf-8");
  if (charge.length > SAVE_MAX_BYTES)
    throw new HttpError(413, `Contenu trop volumineux pour l'éditeur (${SAVE_MAX_BYTES / MIO} Mo max)`);
  const racine = await ctx.bac.racine(uid);
  const rel = relEditeur(racine, relPath);
  const agent = await agentDe(ctx, uid, "Lecture");
  if (binaire === null && (await binaireExistant(agent, rel)))
    throw new HttpError(409, "Fichier binaire : sauvegarde refusée");
  const siAbsent = veritePy(getPy(donnees, "if_absent"));
  const existe = { code: "exists", message: "Un fichier porte déjà ce nom" };
  const mtimeBrut = getPy(donnees, "expected_mtime");
  if (mtimeBrut !== null && !estNombre(mtimeBrut))
    throw new HttpError(400, "expected_mtime invalide (nombre attendu)");
  const attenduMtime = mtimeBrut === null ? null : valeurNombre(mtimeBrut);
  let attenduSha = getPy(donnees, "expected_sha256");
  if (attenduSha !== null) {
    if (typeof attenduSha !== "string" || !SHA_RE.test(lowerPy(attenduSha)))
      throw new HttpError(400, "expected_sha256 invalide (64 caractères hexadécimaux)");
    attenduSha = lowerPy(attenduSha);
  }
  const source = getPy(donnees, "source") === "restore" ? "restore" : "editor";
  const qMb = await quotaMb(ctx.rappel, uid);
  try {
    const [avant, nouveauMtime, duree] = await sousVerrouQuota(uid, () =>
      sousVerrouFichier(cheminHote(racine, rel), async () => {
        const st = await etatAgent(agent, rel, DOWNLOAD_SHA_MAX);
        let condition: { ifSha256?: string; ifMtimeNs?: number | bigint; ifAbsent?: boolean } = {};
        if (attenduSha !== null || attenduMtime !== null) {
          const conflit = saveConflict(st, attenduMtime, attenduSha as string | null);
          if (conflit !== null) throw new HttpError(conflit[0], conflit[1]);
          if (st.kind === "file")
            condition = st.sha256 ? { ifSha256: st.sha256 } : { ifMtimeNs: st.mtime_ns };
        } else if (st.kind === "dir")
          throw new HttpError(409, { code: "is_dir", message: "Un dossier porte ce nom" });
        if (siAbsent) {
          if (st.kind !== "missing") throw new HttpError(409, { ...existe });
          condition = { ifAbsent: true };
        }
        const existant = st.kind === "file" ? st.size : 0;
        const netNouveau = charge.length - existant;
        if (qMb > 0) {
          const utilise = await sandboxUsageBytes(uid, racine, { quotaBytes: qMb * MIO });
          if (utilise + netNouveau > qMb * MIO) throw new HttpError(413, `Quota sandbox dépassé (${qMb} Mo)`);
        }
        const a = await histAvant(agent, rel, st);
        const t0 = Date.now();
        let r: Dict;
        try {
          r = await agent.write(rel, charge, { parents: true, ...condition });
        } catch (e) {
          if (!estErreurAgent(e)) throw e;
          if (e.code === "changed") {
            const st2 = await etatAgent(agent, rel, DOWNLOAD_SHA_MAX);
            throw new HttpError(
              412,
              conflictDetail(st2.kind === "missing", st2, "Le fichier a changé sur le disque"),
            );
          }
          if (e.code === "exists") throw new HttpError(409, { ...existe });
          throw agentHttp(e, "Sauvegarde");
        }
        bumpSandboxUsage(uid, netNouveau);
        const d = (Date.now() - t0) / 1000;
        return [a, veritePy(getPy(r, "mtime_ns")) ? mtimeF(getPy(r, "mtime_ns")) : null, d] as const;
      }),
    );
    await histEcrire(uid, rel, avant, charge, source);
    const ext = suffixeDe(rel).replace(/^\.+/u, "");
    const nom = resolveUsername(uid) || `user_${uid}`;
    await metrique?.("code_write_time", Math.round(duree * 10_000) / 10_000, {
      ext,
      size: charge.length,
      user: nom,
    });
    await metrique?.("sandbox_write", 1, { ext, size: charge.length, user: nom });
    return { ok: true, size: charge.length, mtime: nouveauMtime, sha256: sha256Bytes(charge) };
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(500, `Write error: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Erreur imprévue d'une route de structure : 500 « <libellé> error: … » comme le `except Exception` du Python. */
async function sinon500<T>(libelle: string, f: () => Promise<T>): Promise<T> {
  try {
    return await f();
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(500, `${libelle} error: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export function routesEcriture(ctx: ContexteFichiers): DefinitionRoute[] {
  return [
    route("POST", "/api/sandbox/upload", async (q, r) => reponseJson(r, await envoyer(ctx, q))),
    route("POST", "/api/sandbox/upload-chunk", async (q, r) => reponseJson(r, await envoyerMorceau(ctx, q))),
    route("DELETE", "/api/sandbox/upload-chunk", async (q, r) => {
      const p = entrees(q, { query: { path: py.str().defaut(""), upload_id: py.str().defaut("") } }).query;
      const uid = uidDe(q);
      if (!p.path) throw new HttpError(400, "Chemin requis");
      const racine = await ctx.bac.racine(uid);
      const tmpRel = uploadTmpRel(p.path, p.upload_id);
      const tmp = relEditeur(racine, tmpRel);
      const agent = await agentDe(ctx, uid, "Annulation");
      if (getPy(await statUn(agent, tmp, "Annulation"), "kind") === "missing")
        return reponseJson(r, { ok: true, removed: false });
      await sandboxDelete(agent, tmpRel);
      invalidateSandboxUsage(uid);
      return reponseJson(r, { ok: true, removed: true });
    }),
    route("POST", "/api/sandbox/upload-precheck", async (q, r) => reponseJson(r, await preControle(ctx, q))),
    route("POST", "/api/sandbox/save", async (q, r) => reponseJson(r, await sauvegarder(ctx, q))),
    route("DELETE", "/api/sandbox/delete", async (q, r) => {
      const { path } = entrees(q, { query: { path: py.str() } }).query;
      const uid = uidDe(q);
      const rel = relEditeur(await ctx.bac.racine(uid), path);
      const agent = await agentDe(ctx, uid, "Suppression");
      const e = await statUn(agent, rel, "Suppression");
      if (getPy(e, "kind") === "missing") throw new HttpError(404, "Not found");
      const estFichier = getPy(e, "kind") === "file" && !veritePy(getPy(e, "link"));
      const avant = estFichier
        ? await histAvant(agent, rel, { kind: "file", size: entierDe(e, "size") })
        : null;
      return sinon500("Delete", async () => {
        await sandboxDelete(agent, path);
        invalidateSandboxUsage(uid);
        if (estFichier) await histEcrire(uid, rel, avant, null, "editor");
        return reponseJson(r, { ok: true });
      });
    }),
    route("POST", "/api/sandbox/clear", async (q, r) => {
      const uid = uidDe(q);
      const racine = await ctx.bac.racine(uid);
      if (!existsSync(racine)) return reponseJson(r, { ok: true, deleted: 0 });
      return sinon500("Clear", async () => {
        const n = await sandboxClear(await agentDe(ctx, uid, "Vidage sandbox"), uid);
        invalidateSandboxUsage(uid);
        return reponseJson(r, { ok: true, deleted: n });
      });
    }),
    route("POST", "/api/sandbox/mkdir", async (q, r) => {
      const uid = uidDe(q);
      const relPath = champ(corps(q), "path");
      if (!veritePy(relPath)) throw new HttpError(400, "Path required");
      relEditeur(await ctx.bac.racine(uid), relPath as string);
      return sinon500("Mkdir", async () => {
        await sandboxMkdir(await agentDe(ctx, uid, "Création dossier"), relPath as string);
        return reponseJson(r, { ok: true });
      });
    }),
    route("POST", "/api/sandbox/rename", async (q, r) => {
      const uid = uidDe(q);
      const d = corps(q);
      const ancien = champ(d, "old_path");
      const nouveau = champ(d, "new_path");
      if (!veritePy(ancien) || !veritePy(nouveau)) throw new HttpError(400, "Old and new paths required");
      const racine = await ctx.bac.racine(uid);
      const a = relEditeur(racine, ancien as string);
      const b = relEditeur(racine, nouveau as string);
      const agent = await agentDe(ctx, uid, "Renommage");
      if (getPy(await statUn(agent, a, "Renommage"), "kind") === "missing")
        throw new HttpError(404, "Source not found");
      if (b !== a && getPy(await statUn(agent, b, "Renommage"), "kind") !== "missing")
        throw new HttpError(409, "Un élément porte déjà ce nom à cet endroit");
      return sinon500("Rename", async () => {
        await sandboxRename(agent, ancien as string, nouveau as string);
        await recordMove(uid, a, b);
        return reponseJson(r, { ok: true });
      });
    }),
    route("POST", "/api/sandbox/copy", async (q, r) => {
      const uid = uidDe(q);
      const d = corps(q);
      const srcRel = champ(d, "src");
      const dstRel = champ(d, "dst");
      if (!veritePy(srcRel) || !veritePy(dstRel)) throw new HttpError(400, "Source et destination requises");
      const racine = await ctx.bac.racine(uid);
      const src = relEditeur(racine, srcRel as string);
      const dst = relEditeur(racine, dstRel as string);
      const agent = await agentDe(ctx, uid, "Copie");
      const e = await statUn(agent, src, "Copie");
      if (getPy(e, "kind") === "missing") throw new HttpError(404, "Source introuvable");
      if (getPy(await statUn(agent, dst, "Copie"), "kind") !== "missing")
        throw new HttpError(409, "Un élément porte déjà ce nom à cet endroit");
      if (!src || dst === src || dst.startsWith(src + "/"))
        throw new HttpError(400, "Impossible de copier un dossier dans lui-même");
      await sousVerrouQuota(uid, async () => {
        const qMb = await quotaMb(ctx.rappel, uid);
        const du = await parAgent("Copie", () => agent.fsop("du", { path: src, deadline_s: 30 }));
        const taille = entierDe(du, "bytes");
        if (qMb > 0) {
          if (!veritePy(getPy(du, "complete")))
            throw new HttpError(413, "Arborescence trop grande pour vérifier le quota");
          const utilise = await sandboxUsageBytes(uid, racine, { quotaBytes: qMb * MIO });
          if (utilise + taille > qMb * MIO) throw new HttpError(413, `Quota sandbox dépassé (${qMb} Mo)`);
        }
        await sandboxCopy(agent, srcRel as string, dstRel as string);
        bumpSandboxUsage(uid, taille);
      });
      if (getPy(e, "kind") === "file" && !veritePy(getPy(e, "link"))) {
        const apres = await histAvant(agent, dst, { kind: "file", size: entierDe(e, "size") });
        if (apres !== null) await histEcrire(uid, dst, null, apres, "editor");
      }
      return reponseJson(r, { ok: true, path: dstRel });
    }),
  ];
}
