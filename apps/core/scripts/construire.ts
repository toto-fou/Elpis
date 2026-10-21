// SPDX-License-Identifier: MIT
/** apps/core/scripts/construire.ts — bundle de production du core (dist/main.mjs, dist/exploitation.mjs, thread dist/pixels.mjs et ses codecs WebAssembly), module natif par cible, licences des paquets livrés. */
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import { build } from "esbuild";
import type { Metafile } from "esbuild";

import { empreinteSources } from "@elpis/commun/empreinte";

export const RACINE = path.resolve(import.meta.dirname, "..", "..", "..");
const CORE = path.join(RACINE, "apps", "core");
export const CIBLES: readonly string[] = ["linux-x64", "linux-arm64"];
export const NATIFS = ["better-sqlite3"];
export const COMPILES_DANS: Readonly<Record<string, readonly string[]>> = {
  "better-sqlite3": ["node-addon-api"],
};
const FICHIERS_CONSTRUCTION = [
  "package.json",
  "package-lock.json",
  "tsconfig.base.json",
  "apps/core/scripts/construire.ts",
  "deploy/codecs/webp/SHA256SUMS",
  "deploy/codecs/webp/construire.sh",
];
const OPTIONNELS = ["pg-native", "bufferutil", "utf-8-validate"];
/** Codecs WebAssembly de libwebp construits par deploy/codecs/webp/construire.sh, livrés dans dist/webp pour le thread des images. */
const WEBP = {
  sources: path.join(RACINE, "packages", "images", "src", "webp"),
  empreintes: "deploy/codecs/webp/SHA256SUMS",
  script: path.join(RACINE, "deploy", "codecs", "webp", "construire.sh"),
} as const;
/** Ce que les .wasm de libwebp contiennent : textes à côté des .wasm, ou `depot` (apps/core/scripts/licences/). */
const LICENCES_WEBP: readonly { fichier: string; licence: string; objet: string; depot?: boolean }[] = [
  { fichier: "COPYING", licence: "BSD-3-Clause", objet: "libwebp, compiled to WebAssembly (dist/webp)" },
  { fichier: "PATENTS", licence: "BSD-3-Clause", objet: "libwebp, additional grant of patent rights" },
  {
    fichier: "emscripten.txt",
    depot: true,
    licence: "MIT",
    objet: "Emscripten system libraries, compiled into the .wasm (MIT option of MIT OR NCSA)",
  },
  {
    fichier: "musl.txt",
    depot: true,
    licence: "MIT",
    objet: "musl libc, compiled into the .wasm by Emscripten",
  },
  {
    fichier: "compiler-rt.txt",
    depot: true,
    licence: "Apache-2.0 WITH LLVM-exception",
    objet: "compiler-rt builtins (LLVM), compiled into the .wasm by Emscripten",
  },
  {
    fichier: "dlmalloc.txt",
    depot: true,
    licence: "",
    objet: "dlmalloc, the allocator compiled into the .wasm by Emscripten (public domain)",
  },
];
/** Code d'un paquet sous une autre licence que la sienne : texte (fichier du paquet, en-tête d'un .js, ou `depot` : apps/core/scripts/licences/), licence SPDX (vide : domaine public), objet. */
const LICENCES_INTERNES: Readonly<
  Record<string, readonly { fichier: string; licence: string; objet: string; depot?: boolean }[]>
> = {
  "jpeg-js": [
    { fichier: "lib/decoder.js", licence: "Apache-2.0", objet: "JPEG decoder, from pdf.js" },
    { fichier: "lib/encoder.js", licence: "BSD-3-Clause", objet: "JPEG encoder, from Adobe" },
  ],
};
const NOMS_LICENCE = /^(licen[cs]e|copying)([-._].*)?$/i;
const NOTICES = path.join(RACINE, "THIRD_PARTY_NOTICES.md");
const LICENCES_DEPOT = path.join(RACINE, "THIRD_PARTY_LICENSES", "npm-core.txt");
const DEBUT_TABLE = "<!-- npm-core : table écrite par `npm run licences`, ne pas modifier à la main -->";
const FIN_TABLE = "<!-- /npm-core -->";

export interface PaquetLivre {
  nom: string;
  version: string;
  licence: string;
  textes: string[];
}

export interface Construction {
  sortie: string;
  empreinte: string;
  sources: string[];
  paquets: PaquetLivre[];
}

/** Expression SPDX (parenthèses, AND prioritaire sur OR, WITH) satisfaite par des licences autorisées ; invalide = non conforme (`licence_conforme` du kit). */
export function licenceConforme(expression: string, autorisees: readonly string[]): boolean {
  const jetons = expression.match(/\(|\)|[^\s()]+/g) ?? [];
  if (!jetons.length) return false;
  let pos = 0;
  const atome = (): boolean => {
    const j = jetons[pos];
    if (j === "(") {
      pos += 1;
      const v = ou();
      if (jetons[pos] !== ")") throw new Error("parenthèse non fermée");
      pos += 1;
      return v;
    }
    if (j === undefined || [")", "AND", "OR", "WITH"].includes(j))
      throw new Error("expression SPDX invalide");
    pos += 1;
    if (jetons[pos] === "WITH") pos += 2;
    return autorisees.includes(j);
  };
  const et = (): boolean => {
    let v = atome();
    while (jetons[pos] === "AND") {
      pos += 1;
      v = atome() && v;
    }
    return v;
  };
  const ou = (): boolean => {
    let v = et();
    while (jetons[pos] === "OR") {
      pos += 1;
      v = et() || v;
    }
    return v;
  };
  try {
    return ou() && pos === jetons.length;
  } catch {
    return false;
  }
}

/** Licences admises pour un paquet livré (`politique.licences.livrees` de migration-kit/deps.map.json). */
export function licencesLivrees(): string[] {
  const carte = JSON.parse(readFileSync(path.join(RACINE, "migration-kit", "deps.map.json"), "utf-8")) as {
    politique: { licences: { livrees: string[] } };
  };
  return carte.politique.licences.livrees;
}

/** Dossier du paquet npm d'un fichier d'entrée (`node_modules/a/…`, `node_modules/@p/a/…`, imbrications comprises). */
export function dossierPaquet(entree: string): string | null {
  const marque = "node_modules/";
  const i = entree.lastIndexOf(marque);
  if (i < 0) return null;
  const parties = entree.slice(i + marque.length).split("/");
  const n = parties[0]?.startsWith("@") ? 2 : 1;
  if (parties.length <= n) return null;
  return entree.slice(0, i + marque.length) + parties.slice(0, n).join("/");
}

function licenceDe(champ: unknown): string {
  if (typeof champ === "string") return champ;
  if (champ && typeof champ === "object" && "type" in champ) return String((champ as { type: unknown }).type);
  if (Array.isArray(champ)) return champ.map(licenceDe).join(" OR ");
  return "";
}

function lireTexte(fichier: string): string {
  return readFileSync(fichier, "utf-8").replace(/\r\n?/g, "\n").trimEnd();
}

/** Texte de licence d'un fichier : en entier, ou pour un .js son premier commentaire de bloc qui porte un copyright. */
function texteInterne(fichier: string): string {
  const texte = lireTexte(fichier);
  if (!fichier.endsWith(".js")) return texte;
  const bloc = (texte.match(/\/\*[\s\S]*?\*\//g) ?? []).find((b) => /copyright/i.test(b));
  if (bloc === undefined) throw new Error(`${fichier} : en-tête de licence introuvable`);
  return bloc
    .replace(/^\/\*+\s*\n?/, "")
    .replace(/\s*\*+\/$/, "")
    .trimEnd();
}

/** Section « License » du README (jusqu'au titre suivant de même niveau), pour un paquet publié sans fichier de licence. */
export function sectionLicenceReadme(readme: string): string | null {
  const lignes = readme.replace(/\r\n?/g, "\n").split("\n");
  const debut = lignes.findIndex((l) => /^#{1,6}\s*licen[cs]e\b/i.test(l));
  if (debut < 0) return null;
  const niveau = /^#+/.exec(lignes[debut] ?? "")?.[0].length ?? 1;
  const suivant = lignes.findIndex(
    (l, i) => i > debut && (/^(#{1,6})\s/.exec(l)?.[1]?.length ?? 7) <= niveau,
  );
  return lignes
    .slice(debut, suivant < 0 ? lignes.length : suivant)
    .join("\n")
    .trim();
}

const PERMISSION_MIT = `Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`;

function auteur(champ: unknown): string {
  if (typeof champ === "string") return champ;
  if (champ && typeof champ === "object" && "name" in champ) return String((champ as { name: unknown }).name);
  return "";
}

/** Paquet npm d'un dossier : nom, version, licence SPDX (code interne sous une autre licence compris) et textes à livrer. */
export function lirePaquet(dossier: string): PaquetLivre {
  const meta = JSON.parse(readFileSync(path.join(dossier, "package.json"), "utf-8")) as Record<
    string,
    unknown
  >;
  const noms = readdirSync(dossier);
  const textes = noms
    .filter((n) => NOMS_LICENCE.test(n))
    .sort()
    .map((n) => lireTexte(path.join(dossier, n)));
  if (!textes.length) {
    const readme = noms.find((n) => /^readme(\.(md|markdown|txt))?$/i.test(n));
    const section = readme ? sectionLicenceReadme(lireTexte(path.join(dossier, readme))) : null;
    const signataire = auteur(meta["author"]);
    const mit = licenceDe(meta["license"]) === "MIT" && !section?.includes("Permission is hereby granted");
    textes.push(
      [
        "(no license file in the published package" +
          (section ? "; license section of its README below)" : ")"),
        ...(signataire ? [`Author (package.json): ${signataire}`] : []),
        ...(section ? ["", section] : []),
        ...(mit && signataire
          ? [
              "",
              "MIT License, as declared in package.json:",
              "",
              `Copyright (c) ${signataire}`,
              "",
              PERMISSION_MIT,
            ]
          : []),
      ].join("\n"),
    );
  }
  const nom = String(meta["name"]);
  let licence = licenceDe(meta["license"] ?? meta["licenses"]);
  for (const i of LICENCES_INTERNES[nom] ?? []) {
    if (i.licence && !licence.includes(i.licence))
      licence = `${/ OR /.test(licence) ? `(${licence})` : licence} AND ${i.licence}`;
    const texte = i.depot ? path.join(CORE, "scripts", "licences", i.fichier) : path.join(dossier, i.fichier);
    textes.push(
      `${i.objet} — ${path.relative(i.depot ? RACINE : dossier, texte)} — ${i.licence || "public domain"}:\n\n${texteInterne(texte)}`,
    );
  }
  return { nom, version: String(meta["version"]), licence, textes };
}

/** Fichiers du dépôt dont le bundle est fait (entrées du métafichier hors node_modules, leurs package.json, verrou npm, tsconfig, ce script). */
export function sourcesDuBundle(meta: Metafile): string[] {
  const fichiers = new Set(FICHIERS_CONSTRUCTION);
  for (const entree of Object.keys(meta.inputs)) {
    if (entree.includes("node_modules/") || !existsSync(path.join(RACINE, entree))) continue;
    fichiers.add(entree);
    const espace = /^((?:apps|packages)\/[^/]+)\//.exec(entree)?.[1];
    if (espace) fichiers.add(`${espace}/package.json`);
  }
  return [...fichiers].sort();
}

/** Paquets npm dont du code est réellement écrit dans les sorties (octets > 0), plus les modules natifs copiés à côté et ce qui y est compilé. */
export function paquetsLivres(meta: Metafile): PaquetLivre[] {
  const dossiers = new Set<string>();
  for (const sortie of Object.values(meta.outputs)) {
    for (const [entree, { bytesInOutput }] of Object.entries(sortie.inputs)) {
      const dossier = bytesInOutput > 0 ? dossierPaquet(entree) : null;
      if (dossier) dossiers.add(path.resolve(RACINE, dossier));
    }
  }
  const exiger = createRequire(path.join(CORE, "package.json"));
  for (const nom of NATIFS) {
    const natif = path.dirname(exiger.resolve(`${nom}/package.json`));
    dossiers.add(natif);
    const depuisNatif = createRequire(path.join(natif, "package.json"));
    for (const compile of COMPILES_DANS[nom] ?? [])
      dossiers.add(path.dirname(depuisNatif.resolve(`${compile}/package.json`)));
  }
  const paquets = new Map<string, PaquetLivre>();
  for (const dossier of dossiers) {
    const p = lirePaquet(dossier);
    paquets.set(`${p.nom}@${p.version}`, p);
  }
  return [...paquets.values()].sort((a, b) => (a.nom < b.nom ? -1 : a.nom > b.nom ? 1 : 0));
}

/** Refuse un paquet livré sans licence admise. */
export function verifierLicences(paquets: readonly PaquetLivre[], autorisees: readonly string[]): void {
  const refuses = paquets.filter((p) => !p.licence || !licenceConforme(p.licence, autorisees));
  if (refuses.length) {
    throw new Error(
      `licence hors politique pour un paquet livré : ${refuses.map((p) => `${p.nom}@${p.version} (${p.licence || "?"})`).join(", ")}`,
    );
  }
}

/** Textes des licences de tous les paquets livrés : `dist/LICENCES-TIERS.txt` et `THIRD_PARTY_LICENSES/npm-core.txt`. */
export function texteLicences(paquets: readonly PaquetLivre[]): string {
  const filet = "=".repeat(78);
  const blocs = paquets.map(
    (p) => `${filet}\n${p.nom} ${p.version} — ${p.licence}\n${filet}\n\n${p.textes.join("\n\n")}\n`,
  );
  return (
    "npm packages bundled in the Elpis TypeScript core (apps/core/dist): license text of each.\n" +
    "Generated by `npm run licences`; do not edit by hand.\n\n" +
    blocs.join("\n")
  );
}

/** Table Markdown des paquets livrés, entre les marques de THIRD_PARTY_NOTICES.md. */
export function tableLicences(paquets: readonly PaquetLivre[]): string {
  const lignes = paquets.map((p) => `| ${p.nom} | ${p.version} | ${p.licence} |`);
  return [DEBUT_TABLE, "", "| Package | Version | License |", "|---|---|---|", ...lignes, "", FIN_TABLE].join(
    "\n",
  );
}

/** Section des paquets livrés telle qu'elle figure dans THIRD_PARTY_NOTICES.md (vide si les marques manquent). */
export function tableDansNotices(texte: string): string {
  const debut = texte.indexOf(DEBUT_TABLE);
  const fin = texte.indexOf(FIN_TABLE);
  return debut >= 0 && fin > debut ? texte.slice(debut, fin + FIN_TABLE.length) : "";
}

/** Module natif dans `sortie/node_modules` : package.json, licences, lib et un binaire précompilé par cible. */
export function copierNatif(nom: string, sortie: string, cibles: readonly string[]): void {
  const source = path.dirname(createRequire(path.join(CORE, "package.json")).resolve(`${nom}/package.json`));
  const dest = path.join(sortie, "node_modules", nom);
  mkdirSync(path.join(dest, "prebuilds"), { recursive: true });
  for (const f of ["package.json", ...readdirSync(source).filter((n) => NOMS_LICENCE.test(n))]) {
    cpSync(path.join(source, f), path.join(dest, f));
  }
  cpSync(path.join(source, "lib"), path.join(dest, "lib"), { recursive: true });
  for (const cible of cibles) {
    const binaire = path.join(source, "prebuilds", `${cible}.node`);
    if (!existsSync(binaire)) throw new Error(`${nom} : pas de binaire précompilé pour ${cible}`);
    cpSync(binaire, path.join(dest, "prebuilds", `${cible}.node`));
  }
}

/** Fichiers des codecs WebP et leur empreinte attendue (deploy/codecs/webp/SHA256SUMS). */
function empreintesWebp(): [string, string][] {
  return readFileSync(path.join(RACINE, WEBP.empreintes), "utf-8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => {
      const [empreinte = "", fichier = ""] = l.trim().split(/\s+/);
      return [fichier, empreinte];
    });
}

/** Les .wasm de libwebp et ses licences dans `sortie/webp`, où le thread des images les cherche ; refusés s'ils diffèrent de SHA256SUMS. */
export function copierCodecsWebp(sortie: string): void {
  for (const [fichier, attendue] of empreintesWebp()) {
    const octets = readFileSync(path.join(WEBP.sources, fichier));
    if (createHash("sha256").update(octets).digest("hex") !== attendue)
      throw new Error(
        `codec WebP ${fichier} différent de ${WEBP.empreintes} : relancer deploy/codecs/webp/construire.sh`,
      );
    mkdirSync(path.dirname(path.join(sortie, "webp", fichier)), { recursive: true });
    writeFileSync(path.join(sortie, "webp", fichier), octets);
  }
}

/** libwebp livrée en WebAssembly, avec ce qu'Emscripten y compile ; version lue dans construire.sh. */
export function codecWebp(): PaquetLivre {
  const version = /^LIBWEBP_VERSION="([^"]+)"/m.exec(readFileSync(WEBP.script, "utf-8"))?.[1];
  if (version === undefined)
    throw new Error("version de libwebp absente de deploy/codecs/webp/construire.sh");
  const licences = [...new Set(LICENCES_WEBP.map((l) => l.licence).filter(Boolean))];
  const textes = LICENCES_WEBP.map((i) => {
    const texte = i.depot
      ? path.join(CORE, "scripts", "licences", i.fichier)
      : path.join(WEBP.sources, i.fichier);
    return `${i.objet} — ${path.relative(RACINE, texte)} — ${i.licence || "public domain"}:\n\n${texteInterne(texte)}`;
  });
  return { nom: "libwebp", version, licence: licences.join(" AND "), textes };
}

/** Construit dans un dossier voisin puis remplace `sortie` d'un coup : un échec laisse l'ancien bundle intact. */
export async function construire(
  sortie: string,
  cibles: readonly string[] = CIBLES,
  options: { licences?: readonly string[] } = {},
): Promise<Construction> {
  const inconnues = cibles.filter((c) => !CIBLES.includes(c));
  if (inconnues.length || !cibles.length)
    throw new Error(`cibles : ${CIBLES.join(", ")} (reçu : ${cibles.join(", ")})`);
  const provisoire = `${sortie}.construction-${process.pid}`;
  rmSync(provisoire, { recursive: true, force: true });
  try {
    const resultat = await build({
      absWorkingDir: RACINE,
      entryPoints: {
        main: path.join(CORE, "src", "main.ts"),
        exploitation: path.join(CORE, "src", "exploitation.ts"),
        pixels: path.join(RACINE, "packages", "images", "src", "pixels.ts"),
      },
      outdir: provisoire,
      outExtension: { ".js": ".mjs" },
      bundle: true,
      platform: "node",
      target: "node24",
      format: "esm",
      charset: "utf8",
      external: [...NATIFS, ...OPTIONNELS],
      banner: {
        js: 'import { createRequire as __elpisRequire } from "node:module"; const require = __elpisRequire(import.meta.url);',
      },
      sourcemap: "linked",
      sourcesContent: false,
      metafile: true,
      logLevel: "warning",
    });
    const paquets = [...paquetsLivres(resultat.metafile), codecWebp()].sort((a, b) =>
      a.nom < b.nom ? -1 : a.nom > b.nom ? 1 : 0,
    );
    verifierLicences(paquets, options.licences ?? licencesLivrees());
    for (const nom of NATIFS) copierNatif(nom, provisoire, cibles);
    copierCodecsWebp(provisoire);
    writeFileSync(path.join(provisoire, "LICENCES-TIERS.txt"), texteLicences(paquets));
    const sources = sourcesDuBundle(resultat.metafile);
    const empreinte = empreinteSources(RACINE, sources);
    const version = (
      JSON.parse(readFileSync(path.join(CORE, "package.json"), "utf-8")) as { version: string }
    ).version;
    writeFileSync(
      path.join(provisoire, "construction.json"),
      JSON.stringify({ version, empreinte, cibles: [...cibles], sources }, null, 2) + "\n",
    );
    const ancien = `${sortie}.ancien-${process.pid}`;
    if (existsSync(sortie)) renameSync(sortie, ancien);
    renameSync(provisoire, sortie);
    rmSync(ancien, { recursive: true, force: true });
    return { sortie, empreinte, sources, paquets };
  } catch (e) {
    rmSync(provisoire, { recursive: true, force: true });
    throw e;
  }
}

/** `--licences` : réécrit THIRD_PARTY_LICENSES/npm-core.txt et la table de THIRD_PARTY_NOTICES.md d'après les paquets livrés. */
export function ecrireLicencesDuDepot(paquets: readonly PaquetLivre[]): void {
  writeFileSync(LICENCES_DEPOT, texteLicences(paquets));
  const notices = readFileSync(NOTICES, "utf-8");
  const actuelle = tableDansNotices(notices);
  if (!actuelle) throw new Error(`marques ${DEBUT_TABLE} … ${FIN_TABLE} absentes de THIRD_PARTY_NOTICES.md`);
  writeFileSync(
    NOTICES,
    notices.replace(actuelle, () => tableLicences(paquets)),
  );
}

function options(argv: readonly string[]): { sortie: string; cibles: string[]; licences: boolean } {
  let sortie = path.join(CORE, "dist");
  const cibles: string[] = [];
  let licences = false;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--licences") licences = true;
    else if (a === "--sortie" && argv[i + 1]) sortie = path.resolve(argv[(i += 1)] ?? "");
    else if (a === "--cible" && argv[i + 1]) cibles.push(argv[(i += 1)] ?? "");
    else
      throw new Error(`usage : construire.ts [--sortie DOSSIER] [--cible ${CIBLES.join("|")}]… [--licences]`);
  }
  return { sortie, cibles: cibles.length ? cibles : [...CIBLES], licences };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  const o = options(process.argv.slice(2));
  const fait = await construire(o.sortie, o.cibles);
  if (o.licences) ecrireLicencesDuDepot(fait.paquets);
  process.stdout.write(
    `core construit dans ${path.relative(RACINE, fait.sortie) || fait.sortie} : ${fait.paquets.length} paquets npm livrés, ` +
      `cibles ${o.cibles.join(", ")}, empreinte ${fait.empreinte.slice(0, 12)}${o.licences ? " ; licences du dépôt réécrites" : ""}\n`,
  );
}
