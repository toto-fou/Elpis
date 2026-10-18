// SPDX-License-Identifier: MIT
/** apps/toolhost/scripts/construire.ts — bundle de production de l'hôte d'outils (dist/main.mjs, threads dist/pixels.mjs avec ses codecs WebAssembly et dist/calcul-fil.mjs) : paquets livrés sous licence admise, textes dans LICENSES/npm-toolhost.txt (écrit par `npm run licences`), modules natifs (better-sqlite3, node-pty) copiés à côté pour la cible. */
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

import {
  CIBLES,
  codecWebp,
  COMPILES_DANS,
  copierCodecsWebp,
  copierNatif,
  dossierPaquet,
  licenceConforme,
  licencesLivrees,
  lirePaquet,
  NATIFS,
  RACINE,
} from "../../core/scripts/construire";
import type { PaquetLivre } from "../../core/scripts/construire";
import { empreinteSources } from "@elpis/commun/empreinte";

const HOTE = path.join(RACINE, "apps", "toolhost");
const LICENCES_DEPOT = path.join(RACINE, "LICENSES", "npm-toolhost.txt");
const NOTICES = path.join(RACINE, "THIRD_PARTY_NOTICES.md");
const DEBUT_TABLE = "<!-- npm-toolhost : table écrite par `npm run licences`, ne pas modifier à la main -->";
const FIN_TABLE = "<!-- /npm-toolhost -->";
const FICHIERS_CONSTRUCTION = [
  "package.json",
  "package-lock.json",
  "tsconfig.base.json",
  "apps/core/scripts/construire.ts",
  "apps/toolhost/scripts/construire.ts",
];
/** Modules facultatifs de ws et de pg, jamais livrés (repli en JavaScript). */
const OPTIONNELS = ["bufferutil", "utf-8-validate", "pg-native"];
/** Natifs de l'hôte : ceux du core (base) et node-pty (terminal), avec ce qui est compilé dans leur binaire. */
const NATIFS_HOTE = [...NATIFS, "node-pty"];
const COMPILES_HOTE: Readonly<Record<string, readonly string[]>> = {
  ...COMPILES_DANS,
  "node-pty": ["node-addon-api"],
};
const NOMS_LICENCE = /^(licen[cs]e|copying)([-._].*)?$/i;
/** Cible de la machine de construction : node-pty n'a pas de binaire Linux publié, `npm ci` le compile pour elle seule. */
export const CIBLE_LOCALE = `${process.platform}-${process.arch}`;
const FILET = "=".repeat(78);

export type PaquetHote = PaquetLivre;

export interface ConstructionHote {
  sortie: string;
  empreinte: string;
  sources: string[];
  paquets: PaquetHote[];
}

/** Paquets npm dont du code est écrit dans le bundle (octets > 0), plus les modules natifs copiés à côté et ce qui y est compilé, lus comme ceux du core (licence, textes). */
export function paquetsDuBundle(meta: Metafile): PaquetHote[] {
  const dossiers = new Set<string>();
  for (const sortie of Object.values(meta.outputs))
    for (const [entree, { bytesInOutput }] of Object.entries(sortie.inputs)) {
      const d = bytesInOutput > 0 ? dossierPaquet(entree) : null;
      if (d) dossiers.add(path.resolve(RACINE, d));
    }
  const exiger = createRequire(path.join(HOTE, "package.json"));
  for (const nom of NATIFS_HOTE) {
    const natif = path.dirname(exiger.resolve(`${nom}/package.json`));
    dossiers.add(natif);
    const depuisNatif = createRequire(path.join(natif, "package.json"));
    for (const compile of COMPILES_HOTE[nom] ?? [])
      dossiers.add(path.dirname(depuisNatif.resolve(`${compile}/package.json`)));
  }
  const paquets = new Map<string, PaquetHote>();
  for (const d of dossiers) {
    const p = lirePaquet(d);
    paquets.set(`${p.nom}@${p.version}`, p);
  }
  return [...paquets.values()].sort((a, b) => (a.nom < b.nom ? -1 : a.nom > b.nom ? 1 : 0));
}

/** node-pty à côté du bundle : package.json, licence, JavaScript (`lib/`) et `prebuilds/<cible>/pty.node`, pris dans les prébuilds du paquet ou, pour la cible de la machine, dans sa compilation par `npm ci` (`build/Release`). */
function copierNodePty(sortie: string, cibles: readonly string[]): void {
  const source = path.dirname(
    createRequire(path.join(HOTE, "package.json")).resolve("node-pty/package.json"),
  );
  const dest = path.join(sortie, "node_modules", "node-pty");
  mkdirSync(dest, { recursive: true });
  for (const f of ["package.json", ...readdirSync(source).filter((n) => NOMS_LICENCE.test(n))])
    cpSync(path.join(source, f), path.join(dest, f));
  cpSync(path.join(source, "lib"), path.join(dest, "lib"), { recursive: true });
  for (const cible of cibles) {
    const binaire = [
      path.join(source, "prebuilds", cible, "pty.node"),
      ...(cible === CIBLE_LOCALE ? [path.join(source, "build", "Release", "pty.node")] : []),
    ].find((f) => existsSync(f));
    if (binaire === undefined)
      throw new Error(
        `node-pty : pas de binaire précompilé pour ${cible} (construire le bundle sur une machine ${cible} : npm ci y compile node-pty)`,
      );
    mkdirSync(path.join(dest, "prebuilds", cible), { recursive: true });
    cpSync(binaire, path.join(dest, "prebuilds", cible, "pty.node"));
  }
}

/** LICENSES/npm-toolhost.txt : texte de licence de chaque paquet du bundle de l'hôte. */
export function texteLicencesDepot(paquets: readonly PaquetHote[]): string {
  const blocs = paquets.map(
    (p) => `${FILET}\n${p.nom} ${p.version} — ${p.licence}\n${FILET}\n\n${p.textes.join("\n\n")}\n`,
  );
  return (
    "npm packages bundled in the Elpis TypeScript tool host (apps/toolhost/dist): license text of each.\n" +
    "Generated by `npm run licences`; do not edit by hand.\n\n" +
    blocs.join("\n")
  );
}

/** Table Markdown des paquets de l'hôte, entre ses marques de THIRD_PARTY_NOTICES.md. */
export function tableLicencesHote(paquets: readonly PaquetHote[]): string {
  const lignes = paquets.map((p) => `| ${p.nom} | ${p.version} | ${p.licence} |`);
  return [DEBUT_TABLE, "", "| Package | Version | License |", "|---|---|---|", ...lignes, "", FIN_TABLE].join(
    "\n",
  );
}

/** Section de l'hôte telle qu'elle figure dans THIRD_PARTY_NOTICES.md (vide si les marques manquent). */
export function tableHoteDansNotices(texte: string): string {
  const debut = texte.indexOf(DEBUT_TABLE);
  const fin = texte.indexOf(FIN_TABLE);
  return debut >= 0 && fin > debut ? texte.slice(debut, fin + FIN_TABLE.length) : "";
}

/** `--licences` : réécrit LICENSES/npm-toolhost.txt et la table de l'hôte dans THIRD_PARTY_NOTICES.md. */
export function ecrireLicencesHote(paquets: readonly PaquetHote[]): void {
  writeFileSync(LICENCES_DEPOT, texteLicencesDepot(paquets));
  const notices = readFileSync(NOTICES, "utf-8");
  const actuelle = tableHoteDansNotices(notices);
  if (!actuelle) throw new Error(`marques ${DEBUT_TABLE} … ${FIN_TABLE} absentes de THIRD_PARTY_NOTICES.md`);
  writeFileSync(
    NOTICES,
    notices.replace(actuelle, () => tableLicencesHote(paquets)),
  );
}

/** Blocs de LICENSES/npm-core.txt par `nom version` : un titre encadré de deux filets ouvre un bloc (un texte de licence peut contenir un filet). */
export function blocsDeLicence(texte: string): Map<string, string> {
  const blocs = new Map<string, string>();
  const debuts = [...texte.matchAll(new RegExp(`^${FILET}\\n([^\\n]+ — [^\\n]*)\\n${FILET}\\n`, "gmu"))];
  debuts.forEach((m, i) => {
    const cle = (m[1] ?? "").split(" — ")[0] ?? "";
    blocs.set(cle, texte.slice(m.index, debuts[i + 1]?.index ?? texte.length));
  });
  return blocs;
}

/** Licence admise et texte déjà au dépôt (`npm run licences` l'y fait entrer) ; `ecrire` : textes lus des paquets eux-mêmes. */
export function texteLicencesHote(
  paquets: readonly PaquetHote[],
  autorisees: readonly string[],
  ecrire = false,
): string {
  const refus = paquets.filter((p) => !p.licence || !licenceConforme(p.licence, autorisees));
  if (refus.length)
    throw new Error(`licence hors politique : ${refus.map((p) => `${p.nom}@${p.version}`).join(", ")}`);
  if (ecrire) return texteLicencesDepot(paquets);
  const blocs = blocsDeLicence(existsSync(LICENCES_DEPOT) ? readFileSync(LICENCES_DEPOT, "utf-8") : "");
  const absents = paquets.filter((p) => !blocs.has(`${p.nom} ${p.version}`));
  if (absents.length)
    throw new Error(
      `paquets absents de LICENSES/npm-toolhost.txt (lancer npm run licences) : ${absents.map((p) => `${p.nom}@${p.version}`).join(", ")}`,
    );
  return (
    "npm packages bundled in the Elpis TypeScript tool host (apps/toolhost/dist): license text of each.\n" +
    "Generated by apps/toolhost/scripts/construire.ts from LICENSES/npm-toolhost.txt; do not edit by hand.\n\n" +
    paquets.map((p) => blocs.get(`${p.nom} ${p.version}`)).join("")
  );
}

/** Construit dans un dossier voisin puis remplace `sortie` d'un coup : un échec laisse l'ancien bundle intact. */
export async function construireHote(
  sortie: string,
  options: { licences?: readonly string[]; ecrireLicences?: boolean; cibles?: readonly string[] } = {},
): Promise<ConstructionHote> {
  const cibles = options.cibles ?? [CIBLE_LOCALE];
  const inconnues = cibles.filter((c) => !CIBLES.includes(c));
  if (inconnues.length || !cibles.length)
    throw new Error(`cibles : ${CIBLES.join(", ")} (reçu : ${cibles.join(", ")})`);
  const provisoire = `${sortie}.construction-${process.pid}`;
  rmSync(provisoire, { recursive: true, force: true });
  try {
    const resultat = await build({
      absWorkingDir: RACINE,
      entryPoints: {
        main: path.join(HOTE, "src", "main.ts"),
        pixels: path.join(RACINE, "packages", "images", "src", "pixels.ts"),
        "calcul-fil": path.join(HOTE, "src", "fichiers", "calcul-fil.ts"),
      },
      outdir: provisoire,
      outExtension: { ".js": ".mjs" },
      bundle: true,
      platform: "node",
      target: "node24",
      format: "esm",
      charset: "utf8",
      external: [...NATIFS_HOTE, ...OPTIONNELS],
      banner: {
        js: 'import { createRequire as __elpisRequire } from "node:module"; const require = __elpisRequire(import.meta.url);',
      },
      sourcemap: "linked",
      sourcesContent: false,
      metafile: true,
      logLevel: "warning",
    });
    copierCodecsWebp(provisoire);
    const paquets = [...paquetsDuBundle(resultat.metafile), codecWebp()];
    writeFileSync(
      path.join(provisoire, "LICENCES-TIERS.txt"),
      texteLicencesHote(paquets, options.licences ?? licencesLivrees(), options.ecrireLicences ?? false),
    );
    for (const nom of NATIFS) copierNatif(nom, provisoire, cibles);
    copierNodePty(provisoire, cibles);
    const sources = new Set(FICHIERS_CONSTRUCTION);
    for (const entree of Object.keys(resultat.metafile.inputs)) {
      if (entree.includes("node_modules/") || !existsSync(path.join(RACINE, entree))) continue;
      sources.add(entree);
      const espace = /^((?:apps|packages)\/[^/]+)\//.exec(entree)?.[1];
      if (espace) sources.add(`${espace}/package.json`);
    }
    const liste = [...sources].sort();
    const empreinte = empreinteSources(RACINE, liste);
    const version = (
      JSON.parse(readFileSync(path.join(HOTE, "package.json"), "utf-8")) as { version: string }
    ).version;
    writeFileSync(
      path.join(provisoire, "construction.json"),
      JSON.stringify({ version, empreinte, cibles: [...cibles], sources: liste }, null, 2) + "\n",
    );
    const ancien = `${sortie}.ancien-${process.pid}`;
    if (existsSync(sortie)) renameSync(sortie, ancien);
    try {
      renameSync(provisoire, sortie);
    } catch (e) {
      if (existsSync(ancien)) renameSync(ancien, sortie);
      throw e;
    }
    rmSync(ancien, { recursive: true, force: true });
    return { sortie, empreinte, sources: liste, paquets };
  } catch (e) {
    rmSync(provisoire, { recursive: true, force: true });
    throw e;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  const argv = process.argv.slice(2);
  let sortie = path.join(HOTE, "dist");
  const cibles: string[] = [];
  let licences = false;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--licences") licences = true;
    else if (argv[i] === "--sortie" && argv[i + 1]) sortie = path.resolve(argv[(i += 1)] ?? "");
    else if (argv[i] === "--cible" && argv[i + 1]) cibles.push(argv[(i += 1)] ?? "");
    else
      throw new Error(`usage : construire.ts [--sortie DOSSIER] [--cible ${CIBLES.join("|")}]… [--licences]`);
  }
  const fait = await construireHote(sortie, {
    ecrireLicences: licences,
    ...(cibles.length ? { cibles } : {}),
  });
  if (licences) ecrireLicencesHote(fait.paquets);
  process.stdout.write(
    `hôte d'outils construit dans ${path.relative(RACINE, fait.sortie) || fait.sortie} : ${fait.paquets.length} paquets npm livrés, ` +
      `cibles ${(cibles.length ? cibles : [CIBLE_LOCALE]).join(", ")}, empreinte ${fait.empreinte.slice(0, 12)}` +
      `${licences ? " ; licences du dépôt réécrites" : ""}\n`,
  );
}
