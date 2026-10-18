// SPDX-License-Identifier: MIT
/** apps/core/src/familles/admin-base.ts — page admin « Base de données » : état, test, enregistrement, simulation, bascule et retour à SQLite (routes/admin/database.py). */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

import { ErreurPython, HttpError, intPy, stripPy, strPy, veritePy } from "@elpis/commun";
import { config, DB_BACKENDS_RETIRED, dbPassword, readConfigJson } from "@elpis/config";
import { infoBase } from "@elpis/db";
import type { Base } from "@elpis/db";

import type { Journal } from "../journal";
import { cibleActive, jobStatus, pendingPassword, startJob, writeDatabaseConfig } from "../ops/bascule";
import type { DependancesBascule } from "../ops/bascule";
import type { SourceGenerations } from "../ops/redemarrage";
import { checkTarget, describe, ErreurTransfert, transferer } from "../ops/transfert";
import type { Cible } from "../ops/transfert";
import type { DefinitionRoute, Famille, Traitement } from "../routes";
import { utilisateur } from "./comptes";
import { corpsJsonValeurs } from "@elpis/http";

type Dict = Record<string, unknown>;

export const ENV_KEYS = [
  "APP_DB_BACKEND",
  "APP_DB_HOST",
  "APP_DB_PORT",
  "APP_DB_NAME",
  "APP_DB_USER",
  "APP_DB_PASSWORD",
  "APP_DB_TLS",
];

/** `d.get(cle)` : un objet qui n'est pas un dict (None compris) lève comme l'`AttributeError` du Python. */
function get(d: unknown, cle: string): unknown {
  if (d === null || typeof d !== "object" || Array.isArray(d))
    throw new TypeError(
      `'${d === null ? "NoneType" : Array.isArray(d) ? "list" : typeof d}' object has no attribute 'get'`,
    );
  return Object.hasOwn(d, cle) ? (d as Dict)[cle] : undefined;
}

function ou<T>(v: unknown, defaut: T): unknown {
  return veritePy(v) ? v : defaut;
}

/** `_saved` : cible enregistrée sans bascule (`database.pending`), sinon la base active ; jamais le mot de passe. */
export function saved(env: NodeJS.ProcessEnv = process.env): Dict {
  const active = ou(get(readConfigJson(), "database"), {});
  let pending = ou(get(active, "pending"), {});
  if (DB_BACKENDS_RETIRED.includes(stripPy(strPy(ou(get(pending, "backend"), ""))).toLowerCase()))
    pending = {};
  const enAttente = veritePy(pending);
  const db = enAttente ? pending : active;
  const fichier = enAttente ? ".db_password.pending" : ".db_password";
  return {
    backend: ou(get(db, "backend"), "sqlite"),
    host: ou(get(db, "host"), "127.0.0.1"),
    port: intPy(ou(get(db, "port"), 0)) || null,
    name: ou(get(db, "name"), "elpis"),
    user: ou(get(db, "user"), "elpis"),
    tls: ou(get(db, "tls"), "off"),
    pending: enAttente,
    password_present: Boolean(env["APP_DB_PASSWORD"]) || existsSync(join(dirname(config.DB_PATH), fichier)),
  };
}

/** `_target` : formulaire → cible serveur (postgres seul) ; un corps qui n'est pas un objet lève (500) comme `body.get`. */
export function cibleDuFormulaire(corps: unknown): Cible & Dict {
  const texte = (cle: string, defaut = ""): string => stripPy(strPy(ou(get(corps, cle), defaut)));
  let backend = texte("backend").toLowerCase();
  if (backend === "postgresql") backend = "postgres";
  if (backend !== "postgres") throw new HttpError(400, "Moteur : postgres");
  const host = texte("host");
  const name = texte("name");
  const user = texte("user");
  if (!host || !name || !user) throw new HttpError(400, "Hôte, base et utilisateur requis");
  let port: number;
  try {
    port = intPy(ou(get(corps, "port"), 5432));
  } catch (e) {
    if (e instanceof ErreurPython && e.type === "OverflowError")
      throw new HttpError(400, "Paramètre hors bornes.");
    throw new HttpError(400, "Port invalide");
  }
  const tls = strPy(ou(get(corps, "tls"), "off")).toLowerCase();
  if (!["off", "require", "verify"].includes(tls)) throw new HttpError(400, "TLS : off, require ou verify");
  const out: Dict = { backend, host, port, name, user, tls, timeout: 30, schema: null };
  if (veritePy(get(corps, "password"))) out["password"] = strPy(get(corps, "password"));
  return out as Cible & Dict;
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export interface DependancesAdminBase {
  readonly base: Base;
  readonly journal: Journal;
  /** `_reloader` : rechargement de main puis de ce process. */
  recharger(): unknown;
  readonly env?: NodeJS.ProcessEnv;
  readonly generations?: SourceGenerations;
  readonly pauseGenerationsMs?: number;
}

export function creerFamilleAdminBase(dep: DependancesAdminBase): Famille {
  const env = (): NodeJS.ProcessEnv => dep.env ?? process.env;
  const bascule: DependancesBascule = {
    journal: dep.journal,
    recharger: () => dep.recharger(),
    ...(dep.generations === undefined ? {} : { generations: dep.generations }),
    ...(dep.pauseGenerationsMs === undefined ? {} : { pauseGenerationsMs: dep.pauseGenerationsMs }),
  };
  const route = (methode: "GET" | "POST", chemin: string, traiter: Traitement): DefinitionRoute => ({
    methode,
    chemin,
    processus: ["admin"],
    acces: "admin",
    traiter,
  });
  return {
    nom: "admin-base",
    routes: [
      route("GET", "/api/admin/database", async () => {
        let info: Dict;
        try {
          info = {
            ...(await infoBase(dep.base, {
              location: describe(cibleActive()),
              ...(dep.base.dialecte === "sqlite" ? { cheminSqlite: config.DB_PATH } : {}),
              generation: intPy(config.DB_GENERATION || 0),
            })),
          };
        } catch (e) {
          info = { error: message(e) };
        }
        return {
          active: info,
          saved: saved(env()),
          env: ENV_KEYS.filter((k) => env()[k]),
          job: jobStatus(),
        };
      }),
      route("POST", "/api/admin/database/test", async (req) => {
        const cible = cibleDuFormulaire(corpsJsonValeurs(req));
        try {
          return await checkTarget(cible);
        } catch (e) {
          return { ok: false, error: message(e).slice(0, 500) };
        }
      }),
      route("POST", "/api/admin/database/save", async (req) => {
        const cible = cibleDuFormulaire(corpsJsonValeurs(req));
        await writeDatabaseConfig(cible, false);
        dep.journal.info(`[database] réglages enregistrés par uid=${utilisateur(req)}`);
        return { ok: true, saved: saved(env()) };
      }),
      route("POST", "/api/admin/database/simulate", async (req) => {
        const cible = cibleDuFormulaire(corpsJsonValeurs(req));
        try {
          return await transferer(cibleActive(), cible, { dryRun: true, journal: dep.journal });
        } catch (e) {
          if (e instanceof ErreurTransfert) return { ok: false, error: e.message };
          return { ok: false, error: message(e).slice(0, 500) };
        }
      }),
      route("POST", "/api/admin/database/migrate", async (req) => {
        const cible = cibleDuFormulaire(corpsJsonValeurs(req));
        if (!veritePy(cible["password"])) {
          const pw = pendingPassword() || dbPassword();
          if (pw) cible["password"] = pw;
        }
        if (env()["APP_DB_BACKEND"])
          throw new HttpError(409, "Moteur imposé par APP_DB_BACKEND : retirer la variable d'abord");
        dep.journal.warn(
          `[database] bascule ${config.DB_BACKEND} → ${String(cible["backend"])} demandée par uid=${utilisateur(req)}`,
        );
        return startJob("migrate", cible, bascule);
      }),
      route("POST", "/api/admin/database/sqlite", () => {
        if (config.DB_BACKEND === "sqlite") throw new HttpError(409, "Déjà sur SQLite");
        if (env()["APP_DB_BACKEND"])
          throw new HttpError(409, "Moteur imposé par APP_DB_BACKEND : retirer la variable d'abord");
        return startJob("sqlite", { backend: "sqlite" } as Cible & Dict, bascule);
      }),
      route("GET", "/api/admin/database/job", () => jobStatus()),
    ],
  };
}
