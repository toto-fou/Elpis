// SPDX-License-Identifier: MIT
/** frontend/src/features/editor/langages.ts — langage Monaco d'un fichier (nom spécial, puis extension) et tokeniseur Monarch de Robot Framework (porté de `editor/_languages.js`). */
import type { Monaco } from "./monaco";

export interface LangageFichier {
  lang: string;
  icon: string;
  color: string;
}

const l = (lang: string, icon: string, color: string): LangageFichier => ({ lang, icon, color });

export const LANG_MAP: Readonly<Record<string, LangageFichier>> = {
  js: l("javascript", "ph-file-js", "text-yellow-400"),
  mjs: l("javascript", "ph-file-js", "text-yellow-400"),
  cjs: l("javascript", "ph-file-js", "text-yellow-400"),
  jsx: l("javascript", "ph-file-js", "text-yellow-400"),
  ts: l("typescript", "ph-file-ts", "text-blue-400"),
  tsx: l("typescript", "ph-file-ts", "text-blue-400"),
  html: l("html", "ph-browsers", "text-orange-500"),
  htm: l("html", "ph-browsers", "text-orange-500"),
  vue: l("html", "ph-browsers", "text-emerald-500"),
  css: l("css", "ph-paint-brush", "text-sky-400"),
  scss: l("scss", "ph-paint-brush", "text-pink-400"),
  sass: l("scss", "ph-paint-brush", "text-pink-400"),
  less: l("less", "ph-paint-brush", "text-indigo-400"),
  json: l("json", "ph-brackets-curly", "text-lime-500"),
  jsonc: l("json", "ph-brackets-curly", "text-lime-500"),
  yaml: l("yaml", "ph-file-text", "text-yellow-500"),
  yml: l("yaml", "ph-file-text", "text-yellow-500"),
  toml: l("ini", "ph-file-text", "text-orange-400"),
  ini: l("ini", "ph-file-text", "text-slate-400"),
  env: l("ini", "ph-file-text", "text-slate-400"),
  xml: l("xml", "ph-code", "text-orange-400"),
  svg: l("xml", "ph-image", "text-purple-400"),
  sql: l("sql", "ph-database", "text-blue-400"),
  graphql: l("graphql", "ph-graph", "text-pink-500"),
  gql: l("graphql", "ph-graph", "text-pink-500"),
  py: l("python", "ph-file-py", "text-blue-500"),
  pyw: l("python", "ph-file-py", "text-blue-500"),
  go: l("go", "ph-file-code", "text-cyan-500"),
  rs: l("rust", "ph-file-code", "text-orange-500"),
  java: l("java", "ph-file-code", "text-red-500"),
  kt: l("kotlin", "ph-file-code", "text-purple-500"),
  kts: l("kotlin", "ph-file-code", "text-purple-500"),
  c: l("c", "ph-file-code", "text-blue-600"),
  h: l("c", "ph-file-code", "text-blue-400"),
  cpp: l("cpp", "ph-file-code", "text-blue-600"),
  cc: l("cpp", "ph-file-code", "text-blue-600"),
  cxx: l("cpp", "ph-file-code", "text-blue-600"),
  hpp: l("cpp", "ph-file-code", "text-blue-400"),
  cs: l("csharp", "ph-file-code", "text-green-600"),
  rb: l("ruby", "ph-file-code", "text-red-500"),
  php: l("php", "ph-file-code", "text-indigo-500"),
  swift: l("swift", "ph-file-code", "text-orange-500"),
  r: l("r", "ph-file-code", "text-blue-400"),
  sh: l("shell", "ph-terminal-window", "text-green-500"),
  bash: l("shell", "ph-terminal-window", "text-green-500"),
  zsh: l("shell", "ph-terminal-window", "text-green-400"),
  fish: l("shell", "ph-terminal-window", "text-green-400"),
  ps1: l("powershell", "ph-terminal-window", "text-blue-500"),
  psm1: l("powershell", "ph-terminal-window", "text-blue-500"),
  dockerfile: l("dockerfile", "ph-cube", "text-sky-500"),
  nginx: l("nginx", "ph-file-text", "text-emerald-500"),
  proto: l("proto3", "ph-file-code", "text-slate-400"),
  tf: l("hcl", "ph-file-code", "text-purple-400"),
  hcl: l("hcl", "ph-file-code", "text-purple-400"),
  md: l("markdown", "ph-info", "text-slate-400"),
  mdx: l("markdown", "ph-info", "text-slate-400"),
  rst: l("restructuredtext", "ph-info", "text-slate-400"),
  robot: l("robotframework", "ph-robot", "text-cyan-600"),
  resource: l("robotframework", "ph-robot", "text-cyan-500"),
  txt: l("plaintext", "ph-file-text", "text-gray-500"),
  log: l("plaintext", "ph-file-text", "text-gray-400"),
  csv: l("plaintext", "ph-table", "text-green-500"),
};

/** Noms de fichiers sans extension significative. */
export const FILENAME_LANG_MAP: Readonly<Record<string, string>> = {
  dockerfile: "dockerfile",
  makefile: "makefile",
  gemfile: "ruby",
  rakefile: "ruby",
  procfile: "shell",
  vagrantfile: "ruby",
  ".env": "ini",
  ".gitignore": "ini",
  ".htaccess": "apache",
  "nginx.conf": "nginx",
};

/** Langage Monaco d'un chemin (insensible à la casse) : nom exact d'abord, puis extension. */
export function langageDe(chemin: string | null | undefined): string {
  const nom = (chemin || "").split("/").pop()?.toLowerCase() ?? "";
  if (Object.hasOwn(FILENAME_LANG_MAP, nom)) return FILENAME_LANG_MAP[nom] ?? "plaintext";
  const ext = nom.split(".").pop() ?? "";
  return (Object.hasOwn(LANG_MAP, ext) && LANG_MAP[ext]?.lang) || "plaintext";
}

/** Déclare Robot Framework auprès de Monaco ; idempotent. */
export function enregistrerRobotFramework(monaco: Monaco | undefined): void {
  if (!monaco) return;
  if (monaco.languages.getLanguages().some((x) => x.id === "robotframework")) return;
  monaco.languages.register({
    id: "robotframework",
    extensions: [".robot", ".resource"],
    aliases: ["Robot Framework", "robot"],
  });
  monaco.languages.setMonarchTokensProvider("robotframework", {
    defaultToken: "text",
    tokenPostfix: ".robot",
    keywords: [
      "IF",
      "ELSE IF",
      "ELSE",
      "END",
      "FOR",
      "IN",
      "IN RANGE",
      "IN ENUMERATE",
      "IN ZIP",
      "WHILE",
      "BREAK",
      "CONTINUE",
      "TRY",
      "EXCEPT",
      "FINALLY",
      "RETURN",
      "SKIP",
    ],
    settings_keywords: [
      "Library",
      "Resource",
      "Variables",
      "Documentation",
      "Metadata",
      "Suite Setup",
      "Suite Teardown",
      "Test Setup",
      "Test Teardown",
      "Test Template",
      "Test Timeout",
      "Task Setup",
      "Task Teardown",
      "Task Template",
      "Task Timeout",
      "Force Tags",
      "Default Tags",
    ],
    tokenizer: {
      root: [
        [
          /^\*{3,}\s*(Settings?|Variables?|Test Cases?|Tasks?|Keywords?|Comments?)\s*\*{0,3}/i,
          "keyword.section",
        ],
        [/#.*$/, "comment"],
        [/\[[A-Za-z ]+\]/, "type.annotation"],
        [/[$@&%]\{[^}]*\}/, "variable"],
        [/[$@&%]\{[^}]*\}\s*=/, "variable.definition"],
        [/"(?:[^"\\]|\\.)*"/, "string"],
        [/'(?:[^'\\]|\\.)*'/, "string"],
        [/\b([A-Za-z_][A-Za-z0-9_]*)\s*=/, "variable.parameter"],
        [/\b-?\d+(?:\.\d+)?\b/, "number"],
        [
          /^(Library|Resource|Variables|Documentation|Metadata|Suite Setup|Suite Teardown|Test Setup|Test Teardown|Test Template|Test Timeout|Task Setup|Task Teardown|Task Template|Task Timeout|Force Tags|Default Tags|Tags)\b/i,
          "keyword",
        ],
        [
          /\b(IF|ELSE IF|ELSE|END|FOR|IN(?:\s+RANGE|\s+ENUMERATE|\s+ZIP)?|WHILE|BREAK|CONTINUE|TRY|EXCEPT|FINALLY|RETURN|SKIP)\b/,
          "keyword.control",
        ],
        [/(?: {2,}|\t)/, "white"],
      ],
    },
  });
  monaco.languages.setLanguageConfiguration("robotframework", {
    comments: { lineComment: "#" },
    brackets: [
      ["${", "}"],
      ["@{", "}"],
      ["&{", "}"],
      ["(", ")"],
      ["[", "]"],
    ],
    wordPattern: /([^\s:,(])+/,
  });
}
