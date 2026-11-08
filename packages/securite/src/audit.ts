// SPDX-License-Identifier: MIT
/** packages/securite/src/audit.ts — journal de sécurité JSONL quotidien : format v1 à champs fixes, ligne signée (HMAC) et numérotée par écrivain, écriture O_APPEND atomique. */
import { createHash, createHmac, createSecretKey, randomBytes } from "node:crypto";
import type { KeyObject } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fchownSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { hostname } from "node:os";
import { join, resolve } from "node:path";

import { estCleEntiere, FlottantPy, pyJsonDumps, reprFlottant, strPy, veritePy } from "@elpis/commun";

import { journalDe } from "./ports";

const PIPE_BUF = 4096;
const DOSSIER_PROD = "/var/lib/elpis/audit";
const BLANCS_ASCII = new Set([0x20, 0x09, 0x0a, 0x0d, 0x0b, 0x0c]);
/** Version du format des lignes (champ `v`) : incrémentée à tout changement de syntaxe ou de sens. */
export const VERSION_AUDIT = 1;
const BATTEMENT_MS = 3_600_000;
/** Longueur maximale (points de code) d'`action`, `username` et `ip`. */
const CHAMP_MAX = 256;
/** Ouvertures sans attendre : un FIFO posé à la place d'un fichier ne bloque pas le process (ENXIO sans lecteur, refusé ensuite). */
const OUVERTURE_AJOUT = constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const OUVERTURE_CREATION = OUVERTURE_AJOUT | constants.O_CREAT | constants.O_EXCL;
const OUVERTURE_LECTURE = constants.O_RDONLY | constants.O_NONBLOCK;

export type IssueAudit = "success" | "failure" | "unknown";

/** Nom d'un fichier du journal (jour UTC en groupe 1) et forme d'un jour AAAA-MM-JJ. */
export const FICHIER_AUDIT = /^audit-(\d{4}-\d{2}-\d{2})\.jsonl$/u;
export const JOUR_AUDIT = /^\d{4}-\d{2}-\d{2}$/u;

export interface ReglagesAudit {
  service?: string;
  auditDir: string;
  hmacKeyPath: string;
  maintenant?: () => number;
  hote?: string;
}

export interface EvenementAudit {
  userId: number | null;
  username: string | null;
  action: string;
  details?: unknown;
  /** Absent : `failure` si l'action finit par `.denied` ou `.failed`, `success` sinon. */
  outcome?: IssueAudit;
  ip?: string | null;
}

interface Etat {
  service: string;
  dossier: string;
  cle: Buffer | null;
  cleHmac: KeyObject | null;
  kid: string | null;
  hote: string;
  maintenant: () => number;
}

/** Écrivain de ce process : identifiant tiré au hasard, numéro de la dernière ligne écrite, échecs d'écriture. */
interface Ecrivain {
  boot: string;
  seq: number;
  echecs: number;
  derniereErreur: string | null;
  battement: ReturnType<typeof setInterval> | null;
}

let etat: Etat | null = null;
/** Fichier du jour gardé ouvert (une ouverture par jour au lieu d'une par événement). */
let fichier: { chemin: string; fd: number } | null = null;
const nouvelEcrivain = (): Ecrivain => ({
  boot: randomBytes(8).toString("hex"),
  seq: 0,
  echecs: 0,
  derniereErreur: null,
  battement: null,
});
let ecrivain: Ecrivain = nouvelEcrivain();

function erreurDeDroits(e: unknown): boolean {
  const code = (e as { code?: unknown }).code;
  return code === "EACCES" || code === "EPERM";
}

function inscriptible(dossier: string): boolean {
  try {
    if (!existsSync(dossier)) return false;
    const test = join(dossier, ".write_test");
    closeSync(
      openSync(test, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NONBLOCK),
    );
    unlinkSync(test);
    return true;
  } catch {
    return false;
  }
}

/** `_default_audit_dir` : ELPIS_AUDIT_DIR, sinon /var/lib/elpis/audit s'il est inscriptible, sinon <racine>/logs/audit. */
export function defaultAuditDir(env: NodeJS.ProcessEnv, racine: string): string {
  const explicite = env["ELPIS_AUDIT_DIR"];
  if (explicite) return explicite;
  if (inscriptible(DOSSIER_PROD)) return DOSSIER_PROD;
  const repli = join(racine, "logs", "audit");
  mkdirSync(repli, { recursive: true, mode: 0o750 });
  return repli;
}

export function defaultAuditKeyPath(env: NodeJS.ProcessEnv): string {
  return env["ELPIS_AUDIT_KEY_PATH"] || "/etc/elpis/audit.key";
}

function stripAscii(b: Buffer): Buffer {
  let debut = 0;
  let fin = b.length;
  while (debut < fin && BLANCS_ASCII.has(b[debut] ?? 0)) debut++;
  while (fin > debut && BLANCS_ASCII.has(b[fin - 1] ?? 0)) fin--;
  return b.subarray(debut, fin);
}

/** Identifiant public d'une clé (8 premiers chiffres hexadécimaux de son SHA-256) : désigne la clé sans la révéler. */
export function identifiantCle(cle: Buffer): string {
  return createHash("sha256").update(cle).digest("hex").slice(0, 8);
}

/** Clés dont la lecture a été refusée (EACCES, EPERM), signalée une fois par chemin. */
const clesRefusees = new Set<string>();

/** Clé HMAC d'un fichier : au moins 32 octets après retrait des blancs ASCII, `null` sinon (absente, refusée, trop courte). */
export function lireCleAudit(chemin: string): Buffer | null {
  let lue: Buffer;
  try {
    lue = readFileSync(chemin);
  } catch (e) {
    const code = (e as { code?: unknown }).code;
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    if (!erreurDeDroits(e)) throw e;
    if (!clesRefusees.has(chemin)) {
      clesRefusees.add(chemin);
      journalDe("audit").warn(
        `clé HMAC de ${chemin} illisible (${String(code)}) : audit sans HMAC (groupe de la clé absent de ce process ? le relancer depuis une nouvelle session)`,
      );
    }
    return null;
  }
  const brute = stripAscii(lue);
  if (brute.length >= 32) return brute;
  journalDe("audit").warn(
    `clé HMAC de ${chemin} trop courte (${brute.length} octet(s) < 32) : audit sans HMAC`,
  );
  return null;
}

/** `configure` : service, dossier (créé en 0750, jamais rechmodé : il peut porter un groupe de lecture) et clé HMAC (illisible = sans HMAC). */
export function configureAudit(r: ReglagesAudit): void {
  fermerFichier();
  const cree = mkdirSync(r.auditDir, { recursive: true, mode: 0o750 });
  if (cree !== undefined) {
    try {
      chmodSync(r.auditDir, 0o750);
    } catch (e) {
      if (!erreurDeDroits(e)) throw e;
    }
  }
  const cle = lireCleAudit(r.hmacKeyPath);
  etat = {
    service: r.service || "main",
    dossier: r.auditDir,
    cle,
    cleHmac: cle ? createSecretKey(cle) : null,
    kid: cle ? identifiantCle(cle) : null,
    hote: r.hote ?? hostname(),
    maintenant: r.maintenant ?? (() => Date.now() / 1000),
  };
}

/** Oublie la configuration et l'écrivain (tests) : le prochain événement se reconfigure depuis l'environnement. */
export function oublierConfigurationAudit(): void {
  if (ecrivain.battement) clearInterval(ecrivain.battement);
  fermerFichier();
  etat = null;
  ecrivain = nouvelEcrivain();
}

/** Racine du dépôt comme `racineDepot()` de @elpis/config : `ELPIS_RACINE`, sinon trois niveaux au-dessus de ce fichier. */
function racineParDefaut(): string {
  const racine = process.env["ELPIS_RACINE"] || resolve(import.meta.dirname, "..", "..", "..");
  try {
    return realpathSync(racine);
  } catch {
    return racine;
  }
}

/** Sans `configureAudit`, réglages de l'environnement comme `_auto_configure` : un échec garde l'audit, sans HMAC. */
function etatCourant(): Etat {
  if (etat === null) {
    const service = (process.env["APP_SERVICE"] ?? "main").toLowerCase() || "main";
    const auditDir = defaultAuditDir(process.env, racineParDefaut());
    try {
      configureAudit({ service, auditDir, hmacKeyPath: defaultAuditKeyPath(process.env) });
    } catch {
      etat = {
        service,
        dossier: auditDir,
        cle: null,
        cleHmac: null,
        kid: null,
        hote: hostname(),
        maintenant: () => Date.now() / 1000,
      };
    }
  }
  return etat as Etat;
}

/** Jour UTC (nom du fichier) et horodatage RFC 3339 en millisecondes, en UTC (`Z`). */
function horodatage(t: number): { jour: string; time: string } {
  const time = new Date(Math.round(t * 1000)).toISOString();
  return { jour: time.slice(0, 10), time };
}

interface Enregistrement {
  time: string;
  ts: number;
  /** `"host":…,"service":…,"boot":…` déjà sérialisés (voir `enteteJson`). */
  entete: string;
  seq: number;
  action: string;
  outcome: IssueAudit;
  userId: number | null;
  username: string | null;
  ip: string | null;
}

/** JSON compact ; un nombre non fini resté dans un objet non simple fait lever (ligne `audit.event.lost`), jamais de `NaN` écrit. */
const json = (v: unknown): string =>
  pyJsonDumps(v, { ensureAscii: false, sortKeys: true, separators: [",", ":"], allowNan: false });

/** `json` d'un texte bien formé ou de `null` par JSON.stringify (mêmes octets) ; toute autre valeur repasse par `json`. */
const texteJson = (v: unknown): string =>
  v === null ? "null" : typeof v === "string" && v.isWellFormed() ? JSON.stringify(v) : json(v);

/** `json` d'un entier sûr ou de `null` par String (mêmes octets) ; un entier non sûr ou un flottant repasse par `json`. */
const entierJson = (v: number | null): string =>
  v === null ? "null" : Number.isSafeInteger(v) ? String(v) : json(v);

/** Hôte, service et écrivain sérialisés une fois par configuration et par écrivain. */
let entete: { etat: Etat; ecrivain: Ecrivain; texte: string } | null = null;
function enteteJson(s: Etat): string {
  if (entete?.etat !== s || entete.ecrivain !== ecrivain)
    entete = {
      etat: s,
      ecrivain,
      texte: `"host":${json(s.hote)},"service":${json(s.service)},"boot":${json(ecrivain.boot)}`,
    };
  return entete.texte;
}

/** `JSON.rawJSON` (Node 21+), absent des déclarations de TypeScript 6. */
const rawJSON = (JSON as unknown as { rawJSON(texte: string): unknown }).rawJSON;
const HORS_DOMAINE = new Error("détails hors du domaine de JSON.stringify");
const SUBSTITUTION = /[\uD800-\uDFFF]/;

/** `propre` et tri des clés en une copie que JSON.stringify écrit comme `json` ; lève HORS_DOMAINE (clé entière, `__proto__` ou à demi-paire, objet non simple, BigInt). */
function propreTrie(v: unknown, profondeur: number): unknown {
  if (typeof v === "string") return v.isWellFormed() ? v : v.toWellFormed();
  if (typeof v === "number") {
    if (!Number.isFinite(v)) return null;
    if (Number.isSafeInteger(v)) return v;
    return rawJSON(Number.isInteger(v) ? BigInt(v).toString() : reprFlottant(v));
  }
  if (v instanceof FlottantPy) return Number.isFinite(v.valeur) ? rawJSON(reprFlottant(v.valeur)) : null;
  if (v === null || v === undefined || typeof v === "boolean") return v;
  if (typeof v === "function" || typeof v === "symbol") return undefined;
  if (typeof v !== "object") throw HORS_DOMAINE;
  if (profondeur >= 16) return "[…]";
  const proto: unknown = Object.getPrototypeOf(v);
  if (Array.isArray(v)) {
    if (proto !== Array.prototype) throw HORS_DOMAINE;
    const sortie = new Array<unknown>(v.length);
    for (let i = 0; i < v.length; i++) sortie[i] = propreTrie(v[i], profondeur + 1);
    return sortie;
  }
  if (
    (proto !== Object.prototype && proto !== null) ||
    typeof (v as { toJSON?: unknown }).toJSON === "function"
  )
    throw HORS_DOMAINE;
  const cles = Object.keys(v);
  for (const k of cles) if (estCleEntiere(k) || k === "__proto__" || SUBSTITUTION.test(k)) throw HORS_DOMAINE;
  cles.sort();
  const sortie: Record<string, unknown> = {};
  for (const k of cles) sortie[k] = propreTrie((v as Record<string, unknown>)[k], profondeur + 1);
  return sortie;
}

/** Chemin rapide de `jsonDetails` (exporté pour les tests) : `propreTrie` puis JSON.stringify ; `null` hors du domaine simple ou à la moindre exception. */
export function jsonDetailsRapide(details: unknown): string | null {
  try {
    return (JSON.stringify(propreTrie(details, 0)) as string | undefined) ?? null;
  } catch {
    return null;
  }
}

/** `json(propre(details))` : chemin rapide, sinon l'ancien chemin, qui rend ses octets ou son exception. */
const jsonDetails = (details: unknown): string => jsonDetailsRapide(details) ?? json(propre(details));

/** Ligne v1 : champs dans un ordre fixe, JSON compact, `details` déjà sérialisés ; `kid` présent quand la ligne est signée. */
function corpsV1(r: Enregistrement, details: string, kid: string | null): string {
  return `{"v":${VERSION_AUDIT},"time":${texteJson(r.time)},"ts":${reprFlottant(r.ts)},${r.entete},"seq":${r.seq},"action":${texteJson(r.action)},"outcome":${texteJson(r.outcome)},"user_id":${entierJson(r.userId)},"username":${texteJson(r.username)},"ip":${texteJson(r.ip)},"details":${details}${kid === null ? "" : `,"kid":${texteJson(kid)}`}}`;
}

/** Signature HMAC-SHA256 du corps, ajoutée en dernier champ : la vérification retire `,"hmac":"…"` et recalcule, sans re-sérialiser. */
function ligneV1(r: Enregistrement, details: string, cle: KeyObject | null, kid: string | null): Buffer {
  const corps = corpsV1(r, details, cle ? kid : null);
  if (!corps.isWellFormed()) throw new Error("demi-paire UTF-16 : ligne non encodable en UTF-8");
  if (!cle) return Buffer.from(`${corps}\n`, "utf8");
  const hmac = createHmac("sha256", cle).update(corps, "utf8").digest("hex");
  return Buffer.from(`${corps.slice(0, -1)},"hmac":"${hmac}"}\n`, "utf8");
}

/** Issue d'une action sans issue explicite : `.denied` et `.failed` échouent. */
export function issueParDefaut(action: string): IssueAudit {
  return /\.(denied|failed)$/u.test(action) ? "failure" : "success";
}

/** Valeur prête à sérialiser : textes bien formés (clés comprises), nombres non finis en `null`, profondeur bornée. */
function propre(v: unknown, profondeur = 0): unknown {
  if (typeof v === "string") return v.isWellFormed() ? v : v.toWellFormed();
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (v instanceof FlottantPy) return Number.isFinite(v.valeur) ? v : null;
  if (v === null || typeof v !== "object") return v;
  if (profondeur >= 16) return "[…]";
  if (Array.isArray(v)) return v.map((x) => propre(x, profondeur + 1));
  if (Object.getPrototypeOf(v) !== Object.prototype && Object.getPrototypeOf(v) !== null) return v;
  const sortie: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v))
    sortie[k.isWellFormed() ? k : k.toWellFormed()] = propre(x, profondeur + 1);
  return sortie;
}

const borne = (v: string | null | undefined): string | null => (v == null ? null : texteBorne(v, CHAMP_MAX));

function fermerFichier(): void {
  if (fichier === null) return;
  try {
    closeSync(fichier.fd);
  } catch {
    /* déjà fermé */
  }
  fichier = null;
}

/** Fichier du jour ouvert sans suivre de lien : créé en 0640 (rendu au propriétaire du dossier si root) ou rouvert s'il a été retiré ; refusé s'il n'est pas un fichier régulier à un seul lien. */
function fdDuJour(dossier: string, jour: string): number {
  const chemin = `${dossier}/audit-${jour}.jsonl`;
  if (fichier !== null && fichier.chemin === chemin) {
    try {
      if (fstatSync(fichier.fd).nlink > 0) return fichier.fd;
    } catch {
      /* rouvert plus bas */
    }
  }
  fermerFichier();
  let fd: number;
  let cree = false;
  try {
    fd = openSync(chemin, OUVERTURE_CREATION, 0o640);
    cree = true;
  } catch (e) {
    const code = (e as { code?: unknown }).code;
    if (code === "ENOENT") {
      mkdirSync(dossier, { recursive: true, mode: 0o750 });
      fd = openSync(chemin, OUVERTURE_CREATION, 0o640);
      cree = true;
    } else if (code === "EEXIST") fd = openSync(chemin, OUVERTURE_AJOUT);
    else throw e;
  }
  const st = fstatSync(fd);
  if (!st.isFile() || st.nlink !== 1) {
    closeSync(fd);
    throw new Error(`${chemin} : pas un fichier régulier à un seul lien`);
  }
  if (cree) {
    try {
      fchmodSync(fd, 0o640);
      // Créé par un process root (commande d'administration) : rendu au propriétaire du dossier.
      if (process.getuid?.() === 0) {
        const d = statSync(dossier);
        fchownSync(fd, d.uid, d.gid);
      }
    } catch {
      /* au mieux : droits laissés tels quels */
    }
  }
  fichier = { chemin, fd };
  return fd;
}

/** `audit_event` : une ligne v1 dans audit-AAAA-MM-JJ.jsonl (jour UTC), en un seul write O_APPEND ; ne lève jamais. */
export function auditEvent(e: EvenementAudit): void {
  try {
    const s = etatCourant();
    const t = s.maintenant();
    const { jour, time } = horodatage(t);
    const r: Enregistrement = {
      time,
      ts: t,
      entete: enteteJson(s),
      seq: ecrivain.seq + 1,
      action: borne(e.action) ?? "",
      outcome: e.outcome ?? issueParDefaut(e.action),
      userId: typeof e.userId === "number" && Number.isFinite(e.userId) ? e.userId : null,
      username: borne(e.username),
      ip: borne(e.ip ?? null),
    };
    let octets: Buffer;
    try {
      const details = veritePy(e.details) ? e.details : {};
      octets = ligneV1(r, jsonDetails(details), s.cleHmac, s.kid);
      if (octets.length > PIPE_BUF) {
        const resumes = {
          _truncated: true,
          _orig_len: octets.length,
          summary: texteBorne(strPy(propre(details)), 500),
        };
        octets = ligneV1(r, json(resumes), s.cleHmac, s.kid);
      }
      if (octets.length > PIPE_BUF) {
        r.username = texteBorne(r.username ?? "", 32) || null;
        r.ip = texteBorne(r.ip ?? "", 64) || null;
        r.action = texteBorne(r.action, 64);
        octets = ligneV1(r, json({ _truncated: true, _orig_len: octets.length }), s.cleHmac, s.kid);
      }
    } catch (erreur) {
      // Ligne impossible à sérialiser : une ligne minimale garde la trace (et le numéro) de l'événement.
      r.action = "audit.event.lost";
      r.outcome = "unknown";
      r.username = null;
      r.ip = null;
      const perdu = {
        action: texteBorne(e.action, 64),
        error: texteBorne(erreur instanceof Error ? erreur.message : String(erreur), 200),
      };
      octets = ligneV1(r, json(perdu), s.cleHmac, s.kid);
    }
    const ecrits = writeSync(fdDuJour(s.dossier, jour), octets);
    if (ecrits !== octets.length) throw new Error(`écriture partielle (${ecrits}/${octets.length} octets)`);
    ecrivain.seq = r.seq;
  } catch (erreur) {
    ecrivain.echecs += 1;
    ecrivain.derniereErreur = erreur instanceof Error ? erreur.message : String(erreur);
    try {
      // Ligne de repli sur stderr : l'événement perdu reste au moins visible dans le journal du process.
      journalDe("audit").error(
        `audit_event a échoué (non-bloquant) : action=${e.action} user_id=${String(e.userId)}`,
        erreur,
      );
    } catch {
      /* comme Python : même le journal ne doit pas faire lever l'audit */
    }
  }
}

/** État de l'écrivain pour la console : dossier, signature, numéro de la dernière ligne, échecs. */
export function etatEcritureAudit(): {
  dossier: string;
  service: string;
  signe: boolean;
  kid: string | null;
  boot: string;
  seq: number;
  echecs: number;
  derniereErreur: string | null;
} {
  const s = etatCourant();
  return {
    dossier: s.dossier,
    service: s.service,
    signe: s.cle !== null,
    kid: s.kid,
    boot: ecrivain.boot,
    seq: ecrivain.seq,
    echecs: ecrivain.echecs,
    derniereErreur: ecrivain.derniereErreur,
  };
}

/** Texte bien formé (demi-paires remplacées) coupé à `max` points de code : jamais de caractère coupé en deux. */
export function texteBorne(texte: string, max: number): string {
  const propre = texte.toWellFormed();
  if (propre.length <= max) return propre;
  let n = 0;
  let fin = 0;
  for (const c of propre) {
    if (n === max) break;
    n += 1;
    fin += c.length;
  }
  return propre.slice(0, fin);
}

/** Clé de signature de ce process (vérification du journal par la console) ; `null` sans clé. */
export function cleAuditCourante(): Buffer | null {
  return etatCourant().cle;
}

/** Empreinte d'un identifiant saisi qui ne correspond à aucun compte : les tentatives se recoupent sans garder le texte (souvent un mot de passe tapé au mauvais endroit). */
export function empreinteIdentifiant(nom: string): string {
  const cle = etatCourant().cleHmac;
  const h = cle ? createHmac("sha256", cle) : createHash("sha256");
  return h.update(`identifiant:${nom}`, "utf8").digest("hex").slice(0, 16);
}

/** Dernière ligne v1 de cet hôte et de ce service dans la fin des fichiers du jour et de la veille (256 Kio lus au plus par fichier). */
function derniereLigneConnue(s: Etat): { boot: string; seq: number } | null {
  const t = s.maintenant();
  for (const jour of [horodatage(t).jour, horodatage(t - 86_400).jour]) {
    const chemin = `${s.dossier}/audit-${jour}.jsonl`;
    let fd: number;
    try {
      fd = openSync(chemin, OUVERTURE_LECTURE);
    } catch {
      continue;
    }
    try {
      const st = fstatSync(fd);
      if (!st.isFile()) continue;
      const taille = st.size;
      const n = Math.min(taille, 256 * 1024);
      const tampon = Buffer.alloc(n);
      readSync(fd, tampon, 0, n, taille - n);
      for (const texte of tampon.toString("utf8").split("\n").reverse()) {
        if (!texte.startsWith('{"v":')) continue;
        try {
          const rec = JSON.parse(texte) as Record<string, unknown>;
          if (rec["host"] === s.hote && rec["service"] === s.service && typeof rec["boot"] === "string")
            return { boot: rec["boot"], seq: Number(rec["seq"]) };
        } catch {
          continue;
        }
      }
    } catch {
      continue;
    } finally {
      closeSync(fd);
    }
  }
  return null;
}

/** Début d'écriture de ce process (`audit.writer.start`, avec la dernière ligne connue du précédent), puis un battement par heure. */
export function demarrerAudit(): void {
  const s = etatCourant();
  const precedent = derniereLigneConnue(s);
  auditEvent({
    userId: null,
    username: null,
    action: "audit.writer.start",
    details: { pid: process.pid, prev: precedent },
  });
  if (ecrivain.battement) clearInterval(ecrivain.battement);
  ecrivain.battement = setInterval(() => {
    auditEvent({
      userId: null,
      username: null,
      action: "audit.writer.heartbeat",
      details: { pid: process.pid, failures: ecrivain.echecs },
    });
  }, BATTEMENT_MS);
  ecrivain.battement.unref?.();
}

const avantArret = new Set<() => void>();

/** Rappel lancé par `arreterAudit` avant la ligne de fin (résumés de rafales en attente) ; rend sa désinscription. */
export function avantArretAudit(f: () => void): () => void {
  avantArret.add(f);
  return () => avantArret.delete(f);
}

/** Fin d'écriture propre (`audit.writer.stop`) : un écrivain sans elle s'est arrêté brutalement ou tourne encore. */
export function arreterAudit(): void {
  if (ecrivain.battement) clearInterval(ecrivain.battement);
  ecrivain.battement = null;
  for (const f of avantArret) {
    try {
      f();
    } catch {
      /* un rappel en échec ne retient pas la ligne de fin */
    }
  }
  auditEvent({ userId: null, username: null, action: "audit.writer.stop", details: { pid: process.pid } });
  fermerFichier();
}

/** `audit_code_exec` : empreinte SHA-256 et taille du code, jamais le code. */
export function auditCodeExec(e: {
  userId: number;
  username: string;
  kind: string;
  code: string;
  pipelineId: number | null;
  runId: string;
  nodeId: string;
  executor: string;
  extra?: Record<string, unknown> | null;
}): void {
  const empreinte = createHash("sha256")
    .update(e.code.replace(/[\uD800-\uDFFF]/gu, "?"), "utf8")
    .digest("hex");
  auditEvent({
    userId: e.userId,
    username: e.username,
    action: `code.exec.${e.kind}`,
    details: {
      code_sha256: empreinte,
      code_len: Array.from(e.code).length,
      pipeline_id: e.pipelineId,
      run_id: e.runId,
      node_id: e.nodeId,
      executor: e.executor,
      ...(e.extra ?? {}),
    },
  });
}

/** `audit_login` : connexion réussie ou refusée, déconnexion ; user-agent borné à 200 caractères. */
export function auditLogin(e: {
  userId: number | null;
  username: string | null;
  ip?: string | null;
  userAgent?: string | null;
  success?: boolean;
  reason?: string | null;
  /** Empreinte du compte saisi quand il n'existe pas (voir `empreinteIdentifiant`). */
  identifierHash?: string | null;
}): void {
  auditEvent({
    userId: e.userId,
    username: e.username,
    action: (e.success ?? true) ? "auth.login" : "auth.login.denied",
    ip: e.ip ?? null,
    details: {
      user_agent: Array.from(e.userAgent || "")
        .slice(0, 200)
        .join(""),
      reason: e.reason ?? null,
      ...(e.identifierHash ? { identifier_hash: e.identifierHash } : {}),
    },
  });
}
