// SPDX-License-Identifier: MIT
/** apps/core/src/familles/skills.ts — bibliothèque de skills (mémoire procédurale) : lecture, création, édition, suppression, promotion, import .zip ou dossier, export (shared_infra/chat/routes_skills.py). */
import { open, readFile, stat } from "node:fs/promises";

import { ligneUtilisateur } from "@elpis/auth";
import {
  dateHeureLocale,
  ecrireZip,
  ErreurPython,
  ErreurValidation,
  estDict,
  HttpError,
  lire,
  lowerPy,
  messageErreurOs,
  nomTypePy,
  ouPy,
  stripPy,
  strPy,
  veritePy,
} from "@elpis/commun";
import type { Dict, ErreurPydantic } from "@elpis/commun";
import type { Base } from "@elpis/db";
import type { FastifyReply, FastifyRequest } from "fastify";

import {
  avecVerrouEcriture,
  deleteGlobalSkill,
  deleteLearnedSkill,
  deleteUserSkill,
  discoverSkills,
  discoverSkillsBySource,
  exportSkillZip,
  findGlobalEntry,
  findLearnedEntry,
  findUserEntry,
  installSkillZip,
  invalidateSkillsScanCache,
  parseTags,
  promoteLearnedSkill,
  racineSkillsGlobale,
  resumeSkill,
  saveGlobalSkill,
  saveLearnedSkill,
  saveUserSkill,
  SKILL_ZIP_MAX_FILES,
  SKILL_ZIP_MAX_UNCOMPRESSED,
  SkillExistsError,
  SkillSaveError,
  slugifyName,
  syncUserMirror,
  userSkillsDir,
} from "../skills/bibliotheque";
import type { SkillSpec } from "../skills/bibliotheque";
import { estErreurOs, estSous, nomDe, pyJoin, pyPath, resoudre, stemDe } from "../skills/chemins";
import { splitFrontmatter, strFrontmatter, veriteFrontmatter } from "../skills/frontmatter";
import type { Famille } from "../routes";
import { utilisateur } from "./comptes";
import {
  corpsJsonValeurs,
  entrees,
  erreurValidation,
  lireFormulaire,
  py,
  repondreAnnote,
  reponseJsonPy,
  valeursFormulaire,
} from "@elpis/http";
import type { ErreurPy, FichierRecu, Formulaire } from "@elpis/http";

export interface DependancesSkills {
  readonly base: Base;
  /** `_sync_user_mirror`, appelé hors du verrou d'écriture après chaque mutation du magasin perso. */
  readonly synchroniserMiroir?: (uid: number) => Promise<void>;
}

interface Champs {
  name: string;
  description: string;
  body: string;
  tags: string[];
  domain: string;
}

type Charge = { brut: true; rawMd: string; filename: unknown } | ({ brut: false } & Champs);

const PLAFOND_LECTURE = 256 * 1024;
const ERRNO_IGNORES = new Set(["ENOENT", "ENOTDIR", "EBADF", "ELOOP"]);
const UTF8_REMPLACEMENT = new TextDecoder("utf-8", { ignoreBOM: true });
const ENTETE_LATIN1 = /^[\t\x20-\x7e\x80-\xff]*$/u;

/** `_require_admin` : 403 « Admin required » hors admin. */
async function exigerAdmin(base: Base, uid: number): Promise<void> {
  const moi = await ligneUtilisateur(base, uid);
  if (!moi || Number(moi.is_admin) !== 1) throw new HttpError(403, "Admin required");
}

/** `_json_body` : JSON illisible = `{}`, autre chose qu'un objet = 400. */
function corpsObjet(req: FastifyRequest): Dict {
  let data: unknown;
  try {
    data = corpsJsonValeurs(req);
  } catch {
    data = {};
  }
  if (!estDict(data)) throw new HttpError(400, "body JSON attendu");
  return data;
}

/** `_validate_scope` : user, learned ou global (casse et blancs ignorés), 400 sinon ; une valeur non textuelle lève comme `.strip()`. */
function scopeValide(scope: unknown, defaut = "user"): string {
  const v = ouPy(scope, defaut);
  if (typeof v !== "string")
    throw new ErreurPython("AttributeError", `'${nomTypePy(v)}' object has no attribute 'strip'`);
  const s = lowerPy(stripPy(v));
  if (s !== "user" && s !== "learned" && s !== "global")
    throw new HttpError(400, "scope doit être user, learned ou global");
  return s;
}

/** Paramètre de requête non déclaré (`request.query_params.get`) : la dernière valeur, `null` s'il manque. */
function parametre(req: FastifyRequest, nom: string): string | null {
  return entrees(req, { query: { [nom]: py.optional(py.str()).defaut(null) } }).query[nom] as string | null;
}

function nomDuChemin(req: FastifyRequest): string {
  return entrees(req, { path: { name: py.str() } }).path.name;
}

/** `_require_user_skills_dir` : magasin perso protégé du compte, 500 s'il est introuvable. */
async function dossierPerso(uid: number): Promise<string> {
  const d = await userSkillsDir(uid);
  if (d === null) throw new HttpError(500, "store de skills utilisateur introuvable");
  return d;
}

/** `_find_spec` : id qualifié, puis nom exact ou slug ; vue fusionnée, ou inventaire réel d'un seul scope. */
async function trouverSpec(name: string, uid: number, scope: string | null): Promise<SkillSpec | null> {
  const slug = slugifyName(name);
  const dossier = await userSkillsDir(uid);
  const specs = scope ? await discoverSkillsBySource(scope, dossier) : await discoverSkills(dossier);
  return (
    specs.find((s) => s.id === name) ??
    specs.find((s) => s.name === name || slugifyName(s.name) === slug) ??
    null
  );
}

/** `_skill_exists` : un skill de ce slug existe déjà dans le scope (dossiers et sous-skills compris). */
async function skillExiste(scope: string, uid: number, slug: string): Promise<boolean> {
  if (scope === "user") {
    const d = await userSkillsDir(uid);
    return d !== null && (await findUserEntry(d, slug)) !== null;
  }
  if (scope === "learned") return (await findLearnedEntry(slug)) !== null;
  return (await findGlobalEntry(slug)) !== null;
}

const texteDe = (data: Dict, cle: string): string => stripPy(strPy(ouPy(lire(data, cle) ?? null, "")));
const texteFm = (v: unknown): string => stripPy(strFrontmatter(veriteFrontmatter(v) ? v : ""));

/** `_parse_payload` : import d'un markdown complet (`raw_md`) ou champs, `name` et `body` exigés. */
function lireCharge(data: Dict): Charge {
  const rawMd = lire(data, "raw_md");
  if (typeof rawMd === "string" && stripPy(rawMd))
    return { brut: true, rawMd, filename: lire(data, "filename") ?? null };
  const name = texteDe(data, "name");
  if (!name) throw new HttpError(400, "champ 'name' requis");
  const body = texteDe(data, "body");
  if (!body) throw new HttpError(400, "champ 'body' requis");
  return {
    brut: false,
    name,
    description: texteDe(data, "description"),
    body,
    tags: parseTags(lire(data, "tags") ?? null),
    domain: texteDe(data, "domain"),
  };
}

/** `_resolve_fields` : champs concrets ; un markdown sans nom (frontmatter ni fichier) ou sans corps lève SkillSaveError. */
function champs(c: Charge): Champs {
  if (!c.brut) return c;
  const [meta, brut] = splitFrontmatter(c.rawMd || "");
  const body = stripPy(brut || "");
  let name = texteFm(meta.get("name"));
  if (!name && veritePy(c.filename)) {
    const f = strPy(c.filename);
    const fname = f.slice(f.lastIndexOf("/") + 1);
    name = lowerPy(fname).endsWith(".md") ? fname.slice(0, -3) : fname;
  }
  if (!name)
    throw new SkillSaveError("name introuvable : ajoute un frontmatter 'name:' ou un nom de fichier valide");
  if (!body) throw new SkillSaveError("body requis (la procédure ne peut pas être vide)");
  return {
    name,
    description: texteFm(meta.get("description")),
    body,
    tags: parseTags(meta.get("tags") ?? null),
    domain: texteFm(meta.get("domain")),
  };
}

/** Slug du nom visé par une charge ; une charge invalide donne le 400 de la route. */
function slugDe(c: Charge): string {
  try {
    return slugifyName(champs(c).name);
  } catch (e) {
    if (e instanceof SkillSaveError) throw new HttpError(400, e.message);
    throw e;
  }
}

/** `_write_skill` : écriture dans le scope ciblé, renommage (`prevName`) fait par l'écrivain sous son verrou. */
async function ecrireSkill(
  scope: string,
  uid: number,
  c: Charge,
  prevName: string | null,
): Promise<[string, string]> {
  const f = champs(c);
  const options = { prevName };
  if (scope === "user")
    return [
      await saveUserSkill(
        await dossierPerso(uid),
        f.name,
        f.description,
        f.body,
        f.tags,
        f.domain || null,
        options,
      ),
      f.name,
    ];
  const ecrivain = scope === "learned" ? saveLearnedSkill : saveGlobalSkill;
  return [await ecrivain(f.name, f.description, f.body, f.tags, f.domain || null, options), f.name];
}

/** Erreur métier de la bibliothèque rendue en `statut` (le message tel quel). */
async function enHttp<T>(statut: number, f: () => Promise<T>): Promise<T> {
  try {
    return await f();
  } catch (e) {
    if (e instanceof SkillSaveError) throw new HttpError(statut, e.message);
    throw e;
  }
}

/** `_skill_scope_dest` : import vers le magasin perso, ou la bibliothèque curée (admin) ; jamais vers `learned`. */
async function scopeEtDestination(base: Base, uid: number, brut: string): Promise<[string, string]> {
  const scope = scopeValide(brut);
  if (scope === "learned")
    throw new HttpError(400, "import vers 'learned' non supporté (scope: user|global)");
  if (scope === "global") {
    await exigerAdmin(base, uid);
    return [scope, racineSkillsGlobale()];
  }
  return [scope, await dossierPerso(uid)];
}

/** Erreurs d'un 422 à grouper avec d'autres (requête puis corps, comme FastAPI) ; toute autre erreur remonte. */
function erreursValidation(e: unknown): ErreurPydantic[] {
  if (e instanceof ErreurValidation) return e.erreurs;
  throw e;
}

/** `List[UploadFile] = File(...)` ou `List[str] = Form(...)` : toutes les valeurs du nom, liste vide = absente. */
function listeFormulaire(f: Formulaire, nom: string, type: "fichier" | "texte"): ErreurPy[] {
  const valeurs = f.getAll(nom);
  if (valeurs.length === 0)
    return [{ type: "missing", loc: ["body", nom], msg: "Field required", input: null }];
  const erreurs: ErreurPy[] = [];
  valeurs.forEach((v, i) => {
    if (type === "fichier" && typeof v === "string")
      erreurs.push({
        type: "value_error",
        loc: ["body", nom, i],
        msg: "Value error, Expected UploadFile, received: <class 'str'>",
        input: v,
        ctx: { error: {} },
      });
    else if (type === "texte" && typeof v !== "string")
      erreurs.push({
        type: "string_type",
        loc: ["body", nom, i],
        msg: "Input should be a valid string",
        input: { filename: v.filename, size: v.taille },
      });
  });
  return erreurs;
}

/** Paramètres de requête communs aux deux imports. */
function optionsImport(req: FastifyRequest): { scope: string; overwrite: boolean } {
  return entrees(req, { query: { scope: py.str().defaut("user"), overwrite: py.bool().defaut(false) } })
    .query;
}

/** `ZipFile.writestr` en mémoire (deflate, 0o600, date locale) : le dossier envoyé repasse par l'import .zip. */
function zipDuDossier(fichiers: readonly (readonly [string, Buffer])[]): Buffer {
  const dateHeure = dateHeureLocale(Date.now());
  return ecrireZip(
    fichiers.map(([nom, donnees]) => ({
      nom: nom.split("\0")[0] ?? "",
      donnees,
      dateHeure,
      attributsExternes: (0o600 << 16) >>> 0,
    })),
  );
}

/** `Path.is_file()` de Python 3.13 : faux si absent, une erreur d'E/S inattendue (nom trop long…) remonte. */
async function estFichierPy(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isFile();
  } catch (e) {
    if (ERRNO_IGNORES.has(String((e as { code?: unknown }).code ?? ""))) return false;
    throw e;
  }
}

/** `_read_text_capped` : au plus `plafond` octets, décodés en UTF-8 avec remplacement. */
async function lirePlafonne(p: string, plafond = PLAFOND_LECTURE): Promise<string> {
  const fh = await open(p, "r");
  try {
    const tampon = Buffer.alloc(plafond);
    let lus = 0;
    while (lus < plafond) {
      const { bytesRead } = await fh.read(tampon, lus, plafond - lus, null);
      if (bytesRead === 0) break;
      lus += bytesRead;
    }
    return UTF8_REMPLACEMENT.decode(tampon.subarray(0, lus));
  } finally {
    await fh.close();
  }
}

/** `str(OSError)` : chemin en cause s'il y en a un (ouverture), aucun pour une erreur de lecture. */
function messageOs(e: unknown): string {
  const chemin = (e as { path?: unknown }).path;
  const texte = messageErreurOs(e, typeof chemin === "string" ? chemin : "");
  return typeof chemin === "string" ? texte : texte.slice(0, -": ''".length);
}

/** `Path(rel).parts` contient `..`. */
function remonte(rel: string): boolean {
  return pyPath(rel).split("/").includes("..");
}

/** Le 409 d'un import sans `overwrite` : skills déjà présents, pour que l'interface confirme. */
function dejaPresents(rep: FastifyReply, e: SkillExistsError, scope: string): FastifyReply {
  return reponseJsonPy(rep.code(409), { detail: e.message, name: e.names[0] ?? "", names: e.names, scope });
}

export function creerFamilleSkills(dep: DependancesSkills): Famille {
  const base = dep.base;
  const synchroniser = dep.synchroniserMiroir ?? syncUserMirror;

  /** Import commun au .zip et au dossier : 409 si présent sans `overwrite`, miroir resynchronisé pour le magasin perso. */
  const installer = async (
    rep: FastifyReply,
    uid: number,
    scope: string,
    dest: string,
    archive: Buffer,
    overwrite: boolean,
  ): Promise<FastifyReply> => {
    let importes: string[];
    try {
      importes = await installSkillZip(archive, dest, { source: scope, strict: false, overwrite });
    } catch (e) {
      if (e instanceof SkillExistsError) return dejaPresents(rep, e, scope);
      if (e instanceof SkillSaveError) throw new HttpError(400, e.message);
      throw e;
    }
    if (scope === "user") await synchroniser(uid);
    return repondreAnnote(rep, {
      ok: true,
      imported: importes,
      count: importes.length,
      name: importes[0] ?? "",
      scope,
    });
  };

  return {
    nom: "skills",
    routes: [
      {
        methode: "GET",
        chemin: "/api/skills",
        processus: ["main"],
        acces: "session",
        traiter: async (req, rep) => {
          const uid = utilisateur(req);
          const brut = parametre(req, "scope");
          const scope = brut ? scopeValide(brut) : null;
          const dossier = await userSkillsDir(uid);
          const specs = scope ? await discoverSkillsBySource(scope, dossier) : await discoverSkills(dossier);
          return repondreAnnote(rep, { skills: specs.map(resumeSkill), count: specs.length });
        },
      },
      {
        methode: "GET",
        chemin: "/api/skills/file",
        processus: ["main"],
        acces: "session",
        traiter: async (req, rep) => {
          const uid = utilisateur(req);
          const q = entrees(req, {
            query: {
              id: py.str(),
              path: py.str().defaut("SKILL.md"),
              scope: py.optional(py.str()).defaut(null),
            },
          }).query;
          const spec = await trouverSpec(q.id, uid, q.scope ? scopeValide(q.scope) : null);
          if (spec === null) throw new HttpError(404, `skill introuvable : ${q.id}`);
          const rel = (q.path || "SKILL.md").replaceAll("\\", "/").replace(/^\/+/u, "");
          if (remonte(rel)) throw new HttpError(400, "chemin invalide");
          if (!spec.skillDir) {
            if (spec.path && (rel === "SKILL.md" || rel === nomDe(spec.path)))
              return repondreAnnote(rep, { id: spec.id, path: rel, content: await lirePlafonne(spec.path) });
            throw new HttpError(404, "fichier introuvable");
          }
          let cible: string;
          let fichier: boolean;
          try {
            cible = resoudre(pyJoin(spec.skillDir, rel));
            if (cible !== resoudre(spec.skillDir) && !estSous(cible, spec.skillDir))
              throw new HttpError(400, "chemin hors du skill");
            fichier = await estFichierPy(cible);
          } catch (e) {
            if (estErreurOs(e)) throw new HttpError(400, "chemin invalide");
            throw e;
          }
          if (!fichier) throw new HttpError(404, `fichier introuvable : ${rel}`);
          let content: string;
          try {
            content = await lirePlafonne(cible);
          } catch (e) {
            if (estErreurOs(e)) throw new HttpError(503, `lecture échouée : ${messageOs(e)}`);
            throw e;
          }
          return repondreAnnote(rep, { id: spec.id, path: rel, content });
        },
      },
      {
        methode: "GET",
        chemin: "/api/skills/:name",
        processus: ["main"],
        acces: "session",
        traiter: async (req, rep) => {
          const uid = utilisateur(req);
          const brut = parametre(req, "scope");
          const scope = brut ? scopeValide(brut) : null;
          const ident = stripPy(parametre(req, "id") || nomDuChemin(req));
          const spec = await trouverSpec(ident, uid, scope);
          if (spec === null) throw new HttpError(404, `Skill introuvable : ${ident}`);
          return repondreAnnote(rep, { ...resumeSkill(spec), body: spec.body });
        },
      },
      {
        methode: "POST",
        chemin: "/api/skills",
        processus: ["main"],
        acces: "session",
        traiter: async (req, rep) => {
          const uid = utilisateur(req);
          const data = corpsObjet(req);
          const scope = scopeValide(lire(data, "scope") ?? null);
          if (scope !== "user") await exigerAdmin(base, uid);
          const charge = lireCharge(data);
          const slug = slugDe(charge);
          const [dest, name] = await enHttp(400, () =>
            avecVerrouEcriture(async () => {
              invalidateSkillsScanCache();
              if (slug && (await skillExiste(scope, uid, slug)))
                throw new HttpError(
                  409,
                  `un skill '${slug}' existe déjà (${scope}) — utilise PUT pour le mettre à jour`,
                );
              return ecrireSkill(scope, uid, charge, null);
            }),
          );
          if (scope === "user") await synchroniser(uid);
          return repondreAnnote(rep, { ok: true, name, path: dest, source: scope });
        },
      },
      {
        methode: "PUT",
        chemin: "/api/skills/:name",
        processus: ["main"],
        acces: "session",
        traiter: async (req, rep) => {
          const uid = utilisateur(req);
          const data = { ...corpsObjet(req) };
          const ident = stripPy(parametre(req, "id") || nomDuChemin(req)).replace(/^\/+|\/+$/gu, "");
          const feuille = ident.slice(ident.lastIndexOf("/") + 1);
          if (!Object.hasOwn(data, "name")) data["name"] = feuille;
          const scope = scopeValide(lire(data, "scope") ?? null);
          if (scope !== "user") await exigerAdmin(base, uid);
          const charge = lireCharge(data);
          const nouveau = slugDe(charge);
          const [dest, name] = await enHttp(400, () =>
            avecVerrouEcriture(async () => {
              invalidateSkillsScanCache();
              if (nouveau && nouveau !== slugifyName(feuille) && (await skillExiste(scope, uid, nouveau)))
                throw new HttpError(
                  409,
                  `un skill '${nouveau}' existe déjà (${scope}) — choisis un nom libre`,
                );
              return ecrireSkill(scope, uid, charge, ident);
            }),
          );
          if (scope === "user") await synchroniser(uid);
          return repondreAnnote(rep, { ok: true, name, path: dest, source: scope });
        },
      },
      {
        methode: "DELETE",
        chemin: "/api/skills/:name",
        processus: ["main"],
        acces: "session",
        traiter: async (req, rep) => {
          const uid = utilisateur(req);
          const scope = scopeValide(parametre(req, "scope"));
          const ident = stripPy(parametre(req, "id") || nomDuChemin(req));
          let supprime: boolean;
          if (scope === "user") supprime = await deleteUserSkill(await dossierPerso(uid), ident);
          else {
            await exigerAdmin(base, uid);
            supprime = scope === "learned" ? await deleteLearnedSkill(ident) : await deleteGlobalSkill(ident);
          }
          if (!supprime) throw new HttpError(404, `skill introuvable : ${ident}`);
          if (scope === "user") await synchroniser(uid);
          return repondreAnnote(rep, { ok: true, name: ident, scope, deleted: true });
        },
      },
      {
        methode: "POST",
        chemin: "/api/skills/promote",
        processus: ["main"],
        acces: "admin",
        traiter: async (req, rep) => {
          const name = texteDe(corpsObjet(req), "name");
          if (!name) throw new HttpError(400, "champ 'name' requis");
          const dest = await enHttp(409, () => promoteLearnedSkill(name));
          return repondreAnnote(rep, { ok: true, name: stemDe(dest), path: dest, source: "global" });
        },
      },
      {
        methode: "POST",
        chemin: "/api/skills/import",
        processus: ["main"],
        acces: "session",
        traiter: async (req, rep) => {
          const uid = utilisateur(req);
          const formulaire = await lireFormulaire(req);
          const erreurs: ErreurPydantic[] = [];
          let options = { scope: "user", overwrite: false };
          try {
            options = optionsImport(req);
          } catch (e) {
            erreurs.push(...erreursValidation(e));
          }
          let fichier: FichierRecu | null = null;
          try {
            fichier = valeursFormulaire(formulaire, { file: { type: "fichier", requis: true } }).file;
          } catch (e) {
            erreurs.push(...erreursValidation(e));
          }
          if (erreurs.length > 0 || fichier === null) throw new ErreurValidation(erreurs);
          const [scope, dest] = await scopeEtDestination(base, uid, options.scope);
          let archive: Buffer;
          try {
            archive = await readFile(fichier.chemin);
          } catch {
            throw new HttpError(400, "lecture du fichier envoyé échouée — réessaie l'upload");
          }
          return installer(rep, uid, scope, dest, archive, options.overwrite);
        },
      },
      {
        methode: "POST",
        chemin: "/api/skills/import-folder",
        processus: ["main"],
        acces: "session",
        traiter: async (req, rep) => {
          const uid = utilisateur(req);
          const formulaire = await lireFormulaire(req);
          const erreurs: ErreurPydantic[] = [];
          let options = { scope: "user", overwrite: false };
          try {
            options = optionsImport(req);
          } catch (e) {
            erreurs.push(...erreursValidation(e));
          }
          erreurs.push(
            ...erreurValidation([
              ...listeFormulaire(formulaire, "files", "fichier"),
              ...listeFormulaire(formulaire, "paths", "texte"),
            ]).erreurs,
          );
          if (erreurs.length > 0) throw new ErreurValidation(erreurs);
          const files = formulaire.getAll("files") as FichierRecu[];
          const paths = formulaire.getAll("paths") as string[];
          const [scope, dest] = await scopeEtDestination(base, uid, options.scope);
          if (files.length !== paths.length)
            throw new HttpError(400, "upload invalide (files/paths dépareillés)");
          if (files.length > SKILL_ZIP_MAX_FILES)
            throw new HttpError(400, `trop de fichiers (${files.length} > ${SKILL_ZIP_MAX_FILES})`);
          const contenus: [string, Buffer][] = [];
          let total = 0;
          for (const [i, f] of files.entries()) {
            const brut = paths[i] ?? "";
            const arc = brut.replaceAll("\\", "/");
            const parts = arc.split("/").filter((p) => p !== "" && p !== ".");
            if (parts.length === 0) continue;
            if (arc.startsWith("/") || parts.includes(".."))
              throw new HttpError(400, `chemin dangereux refusé : ${brut}`);
            if (parts.some((p) => p.startsWith("."))) continue;
            let blob: Buffer;
            try {
              blob = await readFile(f.chemin);
            } catch {
              throw new HttpError(400, `lecture échouée : ${arc}`);
            }
            total += blob.length;
            if (total > SKILL_ZIP_MAX_UNCOMPRESSED)
              throw new HttpError(
                400,
                `dossier trop volumineux (> ${Math.floor(SKILL_ZIP_MAX_UNCOMPRESSED / 1048576)} Mo)`,
              );
            contenus.push([parts.join("/"), blob]);
          }
          if (contenus.length === 0) throw new HttpError(400, "aucun fichier exploitable dans le dossier");
          return installer(rep, uid, scope, dest, zipDuDossier(contenus), options.overwrite);
        },
      },
      {
        methode: "GET",
        chemin: "/api/skills/:name/export",
        processus: ["main"],
        acces: "session",
        traiter: async (req, rep) => {
          const uid = utilisateur(req);
          const brut = parametre(req, "scope");
          const ident = stripPy(parametre(req, "id") || nomDuChemin(req));
          const spec = await trouverSpec(ident, uid, brut ? scopeValide(brut) : null);
          if (spec === null) throw new HttpError(404, `skill '${ident}' introuvable`);
          const archive = await enHttp(400, () => exportSkillZip(spec));
          const disposition = `attachment; filename="${spec.name}.zip"`;
          if (!ENTETE_LATIN1.test(disposition))
            throw new ErreurPython(
              "ValueError",
              "'latin-1' codec can't encode the Content-Disposition header",
            );
          return rep.header("content-disposition", disposition).type("application/zip").send(archive);
        },
      },
    ],
  };
}
