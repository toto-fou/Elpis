// SPDX-License-Identifier: MIT
/** apps/core/test/identite/pki-openssl.ts — autorités et certificats de test jetables générés par la commande openssl (noms, validité et autorité au choix). */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface Autorite {
  readonly cert: string;
  readonly cle: string;
  readonly dossier: string;
}
export interface Feuille {
  readonly cert: string;
  readonly cle: string;
}
export interface OptionsFeuille {
  /** Noms DNS du certificat ; le premier sert de sujet. */
  readonly noms?: readonly string[];
  readonly ips?: readonly string[];
  readonly avant?: string;
  readonly apres?: string;
  readonly jours?: number;
}

export const OPENSSL_DISPONIBLE = spawnSync("openssl", ["version"]).status === 0;

function openssl(dossier: string, ...args: string[]): void {
  const r = spawnSync("openssl", args, { cwd: dossier, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`openssl ${args[0]} : ${r.stderr}`);
}

let compteur = 0;

/** Autorité racine EC P-256 (nom unique par appel) dans son propre dossier jetable. */
export function creerAutorite(nom: string): Autorite {
  const dossier = mkdtempSync(join(tmpdir(), "elpis-pki-"));
  compteur += 1;
  openssl(
    dossier,
    "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes",
    "-keyout", "ca.key", "-out", "ca.crt", "-subj", `/CN=${nom} ${compteur}`, "-days", "3650",
    "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign,cRLSign",
  ); // prettier-ignore
  return {
    cert: readFileSync(join(dossier, "ca.crt"), "utf8"),
    cle: readFileSync(join(dossier, "ca.key"), "utf8"),
    dossier,
  };
}

/** Certificat serveur signé par `ca` ; `avant` et `apres` (AAAAMMJJhhmmssZ) fixent une validité passée. */
export function creerFeuille(ca: Autorite, o: OptionsFeuille = {}): Feuille {
  const noms = o.noms ?? ["elpis-test.invalid"];
  const san = [...noms.map((n) => `DNS:${n}`), ...(o.ips ?? []).map((i) => `IP:${i}`)].join(",");
  compteur += 1;
  const base = `feuille${compteur}`;
  writeFileSync(join(ca.dossier, `${base}.cnf`), `subjectAltName=${san}\nextendedKeyUsage=serverAuth\n`);
  openssl(
    ca.dossier,
    "req", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes",
    "-keyout", `${base}.key`, "-out", `${base}.csr`, "-subj", `/CN=${noms[0] ?? "serveur"}`,
  ); // prettier-ignore
  const validite =
    o.avant !== undefined && o.apres !== undefined
      ? ["-not_before", o.avant, "-not_after", o.apres]
      : ["-days", String(o.jours ?? 365)];
  openssl(
    ca.dossier,
    "x509", "-req", "-in", `${base}.csr`, "-CA", "ca.crt", "-CAkey", "ca.key", "-CAcreateserial",
    "-out", `${base}.crt`, "-extfile", `${base}.cnf`, ...validite,
  ); // prettier-ignore
  return {
    cert: readFileSync(join(ca.dossier, `${base}.crt`), "utf8"),
    cle: readFileSync(join(ca.dossier, `${base}.key`), "utf8"),
  };
}

/** Certificat auto-signé (sans autorité), valable pour `nom`. */
export function creerAutoSigne(nom: string): Feuille & { dossier: string } {
  const dossier = mkdtempSync(join(tmpdir(), "elpis-pki-"));
  openssl(
    dossier,
    "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes",
    "-keyout", "s.key", "-out", "s.crt", "-subj", `/CN=${nom}`, "-days", "30", "-addext", `subjectAltName=DNS:${nom}`,
  ); // prettier-ignore
  return {
    cert: readFileSync(join(dossier, "s.crt"), "utf8"),
    cle: readFileSync(join(dossier, "s.key"), "utf8"),
    dossier,
  };
}

export function effacer(...d: readonly { dossier: string }[]): void {
  for (const x of d) rmSync(x.dossier, { recursive: true, force: true });
}
