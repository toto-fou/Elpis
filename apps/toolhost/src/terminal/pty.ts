// SPDX-License-Identifier: MIT
/** apps/toolhost/src/terminal/pty.ts — PTY de l'hôte (terminal/pty.py) : `docker exec -it` du bac du compte sous node-pty, registre par (compte, session), éviction, nettoyage. */
import {
  appelDocker,
  binaireDocker,
  containerName,
  decoderRemplace,
  entreePermise,
  FORMAT_ENTREE,
  PATH_COMPTE,
  PREFIXE_NPM,
  racineTravail,
} from "@elpis/bac";
import { HttpError, intPy, stripPy } from "@elpis/commun";
import { safeSandboxName } from "@elpis/config";
import { usernameFor } from "@elpis/securite";
import { writeSync } from "node:fs";
import { createRequire } from "node:module";

import type * as NodePtyModule from "node-pty";
import type { IPty } from "node-pty";

import type { Journal } from "../journal";
import { bacDuCompteConnu } from "../mcp/espace";

export const DEFAULT_SID = "default";
export const MAX_SESSIONS_PER_USER = 4;
export const PTY_IDLE_TIMEOUT_S = 1800;
export const TERM_RCFILE = "/tmp/.elpis-termrc";
export const TERM_BOOTSTRAP =
  "umask 0022; " +
  '{ echo \'[ -f "$HOME/.bashrc" ] && . "$HOME/.bashrc"\'; ' +
  "echo 'umask 0022'; } > " +
  TERM_RCFILE +
  " 2>/dev/null " +
  "&& exec /bin/bash --rcfile " +
  TERM_RCFILE +
  "; " +
  "exec /bin/bash";
export const PTY_EXEC_USER = "10001:10001";
const PATH_ENFANT = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
/** Au-delà de 65 535, `struct.pack("HHHH")` lève : le Python ne redimensionne pas. */
const TAILLE_MAX = 0xffff;
/** `docker exec -it` perd un SIGWINCH reçu pendant son démarrage : une taille demandée avant sa première sortie est renvoyée peu après celle-ci, puis à 1 s et 3 s. */
const RATTRAPAGES_MS = [1_000, 3_000];
const APRES_PREMIERE_SORTIE_MS = 100;
/** Frappe en attente d'écriture dans le maître (le shell ne lit pas) : au-delà, refusée (le Python levait sur EAGAIN). */
export const PLAFOND_ECRITURE = 1024 * 1024;
const REESSAI_ECRITURE_MS = 5;

export const CONTAINER_NOT_READY = {
  error: "container_not_ready",
  message:
    "Le container Docker n'est pas démarré. Démarre-le dans tes paramètres ou utilise la modal d'init.",
} as const;

/** État du conteneur illisible pour l'instant : rien à relancer. */
export const CONTAINER_NOT_READY_INSPECTION = {
  error: "container_not_ready",
  message: "La sandbox ne répond pas pour l'instant. Réessayez dans un instant.",
} as const;

/** Conteneur d'avant une mise à jour : la relance le recrée. */
export const CONTAINER_A_RELANCER = {
  error: "container_not_ready",
  message: "La sandbox doit être relancée avant d'ouvrir un terminal. Relancez-la depuis vos paramètres.",
} as const;

/** `PTY_MAX_PER_USER` (env, défaut : sessions nommées + 2) : plafond de PTY vivants par compte dans ce process. */
export function ptyMaxParCompte(env: NodeJS.ProcessEnv = process.env): number {
  try {
    return intPy(env["PTY_MAX_PER_USER"] ?? String(MAX_SESSIONS_PER_USER + 2));
  } catch {
    return MAX_SESSIONS_PER_USER + 2;
  }
}

/** `_build_pty_docker_cmd` : argv `docker exec -it` du terminal, sous l'UID du compte, sans étape root. */
export function construireCommandePty(conteneur: string): string[] {
  return [
    "docker",
    "exec",
    "-it",
    "--user",
    PTY_EXEC_USER,
    "--workdir",
    "/work",
    "-e",
    "TERM=xterm-256color",
    "-e",
    "LANG=C.UTF-8",
    "-e",
    "LC_ALL=C.UTF-8",
    "-e",
    `PATH=${PATH_COMPTE}`,
    "-e",
    `NPM_CONFIG_PREFIX=${PREFIXE_NPM}`,
    "-e",
    "GIT_CONFIG_COUNT=1",
    "-e",
    "GIT_CONFIG_KEY_0=safe.directory",
    "-e",
    "GIT_CONFIG_VALUE_0=*",
    conteneur,
    "/bin/sh",
    "-c",
    TERM_BOOTSTRAP,
  ];
}

/** Lecteur d'un PTY : données, fin du shell, remplacement par une connexion plus récente. */
export interface Consommateur {
  donnees(morceau: Buffer): void;
  fin(): void;
  remplace(): void;
}

/** Lancement d'un PTY (node-pty en production, remplaçable en test). */
export type LanceurPty = (fichier: string, args: string[], env: Record<string, string>) => IPty;

type NodePty = typeof NodePtyModule;
let nodePty: NodePty | null = null;

/** node-pty chargé au premier PTY (module natif à côté du bundle) : un binaire absent ne bloque que le terminal. */
export function chargerNodePty(): NodePty {
  nodePty ??= createRequire(import.meta.url)("node-pty") as NodePty;
  return nodePty;
}

/** Internes de node-pty lus ici : fd maître (non bloquant) et socket de lecture, détruite avant la fermeture du fd. */
interface PtyInterne {
  fd?: unknown;
  _socket?: { destroyed?: boolean };
}

/** Maître fermé ou en cours de fermeture : plus aucun appel sur son fd (il peut être réattribué). */
function maitreFerme(pty: IPty): boolean {
  return (pty as unknown as PtyInterne)._socket?.destroyed === true;
}

export const lanceurNodePty: LanceurPty = (fichier, args, env) =>
  chargerNodePty().spawn(fichier, args, { name: "xterm-256color", cols: 80, rows: 24, env, encoding: null });

/** État d'un PTY (`state` du Python) : le flux n'est lu que tant qu'un consommateur est branché et ne demande pas de pause. */
export class Terminal {
  readonly uid: number;
  readonly sid: string;
  readonly racine: string;
  readonly conteneur: string;
  readonly pid: number;
  alive = true;
  sorti = false;
  lastIo = Date.now() / 1000;
  streamEpoch = 0;
  private readonly pty: IPty;
  private consommateur: Consommateur | null = null;
  private pression = false;
  private enPause = true;
  private readonly creeA = performance.now();
  private rattrapage = false;
  private sortieVue = false;
  private tailleEnAttente = false;
  private readonly attente: Buffer[] = [];
  private octetsEnAttente = 0;
  private reessai: NodeJS.Timeout | undefined;

  constructor(pty: IPty, uid: number, sid: string, racine: string, conteneur: string) {
    this.pty = pty;
    this.pid = pty.pid;
    this.uid = uid;
    this.sid = sid;
    this.racine = racine;
    this.conteneur = conteneur;
    pty.pause();
    pty.onData((d: string | Buffer) => {
      this.lastIo = Date.now() / 1000;
      if (!this.sortieVue) {
        this.sortieVue = true;
        if (this.tailleEnAttente) setTimeout(() => this.signalerTaille(), APRES_PREMIERE_SORTIE_MS).unref();
      }
      this.consommateur?.donnees(typeof d === "string" ? Buffer.from(d, "utf-8") : d);
    });
    pty.onExit(() => {
      this.sorti = true;
      const c = this.consommateur;
      this.consommateur = null;
      c?.fin();
    });
  }

  /** Branche un lecteur (nouvelle époque) ; l'ancien est prévenu qu'il est remplacé. Rend l'époque, ou -1 si le shell est déjà fini. */
  attacher(c: Consommateur): number {
    this.streamEpoch += 1;
    const ancien = this.consommateur;
    this.consommateur = c;
    this.pression = false;
    if (ancien !== null && ancien !== c) ancien.remplace();
    if (this.sorti) {
      this.consommateur = null;
      c.fin();
      return -1;
    }
    this.ajuster();
    return this.streamEpoch;
  }

  detacher(c: Consommateur): void {
    if (this.consommateur !== c) return;
    this.consommateur = null;
    this.ajuster();
  }

  /** Contre-pression du lecteur courant : lecture suspendue (le shell se bloque comme dans un vrai terminal), puis reprise. */
  pause(c: Consommateur, active: boolean): void {
    if (this.consommateur !== c) return;
    this.pression = active;
    this.ajuster();
  }

  private ajuster(): void {
    const pause = this.consommateur === null || this.pression || this.sorti;
    if (pause === this.enPause) return;
    this.enPause = pause;
    if (pause) this.pty.pause();
    else this.pty.resume();
  }

  /** Frappe vers le shell : écrite tout de suite dans le maître non bloquant, le reste gardé (1 Mio au plus) ; lève si le terminal est fermé ou saturé. */
  ecrire(octets: Buffer): void {
    if (this.sorti || !this.alive || maitreFerme(this.pty)) throw new Error("terminal closed");
    const fd = (this.pty as unknown as PtyInterne).fd;
    if (typeof fd !== "number") {
      this.pty.write(octets);
      this.lastIo = Date.now() / 1000;
      return;
    }
    if (this.octetsEnAttente + octets.length > PLAFOND_ECRITURE) throw new Error("terminal saturé");
    if (octets.length) {
      this.attente.push(octets);
      this.octetsEnAttente += octets.length;
    }
    this.lastIo = Date.now() / 1000;
    this.vider(fd);
  }

  /** Écritures synchrones (fd non bloquant, jamais après sa fermeture) ; EAGAIN : nouvel essai peu après. */
  private vider(fd: number): void {
    clearTimeout(this.reessai);
    this.reessai = undefined;
    while (this.attente.length) {
      if (this.sorti || maitreFerme(this.pty)) {
        this.attente.length = 0;
        this.octetsEnAttente = 0;
        return;
      }
      const tete = this.attente[0] as Buffer;
      let n: number;
      try {
        n = writeSync(fd, tete);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "EAGAIN") {
          this.reessai = setTimeout(() => this.vider(fd), REESSAI_ECRITURE_MS);
          this.reessai.unref();
        } else {
          this.attente.length = 0;
          this.octetsEnAttente = 0;
        }
        return;
      }
      this.octetsEnAttente -= n;
      if (n < tete.length) this.attente[0] = tete.subarray(n);
      else this.attente.shift();
    }
  }

  /** `TIOCSWINSZ` puis SIGWINCH ; une taille hors de `unsigned short` est ignorée comme l'échec de `struct.pack`. */
  redimensionner(lignes: number, colonnes: number): void {
    if (lignes > TAILLE_MAX || colonnes > TAILLE_MAX || this.sorti || maitreFerme(this.pty)) return;
    try {
      this.pty.resize(colonnes, lignes);
    } catch {
      return;
    }
    this.signalerTaille();
    if (!this.sortieVue) this.tailleEnAttente = true;
    const age = performance.now() - this.creeA;
    if (this.rattrapage || age >= (RATTRAPAGES_MS.at(-1) ?? 0)) return;
    this.rattrapage = true;
    for (const d of RATTRAPAGES_MS) setTimeout(() => this.signalerTaille(), Math.max(0, d - age)).unref();
  }

  /** SIGWINCH au client docker (qui relit la taille) tant que le shell vit. */
  private signalerTaille(): void {
    if (this.sorti || maitreFerme(this.pty)) return;
    try {
      process.kill(this.pid, "SIGWINCH");
    } catch {
      return;
    }
  }

  /** `_kill_terminal` : SIGKILL du client docker ; node-pty ferme le maître et recueille l'enfant. */
  tuer(): void {
    this.alive = false;
    clearTimeout(this.reessai);
    this.attente.length = 0;
    this.octetsEnAttente = 0;
    if (!this.sorti && !maitreFerme(this.pty)) this.pty.kill("SIGKILL");
  }
}

/** `_terminals` et son verrou : un PTY par (compte, session), créé au plus une fois à la fois. */
export class Terminaux {
  private readonly table = new Map<string, Terminal>();
  private readonly enCreation = new Map<string, Promise<Terminal>>();
  /** Générations des arrêts (clé, compte, tout) : une création commencée avant un arrêt qui la vise est abandonnée. */
  private generation = 0;
  private readonly generationsCompte = new Map<number, number>();
  private readonly generationsCle = new Map<string, number>();
  private readonly journal: Journal;
  private readonly lanceur: LanceurPty;
  private readonly maxParCompte: number;
  private readonly reconcilier: (uid: number, username: string) => Promise<boolean>;

  constructor(o: {
    journal: Journal;
    lanceur?: LanceurPty;
    maxParCompte?: number;
    reconcilier?: (uid: number, username: string) => Promise<boolean>;
  }) {
    this.journal = o.journal;
    this.lanceur = o.lanceur ?? lanceurNodePty;
    this.maxParCompte = o.maxParCompte ?? ptyMaxParCompte();
    this.reconcilier = o.reconcilier ?? reconcilierBac;
  }

  private static cle(uid: number, sid: string): string {
    return `${uid}\0${sid}`;
  }

  get taille(): number {
    return this.table.size;
  }

  /** PTY vivants d'un compte (tests, diagnostic). */
  duCompte(uid: number): Terminal[] {
    return [...this.table.values()].filter((t) => t.uid === uid);
  }

  /** `_get_or_create_terminal` : PTY existant si son shell vit, sinon un neuf (503 si le conteneur ne tourne pas). */
  async obtenir(uid: number, sid: string = DEFAULT_SID): Promise<Terminal> {
    const cle = Terminaux.cle(uid, sid);
    const deja = this.table.get(cle);
    if (deja !== undefined) {
      if (deja.alive && !deja.sorti) return deja;
      deja.tuer();
      this.table.delete(cle);
    }
    const encours = this.enCreation.get(cle);
    if (encours !== undefined) return encours;
    const creation = this.creer(uid, sid, cle).finally(() => this.enCreation.delete(cle));
    this.enCreation.set(cle, creation);
    return creation;
  }

  private marque(uid: number, cle: string): string {
    return `${this.generation}/${this.generationsCompte.get(uid) ?? 0}/${this.generationsCle.get(cle) ?? 0}`;
  }

  private async creer(uid: number, sid: string, cle: string): Promise<Terminal> {
    const marque = this.marque(uid, cle);
    const nom = await usernameFor(uid);
    const racine = await racineTravail(nom);
    const conteneur = containerName(safeSandboxName(nom));
    if (!(await enMarche(conteneur))) throw new HttpError(503, { ...CONTAINER_NOT_READY });
    let durci: boolean;
    try {
      durci = await this.reconcilier(uid, nom);
    } catch (e) {
      this.journal.warn(
        `[pty] terminal refusé dans ${conteneur} : conteneur non remis à jour (${e instanceof Error ? e.message : String(e)})`,
      );
      throw new HttpError(503, { ...CONTAINER_NOT_READY });
    }
    const sure = await entreeSure(conteneur, durci);
    if (sure !== true) {
      this.journal.warn(
        `[pty] terminal refusé dans ${conteneur} : ${sure === null ? "inspection impossible" : "conteneur à relancer (options d'avant la mise à jour ou surchargées)"}`,
      );
      throw new HttpError(503, {
        ...(sure === null ? CONTAINER_NOT_READY_INSPECTION : CONTAINER_A_RELANCER),
      });
    }
    if (this.marque(uid, cle) !== marque) throw new Error("terminal fermé pendant sa création");
    const argv = construireCommandePty(conteneur);
    const mien = this.duCompte(uid);
    if (mien.length >= this.maxParCompte) {
      const victime = mien.reduce((a, b) => (b.lastIo < a.lastIo ? b : a));
      this.journal.info(
        `[pty] cap user atteint (uid=${uid}, ${mien.length} PTYs) → éviction ${victime.sid.slice(0, 8)}`,
      );
      victime.tuer();
      this.table.delete(Terminaux.cle(uid, victime.sid));
    }
    const pty = this.lanceur(binaireDocker(), argv.slice(1), {
      PATH: PATH_ENFANT,
      TERM: "xterm-256color",
      HOME: "/tmp",
    });
    const t = new Terminal(pty, uid, sid, racine, conteneur);
    this.table.set(cle, t);
    return t;
  }

  /** `_terminals.pop((uid, sid))` puis `_kill_terminal` ; vrai si un PTY a été tué. */
  tuerSession(uid: number, sid: string): boolean {
    const cle = Terminaux.cle(uid, sid);
    if (this.enCreation.has(cle)) this.generationsCle.set(cle, (this.generationsCle.get(cle) ?? 0) + 1);
    const t = this.table.get(cle);
    if (t === undefined) return false;
    this.table.delete(cle);
    t.tuer();
    return true;
  }

  /** `kill_user_terminals` : tous les PTY du compte (relais en 4001, révocation). */
  tuerDuCompte(uid: number): number {
    this.generationsCompte.set(uid, (this.generationsCompte.get(uid) ?? 0) + 1);
    const tues = this.duCompte(uid).filter((t) => this.tuerSession(uid, t.sid)).length;
    if (tues) this.journal.info(`[PTY] révocation uid=${uid} : ${tues} terminal(aux) tué(s).`);
    return tues;
  }

  /** `shutdown_all_terminals`. */
  tuerTout(): number {
    this.generation += 1;
    const tous = [...this.table.values()];
    this.table.clear();
    for (const t of tous) t.tuer();
    if (tous.length) this.journal.info(`[PTY] Shutdown: ${tous.length} terminal(aux) fermé(s).`);
    return tous.length;
  }

  /** `_cleanup_idle_terminals` (PTY seulement) : inactifs depuis plus de 30 min. */
  nettoyerInactifs(maintenant = Date.now() / 1000): number {
    let tues = 0;
    for (const t of [...this.table.values()]) {
      if (t.lastIo && maintenant - t.lastIo > PTY_IDLE_TIMEOUT_S && this.tuerSession(t.uid, t.sid)) tues += 1;
    }
    if (tues)
      this.journal.info(
        `[PTY] ${tues} terminal(aux) inactif(s) fermé(s) (>${Math.floor(PTY_IDLE_TIMEOUT_S / 60)}min).`,
      );
    return tues;
  }
}

/** `docker inspect --format {{.State.Running}}` (5 s) : seul « true » compte ; binaire absent ou délai : arrêté. */
async function enMarche(conteneur: string): Promise<boolean> {
  try {
    const r = await appelDocker(["inspect", "--format", "{{.State.Running}}", conteneur], 5_000);
    return r.code === 0 && stripPy(decoderRemplace(r.sortie)).toLowerCase() === "true";
  } catch {
    return false;
  }
}

/** Conteneur du compte remis à jour des réglages (sudo, profil, protections) avant d'y entrer ; rend le durcissement attendu. */
async function reconcilierBac(uid: number, username: string): Promise<boolean> {
  const bac = await bacDuCompteConnu(uid, username);
  await bac.ensureRunning();
  return bac.durci(bac.networkProfile);
}

/** Entrée directe permise dans ce conteneur (`entreePermise` de @elpis/bac ; `durci` : no-new-privileges exigé) ; `null` : inspection impossible. */
async function entreeSure(conteneur: string, durci: boolean): Promise<boolean | null> {
  try {
    const r = await appelDocker(["inspect", "--format", FORMAT_ENTREE, conteneur], 5_000);
    return r.code === 0 ? entreePermise(decoderRemplace(r.sortie), PTY_EXEC_USER, durci) : null;
  } catch {
    return null;
  }
}
