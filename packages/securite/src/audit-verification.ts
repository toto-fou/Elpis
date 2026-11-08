// SPDX-License-Identifier: MIT
/** packages/securite/src/audit-verification.ts — vérification du journal de sécurité : signatures v1 et v0, continuité des numéros, fins d'écrivains, début couvert par la dernière purge, rejeux ; lecture en flux bornée. */
import { createHmac, createSecretKey, timingSafeEqual } from "node:crypto";
import type { KeyObject } from "node:crypto";
import { constants } from "node:fs";
import { open, readdir } from "node:fs/promises";
import { join } from "node:path";

import { FICHIER_AUDIT as FICHIER, identifiantCle, JOUR_AUDIT as JOUR } from "./audit";

/** Signature v1 : dernier champ de la ligne. */
const SIGNATURE_V1 = /,"hmac":"([0-9a-f]{64})"\}$/u;
/** Signature v0 : champ trié entre `details` et `iso` (format Python). */
const SIGNATURE_V0 = /, "hmac": "([0-9a-f]{64})"(?=, "iso": ")/gu;
const CLES_V0 = new Set(["action", "details", "hmac", "iso", "service", "ts", "user_id", "username"]);
/** Ligne plus longue : illisible (le format en écrit au plus 4096 octets). */
const LIGNE_MAX = 64 * 1024;
/** Entrées gardées par liste d'anomalies ; les totaux comptent tout. */
const LISTE_MAX = 1000;
/** Silence au-delà duquel un écrivain sans ligne de fin est signalé (battement horaire + marge). */
const SILENCE_S = 3600 + 600;
/** Âge de la dernière ligne d'un hôte au-delà duquel la fin du journal est incertaine (un battement par heure). */
const FIN_MAX_S = 2 * 3600;
/** Lignes signées récentes retenues pour reconnaître un rejeu identique ; un doublon plus ancien est un désordre. */
const RECENTES_MAX = 50_000;
/** Position d'une ligne : index de fichier × 2^24 + numéro de ligne. */
const POSITION = 2 ** 24;
const DEBUT_V1 = Buffer.from('{"v":');
/** Ligne `audit.purge` reconnue en octets avant tout JSON.parse (purges postérieures à `au`). */
const MOTIF_PURGE = Buffer.from(',"action":"audit.purge","outcome":');

export interface LigneEnCause {
  fichier: string;
  ligne: number;
}

export interface TrouAudit extends LigneEnCause {
  hote: string;
  service: string;
  boot: string;
  /** Numéros manquants, bornes comprises. */
  de: number;
  a: number;
  /** `milieu` : entre deux lignes ; `debut` : début d'écrivain sans purge qui l'explique ; `fin` : dernières lignes d'un écrivain (prev du suivant) ; `ecrivain` : écrivain entier absent ; `fichiers` : premier fichier postérieur au `kept_from` de la dernière purge (écrivain et numéros vides). */
  nature: "milieu" | "debut" | "fin" | "ecrivain" | "fichiers";
}

export interface EcrivainAudit {
  hote: string;
  service: string;
  boot: string;
  premier: number;
  dernier: number;
  lignes: number;
  /** `audit.writer.stop` vu : sinon arrêt brutal, ou écrivain encore actif. */
  arretPropre: boolean;
  /** Premières lignes antérieures à la période vérifiée (période choisie, ou purge signée). */
  debutAvantPeriode: boolean;
  /** Empreinte de la clé de ses lignes signées, `null` s'il n'en signe aucune. */
  kid: string | null;
}

/** Écrivain sans ligne de fin resté silencieux : arrêt brutal, ou dernières lignes supprimées avant un redémarrage. */
export interface FinIncertaine {
  hote: string;
  service: string;
  boot: string;
  dernierTs: number;
  raison: "silence_avant_suivant" | "silence_fin_periode";
}

/** Raison d'un statut `non_verifie` autre que les signatures. */
export interface MotifNonVerifie {
  /** `fin_ancienne` : dernière ligne de l'hôte trop vieille ; `fin_incertaine` : dernier écrivain d'un service sans ligne de fin ; `purge_sans_borne` : début expliqué par une purge sans `kept_from`. */
  nature: "fin_ancienne" | "fin_incertaine" | "purge_sans_borne";
  hote: string | null;
  service: string | null;
  dernierTs: number | null;
  texte: string;
}

export type StatutVerification = "intact" | "anomalies" | "non_verifie" | "vide";

export interface ResultatVerificationAudit {
  du: string | null;
  au: string | null;
  fichiers: string[];
  lignes: number;
  v0: number;
  signees: number;
  valides: number;
  sansSignature: number;
  cleInconnue: number;
  signaturesInvalides: LigneEnCause[];
  illisibles: LigneEnCause[];
  trous: TrouAudit[];
  desordres: LigneEnCause[];
  /** Lignes non signées, ou de clé inconnue, alors que des clés sont fournies. */
  nonVerifiees: LigneEnCause[];
  /** Écrivain dont les lignes changent de clé, ou mêlent signées et non signées. */
  incoherences: LigneEnCause[];
  /** Ligne dont l'horodatage n'est pas du jour de son fichier. */
  horsFichier: LigneEnCause[];
  /** Ligne v0 après une ligne v1 : le format Python n'est plus écrit. */
  v0Tardives: LigneEnCause[];
  /** Copie à l'octet d'une ligne validement signée (file rsyslog rejouée) : avertissement, pas une anomalie. */
  doublons: LigneEnCause[];
  ecrivains: EcrivainAudit[];
  finsIncertaines: FinIncertaine[];
  /** Fin ou début du journal non établis : statut `non_verifie` même avec toutes les signatures valides. */
  motifs: MotifNonVerifie[];
  /** Nombre total de chaque anomalie ou avertissement (les listes sont bornées à 1000). */
  totaux: Record<
    | "signaturesInvalides"
    | "illisibles"
    | "trous"
    | "desordres"
    | "nonVerifiees"
    | "incoherences"
    | "horsFichier"
    | "v0Tardives"
    | "doublons",
    number
  >;
  statut: StatutVerification;
  /** Statut `intact` : toutes les lignes signées et valides, aucune anomalie, début et fin établis. */
  integre: boolean;
}

interface Ecrivain extends EcrivainAudit {
  /** Suites de numéros consécutifs dans l'ordre de lecture : premier et dernier numéro, position de la première ligne. */
  suitesDe: number[];
  suitesA: number[];
  suitesLieu: number[];
  premierFichier: number;
  /** Fichier en cours et plus grand numéro qui y a été lu (désordre dans un fichier). */
  fichierLu: number;
  maxFichier: number;
  premierTs: number;
  dernierTs: number;
  prev: { boot: string; seq: number; ou: LigneEnCause; fichier: number } | null;
}

function memeSignature(attendue: string, lue: string): boolean {
  const a = Buffer.from(attendue, "hex");
  const b = Buffer.from(lue, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

const hmac = (cle: KeyObject, corps: Buffer): string => createHmac("sha256", cle).update(corps).digest("hex");

const estObjet = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

/** Durée lisible : minutes, heures, puis jours. */
function duree(s: number): string {
  if (s < 3600) return `${Math.floor(s / 60)} min`;
  if (s < 2 * 86_400) return `${Math.floor(s / 3600)} h`;
  return `${Math.floor(s / 86_400)} j`;
}

interface Brute {
  /** `null` : ligne de plus de 64 Kio, ou fichier qui n'est pas régulier. */
  octets: Buffer | null;
  /** Fragment final sans saut de ligne (écriture en cours). */
  final: boolean;
}

/** Lignes d'un fichier en octets bruts, lues en flux sans recopie quadratique (une signature porte sur les octets écrits) ; ouvert sans attendre (FIFO), refusé s'il n'est pas régulier. */
async function* lignesBrutes(chemin: string, signal?: AbortSignal): AsyncGenerator<Brute> {
  const fh = await open(chemin, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    if (!(await fh.stat()).isFile()) {
      yield { octets: null, final: false };
      return;
    }
    let morceaux: Buffer[] = [];
    let taille = 0;
    let saute = false;
    for await (const brut of fh.createReadStream({
      highWaterMark: 64 * 1024,
      autoClose: false,
      ...(signal ? { signal } : {}),
    })) {
      const m = brut as Buffer;
      let debut = 0;
      for (let i = m.indexOf(0x0a); i !== -1; i = m.indexOf(0x0a, debut)) {
        if (saute) saute = false;
        else if (taille + (i - debut) > LIGNE_MAX) yield { octets: null, final: false };
        else {
          const fin = m.subarray(debut, i);
          yield { octets: morceaux.length ? Buffer.concat([...morceaux, fin]) : fin, final: false };
        }
        morceaux = [];
        taille = 0;
        debut = i + 1;
      }
      if (saute) continue;
      const reste = m.subarray(debut);
      if (taille + reste.length > LIGNE_MAX) {
        yield { octets: null, final: false };
        saute = true;
        morceaux = [];
        taille = 0;
      } else if (reste.length) {
        morceaux.push(reste);
        taille += reste.length;
      }
    }
    if (!saute && taille) yield { octets: Buffer.concat(morceaux), final: true };
  } finally {
    await fh.close();
  }
}

/** Vérifie les fichiers `audit-AAAA-MM-JJ.jsonl` du dossier (bornes de jours UTC comprises) avec les clés données (identifiées par `kid`). */
export async function verifierJournalAudit(o: {
  dossier: string;
  du?: string | null;
  au?: string | null;
  cles?: readonly Buffer[];
  /** Hôte attendu (copie centrale d'un hôte) : toute autre valeur est une incohérence. */
  hote?: string | null;
  maintenant?: () => number;
  signal?: AbortSignal;
}): Promise<ResultatVerificationAudit> {
  const cles = new Map((o.cles ?? []).map((c) => [identifiantCle(c), createSecretKey(c)]));
  const du = o.du ?? null;
  const au = o.au ?? null;
  const tous = (await readdir(o.dossier).catch(() => [] as string[])).filter((n) => FICHIER.test(n)).sort();
  const jourDe = (nom: string | undefined): string | null => FICHIER.exec(nom ?? "")?.[1] ?? null;
  const noms = tous.filter((n) => {
    const jour = jourDe(n) as string;
    return (du === null || jour >= du) && (au === null || jour <= au);
  });
  const totaux: ResultatVerificationAudit["totaux"] = {
    signaturesInvalides: 0,
    illisibles: 0,
    trous: 0,
    desordres: 0,
    nonVerifiees: 0,
    incoherences: 0,
    horsFichier: 0,
    v0Tardives: 0,
    doublons: 0,
  };
  const r: ResultatVerificationAudit = {
    du,
    au,
    fichiers: noms,
    lignes: 0,
    v0: 0,
    signees: 0,
    valides: 0,
    sansSignature: 0,
    cleInconnue: 0,
    signaturesInvalides: [],
    illisibles: [],
    trous: [],
    desordres: [],
    nonVerifiees: [],
    incoherences: [],
    horsFichier: [],
    v0Tardives: [],
    doublons: [],
    ecrivains: [],
    finsIncertaines: [],
    motifs: [],
    totaux,
    statut: "vide",
    integre: false,
  };
  const noter = <K extends keyof typeof totaux>(
    cle: K,
    v: ResultatVerificationAudit[K][number],
    n = 1,
  ): void => {
    totaux[cle] += n;
    const liste = r[cle] as unknown[];
    if (liste.length < LISTE_MAX) liste.push(v);
  };
  const ecrivains = new Map<string, Ecrivain>();
  let v1Vu = false;
  /** Purge signée au `newest` le plus récent : `garde` est son `kept_from`, `null` pour l'ancien format. */
  const purge: { retenue: { newest: string; garde: string | null; hote: string } | null } = {
    retenue: null,
  };
  /** Signature des dernières lignes validement signées, par écrivain et numéro (la plus ancienne sort de l'anneau) : un numéro relu est un rejeu s'il porte la même signature valide, un désordre sinon. */
  const recentes = new Map<string, string>();
  const anneau: string[] = [];
  let tete = 0;

  /** Signature d'une ligne v1, recopiée (une sous-chaîne retiendrait la ligne) : `null` sans signature ; `valide` vaut `null` sans la clé désignée par `kid`. */
  const signatureV1 = (octets: Buffer, kid: unknown): { hmac: string; valide: boolean | null } | null => {
    const m = SIGNATURE_V1.exec(octets.toString("latin1"));
    if (m === null) return null;
    const lue = octets.toString("latin1", m.index + 9, m.index + 73);
    const cle = typeof kid === "string" ? cles.get(kid) : undefined;
    if (cle === undefined) return { hmac: lue, valide: null };
    const corps = Buffer.concat([octets.subarray(0, m.index), Buffer.from("}")]);
    return { hmac: lue, valide: memeSignature(hmac(cle, corps), lue) };
  };

  const retenirPurge = (rec: Record<string, unknown>): void => {
    const d = estObjet(rec["details"]) ? rec["details"] : {};
    if (typeof d["newest"] !== "string") return;
    const newest = d["newest"];
    const garde = typeof d["kept_from"] === "string" && JOUR.test(d["kept_from"]) ? d["kept_from"] : null;
    const p = purge.retenue;
    if (p === null || newest > p.newest || (newest === p.newest && (garde ?? "") > (p.garde ?? "")))
      purge.retenue = { newest, garde, hote: String(rec["host"] ?? "") };
  };

  // Motifs cherchés dans le texte latin1 de la ligne : une position y est une position en octets.
  const verifierV0 = (octets: Buffer, ou: LigneEnCause): void => {
    r.v0 += 1;
    let rec: unknown;
    try {
      rec = JSON.parse(octets.toString("utf8"));
    } catch {
      noter("illisibles", ou);
      return;
    }
    if (!estObjet(rec) || Object.keys(rec).some((k) => !CLES_V0.has(k))) {
      noter("illisibles", ou);
      return;
    }
    if (v1Vu) noter("v0Tardives", ou);
    const m = [...octets.toString("latin1").matchAll(SIGNATURE_V0)].at(-1);
    if (m === undefined || m.index === undefined) {
      r.sansSignature += 1;
      if (cles.size) noter("nonVerifiees", ou);
      return;
    }
    r.signees += 1;
    if (!cles.size) {
      r.cleInconnue += 1;
      return;
    }
    const corps = Buffer.concat([octets.subarray(0, m.index), octets.subarray(m.index + m[0].length)]);
    const lue = m[1] as string;
    if ([...cles.values()].some((c) => memeSignature(hmac(c, corps), lue))) r.valides += 1;
    else noter("signaturesInvalides", ou);
  };

  const verifierV1 = (octets: Buffer, ou: LigneEnCause, iFichier: number, jour: string): void => {
    v1Vu = true;
    let rec: Record<string, unknown>;
    try {
      rec = JSON.parse(octets.toString("utf8")) as Record<string, unknown>;
    } catch {
      noter("illisibles", ou);
      return;
    }
    const sig = signatureV1(octets, rec["kid"]);
    const kid = sig !== null && typeof rec["kid"] === "string" ? rec["kid"] : null;
    if (sig === null) {
      r.sansSignature += 1;
      if (cles.size) noter("nonVerifiees", ou);
    } else {
      r.signees += 1;
      if (sig.valide === null) {
        r.cleInconnue += 1;
        if (cles.size) noter("nonVerifiees", ou);
      } else if (sig.valide) r.valides += 1;
      else noter("signaturesInvalides", ou);
    }
    const boot = typeof rec["boot"] === "string" ? rec["boot"] : "";
    const seq = rec["seq"];
    const ts = typeof rec["ts"] === "number" ? rec["ts"] : NaN;
    if (!boot || typeof seq !== "number" || !Number.isInteger(seq) || seq < 1 || !Number.isFinite(ts)) {
      noter("illisibles", ou);
      return;
    }
    if (typeof rec["time"] !== "string" || rec["time"].slice(0, 10) !== jour) noter("horsFichier", ou);
    const hote = String(rec["host"] ?? "");
    const service = String(rec["service"] ?? "");
    if (o.hote && hote !== o.hote) noter("incoherences", ou);
    const action = rec["action"];
    if (action === "audit.purge" && (sig?.valide === true || !cles.size)) retenirPurge(rec);
    let e = ecrivains.get(boot);
    if (e === undefined) {
      e = {
        hote,
        service,
        boot,
        premier: seq,
        dernier: seq,
        lignes: 0,
        arretPropre: false,
        debutAvantPeriode: false,
        kid,
        suitesDe: [],
        suitesA: [],
        suitesLieu: [],
        premierFichier: iFichier,
        fichierLu: -1,
        maxFichier: 0,
        premierTs: ts,
        dernierTs: ts,
        prev: null,
      };
      ecrivains.set(boot, e);
    }
    // Une clé est lue une fois au démarrage du process : toutes ses lignes portent la même (ou aucune).
    if (e.kid !== kid) noter("incoherences", ou);
    const cleRecente = cles.size ? `${boot}\u0000${seq}` : null;
    const recente = cleRecente === null ? undefined : recentes.get(cleRecente);
    if (recente !== undefined) {
      noter(sig?.valide === true && sig.hmac === recente ? "doublons" : "desordres", ou);
      return;
    }
    if (e.fichierLu === iFichier && seq <= e.maxFichier) noter("desordres", ou);
    e.maxFichier = e.fichierLu === iFichier ? Math.max(e.maxFichier, seq) : seq;
    e.fichierLu = iFichier;
    const k = e.suitesA.length - 1;
    if (k >= 0 && seq === (e.suitesA[k] as number) + 1) e.suitesA[k] = seq;
    else {
      e.suitesDe.push(seq);
      e.suitesA.push(seq);
      e.suitesLieu.push(iFichier * POSITION + ou.ligne);
    }
    if (cleRecente !== null && sig?.valide === true) {
      recentes.set(cleRecente, sig.hmac);
      const sortante = anneau[tete];
      if (sortante !== undefined) recentes.delete(sortante);
      anneau[tete] = cleRecente;
      tete = (tete + 1) % RECENTES_MAX;
    }
    e.lignes += 1;
    e.premierTs = Math.min(e.premierTs, ts);
    e.dernierTs = Math.max(e.dernierTs, ts);
    if (action === "audit.writer.stop") e.arretPropre = true;
    if (action === "audit.writer.start") {
      const p = (rec["details"] as { prev?: { boot?: unknown; seq?: unknown } | null } | null)?.prev;
      if (p && typeof p.boot === "string" && typeof p.seq === "number")
        e.prev = { boot: p.boot, seq: p.seq, ou, fichier: iFichier };
    }
  };

  for (const [i, nom] of noms.entries()) {
    o.signal?.throwIfAborted();
    const jour = jourDe(nom) as string;
    const dernierFichier = i === noms.length - 1;
    let n = 0;
    for await (const { octets: brute, final } of lignesBrutes(join(o.dossier, nom), o.signal)) {
      n += 1;
      const ou = { fichier: nom, ligne: n };
      // Fragment final du dernier fichier : ligne en cours d'écriture, pas une anomalie.
      if (final && dernierFichier) break;
      if (brute === null) {
        r.lignes += 1;
        noter("illisibles", ou);
        continue;
      }
      const octets = brute.at(-1) === 0x0d ? brute.subarray(0, -1) : brute;
      if (!octets.length) continue;
      r.lignes += 1;
      if (final) noter("illisibles", ou);
      else if (octets.subarray(0, DEBUT_V1.length).equals(DEBUT_V1)) verifierV1(octets, ou, i, jour);
      else if (octets[0] === 0x7b) verifierV0(octets, ou);
      else noter("illisibles", ou);
    }
  }

  /** Purges des fichiers postérieurs à `au` (une période close peut commencer après un début purgé) : seules leurs lignes `audit.purge` sont décodées. */
  const lirePurgesApres = async (): Promise<void> => {
    for (const nom of tous) {
      if ((jourDe(nom) as string) <= (au as string)) continue;
      o.signal?.throwIfAborted();
      for await (const { octets: brute, final } of lignesBrutes(join(o.dossier, nom), o.signal)) {
        if (brute === null || final || brute.indexOf(MOTIF_PURGE) === -1) continue;
        const octets = brute.at(-1) === 0x0d ? brute.subarray(0, -1) : brute;
        if (!octets.subarray(0, DEBUT_V1.length).equals(DEBUT_V1)) continue;
        let rec: unknown;
        try {
          rec = JSON.parse(octets.toString("utf8"));
        } catch {
          continue;
        }
        if (!estObjet(rec) || rec["action"] !== "audit.purge") continue;
        if (cles.size && signatureV1(octets, rec["kid"])?.valide !== true) continue;
        retenirPurge(rec);
      }
    }
  };

  const premierPresent = jourDe(tous[0]);
  const premierJour = jourDe(noms[0]);
  // Début du journal : libre pour une période commencée dans le journal, sinon borné par la dernière purge (premier jour ≤ `kept_from`, plus tard = fichiers retirés).
  const debutChoisi = du !== null && premierPresent !== null && du >= premierPresent;
  if (!debutChoisi && au !== null && premierJour !== null) await lirePurgesApres();
  const derniere = purge.retenue;
  const debut: "oui" | "non" | "incertain" = debutChoisi
    ? "oui"
    : derniere === null || premierJour === null
      ? "non"
      : derniere.garde === null
        ? "incertain"
        : premierJour <= derniere.garde
          ? "oui"
          : "non";
  if (debut === "non" && derniere !== null && derniere.garde !== null)
    noter("trous", {
      fichier: noms[0] as string,
      ligne: 1,
      hote: derniere.hote,
      service: "",
      boot: "",
      de: 0,
      a: 0,
      nature: "fichiers",
    });
  if (debut === "incertain")
    r.motifs.push({
      nature: "purge_sans_borne",
      hote: null,
      service: null,
      dernierTs: null,
      texte: `début du journal (${premierJour}) non vérifiable : la dernière purge, d'un format antérieur, ne dit pas quel fichier elle a gardé (kept_from)`,
    });

  const lieu = (code: number): LigneEnCause => ({
    fichier: noms[Math.floor(code / POSITION)] ?? "",
    ligne: code % POSITION,
  });
  for (const e of ecrivains.values()) {
    const ordre = [...e.suitesDe.keys()].sort(
      (x, y) => (e.suitesDe[x] as number) - (e.suitesDe[y] as number) || x - y,
    );
    const base = { hote: e.hote, service: e.service, boot: e.boot };
    let couvert = 0;
    for (const [k, i] of ordre.entries()) {
      const [de, a] = [e.suitesDe[i] as number, e.suitesA[i] as number];
      const ou = lieu(e.suitesLieu[i] as number);
      if (k === 0) {
        e.premier = de;
        // Début absent : toléré au premier fichier s'il est expliqué (période choisie ou purge), incertain avec une purge sans borne.
        if (de > 1 && e.premierFichier === 0 && debut !== "non") e.debutAvantPeriode = true;
        else if (de > 1)
          noter("trous", {
            ...ou,
            ...base,
            de: 1,
            a: de - 1,
            nature: e.premierFichier === 0 ? "debut" : "milieu",
          });
      } else if (de > couvert + 1)
        noter("trous", { ...ou, ...base, de: couvert + 1, a: de - 1, nature: "milieu" });
      else if (de <= couvert) noter("desordres", ou, Math.min(a, couvert) - de + 1);
      couvert = Math.max(couvert, a);
    }
    e.dernier = couvert;
  }
  // Fins d'écrivains : la ligne de démarrage du suivant désigne la dernière ligne connue du précédent.
  for (const e of ecrivains.values()) {
    if (e.prev === null) continue;
    const p = ecrivains.get(e.prev.boot);
    if (p !== undefined) {
      if (p.dernier < e.prev.seq)
        noter("trous", {
          ...e.prev.ou,
          hote: p.hote,
          service: p.service,
          boot: p.boot,
          de: p.dernier + 1,
          a: e.prev.seq,
          nature: "fin",
        });
    } else if (e.prev.fichier !== 0 || debut === "non")
      // Précédent absent : toléré seulement au premier fichier, quand le début y est expliqué.
      noter("trous", {
        ...e.prev.ou,
        hote: e.hote,
        service: e.service,
        boot: e.prev.boot,
        de: 1,
        a: e.prev.seq,
        nature: "ecrivain",
      });
  }
  const maintenant = (o.maintenant ?? (() => Date.now() / 1000))();
  const parService = new Map<string, Ecrivain[]>();
  for (const e of ecrivains.values()) {
    const cle = `${e.hote}|${e.service}`;
    const liste = parService.get(cle);
    if (liste) liste.push(e);
    else parService.set(cle, [e]);
  }
  for (const liste of parService.values()) {
    liste.sort((a, b) => a.premierTs - b.premierTs);
    liste.forEach((e, k) => {
      if (e.arretPropre) return;
      const suivant = liste[k + 1];
      const base = { hote: e.hote, service: e.service, boot: e.boot, dernierTs: e.dernierTs };
      if (suivant !== undefined && suivant.premierTs - e.dernierTs > SILENCE_S)
        r.finsIncertaines.push({ ...base, raison: "silence_avant_suivant" });
      else if (suivant === undefined && au === null && maintenant - e.dernierTs > 2 * SILENCE_S)
        r.finsIncertaines.push({ ...base, raison: "silence_fin_periode" });
    });
  }
  // Fin du journal dans la période (sans `au`) : une instance en marche écrit au moins un battement par heure.
  if (au === null) {
    const parHote = new Map<string, number>();
    for (const e of ecrivains.values())
      parHote.set(e.hote, Math.max(parHote.get(e.hote) ?? -Infinity, e.dernierTs));
    for (const [hote, ts] of parHote)
      if (maintenant - ts > FIN_MAX_S)
        r.motifs.push({
          nature: "fin_ancienne",
          hote,
          service: null,
          dernierTs: ts,
          texte: `dernière ligne de ${hote || "?"} il y a ${duree(maintenant - ts)}`,
        });
    for (const f of r.finsIncertaines)
      if (
        f.raison === "silence_fin_periode" &&
        !r.motifs.some((m) => m.nature === "fin_ancienne" && m.hote === f.hote)
      )
        r.motifs.push({
          nature: "fin_incertaine",
          hote: f.hote,
          service: f.service,
          dernierTs: f.dernierTs,
          texte: `${f.hote}/${f.service} silencieux depuis ${duree(maintenant - f.dernierTs)}, sans ligne de fin`,
        });
  }
  r.ecrivains = [...ecrivains.values()].map((e) => ({
    hote: e.hote,
    service: e.service,
    boot: e.boot,
    premier: e.premier,
    dernier: e.dernier,
    lignes: e.lignes,
    arretPropre: e.arretPropre,
    debutAvantPeriode: e.debutAvantPeriode,
    kid: e.kid,
  }));
  const anomalies =
    totaux.signaturesInvalides +
    totaux.illisibles +
    totaux.trous +
    totaux.desordres +
    totaux.incoherences +
    totaux.horsFichier +
    totaux.v0Tardives;
  r.statut =
    r.lignes === 0
      ? "vide"
      : anomalies > 0
        ? "anomalies"
        : !cles.size ||
            totaux.nonVerifiees > 0 ||
            r.valides < r.signees ||
            r.signees === 0 ||
            r.motifs.length > 0
          ? "non_verifie"
          : "intact";
  r.integre = r.statut === "intact";
  return r;
}
