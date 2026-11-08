// SPDX-License-Identifier: MIT
/** apps/core/src/journal-securite/retention.ts — purge quotidienne du journal de sécurité (main élu) : jours UTC complets au-delà de la conservation, réglages relus strictement, gel (config.json ou témoin), garde de centralisation et d'horloge, événement écrit avant toute suppression. */
import { readdir, stat, unlink } from "node:fs/promises";
import { join } from "node:path";

import { lireConfigDisque } from "@elpis/config";
import { auditEvent, etatEcritureAudit, FICHIER_AUDIT } from "@elpis/securite";

import type { Journal } from "../journal";
import { detecterCentralisation } from "./centralisation";
import type { EtatCentralisation } from "./centralisation";
import { ecrireTemoinReglages, lireTemoinReglages, reglagesAvecTemoin } from "./reglages";
import type { ReglagesJournalLus } from "./reglages";

const LISTE_MAX = 50;
/** Fichiers supprimés par passe au plus : une horloge déréglée ou la levée d'un long gel n'efface pas tout d'un coup. */
const SUPPRESSIONS_MAX = 31;

export type StatutPurge = "ok" | "none" | "hold" | "forwarding_missing" | "error";

export interface ResultatPurge {
  statut: StatutPurge;
  ts: number;
  retention_days: number;
  /** Fichiers au-delà de la durée de conservation. */
  eligibles: number;
  supprimes: number;
  octets: number;
  plus_ancien_garde: string | null;
  erreur: string | null;
}

export interface OptionsPurge {
  dossier?: string;
  maintenant?: () => number;
  /** Réglages imposés (tests) ; sinon relus strictement sur disque, deux fois. */
  reglages?: ReglagesJournalLus;
  centralisation?: () => Promise<EtatCentralisation>;
  journal?: Journal;
}

/** Jour UTC sous lequel un fichier ne contient que des lignes plus vieilles que la conservation. */
export function jourLimite(maintenantS: number, jours: number): string {
  return new Date((maintenantS - jours * 86_400) * 1000).toISOString().slice(0, 10);
}

const jourDe = (nom: string): string => FICHIER_AUDIT.exec(nom)?.[1] ?? "";

function systeme(action: string, details: Record<string, unknown>): void {
  auditEvent({ userId: null, username: null, action, details });
}

/** Réglages relus sur disque sans indulgence : config.json absent, vide, illisible ou non objet = `null` (aucune suppression). */
function reglagesStricts(dossier: string): ReglagesJournalLus | null {
  let cfg: Record<string, unknown> | null;
  try {
    cfg = lireConfigDisque(true);
  } catch {
    return null;
  }
  if (cfg === null) return null;
  const securite = cfg["security"];
  const section =
    securite !== null && typeof securite === "object" && !Array.isArray(securite)
      ? (securite as Record<string, unknown>)["audit"]
      : undefined;
  return reglagesAvecTemoin(section, dossier);
}

/** Une passe : rien à faire, gel, centralisation absente alors qu'attendue, ou `audit.purge` écrit puis fichiers supprimés ; ne lève jamais. */
export async function purgerJournalSecurite(o: OptionsPurge = {}): Promise<ResultatPurge> {
  const t = (o.maintenant ?? (() => Date.now() / 1000))();
  const res: ResultatPurge = {
    statut: "none",
    ts: t,
    retention_days: 0,
    eligibles: 0,
    supprimes: 0,
    octets: 0,
    plus_ancien_garde: null,
    erreur: null,
  };
  const echouer = (erreur: string): ResultatPurge => {
    res.statut = "error";
    res.erreur = erreur;
    o.journal?.warn(`[audit] purge du journal de sécurité suspendue : ${erreur}`);
    return res;
  };
  try {
    const dossier = o.dossier ?? etatEcritureAudit().dossier;
    const lire = (): ReglagesJournalLus | null => o.reglages ?? reglagesStricts(dossier);
    const r = lire();
    if (r === null) return echouer("config.json absent ou illisible");
    if (r.invalide) return echouer("durée de conservation illisible dans security.audit");
    if (r.depuis_temoin)
      o.journal?.warn(
        "[audit] security.audit absent de config.json : durée de conservation et centralisation reprises du témoin du dossier du journal.",
      );
    else if (!o.reglages) {
      // Réglages lus dans config.json (même écrits à la main) : le témoin les suit, pour le jour où la section disparaîtrait.
      const t0 = lireTemoinReglages(dossier);
      if (t0?.retention_days !== r.retention_days || t0.forwarding_expected !== r.forwarding_expected)
        ecrireTemoinReglages(dossier, r);
    }
    res.retention_days = r.retention_days;
    const limite = jourLimite(t, r.retention_days);
    const noms = (await readdir(dossier).catch(() => [] as string[]))
      .filter((n) => FICHIER_AUDIT.test(n))
      .sort();
    // Les `retention_days` fichiers les plus récents restent toujours : une horloge en avance ne vide pas le journal.
    const recents = new Set(noms.slice(-r.retention_days));
    const eligibles = noms.filter((n) => jourDe(n) < limite && !recents.has(n));
    res.eligibles = eligibles.length;
    res.plus_ancien_garde = noms.find((n) => !eligibles.includes(n)) ?? null;
    if (!eligibles.length) return res;
    const lot = eligibles.slice(0, SUPPRESSIONS_MAX);
    const resume = {
      retention_days: r.retention_days,
      count: lot.length,
      oldest: jourDe(lot[0] as string),
      newest: jourDe(lot.at(-1) as string),
      ...(eligibles.length > lot.length ? { remaining: eligibles.length - lot.length } : {}),
    };
    if (r.hold) {
      res.statut = "hold";
      systeme("audit.purge.skipped", { ...resume, reason: "hold", hold_reason: r.hold_reason });
      return res;
    }
    let centralisation: EtatCentralisation | null = null;
    if (r.forwarding_expected) {
      const c = await (o.centralisation ?? (() => detecterCentralisation({ dossierAudit: dossier })))();
      centralisation = c;
      // Sans réponse de systemd, l'envoi n'est pas établi : la purge attend.
      if (c.agent === null || c.actif !== true || c.regle === null) {
        res.statut = "forwarding_missing";
        systeme("audit.purge.skipped", {
          ...resume,
          reason: "forwarding_missing",
          agent: c.agent,
          active: c.actif,
          rule: c.regle,
        });
        o.journal?.warn(
          `[audit] purge du journal de sécurité suspendue : centralisation attendue mais ${c.agent === null ? "aucun agent syslog" : c.regle === null ? "aucune règle Elpis lisant ce dossier" : c.actif === false ? `${c.agent} arrêté` : `état de ${c.agent} inconnu`} ; ${eligibles.length} fichier(s) gardé(s).`,
        );
        return res;
      }
    }
    for (const n of lot)
      res.octets += await stat(join(dossier, n)).then(
        (s) => s.size,
        () => 0,
      );
    // Gel posé pendant la passe : relu juste avant d'écrire et de supprimer.
    const relu = lire();
    if (relu === null || relu.invalide) return echouer("réglages devenus illisibles pendant la passe");
    if (relu.hold) {
      res.statut = "hold";
      systeme("audit.purge.skipped", { ...resume, reason: "hold", hold_reason: relu.hold_reason });
      return res;
    }
    const echecsAvant = etatEcritureAudit().echecs;
    systeme("audit.purge", {
      ...resume,
      kept_from: jourDe(noms.find((n) => !lot.includes(n)) ?? "") || null,
      bytes: res.octets,
      files: lot.slice(0, LISTE_MAX),
      ...(centralisation ? { agent: centralisation.agent, rule: centralisation.regle } : {}),
    });
    // Sans trace écrite de la purge, rien n'est supprimé.
    if (etatEcritureAudit().echecs > echecsAvant) return echouer("audit.purge non écrit");
    const restes: string[] = [];
    for (const n of lot) {
      try {
        await unlink(join(dossier, n));
        res.supprimes += 1;
      } catch {
        restes.push(n);
      }
    }
    res.statut = restes.length ? "error" : "ok";
    if (restes.length) {
      res.erreur = `${restes.length} fichier(s) non supprimé(s)`;
      systeme("audit.purge.failed", { files: restes.slice(0, LISTE_MAX), count: restes.length });
    }
    o.journal?.info(
      `[audit] purge du journal de sécurité : ${res.supprimes} fichier(s) de plus de ${r.retention_days} jours supprimé(s).`,
    );
    return res;
  } catch (e) {
    return echouer(e instanceof Error ? e.message : String(e));
  }
}
