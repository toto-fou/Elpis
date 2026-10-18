// SPDX-License-Identifier: MIT
/** apps/toolhost/src/lanceur.ts — arguments du lanceur (`toolhost/__main__.py`) et niveau du journal. */
import type { Niveau } from "@elpis/http";

/** `_parse_families` : `--families a,b`, `--family a`, `--families=a,b` ; `null` si absent. */
export function parseFamiliesArgv(argv: readonly string[]): string | null {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? "";
    for (const drapeau of ["--families", "--family"]) {
      if (a === drapeau && i + 1 < argv.length) {
        out.push(argv[i + 1] ?? "");
        i++;
        break;
      }
      if (a.startsWith(drapeau + "=")) {
        out.push(a.slice(drapeau.length + 1));
        break;
      }
    }
  }
  return out.length ? out.filter((x) => x.trim()).join(",") : null;
}

const NIVEAUX: Readonly<Record<string, Niveau>> = {
  trace: "trace",
  debug: "debug",
  info: "info",
  warning: "warn",
  error: "error",
  critical: "fatal",
};

/** `TOOLHOST_LOG_LEVEL` (noms d'uvicorn) ; `null` s'il est absent ou inconnu. */
export function niveauDuJournal(brut: string | undefined): Niveau | null {
  return NIVEAUX[(brut ?? "").trim().toLowerCase()] ?? null;
}
