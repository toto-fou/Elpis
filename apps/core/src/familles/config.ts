// SPDX-License-Identifier: MIT
/** apps/core/src/familles/config.ts — `/api/config` : configuration JSON du compte (sections publiques de config.json seulement), diagnostics de session, 200 Ko au plus (routes/config.py). */
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import type { BigIntStats } from "node:fs";
import { stat } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  CHEMINS_SI_MOT_DE_PASSE_A_CHANGER,
  dependancesSession,
  getUsernameById,
  ligneUtilisateur,
  METHODES_MUTANTES,
  validerSession,
} from "@elpis/auth";
import type { DependancesAuth } from "@elpis/auth";
import {
  clesOrdonnees,
  encoderUtf8Py,
  estDict,
  getPy,
  HttpError,
  intPy,
  longueurPy,
  poserCle,
  pyJsonDumps,
  pyJsonLoads,
  veritePy,
} from "@elpis/commun";
import type { Dict } from "@elpis/commun";
import { config } from "@elpis/config";
import type { FastifyRequest } from "fastify";

import { lireTextePy } from "../memoire/magasin";
import type { Famille } from "../routes";
import { existe } from "../skills/chemins";
import { corpsJsonValeurs, reponseJsonPy } from "@elpis/http";

export const TAILLE_MAX_CONFIG = 200_000;
/** Corps de PUT /api/config : 200 000 caractères au plus une fois réécrit, marge pour l'UTF-8 et les échappements. */
const CORPS_CONFIG_MAX = 2 * 1024 * 1024;

/** Sections de config.json que `/api/public-config` rend déjà sans session : les seules qu'un compte reçoit ou garde dans son fichier. */
const SECTIONS_COMPTE: readonly string[] = ["welcome", "app_info", "login_page"];

/** Copie réduite à `SECTIONS_COMPTE` : toute autre section, présente ou future, reste côté instance. */
function sectionsCompte(cfg: Dict): Dict {
  const out: Dict = {};
  for (const cle of clesOrdonnees(cfg)) if (SECTIONS_COMPTE.includes(cle)) poserCle(out, cle, cfg[cle]);
  return out;
}

/** Première clé `user_id`, `uid`, `user` non nulle convertie par `int()` ; `undefined` si aucune, `null` si la conversion échoue. */
export function uidDeSession(lire: (cle: string) => unknown): number | null | undefined {
  for (const cle of ["user_id", "uid", "user"]) {
    const v = lire(cle);
    if (v === null || v === undefined) continue;
    try {
      return intPy(v);
    } catch {
      return null;
    }
  }
  return undefined;
}

/** `_session_uid_any` : session valide (portes de deps.py) et, sur une écriture, mot de passe à jour (panne de base = passe) ; `null` sinon. */
export async function sessionUidAny(req: FastifyRequest, dep: DependancesAuth): Promise<number | null> {
  const uid = uidDeSession((cle) => req.session.get(cle));
  if (uid === null || uid === undefined) return null;
  if (!(await validerSession(req.session, uid, dependancesSession(dep))).valide) return null;
  if (!METHODES_MUTANTES.has(req.method)) return uid;
  const ligne = await ligneUtilisateur(dep.base, uid).catch(() => undefined);
  const chemin = req.url.split("?")[0] ?? "";
  if (ligne && veritePy(ligne.must_change_pwd) && !CHEMINS_SI_MOT_DE_PASSE_A_CHANGER.has(chemin)) return null;
  return uid;
}

/** `read_config_json()` en valeurs Python : objet de config.json, `{}` s'il manque, est illisible ou n'est pas un objet. */
export async function lireConfigInstance(chemin: string = config.CONFIG_JSON_PATH): Promise<Dict> {
  if (!(await existe(chemin))) return {};
  try {
    const v = pyJsonLoads(await lireTextePy(chemin));
    return estDict(v) ? v : {};
  } catch {
    return {};
  }
}

const PEREMPTION_MS = 1000;
let cacheInstance: { cle: string; valeur: Dict; a: number } | null = null;

/** `config_view()` en valeurs Python : relu si la clé `stat` change ou après une seconde ; vue partagée, jamais modifiée. */
export async function vueConfigInstance(chemin: string = config.CONFIG_JSON_PATH): Promise<Dict> {
  let st: BigIntStats;
  try {
    st = await stat(chemin, { bigint: true });
  } catch {
    cacheInstance = null;
    return {};
  }
  const cle = `${chemin}\u0000${st.mtimeNs}:${st.size}:${st.ino}`;
  const maintenant = performance.now();
  if (cacheInstance !== null && cacheInstance.cle === cle && maintenant - cacheInstance.a < PEREMPTION_MS)
    return cacheInstance.valeur;
  const valeur = await lireConfigInstance(chemin);
  cacheInstance = { cle, valeur, a: maintenant };
  return valeur;
}

/** `_read_json_file` des routes : toute valeur JSON, `{}` si le fichier manque ou se lit mal. */
export async function lireJsonFichier(chemin: string): Promise<unknown> {
  if (!(await existe(chemin))) return {};
  try {
    return pyJsonLoads(await lireTextePy(chemin));
  } catch {
    return {};
  }
}

/** `_write_json_atomic` : `json.dumps(indent=2, ensure_ascii=False)` dans `<fichier>.tmp` puis renommage. */
export function ecrireJsonAtomique(chemin: string, valeur: unknown): void {
  const octets = encoderUtf8Py(pyJsonDumps(valeur, { ensureAscii: false, indent: 2 }));
  mkdirSync(dirname(chemin), { recursive: true });
  const tmp = `${chemin}.tmp`;
  writeFileSync(tmp, octets);
  renameSync(tmp, chemin);
}

export interface DependancesConfig {
  readonly auth: DependancesAuth;
  /** Racine du projet (`PROJECT_ROOT`) : fichiers des comptes sous `user_db/configs/<uid>.json`. */
  readonly racine: string;
  /** Lecture de l'uid de session (défaut : `_session_uid_any`). */
  readonly uidSession?: (req: FastifyRequest) => Promise<number | null>;
}

export function cheminConfigCompte(racine: string, uid: number): string {
  return join(racine, "user_db", "configs", `${uid}.json`);
}

export function creerFamilleConfig(dep: DependancesConfig): Famille {
  const uidSession = dep.uidSession ?? ((req: FastifyRequest) => sessionUidAny(req, dep.auth));
  const nomDe = async (uid: number | null): Promise<string | null> =>
    uid === null ? null : getUsernameById(dep.auth.base, uid);
  const connectes = new WeakMap<FastifyRequest, number>();
  /** Compte de la session (401 sinon), vérifié avant la lecture du corps comme le Python, une fois par requête. */
  const compteConnecte = async (req: FastifyRequest): Promise<number> => {
    const connu = connectes.get(req);
    if (connu !== undefined) return connu;
    const uid = await uidSession(req);
    if (uid === null || !veritePy(await nomDe(uid))) throw new HttpError(401, "not logged in");
    connectes.set(req, uid);
    return uid;
  };
  return {
    nom: "config",
    routes: [
      {
        methode: "GET",
        chemin: "/api/config",
        processus: ["main"],
        acces: "public",
        traiter: async (req, rep) => {
          const uid = await uidSession(req);
          const defaut = sectionsCompte(await vueConfigInstance());
          const username = await nomDe(uid);
          if (uid === null || !veritePy(username)) throw new HttpError(401, "not logged in");
          const chemin = cheminConfigCompte(dep.racine, uid);
          if (!(await existe(chemin))) ecrireJsonAtomique(chemin, defaut);
          const fichier = await lireJsonFichier(chemin);
          let cfgCompte: Dict = estDict(fichier) ? sectionsCompte(fichier) : {};
          if (!veritePy(cfgCompte)) cfgCompte = defaut;
          return reponseJsonPy(
            rep,
            {
              mode: "user",
              editable: true,
              logged_in: true,
              session_user_id: uid,
              db_user_found: true,
              username,
              session_keys: [...clesOrdonnees(req.session.contenu())],
              config: cfgCompte,
            },
            { "cache-control": "no-cache" },
          );
        },
      },
      {
        methode: "PUT",
        chemin: "/api/config",
        processus: ["main"],
        acces: "public",
        corps: {
          limite: CORPS_CONFIG_MAX,
          message: "config too large",
          avant: async (req) => void (await compteConnecte(req)),
        },
        traiter: async (req) => {
          const uid = await compteConnecte(req);
          const cfg = getPy(corpsJsonValeurs(req), "config");
          if (!estDict(cfg)) throw new HttpError(400, "config must be an object");
          if (longueurPy(pyJsonDumps(cfg, { ensureAscii: false })) > TAILLE_MAX_CONFIG)
            throw new HttpError(413, "config too large");
          const chemin = cheminConfigCompte(dep.racine, uid);
          ecrireJsonAtomique(chemin, sectionsCompte(cfg));
          return { ok: true, path: chemin };
        },
      },
    ],
  };
}
