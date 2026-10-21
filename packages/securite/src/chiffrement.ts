// SPDX-License-Identifier: MIT
/** packages/securite/src/chiffrement.ts — secrets chiffrés au repos : Fernet et clé maître. */
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeSync,
} from "node:fs";
import { dirname, isAbsolute } from "node:path";

import { ErreurPython, stripPy } from "@elpis/commun";
import { avecVerrouSync } from "@elpis/verrous";

import { ErreurBase64, urlsafeB64Decode, urlsafeB64Encode } from "./base64";
import { egauxEnTempsConstant } from "./mots-de-passe";
import { decoderUtf8Py, encoderUtf8Py, estAscii, estErreurPython } from "./outils";
import { journalDe } from "./ports";

export class InvalidToken extends Error {
  constructor() {
    super("jeton Fernet invalide");
    this.name = "InvalidToken";
  }
}

/** Aucune clé maître résolvable ni créable : la couche base refuse alors d'écrire un secret en clair. */
export class EncryptionUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EncryptionUnavailable";
  }
}

const MAX_CLOCK_SKEW = 60n;
const MESSAGE_CLE = "Fernet key must be 32 url-safe base64-encoded bytes.";

interface ClesFernet {
  signature: Buffer;
  chiffrement: Buffer;
}

function clesFernet(key: string | Uint8Array): ClesFernet {
  let brute: Buffer;
  try {
    brute = urlsafeB64Decode(key);
  } catch (e) {
    if (e instanceof ErreurBase64) throw new ErreurPython("ValueError", MESSAGE_CLE);
    throw e;
  }
  if (brute.length !== 32) throw new ErreurPython("ValueError", MESSAGE_CLE);
  return { signature: brute.subarray(0, 16), chiffrement: brute.subarray(16) };
}

function entier(v: number | bigint, nom: string): bigint {
  if (typeof v === "bigint") return v;
  if (!Number.isInteger(v)) throw new ErreurPython("TypeError", `${nom} doit être un entier`);
  return BigInt(v);
}

function secondes(): bigint {
  return BigInt(Math.floor(Date.now() / 1000));
}

function chiffrerParties(
  cles: ClesFernet,
  donnees: Uint8Array,
  heure: number | bigint,
  iv: Uint8Array,
): string {
  if (!(donnees instanceof Uint8Array)) throw new ErreurPython("TypeError", "data must be bytes");
  if (iv.length !== 16) throw new ErreurPython("ValueError", `Invalid IV size (${iv.length}) for CBC.`);
  const t = entier(heure, "current_time");
  if (t < 0n || t >= 1n << 64n) throw new ErreurPython("OverflowError", "int too big to convert");
  const entete = Buffer.alloc(9);
  entete[0] = 0x80;
  entete.writeBigUInt64BE(t, 1);
  const aes = createCipheriv("aes-128-cbc", cles.chiffrement, iv);
  const parties = Buffer.concat([entete, iv, aes.update(donnees), aes.final()]);
  const mac = createHmac("sha256", cles.signature).update(parties).digest();
  return urlsafeB64Encode(Buffer.concat([parties, mac]));
}

function donneesNonVerifiees(token: string | Uint8Array): [bigint, Buffer] {
  if (typeof token !== "string" && !(token instanceof Uint8Array)) {
    throw new ErreurPython("TypeError", "token must be bytes or str");
  }
  let data: Buffer;
  try {
    data = urlsafeB64Decode(token);
  } catch (e) {
    if (e instanceof ErreurBase64) throw new InvalidToken();
    throw e;
  }
  if (data.length < 9 || data[0] !== 0x80) throw new InvalidToken();
  return [data.readBigUInt64BE(1), data];
}

function verifierSignature(cles: ClesFernet, data: Buffer): void {
  const fin = Math.max(0, data.length - 32);
  const attendu = createHmac("sha256", cles.signature).update(data.subarray(0, fin)).digest();
  const recu = data.subarray(fin);
  if (!egauxEnTempsConstant(recu, attendu)) throw new InvalidToken();
}

/** Unpadder PKCS7 de `cryptography` : dernier octet n dans 1..16 et n octets égaux à n. */
function retirerRembourrage(clair: Buffer): Buffer {
  const n = clair.length > 0 ? (clair[clair.length - 1] ?? 0) : 0;
  let ecart = n === 0 || n > 16 ? 1 : 0;
  for (let i = 1; i <= 16 && i <= clair.length; i++) {
    ecart |= (i <= n ? 1 : 0) & ((clair[clair.length - i] ?? 0) === n ? 0 : 1);
  }
  if (ecart !== 0) throw new InvalidToken();
  return clair.subarray(0, clair.length - n);
}

function dechiffrerDonnees(
  cles: ClesFernet,
  data: Buffer,
  horodatage: bigint,
  temps: readonly [bigint, bigint] | null,
): Buffer {
  if (temps !== null) {
    const [ttl, maintenant] = temps;
    if (horodatage + ttl < maintenant) throw new InvalidToken();
    if (maintenant + MAX_CLOCK_SKEW < horodatage) throw new InvalidToken();
  }
  verifierSignature(cles, data);
  const chiffre = data.subarray(25, Math.max(25, data.length - 32));
  if (chiffre.length % 16 !== 0) throw new InvalidToken();
  const aes = createDecipheriv("aes-128-cbc", cles.chiffrement, data.subarray(9, 25));
  aes.setAutoPadding(false);
  return retirerRembourrage(Buffer.concat([aes.update(chiffre), aes.final()]));
}

/** Fernet de `cryptography` : AES-128-CBC, PKCS7, HMAC-SHA256 ; base64url(0x80‖heure‖IV‖chiffré‖HMAC). */
export class Fernet {
  readonly #cles: ClesFernet;

  constructor(key: string | Uint8Array) {
    this.#cles = clesFernet(key);
  }

  static generateKey(): string {
    return urlsafeB64Encode(randomBytes(32));
  }

  encrypt(data: Uint8Array): string {
    return this.encryptAtTime(data, Math.floor(Date.now() / 1000));
  }

  encryptAtTime(data: Uint8Array, currentTime: number | bigint): string {
    return chiffrerParties(this.#cles, data, currentTime, randomBytes(16));
  }

  /** Sans `ttl`, l'heure du jeton n'est pas contrôlée (comme `cryptography`). */
  decrypt(token: string | Uint8Array, ttl: number | bigint | null = null): Buffer {
    const [horodatage, data] = donneesNonVerifiees(token);
    const temps = ttl === null ? null : ([entier(ttl, "ttl"), secondes()] as const);
    return dechiffrerDonnees(this.#cles, data, horodatage, temps);
  }

  decryptAtTime(
    token: string | Uint8Array,
    ttl: number | bigint | null,
    currentTime: number | bigint,
  ): Buffer {
    if (ttl === null)
      throw new ErreurPython("ValueError", "decrypt_at_time() can only be used with a non-None ttl");
    const [horodatage, data] = donneesNonVerifiees(token);
    return dechiffrerDonnees(this.#cles, data, horodatage, [
      entier(ttl, "ttl"),
      entier(currentTime, "current_time"),
    ]);
  }
}

/** `_encrypt_from_parts` : IV et heure imposés, pour les vecteurs seulement (jamais pour un vrai secret). */
export function encryptFromParts(
  key: string | Uint8Array,
  data: Uint8Array,
  currentTime: number | bigint,
  iv: Uint8Array,
): string {
  return chiffrerParties(clesFernet(key), data, currentTime, iv);
}

/** Toute chaîne → clé Fernet déterministe : base64url(sha256(secret)). */
export function deriveFernetKey(secret: string): string {
  return urlsafeB64Encode(createHash("sha256").update(encoderUtf8Py(secret)).digest());
}

/** Clé Fernet acceptée telle quelle (décodage tolérant de Python compris), sinon dérivée de la chaîne. */
export function coerceToFernetKey(value: string): string {
  const brute = stripPy(value);
  try {
    clesFernet(brute);
    return brute;
  } catch (e) {
    if (estErreurPython(e, "ValueError", "TypeError")) return deriveFernetKey(brute);
    throw e;
  }
}

/** `Path(DB_PATH).parent / ".encryption_key"` lu comme PurePosixPath (`//` gardé, `.` retiré). */
export function encryptionKeyPath(dbPath: string): string {
  const racine =
    dbPath.startsWith("//") && !dbPath.startsWith("///") ? "//" : dbPath.startsWith("/") ? "/" : "";
  const parties = dbPath.split("/").filter((p) => p !== "" && p !== ".");
  parties.pop();
  parties.push(".encryption_key");
  return racine + parties.join("/");
}

/** APP_ENCRYPTION_KEY, `app.encryption_key` brut de config.json, et `encryptionKeyPath(DB_PATH)` (absolu). */
export interface SourceCle {
  cleEnv?: string | null | undefined;
  cleConfig?: unknown;
  fichierCle: string;
}

function critique(message: string): null {
  const j = journalDe("encryption");
  if (j.fatal) j.fatal(message);
  else j.error(message);
  return null;
}

/** `_as_str(v, "")` d'un texte : absent ou blanc vaut « non défini ». */
function texteDefini(v: string | null | undefined): string {
  return v && stripPy(v) ? v : "";
}

function codeErreur(e: unknown): unknown {
  return (e as { code?: unknown } | null)?.code;
}

function texteErreur(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function refuser(fichier: string, motif: string): null {
  return critique(
    `Fichier de clé ${fichier} ${motif} : laissé intact, chiffrement indisponible. ` +
      "Le réparer, ou définir APP_ENCRYPTION_KEY.",
  );
}

/** `_ATTENTE_ECRITURE_S` : patience sous le verrou envers un fichier présent mais vide ou illisible. */
export const ATTENTE_ECRITURE_S = 1.0;
const ATTENTE = new Int32Array(new SharedArrayBuffer(4));

type LectureCle = { absent: true } | { absent: false; texte: string | null; motif: string };

/** `_lire_cle` : absent sur ENOENT/ENOTDIR seulement ; texte `null` (et motif) si illisible ou vide. */
function lireCle(fichier: string): LectureCle {
  let octets: Buffer;
  try {
    octets = readFileSync(fichier);
  } catch (e) {
    const code = codeErreur(e);
    if (code === "ENOENT" || code === "ENOTDIR") return { absent: true };
    return { absent: false, texte: null, motif: `illisible (${texteErreur(e)})` };
  }
  let texte: string;
  try {
    texte = stripPy(decoderUtf8Py(octets).replace(/\r\n?/g, "\n"));
  } catch {
    return { absent: false, texte: null, motif: "illisible (UTF-8 invalide)" };
  }
  return { absent: false, texte: texte || null, motif: "vide" };
}

/** `_relire_sous_verrou` : un fichier présent mais vide ou illisible peut être en cours d'écriture. */
function relireSousVerrou(fichier: string): LectureCle {
  const fin = performance.now() + ATTENTE_ECRITURE_S * 1000;
  let lue = lireCle(fichier);
  while (!lue.absent && lue.texte === null && performance.now() < fin) {
    Atomics.wait(ATTENTE, 0, 0, 50);
    lue = lireCle(fichier);
  }
  return lue;
}

/** Clé du fichier présent, sinon refus CRITICAL : il n'est jamais remplacé. */
function cleOuRefus(fichier: string, lue: LectureCle): string | null {
  if (lue.absent) return critique(`Fichier de clé ${fichier} disparu aussitôt créé.`);
  return lue.texte ? coerceToFernetKey(lue.texte) : refuser(fichier, lue.motif);
}

/** `_fsync_dossier` : rend durable une entrée de dossier ; sans effet là où c'est impossible. */
function fsyncDossier(dossier: string): void {
  let fd: number;
  try {
    fd = openSync(dossier, "r");
  } catch {
    return;
  }
  try {
    fsyncSync(fd);
  } catch {
    /* système sans fsync de dossier */
  } finally {
    closeSync(fd);
  }
}

/** Écrit, synchronise et ferme `fd`. */
function ecrireFd(fd: number, contenu: string): void {
  try {
    writeSync(fd, contenu);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function ecrireTemporaire(fichier: string, contenu: string): void {
  ecrireFd(openSync(fichier, "wx", 0o600), contenu);
}

/** `_ecrire_exclusif` : création exclusive (système sans liens durs) ; faux s'il existe ; jamais laissé vide. */
function ecrireExclusif(fichier: string, cle: string): boolean {
  let fd: number;
  try {
    fd = openSync(fichier, "wx", 0o600);
  } catch (e) {
    if (codeErreur(e) === "EEXIST") return false;
    throw e;
  }
  try {
    ecrireFd(fd, cle);
  } catch (e) {
    rmSync(fichier, { force: true });
    throw e;
  }
  fsyncDossier(dirname(fichier));
  return true;
}

/** Publication par link (sinon création exclusive) ; faux si une clé a été posée entre-temps. */
function publier(temporaire: string, fichier: string, cle: string): boolean {
  try {
    linkSync(temporaire, fichier);
  } catch (e) {
    if (codeErreur(e) === "EEXIST") return false;
    return ecrireExclusif(fichier, cle);
  }
  fsyncDossier(dirname(fichier));
  return true;
}

/** `_publish_key` : clé complète publiée d'un coup (temporaire 0600 synchronisé) ; une clé posée entre-temps l'emporte. */
function creerCle(fichier: string): string | null {
  const cle = Fernet.generateKey();
  const temporaire = `${fichier}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    ecrireTemporaire(temporaire, cle);
    if (publier(temporaire, fichier, cle)) {
      journalDe("encryption").warn(
        `Nouvelle clé de chiffrement créée dans ${fichier} : la sauvegarder avec la base.`,
      );
      return cle;
    }
  } finally {
    rmSync(temporaire, { force: true });
  }
  return cleOuRefus(fichier, lireCle(fichier));
}

/** Clé maître : env, config.json, sinon le fichier dédié (créé s'il est absent, sous `.encryption_key.lock` v1.1) ; `null` (CRITICAL) sinon. */
export function loadOrCreateKey(source: SourceCle): string | null {
  const env = texteDefini(source.cleEnv);
  if (env) return coerceToFernetKey(env);
  const config = source.cleConfig;
  if (config !== null && config !== undefined && typeof config !== "string") {
    return critique(
      "app.encryption_key de config.json n'est pas un texte : clé refusée (l'écrire entre guillemets).",
    );
  }
  const json = texteDefini(config as string | null | undefined);
  if (json) return coerceToFernetKey(json);
  const fichier = source.fichierCle;
  if (!isAbsolute(fichier)) return critique(`Chemin du fichier de clé non absolu, refusé : ${fichier}`);
  const lue = lireCle(fichier);
  if (!lue.absent && lue.texte) return coerceToFernetKey(lue.texte);
  const dossier = dirname(fichier);
  try {
    mkdirSync(dossier, { recursive: true });
  } catch (e) {
    return critique(
      `Impossible de créer ${dossier} pour persister la clé de chiffrement (${texteErreur(e)}) ` +
        "— les secrets des connecteurs LLM ne pourront PAS être stockés. " +
        "Définir APP_ENCRYPTION_KEY dans l'environnement.",
    );
  }
  try {
    return avecVerrouSync(`${fichier}.lock`, {}, () => {
      const relue = relireSousVerrou(fichier);
      return relue.absent ? creerCle(fichier) : cleOuRefus(fichier, relue);
    });
  } catch (e) {
    if (!lue.absent) return refuser(fichier, lue.motif);
    return critique(
      `Échec d'écriture de la clé de chiffrement dans ${fichier} : ${texteErreur(e)}. ` +
        "Les clés API des connecteurs LLM ne seront pas stockables. Définir APP_ENCRYPTION_KEY explicitement.",
    );
  }
}

let source: SourceCle | null = null;
let chiffreur: Fernet | null = null;
let resolu = false;

/** Source de la clé maître (démarrage, tests) ; la résolution reste paresseuse et mémorisée. */
export function configurerChiffrement(s: SourceCle): void {
  source = s;
  chiffreur = null;
  resolu = false;
}

function getCipher(): Fernet | null {
  if (resolu) return chiffreur;
  if (source === null)
    throw new Error("chiffrement non configuré : appeler configurerChiffrement() au démarrage");
  const cle = loadOrCreateKey(source);
  chiffreur = cle ? new Fernet(cle) : null;
  resolu = true;
  return chiffreur;
}

export function encrypt(plaintext: string | null | undefined): string {
  const f = getCipher();
  if (f === null)
    throw new EncryptionUnavailable("Clé de chiffrement indisponible — définir APP_ENCRYPTION_KEY.");
  return f.encrypt(encoderUtf8Py(plaintext || ""));
}

/** "" (et un avertissement) sur jeton invalide ou clé changée ; "" sans bruit si aucune clé n'existe. */
export function decrypt(token: string | null | undefined): string {
  const f = getCipher();
  if (f === null) return "";
  try {
    const jeton = token || "";
    if (!estAscii(jeton)) throw new ErreurPython("ValueError", "'ascii' codec can't encode character");
    return decoderUtf8Py(f.decrypt(jeton));
  } catch (e) {
    if (!(e instanceof InvalidToken) && !estErreurPython(e, "ValueError", "TypeError")) throw e;
    journalDe("encryption").warn("token Fernet invalide (clé tournée ?)");
    return "";
  }
}
