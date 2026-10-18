// SPDX-License-Identifier: MIT
/** eslint.config.mjs — lint du TypeScript (apps/*, packages/*) et du frontend TS (frontend/src, frontend/test, SFC). */
import { readdirSync, readFileSync } from "node:fs";

import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import tseslint from "typescript-eslint";
import pluginVue from "eslint-plugin-vue";

/** Invariant 3 : seul apps/core/src/contexte/tokens.ts compte les tokens (requêtes /tokenize, /apply-template) ; le ratio chars/token n'est défini que dans @elpis/config. */
const COMPTEUR = "apps/core/src/contexte/tokens.ts";
const RATIO = "packages/config/src/contexte.ts";
const MOTIF_REQUETE = "/^[^\\s]*\\/((de)?tokenize|apply-template)\\/?([?#].*)?$/";
const MOTIF_NU = "/^((de)?tokenize|apply-template)\\/?([?#].*)?$/";
const MESSAGE_REQUETE = `invariant 3 : les tokens se comptent par ${COMPTEUR} (countTokensExact, countTokensForMessages…), pas par une requête directe au moteur.`;
const textes = (motif) => [`Literal[value=${motif}]`, `TemplateElement[value.raw=${motif}]`];
const URLS = [
  'NewExpression[callee.name="URL"]',
  'NewExpression[callee.property.name="URL"]',
  'CallExpression[callee.object.name="URL"][callee.property.name=/^(parse|canParse)$/]',
];
/** Chemin du moteur (sans espace avant le dernier « / ») partout ; nom nu (`new URL("tokenize", base)`, `${base}tokenize`) dans une URL construite. */
const requeteJetons = [
  ...textes(MOTIF_REQUETE),
  ...URLS.flatMap((url) => textes(MOTIF_NU).map((t) => `${url} ${t}`)),
].map((selector) => ({ selector, message: MESSAGE_REQUETE }));
const ratioJetons = [
  {
    selector: "VariableDeclarator[id.name=/chars_?per_?tokens?|tokens?_?per_?chars?/i]",
    message: `invariant 3 : le ratio chars/token se lit dans @elpis/config (${RATIO}), il ne se redéfinit pas.`,
  },
];
/** contexte/config-contexte.ts estime aussi des tokens (`estTokens`, ratio réglable de context_config.json) : avertissement des budgets au chargement, comme le Python, pas un compteur. */
const TESTS = ["apps/*/test/**/*.ts", "packages/*/test/**/*.ts"];

/** Invariant 7 : clés de `config` rechargées à chaud (vivant.ts, ou affectées par la console ailleurs dans src) et lecteurs vivants de config.json, jamais lus au chargement d'un module (limite : fonction locale appelée au chargement, alias local de `config`). */
const SOURCES = ["apps", "packages"].flatMap((d) =>
  readdirSync(new URL(`${d}/`, import.meta.url), { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .flatMap((e) =>
      readdirSync(new URL(`${d}/${e.name}/src/`, import.meta.url), { recursive: true })
        .filter((f) => String(f).endsWith(".ts"))
        .map((f) => new URL(`${d}/${e.name}/src/${f}`, import.meta.url)),
    ),
);
const CLES_VIVES = new Set(
  SOURCES.flatMap((f) => {
    const texte = readFileSync(f, "utf-8");
    const motif = f.pathname.endsWith("/packages/config/src/vivant.ts")
      ? /\b(?:c|config)\.([A-Z][A-Z0-9_]*)\s*=(?!=)/gu
      : /\bconfig\.([A-Z][A-Z0-9_]*)\s*=(?!=)/gu;
    return [...texte.matchAll(motif)].map((m) => m[1]);
  }),
);
const LECTEURS_CONFIG = [
  "configView",
  "featureEnabled",
  "getDesktopTarget",
  "getDesktopTargets",
  "httpsEnabled",
  "httpsPorts",
  "lireConfigDisque",
  "liveConfigValue",
  "maxRecentChats",
  "readConfigJson",
  "sandboxImportMaxPct",
  "sessionCookieAttrs",
];
/** Source d'import → lecteurs vivants qu'elle exporte (chemins relatifs : à l'intérieur du paquet). */
const LECTEURS_VIFS = new Map([
  ...["@elpis/config", "./instance", "./vivant", "./config-json"].map((src) => [
    src,
    new Set(LECTEURS_CONFIG),
  ]),
  ["@elpis/bac", new Set(["chargerConfigBac", "loadAdminConfig"])],
  ["./profils", new Set(["chargerConfigBac"])],
  ["./conteneur", new Set(["loadAdminConfig"])],
]);
const SOURCES_CONFIG = new Set(["@elpis/config", "./instance", "./vivant", "./config-json"]);
const FONCTIONS = new Set(["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"]);
const ENVELOPPES_TS = new Set([
  "TSAsExpression",
  "TSNonNullExpression",
  "TSSatisfiesExpression",
  "TSTypeAssertion",
]);

/** Vrai si `noeud` s'évalue au chargement du module : hors de toute fonction (sauf appelée sur place) et de tout champ d'instance. */
function auChargement(noeud) {
  for (let n = noeud.parent; n; n = n.parent) {
    if (FONCTIONS.has(n.type) && !(n.parent?.type === "CallExpression" && n.parent.callee === n))
      return false;
    if ((n.type === "PropertyDefinition" || n.type === "AccessorProperty") && !n.static) return false;
  }
  return true;
}

/** `{ source, nom }` de l'import que désigne l'identifiant (alias compris, `nom` = « * » pour un espace de noms), ou `null`. */
function importDe(contexte, identifiant) {
  for (let scope = contexte.sourceCode.getScope(identifiant); scope; scope = scope.upper) {
    const v = scope.set.get(identifiant.name);
    if (!v) continue;
    const def = v.defs[0];
    if (def?.type !== "ImportBinding") return null;
    const source = def.parent.source.value;
    if (def.node.type === "ImportNamespaceSpecifier") return { source, nom: "*" };
    if (def.node.type === "ImportSpecifier")
      return { source, nom: def.node.imported.name ?? def.node.imported.value };
    return null;
  }
  return null;
}

const sansEnveloppe = (n) => (n && ENVELOPPES_TS.has(n.type) ? sansEnveloppe(n.expression) : n);
const nomDeCle = (m) =>
  !m.computed
    ? m.property.name
    : m.property.type === "Literal"
      ? m.property.value
      : m.property.type === "TemplateLiteral" && m.property.expressions.length === 0
        ? m.property.quasis[0].value.cooked
        : null;

const regleReglagesVifs = {
  meta: {
    type: "problem",
    messages: {
      fige: "invariant 7 : {{quoi}} est modifiable depuis la console (rechargé à chaud) : le lire à chaque usage, pas dans une constante du chargement du module.",
    },
    schema: [],
  },
  create(contexte) {
    const signaler = (noeud, quoi) => contexte.report({ node: noeud, messageId: "fige", data: { quoi } });
    /** `config` de @elpis/config : identifiant importé (alias, assertion de type) ou `<espace>.config`. */
    const estConfig = (brut) => {
      const n = sansEnveloppe(brut);
      if (n?.type === "Identifier") {
        const i = importDe(contexte, n);
        return i !== null && SOURCES_CONFIG.has(i.source) && i.nom === "config";
      }
      if (n?.type !== "MemberExpression" || nomDeCle(n) !== "config") return false;
      const espace = sansEnveloppe(n.object);
      const i = espace?.type === "Identifier" ? importDe(contexte, espace) : null;
      return i !== null && SOURCES_CONFIG.has(i.source) && i.nom === "*";
    };
    /** Nom du lecteur vivant appelé (`f()` importé, ou `<espace>.f()`), sinon `null`. */
    const lecteur = (callee) => {
      const c = sansEnveloppe(callee);
      const id =
        c?.type === "Identifier" ? c : c?.type === "MemberExpression" ? sansEnveloppe(c.object) : null;
      if (id?.type !== "Identifier") return null;
      const i = importDe(contexte, id);
      if (i === null) return null;
      const nom = c.type === "Identifier" ? i.nom : i.nom === "*" ? nomDeCle(c) : null;
      return nom !== null && LECTEURS_VIFS.get(i.source)?.has(nom) ? nom : null;
    };
    return {
      MemberExpression(m) {
        const cle = nomDeCle(m);
        if (CLES_VIVES.has(cle) && auChargement(m) && estConfig(m.object)) signaler(m, `config.${cle}`);
      },
      VariableDeclarator(d) {
        if (d.id.type !== "ObjectPattern" || !auChargement(d) || !estConfig(d.init)) return;
        for (const p of d.id.properties) {
          const nom = p.type === "RestElement" ? null : (p.key?.name ?? p.key?.value);
          if (p.type === "RestElement" || CLES_VIVES.has(nom))
            signaler(p, nom === null ? "le reste de config" : `config.${nom}`);
        }
      },
      CallExpression(c) {
        if (!auChargement(c)) return;
        const nom = lecteur(c.callee);
        if (nom !== null) signaler(c, `${nom}()`);
      },
    };
  },
};

export default defineConfig(
  { ignores: ["**/dist/**", "**/node_modules/**", "**/*.gen.ts", "apps/core/greffon-opencode/**"] },
  {
    files: ["apps/**/*.ts", "packages/**/*.ts"],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/await-thenable": "error",
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      eqeqeq: ["error", "always", { null: "ignore" }],
      "no-console": "error",
    },
  },
  {
    files: TESTS,
    rules: { "no-console": "off" },
  },
  {
    files: ["apps/**/*.ts", "packages/**/*.ts"],
    ignores: [COMPTEUR, RATIO, ...TESTS],
    rules: { "no-restricted-syntax": ["error", ...requeteJetons, ...ratioJetons] },
  },
  { files: [COMPTEUR], rules: { "no-restricted-syntax": ["error", ...ratioJetons] } },
  {
    files: ["apps/*/src/**/*.ts", "packages/*/src/**/*.ts"],
    plugins: { elpis: { rules: { "reglages-vifs": regleReglagesVifs } } },
    rules: { "elpis/reglages-vifs": "error" },
  },
  { files: [RATIO], rules: { "no-restricted-syntax": ["error", ...requeteJetons] } },
  {
    files: ["frontend/src/**/*.{ts,vue}", "frontend/test/**/*.ts", "frontend/*.mts"],
    extends: [
      js.configs.recommended,
      ...tseslint.configs.recommended,
      ...pluginVue.configs["flat/recommended"],
    ],
    languageOptions: {
      parserOptions: {
        parser: tseslint.parser,
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
        extraFileExtensions: [".vue"],
      },
    },
    rules: {
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/await-thenable": "error",
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      eqeqeq: ["error", "always", { null: "ignore" }],
      "no-console": "error",
      "vue/html-self-closing": "off",
      "vue/max-attributes-per-line": "off",
      "vue/singleline-html-element-content-newline": "off",
      "vue/html-indent": "off",
      "vue/html-closing-bracket-newline": "off",
    },
  },
);
