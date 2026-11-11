// SPDX-License-Identifier: MIT
/** packages/navigateur/src/autorite.ts — autorité de l'instance pour le relais des secrets du navigateur (ECDSA P-256, node:crypto seul) : clé 0600 hors des bacs, certificats feuilles par hôte signés à la demande ; DER écrit à la main (X.509 v3 minimal). */
import {
  createHash,
  createPrivateKey,
  generateKeyPairSync,
  randomBytes,
  sign,
  X509Certificate,
} from "node:crypto";
import type { KeyObject } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { isIP } from "node:net";
import path from "node:path";
import { createSecureContext } from "node:tls";
import type { SecureContext } from "node:tls";

import { config, pyJoin } from "@elpis/config";

// ── DER ──────────────────────────────────────────────────────────────

function longueur(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n]);
  const octets: number[] = [];
  for (let v = n; v > 0; v = Math.floor(v / 256)) octets.unshift(v & 0xff);
  return Buffer.from([0x80 | octets.length, ...octets]);
}
const tlv = (etiquette: number, contenu: Buffer): Buffer =>
  Buffer.concat([Buffer.from([etiquette]), longueur(contenu.length), contenu]);
const seq = (...e: Buffer[]): Buffer => tlv(0x30, Buffer.concat(e));
const ens = (...e: Buffer[]): Buffer => tlv(0x31, Buffer.concat(e));
const entier = (b: Buffer): Buffer =>
  tlv(0x02, (b[0] ?? 0) & 0x80 ? Buffer.concat([Buffer.from([0]), b]) : b);
const octets = (b: Buffer): Buffer => tlv(0x04, b);
const bits = (b: Buffer, inutilises = 0): Buffer => tlv(0x03, Buffer.concat([Buffer.from([inutilises]), b]));
const explicite = (n: number, b: Buffer): Buffer => tlv(0xa0 + n, b);
const vrai = tlv(0x01, Buffer.from([0xff]));

function oid(texte: string): Buffer {
  const p = texte.split(".").map(Number);
  const sortie: number[] = [40 * (p[0] ?? 0) + (p[1] ?? 0)];
  for (const n of p.slice(2)) {
    const groupe: number[] = [n & 0x7f];
    for (let v = Math.floor(n / 128); v > 0; v = Math.floor(v / 128)) groupe.unshift(0x80 | (v & 0x7f));
    sortie.push(...groupe);
  }
  return tlv(0x06, Buffer.from(sortie));
}

function temps(d: Date): Buffer {
  const z = (n: number, l = 2): string => String(n).padStart(l, "0");
  const t = `${z(d.getUTCMonth() + 1)}${z(d.getUTCDate())}${z(d.getUTCHours())}${z(d.getUTCMinutes())}${z(d.getUTCSeconds())}Z`;
  const an = d.getUTCFullYear();
  return an < 2050
    ? tlv(0x17, Buffer.from(`${z(an % 100)}${t}`, "ascii"))
    : tlv(0x18, Buffer.from(`${z(an, 4)}${t}`, "ascii"));
}

const nom = (cn: string): Buffer =>
  seq(
    ens(seq(oid("2.5.4.10"), tlv(0x0c, Buffer.from("Elpis", "utf8")))),
    ens(seq(oid("2.5.4.3"), tlv(0x0c, Buffer.from(cn, "utf8")))),
  );
const extension = (id: string, valeur: Buffer, critique = false): Buffer =>
  critique ? seq(oid(id), vrai, octets(valeur)) : seq(oid(id), octets(valeur));
const ECDSA_SHA256 = seq(oid("1.2.840.10045.4.3.2"));

/** Élément `i` d'une SEQUENCE DER (`[début, fin]` du TLV complet). */
function enfants(der: Buffer, debut = 0): [number, number][] {
  const lire = (o: number): [number, number, number] => {
    let l = der[o + 1] ?? 0;
    let tete = 2;
    if (l & 0x80) {
      const n = l & 0x7f;
      l = 0;
      for (let i = 0; i < n; i++) l = l * 256 + (der[o + 2 + i] ?? 0);
      tete = 2 + n;
    }
    return [o, o + tete, o + tete + l];
  };
  const [, contenu, fin] = lire(debut);
  const sortie: [number, number][] = [];
  for (let o = contenu; o < fin;) {
    const [, , f] = lire(o);
    sortie.push([o, f]);
    o = f;
  }
  return sortie;
}

/** Contenu d'un TLV DER `[début, fin]` (en-tête retiré). */
function contenuTlv(der: Buffer, [debut, fin]: [number, number]): Buffer {
  const l = der[debut + 1] ?? 0;
  return der.subarray(debut + (l & 0x80 ? 2 + (l & 0x7f) : 2), fin);
}

/** Identifiant de clé (SHA-1 des bits de la clé publique, RFC 5280 §4.2.1.2). */
function idCle(spki: Buffer): Buffer {
  const cle = enfants(spki)[1];
  if (cle === undefined) throw new Error("SPKI illisible");
  return createHash("sha1").update(contenuTlv(spki, cle).subarray(1)).digest();
}

function certificat(o: {
  emetteur: Buffer;
  sujet: Buffer;
  spki: Buffer;
  jours: number;
  extensions: Buffer[];
  cleSignature: KeyObject;
}): string {
  const debut = new Date(Date.now() - 3600_000);
  const fin = new Date(debut.getTime() + o.jours * 86400_000);
  const serie = randomBytes(16);
  serie[0] = (serie[0] ?? 0) & 0x7f;
  const tbs = seq(
    explicite(0, entier(Buffer.from([2]))),
    entier(serie),
    ECDSA_SHA256,
    o.emetteur,
    seq(temps(debut), temps(fin)),
    o.sujet,
    o.spki,
    explicite(3, seq(...o.extensions)),
  );
  const signature = sign("sha256", tbs, o.cleSignature);
  const der = seq(tbs, ECDSA_SHA256, bits(signature));
  return `-----BEGIN CERTIFICATE-----\n${der
    .toString("base64")
    .replace(/(.{64})/gu, "$1\n")
    .trimEnd()}\n-----END CERTIFICATE-----\n`;
}

// ── Autorité ─────────────────────────────────────────────────────────

/** Autorité chargée : certificat (PEM), clé privée (jamais hors de l'hôte), sujet et identifiant de clé pour signer les feuilles, échéance (ms). */
export interface Autorite {
  readonly certPem: string;
  readonly cle: KeyObject;
  readonly sujet: Buffer;
  readonly idCle: Buffer;
  readonly empreinte: string;
  readonly echeance: number;
}

/** Validité de l'autorité et renouvellement : une autorité plus courte limite la durée d'une clé volée (pas de contraintes de noms possibles, les origines des secrets changent sans cesse). */
export const reglagesAutorite = {
  /** Validité d'une autorité créée (jours). */
  jours: 365,
  /** Renouvelée au chargement quand il lui reste moins que cela (jours). */
  renouvelerAvantJours: 30,
};

/** Vrai si l'autorité arrive à son terme à `maintenant` (renouvellement dû). */
export function autoriteARenouveler(a: Pick<Autorite, "echeance">, maintenant = Date.now()): boolean {
  return a.echeance - maintenant < reglagesAutorite.renouvelerAvantJours * 86400_000;
}

/** Échéance (ms) d'un certificat PEM, 0 s'il est illisible. */
function echeanceDe(pem: string): number {
  try {
    return Date.parse(new X509Certificate(pem).validTo) || 0;
  } catch {
    return 0;
  }
}

/** Dossier de l'autorité : `ELPIS_BROWSER_CA_DIR`, sinon `<racine>/user_db/browser-relay-ca`. */
export function dossierAutorite(): string {
  return (
    (process.env["ELPIS_BROWSER_CA_DIR"] ?? "").trim() ||
    pyJoin(pyJoin(config.PROJECT_ROOT, "user_db"), "browser-relay-ca")
  );
}

/** Autorité de `dossier` (`ca.key` 0600, `ca.crt`), créée au premier appel (clé ECDSA P-256, `reglagesAutorite.jours`) et recréée quand son terme approche (`renouvelerAvantJours`) ; la supprimer puis relancer l'hôte d'outils la renouvelle aussi. */
export function chargerAutorite(dossier: string = dossierAutorite(), maintenant = Date.now()): Autorite {
  const fCle = path.join(dossier, "ca.key");
  const fCert = path.join(dossier, "ca.crt");
  const echue =
    existsSync(fCert) &&
    autoriteARenouveler({ echeance: echeanceDe(readFileSync(fCert, "utf8")) }, maintenant);
  if (!existsSync(fCle) || !existsSync(fCert) || echue) {
    mkdirSync(dossier, { recursive: true, mode: 0o700 });
    chmodSync(dossier, 0o700);
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const spki = publicKey.export({ type: "spki", format: "der" });
    const sujet = nom(`Elpis browser relay CA ${randomBytes(4).toString("hex")}`);
    const pem = certificat({
      emetteur: sujet,
      sujet,
      spki,
      jours: reglagesAutorite.jours,
      cleSignature: privateKey,
      extensions: [
        extension("2.5.29.19", seq(vrai, entier(Buffer.from([0]))), true),
        extension("2.5.29.15", bits(Buffer.from([0x06]), 1), true),
        extension("2.5.29.14", octets(idCle(spki))),
      ],
    });
    const tmp = `${fCle}.${process.pid}.tmp`;
    writeFileSync(tmp, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
    const tmpCert = `${fCert}.${process.pid}.tmp`;
    writeFileSync(tmpCert, pem, { mode: 0o644 });
    renameSync(tmp, fCle);
    renameSync(tmpCert, fCert);
  }
  const certPem = readFileSync(fCert, "utf8");
  const x = new X509Certificate(certPem);
  const cle = createPrivateKey(readFileSync(fCle));
  if (!x.checkPrivateKey(cle)) throw new Error(`${dossier}: ca.key does not match ca.crt`);
  const tbs = enfants(x.raw)[0];
  const champs = tbs === undefined ? [] : enfants(x.raw, tbs[0]);
  const s = champs[5];
  if (s === undefined) throw new Error(`${fCert}: unreadable certificate`);
  return {
    certPem,
    cle,
    sujet: x.raw.subarray(s[0], s[1]),
    idCle: idCle(x.publicKey.export({ type: "spki", format: "der" })),
    empreinte: x.fingerprint256,
    echeance: Date.parse(x.validTo) || 0,
  };
}

/** Feuilles signées par une autorité, par hôte (nom DNS ou IP), une clé pour toutes, renouvelées avant leur échéance (30 jours). */
export class Feuilles {
  private readonly cle = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  private readonly cache = new Map<string, { ctx: SecureContext; jusqua: number }>();

  private readonly autorite: Autorite;

  constructor(autorite: Autorite) {
    this.autorite = autorite;
  }

  /** Contexte TLS du relais pour `hote` (certificat de la feuille puis celui de l'autorité). */
  contexte(hote: string): SecureContext {
    const h = hote.toLowerCase().replace(/^\[|\]$/gu, "");
    const connu = this.cache.get(h);
    if (connu !== undefined && connu.jusqua > Date.now()) return connu.ctx;
    const spki = this.cle.publicKey.export({ type: "spki", format: "der" });
    const v = isIP(h);
    const san =
      v === 0
        ? tlv(0x82, Buffer.from(h, "ascii"))
        : tlv(0x87, v === 4 ? Buffer.from(h.split(".").map(Number)) : Buffer.from(new X509Ipv6(h).octets()));
    const pem = certificat({
      emetteur: this.autorite.sujet,
      sujet: nom(h),
      spki,
      jours: 30,
      cleSignature: this.autorite.cle,
      extensions: [
        extension("2.5.29.19", seq(), true),
        extension("2.5.29.15", bits(Buffer.from([0x80]), 7), true),
        extension("2.5.29.37", seq(oid("1.3.6.1.5.5.7.3.1"))),
        extension("2.5.29.17", seq(san)),
        extension("2.5.29.35", seq(tlv(0x80, this.autorite.idCle))),
        extension("2.5.29.14", octets(idCle(spki))),
      ],
    });
    const ctx = createSecureContext({
      key: this.cle.privateKey.export({ type: "pkcs8", format: "pem" }),
      cert: pem + this.autorite.certPem,
    });
    if (this.cache.size > 512) this.cache.clear();
    this.cache.set(h, { ctx, jusqua: Date.now() + 20 * 86400_000 });
    return ctx;
  }
}

/** Octets d'une adresse IPv6 textuelle. */
class X509Ipv6 {
  private readonly texte: string;

  constructor(texte: string) {
    this.texte = texte;
  }

  octets(): number[] {
    const [tete = "", queue] = this.texte.includes("::") ? this.texte.split("::") : [this.texte, null];
    const a = tete ? tete.split(":") : [];
    const b = queue ? queue.split(":") : [];
    const groupes = [...a, ...Array<string>(8 - a.length - b.length).fill("0"), ...b].map((x) =>
      parseInt(x || "0", 16),
    );
    return groupes.flatMap((g) => [g >> 8, g & 0xff]);
  }
}
