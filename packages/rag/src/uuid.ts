// SPDX-License-Identifier: MIT
/** packages/rag/src/uuid.ts — UUID v5 (SHA-1, RFC 9562) et identifiant déterministe d'un point Qdrant. */
import { createHash } from "node:crypto";

/** Espace de noms des points du RAG (fixe : changer cette valeur change tous les identifiants). */
export const ESPACE_POINTS_RAG = "3f7a9c52-6d1e-4b08-9a47-c2e5d81b60f4";

function octets(uuid: string): Buffer {
  const hex = uuid.replace(/-/g, "");
  if (!/^[0-9a-f]{32}$/i.test(hex)) throw new TypeError(`UUID invalide : ${uuid}`);
  return Buffer.from(hex, "hex");
}

/** UUID v5 de `nom` dans `espace`. */
export function uuidV5(nom: string, espace: string): string {
  const h = createHash("sha1").update(octets(espace)).update(nom, "utf8").digest();
  h[6] = ((h[6] ?? 0) & 0x0f) | 0x50;
  h[8] = ((h[8] ?? 0) & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString("hex");
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20, 32)}`;
}

/** Identifiant stable du point d'un passage : l'écrire deux fois remplace le même point. */
export function idPoint(docId: string, chunkIndex: number): string {
  return uuidV5(`${docId}:${chunkIndex}`, ESPACE_POINTS_RAG);
}
