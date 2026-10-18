// SPDX-License-Identifier: MIT
/** packages/securite/src/base64.ts — base64 « URL » de Python : décodage tolérant de binascii, encodage. */
import { ErreurPython } from "@elpis/commun";

import { estAscii } from "./outils";

/** `binascii.Error` (une ValueError en Python) : rembourrage incorrect ou longueur impossible. */
export class ErreurBase64 extends ErreurPython {
  constructor(message: string) {
    super("ValueError", message);
    this.name = "binascii.Error";
  }
}

const VALEURS = new Int8Array(256).fill(-1);
for (const [i, c] of Array.from(
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/",
).entries()) {
  VALEURS[c.charCodeAt(0)] = i;
}
VALEURS["-".charCodeAt(0)] = 62;
VALEURS["_".charCodeAt(0)] = 63;

const EGAL = 0x3d;

/** `base64.urlsafe_b64decode` : `-_` et `+/` admis, le reste ignoré, arrêt au rembourrage complet. */
export function urlsafeB64Decode(entree: string | Uint8Array): Buffer {
  if (typeof entree === "string" && !estAscii(entree)) {
    throw new ErreurPython("ValueError", "string argument should contain only ASCII characters");
  }
  const octets = typeof entree === "string" ? Buffer.from(entree, "latin1") : entree;
  const sortie = Buffer.alloc(Math.floor((octets.length + 3) / 4) * 3);
  let n = 0;
  let position = 0;
  let reste = 0;
  let rembourrage = 0;
  for (const octet of octets) {
    if (octet === EGAL) {
      if (position >= 2 && position + ++rembourrage >= 4) return sortie.subarray(0, n);
      continue;
    }
    const valeur = VALEURS[octet] ?? -1;
    if (valeur < 0) continue;
    rembourrage = 0;
    if (position === 0) {
      reste = valeur;
    } else if (position === 1) {
      sortie[n++] = (reste << 2) | (valeur >> 4);
      reste = valeur & 0x0f;
    } else if (position === 2) {
      sortie[n++] = ((reste << 4) & 0xff) | (valeur >> 2);
      reste = valeur & 0x03;
    } else {
      sortie[n++] = ((reste << 6) & 0xff) | valeur;
    }
    position = (position + 1) % 4;
  }
  if (position === 1) {
    const caracteres = Math.floor(n / 3) * 4 + 1;
    throw new ErreurBase64(
      `Invalid base64-encoded string: number of data characters (${caracteres}) ` +
        "cannot be 1 more than a multiple of 4",
    );
  }
  if (position !== 0) throw new ErreurBase64("Incorrect padding");
  return sortie.subarray(0, n);
}

/** `base64.urlsafe_b64encode` : avec le rembourrage `=`. */
export function urlsafeB64Encode(octets: Uint8Array): string {
  return Buffer.from(octets.buffer, octets.byteOffset, octets.byteLength)
    .toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_");
}

/** `urlsafe_b64encode(…).rstrip("=")`. */
export function urlsafeB64EncodeSansRembourrage(octets: Uint8Array): string {
  return Buffer.from(octets.buffer, octets.byteOffset, octets.byteLength).toString("base64url");
}
