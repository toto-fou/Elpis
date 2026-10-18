// SPDX-License-Identifier: MIT
/** apps/toolhost/src/fichiers/types.ts — fichiers binaires et Office (sandbox/filetypes.py), règle partagée avec `frontend/src/utils/office-model.ts`. */

export const OFFICE_KINDS: Readonly<Record<string, string>> = {
  ".docx": "docx",
  ".pptx": "pptx",
  ".xlsx": "xlsx",
  ".pdf": "pdf",
};

const BINARY_MAGICS: readonly Buffer[] = [
  Buffer.from("%PDF-", "latin1"),
  Buffer.from("PK\x03\x04", "latin1"),
  Buffer.from("PK\x05\x06", "latin1"),
  Buffer.from("\x89PNG\r\n\x1a\n", "latin1"),
  Buffer.from("\xff\xd8\xff", "latin1"),
  Buffer.from("GIF87a", "latin1"),
  Buffer.from("GIF89a", "latin1"),
  Buffer.from("\x7fELF", "latin1"),
  Buffer.from("\x1f\x8b", "latin1"),
  Buffer.from("BZh", "latin1"),
  Buffer.from("\xfd7zXZ\x00", "latin1"),
  Buffer.from("7z\xbc\xaf\x27\x1c", "latin1"),
  Buffer.from("Rar!\x1a\x07", "latin1"),
  Buffer.from("\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1", "latin1"),
  Buffer.from("\xff\xfe", "latin1"),
  Buffer.from("\xfe\xff", "latin1"),
];

export const SNIFF_BYTES = 8192;

/** `looks_binary` : début de fichier qui ne s'édite pas comme texte (NUL dans les 8 premiers Kio, signature connue). */
export function looksBinary(tete: Uint8Array): boolean {
  if (tete.length === 0) return false;
  const debut = Buffer.from(tete.buffer, tete.byteOffset, tete.byteLength);
  if (debut.subarray(0, SNIFF_BYTES).includes(0)) return true;
  return BINARY_MAGICS.some((m) => debut.length >= m.length && debut.subarray(0, m.length).equals(m));
}
