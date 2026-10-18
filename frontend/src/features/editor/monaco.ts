// SPDX-License-Identifier: MIT
/** frontend/src/features/editor/monaco.ts — Monaco en ESM : workers livrés par Vite, global `window.monaco` posé pour les scripts historiques. */
import * as monaco from "monaco-editor";
import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import CssWorker from "monaco-editor/esm/vs/language/css/css.worker?worker";
import HtmlWorker from "monaco-editor/esm/vs/language/html/html.worker?worker";
import JsonWorker from "monaco-editor/esm/vs/language/json/json.worker?worker";
import TsWorker from "monaco-editor/esm/vs/language/typescript/ts.worker?worker";

export type Monaco = typeof monaco;

declare global {
  interface Window {
    monaco?: Monaco;
  }
}

/** Worker propre à un langage, éditeur générique sinon (même répartition que le chargeur AMD). */
export function creerWorker(langage: string): Worker {
  if (langage === "json") return new JsonWorker();
  if (langage === "css" || langage === "scss" || langage === "less") return new CssWorker();
  if (langage === "html" || langage === "handlebars" || langage === "razor") return new HtmlWorker();
  if (langage === "typescript" || langage === "javascript") return new TsWorker();
  return new EditorWorker();
}

/** Déclare les workers puis publie l'API ; idempotent. */
export function installerMonaco(): Monaco {
  const cible = self as unknown as { MonacoEnvironment?: monaco.Environment };
  cible.MonacoEnvironment ??= { getWorker: (_id: string, langage: string) => creerWorker(langage) };
  window.monaco ??= monaco;
  return window.monaco;
}
