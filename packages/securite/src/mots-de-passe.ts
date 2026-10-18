// SPDX-License-Identifier: MIT
/** packages/securite/src/mots-de-passe.ts — PBKDF2 des mots de passe, empreintes de jetons, compare_digest. */
import { createHash, pbkdf2, randomBytes, timingSafeEqual } from "node:crypto";

import { ErreurPython, intPy } from "@elpis/commun";

import { encoderUtf8Py, estAscii, estErreurPython, ouPy } from "./outils";

/** Choix de sécurité délibéré (users.py) : ne pas le baisser pour gagner du temps. */
export const PASSWORD_ITERATIONS = 150_000;
const LONGUEUR_EMPREINTE = 32;

const BLANCS_HEX = new Set([0x20, 0x09, 0x0a, 0x0b, 0x0c, 0x0d]);

function valeurHex(code: number): number {
  if (code >= 0x30 && code <= 0x39) return code - 0x30;
  if (code >= 0x61 && code <= 0x66) return code - 0x57;
  if (code >= 0x41 && code <= 0x46) return code - 0x37;
  return -1;
}

/** `bytes.fromhex` : blancs ASCII admis entre deux octets seulement, majuscules acceptées. */
export function bytesFromHex(s: string): Buffer {
  const erreur = (position: number): ErreurPython =>
    new ErreurPython("ValueError", `non-hexadecimal number found in fromhex() arg at position ${position}`);
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) > 0x7f) throw erreur(i);
  const sortie: number[] = [];
  let i = 0;
  while (i < s.length) {
    if (BLANCS_HEX.has(s.charCodeAt(i))) {
      i++;
      continue;
    }
    const haut = valeurHex(s.charCodeAt(i));
    if (haut < 0) throw erreur(i);
    const bas = i + 1 < s.length ? valeurHex(s.charCodeAt(i + 1)) : -1;
    if (bas < 0) throw erreur(i + 1);
    sortie.push((haut << 4) | bas);
    i += 2;
  }
  return Buffer.from(sortie);
}

/** `hmac.compare_digest` : textes ASCII ou octets, jamais mélangés ; longueurs différentes → faux. */
export function compareDigest(a: string | Uint8Array, b: string | Uint8Array): boolean {
  if (typeof a === "string" && typeof b === "string") {
    if (!estAscii(a) || !estAscii(b)) {
      throw new ErreurPython("TypeError", "comparing strings with non-ASCII characters is not supported");
    }
    return egauxEnTempsConstant(Buffer.from(a, "latin1"), Buffer.from(b, "latin1"));
  }
  if (typeof a !== "string" && typeof b !== "string") return egauxEnTempsConstant(a, b);
  throw new ErreurPython("TypeError", "a bytes-like object is required, not 'str'");
}

function egauxEnTempsConstant(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

/** `secrets.token_hex` : sel d'un mot de passe (16 octets). */
export function tokenHex(nbytes = 32): string {
  return randomBytes(nbytes).toString("hex");
}

/** `secrets.token_urlsafe` : base64url sans `=`. */
export function tokenUrlsafe(nbytes = 32): string {
  return randomBytes(nbytes).toString("base64url");
}

/** `tokens.digest` : seule l'empreinte SHA-256 d'un jeton personnel est gardée en base. */
export function tokenDigest(token: string): string {
  return createHash("sha256").update(encoderUtf8Py(token)).digest("hex");
}

const DEFAULT_THREADS = 1;

/** Pool libuv que Node créera : UV_THREADPOOL_SIZE lu comme `atoi`, 4 par défaut, borné à 1..1024. */
function taillePoolLibuv(env: Readonly<Record<string, string | undefined>>): number {
  const brut = env["UV_THREADPOOL_SIZE"];
  if (brut === undefined) return 4;
  const n = Number.parseInt(brut, 10);
  if (Number.isNaN(n) || n === 0) return 1;
  return n < 0 || n > 1024 ? 1024 : n;
}

/** `APP_PWHASH_THREADS` (1..16, un par défaut), sous le pool libuv moins un : Node garde un fil libre. */
export function maxWorkers(env: Readonly<Record<string, string | undefined>> = process.env): number {
  let n: number;
  try {
    n = intPy(ouPy(env["APP_PWHASH_THREADS"] ?? "", DEFAULT_THREADS));
  } catch (e) {
    if (!estErreurPython(e, "TypeError", "ValueError")) throw e;
    n = DEFAULT_THREADS;
  }
  return Math.max(1, Math.min(n, 16, taillePoolLibuv(env) - 1));
}

class FileOperations {
  private actives = 0;
  private readonly enAttente: (() => void)[] = [];
  private readonly maximum: number;

  constructor(maximum: number) {
    this.maximum = maximum;
  }

  async executer<T>(operation: () => T | Promise<T>): Promise<T> {
    if (this.actives < this.maximum) this.actives++;
    else await new Promise<void>((reprendre) => this.enAttente.push(reprendre));
    try {
      return await operation();
    } finally {
      const suivante = this.enAttente.shift();
      if (suivante !== undefined) suivante();
      else this.actives--;
    }
  }
}

let file: FileOperations | null = null;

/** `run_password_op` : exécute `operation` quand une place se libère (taille lue au premier appel). */
export function runPasswordOp<T>(operation: () => T | Promise<T>): Promise<T> {
  file ??= new FileOperations(maxWorkers());
  return file.executer(operation);
}

/** Oublie la file (tests, arrêt) : la suivante relira `APP_PWHASH_THREADS`. */
export function shutdownPasswordPool(): void {
  file = null;
}

/** `_hash_password` : PBKDF2-HMAC-SHA256, 150 000 itérations, sel et empreinte (32 octets) en hexadécimal. */
export async function hashPassword(password: string, saltHex: string): Promise<string> {
  const sel = bytesFromHex(saltHex);
  const motDePasse = encoderUtf8Py(password);
  return runPasswordOp(
    () =>
      new Promise<string>((resoudre, rejeter) => {
        pbkdf2(motDePasse, sel, PASSWORD_ITERATIONS, LONGUEUR_EMPREINTE, "sha256", (erreur, cle) => {
          if (erreur) rejeter(erreur);
          else resoudre(cle.toString("hex"));
        });
      }),
  );
}

/** Le calcul de `verify_user` : `compare_digest` entre l'empreinte recalculée et celle de la base. */
export async function verifyPassword(
  password: string,
  saltHex: string,
  storedHash: string,
): Promise<boolean> {
  return compareDigest(await hashPassword(password, saltHex), storedHash);
}
