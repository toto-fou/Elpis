// SPDX-License-Identifier: MIT
/** packages/bac/src/bwrap.ts — prison `bubblewrap` des commandes que l'hôte lance sur des données du bac (sandbox/bwrap.py) : tout désolidarisé, `/usr` en lecture seule, `/tmp` vide. */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

import { journalDe, stripPy, suffixePy } from "@elpis/commun";

import { decoderRemplace, which } from "./docker";

const TTL_S = 600;
let sonde: { a: number; ok: boolean; bin: string } = { a: 0, ok: false, bin: "" };
let enCours: Promise<boolean> | null = null;

/** `base_argv` : options communes, sans le binaire ni la commande (`/bin`, `/lib`… liens vers `/usr`). */
export function baseArgv(): string[] {
  return [
    "--unshare-all",
    "--die-with-parent",
    "--new-session",
    "--cap-drop",
    "ALL",
    "--ro-bind",
    "/usr",
    "/usr",
    "--symlink",
    "usr/bin",
    "/bin",
    "--symlink",
    "usr/lib",
    "/lib",
    "--symlink",
    "usr/lib64",
    "/lib64",
    "--symlink",
    "usr/sbin",
    "/sbin",
    "--proc",
    "/proc",
    "--dev",
    "/dev",
    "--tmpfs",
    "/tmp",
  ];
}

/** Lance `bwrap … /usr/bin/true` (5 s) : vrai si le code de sortie est 0. */
function essayer(chemin: string): Promise<boolean> {
  return new Promise((ok) => {
    const p = spawn(chemin, [...baseArgv(), "/usr/bin/true"], {
      stdio: ["ignore", "ignore", "pipe"],
      env: { PATH: "/usr/bin:/bin" },
      timeout: 5_000,
      killSignal: "SIGKILL",
    });
    const erreur: Buffer[] = [];
    p.stderr.on("data", (b: Buffer) => erreur.push(b));
    p.once("error", (e) => {
      journalDe("sandbox").warn(`[bwrap] sonde échouée : ${e.message}`);
      ok(false);
    });
    p.once("close", (code, signal) => {
      if (code === 0) return ok(true);
      if (signal) journalDe("sandbox").warn(`[bwrap] sonde échouée : délai de 5 s dépassé`);
      else
        journalDe("sandbox").warn(
          `[bwrap] inutilisable : ${suffixePy(stripPy(decoderRemplace(Buffer.concat(erreur))), 200)}`,
        );
      ok(false);
    });
  });
}

/** `probe` : bwrap utilisable ici (installé, espaces de noms permis) ; verdict gardé 10 min par processus. */
export async function probe(force = false): Promise<boolean> {
  const maintenant = performance.now() / 1000;
  if (!force && sonde.bin && maintenant - sonde.a < TTL_S) return sonde.ok;
  if (enCours !== null) return enCours;
  enCours = (async () => {
    const chemin = which("bwrap") ?? "";
    const ok = chemin !== "" && existsSync("/usr/bin/true") ? await essayer(chemin) : false;
    sonde = { a: maintenant, ok, bin: chemin || "absent" };
    return ok;
  })();
  try {
    return await enCours;
  } finally {
    enCours = null;
  }
}

/** `binary` : chemin de bwrap après `probe` (`""` s'il est absent). */
export function binary(): string {
  return sonde.bin === "absent" ? "" : sonde.bin;
}
