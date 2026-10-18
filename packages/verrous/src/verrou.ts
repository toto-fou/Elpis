// SPDX-License-Identifier: MIT
/** packages/verrous/src/verrou.ts — verrou inter-processus elpis.verrou.v1.1 (O_EXCL, péremption, reprise sous R.lock.reprise), commun avec shared_infra/runtime/verrou_fichier.py. */
import { randomBytes } from "node:crypto";
import { constants, readFileSync, readlinkSync } from "node:fs";
import { hostname } from "node:os";
import path from "node:path";
import { setTimeout as dormirAsync } from "node:timers/promises";
import { isMainThread } from "node:worker_threads";

import { FlottantPy, fixePy, pyJsonDumps, pyJsonLoads, stripPy, strPy } from "@elpis/commun";

import { demarrerBattement } from "./battement";
import {
  bloc,
  creerDossier,
  dormir,
  ecrireFd,
  effacer,
  etatFd,
  etatLien,
  executer,
  executerSync,
  fermer,
  lier,
  lireFd,
  ouvrir,
  renommer,
  synchroniserFd,
} from "./es";
import type { Proc } from "./es";
import { journalDe } from "./ports";

export const VERSION = 1;
export const PEREMPTION_DEFAUT_MS = 120_000;
export const SUFFIXE_REPRISE = ".reprise";
export const SUFFIXE_PERIME = ".perime.";
const ATTENTE_MIN_MS = 10;
const ATTENTE_MAX_MS = 200;
const REPRISE_ATTENTE_MIN_MS = 1;
const REPRISE_ATTENTE_MAX_MS = 20;
const ESSAIS = 8;
const ILLISIBLES_MAX = 256;
const DRAPEAUX_LECTURE = constants.O_RDONLY | constants.O_NOFOLLOW;
const DRAPEAUX_CREATION = constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW;
const VIDE = Buffer.alloc(0);
const DECODEUR = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** Durées que les tests raccourcissent (`ILLISIBLE_S`, `ATTENTE_SIGNALEE_S`, `REPRISE_PEREMPTION_S` de Python). */
export interface Reglages {
  illisibleMs: number;
  attenteSignaleeMs: number;
  reprisePeremptionMs: number;
}

const reglages: Reglages = { illisibleMs: 5_000, attenteSignaleeMs: 30_000, reprisePeremptionMs: 10_000 };

/** Aide de test : remplace des durées et rend la fonction qui remet les précédentes. */
export function surchargerReglages(partiel: Partial<Reglages>): () => void {
  const avant = { ...reglages };
  Object.assign(reglages, partiel);
  return () => {
    Object.assign(reglages, avant);
  };
}

interface EtatProcessus {
  processus: string | null;
  dernierDebut: number;
  debutsTenus: Set<number>;
  illisibles: Map<string, number>;
  machine: [string, string] | null;
}

/** Une seule copie par processus, même si le paquet est chargé deux fois (règle 2 : `debut` tenu par CE processus). */
const etat: EtatProcessus = ((globalThis as unknown as Record<symbol, EtatProcessus | undefined>)[
  Symbol.for("elpis.verrou.v1.1")
] ??= { processus: null, dernierDebut: 0, debutsTenus: new Set(), illisibles: new Map(), machine: null });

/** Délai dépassé : le verrou reste tenu par un détenteur vivant (`VerrouOccupe(TimeoutError)` de Python). */
export class VerrouOccupe extends Error {
  override name = "VerrouOccupe";
}

const log = (): ReturnType<typeof journalDe> => journalDe("verrou");

function codeErreur(e: unknown): string | undefined {
  const code = (e as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : undefined;
}

/** Erreur d'E/S (l'`OSError` de Python) : une autre exception est un défaut du code et remonte. */
function estErreurSysteme(e: unknown): boolean {
  return e instanceof Error && codeErreur(e) !== undefined;
}

function decrire(e: unknown): string {
  return e instanceof Error ? `${codeErreur(e) ?? e.name}: ${e.message}` : String(e);
}

/** Les registres de prises sont par fil : un fil de travail jugerait périmées les prises du fil principal (règle 2). */
function exigerFilPrincipal(): void {
  if (!isMainThread)
    throw new Error("@elpis/verrous : verrous de fichiers réservés au fil principal du processus");
}

export function definirProcessus(nom: string | null | undefined): void {
  etat.processus = stripPy(nom ?? "") || null;
}

/** Nom déclaré, sinon `APP_SERVICE` ou `APP_MODE`, sinon « node ». */
export function nomProcessus(): string {
  return etat.processus || process.env["APP_SERVICE"] || process.env["APP_MODE"] || "node";
}

/** `R.lock` à côté d'un fichier, `R/.lock` dans un répertoire. */
export function cheminVerrou(ressource: string, options: { repertoire?: boolean } = {}): string {
  if (options.repertoire) return path.join(ressource, ".lock");
  return path.join(path.dirname(ressource), path.basename(ressource) + ".lock");
}

/** Faux seulement quand `kill(pid, 0)` répond ESRCH. */
export function pidVivant(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return codeErreur(e) !== "ESRCH";
  }
}

function lireTexteAscii(chemin: string): string {
  try {
    const octets = readFileSync(chemin);
    return octets.some((o) => o > 0x7f) ? "" : stripPy(octets.toString("latin1"));
  } catch {
    return "";
  }
}

function lireLien(chemin: string): string {
  try {
    return readlinkSync(chemin);
  } catch {
    return "";
  }
}

/** (hôte, identifiant de démarrage, espace de PID) de ce processus ; vides quand inconnus. */
export function identiteMachine(): [string, string, string] {
  etat.machine ??= [lireTexteAscii("/proc/sys/kernel/random/boot_id"), lireLien("/proc/self/ns/pid")];
  return [hostname(), etat.machine[0], etat.machine[1]];
}

/** `debut` strictement croissant dans le processus, noté comme tenu avant même la création du fichier. */
function reserverDebut(): number {
  const debut = Math.max(Date.now(), etat.dernierDebut + 1);
  etat.dernierDebut = debut;
  etat.debutsTenus.add(debut);
  return debut;
}

function libererDebut(debut: number): void {
  etat.debutsTenus.delete(debut);
}

/** Instant (monotone) où ce fichier illisible a été vu la première fois par ce processus. */
function illisibleDepuis(cle: string): number {
  const maintenant = performance.now();
  if (etat.illisibles.size >= ILLISIBLES_MAX) {
    for (const [k, t] of etat.illisibles) if (maintenant - t > 600_000) etat.illisibles.delete(k);
    if (etat.illisibles.size >= ILLISIBLES_MAX) etat.illisibles.clear();
  }
  const vu = etat.illisibles.get(cle);
  if (vu !== undefined) return vu;
  etat.illisibles.set(cle, maintenant);
  return maintenant;
}

/** Contenu valide ; champ facultatif absent = `undefined`, mal typé = vide (`boot`, `nspid`) ou absent (`peremption`). */
export interface Contenu {
  pid: number;
  hote: string;
  debut: number;
  proc: unknown;
  boot: string | undefined;
  nspid: string | undefined;
  peremption: number | undefined;
}

export interface EtatFichier {
  dev: bigint;
  ino: bigint;
  mtimeNs: bigint;
  brut: Buffer;
  contenu: Contenu | null;
  interdit: boolean;
}

function estEntierPy(x: unknown): boolean {
  return (typeof x === "number" && Number.isInteger(x)) || typeof x === "bigint";
}

/** `int` ou `float` fini de Python (jamais un booléen), en nombre ; `null` sinon. */
function nombreFini(x: unknown): number | null {
  const n = x instanceof FlottantPy ? x.valeur : typeof x === "bigint" ? Number(x) : x;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

/** Contenu d'une ligne de verrou, ou `null` si un champ obligatoire est invalide (`_decoder` de Python). */
export function decoderContenu(brut: Uint8Array): Contenu | null {
  let d: unknown;
  try {
    d = pyJsonLoads(DECODEUR.decode(brut));
  } catch {
    return null;
  }
  if (typeof d !== "object" || d === null || Object.getPrototypeOf(d) !== Object.prototype) return null;
  const o = d as Record<string, unknown>;
  const lire = (cle: string): unknown => (Object.hasOwn(o, cle) ? o[cle] : undefined);
  const v = lire("v");
  if (!estEntierPy(v) || Number(v) !== VERSION) return null;
  const pid = lire("pid");
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0 || pid >= 2 ** 31) return null;
  const hote = lire("hote");
  const debut = nombreFini(lire("debut"));
  if (typeof hote !== "string" || debut === null) return null;
  const texte = (cle: string): string | undefined => {
    const x = lire(cle);
    return x === undefined ? undefined : typeof x === "string" ? x : "";
  };
  return {
    pid,
    hote,
    debut,
    proc: lire("proc"),
    boot: texte("boot"),
    nspid: texte("nspid"),
    peremption: nombreFini(lire("peremption")) ?? undefined,
  };
}

/** Ligne écrite à la prise : JSON compact, clés dans l'ordre de la spec, `\n` final. */
export function ligneVerrou(
  pid: number,
  debut: number,
  processus: string,
  peremptionMs: number,
  machine: readonly [string, string, string] = identiteMachine(),
): Buffer {
  const [hote, boot, nspid] = machine;
  const contenu = {
    v: VERSION,
    pid,
    hote,
    debut,
    proc: processus,
    boot,
    nspid,
    peremption: Math.trunc(peremptionMs),
  };
  return Buffer.from(pyJsonDumps(contenu, { ensureAscii: false, separators: [",", ":"] }) + "\n", "utf8");
}

/** État du fichier, `null` s'il est absent ; une erreur d'E/S autre que « interdit » ou « lien » remonte. */
export function* lireVerrouP(chemin: string): Proc<EtatFichier | null> {
  let fd: number;
  try {
    fd = yield* ouvrir(chemin, DRAPEAUX_LECTURE);
  } catch (e) {
    const code = codeErreur(e);
    if (code === "ENOENT") return null;
    if (code !== "EACCES" && code !== "EPERM" && code !== "ELOOP") throw e;
    let st;
    try {
      st = yield* etatLien(chemin);
    } catch (e2) {
      if (codeErreur(e2) === "ENOENT") return null;
      throw e2;
    }
    return {
      dev: st.dev,
      ino: st.ino,
      mtimeNs: st.mtimeNs,
      brut: VIDE,
      contenu: null,
      interdit: code !== "ELOOP",
    };
  }
  try {
    const st = yield* etatFd(fd);
    let brut: Buffer = VIDE;
    try {
      brut = yield* lireFd(fd);
    } catch (e) {
      if (codeErreur(e) !== "EISDIR") throw e;
    }
    return {
      dev: st.dev,
      ino: st.ino,
      mtimeNs: st.mtimeNs,
      brut,
      contenu: decoderContenu(brut),
      interdit: false,
    };
  } finally {
    yield* fermer(fd);
  }
}

export function lireVerrou(chemin: string): Promise<EtatFichier | null> {
  return executer(lireVerrouP(chemin));
}

function memeFichier(a: EtatFichier, b: EtatFichier): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.mtimeNs === b.mtimeNs && a.brut.equals(b.brut);
}

function* supprimerP(chemin: string): Proc<void> {
  try {
    yield* effacer(chemin);
  } catch (e) {
    if (codeErreur(e) === "ENOENT") return;
    if (!estErreurSysteme(e)) throw e;
    log().warn(`${chemin} non supprimé : ${decrire(e)}`);
  }
}

function* existeLienP(chemin: string): Proc<boolean> {
  try {
    yield* etatLien(chemin);
    return true;
  } catch {
    return false;
  }
}

/** Création exclusive portant `ligne` ; faux si le chemin existe, ou n'est plus notre fichier une fois écrit. */
export function* creerVerrouP(chemin: string, ligne: Uint8Array, annexe = false): Proc<boolean> {
  let fd: number;
  try {
    fd = yield* ouvrir(chemin, DRAPEAUX_CREATION, 0o600);
  } catch (e) {
    if (codeErreur(e) === "EEXIST") return false;
    if (codeErreur(e) !== "ENOENT") throw e;
    yield* creerDossier(path.dirname(chemin));
    try {
      fd = yield* ouvrir(chemin, DRAPEAUX_CREATION, 0o600);
    } catch (e2) {
      if (codeErreur(e2) === "EEXIST") return false;
      throw e2;
    }
  }
  let ident: [bigint, bigint] | null = null;
  let lie: boolean;
  try {
    try {
      const st = yield* etatFd(fd);
      ident = [st.dev, st.ino];
      yield* ecrireFd(fd, ligne);
      if (!annexe) yield* synchroniserFd(fd);
      lie = (yield* etatFd(fd)).nlink > 0n;
    } finally {
      yield* fermer(fd);
    }
  } catch (e) {
    if (ident !== null) {
      try {
        yield* effacerSiP(chemin, ident, annexe);
      } catch (e2) {
        if (!estErreurSysteme(e2)) throw e2;
      }
    }
    throw e;
  }
  let st;
  try {
    st = yield* etatLien(chemin);
  } catch (e) {
    if (codeErreur(e) === "ENOENT") return false;
    throw e;
  }
  return lie && st.dev === ident[0] && st.ino === ident[1];
}

export function creerVerrou(chemin: string, ligne: Uint8Array, annexe = false): Promise<boolean> {
  return executer(creerVerrouP(chemin, ligne, annexe));
}

/** Supprime `chemin` s'il est encore l'inode `ident` ; sous `R.lock.reprise`, sauf pour la reprise même. */
function* effacerSiP(chemin: string, ident: [bigint, bigint], annexe: boolean): Proc<void> {
  const effacerSiMeme = function* (): Proc<void> {
    const st = yield* etatLien(chemin);
    if (st.dev === ident[0] && st.ino === ident[1]) yield* supprimerP(chemin);
  };
  if (annexe) yield* bloc(effacerSiMeme());
  else yield* sousRepriseP(chemin, null, () => bloc(effacerSiMeme()));
}

/** Règles de péremption de la spec v1.1 (PID, redémarrage, âge du mtime, contenu illisible). */
export function raisonPerime(e: EtatFichier, peremptionMs: number, fixe = false): string | null {
  const ageMs = Date.now() - Number(e.mtimeNs) / 1e6;
  if (e.interdit) return ageMs > peremptionMs ? "illisible pour ce compte et trop ancien" : null;
  const c = e.contenu;
  if (c === null) {
    const vu = illisibleDepuis(`${e.dev}:${e.ino}:${e.mtimeNs}`);
    const limite = reglages.illisibleMs;
    return ageMs > limite || performance.now() - vu > limite ? "contenu illisible" : null;
  }
  const limiteMs = fixe ? peremptionMs : Math.max(peremptionMs, c.peremption || 0);
  const [hote, boot, nspid] = identiteMachine();
  if (c.hote === hote) {
    if (boot && c.boot && c.boot !== boot) return "pris avant le redémarrage de la machine";
    if ((c.boot === undefined || c.boot === boot) && (c.nspid === undefined || c.nspid === nspid)) {
      if (c.pid === process.pid) {
        if (!etat.debutsTenus.has(c.debut)) return "pris par un processus précédent de même PID";
      } else if (!pidVivant(c.pid)) {
        return `pid ${c.pid} absent`;
      }
    }
  }
  if (ageMs > limiteMs) {
    const proc = c.proc === undefined ? "None" : strPy(c.proc);
    return `inchangé depuis plus de ${fixePy(limiteMs / 1000, 0)} s (${proc}, pid ${c.pid}, ${c.hote})`;
  }
  return null;
}

/** `R.lock.reprise` : sous lui seul, `R.lock` peut être supprimé (reprise d'un périmé ou rendu). */
export class Reprise {
  readonly chemin: string;
  private readonly processus: string | null;
  private octets: Buffer = VIDE;
  private debut = 0;

  constructor(verrou: string, processus: string | null) {
    this.chemin = verrou + SUFFIXE_REPRISE;
    this.processus = processus;
  }

  /** Notre reprise est-elle encore en place ? Revérifié juste avant de supprimer `R.lock`. */
  *tenue(): Proc<boolean> {
    try {
      const e = yield* lireVerrouP(this.chemin);
      return e !== null && e.brut.equals(this.octets);
    } catch (e) {
      if (!estErreurSysteme(e)) throw e;
      return false;
    }
  }

  *entrer(): Proc<void> {
    let attente = REPRISE_ATTENTE_MIN_MS;
    for (;;) {
      const debut = reserverDebut();
      const octets = ligneVerrou(
        process.pid,
        debut,
        this.processus ?? nomProcessus(),
        reglages.reprisePeremptionMs,
      );
      let pris: boolean;
      try {
        pris = yield* creerVerrouP(this.chemin, octets, true);
      } catch (e) {
        libererDebut(debut);
        throw e;
      }
      if (pris) {
        this.octets = octets;
        this.debut = debut;
        return;
      }
      libererDebut(debut);
      const e = yield* lireVerrouP(this.chemin);
      if (e !== null && raisonPerime(e, reglages.reprisePeremptionMs, true) !== null) {
        yield* bloc(this.casser(e));
        continue;
      }
      yield* dormir(attente);
      attente = Math.min(attente * 2, REPRISE_ATTENTE_MAX_MS);
    }
  }

  *sortir(): Proc<void> {
    try {
      const e = yield* lireVerrouP(this.chemin);
      if (e !== null && e.brut.equals(this.octets)) yield* supprimerP(this.chemin);
      else log().warn(`${this.chemin} : reprise cassée par un autre processus avant d'être rendue`);
    } catch (e) {
      if (!estErreurSysteme(e)) throw e;
      const dans = fixePy(reglages.reprisePeremptionMs / 1000, 0);
      log().warn(`${this.chemin} non rendue (${decrire(e)}) : périmée dans ${dans} s`);
    } finally {
      libererDebut(this.debut);
    }
  }

  /** Faute de troisième niveau : renommage, relecture, suppression si identique, sinon remise en place. */
  *casser(e: EtatFichier): Proc<void> {
    const deplace = this.chemin + SUFFIXE_PERIME + randomBytes(6).toString("hex");
    try {
      yield* renommer(this.chemin, deplace);
    } catch (x) {
      if (codeErreur(x) === "ENOENT") return;
      throw x;
    }
    let relu: EtatFichier | null = null;
    try {
      relu = yield* lireVerrouP(deplace);
    } catch (x) {
      if (!estErreurSysteme(x)) throw x;
    }
    if (relu !== null && memeFichier(relu, e)) {
      yield* supprimerP(deplace);
      return;
    }
    try {
      yield* lier(deplace, this.chemin);
    } catch (x) {
      if (!estErreurSysteme(x)) throw x;
      if (!(yield* existeLienP(this.chemin))) {
        try {
          yield* renommer(deplace, this.chemin);
          return;
        } catch (y) {
          if (!estErreurSysteme(y)) throw y;
        }
      }
      log().warn(`${this.chemin} : reprise vivante déplacée par erreur, non remise`);
    }
    yield* supprimerP(deplace);
  }
}

function* sousRepriseP<T>(verrou: string, processus: string | null, f: (r: Reprise) => Proc<T>): Proc<T> {
  const reprise = new Reprise(verrou, processus);
  yield* reprise.entrer();
  try {
    return yield* f(reprise);
  } finally {
    yield* reprise.sortir();
  }
}

export interface OptionsVerrou {
  /** Attente maximale ; `null` (défaut) = sans délai, bornée par la péremption du détenteur. */
  delaiMs?: number | null;
  peremptionMs?: number;
  processus?: string | null;
  battement?: boolean;
}

interface Prise {
  debut: number;
  octets: Buffer;
}

/** Verrou elpis.verrou.v1.1 sur `chemin` : non réentrant, une prise à la fois par instance. */
export class VerrouFichier {
  readonly chemin: string;
  readonly delaiMs: number | null;
  readonly peremptionMs: number;
  readonly processus: string | null;
  readonly battement: boolean;
  private prise: Prise | null = null;
  private arreterBattement: (() => void) | null = null;
  private nettoyage: Promise<void> | null = null;

  constructor(chemin: string, options: OptionsVerrou = {}) {
    exigerFilPrincipal();
    this.chemin = chemin;
    this.delaiMs =
      options.delaiMs === null || options.delaiMs === undefined ? null : Math.max(0, options.delaiMs);
    this.peremptionMs = options.peremptionMs ?? PEREMPTION_DEFAUT_MS;
    this.processus = options.processus ?? null;
    this.battement = options.battement ?? false;
  }

  get tenu(): boolean {
    return this.prise !== null;
  }

  /** Une prise sans attente, reprise d'un verrou périmé comprise ; le battement part dès la prise. */
  async essayer(): Promise<boolean> {
    if (this.nettoyage !== null) await this.nettoyage;
    if (!(await executer(this.essayerP()))) return false;
    if (this.battement) {
      try {
        const octets = (this.prise as Prise).octets;
        this.arreterBattement = demarrerBattement(this.chemin, Math.max(50, this.peremptionMs / 3), octets);
      } catch (e) {
        await this.rendre();
        throw e;
      }
    }
    return true;
  }

  /** Attente de 10 ms doublée jusqu'à 200 ms, jamais bloquante ; `VerrouOccupe` au-delà du délai ; annulable par `signal`. */
  async acquerir(options: { signal?: AbortSignal } = {}): Promise<void> {
    const signal = options.signal;
    signal?.throwIfAborted();
    const debut = performance.now();
    let attente = ATTENTE_MIN_MS;
    let signale = false;
    while (!(await this.essayerAnnulable(signal))) {
      const reste = this.reste(debut);
      signale ||= await executer(this.signalerAttenteP(debut));
      try {
        await dormirAsync(reste === null ? attente : Math.min(attente, reste), undefined, { signal });
      } catch (e) {
        if (signal?.aborted) throw signal.reason;
        throw e;
      }
      attente = Math.min(attente * 2, ATTENTE_MAX_MS);
    }
  }

  /** Sous `R.lock.reprise` : supprime le verrou s'il porte encore nos octets ; sinon avertit seulement. Jamais interrompu. */
  async rendre(): Promise<void> {
    const prise = this.detacher();
    if (prise !== null) await executer(this.rendreP(prise));
  }

  /** Prise SYNCHRONE (attente bloquante), réservée au code synchrone d'initialisation : secret de session, clé de chiffrement. */
  acquerirSync(): void {
    if (this.battement) throw new Error("@elpis/verrous : le battement exige la prise asynchrone");
    const debut = performance.now();
    let attente = ATTENTE_MIN_MS;
    let signale = false;
    while (!executerSync(this.essayerP())) {
      const reste = this.reste(debut);
      signale ||= executerSync(this.signalerAttenteP(debut));
      executerSync(dormir(reste === null ? attente : Math.min(attente, reste)));
      attente = Math.min(attente * 2, ATTENTE_MAX_MS);
    }
  }

  rendreSync(): void {
    const prise = this.detacher();
    if (prise !== null) executerSync(this.rendreP(prise));
  }

  /** Reprise d'un état lu et jugé périmé : supprimé seulement s'il est inchangé et la reprise encore à nous. */
  async reprendre(e: EtatFichier, raison: string): Promise<void> {
    await executer(this.reprendreP(e, raison));
  }

  private *essayerP(): Proc<boolean> {
    if (this.prise !== null) throw new Error(`verrou ${this.chemin} déjà tenu par cette instance`);
    for (let i = 0; i < ESSAIS; i++) {
      if (yield* this.prendreP()) return true;
      const e = yield* lireVerrouP(this.chemin);
      if (e === null) continue;
      const raison = raisonPerime(e, this.peremptionMs);
      if (raison === null) return false;
      yield* this.reprendreP(e, raison);
    }
    return false;
  }

  private *prendreP(): Proc<boolean> {
    const debut = reserverDebut();
    const octets = ligneVerrou(process.pid, debut, this.processus ?? nomProcessus(), this.peremptionMs);
    let pris: boolean;
    try {
      pris = yield* creerVerrouP(this.chemin, octets);
    } catch (e) {
      libererDebut(debut);
      throw e;
    }
    if (!pris) {
      libererDebut(debut);
      return false;
    }
    this.prise = { debut, octets };
    return true;
  }

  private *reprendreP(e: EtatFichier, raison: string): Proc<void> {
    const chemin = this.chemin;
    const decision = function* (reprise: Reprise): Proc<boolean> {
      const relu = yield* lireVerrouP(chemin);
      if (relu === null || !memeFichier(relu, e) || !(yield* reprise.tenue())) return false;
      yield* supprimerP(chemin);
      return true;
    };
    const supprime = yield* sousRepriseP(chemin, this.processus, (reprise) => bloc(decision(reprise)));
    if (!supprime) return;
    if (e.contenu === null) log().debug(`${this.chemin} périmé repris : ${raison}`);
    else log().info(`${this.chemin} périmé repris : ${raison}`);
  }

  private detacher(): Prise | null {
    const prise = this.prise;
    this.prise = null;
    if (prise !== null) {
      this.arreterBattement?.();
      this.arreterBattement = null;
    }
    return prise;
  }

  private *rendreP(prise: Prise): Proc<void> {
    const chemin = this.chemin;
    try {
      const decision = function* (reprise: Reprise): Proc<void> {
        const e = yield* lireVerrouP(chemin);
        if (e === null || !e.brut.equals(prise.octets))
          log().warn(
            `${chemin} repris par un autre processus avant d'être rendu (tenu au-delà de sa péremption ?)`,
          );
        else if (yield* reprise.tenue()) yield* supprimerP(chemin);
        else log().warn(`${chemin} non rendu : reprise cassée par un autre processus`);
      };
      yield* sousRepriseP(chemin, this.processus, (reprise) => bloc(decision(reprise)));
    } catch (e) {
      if (!estErreurSysteme(e)) throw e;
      log().warn(`${chemin} non rendu : ${decrire(e)}`);
    } finally {
      libererDebut(prise.debut);
    }
  }

  /** Une tentative n'est jamais coupée : annulée en cours, elle s'achève à part et rend le verrou s'il a été pris. */
  private async essayerAnnulable(signal: AbortSignal | undefined): Promise<boolean> {
    const tentative = this.essayer();
    if (signal === undefined) return tentative;
    return new Promise<boolean>((resolve, reject) => {
      const abandon = (): void => {
        this.nettoyage = tentative
          .then(async (pris) => {
            if (pris) await this.rendre();
          })
          .catch((e: unknown) => log().warn(`${this.chemin} : tentative annulée en échec (${decrire(e)})`))
          .finally(() => {
            this.nettoyage = null;
          });
        reject(signal.reason);
      };
      if (signal.aborted) return abandon();
      signal.addEventListener("abort", abandon, { once: true });
      tentative.then(
        (pris) => {
          signal.removeEventListener("abort", abandon);
          resolve(pris);
        },
        (e: unknown) => {
          signal.removeEventListener("abort", abandon);
          reject(e);
        },
      );
    });
  }

  private reste(debut: number): number | null {
    if (this.delaiMs === null) return null;
    const reste = this.delaiMs - (performance.now() - debut);
    if (reste <= 0)
      throw new VerrouOccupe(`verrou ${this.chemin} occupé depuis ${fixePy(this.delaiMs / 1000, 1)} s`);
    return reste;
  }

  /** Une fois par attente, passé 30 s : journalise qui tient le verrou. */
  private *signalerAttenteP(debut: number): Proc<boolean> {
    if (performance.now() - debut < reglages.attenteSignaleeMs) return false;
    let c: Contenu | null = null;
    try {
      c = (yield* lireVerrouP(this.chemin))?.contenu ?? null;
    } catch (e) {
      if (!estErreurSysteme(e)) throw e;
    }
    const proc = c === null || c.proc === undefined ? "?" : strPy(c.proc);
    const ecoule = fixePy((performance.now() - debut) / 1000, 0);
    log().warn(
      `${this.chemin} attendu depuis ${ecoule} s : tenu par ${proc} (pid ${c?.pid ?? "?"}, ${c?.hote ?? "?"})`,
    );
    return true;
  }
}

/** Exécute `f` sous le verrou de `chemin`, rendu dans tous les cas. */
export async function avecVerrou<T>(
  chemin: string,
  options: OptionsVerrou & { signal?: AbortSignal },
  f: () => Promise<T>,
): Promise<T> {
  const verrou = new VerrouFichier(chemin, options);
  await verrou.acquerir({ signal: options.signal });
  try {
    return await f();
  } finally {
    await verrou.rendre();
  }
}

/** Pendant synchrone d'`avecVerrou` (attente bloquante) : seulement pour du code synchrone d'initialisation. */
export function avecVerrouSync<T>(chemin: string, options: OptionsVerrou, f: () => T): T {
  const verrou = new VerrouFichier(chemin, options);
  verrou.acquerirSync();
  try {
    return f();
  } finally {
    verrou.rendreSync();
  }
}
