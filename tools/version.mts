#!/usr/bin/env node
// SPDX-License-Identifier: MIT
/** tools/version.mts — version unique du produit : `npm run bump -- X.Y.Z` la recopie partout et coupe le CHANGELOG, `--check` vérifie que tout s'accorde, `--align` réaligne sans couper. */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const RACINE = fileURLToPath(new URL("..", import.meta.url));
const FORME = /^\d+\.\d+\.\d+$/;
const NOMBRE = String.raw`(\d+\.\d+\.\d+)`;
const VERROUS = ["package-lock.json", "browser-service/package-lock.json", "tools/demo/package-lock.json"];
/** Fichiers hors npm qui portent la version : un seul motif chacun, capture = la version. */
const TEXTES: readonly (readonly [string, RegExp])[] = [
  ["pyproject.toml", new RegExp(String.raw`^version = "${NOMBRE}"$`, "m")],
  ["rag_app/app.py", new RegExp(String.raw`^VERSION = "${NOMBRE}"$`, "m")],
  ["desktop-agent/elpis_auto/session.py", new RegExp(String.raw`^__version__ = "${NOMBRE}"$`, "m")],
  ["apps/core/src/familles/interface.ts", new RegExp(String.raw`version: "${NOMBRE}"`)],
  ["frontend/src/app/racine/racine.ts", new RegExp(String.raw`version: "${NOMBRE}"`)],
  ["frontend/src/features/admin/config.ts", new RegExp(String.raw`version: "${NOMBRE}"`)],
  ["frontend/src/components/admin/PageGeneral.vue", new RegExp(String.raw`placeholder="${NOMBRE}"`)],
  ["frontend/src/features/auth/auth.ts", new RegExp(String.raw`ou\(a\.version, "${NOMBRE}"\)`)],
];

type Paquet = { version?: string } & Record<string, unknown>;
type Verrou = { version?: string; packages: Record<string, Paquet> };

const lire = (f: string): string => readFileSync(join(RACINE, f), "utf8");
const ecrire = (f: string, s: string): void => writeFileSync(join(RACINE, f), s);

/** Les package.json suivis par git (racine, workspaces, service navigateur, démo). */
function paquets(): string[] {
  const sortie = execFileSync("git", ["ls-files", "*package.json"], { cwd: RACINE, encoding: "utf8" });
  return sortie.split("\n").filter((f) => f.endsWith("package.json"));
}

/** `a` > `b` en semver X.Y.Z. */
function plusRecente(a: string, b: string): boolean {
  const [x, y] = [a, b].map((v) => v.split(".").map(Number));
  for (let i = 0; i < 3; i++) if (x![i] !== y![i]) return x![i]! > y![i]!;
  return false;
}

/** Chaque emplacement et la version qu'il porte (`null` : motif introuvable). */
function releve(): [string, string | null][] {
  const out: [string, string | null][] = [];
  for (const f of paquets()) {
    const s = lire(f);
    out.push([f, (JSON.parse(s) as Paquet).version ?? null]);
    for (const m of s.matchAll(new RegExp(String.raw`"(@elpis/[a-z0-9-]+)": "${NOMBRE}"`, "g")))
      out.push([`${f} ${m[1]}`, m[2]!]);
  }
  for (const f of VERROUS) {
    const v = JSON.parse(lire(f)) as Verrou;
    out.push([f, v.version ?? null]);
    for (const [k, p] of Object.entries(v.packages)) {
      if (!k.includes("node_modules/") && p.version !== undefined) out.push([`${f} "${k}"`, p.version]);
      for (const champ of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
        const deps = (p[champ] ?? {}) as Record<string, string>;
        for (const [d, ver] of Object.entries(deps))
          if (d.startsWith("@elpis/")) out.push([`${f} "${k}" ${d}`, ver]);
      }
    }
  }
  for (const [f, motif] of TEXTES) out.push([f, motif.exec(lire(f))?.[1] ?? null]);
  return out;
}

/** Écrit `version` à chaque emplacement. */
function appliquer(version: string): void {
  for (const f of paquets()) {
    const s = lire(f)
      .replace(/^(\s*"version": )"[^"]*"/m, `$1"${version}"`)
      .replace(new RegExp(String.raw`("@elpis/[a-z0-9-]+": )"${NOMBRE}"`, "g"), `$1"${version}"`);
    ecrire(f, s);
  }
  for (const f of VERROUS) {
    const v = JSON.parse(lire(f)) as Verrou;
    v.version = version;
    for (const [k, p] of Object.entries(v.packages)) {
      if (!k.includes("node_modules/") && p.version !== undefined) p.version = version;
      for (const champ of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
        const deps = p[champ] as Record<string, string> | undefined;
        for (const d of Object.keys(deps ?? {})) if (d.startsWith("@elpis/")) deps![d] = version;
      }
    }
    ecrire(f, JSON.stringify(v, null, 2) + "\n");
  }
  for (const [f, motif] of TEXTES) {
    const s = lire(f);
    const m = motif.exec(s);
    if (!m) throw new Error(`${f} : version introuvable`);
    ecrire(f, s.slice(0, m.index) + m[0].replace(m[1]!, version) + s.slice(m.index + m[0].length));
  }
}

/** `--check` : tout égal à la racine, et une section du CHANGELOG pour cette version. */
function verifier(): number {
  const attendue = (JSON.parse(lire("package.json")) as Paquet).version ?? "";
  const ecarts = releve().filter(([, v]) => v !== attendue);
  for (const [ou, v] of ecarts) console.error(`${ou} : ${v ?? "introuvable"} au lieu de ${attendue}`);
  const section = new RegExp(String.raw`^## ${attendue.replaceAll(".", "\\.")} — `, "m").test(
    lire("CHANGELOG.md"),
  );
  if (!section) console.error(`CHANGELOG.md : pas de section « ## ${attendue} — »`);
  if (ecarts.length || !section) return 1;
  console.log(`version ${attendue} : ${releve().length} emplacements d'accord`);
  return 0;
}

function principal(args: string[]): number {
  if (args[0] === "--check") return verifier();
  const actuelle = (JSON.parse(lire("package.json")) as Paquet).version ?? "";
  if (args[0] === "--align") {
    appliquer(actuelle);
    return verifier();
  }
  const cible = args[0] ?? "";
  if (!FORME.test(cible)) {
    console.error("usage : npm run bump -- X.Y.Z [--date AAAA-MM-JJ] [--stable] | --check | --align");
    return 2;
  }
  if (!plusRecente(cible, actuelle)) {
    console.error(`${cible} n'est pas plus récente que ${actuelle}`);
    return 2;
  }
  if (Number(cible.split(".")[0]) >= 1 && Number(actuelle.split(".")[0]) < 1 && !args.includes("--stable")) {
    console.error("1.0.0 et au-delà : version stable, décidée par le mainteneur (ajouter --stable)");
    return 2;
  }
  const i = args.indexOf("--date");
  const date = i >= 0 ? (args[i + 1] ?? "") : new Date().toISOString().slice(0, 10);
  const journal = lire("CHANGELOG.md");
  const debut = journal.indexOf("\n## Unreleased\n");
  const suite = journal.indexOf("\n## ", debut + 1);
  if (debut < 0 || !/^(### |- )/m.test(journal.slice(debut + 15, suite < 0 ? undefined : suite))) {
    console.error("CHANGELOG.md : la section « ## Unreleased » est absente ou vide");
    return 2;
  }
  appliquer(cible);
  ecrire("CHANGELOG.md", journal.replace("\n## Unreleased\n", `\n## Unreleased\n\n## ${cible} — ${date}\n`));
  return verifier();
}

process.exitCode = principal(process.argv.slice(2));
