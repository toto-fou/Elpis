// SPDX-License-Identifier: MIT
/** apps/core/src/ops/restauration.ts — restauration d'une sauvegarde de la console (routes/admin/lifecycle.py : _restore_from_zip) : base par l'API de sauvegarde de SQLite, chemins prouvés sous leur dossier, sandboxes sans suivre de lien, mémoire au dossier de l'instance. */
import { lstatSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import type { Stats } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  ecrireSecret,
  ErreurPython,
  floatPy,
  groupeDonnees,
  modePartage,
  pyJsonDumps,
  pyJsonLoads,
  versFlottantPy,
} from "@elpis/commun";
import { config, pyJoin, realpathPy, writeTextAtomic } from "@elpis/config";
import { initialiserBase, prendreVerrouSchema } from "@elpis/db";
import type { Base } from "@elpis/db";
import Database from "better-sqlite3";

import { MIGRATIONS_DU_CORE } from "../base";
import type { Journal } from "../journal";
import { LEGACY_MEMORY_SUBDIR, MEMORY_SUBDIR } from "../memoire/portee";
import { portsMigrationsDuCore } from "../secrets/reprise";
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
import { avecVerrou, cheminVerrou } from "@elpis/verrous";
import { LecteurZip } from "./zip-disque";

export interface DossiersRestauration {
  readonly dbPath: string;
  readonly userDbDir: string;
  readonly sandboxDir: string;
  readonly memoryDir: string;
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
    memoryDir: config.MEMORY_DIR,
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

/** Schéma et migrations réappliqués sous le verrou de schéma sur la base restaurée (sauvegarde d'une version antérieure), avant toute requête ; un échec est rendu en texte. */
async function remettreAJour(base: Base, journal?: Journal): Promise<string | null> {
  const verrou = await prendreVerrouSchema();
  try {
    const rapport = await initialiserBase(base, {
      migrations: MIGRATIONS_DU_CORE,
      ports: portsMigrationsDuCore(),
    });
    return rapport.echec ? `${rapport.echec.name}: ${rapport.echec.message}` : null;
  } catch (e) {
    const texte = e instanceof Error ? e.message : String(e);
    journal?.error(`restauration : mise à jour du schéma impossible (${texte})`);
    return texte;
  } finally {
    await verrou?.rendre();
  }
}

/** Dossier de la mémoire par défaut, sous `user_db/` dans l'archive. */
const MEMOIRE_USER_DB = "memoire/";
/** Instantanés des bacs, sous `sandboxes/` dans l'archive. */
const INSTANTANES = "_snapshots";

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

/** Fichier privé restauré en 0600 par un nouveau fichier renommé ; un dossier ou le fichier d'un autre compte sont refusés comme une écriture en place (EISDIR, EACCES), jamais écrits. */
function ecrirePrive(dest: string, donnees: Buffer): void {
  let st: Stats | undefined;
  try {
    st = lstatSync(dest);
  } catch (e) {
    if ((e as { code?: unknown }).code !== "ENOENT") throw e;
  }
  if (st !== undefined && (st.isDirectory() || st.uid !== process.geteuid?.())) {
    const [code, errno] = st.isDirectory() ? ["EISDIR", -21] : ["EACCES", -13];
    throw Object.assign(new Error(`${code}: open '${dest}'`), { code, errno, syscall: "open", path: dest });
  }
  ecrireSecret(dest, donnees, 0o600);
}

function estRefusEcriture(e: unknown): boolean {
  return (
    estErreurOs(e) || e instanceof ErreurCheminBac || (e instanceof ErreurPython && e.type === "ValueError")
  );
}

const objet = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

/** Toute session ouverte avant `ts` (secondes) est refusée (`security.session.global_min_ts` de config.json `chemin`, sous son verrou, jamais abaissé) ; JSON illisible : erreur. */
export async function fermerToutesSessions(chemin: string, ts: number = Date.now() / 1000): Promise<void> {
  await avecVerrou(cheminVerrou(chemin), {}, async () => {
    let texte = "";
    try {
      texte = await readFile(chemin, "utf-8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    const cfg = objet(pyJsonLoads(texte.trim() || "{}"));
    const securite = objet(cfg["security"]);
    const session = objet(securite["session"]);
    let actuel = 0;
    try {
      const v = floatPy(session["global_min_ts"] ?? 0);
      if (Number.isFinite(v)) actuel = v;
    } catch {
      actuel = 0;
    }
    session["global_min_ts"] = versFlottantPy(Math.max(actuel, ts));
    securite["session"] = session;
    cfg["security"] = securite;
    writeTextAtomic(chemin, pyJsonDumps(cfg, { ensureAscii: false, indent: 2 }));
  });
}

/** `_restore_from_zip` : `(restaurés, erreurs, base_remplacée)` ; base remplacée : toutes les sessions coupées aussitôt, avant le reste (coupure globale de config.json) ; mémoire des comptes au dossier de l'instance, qu'elle vienne de `user_db/memoire` ou de `sandboxes/<compte>/memory` ; un compte par service : du dossier des bacs, seuls /work (par l'hôte d'outils) et la mémoire, instantanés signalés ; une archive illisible lève `ErreurZip`. */
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
    options: { prive?: boolean; dessous?: boolean; modeDefaut?: number } = {},
  ): void => {
    try {
      if (options.dessous) {
        mkdirParentsPy(racine);
        ecrireSous(
          racine,
          rel,
          donnees,
          options.modeDefaut === undefined ? {} : { modeDefaut: options.modeDefaut },
        );
      } else {
        const dest = destSous(racine, rel);
        mkdirParentsPy(path.dirname(dest));
        if (options.prive) ecrirePrive(dest, donnees);
        else writeFileSync(dest, donnees);
      }
      restored.push(entree);
    } catch (e) {
      if (!estRefusEcriture(e)) throw e;
      errors.push(`${entree}: ${texteErreurPy(e)}`);
    }
  };

  const memoire = { dessous: true, modeDefaut: modePartage(0o600) };
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
            await fermerToutesSessions(config.CONFIG_JSON_PATH);
            const echec = await remettreAJour(base, journal);
            if (echec) errors.push(`${entree}: mise à jour du schéma impossible (${echec})`);
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
        if (rel.startsWith(MEMOIRE_USER_DB))
          ecrire(entree, d.memoryDir, rel.slice(MEMOIRE_USER_DB.length), await zf.lireNom(entree), memoire);
        else ecrire(entree, d.userDbDir, rel, await zf.lireNom(entree), { prive: true });
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
      const separe = groupeDonnees() !== null;
      let instantanes = 0;
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
        } else if (
          parts.length > 2 &&
          (second === MEMORY_SUBDIR || second === LEGACY_MEMORY_SUBDIR) &&
          !/^[._]/u.test(compte)
        ) {
          ecrire(entree, d.memoryDir, parts.join("/"), await zf.lireNom(entree), memoire);
        } else if (separe) {
          if (compte === INSTANTANES) instantanes += 1;
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
      if (instantanes) {
        const motif = `sandboxes/${INSTANTANES}/: ${instantanes} fichier(s) d'instantanés non restaurés (un compte par service)`;
        journal?.warn(`restauration : ${motif}`);
        errors.push(motif);
      }
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
