// SPDX-License-Identifier: MIT
// browser-service/src/session_util.ts — helpers de cycle de vie des sessions (extraits de
// server.js pour être testables sans Playwright — cf. nav_util.js).
//
// AUDIT 2026-06 :
//   - pingPage : borne les ``page.evaluate(() => true)`` de sondage. Avant,
//     une page GELÉE (script lourd, protocole CDP muet) bloquait
//     indéfiniment le reaper — qui ne tournait alors PLUS pour toutes les
//     autres sessions — ou une requête entrante dans getSession.
//   - planScreenshotQuota : quota par session pour les fichiers qui
//     s'accumulent (step_/shot_/fail_). Le reaper existant ne couvrait que
//     l'âge (orphan 5 min / stale 4 h) : une session active de longue durée
//     pouvait accumuler des milliers de PNG sans limite.

import path from "node:path";
import type { Page } from "playwright";

import { lockIdle } from "./session_lock.ts";
import type { Verrou } from "./session_lock.ts";

/** Verdict d'une sonde de page. */
export type VerdictPing = "ok" | "crashed" | "frozen";

/** Capture du dossier des captures, pour le quota par session. */
export interface EntreeCapture {
  name: string;
  sid: string;
  mtimeMs: number;
  size: number;
}

/** Fichier d'artefact daté, pour la purge par âge. */
export interface EntreeArtefact {
  name: string;
  mtimeMs: number;
}

/** Ce que les plans de sessions lisent d'une session : propriétaire, groupe, dates, isolement, verrou, connexion en cours, politique TLS. */
export interface SessionPlace {
  owner?: string;
  group?: string;
  createdAt?: number;
  lastActivity?: number;
  isolated?: boolean;
  _lock?: Verrou;
  _connexionEnCours?: unknown;
  tls?: unknown;
}

/** Sessions d'un groupe : celles du compte et celles de ses sous-agents. */
export interface Occupation {
  compte: number;
  enfants: number;
}

/** Plafonds de sessions par propriétaire et par groupe. */
export interface Quotas {
  maxPerOwner: number;
  maxPerGroup: number;
}

/** Plan de place d'une nouvelle session : session à évincer, ou refus et sa cause. */
export type PlanPlace =
  | { evict: string; refuse: false; limit: "owner" | "group" }
  | { evict: null; refuse: true; cause: "protegees"; limit: "owner" | "group"; protected: string[] }
  | { evict: null; refuse: true; cause: "groupe" }
  | { evict: null; refuse: false };

/** Plafonds et choix des sessions cessibles d'un plan de place. */
export interface OptionsPlace {
  maxPerOwner: number;
  group?: string;
  maxPerGroup?: number;
  now?: number;
  cessible?: (s: SessionPlace, sid: string) => boolean;
}

/** État sauvegardé introuvable : réponse 404 à rendre. */
export interface EtatIntrouvable {
  code: "state_not_found";
  error: string;
  fix: string;
}

// Rejet d'une page VIVANTE dont le contexte d'exécution change (navigation, page d'erreur après un goto échoué).
const _CONTEXTE_EN_NAVIGATION =
  /Execution context was destroyed|Cannot find context with specified id|most likely because of a navigation/i;

/**
 * Sonde une page Playwright avec un timeout dur.
 * @returns {'ok'|'crashed'|'frozen'}
 *   - ok      : la page répond.
 *   - crashed : evaluate a rejeté (page/context fermé ou crashé).
 *   - frozen  : pas de réponse sous `ms` — la page est peut-être juste
 *               occupée (script long) : à traiter en fail-open côté requête,
 *               et en « N strikes » côté reaper.
 *   Un contexte détruit par une navigation n'est pas un crash : la page est resondée dans le même délai.
 */

export async function pingPage(
  page: Pick<Page, "evaluate"> & Partial<Pick<Page, "isClosed">>,
  ms = 5000,
): Promise<VerdictPing> {
  const fin = Date.now() + ms;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    for (;;) {
      const reste = fin - Date.now();
      if (reste <= 0) return "frozen";
      // NB : pas de timer.unref() — si l'evaluate ne répond jamais, le
      // timer DOIT pouvoir tirer même s'il est le dernier handle vivant
      // (sinon la race reste pendante à jamais). Il est de toute façon
      // clearTimeout-é dès que l'evaluate répond (finally).
      const verdict = await Promise.race([
        page
          .evaluate(() => true)
          .then(
            (): "ok" => "ok",
            (e: Error | null | undefined): "navigating" | "crashed" => {
              const ferme = typeof page.isClosed === "function" && page.isClosed();
              return !ferme && _CONTEXTE_EN_NAVIGATION.test(String(e && e.message))
                ? "navigating"
                : "crashed";
            },
          ),
        new Promise<"frozen">((resolve) => {
          timer = setTimeout(() => resolve("frozen"), reste);
        }),
      ]);
      clearTimeout(timer);
      if (verdict !== "navigating") return verdict;
      await new Promise((resolve) => setTimeout(resolve, Math.min(100, Math.max(0, fin - Date.now()))));
    }
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Calcule les fichiers screenshots à supprimer pour respecter le quota
 * par session. Fonction PURE (pas d'I/O) — l'appelant fournit les entrées
 * et exécute les unlink.
 *
 * Seuls les genres qui s'ACCUMULENT sont éligibles (step_/vision_/shot_/fail_) ;
 * smart_/view_ (et live_ des versions antérieures) sont un fichier unique par
 * session, écrasé en place.
 *
 * @param {Array<{name: string, sid: string, mtimeMs: number, size: number}>} entries
 * @param {{maxPerSession?: number, maxBytesPerSession?: number}} caps
 * @returns {string[]} noms de fichiers à supprimer (les plus anciens d'abord)
 */
export function planScreenshotQuota(
  entries: readonly EntreeCapture[],
  caps: { maxPerSession?: number; maxBytesPerSession?: number } = {},
): string[] {
  const maxCount = caps.maxPerSession ?? 300;
  const maxBytes = caps.maxBytesPerSession ?? 200 * 1024 * 1024;

  const evictable = entries.filter((e) => /^(?:step|vision|shot|fail)_/.test(e.name));

  const bySid = new Map<string, EntreeCapture[]>();
  for (const e of evictable) {
    if (!bySid.has(e.sid)) bySid.set(e.sid, []);
    bySid.get(e.sid)!.push(e);
  }

  const toDelete: string[] = [];
  for (const list of bySid.values()) {
    // Plus récents d'abord : on garde la tête jusqu'aux caps.
    list.sort((a, b) => b.mtimeMs - a.mtimeMs);
    let kept = 0,
      keptBytes = 0;
    for (const e of list) {
      keptBytes += e.size || 0;
      kept += 1;
      if (kept > maxCount || keptBytes > maxBytes) toDelete.push(e.name);
    }
  }
  // Les plus anciens d'abord (ordre de suppression naturel).
  return toDelete.reverse();
}

// ── Propriété des sessions (2026-09-30) ─────────────────────────────────────
// Le service ne sait pas qui l'appelle : c'est l'appelant (les outils pw_*,
// côté Python) qui transmet le propriétaire (``owner``, dérivé du compte
// Elpis) à CHAQUE requête. Une session n'est servie qu'à son propriétaire ;
// une session d'un autre compte répond comme une session inconnue.

/** Chemin d'un fichier du service, tenu sous `dossier` : un nom qui en sortirait (`..`, chemin absolu) est refusé. */
export function sous(dossier: string, ...segments: string[]): string {
  const racine = path.resolve(dossier);
  const chemin = path.resolve(racine, ...segments);
  if (!chemin.startsWith(racine + path.sep))
    throw Object.assign(new Error("This file name leaves the folder of the browser service's files."), {
      code: "invalid_name",
    });
  return chemin;
}

/** Propriétaire normalisé (``[A-Za-z0-9_-]``, 64 max), ou ``''``. */
export function safeOwner(owner: unknown): string {
  const s = String(owner ?? "")
    .replace(/[^A-Za-z0-9_-]/g, "")
    .slice(0, 64);
  return s;
}

/** Propriétaire transmis par une requête (corps JSON puis paramètres). */
export function ownerFromRequest(req: { body?: unknown; query?: unknown } | null | undefined): string {
  const b =
    req && req.body && typeof req.body === "object" ? (req.body as { owner?: unknown }).owner : undefined;
  const q = req && req.query ? (req.query as { owner?: unknown }).owner : undefined;
  return safeOwner(b ?? q ?? "");
}

/** Sessions que ferme le nettoyage de ``owner`` : les siennes et celles des sous-agents de son groupe. */
export function sessionsANettoyer(
  sessions: ReadonlyMap<string, SessionPlace | null | undefined>,
  owner: unknown,
): string[] {
  const o = safeOwner(owner);
  const sids: string[] = [];
  if (!o) return sids;
  for (const [sid, s] of sessions) if (s && (s.owner === o || (s.group || s.owner) === o)) sids.push(sid);
  return sids;
}

/** Sessions de sous-agents (propriétaire dérivé ``s_…`` hors de son groupe) ouvertes depuis ``ageMinMs`` au moins ; jamais celle du compte. */
export function sessionsEnfantsAnciennes(
  sessions: ReadonlyMap<string, SessionPlace | null | undefined>,
  { ageMinMs, now = Date.now() }: { ageMinMs: number; now?: number },
): string[] {
  const sids: string[] = [];
  for (const [sid, s] of sessions) {
    const enfant = !!s && !!s.group && s.owner !== s.group && String(s.owner || "").startsWith("s_");
    if (enfant && now - (s.createdAt || 0) >= ageMinMs) sids.push(sid);
  }
  return sids;
}

/** La session appartient-elle à ce propriétaire ? (jamais pour un vide) */
export function ownerMatches(session: { owner?: string } | null | undefined, owner: unknown): boolean {
  const o = safeOwner(owner);
  return !!o && !!session && session.owner === o;
}

// Identifiant d'état sauvegardé : celui de la session (uuid).
const _STATE_ID_RE = /^[A-Za-z0-9-]{8,64}$/;

/**
 * Nom du fichier d'un état sauvegardé (cookies, stockage local) : lié au
 * propriétaire, pour qu'un compte ne recharge jamais l'état d'un autre.
 * → ``null`` si l'identifiant ou le propriétaire est invalide.
 */
export function stateFileName(owner: unknown, stateId: unknown): string | null {
  const o = safeOwner(owner);
  const id = String(stateId ?? "");
  if (!o || !_STATE_ID_RE.test(id)) return null;
  return `state_${o}__${id}.json`;
}

/** État à charger au démarrage d'une session de ``owner`` (``exists(nom)`` : ``cookies/<nom>`` existe) : ``{ file }``, sinon ``state_not_found`` à rendre en 404, durée de conservation (``maxAgeDays``, 0 : pas de purge) rappelée ; l'état d'un autre compte répond comme un état inconnu. */
export function resolveStateFile(
  owner: unknown,
  stateId: unknown,
  exists: (nom: string) => boolean,
  { maxAgeDays = 0 }: { maxAgeDays?: number } = {},
): { file: string } | EtatIntrouvable {
  const nom = stateFileName(owner, stateId);
  if (nom && exists(nom)) return { file: nom };
  const purge =
    maxAgeDays > 0
      ? ` Un état est supprimé ${maxAgeDays} jours après son enregistrement, même s'il sert : ` +
        "save_state en crée un nouveau, sous l'identifiant de la session."
      : "";
  return {
    code: "state_not_found",
    error: "État sauvegardé introuvable (load_state_id).",
    fix:
      "Utilisez le state_id rendu par save_state sur ce compte, ou démarrez sans " + `load_state_id.${purge}`,
  };
}

/** Nom de fichier sûr pour un téléchargement (jamais de chemin). */
export function safeDownloadName(name: unknown): string {
  const base = String(name ?? "")
    .split(/[\\/]/)
    .pop()!
    // eslint-disable-next-line no-control-regex -- les caractères de contrôle sont précisément ce qu'on retire
    .replace(/[\x00-\x1f]/g, "")
    .trim();
  if (!base || base === "." || base === "..") return "telechargement";
  return base.slice(0, 200);
}

/** Fichiers d'artefacts à purger (``entries`` : ``[{ name, mtimeMs }]``) : ceux plus vieux que ``maxAgeMs``. */
export function planArtifactPurge(
  entries: readonly EntreeArtefact[] | null | undefined,
  { now = Date.now(), maxAgeMs }: { now?: number; maxAgeMs?: number } = {},
): string[] {
  if (!maxAgeMs || maxAgeMs <= 0) return [];
  return (entries || []).filter((e) => e && now - (e.mtimeMs || 0) > maxAgeMs).map((e) => e.name);
}

// Quotas de sessions du compte, lus de l'environnement : `BROWSER_MAX_SESSIONS_PER_OWNER` (un propriétaire) et `BROWSER_MAX_SESSIONS_PER_GROUP` (le compte et ses sous-agents, jamais sous le quota d'un propriétaire).
export function quotasSessions(env: Readonly<Record<string, string | undefined>> = process.env): Quotas {
  const lire = (nom: string, defaut: number) =>
    Math.max(1, parseInt(env[nom] || String(defaut), 10) || defaut);
  const maxPerOwner = lire("BROWSER_MAX_SESSIONS_PER_OWNER", 3);
  return { maxPerOwner, maxPerGroup: Math.max(maxPerOwner, lire("BROWSER_MAX_SESSIONS_PER_GROUP", 4)) };
}

// Sessions d'un groupe : celles du compte (propriétaire = groupe) et celles de ses sous-agents à session isolée.
export function occupationGroupe(
  sessions: ReadonlyMap<string, SessionPlace | null | undefined>,
  group: string,
): Occupation {
  let compte = 0;
  let enfants = 0;
  for (const s of sessions.values()) {
    if (!s || (s.group || s.owner) !== group) continue;
    if (s.owner === group) compte += 1;
    else enfants += 1;
  }
  return { compte, enfants };
}

// Places que les sous-agents se partagent : le groupe moins la session du compte, ou la place qui lui reste réservée
// tant qu'il n'en a pas (le chat n'est jamais refusé parce que ses enfants occupent tout).
export function placesEnfants(occupation: Occupation, maxPerGroup: number): number {
  return Math.max(0, maxPerGroup - Math.max(1, occupation.compte));
}

// Session qui peut céder sa place : aucune requête en cours ni en attente, aucune connexion, pas ouverte pour un secret du coffre.
export function sessionCessible(s: SessionPlace | null | undefined): boolean {
  return !!s && lockIdle(s._lock) && !s._connexionEnCours && !s.tls;
}

// Place d'une nouvelle session : au plafond (propriétaire, groupe), une session du demandeur que `cessible` ne protège pas cède (isolée avant principale, plus ancienne d'abord), jamais celle d'un autre ; sinon refus (`protegees`, `groupe`).
export function planSessionSlot(
  sessions: ReadonlyMap<string, SessionPlace | null | undefined>,
  owner: string,
  {
    maxPerOwner,
    group = owner,
    maxPerGroup = maxPerOwner,
    now = Date.now(),
    cessible = sessionCessible,
  }: OptionsPlace,
): PlanPlace {
  const age = (s: SessionPlace) => (s && (s.lastActivity || s.createdAt)) || now;
  const own: [string, number, number][] = [];
  const protegees: [string, number, number][] = [];
  for (const [sid, s] of sessions)
    if (s && s.owner === owner) (cessible(s, sid) ? own : protegees).push([sid, age(s), s.isolated ? 0 : 1]);
  own.sort((a, b) => a[2] - b[2] || a[1] - b[1]);
  const occupation = occupationGroupe(sessions, group);
  const groupePlein =
    owner === group
      ? occupation.compte + occupation.enfants >= maxPerGroup
      : occupation.enfants >= placesEnfants(occupation, maxPerGroup);
  const siennes = own.length + protegees.length;
  const limite = siennes >= maxPerOwner ? "owner" : groupePlein ? "group" : null;
  if (limite && siennes) {
    if (own.length) return { evict: own[0]![0], refuse: false, limit: limite };
    return {
      evict: null,
      refuse: true,
      cause: "protegees",
      limit: limite,
      protected: protegees.map((p) => p[0]),
    };
  }
  if (groupePlein) return { evict: null, refuse: true, cause: "groupe" };
  return { evict: null, refuse: false };
}
