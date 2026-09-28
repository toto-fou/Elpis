// SPDX-License-Identifier: MIT
// ============================================================
//  static/js/voice/worklet.js -- capture micro, côté thread audio
//
//  Chargé par URL (ctx.audioWorklet.addModule), JAMAIS par une balise
//  <script> : ce code s'exécute dans le thread audio, qui n'a ni `window`
//  ni DOM.
//
//  Rôle volontairement minimal : découper le flux en trames de 20 ms et
//  publier, pour chacune, ses échantillons et son niveau sonore. La
//  détection de parole, le ré-échantillonnage et l'assemblage WAV vivent
//  dans _micro.js — sur le thread principal, où ils sont débogables et
//  testables. Ce qui tourne ici ne doit jamais dépasser son budget de
//  temps, sous peine de craquements.
// ============================================================
class CaptureVocale extends AudioWorkletProcessor {
    constructor() {
        super();
        // 20 ms : assez court pour que le VAD réagisse au mot près, assez long
        // pour que le niveau sonore soit stable (à 5 ms, une consonne sourde
        // fait chuter le RMS et le VAD croit à un silence).
        this._taille = Math.max(128, Math.round(sampleRate * 0.02));
        this._tampon = new Float32Array(this._taille);
        this._ecrit = 0;
        this._actif = true;
        this.port.onmessage = (e) => {
            if (e.data && e.data.op === 'stop') this._actif = false;
        };
    }

    process(entrees) {
        if (!this._actif) return false;
        const canal = entrees[0] && entrees[0][0];
        // Pas d'entrée à ce tour (piste coupée, changement de périphérique) :
        // on rend `true` pour rester vivant, sinon le nœud est détruit et le
        // micro ne redémarre jamais.
        if (!canal || canal.length === 0) return true;

        let lu = 0;
        while (lu < canal.length) {
            const place = Math.min(this._taille - this._ecrit, canal.length - lu);
            this._tampon.set(canal.subarray(lu, lu + place), this._ecrit);
            this._ecrit += place;
            lu += place;
            if (this._ecrit < this._taille) continue;

            let somme = 0;
            for (let i = 0; i < this._taille; i++) somme += this._tampon[i] * this._tampon[i];
            const rms = Math.sqrt(somme / this._taille);

            // Copie transférée : le tampon est réutilisé au tour suivant, et
            // un transfert coûte moins qu'une sérialisation.
            const copie = this._tampon.slice(0);
            this.port.postMessage({ pcm: copie, rms: rms }, [copie.buffer]);
            this._ecrit = 0;
        }
        return true;
    }
}

registerProcessor('capture-vocale', CaptureVocale);
