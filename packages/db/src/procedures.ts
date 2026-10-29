// SPDX-License-Identifier: MIT
/** packages/db/src/procedures.ts — purge des procédures du navigateur (`ax_procedures`, `ax_procedure_runs`, `ax_procedure_counters`, `ax_procedure_demandes`) d'un compte supprimé. */
import type { Base, Executeur } from "./base";

/** Retire procédures et exécutions du compte (rangées par nom de compte) ; nombre de procédures retirées. */
export async function retirerProceduresDuCompte(x: Executeur, proprietaire: string): Promise<number> {
  if (!proprietaire) return 0;
  await x.run("DELETE FROM ax_procedure_runs WHERE owner = ?", [proprietaire]);
  await x.run("DELETE FROM ax_procedure_counters WHERE owner = ?", [proprietaire]);
  await x.run("DELETE FROM ax_procedure_approvals WHERE owner = ?", [proprietaire]);
  await x.run("DELETE FROM ax_procedure_demandes WHERE owner = ?", [proprietaire]);
  return (await x.run("DELETE FROM ax_procedures WHERE owner = ?", [proprietaire])).changes;
}

/** Procédures distinctes par compte, versions gardées par procédure, taille d'un arbre, exécutions gardées par procédure. */
export const QUOTAS = { procedures: 200, versions: 50, octets: 65_536, executions: 200 } as const;

/** Procédure telle que le stockage la voit : l'arbre complet validé par `@elpis/contracts`, dont l'identifiant et l'origine. */
export interface ProcedureAEnregistrer {
  readonly id: string;
  readonly origin: string;
  readonly description: string;
}

export type ResultatSauvegarde =
  | { readonly ok: true; readonly id: string; readonly version: number; readonly texte: string }
  | { readonly ok: false; readonly code: string; readonly message: string };

const maintenant = (): number => Date.now() / 1000;

/** Nouvelle version de la procédure du compte (compteur jamais décroissant, versions gardées) ; arbre écrit en JSON stable (l'ordre des clés est celui du schéma). */
export async function sauvegarder(
  base: Base,
  owner: string,
  p: ProcedureAEnregistrer,
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
    // Rotation : les plus anciennes versions NON approuvées partent ; une version approuvée par l'utilisateur n'est jamais purgée.
    const gardees = await x.all<{ version: number; approved_at: number | null }>(
      "SELECT version, approved_at FROM ax_procedures WHERE owner=? AND id=? ORDER BY version",
      [owner, p.id],
    );
    const aRetirer = gardees.length - QUOTAS.versions + 1;
    const purgeables = gardees.filter((g) => g.approved_at === null || g.approved_at === undefined);
    if (aRetirer > purgeables.length)
      return {
        ok: false,
        code: "version_quota",
        message: `${QUOTAS.versions} versions approuvées par l'utilisateur : aucune ne peut être purgée, il doit en supprimer dans Paramètres › Procédures`,
      } as const;
    for (const g of purgeables.slice(0, Math.max(0, aRetirer)))
      await x.run("DELETE FROM ax_procedures WHERE owner=? AND id=? AND version=?", [owner, p.id, g.version]);
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
    return { ok: true, id: p.id, version, texte: stocke } as const;
  });
}
