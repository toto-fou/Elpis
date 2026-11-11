// SPDX-License-Identifier: MIT
/** vitest.garde-travail.mts — invariant 9 : le code de l'hôte (apps/*\/src, packages/*\/src) ne touche jamais au contenu d'un /work de bac (`<P>/work`), seul l'agent du bac le fait ; chaque test qui le viole échoue. */
import { createRequire, syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, afterEach } from "vitest";

const exiger = createRequire(import.meta.url);
const fs = exiger("node:fs") as Record<string, unknown> & {
  promises: Record<string, unknown>;
  constants: { O_DIRECTORY: number };
};
const lienOriginal = fs["readlinkSync"] as (p: string) => string;
const RACINE = path.dirname(fileURLToPath(import.meta.url));
const ICI = fileURLToPath(import.meta.url);
/** Dossiers où vivent le dépôt et les essais : un `work` au-dessus d'eux (runner de la CI) n'est pas un bac. */
const ANCRAGES = [RACINE, tmpdir()];

/** Primitives par descripteurs (aucun lien suivi) : l'accès est imputé à leur appelant. */
export const PRIMITIVES: ReadonlySet<string> = new Set(["packages/securite/src/confinement.ts"]);

/** Exceptions de l'hôte, comme le Python (L4.6) : source → opérations permises et raison. */
export const EXCEPTIONS: Readonly<
  Record<string, { readonly ops: readonly string[]; readonly raison: string }>
> = {
  "packages/bac/src/travail.ts": {
    ops: ["mkdir", "rename"],
    raison: "création de P/work et migration de l'ancienne disposition à plat, avant tout usage du conteneur",
  },
  "packages/bac/src/conteneur.ts": {
    ops: ["mkdir"],
    raison: "création de P/work avant le démarrage du conteneur",
  },
  "packages/bac/src/usage.ts": {
    ops: ["readdir"],
    raison: "occupation (du) : noms et métadonnées, liens non suivis",
  },
  "apps/core/src/administration/executeurs.ts": {
    ops: ["readdir"],
    raison: "dernière activité (arrêt des conteneurs inactifs) : mtime des journaux de .bg, liens non suivis",
  },
  "packages/bac/src/suppression.ts": {
    ops: ["readdir", "open-dossier", "unlink", "rmdir"],
    raison:
      "suppression d'un compte (console, hôte d'outils) : /work vidé par descripteurs (supprimerArbreSous), sinon par le root du conteneur",
  },
};

/** Opérations sur un chemin : nom → positions des arguments chemin. */
const OPERATIONS: Readonly<Record<string, readonly number[]>> = {
  open: [0],
  readFile: [0],
  writeFile: [0],
  appendFile: [0],
  readdir: [0],
  opendir: [0],
  rm: [0],
  rmdir: [0],
  cp: [0, 1],
  copyFile: [0, 1],
  rename: [0, 1],
  unlink: [0],
  chmod: [0],
  chown: [0],
  lchown: [0],
  mkdir: [0],
  symlink: [1],
  link: [0, 1],
  truncate: [0],
  utimes: [0],
  mkdtemp: [0],
  createReadStream: [0],
  createWriteStream: [0],
  openAsBlob: [0],
  realpath: [0],
  readlink: [0],
  watch: [0],
  watchFile: [0],
};

const violations: string[] = [];
/** Appels faits par Node lui-même au sein d'une opération déjà relevée (readFileSync → openSync). */
let imbrication = 0;

/** Chemin absolu réel d'un argument ; `/proc/self/fd/N/…` ramené au dossier du descripteur. */
function enChemin(arg: unknown): string | null {
  let p: string;
  if (typeof arg === "string") p = path.resolve(arg);
  else if (arg instanceof URL && arg.protocol === "file:") p = fileURLToPath(arg);
  else if (Buffer.isBuffer(arg)) p = path.resolve(arg.toString());
  else return null;
  const m = /^\/proc\/self\/fd\/(\d+)(\/.*)?$/.exec(p);
  if (!m) return p;
  try {
    return path.join(lienOriginal(`/proc/self/fd/${m[1]}`), m[2] ?? "");
  } catch {
    return null;
  }
}

/** `<P>/work` qui contient `chemin` (lui compris), ou `null` ; un `work` au-dessus d'un ancrage n'en est pas un. */
export function racineTravail(chemin: string, ancrages: readonly string[] = ANCRAGES): string | null {
  for (let d = chemin; path.dirname(d) !== d; d = path.dirname(d))
    if (path.basename(d) === "work" && !ancrages.some((a) => a.startsWith(d + path.sep))) return d;
  return null;
}

/** Premier appelant hors de ce fichier, de Node et des primitives : source de production (`apps|packages/<x>/src/…`) ou `null`. */
function appelantProduction(): string | null {
  const limite = Error.stackTraceLimit;
  Error.stackTraceLimit = Infinity;
  const pile = new Error().stack ?? "";
  Error.stackTraceLimit = limite;
  for (const ligne of pile.split("\n").slice(2)) {
    const m = /\(?(?:file:\/\/)?(\/[^():]+):\d+:\d+\)?$/.exec(ligne.trim());
    if (!m?.[1] || m[1].includes("/node_modules/") || m[1] === ICI) continue;
    const rel = path.relative(RACINE, m[1]);
    if (PRIMITIVES.has(rel)) continue;
    return /^(apps|packages)\/[^/]+\/src\//.test(rel) ? rel : null;
  }
  return null;
}

function noter(nom: string, args: readonly unknown[], positions: readonly number[]): void {
  const op =
    nom === "open" && typeof args[1] === "number" && (args[1] & fs.constants.O_DIRECTORY) !== 0
      ? "open-dossier"
      : nom;
  for (const i of positions) {
    const chemin = enChemin(args[i]);
    const travail = chemin === null ? null : racineTravail(chemin);
    if (travail === null) continue;
    const source = appelantProduction();
    if (source !== null && !EXCEPTIONS[source]?.ops.includes(op))
      violations.push(`${source} : ${op}(${chemin}) sous ${travail}`);
  }
}

function envelopper(
  cible: Record<string, unknown>,
  nom: string,
  op: string,
  positions: readonly number[],
): void {
  const original = cible[nom];
  if (typeof original !== "function") return;
  const enveloppe = (f: (...a: unknown[]) => unknown) =>
    function (this: unknown, ...args: unknown[]) {
      if (imbrication === 0) noter(op, args, positions);
      imbrication++;
      try {
        return f.apply(this, args);
      } finally {
        imbrication--;
      }
    };
  const natif = (original as { native?: unknown }).native;
  cible[nom] = Object.assign(
    enveloppe(original as (...a: unknown[]) => unknown),
    typeof natif === "function" ? { native: enveloppe(natif as (...a: unknown[]) => unknown) } : {},
  );
}

for (const [op, positions] of Object.entries(OPERATIONS)) {
  envelopper(fs, op, op, positions);
  envelopper(fs, `${op}Sync`, op, positions);
  envelopper(fs.promises, op, op, positions);
}
syncBuiltinESMExports();

/** Relevés en attente (essais de la garde elle-même), vidés. */
export function releverViolations(): string[] {
  return violations.splice(0);
}

function echouerSiViolation(): void {
  const liste = releverViolations();
  if (liste.length > 0)
    throw new Error(
      `invariant 9 : accès de l'hôte au contenu d'un /work hors de l'agent :\n${liste.join("\n")}`,
    );
}

afterEach(echouerSiViolation);
afterAll(echouerSiViolation);
