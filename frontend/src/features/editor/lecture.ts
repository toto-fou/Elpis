// SPDX-License-Identifier: MIT
/** frontend/src/features/editor/lecture.ts — lecture fidèle des fichiers du bac : décodage UTF-8 strict (BOM mémorisé, fins de ligne relevées, perte signalée), détection d'un binaire au premier bloc, tête d'un flux et vidage hexadécimal. */
import { SNIFF_BYTES, looksBinary } from "../../utils/office-model.ts";

export type FinDeLigne = "lf" | "crlf" | "cr" | "mixed" | null;

export interface TexteDecode {
  text: string;
  bom: boolean;
  lossy: boolean;
  eol: FinDeLigne;
}

export interface LigneHex {
  offset: string;
  hex: string;
  ascii: string;
}

/** Lignes offset / hexadécimal / ASCII, 16 octets par ligne, au plus `max` octets. */
export function vidageHex(octets: Uint8Array, max?: number): LigneHex[] {
  const lignes: LigneHex[] = [];
  const limite = Math.min(octets.length, max || 65536);
  for (let i = 0; i < limite; i += 16) {
    const tranche = Array.from(octets.slice(i, i + 16));
    lignes.push({
      offset: i.toString(16).padStart(8, "0"),
      hex: tranche
        .map((b) => b.toString(16).padStart(2, "0"))
        .join(" ")
        .padEnd(48, " "),
      ascii: tranche.map((b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : ".")).join(""),
    });
  }
  return lignes;
}

/** Concatène des morceaux de flux en `n` octets au plus. */
export function concatener(morceaux: readonly Uint8Array[], n: number): Uint8Array {
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of morceaux) {
    if (o >= n) break;
    const pris = Math.min(p.length, n - o);
    out.set(p.subarray(0, pris), o);
    o += pris;
  }
  return out;
}

/** Lit au plus `n` octets puis coupe le flux (un binaire de plusieurs Go n'est jamais téléchargé pour 4 Ko). */
export async function lireTete(res: Response, n: number): Promise<Uint8Array> {
  const corps = res.body;
  if (!corps || typeof corps.getReader !== "function") {
    return new Uint8Array(await res.arrayBuffer()).slice(0, n);
  }
  const lecteur = corps.getReader();
  const morceaux: Uint8Array[] = [];
  let taille = 0;
  try {
    while (taille < n) {
      const { done, value } = await lecteur.read();
      if (done) break;
      morceaux.push(value);
      taille += value.length;
    }
  } finally {
    lecteur.cancel().catch(() => {});
  }
  return concatener(morceaux, Math.min(taille, n));
}

export function finDeLigne(texte: string): FinDeLigne {
  let crlf = 0;
  let lf = 0;
  let cr = 0;
  for (let i = 0; i < texte.length; i++) {
    const c = texte.charCodeAt(i);
    if (c === 13) {
      if (texte.charCodeAt(i + 1) === 10) {
        crlf++;
        i++;
      } else cr++;
    } else if (c === 10) lf++;
  }
  const genres = Number(crlf > 0) + Number(lf > 0) + Number(cr > 0);
  if (!genres) return null;
  if (genres > 1) return "mixed";
  return crlf ? "crlf" : lf ? "lf" : "cr";
}

/** UTF-8 strict, BOM retiré mais mémorisé ; un contenu non UTF-8 est décodé avec remplacement et marqué `lossy`. */
export function decoderTexte(octets: Uint8Array): TexteDecode {
  const bom = octets.length >= 3 && octets[0] === 0xef && octets[1] === 0xbb && octets[2] === 0xbf;
  const corps = bom ? octets.subarray(3) : octets;
  let text: string;
  let lossy = false;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(corps);
  } catch {
    text = new TextDecoder("utf-8", { ignoreBOM: true }).decode(corps);
    lossy = true;
  }
  return { text, bom, lossy, eol: finDeLigne(text) };
}

/** Texte décodé, ou `{ binary: true }` dès que le premier bloc trahit un binaire (flux coupé aussitôt). */
export async function lireTexteOuBinaire(res: Response): Promise<TexteDecode | { binary: true }> {
  const corps = res.body;
  if (!corps || typeof corps.getReader !== "function") {
    const tout = new Uint8Array(await res.arrayBuffer());
    if (looksBinary(tout.subarray(0, SNIFF_BYTES))) return { binary: true };
    return decoderTexte(tout);
  }
  const lecteur = corps.getReader();
  const morceaux: Uint8Array[] = [];
  let taille = 0;
  let sonde = false;
  for (;;) {
    const { done, value } = await lecteur.read();
    if (done) break;
    morceaux.push(value);
    taille += value.length;
    if (!sonde && taille >= SNIFF_BYTES) {
      sonde = true;
      if (looksBinary(concatener(morceaux, SNIFF_BYTES))) {
        lecteur.cancel().catch(() => {});
        return { binary: true };
      }
    }
  }
  const tout = concatener(morceaux, taille);
  if (!sonde && looksBinary(tout)) return { binary: true };
  return decoderTexte(tout);
}
