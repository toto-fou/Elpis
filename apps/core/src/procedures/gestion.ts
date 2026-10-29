// SPDX-License-Identifier: MIT
/** apps/core/src/procedures/gestion.ts — écran Procédures du compte : liste des versions, résumé lisible, approbation d'une version par l'utilisateur, suppression. */
import type { ChoixParametre, Noeud, ProcedureListee } from "@elpis/contracts";
import { validerProcedure } from "@elpis/contracts";
import type { Base } from "@elpis/db";

const maintenant = (): number => Date.now() / 1000;

type Ligne = Record<string, unknown>;

/** Procédures du compte (nom du compte = propriétaire), versions de la plus récente à la plus ancienne. */
export async function listerProcedures(base: Base, owner: string): Promise<ProcedureListee[]> {
  const l = await base.all<Ligne>(
    "SELECT id, origin, description, version, created_at, parent_version, repaired_path, approved_at FROM ax_procedures WHERE owner=? ORDER BY id, version DESC",
    [owner],
  );
  const out = new Map<string, ProcedureListee>();
  for (const r of l) {
    const id = String(r["id"]);
    const p = out.get(id) ?? {
      id,
      origin: String(r["origin"]),
      description: String(r["description"]),
      versions: [],
    };
    p.versions.push({
      version: Number(r["version"]),
      created_at: Number(r["created_at"]),
      parent_version: r["parent_version"] === null ? null : Number(r["parent_version"]),
      repaired_path: r["repaired_path"] === null ? null : String(r["repaired_path"]),
      approved_at:
        r["approved_at"] === null || r["approved_at"] === undefined ? null : Number(r["approved_at"]),
    });
    out.set(id, p);
  }
  return [...out.values()];
}

/** Caractères invisibles (bidi, largeur nulle…) rendus visibles : le résumé montre ce qui sera joué. */
export const visible = (t: string): string =>
  t.replace(/\p{Cf}/gu, (c) => `⟦U+${(c.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0")}⟧`);

const cible = (t: readonly string[] | undefined): string =>
  (t ?? []).map((x) => `« ${visible(x)} »`).join(" ou ");

function lignes(n: Noeud, profondeur: number, sortie: string[]): void {
  const ligne = (texte: string): void => void sortie.push(`${"  ".repeat(profondeur)}${texte}`);
  if ("seq" in n) {
    ligne("Dans l'ordre :");
    for (const e of n.seq) lignes(e, profondeur + 1, sortie);
  } else if ("sel" in n) {
    ligne("Le premier qui réussit :");
    for (const e of n.sel) lignes(e, profondeur + 1, sortie);
  } else if ("if" in n) {
    ligne(`Si ${visible(JSON.stringify(n.if))} :`);
    if (n.then) lignes(n.then, profondeur + 1, sortie);
    if (n.else) {
      ligne("Sinon :");
      lignes(n.else, profondeur + 1, sortie);
    }
  } else if ("act" in n) {
    const accord =
      n.confirm === true
        ? " [accord à chaque fois]"
        : n.confirm === "once"
          ? " [accord à la première exécution]"
          : "";
    const quoi = n.act === "goto" ? visible(n.url ?? "") : cible(n.t);
    const attendu = n.expect === undefined ? "" : ` puis vérifie ${visible(JSON.stringify(n.expect))}`;
    ligne(`${n.act} ${quoi}${n.v !== undefined ? ` ← « ${visible(n.v)} »` : ""}${attendu}${accord}`.trim());
  } else if ("login" in n) {
    const l = n.login;
    ligne(`Connexion (identifiant ${visible(l.creds)})`);
    const champs: [string, string | undefined][] = [
      ["identifiant", l.username_target],
      ["mot de passe", l.password_target],
      ["validation", l.submit_target],
      ["attend", l.wait_for],
    ];
    for (const [nom, t] of champs) if (t !== undefined) ligne(`  ${nom} : ${cible([t])}`);
  } else if ("retry" in n) {
    ligne(`Recommencer jusqu'à ${n.max} fois :`);
    lignes(n.retry, profondeur + 1, sortie);
  } else {
    ligne(`Attendre ${n.wait_ms} ms`);
  }
}

/** Résumé d'une version : arbre lisible, paramètres déclarés et choix de l'approbation ; `null` si elle n'existe pas. */
export async function resumerVersion(base: Base, owner: string, id: string, version: number) {
  const l = await base.get<Ligne>(
    "SELECT tree_json, approved_at, approved_params FROM ax_procedures WHERE owner=? AND id=? AND version=?",
    [owner, id, version],
  );
  if (l === undefined) return null;
  let brut: unknown;
  try {
    brut = JSON.parse(String(l["tree_json"]));
  } catch {
    brut = null;
  }
  const v = validerProcedure(brut);
  const approved = l["approved_at"] !== null && l["approved_at"] !== undefined;
  if (!v.ok) return { lines: ["Arbre illisible."], readable: false, approved, params: [] };
  const choix = lireChoix(l["approved_params"]);
  const sortie: string[] = [];
  lignes(v.procedure.root, 0, sortie);
  return {
    lines: sortie.slice(0, 200),
    readable: true,
    approved,
    params: Object.entries(v.procedure.params).map(([name, type]) => ({
      name,
      type,
      choice: approved && choix !== null && Object.hasOwn(choix, name) ? (choix[name] ?? null) : null,
    })),
  };
}

function lireChoix(brut: unknown): Record<string, ChoixParametre> | null {
  try {
    const o = JSON.parse(typeof brut === "string" ? brut : "null") as unknown;
    return o !== null && typeof o === "object" && !Array.isArray(o)
      ? (o as Record<string, ChoixParametre>)
      : null;
  } catch {
    return null;
  }
}

/** Approuve une version avec UN choix par paramètre déclaré (hors `creds`) : `null` si elle n'existe pas, sinon l'heure ou la liste des erreurs de choix. */
export async function approuverVersion(
  base: Base,
  owner: string,
  id: string,
  version: number,
  choix: Record<string, ChoixParametre>,
): Promise<{ ok: true; at: number } | { ok: false; erreurs: string[] } | null> {
  const l = await base.get<Ligne>(
    "SELECT tree_json FROM ax_procedures WHERE owner=? AND id=? AND version=?",
    [owner, id, version],
  );
  if (l === undefined) return null;
  let brut: unknown;
  try {
    brut = JSON.parse(String(l["tree_json"]));
  } catch {
    brut = null;
  }
  const v = validerProcedure(brut);
  if (!v.ok) return { ok: false, erreurs: ["arbre illisible : approbation impossible"] };
  const erreurs: string[] = [];
  const retenus: Record<string, ChoixParametre> = {};
  for (const [nom, type] of Object.entries(v.procedure.params)) {
    if (type === "creds") continue;
    const c = Object.hasOwn(choix, nom) ? choix[nom] : undefined;
    if (c === undefined) erreurs.push(`paramètre ${nom} : choix requis (valeur figée ou libre)`);
    else if (c.mode === "fixed") {
      const valeur = type === "number" ? Number(c.value) : String(c.value);
      if (
        typeof valeur === "number"
          ? !Number.isFinite(valeur)
          : valeur.length > 500 || !valeur.isWellFormed() || /[\p{Cc}\p{Cf}]/u.test(valeur)
      )
        erreurs.push(`paramètre ${nom} : valeur figée invalide`);
      else retenus[nom] = { mode: "fixed", value: valeur };
    } else retenus[nom] = { mode: "free" };
  }
  for (const nom of Object.keys(choix))
    if (!Object.hasOwn(v.procedure.params, nom) || v.procedure.params[nom] === "creds")
      erreurs.push(`paramètre ${nom} : inconnu ou non concerné`);
  if (erreurs.length > 0) return { ok: false, erreurs };
  const t = maintenant();
  const r = await base.run(
    "UPDATE ax_procedures SET approved_at=?, approved_params=? WHERE owner=? AND id=? AND version=?",
    [t, JSON.stringify(retenus), owner, id, version],
  );
  return r.changes === 1 ? { ok: true, at: t } : null;
}

/** Retire l'approbation d'une version ; faux si elle n'existe pas. */
export async function retirerApprobation(
  base: Base,
  owner: string,
  id: string,
  version: number,
): Promise<boolean> {
  const r = await base.run(
    "UPDATE ax_procedures SET approved_at=NULL, approved_params=NULL WHERE owner=? AND id=? AND version=?",
    [owner, id, version],
  );
  return r.changes === 1;
}

/** Supprime une version, ou toutes (`version` 0) avec exécutions, approbations de gestes et demandes ; nombre de versions retirées. */
export async function supprimerProcedure(
  base: Base,
  owner: string,
  id: string,
  version: number,
): Promise<number> {
  return base.ecriture(async (x) => {
    const r =
      version > 0
        ? await x.run("DELETE FROM ax_procedures WHERE owner=? AND id=? AND version=?", [owner, id, version])
        : await x.run("DELETE FROM ax_procedures WHERE owner=? AND id=?", [owner, id]);
    if (version === 0 && r.changes > 0) {
      await x.run("DELETE FROM ax_procedure_runs WHERE owner=? AND procedure_id=?", [owner, id]);
      await x.run("DELETE FROM ax_procedure_approvals WHERE owner=? AND procedure_id=?", [owner, id]);
      await x.run("DELETE FROM ax_procedure_demandes WHERE owner=? AND procedure_id=?", [owner, id]);
    }
    return r.changes;
  });
}
