// SPDX-License-Identifier: MIT
/** apps/toolhost/src/mcp/browser/procedures/stockage.ts — procédures du compte (`ax_procedures`, versions gardées) et journal des exécutions (`ax_procedure_runs`) dans la base de l'hôte. */
import { createHash } from "node:crypto";

import type { Procedure } from "@elpis/contracts";
import type { Base } from "@elpis/db";

/** Procédures distinctes par compte, versions gardées par procédure, taille d'un arbre, exécutions gardées par procédure. */
export const QUOTAS = { procedures: 200, versions: 50, octets: 65_536, executions: 200 } as const;

/** Délai pendant lequel une exécution en attente de confirmation peut être reprise. */
export const REPRISE_S = 15 * 60;

export interface ResumeProcedure {
  readonly id: string;
  readonly origin: string;
  readonly version: number;
  readonly versions: number;
  readonly description: string;
  readonly params: Procedure["params"];
  readonly updated_at: number;
}

export type ResultatSauvegarde =
  | { readonly ok: true; readonly id: string; readonly version: number }
  | { readonly ok: false; readonly code: string; readonly message: string };

const maintenant = (): number => Date.now() / 1000;

/** Nouvelle version de la procédure du compte (compteur jamais décroissant, versions gardées) ; arbre écrit en JSON stable (l'ordre des clés est celui du schéma). */
export async function sauvegarder(base: Base, owner: string, p: Procedure): Promise<ResultatSauvegarde> {
  const texte = JSON.stringify(p);
  const octets = Buffer.byteLength(texte, "utf8");
  if (octets > QUOTAS.octets)
    return {
      ok: false,
      code: "procedure_too_large",
      message: `arbre de ${octets} octets (${QUOTAS.octets} au plus)`,
    };
  return base.ecriture(async (x) => {
    const ligne = await x.get<{ v: number | null }>(
      "SELECT MAX(version) AS v FROM ax_procedures WHERE owner=? AND id=?",
      [owner, p.id],
    );
    const derniere = Number(ligne?.v ?? 0);
    // Compteur par (compte, procédure) qui ne recule jamais, même après suppression de versions ou de la procédure entière.
    const compteur = await x.get<{ v: number | null }>(
      "SELECT last_version AS v FROM ax_procedure_counters WHERE owner=? AND id=?",
      [owner, p.id],
    );
    const vue = await x.get<{ v: number | null }>(
      "SELECT MAX(version) AS v FROM ax_procedure_runs WHERE owner=? AND procedure_id=?",
      [owner, p.id],
    );
    if (derniere === 0) {
      const n = await x.get<{ n: number }>(
        "SELECT COUNT(DISTINCT id) AS n FROM ax_procedures WHERE owner=?",
        [owner],
      );
      if (Number(n?.n ?? 0) >= QUOTAS.procedures)
        return {
          ok: false,
          code: "procedure_quota",
          message: `${QUOTAS.procedures} procédures au plus par compte`,
        } as const;
    }
    const version = Math.max(derniere, Number(vue?.v ?? 0), Number(compteur?.v ?? 0)) + 1;
    await x.run(
      "INSERT INTO ax_procedure_counters (owner, id, last_version) VALUES (?, ?, ?) ON CONFLICT (owner, id) DO UPDATE SET last_version = excluded.last_version",
      [owner, p.id, version],
    );
    const t = maintenant();
    await x.run(
      "INSERT INTO ax_procedures (owner, id, version, origin, description, tree_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      [owner, p.id, version, p.origin, p.description, JSON.stringify({ ...p, version }), t, t],
    );
    await x.run("DELETE FROM ax_procedures WHERE owner=? AND id=? AND version<=?", [
      owner,
      p.id,
      version - QUOTAS.versions,
    ]);
    return { ok: true, id: p.id, version } as const;
  });
}

/** Texte JSON et numéro de la version demandée (0 = la dernière), `undefined` si elle n'existe pas. */
export async function lireTexte(
  base: Base,
  owner: string,
  id: string,
  version = 0,
): Promise<{ texte: string; version: number } | undefined> {
  const l =
    version > 0
      ? await base.get<{ tree_json: string; version: number }>(
          "SELECT tree_json, version FROM ax_procedures WHERE owner=? AND id=? AND version=?",
          [owner, id, version],
        )
      : await base.get<{ tree_json: string; version: number }>(
          "SELECT tree_json, version FROM ax_procedures WHERE owner=? AND id=? ORDER BY version DESC LIMIT 1",
          [owner, id],
        );
  return l === undefined ? undefined : { texte: l.tree_json, version: Number(l.version) };
}

/** Arbre stocké relu tel quel (à revalider avant exécution) : `undefined` s'il n'existe pas, `null` si le JSON est illisible. */
export async function lire(base: Base, owner: string, id: string, version = 0): Promise<unknown> {
  const l = await lireTexte(base, owner, id, version);
  if (l === undefined) return undefined;
  try {
    return JSON.parse(l.texte) as unknown;
  } catch {
    return null;
  }
}

/** Empreinte d'une attente de confirmation : arbre exact, chemin du nœud, version et page (origine + chemin, purgée) où l'exécution s'est arrêtée. */
export function empreinte(texte: string, chemin: string, version: number, page: string): string {
  return createHash("sha256").update(`${texte}\n${chemin}\n${version}\n${page}`, "utf8").digest("hex");
}

/** Dernière version de chaque procédure du compte, filtrée par origine exacte si donnée. */
export async function lister(base: Base, owner: string, origin = ""): Promise<ResumeProcedure[]> {
  const lignes = await base.all<{
    id: string;
    origin: string;
    version: number;
    description: string;
    tree_json: string;
    updated_at: number;
    n: number;
  }>(
    `SELECT p.id, p.origin, p.version, p.description, p.tree_json, p.updated_at,
            (SELECT COUNT(*) FROM ax_procedures q WHERE q.owner=p.owner AND q.id=p.id) AS n
       FROM ax_procedures p
      WHERE p.owner=? ${origin ? "AND p.origin=?" : ""}
        AND p.version=(SELECT MAX(version) FROM ax_procedures m WHERE m.owner=p.owner AND m.id=p.id)
      ORDER BY p.id`,
    origin ? [owner, origin] : [owner],
  );
  const parametres = (texte: string): Procedure["params"] => {
    try {
      return (JSON.parse(texte) as { params?: Procedure["params"] }).params ?? {};
    } catch {
      return {};
    }
  };
  return lignes.map((l) => ({
    id: l.id,
    origin: l.origin,
    version: Number(l.version),
    versions: Number(l.n),
    description: l.description,
    params: parametres(l.tree_json),
    updated_at: Number(l.updated_at),
  }));
}

/** Supprime une version (ou toutes si `version` vaut 0) ; nombre de versions retirées. */
export async function supprimer(base: Base, owner: string, id: string, version = 0): Promise<number> {
  return base.ecriture(async (x) => {
    const r =
      version > 0
        ? await x.run("DELETE FROM ax_procedures WHERE owner=? AND id=? AND version=?", [owner, id, version])
        : await x.run("DELETE FROM ax_procedures WHERE owner=? AND id=?", [owner, id]);
    if (version === 0)
      await x.run("DELETE FROM ax_procedure_runs WHERE owner=? AND procedure_id=?", [owner, id]);
    return r.changes;
  });
}

export interface LigneExecution {
  readonly owner: string;
  readonly procedureId: string;
  readonly version: number;
  readonly sessionId: string;
  readonly debut: number;
  readonly fin: number;
  readonly issue: string;
  readonly noeudEnEchec: string | null;
  readonly dureeMs: number;
  /** Attente de confirmation seulement : `empreinte(arbre, chemin, version)`. */
  readonly empreinte?: string;
}

/** Journal d'une exécution (issue, nœud en échec, durée ; jamais de valeur de paramètre) ; les plus anciennes au-delà du quota sont retirées. */
export async function noterExecution(base: Base, e: LigneExecution): Promise<void> {
  await base.transaction(async (x) => {
    await x.run(
      "INSERT INTO ax_procedure_runs (owner, procedure_id, version, session_id, started_at, ended_at, outcome, failed_path, duration_ms, fingerprint) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        e.owner,
        e.procedureId,
        e.version,
        e.sessionId,
        e.debut,
        e.fin,
        e.issue,
        e.noeudEnEchec,
        e.dureeMs,
        e.empreinte ?? null,
      ],
    );
    await x.run(
      `DELETE FROM ax_procedure_runs WHERE owner=? AND procedure_id=? AND id NOT IN
         (SELECT id FROM ax_procedure_runs WHERE owner=? AND procedure_id=? ORDER BY started_at DESC, id DESC LIMIT ${QUOTAS.executions})`,
      [e.owner, e.procedureId, e.owner, e.procedureId],
    );
  });
}

/** Remplace par `superseded` toute attente de confirmation en cours sur la session : une nouvelle exécution les annule. */
export async function annulerAttentes(base: Base, owner: string, sessionId: string): Promise<void> {
  await base.run(
    "UPDATE ax_procedure_runs SET outcome='superseded' WHERE owner=? AND session_id=? AND outcome='needs_confirmation'",
    [owner, sessionId],
  );
}

/** Consomme l'attente de confirmation de la session si elle porte sur cette procédure, cette version, ce chemin et cet arbre et cette page (empreinte) et n'a pas expiré. */
export async function reprendre(
  base: Base,
  o: {
    owner: string;
    procedureId: string;
    version: number;
    sessionId: string;
    texte: string;
    chemin: string;
    page: string;
  },
): Promise<boolean> {
  return base.ecriture(async (x) => {
    const l = await x.get<{ id: number; failed_path: string | null; fingerprint: string | null }>(
      `SELECT id, failed_path, fingerprint FROM ax_procedure_runs
        WHERE owner=? AND procedure_id=? AND version=? AND session_id=? AND outcome='needs_confirmation' AND ended_at>=?
        ORDER BY id DESC LIMIT 1`,
      [o.owner, o.procedureId, o.version, o.sessionId, maintenant() - REPRISE_S],
    );
    const valide =
      l !== undefined &&
      l.failed_path === o.chemin &&
      l.fingerprint === empreinte(o.texte, o.chemin, o.version, o.page);
    if (valide) await x.run("UPDATE ax_procedure_runs SET outcome='confirmed' WHERE id=?", [l.id]);
    return valide;
  });
}

/** Chemin de la dernière attente de confirmation valide de la session (même procédure et version), `null` sinon. */
export async function attenteEnCours(
  base: Base,
  o: { owner: string; procedureId: string; version: number; sessionId: string },
): Promise<string | null> {
  const l = await base.get<{ failed_path: string | null }>(
    `SELECT failed_path FROM ax_procedure_runs
      WHERE owner=? AND procedure_id=? AND version=? AND session_id=? AND outcome='needs_confirmation' AND ended_at>=?
      ORDER BY id DESC LIMIT 1`,
    [o.owner, o.procedureId, o.version, o.sessionId, maintenant() - REPRISE_S],
  );
  return l?.failed_path ?? null;
}
