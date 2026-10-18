// SPDX-License-Identifier: MIT
/** frontend/src/platform/streams/ndjson.ts — lecteur NDJSON sur `ReadableStream` (flux de génération du chat, pas le SSE système). */
import { journal } from "../journal";

export interface OptionsNdjson {
  /** Ligne non JSON : signalée puis sautée, jamais appliquée. */
  readonly surLigneInvalide?: (ligne: string, erreur: unknown) => void;
}

function analyser(ligne: string, opts: OptionsNdjson): { ok: true; valeur: unknown } | { ok: false } {
  try {
    return { ok: true, valeur: JSON.parse(ligne) as unknown };
  } catch (e) {
    if (opts.surLigneInvalide) opts.surLigneInvalide(ligne, e);
    else journal.avertir("[flux] ligne NDJSON illisible, ignorée :", ligne.slice(0, 200));
    return { ok: false };
  }
}

/** Valeurs JSON du flux, une par ligne non vide ; la dernière ligne sans saut est lue ; sortir de la boucle annule le lecteur. */
export async function* lireNdjson(
  flux: ReadableStream<Uint8Array>,
  opts: OptionsNdjson = {},
): AsyncGenerator<unknown, void, undefined> {
  const lecteur = flux.getReader();
  const decodeur = new TextDecoder("utf-8");
  let tampon = "";
  let fini = false;
  try {
    for (;;) {
      const { done, value } = await lecteur.read();
      if (done) {
        fini = true;
        tampon += decodeur.decode();
        break;
      }
      tampon += decodeur.decode(value, { stream: true });
      let fin = tampon.indexOf("\n");
      while (fin >= 0) {
        const ligne = tampon.slice(0, fin).trim();
        tampon = tampon.slice(fin + 1);
        if (ligne) {
          const r = analyser(ligne, opts);
          if (r.ok) yield r.valeur;
        }
        fin = tampon.indexOf("\n");
      }
    }
    const reste = tampon.trim();
    if (reste) {
      const r = analyser(reste, opts);
      if (r.ok) yield r.valeur;
    }
  } finally {
    if (!fini) lecteur.cancel().catch(() => undefined);
    lecteur.releaseLock();
  }
}
