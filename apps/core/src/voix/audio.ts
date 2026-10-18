// SPDX-License-Identifier: MIT
/** apps/core/src/voix/audio.ts — en-tête WAV d'un énoncé de dictée lu sans décoder l'audio, et contexte d'encodeur de whisper. */
import { fixePy, maxPy } from "@elpis/commun";

export const TAUX_ATTENDU = 16000;
export const CANAUX_ATTENDUS = 1;
export const BITS_ATTENDUS = 16;
export const DUREE_MINIMALE_MS = 250.0;
export const POSITIONS_PAR_SECONDE = 50;
export const AUDIO_CTX_MIN = 256;
export const AUDIO_CTX_MAX = 1500;
export const AUDIO_CTX_PAS = 256;
export const AUDIO_CTX_MARGE = 1.6;
export const TOLERANCE_DUREE_MS = 250.0;

/** Le fichier n'est pas le WAV attendu ; le message est montré tel quel (415). */
export class AudioInvalide extends Error {
  override name = "AudioInvalide";
}

export interface EnTeteWav {
  readonly taux: number;
  readonly canaux: number;
  readonly bits: number;
  readonly octets_donnees: number;
}

export function dureeMs(e: EnTeteWav): number {
  const largeur = Math.max(1, Math.floor(e.bits / 8)) * Math.max(1, e.canaux);
  return (e.octets_donnees / largeur / Math.max(1, e.taux)) * 1000.0;
}

function egal(d: Uint8Array, debut: number, texte: string): boolean {
  for (let i = 0; i < texte.length; i++) if (d[debut + i] !== texte.charCodeAt(i)) return false;
  return true;
}

/** `lit_entete_wav` : parcours des blocs RIFF (un `LIST` entre `fmt ` et `data` est sauté), taille de `data` bornée à ce qui est reçu. */
export function litEnteteWav(donnees: Uint8Array): EnTeteWav {
  if (donnees.length < 44) throw new AudioInvalide("Fichier audio trop court pour être un WAV.");
  if (!egal(donnees, 0, "RIFF") || !egal(donnees, 8, "WAVE"))
    throw new AudioInvalide("Le fichier n'est pas un WAV (en-tête RIFF absent).");
  const vue = new DataView(donnees.buffer, donnees.byteOffset, donnees.byteLength);
  const fin = donnees.length;
  let pos = 12;
  let fmt: [number, number, number, number] | null = null;
  let octets = 0;
  while (pos + 8 <= fin) {
    const taille = vue.getUint32(pos + 4, true);
    const corps = pos + 8;
    if (egal(donnees, pos, "fmt ") && taille >= 16 && corps + 16 <= fin) {
      fmt = [
        vue.getUint16(corps, true),
        vue.getUint16(corps + 2, true),
        vue.getUint32(corps + 4, true),
        vue.getUint16(corps + 14, true),
      ];
    } else if (egal(donnees, pos, "data")) {
      octets = Math.min(taille, fin - corps);
      break;
    }
    pos = corps + taille + (taille & 1);
  }
  if (fmt === null) throw new AudioInvalide("WAV sans bloc de format.");
  const [format, canaux, taux, bits] = fmt;
  if (format !== 1) throw new AudioInvalide("WAV compressé : seul le PCM non compressé est accepté.");
  return { taux, canaux, bits, octets_donnees: octets };
}

/** `valide_wav_dictee` : 16 kHz mono 16 bits, données présentes, durée sous le plafond (+250 ms de tolérance). */
export function valideWavDictee(donnees: Uint8Array, maxUtteranceSec: number): EnTeteWav {
  const e = litEnteteWav(donnees);
  if (e.canaux !== CANAUX_ATTENDUS)
    throw new AudioInvalide(`Audio à ${e.canaux} canaux : il en faut ${CANAUX_ATTENDUS}.`);
  if (e.bits !== BITS_ATTENDUS)
    throw new AudioInvalide(`Audio en ${e.bits} bits : il en faut ${BITS_ATTENDUS}.`);
  if (e.taux !== TAUX_ATTENDU)
    throw new AudioInvalide(`Audio à ${e.taux} Hz : il faut du ${TAUX_ATTENDU} Hz.`);
  if (e.octets_donnees <= 0) throw new AudioInvalide("WAV sans données audio.");
  const duree = dureeMs(e);
  if (duree > maxUtteranceSec * 1000.0 + TOLERANCE_DUREE_MS)
    throw new AudioInvalide(`Énoncé de ${fixePy(duree / 1000, 0)} s : le plafond est ${maxUtteranceSec} s.`);
  return e;
}

/** Contexte d'encodeur juste suffisant (marge 1,6), arrondi au multiple de 256 supérieur, borné à [256, 1500]. */
export function audioCtxPour(dureeMs: number): number {
  const besoin = (maxPy(dureeMs, 1.0) / 1000.0) * POSITIONS_PAR_SECONDE * AUDIO_CTX_MARGE;
  const arrondi = Math.ceil(besoin / AUDIO_CTX_PAS) * AUDIO_CTX_PAS;
  return arrondi > AUDIO_CTX_MAX ? AUDIO_CTX_MAX : Math.max(AUDIO_CTX_MIN, arrondi);
}
