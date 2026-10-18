// SPDX-License-Identifier: MIT
/** packages/bac/src/disponibilite.ts — cache « conteneur en marche » nourri par un seul `docker events` (executors/_readiness.py) : `ensureRunning` saute l'inspect par exec quand le flux est sain. */
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";

import { journalDe } from "@elpis/commun";

import { which } from "./docker";

const ACTIONS_HAUT = new Set(["start", "unpause", "restart"]);
const ACTIONS_BAS = new Set(["die", "stop", "kill", "pause", "destroy", "oom"]);

/** `SANDBOX_READINESS_CACHE` relu à chaque appel ; 0, false, no, off le coupent. */
function actif(): boolean {
  const v = (process.env["SANDBOX_READINESS_CACHE"] ?? "1").trim() || "1";
  return !["0", "false", "no", "off"].includes(v);
}

export type Horloge = () => number;

export class ReadinessCache {
  private readonly ttlS: number;
  private readonly horloge: Horloge;
  private readonly etats = new Map<string, [boolean, number]>();
  private sain = false;
  private abonne = false;
  private arret = false;
  private processus: ChildProcess | null = null;
  private attente: NodeJS.Timeout | null = null;

  constructor(ttlS = 15, horloge: Horloge = () => performance.now() / 1000) {
    this.ttlS = ttlS;
    this.horloge = horloge;
  }

  recordRunning(nom: string): void {
    if (nom) this.etats.set(nom, [true, this.horloge()]);
  }

  recordStopped(nom: string): void {
    if (nom) this.etats.set(nom, [false, this.horloge()]);
  }

  invalidate(nom: string): void {
    this.etats.delete(nom);
  }

  /** Vrai seulement avec un signal « en marche » frais ET un flux d'événements sain. */
  confirmedRunning(nom: string): boolean {
    if (!nom || !actif() || !this.sain) return false;
    const e = this.etats.get(nom);
    if (!e || !e[0]) return false;
    return this.horloge() - e[1] <= this.ttlS;
  }

  /** Dernier signal `[en marche, horodatage]`, ou `null` si le flux n'est pas sain (cache dérivé : IP d'aperçu). */
  stateStamp(nom: string): [boolean, number] | null {
    if (!nom || !this.sain) return null;
    return this.etats.get(nom) ?? null;
  }

  applyEvent(nom: string, action: string): void {
    if (!nom || !action) return;
    const a = action.trim().toLowerCase();
    if (ACTIONS_HAUT.has(a)) this.recordRunning(nom);
    else if (ACTIONS_BAS.has(a)) this.recordStopped(nom);
  }

  setEventsHealthy(sain: boolean): void {
    this.sain = sain;
  }

  /** Abonnement `docker events` (une fois), relancé avec un recul de 1 à 30 s ; rien sans docker ou cache coupé. */
  startEvents(filtre = "label=elpis.user_id"): void {
    if (!actif() || this.abonne || which("docker") === null) return;
    this.abonne = true;
    this.arret = false;
    this.lancer(filtre, 1);
  }

  /** Arrête l'abonnement : SIGTERM puis SIGKILL après 2 s, flux marqué malsain. */
  stopEvents(): void {
    this.arret = true;
    this.abonne = false;
    this.setEventsHealthy(false);
    if (this.attente !== null) clearTimeout(this.attente);
    this.attente = null;
    const p = this.processus;
    this.processus = null;
    if (p === null || p.exitCode !== null || p.signalCode !== null) return;
    p.kill("SIGTERM");
    const tuer = setTimeout(() => {
      if (p.exitCode === null && p.signalCode === null) p.kill("SIGKILL");
    }, 2_000);
    tuer.unref();
    p.once("exit", () => clearTimeout(tuer));
  }

  private lancer(filtre: string, recul: number): void {
    if (this.arret) return;
    const docker = which("docker") ?? "docker";
    const format = "{{.Actor.Attributes.name}}\t{{.Action}}";
    const p = spawn(
      docker,
      ["events", "--filter", "type=container", "--filter", filtre, "--format", format],
      {
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
    this.processus = p;
    p.unref();
    (p.stdout as unknown as { unref?: () => void }).unref?.();
    let suivant = recul;
    let fini = false;
    const terminer = (): void => {
      if (fini) return;
      fini = true;
      if (this.processus === p) this.processus = null;
      this.setEventsHealthy(false);
      if (this.arret) return;
      this.attente = setTimeout(() => this.lancer(filtre, Math.min(suivant * 2, 30)), suivant * 1000);
      this.attente.unref();
    };
    p.once("spawn", () => {
      this.setEventsHealthy(true);
      suivant = 1;
    });
    p.once("error", (e) => {
      journalDe("sandbox").debug(`[readiness] events stream error: ${e.message}`);
      terminer();
    });
    createInterface({ input: p.stdout }).on("line", (ligne) => {
      const parts = ligne.split("\t");
      if (parts.length >= 2) this.applyEvent(parts[0] ?? "", parts[1] ?? "");
    });
    p.once("close", terminer);
  }
}

let cache: ReadinessCache | null = null;
let ferme = false;

/** Singleton du process ; le flux d'événements part au premier usage, jamais après l'arrêt du process. */
export function getReadinessCache(): ReadinessCache {
  if (cache === null) {
    cache = new ReadinessCache();
    if (!ferme) cache.startEvents();
  }
  return cache;
}

/** Arrêt du process : abonnement arrêté pour de bon (plus de signal « en marche », un inspect par exec). */
export function arreterReadinessCache(): void {
  ferme = true;
  cache?.stopEvents();
}
