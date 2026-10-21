// SPDX-License-Identifier: MIT
/** apps/core/src/familles/comptes.ts — connexion, session, mot de passe, liste des comptes, réglages, avatars et aide (accounts/routes_auth.py, routes_settings.py). */
import {
  open as ouvrirFichier,
  mkdir,
  readFile,
  readlink,
  realpath,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import {
  createUser,
  dependancesSession,
  estLocalDirect,
  exigerUtilisateur,
  getAllUsers,
  getUser,
  getUserGroups,
  getUsersLite,
  ipClient,
  leverMinSession,
  ligneUtilisateur,
  rehacherSiAncien,
  resetUserPassword,
  revoquerSid,
  revoquerTousAcces,
  updateUserAvatar,
  validerSession,
  verifyUser,
} from "@elpis/auth";
import type { DependancesAuth, DependancesJetons, Reseau } from "@elpis/auth";
import { decoderUtf8Py, HttpError, intPy, messageErreurOs, stripPy, strPy, veritePy } from "@elpis/commun";
import { config } from "@elpis/config";
import { auditLogin, compareDigest, tokenUrlsafe } from "@elpis/securite";
import type { FastifyReply, FastifyRequest } from "fastify";

import {
  enteteSuppressionCookie,
  extensionImage,
  getPy,
  netlocServeur,
  rejeterInterSite,
  textePy,
  validerMotDePasse,
} from "../comptes/aides";
import { ecrireReglages, lireReglages } from "../comptes/reglages";
import { typeStatique } from "../interface/statiques";
import type { Journal } from "../journal";
import type { ModeApp } from "../mode";
import { reglagesAgents } from "../outils/integres/reglages-taches";
import { agentTemplates } from "../outils/integres/taches-agents";
import type { Famille } from "../routes";
import {
  corpsJson,
  corpsJsonValeurs,
  enregistrerBorne,
  entete,
  lireFormulaire,
  reponseFichier,
  reponseJsonPy,
  valeursFormulaire,
} from "@elpis/http";
import type { FichierRecu } from "@elpis/http";

export interface DependancesComptes {
  readonly auth: DependancesAuth & DependancesJetons;
  readonly racine: string;
  readonly mandataires: readonly Reseau[];
  readonly journal: Journal;
  readonly logMetric?: (nom: string, valeur: number, etiquettes: Record<string, unknown>) => void;
  readonly demarrerHistoriqueFichiers?: (uid: number) => Promise<void>;
  readonly libellesCategories?: () => Readonly<Record<string, string>>;
  /** Process servi (`APP_MODE`) : la console n'écrit que l'apparence. */
  readonly mode: ModeApp;
}

const SANS_CACHE = { "cache-control": "no-cache" };
const ROLES: Readonly<Record<number, string>> = { 0: "user", 1: "admin", 2: "moderator" };
/** Corps de `login-lite` : identifiant et mot de passe, lus avant toute session (Python sans limite). */
const CORPS_CONNEXION_MAX = 64 * 1024;
const REFUS_AVATAR_ASSISTANT =
  "L'avatar de l'assistant est le logo de l'application, réglé par l'administrateur dans la console.";

function maintenant(dep: DependancesComptes): number {
  return dep.auth.maintenant ? dep.auth.maintenant() : Date.now() / 1000;
}

/** Adresse du client comme `request.client.host` sous uvicorn (IPv4 transposée en IPv6 par une écoute sur `::` ramenée à IPv4). */
function adresseClient(requete: FastifyRequest, dep: DependancesComptes): string {
  const pair =
    requete.ip.startsWith("::ffff:") && requete.ip.includes(".") ? requete.ip.slice(7) : requete.ip;
  return ipClient(pair, requete.headers, dep.mandataires);
}

export function utilisateur(requete: FastifyRequest): number {
  const u = requete.utilisateur;
  if (!u) throw new HttpError(401, "not logged in");
  return u.id;
}

let fileAmorcage: Promise<unknown> = Promise.resolve();

/** `_bootstrap_admin_lock` : les créations du premier compte passent une à une. */
function sousVerrouAmorcage<T>(fn: () => Promise<T>): Promise<T> {
  const r = fileAmorcage.then(fn);
  fileAmorcage = r.catch(() => undefined);
  return r;
}

/** `_bootstrap_secret` : mot de passe initial lu, ou créé une seule fois (0600, exclusif) et signalé dans le journal. */
async function secretAmorcage(fichier: string, journal: Journal): Promise<string> {
  const lu = await readFile(fichier, "utf8").catch(() => null);
  if (lu !== null) return stripPy(lu);
  const jeton = tokenUrlsafe(18);
  try {
    await mkdir(dirname(fichier), { recursive: true });
    await writeFile(fichier, `${jeton}\n`, { flag: "wx", mode: 0o600 });
    journal.warn(
      `[bootstrap] Instance sans compte : premier login « admin » avec le mot de passe initial de ${fichier} (ou n'importe quel mot de passe depuis la machine elle-même).`,
    );
  } catch (e) {
    if ((e as { code?: unknown }).code === "EEXIST") return stripPy(await readFile(fichier, "utf8"));
    return "";
  }
  return jeton;
}

/** `_bootstrap_mode` : « local » depuis la machine elle-même, « file » avec le mot de passe initial, sinon refus. */
async function modeAmorcage(
  requete: FastifyRequest,
  motDePasse: unknown,
  dep: DependancesComptes,
): Promise<"local" | "file" | null> {
  if (estLocalDirect(requete.socket.remoteAddress, requete.headers)) return "local";
  const attendu = await secretAmorcage(join(dep.racine, "user_db", ".bootstrap_admin"), dep.journal);
  return attendu && compareDigest(Buffer.from(textePy(motDePasse), "utf8"), Buffer.from(attendu, "utf8"))
    ? "file"
    : null;
}

function dossierAvatars(dep: DependancesComptes): string {
  return join(dep.racine, "user_db", "avatars");
}

/** `Path.resolve()` : liens suivis même pendants, partie inexistante du chemin gardée telle quelle. */
async function reel(chemin: string, sauts = 0): Promise<string> {
  const resolu = await realpath(chemin).catch(() => null);
  if (resolu !== null) return resolu;
  const cible = sauts < 40 ? await readlink(chemin).catch(() => null) : null;
  if (cible !== null) return reel(resolve(dirname(chemin), cible), sauts + 1);
  const parent = dirname(chemin);
  return parent === chemin ? chemin : join(await reel(parent, sauts), basename(chemin));
}

function dedans(base: string, cible: string): boolean {
  const rel = relative(base, cible);
  return !(rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel));
}

/** `_safe_unlink_in_avatar_dir` : supprime un fichier du dossier des avatars, jamais au-dehors ; un échec est ignoré. */
async function supprimerAvatar(dep: DependancesComptes, nom: unknown): Promise<void> {
  if (!nom || typeof nom !== "string") return;
  const cible = await reel(resolve(dossierAvatars(dep), nom));
  if (!dedans(await reel(dossierAvatars(dep)), cible)) return;
  await stat(cible)
    .then((st) => (st.isFile() ? unlink(cible) : undefined))
    .catch(() => undefined);
}

async function sansEchec(action: () => Promise<unknown> | undefined): Promise<void> {
  try {
    await action();
  } catch {
    return;
  }
}

/** `_read_and_validate_image` : extension tirée des 64 premiers octets ; l'en-tête Content-Type doit être image/*. */
async function imageValide(f: FichierRecu): Promise<string> {
  if (!f.contentType || !f.contentType.startsWith("image/"))
    throw new HttpError(400, "Le fichier doit être une image");
  const tete = Buffer.alloc(64);
  const fd = await ouvrirFichier(f.chemin, "r");
  let lus: number;
  try {
    ({ bytesRead: lus } = await fd.read(tete, 0, 64, 0));
  } finally {
    await fd.close();
  }
  const ext = extensionImage(tete.subarray(0, lus));
  if (!ext) throw new HttpError(400, "Fichier image invalide (signature non reconnue).");
  return ext;
}

async function enregistrerAvatar(
  requete: FastifyRequest,
  dep: DependancesComptes,
  prefixe: string,
): Promise<string> {
  const { file } = valeursFormulaire(await lireFormulaire(requete), {
    file: { type: "fichier", requis: true },
  });
  const ext = await imageValide(file);
  const nom = `${prefixe}${Math.floor(maintenant(dep))}${ext}`;
  await mkdir(dossierAvatars(dep), { recursive: true });
  await enregistrerBorne(file, join(dossierAvatars(dep), nom), config.MAX_AVATAR_BYTES);
  return nom;
}

export function creerFamilleComptes(dep: DependancesComptes): Famille {
  const base = dep.auth.base;
  return {
    nom: "comptes",
    routes: [
      {
        methode: "GET",
        chemin: "/api/me-lite",
        processus: ["main", "admin"],
        acces: "public",
        traiter: async (req, rep) => {
          void rep.headers(SANS_CACHE);
          const brut = req.session.get("user_id");
          if (!veritePy(brut)) return { logged_in: false };
          let uid: number;
          try {
            uid = intPy(brut);
            if (!(await validerSession(req.session, uid, dependancesSession(dep.auth))).valide)
              return { logged_in: false };
          } catch {
            return { logged_in: false };
          }
          const ligne = await ligneUtilisateur(base, uid);
          if (!ligne) return { logged_in: false };
          if (veritePy(ligne.must_change_pwd))
            return { logged_in: false, must_change_password: true, id: ligne.id, username: ligne.username };
          return {
            logged_in: true,
            id: ligne.id,
            username: ligne.username,
            is_admin: [1, 2].includes(Number(ligne.is_admin)),
            role: ROLES[Number(ligne.is_admin)] ?? "user",
            avatar: ligne.avatar ?? null,
          };
        },
      },
      {
        methode: "GET",
        chemin: "/api/auth/check",
        processus: ["main"],
        acces: "public",
        traiter: async (req, rep) => {
          try {
            await exigerUtilisateur(req, dep.auth);
          } catch (e) {
            if (e instanceof HttpError && (e.statusCode === 401 || e.statusCode === 403))
              throw new HttpError(401, "not authenticated");
            throw e;
          }
          return rep.code(204).send();
        },
      },
      {
        methode: "POST",
        chemin: "/api/login-lite",
        processus: ["main", "admin"],
        acces: "public",
        corps: { limite: CORPS_CONNEXION_MAX },
        traiter: async (req) => {
          const data = corpsJson(req);
          if (data === null || typeof data !== "object" || Array.isArray(data))
            throw new HttpError(400, "Corps JSON invalide : objet attendu");
          const username = stripPy(textePy(getPy(data, "username", null)));
          const brut = getPy(data, "password", null);
          const motDePasse: unknown = veritePy(brut) ? brut : "";
          if (!username || !veritePy(motDePasse)) throw new HttpError(400, "username/password required");
          const ip = adresseClient(req, dep);
          const ua = entete(req, "user-agent") ?? null;
          let uid = (await getUser(base, username))
            ? await verifyUser(base, username, textePy(motDePasse))
            : null;
          if (uid !== null) {
            const verifie = uid;
            await sansEchec(() => rehacherSiAncien(base, verifie, textePy(motDePasse)));
          }
          if (uid === null) {
            uid = await sousVerrouAmorcage(async () => {
              const comptes = await getAllUsers(base);
              const amorcage = comptes.length === 0 && username.toLowerCase() === "admin";
              const mode = amorcage ? await modeAmorcage(req, motDePasse, dep) : null;
              if (amorcage && mode) {
                const cree = await createUser(base, username, textePy(motDePasse), {
                  isAdmin: 1,
                  mustChangePwd: mode === "file" ? 1 : 0,
                });
                await rm(join(dep.racine, "user_db", ".bootstrap_admin"), { force: true });
                return cree;
              }
              const raison = amorcage
                ? "bootstrap_locked"
                : comptes.length === 0 && username.toLowerCase() !== "admin"
                  ? "bootstrap_denied"
                  : "bad_password";
              auditLogin({ userId: null, username, ip, userAgent: ua, success: false, reason: raison });
              throw new HttpError(401, "invalid credentials");
            });
          }
          const ligne = await ligneUtilisateur(base, uid);
          const t = maintenant(dep);
          req.session.vider();
          req.session.set("uid", uid);
          req.session.set("user", uid);
          req.session.set("user_id", uid);
          req.session.set("_login_ts", t);
          req.session.set("_sid", tokenUrlsafe(18));
          const id = uid;
          await sansEchec(() => dep.demarrerHistoriqueFichiers?.(id));
          dep.logMetric?.("user_login", 1, { user: username });
          auditLogin({ userId: uid, username, ip, userAgent: ua, success: true });
          return {
            ok: true,
            is_admin: ligne ? [1, 2].includes(Number(ligne.is_admin)) : false,
            must_change_password: veritePy(ligne?.must_change_pwd),
          };
        },
      },
      {
        methode: "POST",
        chemin: "/api/logout-lite",
        processus: ["main", "admin"],
        acces: "public",
        corps: { limite: 0, avant: () => false },
        traiter: async (req, rep) => {
          let uid: number | null;
          try {
            const brut = req.session.get("user_id");
            uid = brut === null || brut === undefined ? null : intPy(brut);
          } catch {
            uid = null;
          }
          const ip = adresseClient(req, dep);
          const ua = entete(req, "user-agent") ?? null;
          try {
            const sid = req.session.get("_sid");
            if (veritePy(sid)) await revoquerSid(base, strPy(sid), uid, maintenant(dep));
          } catch (e) {
            dep.journal.warn({ err: e }, "[auth] révocation de session au logout échouée");
          }
          req.session.vider();
          auditLogin({ userId: uid, username: null, ip, userAgent: ua, success: true, reason: "logout" });
          void rep.header("set-cookie", enteteSuppressionCookie(dep.auth.attributsCookie(), maintenant(dep)));
          return { ok: true };
        },
      },
      {
        methode: "POST",
        chemin: "/api/users/change-password",
        processus: ["main", "admin"],
        acces: "session",
        traiter: async (req) => {
          const uid = utilisateur(req);
          rejeterInterSite((nom) => entete(req, nom), netlocServeur(req));
          const data = corpsJson(req);
          const nouveau = getPy(data, "new_password", null);
          const ancien = getPy(data, "old_password", null);
          if (!veritePy(nouveau)) throw new HttpError(400, "Mot de passe requis");
          const moi = await ligneUtilisateur(base, uid);
          if (!moi) throw new HttpError(404, "Utilisateur non trouvé");
          if (!veritePy(ancien)) {
            if (!veritePy(moi.must_change_pwd)) throw new HttpError(400, "Ancien mot de passe requis");
          } else if ((await verifyUser(base, String(moi.username), textePy(ancien))) === null) {
            throw new HttpError(400, "Ancien mot de passe incorrect");
          }
          const motDePasse = textePy(nouveau);
          validerMotDePasse(motDePasse, dep.auth.config());
          await resetUserPassword(base, uid, motDePasse);
          const t = maintenant(dep);
          await leverMinSession(base, uid, t);
          req.session.set("_login_ts", t);
          await revoquerTousAcces(dep.auth, uid);
          await base.run("UPDATE users SET must_change_pwd=0 WHERE id=?", [uid]);
          return { ok: true };
        },
      },
      {
        methode: "GET",
        chemin: "/api/users/lite",
        processus: ["main", "admin"],
        acces: "session",
        traiter: async (req) => {
          const uid = utilisateur(req);
          const moi = await ligneUtilisateur(base, uid);
          const admin = Number(moi?.is_admin) === 1;
          return { users: await getUsersLite(base, uid, !admin), my_groups: await getUserGroups(base, uid) };
        },
      },
      {
        methode: "POST",
        chemin: "/api/settings/avatar",
        processus: ["main", "admin"],
        acces: "session",
        traiter: async (req) => {
          const uid = utilisateur(req);
          const nom = await enregistrerAvatar(req, dep, `${uid}_`);
          try {
            const precedent = (await ligneUtilisateur(base, uid))?.avatar;
            if (precedent && precedent !== nom) await supprimerAvatar(dep, precedent);
          } catch (e) {
            dep.journal.warn(
              { err: e },
              `[avatar] suppression de l'ancien avatar échouée (uid=${uid}) — fichier orphelin dans AVATAR_DIR`,
            );
          }
          await updateUserAvatar(base, uid, nom);
          return { ok: true, avatar: nom };
        },
      },
      {
        methode: "DELETE",
        chemin: "/api/settings/avatar",
        processus: ["main", "admin"],
        acces: "session",
        traiter: async (req) => {
          const uid = utilisateur(req);
          try {
            const actuel = (await ligneUtilisateur(base, uid))?.avatar;
            if (actuel) await supprimerAvatar(dep, actuel);
          } catch (e) {
            dep.journal.warn(
              { err: e },
              `[avatar] suppression du fichier avatar échouée (uid=${uid}) — fichier orphelin dans AVATAR_DIR`,
            );
          }
          await updateUserAvatar(base, uid, null);
          return { ok: true };
        },
      },
      {
        methode: "POST",
        chemin: "/api/settings/assistant-avatar",
        processus: ["main"],
        acces: "session",
        // Écart voulu au Python : route gardée (inventaire, contrats) mais refusée pour tous ; fichiers déjà déposés conservés.
        traiter: () => {
          throw new HttpError(403, REFUS_AVATAR_ASSISTANT);
        },
      },
      {
        methode: "GET",
        chemin: "/api/settings/agent-templates",
        processus: ["main"],
        acces: "session",
        traiter: async (req) => {
          utilisateur(req);
          const r = reglagesAgents();
          return { templates: await agentTemplates(r), read_only_policy: r.read_only };
        },
      },
      {
        methode: "GET",
        chemin: "/api/settings",
        processus: ["main", "admin"],
        acces: "session",
        traiter: async (req, rep) =>
          reponseJsonPy(rep, await lireReglages(base, utilisateur(req), dep.journal), SANS_CACHE),
      },
      {
        methode: "PUT",
        chemin: "/api/settings",
        processus: ["main", "admin"],
        acces: "session",
        traiter: async (req) => {
          await ecrireReglages(base, utilisateur(req), corpsJsonValeurs(req), dep.mode, dep.journal);
          return { ok: true };
        },
      },
      {
        methode: "GET",
        chemin: "/avatars/:filename",
        processus: ["main", "admin"],
        acces: "public",
        traiter: async (req, rep: FastifyReply) => {
          const nom = (req.params as { filename: string }).filename;
          if (!nom || nom.includes("/")) throw new HttpError(404, "Not Found");
          if (["..", "\\", "\x00"].some((c) => nom.includes(c))) throw new HttpError(400, "Invalid filename");
          const dossier = dossierAvatars(dep);
          const cible = await reel(resolve(dossier, nom));
          if (!dedans(await reel(dossier), cible)) throw new HttpError(400, "Invalid filename");
          const infos = await stat(cible).catch((e: { code?: string }) => {
            if (["ENOENT", "ENOTDIR", "ELOOP", "EBADF"].includes(e.code ?? "")) return null;
            throw new HttpError(400, "Invalid filename");
          });
          if (!infos?.isFile()) throw new HttpError(404, "Avatar not found");
          return reponseFichier(req, rep, cible, { mediaType: typeStatique(cible) });
        },
      },
      {
        methode: "GET",
        chemin: "/api/help/readme",
        processus: ["main"],
        acces: "session",
        traiter: async (req) => {
          const brut = (req.query as Record<string, unknown>)["doc"];
          const doc = Array.isArray(brut) ? brut[brut.length - 1] : (brut ?? "user");
          const dev = ["dev", "developer", "developpeur", "devs"].includes(
            stripPy(strPy(doc || "")).toLowerCase(),
          );
          const etiquette = dev ? "docs/architecture.md" : "docs/guide-utilisateur.md";
          const resolu = dev ? "dev" : "user";
          const chemin = join(dep.racine, etiquette);
          if ((await stat(chemin).catch(() => null)) === null)
            return {
              content: `# Fichier ${etiquette} introuvable\n\nAucune documentation n'a été trouvée.`,
              doc: resolu,
            };
          try {
            return { content: decoderUtf8Py(await readFile(chemin)), doc: resolu };
          } catch (e) {
            const message = (e as { code?: unknown }).code
              ? messageErreurOs(e, chemin)
              : (e as Error).message;
            return {
              content: `# Erreur de lecture\n\nImpossible de lire le fichier: ${message}`,
              doc: resolu,
            };
          }
        },
      },
    ],
  };
}
