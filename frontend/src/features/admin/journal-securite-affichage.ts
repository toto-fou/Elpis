// SPDX-License-Identifier: MIT
/** frontend/src/features/admin/journal-securite-affichage.ts — Journaux › Sécurité : libellés d'actions, résumé des détails, texte et anomalies d'un résultat de vérification, cellules du bandeau d'état. */
import type { EtatJournal, EvenementJournal, VerificationJournal } from "@elpis/contracts";

import { estObjet } from "../../utils/lecture-json";
import { heureLocale, jourFr } from "./horodatage";
import { octets, pluriel } from "./formats";

export const LIBELLES_ACTIONS: Readonly<Record<string, string>> = Object.freeze({
  "auth.login": "Connexion",
  "auth.login.denied": "Connexion refusée",
  "auth.logout": "Déconnexion",
  "auth.role.denied": "Rôle insuffisant",
  "auth.csrf.denied": "Requête intersite refusée",
  "code.exec.tools.shell": "Commande dans la sandbox",
  "user.sandbox.mode": "Mode de la sandbox changé",
  "token.create": "Jeton personnel créé",
  "oauth.authorize": "Accès OAuth accordé",
  "admin.config.patch": "Réglages modifiés",
  "admin.user.create": "Compte créé",
  "admin.user.role": "Rôle changé",
  "admin.user.groups": "Groupes d'un compte changés",
  "admin.group.create": "Groupe créé",
  "admin.user.password_reset": "Mot de passe réinitialisé",
  "admin.restart": "Redémarrage demandé",
  "admin.security.https": "HTTPS basculé",
  "admin.security.sessions.revoke_user": "Sessions d'un compte révoquées",
  "admin.backup.download": "Sauvegarde téléchargée",
  "admin.llm_traffic.read": "Trafic LLM consulté",
  "admin.metrics.export": "Métriques exportées",
  "admin.audit.settings": "Conservation du journal modifiée",
  "admin.audit.search": "Journal consulté",
  "admin.audit.export": "Journal exporté",
  "admin.audit.verify": "Intégrité vérifiée",
  "audit.test": "Événement de test",
  "audit.purge": "Purge du journal",
  "audit.writer.start": "Début d'écriture",
  "audit.writer.heartbeat": "Battement horaire",
  "audit.writer.stop": "Fin d'écriture",
});

const estMarqueur = (action: string): boolean => action.startsWith("audit.writer.");

/** Style de la colonne Action : refus en rouge, marqueurs et purge en gris. */
export function classeAction(action: string): string {
  if (/\.(denied|failed)$/u.test(action)) return "sup-secu-action--refus";
  return estMarqueur(action) || action === "audit.purge" ? "sup-secu-action--sys" : "";
}

const CHAMPS_TECHNIQUES = new Set([
  "user_agent",
  "code_sha256",
  "repeated",
  "first_ts",
  "last_ts",
  "window_s",
]);

/** Résumé d'une ligne pour la liste : texte brut, 3 champs au plus (le détail complet est dans le tiroir). */
export function resumeDetails(e: EvenementJournal): string {
  const d = estObjet(e.details) ? e.details : {};
  const rafale =
    typeof d["repeated"] === "number" ? `+${d["repeated"]} en ${String(d["window_s"] ?? "?")} s · ` : "";
  const court = (v: unknown): string => (typeof v === "object" && v !== null ? JSON.stringify(v) : String(v));
  const champs = Object.entries(d)
    .filter(([k]) => !CHAMPS_TECHNIQUES.has(k))
    .slice(0, 3)
    .map(([k, v]) => `${k}=${court(v)}`)
    .join(" · ");
  return rafale + champs;
}

export interface CelluleBandeau {
  cle: string;
  libelle: string;
  etat: "ok" | "warn" | "down" | "off" | "unknown" | "info";
  icone: string;
  valeur: string;
  detail: string;
}

type EtatCellule = CelluleBandeau["etat"];

const ICONES: Readonly<Record<EtatCellule, string>> = {
  ok: "ph-check-circle",
  warn: "ph-warning",
  down: "ph-warning-octagon",
  off: "ph-minus-circle",
  unknown: "ph-question",
  info: "ph-snowflake",
};

const cellule = (
  cle: string,
  libelle: string,
  etat: EtatCellule,
  valeur: string,
  detail: string,
): CelluleBandeau => ({ cle, libelle, etat, icone: ICONES[etat], valeur, detail });

/** Cinq cellules du bandeau : conservation, gel, centralisation, horloge, disque. */
export function cellulesBandeau(e: EtatJournal): CelluleBandeau[] {
  const r = e.retention;
  const f = e.forwarding;
  const conservation = r.invalid
    ? cellule("conservation", "Conservation", "down", "Durée illisible", "Purge suspendue")
    : cellule(
        "conservation",
        "Conservation",
        r.out_of_bounds || r.from_witness ? "warn" : "ok",
        `${r.retention_days} jours`,
        `${e.oldest ? `Depuis le ${jourFr(e.oldest)} · ` : ""}${octets(e.bytes)}`,
      );
  const gel = r.hold
    ? cellule("gel", "Gel de la purge", "info", "Gel actif", r.hold_reason)
    : cellule("gel", "Gel de la purge", "off", "Aucun gel", "Purge chaque nuit au-delà de la durée");
  const actif = f.agent !== null && f.active === true && f.rule !== null;
  const certAlerte = f.certificates.some((c) => !c.readable || (c.days_left !== null && c.days_left < 30));
  const centralisation = !f.expected
    ? cellule("centralisation", "Centralisation", "off", "Non attendue", "Purge sans vérifier l'envoi")
    : actif
      ? cellule(
          "centralisation",
          "Centralisation",
          certAlerte ? "warn" : "ok",
          `${f.agent} actif`,
          certAlerte ? "Certificat à vérifier" : "Envoi vers le collecteur",
        )
      : cellule(
          "centralisation",
          "Centralisation",
          "down",
          "Attendue, absente",
          `${f.agent ? `${f.agent} arrêté` : "Aucun agent"} · purge suspendue`,
        );
  const horloge =
    e.clock_synchronized === true
      ? cellule("horloge", "Horloge", "ok", "Synchronisée", "Horodatages fiables")
      : e.clock_synchronized === false
        ? cellule("horloge", "Horloge", "warn", "Non synchronisée", "Horodatages peu fiables")
        : cellule("horloge", "Horloge", "unknown", "Inconnue", "timedatectl sans réponse");
  const d = e.disk;
  const jours = d?.days_left ?? null;
  const disque = !d
    ? cellule("disque", "Disque", "unknown", "Inconnu", "Espace libre non relevé")
    : cellule(
        "disque",
        "Disque",
        jours !== null && jours < 7 ? "down" : jours !== null && jours < 30 ? "warn" : "ok",
        `${octets(d.free_bytes)} libres`,
        jours !== null && jours < 30
          ? `Plein dans ${jours} jours au rythme actuel`
          : e.daily_avg_bytes !== null
            ? `≈ ${octets(e.daily_avg_bytes)} par jour`
            : "Rythme inconnu",
      );
  return [conservation, gel, centralisation, horloge, disque];
}

/** Écrivains encore actifs (non arrêtés proprement) : texte du pied du bandeau. */
export function resumeEcrivains(e: EtatJournal): string {
  const actifs = e.writers.filter((w) => !w.stopped).length;
  const arretes = e.writers.length - actifs;
  return `${pluriel(actifs, "écrivain")} actif${actifs > 1 ? "s" : ""}${arretes ? `, ${arretes} arrêté${arretes > 1 ? "s" : ""}` : ""}`;
}

export interface AnomalieVerification {
  type: string;
  texte: string;
}

const lieu = (x: { file: string; line: number }): string => `${x.file}, ligne ${x.line}`;
const court = (boot: string): string => (boot ? `${boot.slice(0, 8)}…` : "");

/** Anomalies du résultat, une ligne chacune (les listes du serveur sont bornées à 100 par catégorie). */
export function anomaliesDe(v: VerificationJournal): AnomalieVerification[] {
  const sortie: AnomalieVerification[] = [];
  for (const x of v.invalid_signatures) sortie.push({ type: "Signature invalide", texte: lieu(x) });
  for (const x of v.gaps)
    sortie.push({
      type: x.kind === "fichiers" ? "Fichiers manquants" : "Numéros manquants",
      texte:
        x.kind === "fichiers"
          ? lieu(x)
          : `${lieu(x)} · ${x.service} · boot ${court(x.boot)} · n° ${x.from} à ${x.to} (${pluriel(x.to - x.from + 1, "ligne")}) · ${x.kind}`,
    });
  for (const x of v.unreadable) sortie.push({ type: "Ligne illisible", texte: lieu(x) });
  for (const x of v.out_of_order) sortie.push({ type: "Ligne hors ordre", texte: lieu(x) });
  for (const x of v.unverified) sortie.push({ type: "Ligne non vérifiée", texte: lieu(x) });
  for (const x of v.inconsistent) sortie.push({ type: "Ligne incohérente", texte: lieu(x) });
  for (const x of v.misplaced) sortie.push({ type: "Ligne dans le mauvais fichier", texte: lieu(x) });
  for (const x of v.duplicates) sortie.push({ type: "Copie à l'identique", texte: lieu(x) });
  for (const x of v.uncertain_ends)
    sortie.push({
      type: "Fin incertaine",
      texte: `${x.service} · boot ${court(x.boot)} · dernière ligne le ${heureLocale(x.last_ts)} (${x.reason === "silence_fin_periode" ? "silence jusqu'à la fin de la période" : "silence avant l'écrivain suivant"})`,
    });
  return sortie;
}

/** Total hors listes bornées : lignes en cause comptées par le serveur mais non listées. */
function anomaliesNonListees(v: VerificationJournal, listees: number): number {
  const t = v.totals;
  const total =
    t.invalid_signatures +
    t.unreadable +
    t.gaps +
    t.out_of_order +
    t.unverified +
    t.inconsistent +
    t.misplaced +
    t.late_v0 +
    t.duplicates;
  return Math.max(0, total - listees);
}

/** Phrase de la période vérifiée (jours UTC). */
export function textePeriode(du: string, au: string): string {
  return du === au ? `du ${jourFr(du)}` : `du ${jourFr(du)} au ${jourFr(au)}`;
}

/** Pourquoi le statut est « non vérifié » : lignes non signées, clé inconnue ou absente, puis motifs du serveur. */
export function motifsNonVerifie(v: VerificationJournal): string[] {
  const m: string[] = [];
  if (!v.key_available)
    m.push("La clé de signature est absente de ce serveur : aucune signature n'a pu être contrôlée.");
  if (v.unsigned > 0)
    m.push(
      `${pluriel(v.unsigned, "ligne")} non signée${v.unsigned > 1 ? "s" : ""} (écrite${v.unsigned > 1 ? "s" : ""} avant la mise en place de la clé).`,
    );
  if (v.unknown_key > 0)
    m.push(`${pluriel(v.unknown_key, "ligne")} signée${v.unknown_key > 1 ? "s" : ""} avec une clé inconnue.`);
  for (const r of v.reasons) m.push(r.text);
  return m;
}

const ANOMALIES_PAR_CATEGORIE = 20;
const ANOMALIES_TOTAL = 200;

/** Anomalies affichées (20 par catégorie, 200 au total) et nombre d'autres lignes en cause, listées ou non par le serveur. */
export function anomaliesBornees(v: VerificationJournal): { lignes: AnomalieVerification[]; autres: number } {
  const toutes = anomaliesDe(v);
  const vues = new Map<string, number>();
  const lignes: AnomalieVerification[] = [];
  for (const a of toutes) {
    const n = vues.get(a.type) ?? 0;
    if (n >= ANOMALIES_PAR_CATEGORIE || lignes.length >= ANOMALIES_TOTAL) continue;
    vues.set(a.type, n + 1);
    lignes.push(a);
  }
  const listees = toutes.filter((a) => a.type !== "Fin incertaine").length;
  return { lignes, autres: toutes.length - lignes.length + anomaliesNonListees(v, listees) };
}
