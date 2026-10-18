// SPDX-License-Identifier: MIT
/** packages/bac/src/capture.ts — sortie d'un `docker exec` gardée bornée : tête et queue, milieu compté et signalé (`_BoundedCapture`). */
import { estErreurPython, intPy } from "@elpis/commun";

/** `SANDBOX_EXEC_CAPTURE_MAX_BYTES` (64 Kio au moins), 32 Mio par défaut ou si illisible. */
export function execCaptureMaxBytes(env: NodeJS.ProcessEnv = process.env): number {
  try {
    return Math.max(64 * 1024, intPy(env["SANDBOX_EXEC_CAPTURE_MAX_BYTES"] ?? String(32 * 1024 * 1024)));
  } catch (e) {
    if (estErreurPython(e, "TypeError", "ValueError")) return 32 * 1024 * 1024;
    throw e;
  }
}

/** Tête copiée dans un tampon qui double (le `bytearray` du Python) ; queue en file à indice de début, compactée par moitié. */
export class CaptureBornee {
  private readonly moitie: number;
  private tete: Buffer = Buffer.alloc(0);
  private tailleTete = 0;
  private queue: Buffer[] = [];
  private debutQueue = 0;
  private tailleQueue = 0;
  dropped = 0;

  constructor(cap: number) {
    this.moitie = Math.max(1, Math.floor(cap / 2));
  }

  add(data: Buffer): void {
    const place = this.moitie - this.tailleTete;
    if (place > 0) {
      const debut = data.subarray(0, place);
      if (this.tailleTete + debut.length > this.tete.length) {
        const plus = Buffer.allocUnsafe(
          Math.min(this.moitie, Math.max(1024, this.tete.length * 2, this.tailleTete + debut.length)),
        );
        this.tete.copy(plus, 0, 0, this.tailleTete);
        this.tete = plus;
      }
      debut.copy(this.tete, this.tailleTete);
      this.tailleTete += debut.length;
      data = data.subarray(place);
    }
    if (data.length === 0) return;
    this.queue.push(data);
    this.tailleQueue += data.length;
    while (this.debutQueue < this.queue.length) {
      const premier = this.queue[this.debutQueue] as Buffer;
      if (this.tailleQueue - premier.length < this.moitie) break;
      this.queue[this.debutQueue++] = Buffer.alloc(0);
      this.tailleQueue -= premier.length;
      this.dropped += premier.length;
    }
    if (this.debutQueue > 1024 && this.debutQueue * 2 > this.queue.length) {
      this.queue = this.queue.slice(this.debutQueue);
      this.debutQueue = 0;
    }
  }

  value(): Buffer {
    const tete = this.tete.subarray(0, this.tailleTete);
    const queue = Buffer.concat(this.queue.slice(this.debutQueue));
    if (!this.dropped) return Buffer.concat([tete, queue]);
    const marque = Buffer.from(
      `\n…[${this.dropped} bytes omitted: output exceeded the ${2 * this.moitie} bytes capture limit]…\n`,
      "utf-8",
    );
    return Buffer.concat([tete, marque, queue]);
  }
}
