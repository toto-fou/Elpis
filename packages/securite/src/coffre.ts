// SPDX-License-Identifier: MIT
/** packages/securite/src/coffre.ts — coffre « Secrets » : AES-256-GCM (AAD propre au secret, `kid` de la clé), clé hors base (env, fichier système, repli 0600 créé sous verrou). */
import { createCipheriv, createDecipheriv, createSecretKey, randomBytes } from "node:crypto";
import type { KeyObject } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeSync,
} from "node:fs";
import { dirname, isAbsolute, join } from "node:path";

import { avecVerrouSync } from "@elpis/verrous";

import { identifiantCle } from "./audit";
import { journalDe } from "./ports";

/** Clé système posée par `sudo ./elpis vault setup` (0440 root, groupe du seul compte des services). */
export const FICHIER_CLE_COFFRE = "/etc/elpis/vault.key";
/** Nom du fichier de repli, dans le dossier de la base. */
export const REPLI_CLE_COFFRE = ".vault.key";

const TAILLE_CLE = 32;
const TAILLE_NONCE = 12;
const TAILLE_TAG = 16;
/** `v1.<kid>.<nonce>.<chiffré‖tag>` : kid en 8 chiffres hexadécimaux, base64url sans remplissage. */
const FORME = /^v1\.([0-9a-f]{8})\.([A-Za-z0-9_-]{16})\.([A-Za-z0-9_-]{22,})$/u;
const ATTENTE_ECRITURE_MS = 1_000;
const ATTENTE = new Int32Array(new SharedArrayBuffer(4));

export type SourceCleCoffre = "env" | "fichier" | "repli";

/** Clé du coffre chargée : la clé AES elle-même reste dans un `KeyObject`. */
export interface CleCoffre {
  readonly cle: KeyObject;
  readonly kid: string;
  readonly source: SourceCleCoffre;
  readonly chemin: string | null;
}

/** `ELPIS_VAULT_KEY`, `ELPIS_VAULT_KEY_PATH` (explicite : jamais de repli s'il manque), clé système par défaut (changée par les essais seulement) et fichier de repli (absolu). */
export interface ReglagesCoffre {
  cleEnv?: string | null | undefined;
  fichier?: string | null | undefined;
  systeme?: string | undefined;
  repli: string;
}

/** Secret illisible avec les clés connues (forme, autre clé, donnée altérée) : jamais rendu vide. */
export class SecretIndechiffrable extends Error {
  readonly motif: "forme" | "cle" | "integrite";
  readonly kid: string | null;
  constructor(motif: "forme" | "cle" | "integrite", kid: string | null) {
    super(
      motif === "forme"
        ? "secret du coffre mal formé"
        : motif === "cle"
          ? `secret chiffré par une autre clé (kid ${kid ?? "?"})`
          : "secret du coffre altéré ou AAD différente",
    );
    this.name = "SecretIndechiffrable";
    this.motif = motif;
    this.kid = kid;
  }
}

/** Clé du coffre introuvable, illisible ou invalide : rien n'est chiffré ni déchiffré. */
export class CleCoffreIndisponible extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CleCoffreIndisponible";
  }
}

const ATTENDU = "32 octets en base64 canonique (ou 64 chiffres hexadécimaux) attendus";

/** Validateur unique des clés du coffre (cœur, `vault setup`, doctor) : base64 canonique de 32 octets (44 caractères, comme `base64`) ou 64 chiffres hexadécimaux, blancs ASCII autour ignorés, jamais un seul octet répété ; rend aussi le `kid`. */
export function validerCleCoffre(texte: string): { octets: Buffer; kid: string } | { motif: string } {
  const t = texte.replace(/^[\t\n\v\f\r ]+|[\t\n\v\f\r ]+$/gu, "");
  let octets: Buffer | null = null;
  if (/^[0-9a-fA-F]{64}$/u.test(t)) octets = Buffer.from(t, "hex");
  else if (/^[A-Za-z0-9+/]{43}=$/u.test(t)) {
    const lus = Buffer.from(t, "base64");
    if (lus.length === TAILLE_CLE && lus.toString("base64") === t) octets = lus;
  }
  if (octets === null) return { motif: ATTENDU };
  const premier = octets[0];
  if (octets.every((o) => o === premier)) return { motif: "clé dégénérée (un seul octet répété)" };
  return { octets, kid: identifiantCle(octets) };
}

/** Octets d'une clé valide (`validerCleCoffre`), `null` sinon. */
export function octetsCleCoffre(texte: string): Buffer | null {
  const v = validerCleCoffre(texte);
  return "octets" in v ? v.octets : null;
}

function cleDe(octets: Buffer, source: SourceCleCoffre, chemin: string | null): CleCoffre {
  return { cle: createSecretKey(octets), kid: identifiantCle(octets), source, chemin };
}

function codeErreur(e: unknown): unknown {
  return (e as { code?: unknown } | null)?.code;
}

type LectureCle =
  | { etat: "absent" }
  | { etat: "vide" }
  | { etat: "invalide"; motif: string }
  | { etat: "ok"; cle: CleCoffre };

/** Fichier de clé : absent (ENOENT, ENOTDIR), vide, invalide ou lu ; illisible (droits) : lève, sans repli. */
function lireFichier(chemin: string, source: SourceCleCoffre): LectureCle {
  let brut: Buffer;
  try {
    brut = readFileSync(chemin);
  } catch (e) {
    const code = codeErreur(e);
    if (code === "ENOENT" || code === "ENOTDIR") return { etat: "absent" };
    throw new CleCoffreIndisponible(`clé du coffre ${chemin} illisible (${String(code ?? e)})`);
  }
  const texte = brut.toString("latin1");
  if (!texte.trim()) return { etat: "vide" };
  const v = validerCleCoffre(texte);
  return "motif" in v
    ? { etat: "invalide", motif: v.motif }
    : { etat: "ok", cle: cleDe(v.octets, source, chemin) };
}

/** Motif lisible d'une lecture qui n'a pas donné de clé. */
function motifLecture(lue: Exclude<LectureCle, { etat: "ok" }>): string {
  return lue.etat === "invalide" ? `invalide (${lue.motif})` : lue.etat;
}

/** Clé d'un fichier donné (`rekey --from`, essais) : absente, vide ou invalide → `CleCoffreIndisponible`. */
export function lireCleCoffre(chemin: string): CleCoffre {
  const lue = lireFichier(chemin, "fichier");
  if (lue.etat === "ok") return lue.cle;
  throw new CleCoffreIndisponible(
    lue.etat === "absent"
      ? `clé du coffre ${chemin} absente`
      : `clé du coffre ${chemin} ${motifLecture(lue)}`,
  );
}

/** Relecture sous verrou : un fichier vide ou incomplet peut être en cours d'écriture par un autre process. */
function relireSousVerrou(chemin: string): LectureCle {
  const fin = performance.now() + ATTENTE_ECRITURE_MS;
  let lue = lireFichier(chemin, "repli");
  while ((lue.etat === "vide" || lue.etat === "invalide") && performance.now() < fin) {
    Atomics.wait(ATTENTE, 0, 0, 50);
    lue = lireFichier(chemin, "repli");
  }
  return lue;
}

function fsyncDossier(dossier: string): void {
  let fd: number;
  try {
    fd = openSync(dossier, "r");
  } catch {
    return;
  }
  try {
    fsyncSync(fd);
  } catch {
    /* système sans fsync de dossier */
  } finally {
    closeSync(fd);
  }
}

/** Création exclusive 0600, écrite et synchronisée ; faux si le fichier existe ; jamais laissé vide. */
function ecrireExclusif(chemin: string, contenu: string): boolean {
  let fd: number;
  try {
    fd = openSync(chemin, "wx", 0o600);
  } catch (e) {
    if (codeErreur(e) === "EEXIST") return false;
    throw e;
  }
  try {
    writeSync(fd, contenu);
    fsyncSync(fd);
  } catch (e) {
    closeSync(fd);
    rmSync(chemin, { force: true });
    throw e;
  }
  closeSync(fd);
  return true;
}

/** Clé de repli publiée d'un coup (temporaire 0600 lié au nom final, création exclusive sans liens durs) ; une clé posée entre-temps l'emporte. */
function creerRepli(chemin: string): CleCoffre {
  const octets = randomBytes(TAILLE_CLE);
  const contenu = `${octets.toString("base64")}\n`;
  const temporaire = `${chemin}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  let publiee = false;
  try {
    if (!ecrireExclusif(temporaire, contenu)) throw new CleCoffreIndisponible(`${temporaire} existe déjà`);
    try {
      linkSync(temporaire, chemin);
      publiee = true;
    } catch (e) {
      if (codeErreur(e) !== "EEXIST") publiee = ecrireExclusif(chemin, contenu);
    }
  } finally {
    rmSync(temporaire, { force: true });
  }
  if (publiee) {
    fsyncDossier(dirname(chemin));
    return cleDe(octets, "repli", chemin);
  }
  const posee = lireFichier(chemin, "repli");
  if (posee.etat === "ok") return posee.cle;
  throw new CleCoffreIndisponible(`clé de repli ${chemin} ${motifLecture(posee)} aussitôt créée`);
}

/** Repli `<dossier de la base>/.vault.key` : lu, sinon créé sous `.vault.key.lock` si `creer` ; `null` s'il manque et n'est pas à créer ; toute erreur du système de fichiers (droits, disque plein) devient `CleCoffreIndisponible`. */
function cleDeRepli(chemin: string, creer: boolean): CleCoffre | null {
  if (!isAbsolute(chemin))
    throw new CleCoffreIndisponible(`chemin de la clé de repli non absolu : ${chemin}`);
  const lue = lireFichier(chemin, "repli");
  if (lue.etat === "ok") return lue.cle;
  if (lue.etat === "absent" && !creer) return null;
  try {
    mkdirSync(dirname(chemin), { recursive: true, mode: 0o700 });
    return avecVerrouSync(`${chemin}.lock`, {}, () => {
      const relue = relireSousVerrou(chemin);
      if (relue.etat === "ok") return relue.cle;
      if (relue.etat !== "absent")
        throw new CleCoffreIndisponible(
          `clé de repli ${chemin} ${motifLecture(relue)} : laissée intacte, à vérifier`,
        );
      return creer ? creerRepli(chemin) : null;
    });
  } catch (e) {
    if (e instanceof CleCoffreIndisponible) throw e;
    throw new CleCoffreIndisponible(
      `clé de repli ${chemin} impossible à créer (${String(codeErreur(e) ?? (e instanceof Error ? e.message : e))})`,
    );
  }
}

let reglages: ReglagesCoffre | null = null;
let courante: CleCoffre | null = null;

/** Source de la clé (démarrage, commandes, essais) ; la résolution reste paresseuse et mémorisée une fois trouvée. */
export function configurerCoffre(r: ReglagesCoffre): void {
  reglages = r;
  courante = null;
}

/** Réglages lus dans l'environnement ; le repli est `.vault.key` dans le dossier de la base. */
export function reglagesCoffreDeLEnvironnement(env: NodeJS.ProcessEnv, dossierBase: string): ReglagesCoffre {
  return {
    cleEnv: env["ELPIS_VAULT_KEY"],
    fichier: env["ELPIS_VAULT_KEY_PATH"],
    repli: join(dossierBase, REPLI_CLE_COFFRE),
  };
}

function reglagesExiges(): ReglagesCoffre {
  if (reglages === null) throw new Error("coffre non configuré : appeler configurerCoffre() au démarrage");
  return reglages;
}

/** Résolution sans mémoire : env, puis fichier système (explicite : jamais de repli), puis repli. */
function resoudre(r: ReglagesCoffre, creer: boolean): CleCoffre | null {
  const env = r.cleEnv?.trim();
  if (env) {
    const v = validerCleCoffre(env);
    if ("motif" in v) throw new CleCoffreIndisponible(`ELPIS_VAULT_KEY invalide : ${v.motif}`);
    return cleDe(v.octets, "env", null);
  }
  const explicite = r.fichier?.trim() || null;
  const fichier = explicite ?? r.systeme ?? FICHIER_CLE_COFFRE;
  const lue = lireFichier(fichier, "fichier");
  if (lue.etat === "ok") return lue.cle;
  if (lue.etat !== "absent" || explicite !== null)
    throw new CleCoffreIndisponible(
      lue.etat === "absent"
        ? `ELPIS_VAULT_KEY_PATH=${fichier} absent`
        : `clé du coffre ${fichier} ${motifLecture(lue)}`,
    );
  return cleDeRepli(r.repli, creer);
}

/** Clé courante ; `creer` pose la clé de repli à défaut de toute autre ; `null` sans clé (et sans création). */
export function cleCoffre(o: { creer?: boolean } = {}): CleCoffre | null {
  if (courante !== null) return courante;
  courante = resoudre(reglagesExiges(), o.creer === true);
  if (courante?.source === "repli")
    journalDe("coffre").warn(
      `coffre : clé de repli ${courante.chemin ?? "?"} en usage, emportée par les sauvegardes de la base ; ` +
        "sudo ./elpis vault setup pose une clé hors base (/etc/elpis/vault.key)",
    );
  return courante;
}

/** `kid` de la clé courante, sans rien créer ; `null` tant qu'aucune clé n'existe. */
export function kidCoffre(): string | null {
  return cleCoffre()?.kid ?? null;
}

/** Clé courante, ou clé de repli posée faute de toute autre : à n'appeler que sur un coffre vide (sinon ses secrets resteraient illisibles). */
export function chargerCleCoffre(): CleCoffre {
  const cle = cleCoffre({ creer: true });
  if (cle === null) throw new CleCoffreIndisponible("aucune clé du coffre");
  return cle;
}

/** Clé courante exigée, jamais créée. */
function cleExistante(): CleCoffre {
  const cle = cleCoffre();
  if (cle === null) throw new CleCoffreIndisponible("aucune clé du coffre");
  return cle;
}

/** État de la clé pour le doctor et `vault status` (sans rien créer ni mémoriser) : source, chemin, kid, erreur. */
export function etatCleCoffre(r: ReglagesCoffre = reglagesExiges()): {
  source: SourceCleCoffre | "absente";
  chemin: string | null;
  kid: string | null;
  erreur: string | null;
} {
  try {
    const cle = resoudre(r, false);
    return cle === null
      ? { source: "absente", chemin: null, kid: null, erreur: null }
      : { source: cle.source, chemin: cle.chemin, kid: cle.kid, erreur: null };
  } catch (e) {
    return { source: "absente", chemin: null, kid: null, erreur: e instanceof Error ? e.message : String(e) };
  }
}

/** `v1.<kid>.<nonce>.<chiffré‖tag>` : nonce aléatoire de 96 bits, tag de 128 bits, AAD liée au secret ; sans clé donnée, la clé courante (jamais créée ici). */
export function chiffrerSecret(clair: string, aad: string, cle: CleCoffre = cleExistante()): string {
  if (typeof clair !== "string" || !clair.isWellFormed() || !aad.isWellFormed())
    throw new TypeError("secret du coffre : texte bien formé attendu");
  const nonce = randomBytes(TAILLE_NONCE);
  const c = createCipheriv("aes-256-gcm", cle.cle, nonce, { authTagLength: TAILLE_TAG });
  c.setAAD(Buffer.from(aad, "utf8"));
  const corps = Buffer.concat([c.update(clair, "utf8"), c.final(), c.getAuthTag()]);
  return `v1.${cle.kid}.${nonce.toString("base64url")}.${corps.toString("base64url")}`;
}

/** base64url sans remplissage, refusé s'il n'est pas canonique. */
function base64urlStrict(texte: string): Buffer | null {
  const octets = Buffer.from(texte, "base64url");
  return octets.toString("base64url") === texte ? octets : null;
}

/** `kid` porté par un secret chiffré, `null` s'il est mal formé. */
export function kidDe(enc: string): string | null {
  return FORME.exec(enc)?.[1] ?? null;
}

/** Clair du secret ; lève `SecretIndechiffrable` (forme, clé inconnue, altération ou autre AAD), jamais `""`. */
export function dechiffrerSecret(enc: string, aad: string, cles?: readonly CleCoffre[]): string {
  const m = typeof enc === "string" ? FORME.exec(enc) : null;
  if (m === null) throw new SecretIndechiffrable("forme", null);
  const kid = m[1] ?? "";
  const nonce = base64urlStrict(m[2] ?? "");
  const corps = base64urlStrict(m[3] ?? "");
  if (nonce?.length !== TAILLE_NONCE || corps === null || corps.length < TAILLE_TAG)
    throw new SecretIndechiffrable("forme", kid);
  const candidates = cles ?? [cleCoffre()].filter((c): c is CleCoffre => c !== null);
  const cle = candidates.find((c) => c.kid === kid);
  if (cle === undefined) throw new SecretIndechiffrable("cle", kid);
  try {
    const d = createDecipheriv("aes-256-gcm", cle.cle, nonce, { authTagLength: TAILLE_TAG });
    d.setAAD(Buffer.from(aad, "utf8"));
    d.setAuthTag(corps.subarray(corps.length - TAILLE_TAG));
    const clair = Buffer.concat([d.update(corps.subarray(0, corps.length - TAILLE_TAG)), d.final()]);
    return new TextDecoder("utf-8", { fatal: true }).decode(clair);
  } catch {
    throw new SecretIndechiffrable("integrite", kid);
  }
}
