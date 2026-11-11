// SPDX-License-Identifier: MIT
/** packages/fichiers/test/aides.ts — aides des tests : dossier temporaire, Python du système, bac servi par le vrai agent Python (sans conteneur). */
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { BacPourAgent, EtatBac } from "@elpis/bac";
import { pythonDisponible } from "@elpis/verrous/test";

export const RACINE = path.resolve(import.meta.dirname, "../../..");

/** Dossier temporaire supprimé par la fonction rendue. */
export function dossierTemporaire(prefixe: string): [string, () => void] {
  const d = mkdtempSync(path.join(tmpdir(), prefixe));
  return [d, () => rmSync(d, { recursive: true, force: true })];
}

/** Python 3 du système (agent du conteneur, essais croisés) ; `null` : essais sautés. */
export const PYTHON = pythonDisponible();
export const SERVEUR_AGENT = path.join(RACINE, "sandbox-agent", "server.py");

export function etat(running: boolean): EtatBac {
  return {
    exists: true,
    running,
    container_id: null,
    container_name: "elpis-sb-test",
    image: null,
    started_at: null,
    error: null,
  };
}

/** Bac de test : `P = <racine>/sb/<nom>`, `startAgent` lance le vrai agent Python (`server.py`) sur `P/work`, sans conteneur. */
export class BacTest implements BacPourAgent {
  readonly sandboxPath: string;
  readonly P: string;
  readonly socket: string;
  readonly relais: string;
  running = true;
  demarrages = 0;
  remplacements = 0;
  readonly agents: ChildProcess[] = [];

  constructor(racine: string, nom = "u") {
    this.P = path.join(racine, "sb", nom);
    this.sandboxPath = path.join(this.P, "work");
    this.socket = path.join(this.P, ".elpis-agent", "agent.sock");
    this.relais = path.join(racine, "sb", ".elpis-relay");
    mkdirSync(this.sandboxPath, { recursive: true });
    mkdirSync(path.dirname(this.socket), { recursive: true });
  }

  async status(): Promise<EtatBac> {
    return etat(this.running);
  }

  async ensureRunning(): Promise<EtatBac> {
    return etat(this.running);
  }

  async startAgent(replace: boolean): Promise<void> {
    this.demarrages++;
    if (replace) {
      this.remplacements++;
      await this.arreter();
    }
    const p = spawn(
      PYTHON as string,
      [
        "-I",
        "-S",
        SERVEUR_AGENT,
        "--root",
        this.sandboxPath,
        "--socket",
        this.socket,
        "--relay-dir",
        this.relais,
      ],
      { stdio: "ignore" },
    );
    this.agents.push(p);
  }

  /** Arrête les agents lancés (SIGKILL) et attend leur fin. */
  async arreter(): Promise<void> {
    const vivants = this.agents.splice(0).filter((p) => p.exitCode === null && p.signalCode === null);
    await Promise.all(
      vivants.map(
        (p) =>
          new Promise<void>((fin) => {
            p.once("exit", () => fin());
            p.kill("SIGKILL");
          }),
      ),
    );
  }
}
