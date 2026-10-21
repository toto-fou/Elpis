// SPDX-License-Identifier: MIT
/** apps/toolhost/src/mcp/office/worker.ts — worker Python des outils Office (`python -m elpis_office`) : un process partagé, appels multiplexés sur son stdin et son descripteur 3 (stdout et stderr : journal), rappels vers l'hôte pour les fichiers, graphiques et conversions. */
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import path from "node:path";
import type { Readable } from "node:stream";

import type { Dict } from "@elpis/commun";
import { racineDepot } from "@elpis/config";
import { interpreteurPython } from "@elpis/mcp";

import type { Journal } from "../../journal";
import { DecodeurCadres, encoderCadre } from "./cadres";
import type { Cadre } from "./cadres";

export const VERSION_CANAL = 1;
const DELAI_PRET_MS = 30_000;
const DELAI_ARRET_MS = 3_000;

/** Ce que l'hôte dit au worker d'un appel : session (garde anti-boucle) et conversions disponibles. */
export interface ContexteOffice {
  readonly session: string | null;
  readonly convertir: boolean;
  readonly svg_png: boolean;
  readonly echarts_svg: boolean;
}

export interface ReponseRappel {
  readonly valeur?: Dict;
  readonly corps?: Uint8Array;
}

/** Refus d'un rappel, rendu au Python comme l'exception que le moteur sait présenter. */
export class RefusRappel extends Error {
  override name = "RefusRappel";
  readonly genre: "introuvable" | "dossier" | "valeur" | "office" | "execution";
  readonly code: string | undefined;
  readonly fix: string | undefined;
  readonly retryable: boolean;

  constructor(
    genre: RefusRappel["genre"],
    message: string,
    o: { code?: string; fix?: string; retryable?: boolean } = {},
  ) {
    super(message);
    this.genre = genre;
    this.code = o.code;
    this.fix = o.fix;
    this.retryable = o.retryable ?? false;
  }
}

export type Rappels = (op: string, args: Dict, corps: Buffer) => Promise<ReponseRappel>;

export interface AppelOffice {
  readonly outil: string;
  readonly args: Dict;
  readonly contexte: ContexteOffice;
  readonly signal: AbortSignal;
  readonly rappels: Rappels;
}

/** Le worker a disparu ou parle mal : le résultat de l'appel est inconnu, il n'est jamais rejoué. */
export class ErreurWorker extends Error {
  override name = "ErreurWorker";
}

/** Le worker parle sur son stdin (appels) et son descripteur 3 (`stdio[3]`, réponses) ; stdout et stderr ne portent que du journal. */
export type LanceurWorker = () => ChildProcess;

export function lancerWorkerPython(): ChildProcess {
  const office = path.join(racineDepot(), "office");
  const parallele = process.env["ELPIS_OFFICE_PARALLELE"];
  return spawn(interpreteurPython(), ["-X", "utf8", "-m", "elpis_office"], {
    cwd: office,
    stdio: ["pipe", "pipe", "pipe", "pipe"],
    env: {
      PATH: process.env["PATH"] ?? "/usr/bin:/bin",
      LANG: "C.UTF-8",
      PYTHONPATH: office,
      PYTHONUNBUFFERED: "1",
      ...(parallele ? { ELPIS_OFFICE_PARALLELE: parallele } : {}),
    },
  });
}

interface EnCours {
  readonly appel: AppelOffice;
  readonly enfant: ChildProcess;
  readonly finir: (f: () => void) => void;
  readonly ok: (v: Dict) => void;
  readonly ko: (e: unknown) => void;
}

export interface OptionsCanal {
  readonly journal: Journal;
  readonly lanceur?: LanceurWorker;
  readonly delaiPretMs?: number;
}

export class CanalOffice {
  private readonly journal: Journal;
  private readonly lanceur: LanceurWorker;
  private readonly delaiPretMs: number;
  private pret: Promise<ChildProcess> | null = null;
  private readonly appels = new Map<number, EnCours>();
  private suivant = 0;
  private ferme = false;

  constructor(o: OptionsCanal) {
    this.journal = o.journal;
    this.lanceur = o.lanceur ?? lancerWorkerPython;
    this.delaiPretMs = o.delaiPretMs ?? DELAI_PRET_MS;
  }

  /** Résultat du moteur (enveloppe ok / error) ; `ErreurWorker` si le worker meurt en route, la raison du signal si l'appel est annulé. */
  async appeler(appel: AppelOffice): Promise<Dict> {
    if (this.ferme) throw new ErreurWorker("worker Office arrêté");
    appel.signal.throwIfAborted();
    const enfant = await jusquAbandon(this.demarrer(), appel.signal);
    appel.signal.throwIfAborted();
    return new Promise<Dict>((ok, ko) => {
      const id = ++this.suivant;
      const retirer = (): void => {
        appel.signal.removeEventListener("abort", abandon);
        this.appels.delete(id);
      };
      const finir = (f: () => void): void => {
        if (!this.appels.has(id)) return;
        retirer();
        f();
      };
      const abandon = (): void => {
        envoyer(enfant, { type: "annuler", id });
        finir(() => ko(appel.signal.reason ?? new Error("appel annulé")));
      };
      this.appels.set(id, { appel, enfant, finir, ok, ko });
      appel.signal.addEventListener("abort", abandon, { once: true });
      envoyer(enfant, { type: "appel", id, outil: appel.outil, args: appel.args, contexte: appel.contexte });
    });
  }

  /** Arrêt de l'hôte : appels en vol refusés, worker prié de finir (stdin fermé) puis tué après un délai. */
  async fermer(): Promise<void> {
    this.ferme = true;
    const pret = this.pret;
    this.pret = null;
    for (const c of [...this.appels.values()]) c.finir(() => c.ko(new ErreurWorker("worker Office arrêté")));
    if (pret === null) return;
    let enfant: ChildProcess;
    try {
      enfant = await pret;
    } catch {
      return;
    }
    if (enfant.exitCode !== null || enfant.signalCode !== null) return;
    await new Promise<void>((fin) => {
      const tue = setTimeout(() => enfant.kill("SIGKILL"), DELAI_ARRET_MS);
      enfant.once("exit", () => {
        clearTimeout(tue);
        fin();
      });
      enfant.stdin?.end();
    });
  }

  private demarrer(): Promise<ChildProcess> {
    if (this.pret !== null) return this.pret;
    const p: Promise<ChildProcess> = this.lancer().catch((e: unknown) => {
      if (this.pret === p) this.pret = null;
      throw e;
    });
    this.pret = p;
    return p;
  }

  private lancer(): Promise<ChildProcess> {
    return new Promise<ChildProcess>((ok, ko) => {
      const enfant = this.lanceur();
      const decodeur = new DecodeurCadres();
      let annonce = false;
      const abandonner = (e: ErreurWorker): void => {
        if (!annonce) ko(e);
        if (enfant.exitCode === null && enfant.signalCode === null) enfant.kill("SIGKILL");
      };
      const delai = setTimeout(
        () => abandonner(new ErreurWorker("worker Office : pas de réponse au démarrage")),
        this.delaiPretMs,
      );
      enfant.stdin?.on("error", () => undefined);
      const protocole = enfant.stdio[3] as Readable | null | undefined;
      if (!protocole) {
        clearTimeout(delai);
        enfant.once("error", () => undefined);
        abandonner(new ErreurWorker("worker Office lancé sans canal de protocole (descripteur 3)"));
        return;
      }
      protocole.on("error", () => undefined);
      protocole.on("data", (morceau: Buffer) => {
        let cadres: Cadre[];
        try {
          cadres = decodeur.pousser(morceau);
        } catch (e) {
          abandonner(new ErreurWorker(`worker Office : ${(e as Error).message}`));
          return;
        }
        for (const cadre of cadres) {
          if (annonce) {
            this.recevoir(enfant, cadre);
            continue;
          }
          if (cadre.entete["type"] !== "pret" || cadre.entete["version"] !== VERSION_CANAL) {
            abandonner(new ErreurWorker("worker Office : annonce inattendue"));
            return;
          }
          annonce = true;
          clearTimeout(delai);
          ok(enfant);
        }
      });
      const restes = [enfant.stdout, enfant.stderr].map((flux) => this.suivreJournal(flux));
      enfant.once("error", (e) => {
        clearTimeout(delai);
        if (!annonce) ko(new ErreurWorker(`worker Office non lancé (${e.message})`));
        this.disparu(enfant, e.message);
      });
      enfant.once("exit", (code, signal) => {
        clearTimeout(delai);
        const raison = signal ? `signal ${signal}` : `code ${code}`;
        if (!annonce) ko(new ErreurWorker(`worker Office arrêté au démarrage (${raison})`));
        for (const reste of restes) {
          const ligne = reste();
          if (ligne.trim()) this.journal.warn(`[office] worker : ${ligne}`);
        }
        this.disparu(enfant, raison);
      });
    });
  }

  /** Journalise les lignes complètes d'un flux du worker ; rend le fragment de ligne resté en attente. */
  private suivreJournal(flux: Readable | null): () => string {
    let fin = "";
    flux?.setEncoding("utf8");
    flux?.on("data", (texte: string) => {
      const lignes = (fin + texte).split("\n");
      fin = lignes.pop() ?? "";
      for (const l of lignes) if (l.trim()) this.journal.warn(`[office] worker : ${l}`);
    });
    return () => fin;
  }

  /** Le worker n'est plus : le prochain appel en relance un ; les appels en vol échouent, sans être rejoués. */
  private disparu(enfant: ChildProcess, raison: string): void {
    for (const c of [...this.appels.values()])
      if (c.enfant === enfant) c.finir(() => c.ko(new ErreurWorker(`worker Office arrêté (${raison})`)));
    const p = this.pret;
    if (p === null) return;
    void p.then(
      (e) => {
        if (e === enfant && this.pret === p) this.pret = null;
      },
      () => undefined,
    );
  }

  private recevoir(enfant: ChildProcess, { entete, corps }: Cadre): void {
    const id = Number(entete["id"]);
    const c = this.appels.get(id);
    switch (entete["type"]) {
      case "resultat": {
        const v = entete["valeur"];
        if (c === undefined) return;
        if (v === null || typeof v !== "object" || Array.isArray(v))
          c.finir(() => c.ko(new ErreurWorker("worker Office : résultat illisible")));
        else c.finir(() => c.ok(v as Dict));
        return;
      }
      case "echec":
        c?.finir(() => c.ko(new ErreurWorker(`worker Office : ${String(entete["message"])}`)));
        return;
      case "rappel":
        void this.servir(enfant, c, entete, corps);
        return;
      default:
        this.journal.warn(`[office] cadre inconnu du worker ignoré : ${String(entete["type"])}`);
    }
  }

  private async servir(
    enfant: ChildProcess,
    c: EnCours | undefined,
    entete: Dict,
    corps: Buffer,
  ): Promise<void> {
    const reponse = { type: "reponse", id: entete["id"], rid: entete["rid"] };
    if (c === undefined || c.appel.signal.aborted) {
      envoyer(enfant, { ...reponse, ok: false, erreur: { genre: "annule", message: "appel annulé" } });
      return;
    }
    try {
      const r = await c.appel.rappels(String(entete["op"]), (entete["args"] ?? {}) as Dict, corps);
      envoyer(enfant, { ...reponse, ok: true, valeur: r.valeur ?? {} }, r.corps);
    } catch (e) {
      const erreur =
        e instanceof RefusRappel
          ? {
              genre: e.genre,
              message: e.message,
              ...(e.code === undefined ? {} : { code: e.code }),
              ...(e.fix === undefined ? {} : { fix: e.fix }),
              retryable: e.retryable,
            }
          : c.appel.signal.aborted
            ? { genre: "annule", message: "appel annulé" }
            : { genre: "execution", message: e instanceof Error ? e.message : String(e) };
      envoyer(enfant, { ...reponse, ok: false, erreur });
    }
  }
}

/** Le résultat de `p`, ou la raison du signal dès qu'il est levé (le démarrage du worker continue pour les appels suivants). */
function jusquAbandon<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((ok, ko) => {
    const abandon = (): void => ko(signal.reason ?? new Error("appel annulé"));
    signal.addEventListener("abort", abandon, { once: true });
    p.then(ok, ko).finally(() => signal.removeEventListener("abort", abandon));
  });
}

function envoyer(enfant: ChildProcess, entete: Dict, corps?: Uint8Array): void {
  if (enfant.stdin === null || enfant.stdin.destroyed || !enfant.stdin.writable) return;
  enfant.stdin.write(encoderCadre(entete, corps));
}
