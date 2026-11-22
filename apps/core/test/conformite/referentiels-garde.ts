// SPDX-License-Identifier: MIT
/** apps/core/test/conformite/referentiels-garde.ts — lit un fichier de test pour le garde-fou de la matrice : titres des tests déclarés, marqueurs interdits (skip, todo, only). */
import ts from "typescript";

export const LONGUEUR_MIN_TITRE = 20;

function texteDe(n: ts.Expression): string {
  if (ts.isStringLiteralLike(n)) return n.text;
  if (ts.isTemplateExpression(n)) return n.getText().slice(1, -1);
  if (ts.isParenthesizedExpression(n)) return texteDe(n.expression);
  if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.PlusToken)
    return texteDe(n.left) + texteDe(n.right);
  return n.getText();
}

/** Vrai pour `it`, `test` ou l'une de leurs formes `.each(...)`, `.skipIf(...)`, `.runIf(...)` appelées ensuite avec le titre. */
function estAppelDeTest(appelee: ts.Expression): boolean {
  if (ts.isIdentifier(appelee)) return appelee.text === "it" || appelee.text === "test";
  if (!ts.isCallExpression(appelee) || !ts.isPropertyAccessExpression(appelee.expression)) return false;
  const base = appelee.expression.expression;
  return (
    ts.isIdentifier(base) &&
    (base.text === "it" || base.text === "test") &&
    ["each", "skipIf", "runIf"].includes(appelee.expression.name.text)
  );
}

export interface LectureTests {
  /** Premier argument de chaque appel `it(` / `it.each(…)(` / `it.skipIf(…)(` / `test(`. */
  readonly titres: readonly string[];
  /** Occurrences de `.skip`, `.todo` ou `.only` (un `skipIf` reste permis). */
  readonly interdits: readonly string[];
}

/** Titres déclarés et marqueurs interdits d'un texte de test ; les commentaires et les lignes d'un tableau de cas n'en font pas partie. */
export function lireTests(texte: string): LectureTests {
  const source = ts.createSourceFile("test.ts", texte, ts.ScriptTarget.Latest, true);
  const titres: string[] = [];
  const interdits: string[] = [];
  const visiter = (n: ts.Node): void => {
    if (ts.isCallExpression(n) && estAppelDeTest(n.expression) && n.arguments[0] !== undefined)
      titres.push(texteDe(n.arguments[0]));
    if (ts.isPropertyAccessExpression(n) && ["skip", "todo", "only"].includes(n.name.text))
      interdits.push(n.getText());
    ts.forEachChild(n, visiter);
  };
  visiter(source);
  return { titres, interdits };
}

function occurrences(texte: string, motif: string): number {
  let n = 0;
  for (let i = texte.indexOf(motif); i !== -1; i = texte.indexOf(motif, i + motif.length)) n += 1;
  return n;
}

/** Raison pour laquelle `titre` ne désigne pas un test unique et actif de `texte`, ou `null` quand la preuve tient. */
export function defautDePreuve(texte: string, titre: string): string | null {
  if (titre.trim().length < LONGUEUR_MIN_TITRE)
    return `titre de moins de ${String(LONGUEUR_MIN_TITRE)} caractères`;
  const { titres } = lireTests(texte);
  if (titres.filter((t) => t.includes(titre)).length === 0) return "titre absent des tests déclarés";
  if (occurrences(texte, titre) !== 1)
    return "titre présent plusieurs fois dans le fichier (ou écrit autrement)";
  return null;
}
