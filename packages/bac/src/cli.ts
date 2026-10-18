// SPDX-License-Identifier: MIT
/** packages/bac/src/cli.ts — client Docker du bac (`_DockerCLI`) : appels bornés (124 au délai), annulables, et `docker exec` lancé en flux. */
import { spawn } from "node:child_process";
import { constants } from "node:os";
import type { Readable, Writable } from "node:stream";

import { messageErreurOs } from "@elpis/commun";

import { appelDocker, binaireDocker } from "./docker";

export type ReponseDocker = [number, Buffer, Buffer];

export interface OptionsAppel {
  /** Délai en secondes (30 par défaut, comme `call(timeout=30)`). */
  readonly timeoutS?: number;
  readonly entree?: Buffer;
  readonly signal?: AbortSignal;
}

/** Processus `docker exec` en cours : `fin` rend le `returncode` de Python (négatif si tué par un signal). */
export interface ProcessusDocker {
  readonly stdin: Writable | null;
  readonly stdout: Readable;
  readonly stderr: Readable;
  readonly fin: Promise<number>;
  tuer(): void;
}

export interface CliDocker {
  readonly bin: string;
  call(args: readonly string[], options?: OptionsAppel): Promise<ReponseDocker>;
  lancer(args: readonly string[], options: { entree: boolean }): ProcessusDocker;
}

/** Erreur de lancement du binaire (`FileNotFoundError`…) : message de `str(OSError)`. */
export class ErreurLancement extends Error {
  readonly code: string;

  constructor(e: unknown, binaire: string) {
    super(messageErreurOs(e, binaire));
    this.name = "OSError";
    this.code = String((e as { code?: unknown }).code ?? "");
  }
}

function estErreurLancement(e: unknown): boolean {
  return typeof (e as { syscall?: unknown } | null)?.syscall === "string";
}

/** `returncode` de Python : code de sortie, ou `-numéro` du signal. */
export function codeRetour(code: number | null, signal: NodeJS.Signals | null): number {
  if (code !== null) return code;
  return signal ? -(constants.signals[signal] ?? 0) : -1;
}

export class DockerCli implements CliDocker {
  /** `shutil.which("docker") or "/usr/bin/docker"`, fixé à la construction. */
  readonly bin: string;

  constructor(bin: string = binaireDocker()) {
    this.bin = bin;
  }

  /** `call` : (code, sortie, erreur) ; délai dépassé → (124, "", "docker call timeout"), processus tué. */
  async call(args: readonly string[], options: OptionsAppel = {}): Promise<ReponseDocker> {
    let r;
    try {
      r = await appelDocker(args, (options.timeoutS ?? 30) * 1000, {
        binaire: this.bin,
        ...(options.entree ? { entree: options.entree } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
      });
    } catch (e) {
      if (estErreurLancement(e)) throw new ErreurLancement(e, this.bin);
      throw e;
    }
    if (r.delaiDepasse) return [124, Buffer.alloc(0), Buffer.from("docker call timeout")];
    return [codeRetour(r.code, r.signal) || 0, r.sortie, r.erreur];
  }

  lancer(args: readonly string[], options: { entree: boolean }): ProcessusDocker {
    const proc = spawn(this.bin, [...args], { stdio: [options.entree ? "pipe" : "ignore", "pipe", "pipe"] });
    const fin = new Promise<number>((ok, ko) => {
      proc.once("error", (e) => ko(estErreurLancement(e) ? new ErreurLancement(e, this.bin) : e));
      proc.once("exit", (code, signal) => ok(codeRetour(code, signal)));
    });
    proc.stdin?.on("error", () => undefined);
    return {
      stdin: proc.stdin,
      stdout: proc.stdout as Readable,
      stderr: proc.stderr as Readable,
      fin,
      tuer: () => {
        if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
      },
    };
  }
}
