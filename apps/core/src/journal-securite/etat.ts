// SPDX-License-Identifier: MIT
/** apps/core/src/journal-securite/etat.ts — état du journal de sécurité pour la console : dossier et droits, signature, volume, disque, horloge, centralisation et certificats, écrivains ; alertes ; calculé sans bloquer, gardé 60 s. */
import { execFile } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { readdir, readFile, stat, statfs } from "node:fs/promises";
import { basename, join } from "node:path";

import { racineDepot } from "@elpis/config";
import type { EtatJournal as EtatJournalContrat } from "@elpis/contracts";
import { etatEcritureAudit, FICHIER_AUDIT } from "@elpis/securite";

import { sansBarresFinales } from "../llm/client-http";
import { detecterCentralisation, lireFichierBorne } from "./centralisation";
import { ouvrirFichierJournal } from "./recherche";
import type { EtatCentralisation } from "./centralisation";
import { lireReglagesJournal, vueReglages } from "./reglages";
import type { ReglagesJournalLus } from "./reglages";
import { jourLimite } from "./retention";

const DUREE_CACHE_MS = 60_000;
const LOT_STAT = 64;
const DUREE_HORLOGE_MS = 10 * 60_000;
const QUEUE_LUE = 256 * 1024;
const JOURS_DISQUE_MIN = 7;
const CERT_PROCHE_JOURS = 30;
const SILENCE_ECRIVAIN_S = 2 * 3600 + 600;

export type EtatJournal = EtatJournalContrat;
export type AlerteJournal = EtatJournal["alerts"][number];
export type NiveauAlerte = AlerteJournal["level"];
export type CertificatJournal = EtatJournal["forwarding"]["certificates"][number];
export type EcrivainJournal = EtatJournal["writers"][number];

export interface OptionsEtat {
  maintenant?: () => number;
  centralisation?: () => Promise<EtatCentralisation>;
  horloge?: () => Promise<boolean | null>;
  reglages?: ReglagesJournalLus;
  /** Lecture d'un fichier de règle ou de certificat (tests). */
  lire?: (chemin: string) => Promise<string>;
  /** Racine du dépôt, pour reconnaître le dossier de repli `logs/audit`. */
  racine?: string;
}

/** Incrémenté à chaque oubli : un calcul commencé avant ne repeuple pas le cache avec un état périmé. */
let generation = 0;
let cache: { valeur: EtatJournal; expire: number } | null = null;
/** Calcul partagé en cours (état sans option) et la génération où il a commencé. */
let enVol: { generation: number; promesse: Promise<EtatJournal> } | null = null;
let horlogeCache: { valeur: boolean | null; expire: number } | null = null;

/** `timedatectl show -p NTPSynchronized --value` : vrai, faux, ou `null` si systemd ne répond pas en 2 s ; gardé 10 min. */
function horlogeSynchronisee(): Promise<boolean | null> {
  if (horlogeCache && horlogeCache.expire > Date.now()) return Promise.resolve(horlogeCache.valeur);
  return new Promise((resoudre) => {
    execFile("timedatectl", ["show", "-p", "NTPSynchronized", "--value"], { timeout: 2000 }, (e, sortie) => {
      const t = String(sortie ?? "").trim();
      const valeur = e ? null : t === "yes" ? true : t === "no" ? false : null;
      horlogeCache = { valeur, expire: Date.now() + DUREE_HORLOGE_MS };
      resoudre(valeur);
    });
  });
}

/** Certificats cités par la règle d'envoi (CA et certificat client, règle lue sur 256 Kio au plus), lignes commentées ignorées. */
async function certificats(
  regle: string | null,
  lireRegle: (chemin: string) => Promise<string | null>,
  lire: (chemin: string) => Promise<string>,
  maintenantS: number,
): Promise<CertificatJournal[]> {
  if (regle === null) return [];
  const texte = await lireRegle(regle).catch(() => null);
  if (texte === null) return [];
  const vus = new Map<string, "ca" | "client">();
  for (const ligne of texte.split("\n")) {
    if (/^\s*#/u.test(ligne)) continue;
    for (const m of ligne.matchAll(/\b(CAFile|caCert|CertFile|myCert)\s*=\s*"([^"]+)"/giu)) {
      const role = /^ca/iu.test(m[1] as string) ? "ca" : "client";
      vus.set(m[2] as string, role);
    }
  }
  const sortie: CertificatJournal[] = [];
  for (const [path, role] of vus) {
    try {
      const fin = Date.parse(new X509Certificate(await lire(path)).validTo) / 1000;
      sortie.push({
        path,
        role,
        readable: true,
        expires_at: new Date(fin * 1000).toISOString(),
        days_left: Math.floor((fin - maintenantS) / 86_400),
      });
    } catch {
      sortie.push({ path, role, readable: false, expires_at: null, days_left: null });
    }
  }
  return sortie;
}

/** Dernière ligne de chaque écrivain (hôte, service) dans la fin des fichiers du jour et de la veille. */
async function ecrivains(dossier: string, noms: readonly string[]): Promise<EcrivainJournal[]> {
  const parCle = new Map<string, EcrivainJournal>();
  for (const nom of noms.slice(-2)) {
    let fh;
    try {
      fh = await ouvrirFichierJournal(join(dossier, nom));
    } catch {
      continue;
    }
    if (fh === null) continue;
    try {
      const taille = (await fh.stat()).size;
      const n = Math.min(taille, QUEUE_LUE);
      const tampon = Buffer.alloc(n);
      await fh.read(tampon, 0, n, taille - n);
      for (const texte of tampon.toString("utf8").split("\n")) {
        if (!texte.startsWith('{"v":')) continue;
        let r: Record<string, unknown>;
        try {
          r = JSON.parse(texte) as Record<string, unknown>;
        } catch {
          continue;
        }
        const host = String(r["host"] ?? "");
        const service = String(r["service"] ?? "");
        const ts = typeof r["ts"] === "number" ? r["ts"] : 0;
        const cle = `${host}|${service}`;
        const avant = parCle.get(cle);
        if (avant && avant.last_ts > ts) continue;
        const action = String(r["action"] ?? "");
        const d = (r["details"] ?? {}) as Record<string, unknown>;
        parCle.set(cle, {
          host,
          service,
          boot: String(r["boot"] ?? ""),
          last_ts: ts,
          last_action: action,
          failures:
            action === "audit.writer.heartbeat" && typeof d["failures"] === "number"
              ? d["failures"]
              : (avant?.failures ?? null),
          stopped: action === "audit.writer.stop",
        });
      }
    } finally {
      await fh.close();
    }
  }
  return [...parCle.values()].sort((a, b) => (a.service < b.service ? -1 : 1));
}

/** « 1 jour », « 5 jours » (au singulier jusqu'à 1 inclus). */
const jours = (n: number): string => `${n} jour${n > 1 ? "s" : ""}`;
/** « dans 3 jours », « aujourd'hui » à 0. */
const dansJours = (n: number): string => (n === 0 ? "aujourd'hui" : `dans ${jours(n)}`);
const fichiers = (n: number): string => `${n} fichier${n > 1 ? "s" : ""}`;

/** Taille en unités binaires (Kio, Mio, Gio, Tio), une décimale sous 10. */
function tailleLisible(octets: number): string {
  const unites = ["o", "Kio", "Mio", "Gio", "Tio"];
  let v = octets;
  let i = 0;
  while (v >= 1024 && i < unites.length - 1) {
    v /= 1024;
    i += 1;
  }
  const texte =
    v < 10 && i > 0 ? v.toLocaleString("fr-FR", { maximumFractionDigits: 1 }) : String(Math.round(v));
  return `${texte} ${unites[i]}`;
}

/** Date JJ/MM/AAAA d'un instant ISO, en heure locale du serveur (comme la page, qui affiche la date locale du navigateur). */
const dateLisible = (iso: string): string => new Date(iso).toLocaleDateString("fr-FR");

/** Alertes d'un état (ids et niveaux stables, textes en français lisibles). */
export function alertesDe(e: Omit<EtatJournal, "alerts">, maintenantS: number): AlerteJournal[] {
  const a: AlerteJournal[] = [];
  const pousser = (id: string, level: NiveauAlerte, title: string, detail = ""): void =>
    void a.push({ id, level, title, detail });
  if (e.fallback_directory)
    pousser(
      "audit-fallback",
      "warn",
      "Journal de sécurité dans le dossier de repli",
      `${e.directory} : lancez « sudo ./elpis audit setup » pour le placer dans /var/lib/elpis/audit.`,
    );
  if (e.world_readable) pousser("audit-perms", "danger", "Journal de sécurité lisible par tous", e.directory);
  if (!e.signed)
    pousser(
      "audit-key",
      "warn",
      "Journal de sécurité non signé",
      "Clé de signature absente (/etc/elpis/audit.key) : « sudo ./elpis audit setup ».",
    );
  if (e.write_failures.count > 0 || e.writers.some((w) => (w.failures ?? 0) > 0))
    pousser(
      "audit-write",
      "danger",
      "Écritures du journal de sécurité en échec",
      e.write_failures.last_error ?? "Voir le journal des services.",
    );
  if (e.disk && e.disk.days_left !== null && e.disk.days_left < JOURS_DISQUE_MIN)
    pousser(
      "audit-disk",
      "danger",
      "Disque du journal bientôt plein",
      `Plein ${dansJours(e.disk.days_left)} au rythme actuel (${tailleLisible(e.disk.free_bytes)} libres).`,
    );
  else if (e.disk && e.disk.total_bytes > 0 && e.disk.free_bytes / e.disk.total_bytes < 0.05)
    pousser("audit-disk", "warn", "Moins de 5 % d'espace libre pour le journal", e.directory);
  if (e.clock_synchronized === false)
    pousser(
      "audit-clock",
      "warn",
      "Horloge non synchronisée",
      "Configurez chrony sur le serveur de temps interne.",
    );
  const f = e.forwarding;
  if (f.expected && (f.agent === null || f.rule === null || f.active !== true))
    pousser(
      "audit-forwarding",
      "danger",
      "Centralisation attendue mais absente : purge suspendue",
      f.agent === null
        ? "Aucun agent syslog installé."
        : f.rule === null
          ? "Aucune règle Elpis."
          : f.active === null
            ? `État de ${f.agent} inconnu.`
            : `${f.agent} arrêté.`,
    );
  for (const c of f.certificates)
    if (c.days_left !== null && c.days_left < CERT_PROCHE_JOURS)
      pousser(
        `audit-cert-${c.role}`,
        c.days_left < 0 ? "danger" : "warn",
        c.days_left < 0
          ? "Certificat de centralisation expiré"
          : "Certificat de centralisation bientôt expiré",
        c.days_left < 0
          ? `${basename(c.path)} a expiré le ${dateLisible(c.expires_at ?? "")}, depuis ${jours(-c.days_left)}.`
          : `${basename(c.path)} expire le ${dateLisible(c.expires_at ?? "")}, ${dansJours(c.days_left)}.`,
      );
  for (const w of e.writers)
    if (!w.stopped && maintenantS - w.last_ts > SILENCE_ECRIVAIN_S)
      pousser(
        `audit-silent-${w.service}`,
        "warn",
        `Service ${w.service} silencieux dans le journal`,
        "Aucun battement depuis plus de deux heures.",
      );
  if (e.retention.invalid)
    pousser(
      "audit-settings",
      "danger",
      "Durée de conservation illisible : purge suspendue",
      "Corrigez security.audit.retention_days dans config.json, ou enregistrez la conservation depuis la console.",
    );
  if (e.retention.from_witness)
    pousser(
      "audit-settings-witness",
      "warn",
      "Réglages du journal absents de config.json",
      "Durée de conservation et centralisation attendue reprises du témoin du dossier du journal ; enregistrez-les depuis la console pour les réécrire dans config.json.",
    );
  if (e.retention.hold)
    pousser(
      "audit-hold",
      "info",
      "Gel de la purge du journal actif",
      [
        e.retention.hold_reason,
        e.retention.eligible_files
          ? `${fichiers(e.retention.eligible_files)} ${e.retention.eligible_files > 1 ? "gardés" : "gardé"} au-delà de la durée.`
          : "",
      ]
        .filter(Boolean)
        .join(" · "),
    );
  return a;
}

/** État complet (gardé 60 s sans option, un seul calcul à la fois pour les appels simultanés) ; ne lève jamais, une sonde en échec laisse son champ vide. */
export function etatJournalSecurite(o: OptionsEtat = {}): Promise<EtatJournal> {
  if (Object.keys(o).length !== 0) return calculerEtat(o, false);
  if (cache && cache.expire > Date.now()) return Promise.resolve(cache.valeur);
  if (enVol && enVol.generation === generation) return enVol.promesse;
  const courant: typeof enVol = { generation, promesse: calculerEtat(o, true) };
  enVol = courant;
  const liberer = (): void => {
    if (enVol === courant) enVol = null;
  };
  courant.promesse.then(liberer, liberer);
  return courant.promesse;
}

/** Tailles des fichiers par lots de 64 `stat` en parallèle (un fichier illisible compte 0). */
async function taillesDesFichiers(dossier: string, noms: readonly string[]): Promise<Map<string, number>> {
  const tailles = new Map<string, number>();
  for (let i = 0; i < noms.length; i += LOT_STAT) {
    const lot = noms.slice(i, i + LOT_STAT);
    const lus = await Promise.all(
      lot.map((n) =>
        stat(join(dossier, n)).then(
          (s) => s.size,
          () => 0,
        ),
      ),
    );
    lot.forEach((n, j) => tailles.set(n, lus[j] ?? 0));
  }
  return tailles;
}

async function calculerEtat(o: OptionsEtat, partage: boolean): Promise<EtatJournal> {
  const debutGeneration = generation;
  const t = (o.maintenant ?? (() => Date.now() / 1000))();
  const ecriture = etatEcritureAudit();
  const dossier = ecriture.dossier;
  const reglages = o.reglages ?? lireReglagesJournal(dossier);
  const lire = o.lire ?? ((chemin: string) => readFile(chemin, "utf8"));
  const noms = (await readdir(dossier).catch(() => [] as string[]))
    .filter((n) => FICHIER_AUDIT.test(n))
    .sort();
  const tailles = await taillesDesFichiers(dossier, noms);
  const aujourdHui = new Date(t * 1000).toISOString().slice(0, 10);
  const complets = noms.filter((n) => (FICHIER_AUDIT.exec(n)?.[1] ?? "") < aujourdHui).slice(-7);
  const moyenne = complets.length
    ? Math.round(complets.reduce((s, n) => s + (tailles.get(n) ?? 0), 0) / complets.length)
    : null;
  const st = await stat(dossier).catch(() => null);
  const fs = await statfs(dossier).catch(() => null);
  const libre = fs ? Number(fs.bavail) * Number(fs.bsize) : 0;
  const [centralisation, horloge, writers] = await Promise.all([
    (o.centralisation ?? (() => detecterCentralisation({ dossierAudit: dossier })))(),
    (o.horloge ?? horlogeSynchronisee)(),
    ecrivains(dossier, noms),
  ]);
  const limite = jourLimite(t, reglages.retention_days);
  const base: Omit<EtatJournal, "alerts"> = {
    directory: dossier,
    fallback_directory: sansBarresFinales(dossier) === join(o.racine ?? racineDepot(), "logs", "audit"),
    mode: st ? (st.mode & 0o7777).toString(8).padStart(4, "0") : null,
    group_id: st ? st.gid : null,
    world_readable: st ? (st.mode & 0o004) !== 0 : false,
    signed: ecriture.signe,
    kid: ecriture.kid,
    files: noms.length,
    bytes: [...tailles.values()].reduce((s, v) => s + v, 0),
    oldest: FICHIER_AUDIT.exec(noms[0] ?? "")?.[1] ?? null,
    newest: FICHIER_AUDIT.exec(noms.at(-1) ?? "")?.[1] ?? null,
    daily_avg_bytes: moyenne,
    disk: fs
      ? {
          free_bytes: libre,
          total_bytes: Number(fs.blocks) * Number(fs.bsize),
          days_left: moyenne ? Math.floor(libre / moyenne) : null,
        }
      : null,
    clock_synchronized: horloge,
    forwarding: {
      expected: reglages.forwarding_expected,
      agent: centralisation.agent,
      active: centralisation.actif,
      rule: centralisation.regle,
      collector: centralisation.envoi?.collecteur ?? null,
      transport: centralisation.envoi?.transport ?? null,
      queue: centralisation.envoi?.file
        ? {
            type: centralisation.envoi.file.type,
            file: centralisation.envoi.file.fichier,
            max_disk: centralisation.envoi.file.max_disque,
          }
        : null,
      certificates: await certificats(centralisation.regle, o.lire ?? lireFichierBorne, lire, t),
    },
    retention: {
      ...vueReglages(reglages),
      eligible_files: noms.filter((n) => (FICHIER_AUDIT.exec(n)?.[1] ?? "") < limite).length,
    },
    write_failures: { count: ecriture.echecs, last_error: ecriture.derniereErreur },
    writers,
    generated_at: t,
  };
  const valeur: EtatJournal = { ...base, alerts: alertesDe(base, t) };
  if (partage && debutGeneration === generation) cache = { valeur, expire: Date.now() + DUREE_CACHE_MS };
  return valeur;
}

export function oublierEtatJournal(): void {
  generation += 1;
  cache = null;
  enVol = null;
}
