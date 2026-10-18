// SPDX-License-Identifier: MIT
/** packages/skills/src/resolution.ts — un skill désigné par le modèle (llm_core/tools/skill_tools.py `_resolve_skill_spec`, `_safe_skill_file`) : commun aux outils skill_get, skill_read_file (core) et skill_run_script (hôte d'outils). */
import { ErreurPython, stripPy } from "@elpis/commun";
import { asStr } from "@elpis/outils-mcp";

import { partiesRelatives, pyJoin, resoudre } from "./chemins";
import { discoverSkills, slugifyName } from "./decouverte";
import type { SkillSpec } from "./decouverte";

/** `PATH_MAX` de Linux : au-delà, le noyau refuse le chemin (ENAMETOOLONG). */
export const PATH_MAX = 4096;

/** Skill visible de l'appelant (perso de `dossierPerso` > global ; learned exclu) : id qualifié, puis nom exact, puis slug ; et la liste vue. */
export async function resoudreSkill(
  dossierPerso: string | null,
  nom: unknown,
): Promise<[SkillSpec | null, SkillSpec[]]> {
  const skills = await discoverSkills(dossierPerso, { includeLearned: false });
  const voulu = asStr(nom);
  const slug = slugifyName(voulu);
  const spec =
    skills.find((s) => (s.id || s.name) === voulu) ??
    skills.find((s) => s.name === voulu) ??
    skills.find((s) => slugifyName(s.name) === slug) ??
    null;
  return [spec, skills];
}

/** `_safe_skill_file` : `rel` résolu SOUS le dossier du skill (liens compris) ; `ValueError` en message, chemin au-delà de PATH_MAX signalé sans le résoudre. */
export function fichierSousSkill(
  dossier: string,
  rel: unknown,
): { chemin: string } | { erreur: string } | { tropLong: string } {
  const brut = stripPy(asStr(rel)).replace(/^\/+/u, "");
  if (!brut || brut.includes("\0")) return { erreur: "path required" };
  const base = resoudre(dossier);
  if (Buffer.byteLength(`${base}/${brut}`) > PATH_MAX) return { tropLong: pyJoin(base, brut) };
  try {
    const cible = resoudre(pyJoin(base, brut));
    return partiesRelatives(cible, base) === null
      ? { erreur: "path outside the skill folder" }
      : { chemin: cible };
  } catch (e) {
    if (e instanceof ErreurPython && e.type === "ValueError") return { erreur: e.message };
    throw e;
  }
}
