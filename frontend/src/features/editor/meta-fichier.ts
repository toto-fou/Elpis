// SPDX-License-Identifier: MIT
/** frontend/src/features/editor/meta-fichier.ts — icône, couleur et langage d'un fichier d'après son extension (arbre et onglets ; porté de `getFileMeta` d'utils.js). */
import type { MetaFichier } from "./onglets";

export interface MetaFichierLangue extends MetaFichier {
  lang: string;
}

const TABLE: Readonly<Record<string, MetaFichierLangue>> = {
  js: { icon: "ph-file-js", color: "text-yellow-400", lang: "javascript" },
  ts: { icon: "ph-file-ts", color: "text-blue-400", lang: "typescript" },
  html: { icon: "ph-browsers", color: "text-orange-500", lang: "html" },
  css: { icon: "ph-paint-brush", color: "text-sky-400", lang: "css" },
  json: { icon: "ph-brackets-curly", color: "text-lime-500", lang: "json" },
  py: { icon: "ph-file-py", color: "text-blue-500", lang: "python" },
  sh: { icon: "ph-terminal-window", color: "text-green-500", lang: "shell" },
  md: { icon: "ph-info", color: "text-slate-400", lang: "markdown" },
  txt: { icon: "ph-file-text", color: "text-gray-500", lang: "plaintext" },
  robot: { icon: "ph-robot", color: "text-cyan-600", lang: "robot" },
  docx: { icon: "ph-file-doc", color: "text-blue-400", lang: "plaintext" },
  pptx: { icon: "ph-file-ppt", color: "text-orange-400", lang: "plaintext" },
  xlsx: { icon: "ph-file-xls", color: "text-emerald-400", lang: "plaintext" },
  pdf: { icon: "ph-file-pdf", color: "text-rose-400", lang: "plaintext" },
};

const DEFAUT: MetaFichierLangue = { icon: "ph-file", color: "text-gray-400", lang: "plaintext" };

export function metaFichier(nom: string): MetaFichierLangue {
  const ext = String(nom).split(".").pop()?.toLowerCase() ?? "";
  return TABLE[ext] ?? DEFAUT;
}
