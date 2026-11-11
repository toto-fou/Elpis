// SPDX-License-Identifier: MIT
/** apps/toolhost/test/terminal-aides.ts — terminal en test : faux `docker` (inspect, sonde, `exec -it` qui ouvre un vrai `sh`), faux PTY et fausse socket pour rejouer la boucle WebSocket. */
import { EventEmitter } from "node:events";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { IPty } from "node-pty";
import WebSocket from "ws";

import type { LanceurPty } from "../src/terminal/pty";

export interface FauxDockerTerminal {
  readonly bin: string;
  readonly etat: string;
  appels(): string[];
  /** argv reçus par les `docker exec -it` (un par PTY lancé). */
  argvPty(): string[][];
  poser(drapeau: "arrete" | "privdrop-ok" | "lent", actif?: boolean): void;
}

/** Faux `docker` : l'état est écrit en dur dans le script, l'enfant du PTY ne recevant qu'un environnement minimal. */
export function creerFauxDockerTerminal(dossier: string): FauxDockerTerminal {
  const bin = path.join(dossier, "bin");
  const etat = path.join(dossier, "etat");
  mkdirSync(bin, { recursive: true });
  mkdirSync(etat, { recursive: true });
  const script = `#!/bin/sh
d='${etat}'
printf '%s\\n' "$*" >> "$d/appels.log"
case "$1" in
  inspect) [ -f "$d/lent" ] && sleep 1; if [ -f "$d/arrete" ]; then echo false; else echo true; fi; exit 0 ;;
  exec)
    if [ "$2" = "-it" ]; then
      printf '%s\\0' "$@" > "$d/pty-$$.argv"
      PS1='$ ' exec /bin/sh
    fi
    [ -f "$d/privdrop-ok" ] && exit 0; exit 1 ;;
  version) echo "27.3.1"; exit 0 ;;
esac
exit 0
`;
  writeFileSync(path.join(bin, "docker"), script);
  chmodSync(path.join(bin, "docker"), 0o755);
  writeFileSync(path.join(etat, "appels.log"), "");
  return {
    bin,
    etat,
    appels: () =>
      readFileSync(path.join(etat, "appels.log"), "utf-8")
        .split("\n")
        .filter((l) => l !== ""),
    argvPty: () =>
      readdirSync(etat)
        .filter((n) => n.startsWith("pty-"))
        .map((n) => readFileSync(path.join(etat, n), "utf-8").split("\0").slice(0, -1)),
    poser(drapeau, actif = true) {
      const f = path.join(etat, drapeau);
      if (actif) writeFileSync(f, "");
      else if (existsSync(f)) rmSync(f);
    },
  };
}

/** PTY factice : écritures, tailles et pauses relevées ; `sortir()` simule la fin du shell. */
export class FauxPty {
  readonly pid = 2 ** 30;
  /** fd maître (écriture directe par le Terminal) ; absent : écritures relevées par `write`. */
  fd?: number;
  readonly ecrits: Buffer[] = [];
  readonly tailles: [number, number][] = [];
  readonly signaux: string[] = [];
  enPause = false;
  private surDonnees: ((d: Buffer) => void)[] = [];
  private surFin: ((e: { exitCode: number }) => void)[] = [];

  onData(f: (d: Buffer) => void): { dispose(): void } {
    this.surDonnees.push(f);
    return { dispose: () => undefined };
  }

  onExit(f: (e: { exitCode: number }) => void): { dispose(): void } {
    this.surFin.push(f);
    return { dispose: () => undefined };
  }

  pause(): void {
    this.enPause = true;
  }

  resume(): void {
    this.enPause = false;
  }

  write(d: string | Buffer): void {
    this.ecrits.push(Buffer.isBuffer(d) ? d : Buffer.from(d));
  }

  resize(colonnes: number, lignes: number): void {
    this.tailles.push([lignes, colonnes]);
  }

  kill(signal?: string): void {
    this.signaux.push(signal ?? "SIGHUP");
    queueMicrotask(() => this.sortir());
  }

  emettre(d: Buffer): void {
    for (const f of this.surDonnees) f(d);
  }

  sortir(): void {
    const fins = this.surFin.splice(0);
    for (const f of fins) f({ exitCode: 0 });
  }

  commeIPty(): IPty {
    return this as unknown as IPty;
  }
}

/** Lanceur qui rend des FauxPty (gardés dans `crees`). */
export function lanceurFactice(): { lanceur: LanceurPty; crees: FauxPty[]; appels: string[][] } {
  const crees: FauxPty[] = [];
  const appels: string[][] = [];
  return {
    crees,
    appels,
    lanceur: (fichier, args) => {
      appels.push([fichier, ...args]);
      const p = new FauxPty();
      crees.push(p);
      return p.commeIPty();
    },
  };
}

/** Socket WebSocket factice : trames envoyées relevées, fermeture notée puis annoncée. */
export class FausseSocket extends EventEmitter {
  readyState: number = WebSocket.OPEN;
  bufferedAmount = 0;
  readonly trames: { donnees: Buffer | string; binaire: boolean }[] = [];
  ferme: number | null = null;

  send(donnees: Buffer | string, options: { binary?: boolean }, fin?: () => void): void {
    this.trames.push({ donnees, binaire: options.binary === true });
    fin?.();
  }

  close(code = 1005): void {
    if (this.readyState !== WebSocket.OPEN) return;
    this.readyState = WebSocket.CLOSING;
    this.ferme = code;
    setImmediate(() => {
      this.readyState = WebSocket.CLOSED;
      this.emit("close", code, Buffer.alloc(0));
    });
  }

  /** Message reçu du client. */
  recevoir(donnees: string | Buffer, binaire = typeof donnees !== "string"): void {
    this.emit("message", Buffer.isBuffer(donnees) ? donnees : Buffer.from(donnees, "utf-8"), binaire);
  }

  /** Fermeture venue du client (code lu par la boucle). */
  fermeParLeClient(code: number): void {
    if (this.readyState === WebSocket.CLOSED) return;
    this.readyState = WebSocket.CLOSED;
    this.emit("close", code, Buffer.alloc(0));
  }

  textes(): unknown[] {
    return this.trames.filter((t) => !t.binaire).map((t) => JSON.parse(String(t.donnees)) as unknown);
  }

  commeWs(): WebSocket {
    return this as unknown as WebSocket;
  }
}

/** Attente bornée d'une condition. */
export async function attendre(
  condition: () => boolean,
  delaiMs = 5_000,
  message = "délai dépassé",
): Promise<void> {
  const fin = Date.now() + delaiMs;
  while (!condition()) {
    if (Date.now() > fin) throw new Error(message);
    await new Promise((ok) => setTimeout(ok, 10));
  }
}
