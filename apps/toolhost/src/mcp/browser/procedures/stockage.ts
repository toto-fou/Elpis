// SPDX-License-Identifier: MIT
/** apps/toolhost/src/mcp/browser/procedures/stockage.ts — procédures du compte (`ax_procedures`, versions gardées) et journal des exécutions (`ax_procedure_runs`) dans la base de l'hôte. */
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

/** Nouvelle version (dernière + 1) de la procédure du compte ; arbre écrit en JSON stable (l'ordre des clés est celui du schéma). */
export async function sauvegarder(base: Base, owner: string, p: Procedure): Promise<ResultatSauvegarde> {
  const texte = JSON.stringify(p);
  if (texte.length > QUOTAS.octets)
    return {
      ok: false,
      code: "procedure_too_large",
      message: `arbre de ${texte.length} octets (${QUOTAS.octets} au plus)`,
    };
  return base.ecriture(async (x) => {
    const ligne = await x.get<{ v: number | null }>(
      "SELECT MAX(version) AS v FROM ax_procedures WHERE owner=? AND id=?",
      [owner, p.id],
    );
    const derniere = Number(ligne?.v ?? 0);
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
    const version = derniere + 1;
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

/** Arbre stocké (JSON relu tel quel, à revalider avant exécution) ; version 0 = la dernière. */
export async function lire(base: Base, owner: string, id: string, version = 0): Promise<unknown> {
  const l =
    version > 0
      ? await base.get<{ tree_json: string }>(
          "SELECT tree_json FROM ax_procedures WHERE owner=? AND id=? AND version=?",
          [owner, id, version],
        )
      : await base.get<{ tree_json: string }>(
          "SELECT tree_json FROM ax_procedures WHERE owner=? AND id=? ORDER BY version DESC LIMIT 1",
          [owner, id],
        );
  if (l === undefined) return undefined;
  try {
    return JSON.parse(l.tree_json) as unknown;
  } catch {
    return null;
  }
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
}

/** Journal d'une exécution (issue, nœud en échec, durée ; jamais de valeur de paramètre) ; les plus anciennes au-delà du quota sont retirées. */
export async function noterExecution(base: Base, e: LigneExecution): Promise<void> {
  await base.transaction(async (x) => {
    await x.run(
      "INSERT INTO ax_procedure_runs (owner, procedure_id, version, session_id, started_at, ended_at, outcome, failed_path, duration_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [e.owner, e.procedureId, e.version, e.sessionId, e.debut, e.fin, e.issue, e.noeudEnEchec, e.dureeMs],
    );
    await x.run(
      `DELETE FROM ax_procedure_runs WHERE owner=? AND procedure_id=? AND id NOT IN
         (SELECT id FROM ax_procedure_runs WHERE owner=? AND procedure_id=? ORDER BY started_at DESC, id DESC LIMIT ${QUOTAS.executions})`,
      [e.owner, e.procedureId, e.owner, e.procedureId],
    );
  });
}

/** Chemin du nœud qui attend une confirmation sur cette session, parmi ceux autorisés ; l'attente est consommée (reprise unique). */
export async function reprendre(
  base: Base,
  o: { owner: string; procedureId: string; version: number; sessionId: string; chemins: readonly string[] },
): Promise<string | null> {
  if (o.chemins.length === 0) return null;
  return base.ecriture(async (x) => {
    const l = await x.get<{ id: number; failed_path: string | null }>(
      `SELECT id, failed_path FROM ax_procedure_runs
        WHERE owner=? AND procedure_id=? AND version=? AND session_id=? AND outcome='needs_confirmation' AND ended_at>=?
        ORDER BY id DESC LIMIT 1`,
      [o.owner, o.procedureId, o.version, o.sessionId, maintenant() - REPRISE_S],
    );
    if (l === undefined || l.failed_path === null || !o.chemins.includes(l.failed_path)) return null;
    await x.run("UPDATE ax_procedure_runs SET outcome='confirmed' WHERE id=?", [l.id]);
    return l.failed_path;
  });
}
