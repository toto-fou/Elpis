// SPDX-License-Identifier: MIT
/** apps/toolhost/src/mcp/browser/procedures/stockage.ts — procédures du compte (`ax_procedures`, versions gardées) et journal des exécutions (`ax_procedure_runs`) dans la base de l'hôte. */
import { createHash } from "node:crypto";

import type { Act, Procedure } from "@elpis/contracts";
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
  /** Version dont celle-ci est la réparation, `null` si enregistrée à la main. */
  readonly parent_version: number | null;
  readonly repaired_path: string | null;
  /** Nombre de versions gardées issues d'une réparation. */
  readonly repairs: number;
}

export type ResultatSauvegarde =
  | { readonly ok: true; readonly id: string; readonly version: number; readonly texte: string }
  | { readonly ok: false; readonly code: string; readonly message: string };

const maintenant = (): number => Date.now() / 1000;

/** Nouvelle version de la procédure du compte (compteur jamais décroissant, versions gardées) ; arbre écrit en JSON stable (l'ordre des clés est celui du schéma). */
export async function sauvegarder(
  base: Base,
  owner: string,
  p: Procedure,
  reparation: { parent: number; chemin: string } | null = null,
): Promise<ResultatSauvegarde> {
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
    const stocke = JSON.stringify({ ...p, version });
    await x.run(
      "INSERT INTO ax_procedures (owner, id, version, origin, description, tree_json, created_at, updated_at, parent_version, repaired_path) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        owner,
        p.id,
        version,
        p.origin,
        p.description,
        stocke,
        t,
        t,
        reparation?.parent ?? null,
        reparation?.chemin ?? null,
      ],
    );
    await x.run("DELETE FROM ax_procedures WHERE owner=? AND id=? AND version<=?", [
      owner,
      p.id,
      version - QUOTAS.versions,
    ]);
    return { ok: true, id: p.id, version, texte: stocke } as const;
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

/** Empreinte d'un geste `confirm: "once"` : chemin, geste, cibles, valeur et URL (tout changement de ces champs le fait redemander). */
export function empreinteGeste(chemin: string, n: Act): string {
  return createHash("sha256")
    .update(JSON.stringify([chemin, n.act, n.t ?? null, n.v ?? null, n.url ?? null]), "utf8")
    .digest("hex");
}

/** Gestes `confirm: "once"` de la procédure déjà approuvés et suivis d'une exécution ok : ils ne demandent plus d'accord. */
export async function approbations(base: Base, owner: string, id: string): Promise<Set<string>> {
  const l = await base.all<{ gesture_fp: string }>(
    "SELECT gesture_fp FROM ax_procedure_approvals WHERE owner=? AND procedure_id=? AND validated_at IS NOT NULL",
    [owner, id],
  );
  return new Set(l.map((x) => x.gesture_fp));
}

/**
 * Gestes `once` exécutés avec accord : enregistrés comme approuvés ; si l'exécution a réussi (`ok`), ils sont validés ainsi que
 * tous ceux que les exécutions précédentes de la même chaîne (confirmation, réparation) avaient fait approuver.
 */
export async function enregistrerApprobations(
  base: Base,
  o: {
    owner: string;
    id: string;
    chain: string;
    gestes: readonly { fp: string; path: string }[];
    ok: boolean;
  },
): Promise<void> {
  const t = maintenant();
  for (const g of o.gestes)
    await base.run(
      "INSERT INTO ax_procedure_approvals (owner, procedure_id, gesture_fp, path, approved_at, validated_at, chain) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (owner, procedure_id, gesture_fp) DO UPDATE SET chain = excluded.chain, validated_at = COALESCE(ax_procedure_approvals.validated_at, excluded.validated_at)",
      [o.owner, o.id, g.fp, g.path, t, o.ok ? t : null, o.chain],
    );
  if (o.ok)
    await base.run(
      "UPDATE ax_procedure_approvals SET validated_at=? WHERE owner=? AND procedure_id=? AND chain=? AND validated_at IS NULL",
      [t, o.owner, o.id, o.chain],
    );
}

/** Oublie les approbations du nœud réparé et de ses descendants : une réparation qui le touche les réinitialise. */
export async function oublierApprobations(
  base: Base,
  owner: string,
  id: string,
  chemin: string,
): Promise<void> {
  await base.run(
    "DELETE FROM ax_procedure_approvals WHERE owner=? AND procedure_id=? AND (path=? OR path LIKE ?)",
    [owner, id, chemin, `${chemin}.%`],
  );
}

/** Vrai si la procédure a déjà une exécution `ok` (toutes versions). */
export async function dejaReussi(base: Base, owner: string, id: string): Promise<boolean> {
  const n = await base.get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM ax_procedure_runs WHERE owner=? AND procedure_id=? AND outcome='ok'",
    [owner, id],
  );
  return Number(n?.n ?? 0) > 0;
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
    r: number;
    parent_version: number | null;
    repaired_path: string | null;
  }>(
    `SELECT p.id, p.origin, p.version, p.description, p.tree_json, p.updated_at, p.parent_version, p.repaired_path,
            (SELECT COUNT(*) FROM ax_procedures q WHERE q.owner=p.owner AND q.id=p.id) AS n,
            (SELECT COUNT(*) FROM ax_procedures q WHERE q.owner=p.owner AND q.id=p.id AND q.parent_version IS NOT NULL) AS r
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
    parent_version: l.parent_version === null ? null : Number(l.parent_version),
    repaired_path: l.repaired_path,
    repairs: Number(l.r),
  }));
}

/** Supprime une version (ou toutes si `version` vaut 0) ; nombre de versions retirées. */
export async function supprimer(base: Base, owner: string, id: string, version = 0): Promise<number> {
  return base.ecriture(async (x) => {
    const r =
      version > 0
        ? await x.run("DELETE FROM ax_procedures WHERE owner=? AND id=? AND version=?", [owner, id, version])
        : await x.run("DELETE FROM ax_procedures WHERE owner=? AND id=?", [owner, id]);
    if (version === 0) {
      await x.run("DELETE FROM ax_procedure_runs WHERE owner=? AND procedure_id=?", [owner, id]);
      await x.run("DELETE FROM ax_procedure_approvals WHERE owner=? AND procedure_id=?", [owner, id]);
    }
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
  /** Exécution logique (suite de reprises après confirmation ou réparation). */
  readonly chain?: string;
  /** Attente de réparation seulement : `repair_id` et page (origine, chemin, requête) où l'exécution s'est arrêtée. */
  readonly token?: string;
  readonly pageKey?: string;
  /** Cibles des gestes déjà joués (réparation) : sert à la garde anti-rejeu. */
  readonly played?: readonly string[];
}

/** Journal d'une exécution (issue, nœud en échec, durée ; jamais de valeur de paramètre) ; les plus anciennes au-delà du quota sont retirées. */
export async function noterExecution(base: Base, e: LigneExecution): Promise<void> {
  await base.transaction(async (x) => {
    await x.run(
      "INSERT INTO ax_procedure_runs (owner, procedure_id, version, session_id, started_at, ended_at, outcome, failed_path, duration_ms, fingerprint, chain, token, page_key, played_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
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
        e.chain ?? null,
        e.token ?? null,
        e.pageKey ?? null,
        e.played === undefined ? null : JSON.stringify(e.played),
      ],
    );
    await x.run(
      `DELETE FROM ax_procedure_runs WHERE owner=? AND procedure_id=? AND id NOT IN
         (SELECT id FROM ax_procedure_runs WHERE owner=? AND procedure_id=? ORDER BY started_at DESC, id DESC LIMIT ${QUOTAS.executions})`,
      [e.owner, e.procedureId, e.owner, e.procedureId],
    );
  });
}

/** Une nouvelle exécution annule (`superseded`) les attentes de confirmation et de réparation de la session et retire les `repair_id` non repris. */
export async function annulerAttentes(base: Base, owner: string, sessionId: string): Promise<void> {
  await base.run(
    "UPDATE ax_procedure_runs SET outcome='superseded' WHERE owner=? AND session_id=? AND outcome IN ('needs_confirmation', 'needs_repair', 'repairing')",
    [owner, sessionId],
  );
  await base.run(
    "UPDATE ax_procedure_runs SET token=NULL WHERE owner=? AND session_id=? AND outcome='repaired' AND token IS NOT NULL",
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
): Promise<{ chain: string | null } | null> {
  return base.ecriture(async (x) => {
    const l = await x.get<{
      id: number;
      failed_path: string | null;
      fingerprint: string | null;
      chain: string | null;
    }>(
      `SELECT id, failed_path, fingerprint, chain FROM ax_procedure_runs
        WHERE owner=? AND procedure_id=? AND version=? AND session_id=? AND outcome='needs_confirmation' AND ended_at>=?
        ORDER BY id DESC LIMIT 1`,
      [o.owner, o.procedureId, o.version, o.sessionId, maintenant() - REPRISE_S],
    );
    const valide =
      l !== undefined &&
      l.failed_path === o.chemin &&
      l.fingerprint === empreinte(o.texte, o.chemin, o.version, o.page);
    if (valide) await x.run("UPDATE ax_procedure_runs SET outcome='confirmed' WHERE id=?", [l.id]);
    return valide ? { chain: l.chain } : null;
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

export interface AttenteReparation {
  readonly id: number;
  readonly version: number;
  readonly chemin: string;
  readonly sessionId: string;
  readonly chain: string | null;
  readonly page: string;
  readonly played: string[];
}

/** Réparations déjà faites dans l'exécution logique : au plus 2 en tout et 1 par nœud. */
export const REPARATIONS_MAX = 2;

/** Vrai si l'exécution logique peut encore offrir une réparation pour ce nœud. */
export async function reparationPermise(
  base: Base,
  o: { owner: string; chain: string; chemin: string },
): Promise<boolean> {
  const n = await base.get<{ n: number; m: number }>(
    "SELECT COUNT(*) AS n, COALESCE(SUM(CASE WHEN failed_path=? THEN 1 ELSE 0 END), 0) AS m FROM ax_procedure_runs WHERE owner=? AND chain=? AND outcome='repaired'",
    [o.chemin, o.owner, o.chain],
  );
  return Number(n?.n ?? 0) < REPARATIONS_MAX && Number(n?.m ?? 0) === 0;
}

/** Attente de réparation du compte pour cette procédure et ce `repair_id`, non expirée ; `undefined` sinon. */
export async function attenteReparation(
  base: Base,
  o: { owner: string; procedureId: string; token: string },
): Promise<AttenteReparation | undefined> {
  if (!o.token) return undefined;
  const l = await base.get<{
    id: number;
    version: number;
    failed_path: string | null;
    session_id: string | null;
    chain: string | null;
    page_key: string | null;
    played_json: string | null;
  }>(
    `SELECT id, version, failed_path, session_id, chain, page_key, played_json FROM ax_procedure_runs
      WHERE owner=? AND procedure_id=? AND token=? AND outcome='needs_repair' AND ended_at>=?`,
    [o.owner, o.procedureId, o.token, maintenant() - REPRISE_S],
  );
  if (l === undefined || l.failed_path === null) return undefined;
  return {
    id: Number(l.id),
    version: Number(l.version),
    chemin: l.failed_path,
    sessionId: l.session_id ?? "",
    chain: l.chain,
    page: l.page_key ?? "",
    played: jouesDe(l.played_json),
  };
}

/** Réserve l'attente (usage unique, même sous concurrence) ; faux si quelqu'un l'a déjà prise. */
export async function reserverReparation(base: Base, id: number): Promise<boolean> {
  return (
    (
      await base.run(
        "UPDATE ax_procedure_runs SET outcome='repairing' WHERE id=? AND outcome='needs_repair'",
        [id],
      )
    ).changes === 1
  );
}

/** Rend l'attente réservée si l'enregistrement de la réparation a échoué. */
export async function rendreReparation(base: Base, id: number): Promise<void> {
  await base.run("UPDATE ax_procedure_runs SET outcome='needs_repair' WHERE id=? AND outcome='repairing'", [
    id,
  ]);
}

/** Réparation enregistrée : issue `repaired`, nouvelle version et empreinte (arbre réparé + chemin + version + page) exigées à la reprise ; faux si l'attente n'est plus réservée (annulée entre-temps : rien n'est ressuscité). */
export async function terminerReparation(
  base: Base,
  id: number,
  o: { nouvelleVersion: number; empreinte: string },
): Promise<boolean> {
  return (
    (
      await base.run(
        "UPDATE ax_procedure_runs SET outcome='repaired', new_version=?, fingerprint=? WHERE id=? AND outcome='repairing'",
        [o.nouvelleVersion, o.empreinte, id],
      )
    ).changes === 1
  );
}

/** Consomme (une fois) la réparation de la session si elle vise cette version, ce chemin, cet arbre exact et cette page ; rend le chemin à reprendre. */
export async function reprendreReparation(
  base: Base,
  o: {
    owner: string;
    procedureId: string;
    version: number;
    sessionId: string;
    token: string;
    texte: string;
    page: string;
  },
): Promise<{ chemin: string; chain: string | null } | null> {
  if (!o.token) return null;
  return base.ecriture(async (x) => {
    const l = await x.get<{
      id: number;
      failed_path: string | null;
      fingerprint: string | null;
      chain: string | null;
    }>(
      `SELECT id, failed_path, fingerprint, chain FROM ax_procedure_runs
        WHERE owner=? AND procedure_id=? AND token=? AND outcome='repaired' AND new_version=? AND session_id=? AND ended_at>=?`,
      [o.owner, o.procedureId, o.token, o.version, o.sessionId, maintenant() - REPRISE_S],
    );
    if (l === undefined || l.failed_path === null) return null;
    if (l.fingerprint !== empreinte(o.texte, l.failed_path, o.version, o.page)) return null;
    await x.run("UPDATE ax_procedure_runs SET token=NULL WHERE id=?", [l.id]);
    return { chemin: l.failed_path, chain: l.chain };
  });
}

/** Origine d'une version (versions parente et chemin réparé), `undefined` si la version n'existe pas. */
export async function filiation(
  base: Base,
  owner: string,
  id: string,
  version: number,
): Promise<{ parent_version: number | null; repaired_path: string | null } | undefined> {
  const l = await base.get<{ parent_version: number | null; repaired_path: string | null }>(
    "SELECT parent_version, repaired_path FROM ax_procedures WHERE owner=? AND id=? AND version=?",
    [owner, id, version],
  );
  return l === undefined
    ? undefined
    : {
        parent_version: l.parent_version === null ? null : Number(l.parent_version),
        repaired_path: l.repaired_path,
      };
}

function jouesDe(texte: string | null): string[] {
  try {
    const l = JSON.parse(texte ?? "[]") as unknown;
    return Array.isArray(l) ? l.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}
