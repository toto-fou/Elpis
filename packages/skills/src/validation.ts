// SPDX-License-Identifier: MIT
/** packages/skills/src/validation.ts — contraintes du standard Agent Skills sur le frontmatter d'un skill (permissif en découverte, strict à l'écriture). */
import { longueurPy, lowerPy, stripPy } from "@elpis/commun";

import { strFrontmatter, veriteFrontmatter } from "./frontmatter";

export const NAME_MAX = 64;
export const DESC_MAX = 1024;
export const COMPAT_MAX = 500;

const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const RESERVED = ["anthropic", "claude"] as const;

export function validateName(
  name: string | null | undefined,
  options: { dirName?: string | null } = {},
): string[] {
  const errs: string[] = [];
  const n = stripPy(name || "");
  if (!n) return ["name : requis"];
  const longueur = longueurPy(n);
  if (longueur > NAME_MAX) errs.push(`name : ${longueur} > ${NAME_MAX} caractères`);
  if (n.includes("<") || n.includes(">")) errs.push("name : pas de chevrons/tags XML");
  if (!NAME_RE.test(n))
    errs.push("name : minuscules a-z, chiffres et '-' uniquement, sans '-' en tête/fin ni '--' consécutifs");
  const bas = lowerPy(n);
  if (RESERVED.some((r) => bas.includes(r))) errs.push("name : mot réservé interdit (anthropic / claude)");
  const dossier = options.dirName;
  if (dossier !== null && dossier !== undefined && n !== dossier)
    errs.push(`name doit être identique au nom du dossier (« ${dossier} »)`);
  return errs;
}

export function validateDescription(description: string | null | undefined): string[] {
  const errs: string[] = [];
  const brut = description || "";
  const d = stripPy(brut);
  if (!d) errs.push("description : requise (non vide)");
  else if (longueurPy(d) > DESC_MAX) errs.push(`description : ${longueurPy(d)} > ${DESC_MAX} caractères`);
  if (brut.includes("<") || brut.includes(">")) errs.push("description : pas de chevrons/tags XML");
  return errs;
}

/** Erreurs de conformité du frontmatter (vide = conforme) ; le nom manquant retombe sur celui du dossier. */
export function validateFrontmatter(
  fm: ReadonlyMap<string, unknown>,
  options: { dirName?: string | null } = {},
): string[] {
  const valeurNom = fm.get("name");
  const name = stripPy(strFrontmatter(veriteFrontmatter(valeurNom) ? valeurNom : options.dirName || ""));
  const errs = validateName(name, options);
  const description = fm.get("description");
  errs.push(...validateDescription(strFrontmatter(veriteFrontmatter(description) ? description : "")));
  const compat = fm.get("compatibility");
  if (compat !== null && compat !== undefined && longueurPy(strFrontmatter(compat)) > COMPAT_MAX)
    errs.push(`compatibility : > ${COMPAT_MAX} caractères`);
  return errs;
}
