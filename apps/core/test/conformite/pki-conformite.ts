// SPDX-License-Identifier: MIT
/** apps/core/test/conformite/pki-conformite.ts — certificats de test à défauts précis (sans SAN, mauvais usage de clé, intermédiaire) générés par openssl, en complément de pki-openssl. */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Autorite, Feuille } from "../identite/pki-openssl";

function openssl(dossier: string, ...args: string[]): void {
  const r = spawnSync("openssl", args, { cwd: dossier, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`openssl ${args[0]} : ${r.stderr}`);
}

/** Autorité intermédiaire signée par `racine` (fichiers ca.crt et ca.key dans son propre dossier : utilisable par `creerFeuille`). */
export function creerIntermediaire(racine: Autorite, nom: string): Autorite {
  const dossier = mkdtempSync(join(tmpdir(), "elpis-pki-"));
  writeFileSync(
    join(dossier, "ext.cnf"),
    "basicConstraints=critical,CA:TRUE,pathlen:0\nkeyUsage=critical,keyCertSign,cRLSign\n",
  );
  openssl(
    dossier,
    ...["req", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes"],
    ...["-keyout", "ca.key", "-out", "ca.csr", "-subj", `/CN=${nom}`],
  );
  openssl(
    dossier,
    ...["x509", "-req", "-in", "ca.csr", "-CA", join(racine.dossier, "ca.crt")],
    ...["-CAkey", join(racine.dossier, "ca.key"), "-CAcreateserial", "-out", "ca.crt"],
    ...["-extfile", "ext.cnf", "-days", "3650"],
  );
  return {
    cert: readFileSync(join(dossier, "ca.crt"), "utf8"),
    cle: readFileSync(join(dossier, "ca.key"), "utf8"),
    dossier,
  };
}

export interface OptionsFeuilleSpeciale {
  readonly cn: string;
  /** Extension subjectAltName complète (`DNS:x,IP:y`), `null` : aucune. */
  readonly san: string | null;
  /** Extension extendedKeyUsage, `null` : aucune. */
  readonly eku: string | null;
  /** Extension keyUsage, `null` : aucune. */
  readonly usage?: string | null;
}

/** Certificat serveur signé par `ca` avec exactement ces extensions. */
export function creerFeuilleSpeciale(ca: Autorite, o: OptionsFeuilleSpeciale): Feuille {
  const lignes = [
    ...(o.san === null ? [] : [`subjectAltName=${o.san}`]),
    ...(o.eku === null ? [] : [`extendedKeyUsage=${o.eku}`]),
    ...(o.usage === undefined || o.usage === null ? [] : [`keyUsage=${o.usage}`]),
  ];
  writeFileSync(join(ca.dossier, "speciale.cnf"), `${lignes.join("\n")}\nbasicConstraints=CA:FALSE\n`);
  openssl(
    ca.dossier,
    ...["req", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes"],
    ...["-keyout", "speciale.key", "-out", "speciale.csr", "-subj", `/CN=${o.cn}`],
  );
  openssl(
    ca.dossier,
    ...["x509", "-req", "-in", "speciale.csr", "-CA", "ca.crt", "-CAkey", "ca.key", "-CAcreateserial"],
    ...["-out", "speciale.crt", "-extfile", "speciale.cnf", "-days", "365"],
  );
  return {
    cert: readFileSync(join(ca.dossier, "speciale.crt"), "utf8"),
    cle: readFileSync(join(ca.dossier, "speciale.key"), "utf8"),
  };
}
