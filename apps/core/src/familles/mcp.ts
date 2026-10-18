// SPDX-License-Identifier: MIT
/** apps/core/src/familles/mcp.ts — `/api/mcp` : serveurs déposés en dossier, catégories d'outils, serveurs du manifeste, bibliothèque partagée (écriture admin, stdio refusé), bouton « Tester » (shared_infra/mcp/panel.py). */
import { lstatSync, mkdirSync, opendirSync, readFileSync, rmSync, statSync } from "node:fs";
import path from "node:path";

import { getUserSettings, ligneUtilisateur } from "@elpis/auth";
import {
  arrondiPy,
  decoderUtf8IgnorePy,
  decoderUtf8Py,
  ErreurPython,
  ErreurValidation,
  estDict,
  getPy,
  HttpError,
  lowerPy,
  messageErreurOs,
  prefixePy,
  reprPy,
  splitlinesPy,
  stripPy,
  strPy,
  veritePy,
} from "@elpis/commun";
import type { Dict, ErreurPydantic } from "@elpis/commun";
import { config, parseJsonPy, realpathPy } from "@elpis/config";
import type { Base } from "@elpis/db";
import {
  AUTH_MODES,
  course,
  createShared,
  DEFAULT_HEADER_NAME,
  deleteShared,
  getShared,
  headerNameOk,
  HTTP_TYPES,
  InvalidPair,
  invaliderMcp,
  listShared,
  load as chargerManifeste,
  mergePersonalMcp,
  personalToConfig,
  rawShared,
  resolveConfig,
  sanitizePairs,
  SERVER_TYPES,
  sharedId,
  signalBorne,
  StdioNotAllowed,
  updateShared,
} from "@elpis/mcp";
import type { ChampsPartage, ClientMcp, ConfigMcp } from "@elpis/mcp";
import { EncryptionUnavailable } from "@elpis/securite";
import type { FastifyRequest } from "fastify";

import { getCategories, toolInfo } from "../outils/categories";
import { friendlyMcpError, masquerAdresse, resoudreClientMcp } from "../outils/mcp/clients";
import type { Famille } from "../routes";
import { utilisateur } from "./comptes";
import { corpsJson, enregistrerBorne, entrees, lireFormulaire, py } from "@elpis/http";
import type { FichierRecu, Formulaire } from "@elpis/http";

export interface DependancesMcp {
  readonly base: Base;
}

/** Délai de l'essai d'un serveur (« Tester »), réglable par les tests. */
export const reglagesMcp = { delaiEssaiMs: 20_000 };

export const STDIO_REFUSE =
  "Serveur MCP de type stdio (commande lancée sur le serveur) : non pris en charge par le core " +
  "(plus aucun sous-processus) — publiez-le en HTTP streamable ou SSE.";
const SANS_CHIFFREMENT =
  "Clé de chiffrement indisponible : impossible d'enregistrer un identifiant. Configurez APP_ENCRYPTION_KEY.";
const FICHIERS_DEMARRAGE = ["start", "start.txt", "start.sh", "start.bat"];
const POINTS_ENTREE = ["main.py", "server.py", "__main__.py", "index.js", "server.js", "app.py", "app.js"];
const BOM = Buffer.from([0xef, 0xbb, 0xbf]);

/** `os.path.join(a, b)` pour un nom sans `/`. */
function joindre(a: string, b: string): string {
  return a.endsWith("/") ? a + b : `${a}/${b}`;
}

/** `Path.exists()` : liens suivis, toute erreur = absent. */
function existe(chemin: string): boolean {
  try {
    statSync(chemin);
    return true;
  } catch {
    return false;
  }
}

/** `_path_inside` sur deux chemins déjà résolus : la racine elle-même ou dessous. */
function dedans(cible: string, racine: string): boolean {
  return cible === racine || cible.startsWith(racine === "/" ? "/" : `${racine}/`);
}

/** `str(OSError)` d'une erreur du système de fichiers, sinon son message (`str(e)`). */
function messageDe(e: unknown): string {
  const code = (e as { code?: unknown } | null)?.code;
  if (typeof code === "string" && /^E[A-Z]+$/u.test(code))
    return messageErreurOs(e, String((e as { path?: unknown }).path ?? ""));
  return e instanceof Error ? e.message : strPy(e);
}

// ── Dossiers déposés : commande suggérée (_detect_mcp_command) ──────────────

/** `os.scandir` : entrées dans l'ordre du système de fichiers, dossiers reconnus à travers les liens. */
function lireDossier(dossier: string): { nom: string; dossier: boolean }[] {
  const d = opendirSync(dossier);
  const out: { nom: string; dossier: boolean }[] = [];
  try {
    for (let e = d.readSync(); e !== null; e = d.readSync()) {
      let estDossier = e.isDirectory();
      if (e.isSymbolicLink() || (!estDossier && !e.isFile())) {
        try {
          estDossier = statSync(joindre(dossier, e.name)).isDirectory();
        } catch {
          estDossier = false;
        }
      }
      out.push({ nom: e.name, dossier: estDossier });
    }
  } finally {
    d.closeSync();
  }
  return out;
}

/** `os.walk(racine)` : (dossier, fichiers) en profondeur d'abord, liens vers des dossiers non suivis, erreurs ignorées. */
function* parcourir(racine: string): Generator<[string, string[]]> {
  let liste: { nom: string; dossier: boolean }[];
  try {
    liste = lireDossier(racine);
  } catch {
    return;
  }
  yield [racine, liste.filter((e) => !e.dossier).map((e) => e.nom)];
  for (const e of liste) {
    if (!e.dossier) continue;
    const sous = joindre(racine, e.nom);
    let lien: boolean;
    try {
      lien = lstatSync(sous).isSymbolicLink();
    } catch {
      lien = false;
    }
    if (!lien) yield* parcourir(sous);
  }
}

/** `{f.lower(): f}` : le dernier nom du parcours l'emporte. */
function parNomMinuscule(fichiers: readonly string[]): Map<string, string> {
  return new Map(fichiers.map((f) => [lowerPy(f), f]));
}

/** `cle in conteneur` : clé d'un dict, élément d'une liste, sous-chaîne d'un texte ; TypeError sinon. */
function contient(conteneur: unknown, cle: string): boolean {
  if (typeof conteneur === "string") return conteneur.includes(cle);
  if (Array.isArray(conteneur)) return conteneur.includes(cle);
  if (estDict(conteneur)) return Object.hasOwn(conteneur, cle);
  throw new ErreurPython("TypeError", "argument is not iterable");
}

/** `package.json` avec un script `start` ; toute erreur de lecture ou de forme = non. */
function npmStart(dossier: string): boolean {
  const fichier = joindre(dossier, "package.json");
  if (!existe(fichier)) return false;
  try {
    const donnees = parseJsonPy(decoderUtf8Py(readFileSync(fichier)));
    return estDict(donnees) && Object.hasOwn(donnees, "scripts") && contient(donnees["scripts"], "start");
  } catch {
    return false;
  }
}

/** Première ligne ni vide ni commentaire d'un fichier `start*` (BOM : UTF-8 strict, sinon octets invalides ignorés). */
function premiereLigne(chemin: string): string | null {
  try {
    const brut = readFileSync(chemin);
    const contenu = brut.subarray(0, 3).equals(BOM)
      ? decoderUtf8Py(brut.subarray(3))
      : decoderUtf8IgnorePy(brut);
    for (const ligne of splitlinesPy(contenu)) {
      const l = stripPy(ligne);
      if (l && !l.startsWith("#")) return l;
    }
  } catch {
    return null;
  }
  return null;
}

/** `_detect_mcp_command` : `npm start`, première ligne utile d'un fichier `start*`, sinon `python`/`node` d'un point d'entrée ; `""` sinon. */
export function detecterCommande(dossier: string): string {
  if (npmStart(dossier)) return "npm start";
  for (const [racine, fichiers] of parcourir(dossier)) {
    const parNom = parNomMinuscule(fichiers);
    for (const nom of FICHIERS_DEMARRAGE) {
      const reel = parNom.get(nom);
      if (reel === undefined) continue;
      const ligne = premiereLigne(joindre(racine, reel));
      if (ligne !== null) return ligne;
    }
  }
  for (const [racine, fichiers] of parcourir(dossier)) {
    const parNom = parNomMinuscule(fichiers);
    for (const nom of POINTS_ENTREE) {
      const reel = parNom.get(nom);
      if (reel === undefined) continue;
      const chemin = joindre(racine, reel);
      if (path.posix.normalize(chemin).split("/").includes("node_modules")) continue;
      const rel = path.posix.relative(path.posix.normalize(dossier), path.posix.normalize(chemin));
      return nom.endsWith(".py") ? `python ${rel}` : `node ${rel}`;
    }
  }
  return "";
}

/** `PurePosixPath(s).parts` : racine `/` (ou `//` exactement), composants non vides hors `.`. */
export function partiesChemin(s: string): string[] {
  const racine = s.startsWith("/") ? (s.startsWith("//") && !s.startsWith("///") ? "//" : "/") : "";
  const composants = s.split("/").filter((c) => c !== "" && c !== ".");
  return racine ? [racine, ...composants] : composants;
}

/** Nom de dossier assaini : `c.isalnum()` (lettres et chiffres Unicode), `-` et `_`. */
export function nomDeDossier(nom: string): string {
  return [...nom].filter((c) => /^[\p{L}\p{N}]$/u.test(c) || c === "-" || c === "_").join("");
}

function listerDossiers(req: FastifyRequest): Dict {
  utilisateur(req);
  const racine = config.MCP_SERVERS_DIR;
  const servers: Dict[] = [];
  if (existe(racine)) {
    for (const e of lireDossier(racine)) {
      if (!e.dossier) continue;
      const chemin = joindre(racine, e.nom);
      servers.push({ name: e.nom, path: chemin, suggested_cmd: detecterCommande(chemin) });
    }
  }
  return { servers, root_path: racine };
}

/** `files: List[UploadFile] = File(...)`, `paths: List[str] = Form(...)` : un 422 groupé comme FastAPI. */
function listesDuDepot(f: Formulaire): { fichiers: FichierRecu[]; chemins: string[] } {
  const erreurs: ErreurPydantic[] = [];
  const fichiers: FichierRecu[] = [];
  const chemins: string[] = [];
  const bruts = f.getAll("files");
  if (bruts.length === 0)
    erreurs.push({ type: "missing", loc: ["body", "files"], msg: "Field required", input: null });
  bruts.forEach((v, i) => {
    if (typeof v !== "string") fichiers.push(v);
    else
      erreurs.push({
        type: "value_error",
        loc: ["body", "files", i],
        msg: "Value error, Expected UploadFile, received: <class 'str'>",
        input: v,
        ctx: { error: {} },
      } as ErreurPydantic);
  });
  const textes = f.getAll("paths");
  if (textes.length === 0)
    erreurs.push({ type: "missing", loc: ["body", "paths"], msg: "Field required", input: null });
  textes.forEach((v, i) => {
    if (typeof v === "string") chemins.push(v);
    else
      erreurs.push({
        type: "string_type",
        loc: ["body", "paths", i],
        msg: "Input should be a valid string",
        input: { filename: v.filename, size: v.taille },
      });
  });
  if (erreurs.length > 0) throw new ErreurValidation(erreurs);
  return { fichiers, chemins };
}

/** Dépôt d'un dossier (admin) : chaque chemin reste sous le dossier créé, sinon tout est retiré ; jamais de dépôt partiel. */
async function deposer(req: FastifyRequest): Promise<Dict> {
  const { fichiers, chemins } = listesDuDepot(await lireFormulaire(req));
  if (fichiers.length !== chemins.length) throw new HttpError(400, "Données invalides");
  const premier = partiesChemin(chemins[0] ?? "");
  let nom = nomDeDossier(premier.length > 1 ? (premier[0] ?? "") : "mcp_server");
  if (!nom) nom = `mcp_${Math.floor(Date.now() / 1000)}`;
  let cible = joindre(config.MCP_SERVERS_DIR, nom);
  if (existe(cible)) {
    nom = `${nom}_${Math.floor(Date.now() / 1000)}`;
    cible = joindre(config.MCP_SERVERS_DIR, nom);
  }
  const cibleResolue = realpathPy(cible);
  try {
    mkdirSync(cible, { recursive: true });
    for (const [i, fichier] of fichiers.entries()) {
      const brut = chemins[i] ?? "";
      if (brut.startsWith("/")) throw new HttpError(403, "Chemin absolu refusé");
      const parties = partiesChemin(brut);
      if (parties.length === 0) throw new HttpError(500, "tuple index out of range");
      const rel = parties.length > 1 ? parties.slice(1) : parties;
      const relatif = rel.join("/");
      if (!relatif || relatif === ".") continue;
      if (rel.includes("..")) throw new HttpError(403, "Composant '..' refusé dans le chemin");
      const final = realpathPy(joindre(cible, relatif));
      if (!dedans(final, cibleResolue)) throw new HttpError(403, `Chemin hors du dossier MCP: ${relatif}`);
      mkdirSync(path.dirname(final), { recursive: true });
      await enregistrerBorne(fichier, final, config.MAX_UPLOAD_BYTES);
    }
    return { ok: true, server_name: nom, path: cible, suggested_cmd: detecterCommande(cible) };
  } catch (e) {
    if (existe(cible)) {
      try {
        rmSync(cible, { recursive: true, force: true });
      } catch {
        // nettoyage au mieux, comme le rmtree du Python
      }
    }
    if (e instanceof HttpError) throw e;
    throw new HttpError(500, messageDe(e));
  }
}

function supprimerDossier(req: FastifyRequest): Dict {
  const { name } = entrees(req, { path: { name: py.str() } }).path;
  if (!name || ["..", "/", "\\", "\0"].some((c) => name.includes(c)))
    throw new HttpError(400, "Nom invalide");
  const racine = realpathPy(config.MCP_SERVERS_DIR);
  const cible = realpathPy(joindre(config.MCP_SERVERS_DIR, name));
  if (!dedans(cible, racine) || cible === racine) throw new HttpError(400, "Nom invalide");
  if (!existe(cible)) throw new HttpError(404, "Serveur introuvable");
  if (!statSync(cible).isDirectory())
    throw new HttpError(500, `Erreur suppression: [Errno 20] Not a directory: PosixPath(${reprPy(cible)})`);
  try {
    rmSync(cible, { recursive: true });
  } catch (e) {
    throw new HttpError(500, `Erreur suppression: ${messageDe(e)}`);
  }
  return { ok: true };
}

// ── Catalogue : catégories et serveurs du manifeste ─────────────────────────

function categories(req: FastifyRequest): Dict {
  utilisateur(req);
  const out = getCategories().map((c) => {
    const d: Dict = {};
    for (const [k, v] of Object.entries(c)) if (k !== "tools") d[k] = v;
    const outils = c.tools;
    d["tools"] = (veritePy(outils) ? [...outils] : []).map((n) => toolInfo(n));
    return d;
  });
  return { ok: true, categories: out };
}

function serveursDuManifeste(req: FastifyRequest): Dict {
  utilisateur(req);
  const servers = chargerManifeste()
    .externals()
    .map((e) => ({
      name: e.name,
      description: e.description,
      type: e.type,
      default_on: veritePy(e.default_on_self),
    }));
  return { ok: true, servers };
}

// ── Bibliothèque partagée ────────────────────────────────────────────────────

async function estAdmin(dep: DependancesMcp, uid: number): Promise<boolean> {
  return (await ligneUtilisateur(dep.base, uid))?.is_admin === 1;
}

/** `_shared_payload` : corps validé et normalisé ; stdio refusé dès l'écriture (le core ne lance plus de commande, E22). */
export function champsPartage(data: Dict): ChampsPartage {
  const texte = (cle: string, defaut = ""): string => {
    const v = Object.hasOwn(data, cle) ? data[cle] : null;
    return strPy(veritePy(v) ? v : defaut);
  };
  const name = prefixePy(stripPy(texte("name")), 120);
  const type = lowerPy(stripPy(texte("type", "sse")));
  if (!(SERVER_TYPES as readonly string[]).includes(type))
    throw new HttpError(400, "type doit être 'sse', 'http' ou 'stdio'");
  if (type === "stdio") throw new HttpError(400, STDIO_REFUSE);
  const url = prefixePy(stripPy(texte("url")), 2000);
  const command = prefixePy(stripPy(texte("command")), 2000);
  if ((HTTP_TYPES as readonly string[]).includes(type) && !url)
    throw new HttpError(400, "URL requise pour un serveur SSE/HTTP");
  const mode = lowerPy(stripPy(texte("auth_mode")));
  if (!(AUTH_MODES as readonly string[]).includes(mode))
    throw new HttpError(400, "auth_mode doit être '', 'basic', 'bearer', 'raw' ou 'header'");
  let authUser = prefixePy(stripPy(texte("auth_user")), 200);
  if (mode === "header") {
    authUser = authUser || DEFAULT_HEADER_NAME;
    if (!headerNameOk(authUser)) throw new HttpError(400, `Nom d'en-tête invalide : ${authUser}`);
  }
  let headers: unknown[];
  let env: unknown[];
  try {
    headers = sanitizePairs(getPy(data, "headers"), "headers", true);
    env = sanitizePairs(getPy(data, "env"), "env", true);
  } catch (e) {
    if (e instanceof InvalidPair)
      throw new HttpError(400, `Nom refusé (réservé ou mal formé) : ${e.message}`);
    throw e;
  }
  return {
    name,
    type,
    url,
    command,
    auth_mode: mode,
    auth_user: authUser,
    auth_secret: texte("auth_secret"),
    headers,
    env,
    enabled: veritePy(Object.hasOwn(data, "enabled") ? data["enabled"] : true),
  };
}

function corpsObjet(req: FastifyRequest): Dict {
  const data = corpsJson(req);
  if (!estDict(data)) throw new HttpError(400, "Le payload doit être un objet JSON.");
  return data;
}

async function listerPartages(dep: DependancesMcp, req: FastifyRequest): Promise<Dict> {
  const admin = await estAdmin(dep, utilisateur(req));
  return { ok: true, servers: await listShared(dep.base, { admin }), can_publish: admin };
}

async function publier(dep: DependancesMcp, req: FastifyRequest): Promise<Dict> {
  const p = champsPartage(corpsObjet(req));
  if (!p.name) throw new HttpError(400, "Nom requis");
  let id: number;
  try {
    id = await createShared(dep.base, p);
  } catch (e) {
    if (e instanceof EncryptionUnavailable) throw new HttpError(503, SANS_CHIFFREMENT);
    throw e;
  }
  await invaliderMcp({ type: "partage", avant: null });
  return { ok: true, server: await getShared(dep.base, id, { admin: true }) };
}

function idPartage(req: FastifyRequest): number {
  const { server_id } = entrees(req, { path: { server_id: py.str() } }).path;
  const rid = sharedId(server_id);
  if (rid === null) throw new HttpError(400, "Identifiant invalide");
  return rid;
}

async function modifierPartage(dep: DependancesMcp, req: FastifyRequest): Promise<Dict> {
  const rid = idPartage(req);
  const p = champsPartage(corpsObjet(req));
  if (!p.name) throw new HttpError(400, "Nom requis");
  const avant = await resolveConfig(dep.base, rid);
  let ok: boolean;
  try {
    ok = await updateShared(dep.base, rid, p);
  } catch (e) {
    if (e instanceof EncryptionUnavailable) throw new HttpError(503, SANS_CHIFFREMENT);
    throw e;
  }
  if (!ok) throw new HttpError(404, "Serveur introuvable");
  await invaliderMcp({ type: "partage", avant });
  return { ok: true, server: await getShared(dep.base, rid, { admin: true }) };
}

async function retirerPartage(dep: DependancesMcp, req: FastifyRequest): Promise<Dict> {
  const rid = idPartage(req);
  const avant = await resolveConfig(dep.base, rid);
  if (!(await deleteShared(dep.base, rid))) throw new HttpError(404, "Serveur introuvable");
  await invaliderMcp({ type: "partage", avant });
  return { ok: true };
}

// ── Bouton « Tester » ────────────────────────────────────────────────────────

/** L'enveloppe « MCP HTTP <url> — … » du client masque la cause que `friendly_mcp_error` lisait en Python. */
function causeDeConnexion(e: unknown): unknown {
  return e instanceof Error && e.message.startsWith("MCP HTTP ") && e.cause !== undefined ? e.cause : e;
}

/** `_probe_mcp` : connexion jetable hors pool, liste des outils, 20 s au plus ; jamais d'exception. */
export async function sonderMcp(cfg: ConfigMcp): Promise<Dict> {
  let client: ClientMcp | null;
  try {
    client = resoudreClientMcp(cfg);
  } catch (e) {
    return { ok: false, error: friendlyMcpError(e) };
  }
  if (client === null) return { ok: false, error: "Configuration incomplète (type ou URL/commande)." };
  const borne = signalBorne(undefined, reglagesMcp.delaiEssaiMs);
  const debut = performance.now();
  try {
    await course(client.connecter(borne.signal), borne.signal);
    const outils = await course(client.listerOutils(borne.signal), borne.signal);
    return {
      ok: true,
      tools: outils.map((t) => strPy(getPy(t, "name", "?"))),
      ms: arrondiPy(performance.now() - debut, 0),
    };
  } catch (e) {
    if (borne.signal.reason === borne.delai)
      return { ok: false, error: "Délai dépassé (20 s) : serveur injoignable ?" };
    return { ok: false, error: friendlyMcpError(causeDeConnexion(e)) };
  } finally {
    borne.liberer();
    await client.fermer().catch(() => undefined);
  }
}

/** `headers` / `env` : liste de paires attendue ; un objet, un nombre ou `true` faisait lever le Python (500), le TS répond 400. */
function verifierPaires(data: Dict): void {
  for (const champ of ["headers", "env"]) {
    const v = getPy(data, champ);
    if (veritePy(v) && !Array.isArray(v) && typeof v !== "string")
      throw new HttpError(400, `Le champ « ${champ} » doit être une liste de paires {name, value}.`);
  }
}

/** Mêmes droits qu'à l'enregistrement : partagé = admin ; perso = son propriétaire (stdio réservé à l'admin, refusé à l'usage). */
async function tester(dep: DependancesMcp, req: FastifyRequest): Promise<Dict> {
  const uid = utilisateur(req);
  const data = corpsObjet(req);
  const rid = sharedId(getPy(data, "id"));
  const partage = rid !== null || veritePy(getPy(data, "shared"));
  let ancien: Dict | null;
  let brouillon: Dict;
  let admin: boolean;
  let url: unknown = null;
  if (partage) {
    if (!(await estAdmin(dep, uid))) throw new HttpError(403, "Admin required");
    admin = true;
    verifierPaires(data);
    const p = champsPartage(data);
    url = p.url;
    ancien = rid !== null ? await rawShared(dep.base, rid) : null;
    brouillon = { ...p, id: "t" };
  } else {
    const reglages = await getUserSettings(dep.base, uid);
    const sid = strPy(veritePy(getPy(data, "id")) ? getPy(data, "id") : "");
    const liste = reglages["mcp_servers"];
    ancien = null;
    for (const s of Array.isArray(liste) ? liste : []) {
      if (estDict(s) && strPy(getPy(s, "id")) === sid) {
        ancien = s;
        break;
      }
    }
    brouillon = { ...data, id: "t" };
    admin = await estAdmin(dep, uid);
    const type = lowerPy(stripPy(strPy(veritePy(getPy(brouillon, "type")) ? getPy(brouillon, "type") : "")));
    if (type === "stdio" && !admin)
      throw new HttpError(
        403,
        "Serveur MCP « Local » (commande exécutée sur le serveur) réservé aux administrateurs.",
      );
    verifierPaires(data);
  }
  const anciens = ancien !== null && Object.keys(ancien).length > 0 ? [{ ...ancien, id: "t" }] : [];
  let fusion: Dict[];
  try {
    fusion = await mergePersonalMcp(anciens, [brouillon], { allowStdio: admin });
  } catch (e) {
    if (e instanceof StdioNotAllowed) throw new HttpError(403, e.message);
    if (e instanceof EncryptionUnavailable)
      throw new HttpError(
        503,
        "Clé de chiffrement indisponible : impossible d'éprouver un identifiant. Configurez APP_ENCRYPTION_KEY.",
      );
    throw e;
  }
  const premier = fusion[0];
  if (premier === undefined) throw new HttpError(400, "Configuration vide");
  const resultat = await sonderMcp(await personalToConfig(premier, { allowStdio: admin }));
  if (partage && typeof resultat["error"] === "string")
    resultat["error"] = masquerAdresse(resultat["error"], url);
  return resultat;
}

export function creerFamilleMcp(dep: DependancesMcp): Famille {
  const route = (
    methode: "GET" | "POST" | "PUT" | "DELETE",
    chemin: string,
    acces: "session" | "admin",
    traiter: (req: FastifyRequest) => unknown,
  ) => ({ methode, chemin, processus: ["main"] as const, acces, traiter });
  return {
    nom: "mcp",
    routes: [
      route("GET", "/api/mcp/custom-servers", "session", (req) => listerDossiers(req)),
      route("POST", "/api/mcp/upload", "admin", (req) => deposer(req)),
      route("DELETE", "/api/mcp/custom-servers/:name", "admin", (req) => supprimerDossier(req)),
      route("GET", "/api/mcp/categories", "session", (req) => categories(req)),
      route("GET", "/api/mcp/manifest-servers", "session", (req) => serveursDuManifeste(req)),
      route("GET", "/api/mcp/shared-servers", "session", (req) => listerPartages(dep, req)),
      route("POST", "/api/mcp/shared-servers", "admin", (req) => publier(dep, req)),
      route("PUT", "/api/mcp/shared-servers/:server_id", "admin", (req) => modifierPartage(dep, req)),
      route("DELETE", "/api/mcp/shared-servers/:server_id", "admin", (req) => retirerPartage(dep, req)),
      route("POST", "/api/mcp/test", "session", (req) => tester(dep, req)),
    ],
  };
}
