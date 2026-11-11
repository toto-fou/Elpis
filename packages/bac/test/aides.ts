// SPDX-License-Identifier: MIT
/** packages/bac/test/aides.ts — faux docker scripté (mêmes règles que migration-kit/vecteurs/bac.py), processus `docker exec` simulé, dossiers temporaires. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough, Readable } from "node:stream";

import type { CliDocker, OptionsAppel, ProcessusDocker, ReponseDocker } from "../src/index";

export interface Regle {
  motif: string[];
  rc?: number;
  out?: string;
  err?: string;
  fois?: number | null;
}

export interface ProcessusScripte {
  rc: number;
  out: string;
  err: string;
}

/** Faux docker : première règle dont chaque élément du motif est dans l'argv (`~x` : sous-chaîne de l'argv joint). */
export class FauxCli implements CliDocker {
  readonly bin = "/usr/bin/docker";
  readonly appels: unknown[][] = [];
  readonly lances: string[][] = [];
  readonly entrees: { recu: Buffer; ferme: boolean }[] = [];
  private readonly regles: Regle[];
  processus: ProcessusScripte = { rc: 0, out: "", err: "" };
  /** Appel suspendu (délai, annulation) : promesse rendue telle quelle. */
  suspendre: ((args: readonly string[]) => Promise<ReponseDocker> | null) | null = null;

  constructor(regles: Regle[] = []) {
    this.regles = regles.map((r) => ({ ...r }));
  }

  repondre(args: readonly string[]): ReponseDocker {
    const joint = args.join(" ");
    for (const r of this.regles) {
      if (r.fois === 0) continue;
      if (r.motif.every((m) => (m.startsWith("~") ? joint.includes(m.slice(1)) : args.includes(m)))) {
        if (r.fois !== undefined && r.fois !== null) r.fois -= 1;
        return [r.rc ?? 0, Buffer.from(r.out ?? ""), Buffer.from(r.err ?? "")];
      }
    }
    return [0, Buffer.alloc(0), Buffer.alloc(0)];
  }

  async call(args: readonly string[], options: OptionsAppel = {}): Promise<ReponseDocker> {
    this.appels.push([...args, options.timeoutS ?? 30]);
    const suspendu = this.suspendre?.(args) ?? null;
    if (suspendu !== null) return suspendu;
    return this.repondre(args);
  }

  lancer(args: readonly string[], options: { entree: boolean }): ProcessusDocker {
    this.lances.push([this.bin, ...args]);
    const { rc, out, err } = this.processus;
    const entree = { recu: Buffer.alloc(0), ferme: false };
    let stdin: PassThrough | null = null;
    if (options.entree) {
      stdin = new PassThrough();
      stdin.on("data", (b: Buffer) => {
        entree.recu = Buffer.concat([entree.recu, b]);
      });
      stdin.on("finish", () => {
        entree.ferme = true;
      });
      this.entrees.push(entree);
    }
    return {
      stdin,
      stdout: Readable.from(out ? [Buffer.from(out)] : []),
      stderr: Readable.from(err ? [Buffer.from(err)] : []),
      fin: Promise.resolve(rc),
      tuer: () => undefined,
    };
  }
}

/** Dossier temporaire supprimé par la fonction rendue. */
export function dossierTemporaire(prefixe: string): [string, () => void] {
  const d = mkdtempSync(path.join(tmpdir(), prefixe));
  return [d, () => rmSync(d, { recursive: true, force: true })];
}
