// SPDX-License-Identifier: MIT
/** packages/http/src/tls.ts — autorités de certification des appels HTTPS sortants (PKI interne, E21) : SSL_CERT_FILE, SSL_CERT_DIR ou magasin de Node, lues une fois. */
import { X509Certificate } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import * as tls from "node:tls";

import { journal } from "./journal";

/** Nom d'un certificat dans un `capath` d'OpenSSL (`c_rehash`) : empreinte du sujet, point, rang. */
const NOM_CAPATH = /^[0-9a-f]{8}\.\d+$/;

const autoritesLues = new Map<string, readonly string[]>();

/** Certificats d'un dossier `capath` (noms hachés seulement) ; dossier absent ou illisible = aucun, comme OpenSSL. */
function lireCapath(dossier: string): string[] {
  let noms: string[];
  try {
    noms = readdirSync(dossier).filter((n) => NOM_CAPATH.test(n));
  } catch {
    return [];
  }
  const pems: string[] = [];
  for (const nom of noms.sort()) {
    try {
      const texte = readFileSync(path.join(dossier, nom), "utf-8");
      if (texte.includes("-----BEGIN CERTIFICATE-----")) pems.push(texte);
    } catch {
      continue;
    }
  }
  return pems;
}

/** CA du client : `SSL_CERT_FILE`, sinon `SSL_CERT_DIR` (noms hachés ; une liste `a:b` est lue mais signalée), sinon le magasin par défaut de Node, système compris avec `--use-system-ca` ; lues une fois. */
export function autoritesTls(
  env: Readonly<Record<string, string | undefined>> = process.env,
): readonly string[] {
  const fichier = env["SSL_CERT_FILE"] || "";
  const dossiers = fichier ? "" : env["SSL_CERT_DIR"] || "";
  const cle = JSON.stringify([fichier, dossiers]);
  const connues = autoritesLues.get(cle);
  if (connues !== undefined) return connues;
  let pems: readonly string[];
  if (fichier) pems = [readFileSync(fichier, "utf-8")];
  else if (dossiers) {
    if (dossiers.includes(path.delimiter))
      journal("tls").warn(
        `SSL_CERT_DIR=${dossiers} : liste de dossiers lue pour le moteur d'inférence, mais Node.js (--use-system-ca) n'en lit qu'un pour les autres appels HTTPS du core ; réglez SSL_CERT_FILE ou un seul dossier (./elpis doctor)`,
      );
    pems = dossiers.split(path.delimiter).flatMap(lireCapath);
  } else {
    const magasin = (tls as { getCACertificates?: (type: "default") => string[] }).getCACertificates;
    pems = magasin ? magasin("default") : [...tls.rootCertificates];
  }
  autoritesLues.set(cle, pems);
  return pems;
}

const DEBUT_PEM = /^-----BEGIN (.+)-----$/;

/** `sanitize_line` d'OpenSSL : tout octet ≤ espace retiré en fin de ligne. */
function sansBlancsFinaux(l: string): string {
  let fin = l.length;
  while (fin > 0 && l.charCodeAt(fin - 1) <= 0x20) fin--;
  return l.slice(0, fin);
}
const BASE64_PEM = /^[A-Za-z0-9+/=\s]*$/;

/** `load_verify_locations(cadata=…)` d'OpenSSL : blocs lus dans l'ordre, un bloc de certificat illisible arrête tout, aucun certificat = erreur. */
export function certificatsPem(texte: string): string[] {
  const lignes = texte.split("\n").map(sansBlancsFinaux);
  const certificats: string[] = [];
  for (let i = 0; i < lignes.length; i++) {
    const nom = DEBUT_PEM.exec(lignes[i] ?? "")?.[1];
    if (nom === undefined) continue;
    const fin = lignes.indexOf(`-----END ${nom}-----`, i + 1);
    if (fin < 0) throw new Error("bad end line");
    const corps = lignes.slice(i + 1, fin).join("\n");
    i = fin;
    if (nom !== "CERTIFICATE" && nom !== "X509 CERTIFICATE") continue;
    if (!BASE64_PEM.test(corps)) throw new Error("bad base64 decode");
    const der = Buffer.from(corps.replace(/\s+/g, ""), "base64");
    new X509Certificate(der);
    certificats.push(`-----BEGIN CERTIFICATE-----\n${der.toString("base64")}\n-----END CERTIFICATE-----\n`);
  }
  if (certificats.length === 0) throw new Error("no start line: cadata does not contain a certificate");
  return certificats;
}
