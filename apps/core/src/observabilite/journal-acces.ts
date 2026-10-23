// SPDX-License-Identifier: MIT
/** apps/core/src/observabilite/journal-acces.ts — journal commun du process (shared_infra/observability/access_logging.py) : ligne de démarrage, copie des journaux du process, une ligne par requête HTTP, événements explicites (relecture : admin/journaux.ts). */
import type { ServerResponse } from "node:http";

import { ipClient } from "@elpis/auth";
import type { Reseau, Session } from "@elpis/auth";
import { estErreurPython, intPy, prefixePy, reprPy } from "@elpis/commun";
import { racineDepot } from "@elpis/config";
import type { FastifyInstance, FastifyRequest } from "fastify";

import {
  cheminJournalCommun,
  ecrivainJournalCommun,
  masquerJetonsApercu,
} from "../evenements/journal-commun";
import type { EcrivainJournal } from "../evenements/journal-commun";
import type { EcrireJournal } from "../evenements/systeme";
import { installerCrochetJournal } from "../journal";
import type { CrochetJournal } from "../journal";
import { decouperCible, desechapper, erreursInattendues } from "@elpis/http";

/** Chemins jamais journalisés (très bavards, sans valeur). */
export const HTTP_SKIP_EXACT: ReadonlySet<string> = new Set([
  "/api/health",
  "/api/system-events",
  "/api/code/stream",
  "/api/code/pull",
  "/api/code/ingest",
  "/favicon.ico",
]);
export const HTTP_SKIP_PREFIXES: readonly string[] = ["/static/", "/avatars/", "/api/webhooks/"];

/** 404 attendus sur le process qui n'expose pas ces préfixes : rétrogradés en DEBUG, jamais diffusés en direct. */
export const EXPECTED_404_BY_MODE: readonly (readonly [string, string])[] = [
  ["admin", "/api/llm/"],
  ["admin", "/api/saved/"],
  ["admin", "/api/sandbox/"],
  ["admin", "/api/chat/"],
  ["admin", "/api/pipelines"],
  ["admin", "/api/inbox/"],
  ["admin", "/api/rag/"],
  ["admin", "/api/mcp/"],
  ["admin", "/api/playwright/"],
  ["admin", "/api/diag/"],
  ["admin", "/api/debug/"],
  ["admin", "/api/tools/"],
  ["admin", "/api/prompts"],
  ["admin", "/api/cli/"],
  ["admin", "/ws/"],
  ["main", "/api/admin/"],
];

const CATEGORY_RULES: readonly (readonly [readonly string[], string])[] = [
  [["/api/login-lite", "/api/logout-lite", "/api/users/change-password", "/api/me-lite"], "auth"],
  [["/api/admin/"], "admin"],
];

/** `_categorize` : première règle dont un préfixe correspond, `http` sinon. */
export function categoriser(chemin: string): string {
  for (const [prefixes, categorie] of CATEGORY_RULES)
    if (prefixes.some((p) => chemin === p || chemin.startsWith(p))) return categorie;
  return "http";
}

export function ignoreParJournalAcces(chemin: string): boolean {
  return HTTP_SKIP_EXACT.has(chemin) || HTTP_SKIP_PREFIXES.some((p) => chemin.startsWith(p));
}

/** `repr(exc)` d'une exception : `Type('message')`, `Type()` sans message. */
export function reprErreur(e: unknown): string {
  if (!(e instanceof Error)) return reprPy(e);
  const nom = estErreurPython(e) ? e.type : e.name;
  return e.message ? `${nom}(${reprPy(e.message)})` : `${nom}()`;
}

interface JournalProcess {
  readonly service: string;
  readonly chemin: string;
  readonly ecrire: EcrivainJournal;
}

let processus: JournalProcess | null = null;
let historique: CrochetJournal | null = null;

/** Crochet des journaux du process : historique du bus (`SSELogHandler`) et fichier commun (`FileEventHandler`), chacun au mieux. */
function relayer(niveau: string, message: string, date: Date): void {
  try {
    historique?.(niveau, masquerJetonsApercu(message), date);
  } finally {
    processus?.ecrire({
      level: niveau,
      category: niveau === "ERROR" || niveau === "CRITICAL" ? "system" : "app",
      message,
      logger: "uvicorn.error",
    });
  }
}

/** `configure(service)` : écrivain du process et copie de ses journaux ; la ligne « starting » marque le démarrage (une fois par service et fichier). */
export function configurerJournalProcess(service: string, chemin: string): EcrivainJournal {
  if (processus?.service === service && processus.chemin === chemin) return processus.ecrire;
  processus?.ecrire.fermer();
  processus = { service, chemin, ecrire: ecrivainJournalCommun(chemin, service) };
  installerCrochetJournal(relayer);
  processus.ecrire({
    level: "INFO",
    category: "system",
    message: `Service '${service}' starting (pid=${process.pid})`,
    logger: "access_logging",
  });
  return processus.ecrire;
}

/** Écrivain du process s'il est configuré (pour ce fichier, quand il est précisé). */
export function ecrivainDuProcess(chemin?: string): EcrivainJournal | null {
  if (processus === null || (chemin !== undefined && processus.chemin !== chemin)) return null;
  return processus.ecrire;
}

/** Historique en mémoire du bus, alimenté par le même crochet que le fichier commun. */
export function brancherHistoriqueJournal(h: CrochetJournal | null): void {
  historique = h;
  installerCrochetJournal(relayer);
}

/** Pour les tests : écrivain fermé, crochet retiré. */
export function oublierJournalProcess(): void {
  processus?.ecrire.fermer();
  processus = null;
  historique = null;
  installerCrochetJournal(null);
}

/** Sans `configure`, le fichier du dépôt et le service d'`APP_SERVICE` (main par défaut), comme le module Python à l'import. */
function ecrivainCourant(): EcrivainJournal {
  if (processus === null) {
    const service = (process.env["APP_SERVICE"] ?? "main").toLowerCase();
    const chemin = cheminJournalCommun(racineDepot());
    processus = { service, chemin, ecrire: ecrivainJournalCommun(chemin, service) };
  }
  return processus.ecrire;
}

/** `log_event` : événement applicatif explicite ; `live: false` le garde hors de la console staff. */
export function logEvent(
  category: string,
  level: string,
  message: string,
  options: { live?: boolean; extras?: Readonly<Record<string, unknown>> } = {},
): void {
  ecrivainCourant()({
    level: level.toUpperCase(),
    category,
    message,
    logger: "app",
    extras: options.extras ?? null,
    live: options.live ?? true,
  });
}

export interface OptionsJournalAcces {
  readonly service: string;
  readonly mandataires: readonly Reseau[];
  readonly ecrire?: () => EcrireJournal;
}

/** `request.session.get("user_id")` lu après le traitement (connexion et déconnexion comprises) ; illisible → aucun. */
function compteDeSession(requete: FastifyRequest): number | null {
  try {
    const s = (requete as { session?: Session | null }).session;
    const sid = s?.contenu()["user_id"];
    return sid === undefined || sid === null ? null : intPy(sid);
  } catch {
    return null;
  }
}

function niveauAcces(statut: number, chemin: string, service: string): string {
  if (statut === 404 && EXPECTED_404_BY_MODE.some(([mode, p]) => service === mode && chemin.startsWith(p)))
    return "DEBUG";
  if (statut >= 500) return "ERROR";
  return statut >= 400 ? "WARNING" : "INFO";
}

/** Ligne `http` d'une requête finie : statut, durée, compte, IP (X-Forwarded-For cru des seuls mandataires), exception inattendue. */
function journaliserRequete(
  requete: FastifyRequest,
  reponse: ServerResponse,
  chemin: string,
  debut: number,
  o: OptionsJournalAcces,
): void {
  let statut = reponse.headersSent ? reponse.statusCode : 0;
  const erreur = erreursInattendues.get(requete);
  if (erreur !== undefined) statut = statut || 500;
  const duree = Math.trunc(performance.now() - debut);
  const uid = compteDeSession(requete);
  const pair =
    requete.ip.startsWith("::ffff:") && requete.ip.includes(".") ? requete.ip.slice(7) : requete.ip;
  const ip = ipClient(pair, requete.headers, o.mandataires);
  const categorie = categoriser(chemin);
  const niveau = niveauAcces(statut, chemin, o.service);
  let message = `${requete.method} ${chemin} → ${statut} (${duree}ms) ${uid === null ? "uid=-" : `uid=${uid}`} ip=${ip}`;
  if (erreur !== undefined) message += ` err=${prefixePy(reprErreur(erreur), 200)}`;
  const live =
    niveau !== "DEBUG" &&
    (statut >= 400 || ["admin", "auth", "security"].includes(categorie) || chemin.startsWith("/api/admin"));
  (o.ecrire ?? ecrivainCourant)()({
    level: niveau,
    category: categorie,
    message,
    logger: "http",
    extras: { method: requete.method, path: chemin, status: statut, duration_ms: duree, user_id: uid, ip },
    live,
  });
}

/** `RequestLoggingMiddleware` : une ligne par requête HTTP finie (WebSocket et chemins bavards exclus), écrite à la fin de la réponse. */
export function journalAcces(o: OptionsJournalAcces): (app: FastifyInstance) => void {
  return (app) => {
    app.addHook("onRequest", async (requete, reponse) => {
      if (requete.ws) return;
      const chemin = desechapper(decouperCible(requete.originalUrl).chemin);
      if (ignoreParJournalAcces(chemin)) return;
      const debut = performance.now();
      let fait = false;
      const terminer = (): void => {
        if (fait) return;
        fait = true;
        try {
          journaliserRequete(requete, reponse.raw, chemin, debut, o);
        } catch {
          return;
        }
      };
      reponse.raw.once("finish", terminer);
      reponse.raw.once("close", terminer);
    });
  };
}
