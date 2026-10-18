// SPDX-License-Identifier: MIT
/** packages/securite/src/outils.ts — UTF-8 strict, ASCII, lecture d'un dict et tri des erreurs Python. */
import { ErreurPython } from "@elpis/commun";

const DECODEUR_UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** `bytes.decode("utf-8")` : strict, et le BOM reste dans le texte. */
export function decoderUtf8Py(octets: Uint8Array): string {
  try {
    return DECODEUR_UTF8.decode(octets);
  } catch {
    throw new ErreurPython("ValueError", "'utf-8' codec can't decode bytes: invalid data");
  }
}

export function estAscii(s: string): boolean {
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) > 0x7f) return false;
  return true;
}

export { encoderUtf8Py, estDict, estErreurPython, getPy, ouPy } from "@elpis/commun";
