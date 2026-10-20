// SPDX-License-Identifier: MIT
/** apps/core/src/familles/config.ts — `/api/config` : configuration JSON du compte (copie blanchie de config.json au premier accès), diagnostics de session, 200 Ko au plus (routes/config.py). */
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
  copieDict,
  encoderUtf8Py,
  estDict,
  FlottantPy,
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

/** `_DEFAULT_CONFIG` : rendu quand config.json est absent, vide ou n'est pas un objet. */
export function configParDefaut(): Dict {
  return {
    llama: {
      ip: "127.0.0.1",
      port: "8080",
      url: "",
      model: "local-model",
      timeout_sec: 600,
      retries: 1,
      retry_backoff_sec: 0.6,
    },
    mcp: { server_cmd: "server/local_mcp_server.py", tools_cache_ttl_sec: new FlottantPy(360) },
    app: {
      db_path: "user_db/app.db",
      session_secret: "",
      max_recent_chats: 100,
      sandbox_dir: "user_sandboxes",
    },
    security: {
      password_policy: {
        min_length: 0,
        require_uppercase: false,
        require_lowercase: false,
        require_numbers: false,
        require_special: false,
      },
    },
  };
}

/** `_SECRET_PATHS` : secrets d'instance jamais rendus ni recopiés dans la configuration d'un compte. */
export const SECRET_PATHS: readonly string[] = [
  "llama.api_key",
  "app.session_secret",
  "app.encryption_key",
  "rag.qdrant_api_key",
  "rag.service_token",
  "metrics.scrape_token",
  "agent_memory.qdrant_api_key",
  "agent_memory.embed_api_key",
  "voice.stt.token",
  "voice.tts.token",
  "image.api_key_enc",
  "mcp.local_token",
  "mcp.local_client_tokens",
];

/** `_redact_secrets` : copie où chaque secret présent est vidé en gardant son type ; seules les branches traversées sont recopiées. */
export function redactSecrets(cfg: unknown): unknown {
  if (!estDict(cfg)) return cfg;
  const out = copieDict(cfg);
  for (const chemin of SECRET_PATHS) {
    const parties = chemin.split(".");
    const cle = parties.pop() ?? "";
    let noeud: Dict | null = out;
    for (const parent of parties) {
      const enfant: unknown = Object.hasOwn(noeud, parent) ? noeud[parent] : undefined;
      if (!estDict(enfant)) {
        noeud = null;
        break;
      }
      const copie = copieDict(enfant);
      poserCle(noeud, parent, copie);
      noeud = copie;
    }
    if (noeud !== null && Object.hasOwn(noeud, cle)) {
      const v = noeud[cle];
      poserCle(noeud, cle, estDict(v) ? {} : Array.isArray(v) ? [] : "");
    }
  }
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
          let defaut = await vueConfigInstance();
          if (!veritePy(defaut)) defaut = configParDefaut();
          const username = await nomDe(uid);
          if (uid === null || !veritePy(username)) throw new HttpError(401, "not logged in");
          const chemin = cheminConfigCompte(dep.racine, uid);
          if (!(await existe(chemin))) ecrireJsonAtomique(chemin, redactSecrets(defaut));
          let cfgCompte = await lireJsonFichier(chemin);
          if (!estDict(cfgCompte) || !veritePy(cfgCompte)) cfgCompte = defaut;
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
              config: redactSecrets(cfgCompte),
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
          ecrireJsonAtomique(chemin, cfg);
          return { ok: true, path: chemin };
        },
      },
    ],
  };
}
