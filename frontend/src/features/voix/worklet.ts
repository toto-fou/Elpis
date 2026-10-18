// SPDX-License-Identifier: MIT
/** frontend/src/features/voix/worklet.ts — capture micro côté thread audio : trames de 20 ms (échantillons et niveau RMS), chargé par URL de module. */

interface PortAudio {
  onmessage: ((e: { data: { op?: string } | null }) => void) | null;
  postMessage(message: unknown, transfert?: Transferable[]): void;
}
declare class AudioWorkletProcessor {
  readonly port: PortAudio;
}
declare const sampleRate: number;
declare function registerProcessor(nom: string, ctor: new () => AudioWorkletProcessor): void;

class CaptureVocale extends AudioWorkletProcessor {
  private readonly taille = Math.max(128, Math.round(sampleRate * 0.02));
  private readonly tampon = new Float32Array(this.taille);
  private ecrit = 0;
  private actif = true;

  constructor() {
    super();
    this.port.onmessage = (e) => {
      if (e.data && e.data.op === "stop") this.actif = false;
    };
  }

  process(entrees: Float32Array[][]): boolean {
    if (!this.actif) return false;
    const canal = entrees[0]?.[0];
    if (!canal || canal.length === 0) return true;
    let lu = 0;
    while (lu < canal.length) {
      const place = Math.min(this.taille - this.ecrit, canal.length - lu);
      this.tampon.set(canal.subarray(lu, lu + place), this.ecrit);
      this.ecrit += place;
      lu += place;
      if (this.ecrit < this.taille) continue;
      let somme = 0;
      for (let i = 0; i < this.taille; i++) somme += (this.tampon[i] ?? 0) ** 2;
      const rms = Math.sqrt(somme / this.taille);
      const copie = this.tampon.slice(0);
      this.port.postMessage({ pcm: copie, rms }, [copie.buffer]);
      this.ecrit = 0;
    }
    return true;
  }
}

registerProcessor("capture-vocale", CaptureVocale);
