// SPDX-License-Identifier: MIT
/** apps/core/src/ops/restauration.ts — restauration d'une sauvegarde de la console (routes/admin/lifecycle.py : _restore_from_zip) : base par l'API de sauvegarde de SQLite, chemins prouvés sous leur dossier, sandboxes sans suivre de lien. */
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { ErreurPython } from "@elpis/commun";
import { config, pyJoin, realpathPy } from "@elpis/config";
import type { Base } from "@elpis/db";
import Database from "better-sqlite3";

import type { Journal } from "../journal";
import { estErreurOs, texteErreurPy } from "./erreurs-os";
import {
  AGENT_RUN_DIR,
  comptesDesSandboxes,
  DB_ANNEXES,
  DL_SPOOL,
  HOST_ONLY,
  portTravail,
  RELAY_DIR,
  RUNTIME_DIRS,
  WORK_SUBDIR,
} from "./sauvegarde";
import type { Portee } from "./sauvegarde";
import { ecrireSous, ErreurCheminBac } from "@elpis/securite";
import { LecteurZip } from "./zip-disque";

export interface DossiersRestauration {
  readonly dbPath: string;
  readonly userDbDir: string;
  readonly sandboxDir: string;
  readonly mcpDir: string;
  readonly skinsDir: string;
  readonly skillsDir: string;
}

/** Dossiers de l'instance, relus à l'appel. */
export function dossiersInstance(): DossiersRestauration {
  return {
    dbPath: config.DB_PATH,
    userDbDir: pyJoin(config.PROJECT_ROOT, "user_db"),
    sandboxDir: config.SANDBOX_DIR,
    mcpDir: config.MCP_SERVERS_DIR,
    skinsDir: config.SKINS_DIR,
    skillsDir: config.USER_SKILLS_DIR,
  };
}

/** `_dest_under` : destination d'une entrée prouvée sous `base`, liens résolus (zip-slip refusé). */
export function destSous(base: string, rel: string): string {
  const racine = realpathPy(base);
  const dest = realpathPy(pyJoin(racine, rel));
  const dessous = racine === "/" ? dest !== "/" : dest.startsWith(`${racine}/`);
  if (dest === racine || !dessous) throw new ErreurPython("ValueError", "chemin hors du dossier cible");
  return dest;
}

function estDossier(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** `Path.mkdir(parents=True, exist_ok=True)`. */
export function mkdirParentsPy(p: string): void {
  try {
    mkdirSync(p, 0o777);
  } catch (e) {
    if ((e as { code?: unknown }).code === "ENOENT") {
      const parent = path.dirname(p);
      if (parent === p) throw e;
      mkdirParentsPy(parent);
      try {
        mkdirSync(p, 0o777);
      } catch (x) {
        if (!estDossier(p)) throw x;
      }
      return;
    }
    if (!estDossier(p)) throw e;
  }
}

/** `_restore_db_from` : `integrity_check` de la copie puis API de sauvegarde de SQLite vers la base vivante (verrous de SQLite respectés, WAL gardé). */
export async function restaurerBase(source: string, dbPath: string): Promise<void> {
  const src = new Database(source);
  try {
    const verdict = src.prepare("PRAGMA integrity_check").raw().get() as unknown[] | undefined;
    if (!verdict || verdict[0] !== "ok")
      throw new ErreurPython(
        "ValueError",
        `base de la sauvegarde corrompue : ${verdict ? String(verdict[0]) : "?"}`,
      );
    try {
      await src.backup(dbPath, { progress: () => 0x7fffffff });
    } catch (e) {
      if (estErreurOs(e)) throw new Database.SqliteError("unable to open database file", "SQLITE_CANTOPEN");
      throw e;
    }
  } finally {
    src.close();
  }
}

/** Membres du périmètre relus (CRC) avant toute écriture : une archive abîmée est refusée entière, base vivante comprise. */
const PREFIXES: Readonly<Record<Portee, readonly string[]>> = {
  full: [
    "db/",
    "user_db/",
    "generated_images/",
    "sandboxes/",
    "mcp_custom_servers/",
    "user_skins/",
    "user_skills/",
  ],
  db: ["db/", "user_db/", "generated_images/"],
  sandboxes: ["sandboxes/"],
  mcp: ["mcp_custom_servers/"],
};

export interface ResultatRestauration {
  restored: string[];
  errors: string[];
  dbReplaced: boolean;
}

function estRefusEcriture(e: unknown): boolean {
  return (
    estErreurOs(e) || e instanceof ErreurCheminBac || (e instanceof ErreurPython && e.type === "ValueError")
  );
}

/** `_restore_from_zip` : `(restaurés, erreurs, base_remplacée)` ; une archive illisible lève `ErreurZip`. */
export async function restoreFromZip(
  zipPath: string,
  scope: Portee,
  d: DossiersRestauration,
  base: Base,
  journal?: Journal,
): Promise<ResultatRestauration> {
  const restored: string[] = [];
  const errors: string[] = [];
  let dbReplaced = false;
  const nomBase = path.basename(d.dbPath);
  const fichiersBase = new Set(["", ...DB_ANNEXES].map((s) => nomBase + s));

  const ecrire = (
    entree: string,
    racine: string,
    rel: string,
    donnees: Buffer,
    options: { prive?: boolean; dessous?: boolean } = {},
  ): void => {
    try {
      if (options.dessous) {
        mkdirParentsPy(racine);
        ecrireSous(racine, rel, donnees);
      } else {
        const dest = destSous(racine, rel);
        mkdirParentsPy(path.dirname(dest));
        writeFileSync(dest, donnees);
        if (options.prive) chmodSync(dest, 0o600);
      }
      restored.push(entree);
    } catch (e) {
      if (!estRefusEcriture(e)) throw e;
      errors.push(`${entree}: ${texteErreurPy(e)}`);
    }
  };

  const zf = await LecteurZip.ouvrir(zipPath);
  try {
    const noms = zf.noms().filter((n) => !n.endsWith("/"));
    const prefixes = PREFIXES[scope];
    for (const n of new Set(noms)) if (prefixes.some((p) => n.startsWith(p))) await zf.lireNom(n);

    if (scope === "full" || scope === "db") {
      const sources = noms.filter(
        (n) => n.startsWith("db/") && !n.slice(3).includes("/") && !DB_ANNEXES.some((s) => n.endsWith(s)),
      );
      if (sources.length && config.DB_BACKEND !== "sqlite") {
        errors.push(
          `${sources[0]}: base active sur ${config.DB_BACKEND} — restauration de la ` +
            "base refusée (revenir à SQLite, restaurer, puis migrer)",
        );
      } else if (sources.length) {
        const entree = sources.includes(`db/${nomBase}`) ? `db/${nomBase}` : (sources[0] as string);
        const dossier = mkdtempSync(path.join(tmpdir(), "tmp"));
        try {
          const extrait = path.join(dossier, "restore.db");
          writeFileSync(extrait, await zf.lireNom(entree));
          try {
            await restaurerBase(extrait, d.dbPath);
            restored.push(entree);
            dbReplaced = true;
          } catch (e) {
            if (
              !(e instanceof Database.SqliteError) &&
              !(e instanceof ErreurPython && e.type === "ValueError")
            )
              throw e;
            errors.push(`${entree}: ${e.message}`);
          }
        } finally {
          rmSync(dossier, { recursive: true, force: true });
        }
      }
      for (const entree of noms) {
        if (!entree.startsWith("user_db/")) continue;
        const rel = entree.slice("user_db/".length);
        if (
          fichiersBase.has(rel) ||
          (HOST_ONLY as readonly string[]).includes(rel) ||
          (RUNTIME_DIRS as readonly string[]).includes(rel.split("/")[0] as string)
        )
          continue;
        ecrire(entree, d.userDbDir, rel, await zf.lireNom(entree), { prive: true });
      }
      const images = pyJoin(path.dirname(d.dbPath), "generated_images");
      for (const entree of noms)
        if (entree.startsWith("generated_images/"))
          ecrire(entree, images, entree.slice("generated_images/".length), await zf.lireNom(entree), {
            prive: true,
          });
    }

    if (scope === "full" || scope === "sandboxes") {
      const comptes = await comptesDesSandboxes(base, journal);
      const travaux = new Map<number, [string, string][]>();
      for (const entree of noms) {
        if (!entree.startsWith("sandboxes/")) continue;
        const parts = entree
          .slice("sandboxes/".length)
          .split("/")
          .filter((c) => c !== "" && c !== ".");
        if (parts.includes("..") || !parts.length) {
          errors.push(`${entree}: nom non canonique, ignoré`);
          continue;
        }
        const [compte, second] = [parts[0] as string, parts[1]];
        if (parts.length > 2 && second === WORK_SUBDIR) {
          const uid = comptes.get(compte);
          if (uid === undefined) errors.push(`${entree}: compte inconnu, /work non restauré`);
          else {
            const lot = travaux.get(uid) ?? [];
            lot.push([entree, parts.slice(2).join("/")]);
            travaux.set(uid, lot);
          }
        } else if (!(
          (parts.length > 1 && second === AGENT_RUN_DIR) ||
          compte === RELAY_DIR ||
          compte === DL_SPOOL
        )) {
          ecrire(entree, d.sandboxDir, parts.join("/"), await zf.lireNom(entree), { dessous: true });
        }
      }
      for (const [uid, lot] of travaux)
        await portTravail().restaurer(uid, lot, (e) => zf.lireNom(e), restored, errors);
    }

    if (scope === "full" || scope === "mcp") {
      for (const entree of noms)
        if (entree.startsWith("mcp_custom_servers/"))
          ecrire(entree, d.mcpDir, entree.slice("mcp_custom_servers/".length), await zf.lireNom(entree));
    }

    if (scope === "full") {
      for (const [prefixe, racine] of [
        ["user_skins/", d.skinsDir],
        ["user_skills/", d.skillsDir],
      ] as const) {
        for (const entree of noms)
          if (entree.startsWith(prefixe))
            ecrire(entree, racine, entree.slice(prefixe.length), await zf.lireNom(entree));
      }
    }
  } finally {
    await zf.fermer();
  }
  return { restored, errors, dbReplaced };
}
