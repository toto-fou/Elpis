// SPDX-License-Identifier: MIT
/** apps/core/src/outils/integres/task/statut.ts — statut, verdict et travail restant déclarés en tête du rapport d'un sous-agent (lecture tolérante, jamais `done` par défaut). */
import { longueurPy, prefixePy, stripPy } from "@elpis/commun";

/** Titre `## nom` (un suffixe qui ne commence pas par un mot, `(…)` ou `— 1 item`, peut suivre le nom ; il n'est pas lu) ou ligne de champ `nom:`, tolérants à la casse, au gras, aux puces et aux `#` ; un blanc, `_` ou `-` du nom s'écrit comme l'un des trois. */
const TITRE = (nom: string): RegExp => {
  const n = nom.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&").replace(/[ _-]/gu, "[ \\t_-]");
  return new RegExp(
    `^[ \\t]{0,3}(?:#{1,6}[ \\t]*[*_\`]*${n}(?![*_\`]*[:\\p{L}\\p{N}_])(?![ \\t]+\\p{L})[^\\n]*` +
      `|(?:(?:[-*+>]|#{1,6})[ \\t]*)?[*_\`]*${n}[*_\`]*[ \\t]*(?::[*_\`]*|$))`,
    "imu",
  );
};

/** Valeurs de la ligne `Status:` lues sans équivoque (le reste n'est pas lu) ; les synonymes d'échec valent `blocked`, jamais `done`. */
const STATUTS_LUS: ReadonlyMap<string, "done" | "partial" | "blocked"> = new Map([
  ["done", "done"],
  ["complete", "done"],
  ["completed", "done"],
  ["terminé", "done"],
  ["termine", "done"],
  ["terminée", "done"],
  ["fait", "done"],
  ["faite", "done"],
  ["fini", "done"],
  ["finie", "done"],
  ["partial", "partial"],
  ["incomplete", "partial"],
  ["partiel", "partial"],
  ["partielle", "partial"],
  ["blocked", "blocked"],
  ["failed", "blocked"],
  ["failure", "blocked"],
  ["fail", "blocked"],
  ["bloqué", "blocked"],
  ["bloque", "blocked"],
  ["bloquée", "blocked"],
]);

const LIGNE_STATUT =
  /^[ \t]{0,3}(?:(?:[-*+]|#{1,6})[ \t]*)?[*_`]*(?:status|statut)[*_`]*[ \t]*:[ \t]*[*_`]*(.*)$/iu;
const LIGNE_VERDICT =
  /^[ \t]{0,3}(?:(?:[-*+]|#{1,6})[ \t]*)?[*_`]*(?:verdict)[*_`]*[ \t]*:[ \t]*[*_`]*(.*)$/iu;
const LIGNE_TITRE = /^[ \t]{0,3}#{1,6}[ \t]/u;
const LIGNE_CLOTURE = /^[ \t]{0,3}(?:`{3,}|~{3,})/u;
const LIGNE_CITATION = /^[ \t]{0,3}>/u;

const OUVERTURE_CODE = /^[ \t]{0,3}(`{3,}|~{3,})[ \t]*[\w-]*[ \t]*$/u;
const FERMETURE_CODE = /^[ \t]{0,3}(`{3,}|~{3,})[ \t]*$/u;
const LIGNE_TITRE_1 = /^[ \t]{0,3}#[ \t]/u;

/** Rapport tout entier dans un seul bloc de code (```markdown … ```) : son contenu ; tel quel si le bloc ne couvre pas tout, ou se referme avant la fin. */
function deballer(rapport: string): string {
  const lignes = rapport.split(/\r?\n/u);
  const utiles = lignes.map((l, i) => (l.trim() ? i : -1)).filter((i) => i >= 0);
  if (utiles.length < 2) return rapport;
  const debut = utiles[0]!;
  const fin = utiles[utiles.length - 1]!;
  const ouvre = OUVERTURE_CODE.exec(lignes[debut]!);
  const ferme = FERMETURE_CODE.exec(lignes[fin]!);
  if (!ouvre || !ferme || ferme[1]![0] !== ouvre[1]![0] || ferme[1]!.length < ouvre[1]!.length)
    return rapport;
  const interieur = lignes.slice(debut + 1, fin);
  const referme = interieur.some((l) => {
    const m = FERMETURE_CODE.exec(l);
    return m !== null && m[1]![0] === ouvre[1]![0] && m[1]!.length >= ouvre[1]!.length;
  });
  return referme ? rapport : interieur.join("\n");
}

/** Lignes de tête du rapport où une déclaration est lue : la première ligne non vide et celles qui la suivent jusqu'au premier titre `#` (ce titre compris), hors citations `>` et blocs de code ; une page citée plus bas ne déclare rien. Le rapport entier dans un bloc de code est lu à l'intérieur, et un titre de niveau 1 en tête n'y compte pas quand la ligne `Status:` ou `Verdict:` le suit aussitôt. */
function lignesDeTete(rapport: string): string[] {
  const tete: string[] = [];
  let code = false;
  let titreEnTete = false;
  for (const ligne of deballer(rapport).split(/\r?\n/u)) {
    if (LIGNE_CLOTURE.test(ligne)) {
      code = !code;
      continue;
    }
    if (code || !ligne.trim() || LIGNE_CITATION.test(ligne)) continue;
    const declare = LIGNE_STATUT.test(ligne) || LIGNE_VERDICT.test(ligne);
    if (titreEnTete && !declare) break;
    if (tete.length === 0 && !titreEnTete && !declare && LIGNE_TITRE_1.test(ligne)) {
      titreEnTete = true;
      continue;
    }
    titreEnTete = false;
    tete.push(ligne);
    if (LIGNE_TITRE.test(ligne)) break;
  }
  return tete;
}

/** Valeur de la première ligne de tête qui déclare `motif` (`Status:`, `Verdict:`), lue sur la ligne de tête suivante si elle est vide ; `null` si aucune. */
function valeurDeclaree(rapport: string, motif: RegExp): string | null {
  const tete = lignesDeTete(rapport);
  for (const [i, ligne] of tete.entries()) {
    const m = motif.exec(ligne);
    if (!m) continue;
    const valeur = m[1] ?? "";
    return /\p{L}/u.test(valeur) ? valeur : (tete[i + 1] ?? "");
  }
  return null;
}

/** Statut déclaré par la ligne `Status:` de tête du rapport (casse, gras, puces et synonymes tolérés) ; `unknown` si elle manque, si sa valeur n'est pas lue ou si c'est le gabarit recopié (`done | partial | blocked`) : jamais `done` par défaut, et jamais lu dans une citation, un bloc de code ou sous un titre (`Evidence` cite des pages). */
export function statutDeclare(rapport: string): "done" | "partial" | "blocked" | "unknown" {
  const valeur = valeurDeclaree(rapport, LIGNE_STATUT) ?? "";
  const mots = valeur.toLowerCase().match(/[\p{L}_]+/gu) ?? [];
  const lus = mots.map((m) => STATUTS_LUS.get(m));
  const premier = lus[0];
  if (premier === undefined) return "unknown";
  if (valeur.includes("|") && new Set(lus.filter(Boolean)).size > 1) return "unknown";
  return premier;
}

export type Verdict = "pass" | "fail" | "inconclusive";

const VERDICTS_LUS: ReadonlyMap<string, Verdict> = new Map([
  ["pass", "pass"],
  ["passed", "pass"],
  ["passes", "pass"],
  ["fail", "fail"],
  ["failed", "fail"],
  ["fails", "fail"],
  ["failing", "fail"],
  ["failure", "fail"],
  ["inconclusive", "inconclusive"],
]);

/** Verdict déclaré par la ligne `Verdict:` de tête (agent `verify`) : `pass`, `fail` ou `inconclusive` ; `null` si elle manque, si sa valeur n'est pas lue ou si c'est le gabarit recopié. */
export function verdictDeclare(rapport: string): Verdict | null {
  const valeur = valeurDeclaree(rapport, LIGNE_VERDICT);
  if (valeur === null) return null;
  const lus = (valeur.toLowerCase().match(/[\p{L}_]+/gu) ?? []).map((m) => VERDICTS_LUS.get(m));
  const premier = lus[0];
  if (premier === undefined) return null;
  if (valeur.includes("|") && new Set(lus.filter(Boolean)).size > 1) return null;
  return premier;
}

/** Section `Left open` du rapport (travail restant), bornée ; `null` si absente ou vide. */
export function travailRestant(rapport: string): string | null {
  const m = TITRE("left open").exec(rapport);
  if (!m) return null;
  const reste = rapport.slice(m.index + m[0].length);
  const fin = /^\s{0,3}#{1,6}\s/mu.exec(reste);
  const t = stripPy(fin ? reste.slice(0, fin.index) : reste);
  if (!t || /^[-*`\s]*(?:nothing|none|n\/a|rien|aucun|aucune)[`*\s.!]*$/iu.test(t)) return null;
  return longueurPy(t) > 2000 ? prefixePy(t, 1999) + "…" : t;
}
