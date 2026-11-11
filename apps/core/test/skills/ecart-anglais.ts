// SPDX-License-Identifier: MIT
/** apps/core/test/skills/ecart-anglais.ts — écart voulu au Python : messages des outils skill et chart renvoyés au modèle en anglais, suggestion de nom (B-13, B-20). */

const BIBLIO: [RegExp, string][] = [
  [/name invalide \(vide après normalisation\)/g, "invalid name (empty after normalisation)"],
  [/body requis \(la procédure ne peut pas être vide\)/g, "body required (the procedure cannot be empty)"],
  [
    /'learned' est réservé \(SAS de curation\) — choisis un autre name\/domaine/g,
    "'learned' is reserved (curation staging area): choose another name/domain",
  ],
  [
    /'([^']*)' existe déjà à cet emplacement — renommage refusé/g,
    "'$1' already exists at this location: rename refused",
  ],
  [/renommage du dossier impossible : /g, "cannot rename the folder: "],
  [
    /un dossier '([^']*)' existe déjà et contient des skills mono-fichier — choisis un autre name \(ou migre d'abord ce dossier en package\)/g,
    "a folder '$1' already exists and holds single-file skills: choose another name (or first migrate that folder to a package)",
  ],
  [
    /un skill global '([^']*)' existe déjà — édite-le directement ou choisis un autre name \(les learned ne peuvent pas masquer un skill curé\)/g,
    "a global skill '$1' already exists: edit it directly or choose another name (learned skills cannot shadow a curated skill)",
  ],
  [
    /chemin invalide : relatif au dossier du skill \(ex\. scripts\/run\.sh\), sans '\.\.' ni segments cachés/g,
    "invalid path: relative to the skill folder (e.g. scripts/run.sh), without '..' or hidden segments",
  ],
  [
    /SKILL\.md se met à jour via skill_save, pas via skill_add_file/g,
    "SKILL.md is updated via skill_save, not via skill_add_file",
  ],
  [/content requis \(fichier vide refusé\)/g, "content required (empty file refused)"],
  [/fichier trop gros \((\d+) > (\d+) octets\)/g, "file too large ($1 > $2 bytes)"],
  [
    /skill perso « ([^»]*) » introuvable au format dossier — crée-le d'abord avec skill_save/g,
    "personal skill « $1 » not found in folder format: create it first with skill_save",
  ],
  [/chemin hors du dossier du skill/g, "path outside the skill folder"],
];

const AUTRES: [RegExp, string][] = [
  [/chemin requis/g, "path required"],
  [/fichier introuvable : /g, "file not found: "],
  [/ce skill n'embarque aucun fichier\./g, "this skill bundles no files."],
  [
    /path relatif au dossier du skill \(ex\. 'scripts\/run\.py'\), issu de la liste `files` de skill_get\./g,
    "path relative to the skill folder (e.g. 'scripts/run.py'), taken from the `files` list of skill_get.",
  ],
  [
    /Ce skill embarque des fichiers \(champ `files`\)\. Lis-en un avec `skill_read_file\('([^']*)', '<chemin>'\)` et exécute un script avec `skill_run_script\('([^']*)', 'scripts\/<x>\.py'\)` — les fichiers ne sont PAS dans \/work, n'essaie pas read_file\/execute_shell dessus\./g,
    "This skill bundles files (field `files`). Read one with `skill_read_file('$1', '<path>')` and run a script with `skill_run_script('$2', 'scripts/<x>.py')` — the files are NOT in /work, do not try read_file/execute_shell on them.",
  ],
  [/Sous-skills \(charge-les via skill_get\) : /g, "Sub-skills (load them via skill_get): "],
  [/\(e\.g\. « Réponds au questionnaire ci-dessous 👇 »\)/g, "(e.g. « Answer the questionnaire below 👇 »)"],
  [
    /(\w+) : il faut deux colonnes numériques \(x et y\) — colonnes : /g,
    "$1: needs two numeric columns (x and y); columns: ",
  ],
];

/** Texte attendu (Python) mis en anglais. */
export function enAnglais(texte: string): string {
  return [...BIBLIO, ...AUTRES].reduce((t, [re, par]) => t.replace(re, par), texte);
}

/** Texte obtenu sans la suggestion « Closest names: … » ajoutée après le Python. */
export function sansSuggestion(texte: string): string {
  return texte.replace(/Closest names: [^.]*\. /g, "");
}
