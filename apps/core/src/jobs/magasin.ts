// SPDX-License-Identifier: MIT
/** apps/core/src/jobs/magasin.ts — tables `shell_jobs` et `shell_job_events` : enregistrement sous limites atomiques, états, événements dédoublonnés `(job_id, seq)`, prise atomique des non livrés, listes, purges. */
import { randomBytes } from "node:crypto";

import { estDict, pyJsonLoads } from "@elpis/commun";
import type { Dict } from "@elpis/commun";
import type { Base, Executeur } from "@elpis/db";

import { ETATS_ACTIFS, ETATS_TERMINAUX, lireCharge, nombre } from "./rendu";
import type { ChargeEvenement, EtatJob } from "./rendu";

export interface Job {
  readonly id: string;
  readonly userId: number;
  readonly chatId: string;
  readonly callId: string;
  readonly label: string;
  readonly command: string;
  readonly cwd: string;
  readonly state: EtatJob;
  readonly wakeOn: string[];
  readonly resumeNote: string;
  readonly wake: boolean;
  readonly depth: number;
  readonly turn: Dict;
  readonly host: string;
  readonly pid: number | null;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly killBy: string;
  readonly lastSeq: number;
  readonly lastLine: string;
  readonly createdAt: number;
  readonly startedAt: number | null;
  readonly endedAt: number | null;
  /** Résultat déjà rendu par `execute_shell` (detach_and_wake) : tout événement du job est livré d'office. */
  readonly inline: boolean;
}

/** Événement non livré joint à son job (ce que le réveilleur et la livraison lisent). */
export interface EvenementEnAttente {
  readonly id: number;
  readonly jobId: string;
  readonly chatId: string;
  readonly seq: number;
  readonly kind: string;
  readonly charge: ChargeEvenement;
  readonly label: string;
  readonly resumeNote: string;
  readonly wake: boolean;
  readonly depth: number;
  readonly turn: Dict;
  readonly createdAt: number;
}

export interface DemandeJob {
  readonly uid: number;
  readonly chatId: string;
  readonly callId: string;
  readonly label: string;
  readonly command: string;
  readonly cwd: string;
  readonly wakeOn: readonly string[];
  readonly resumeNote: string;
  readonly wake: boolean;
  readonly depth: number;
  readonly turn: Dict;
  readonly host: string;
}

export type Enregistrement =
  | { readonly ok: true; readonly job: Job; readonly actifsChat: number }
  | { readonly ok: false; readonly portee: "chat" | "user"; readonly actifs: Job[]; readonly max: number };

const ACTIFS_SQL = `(${ETATS_ACTIFS.map((e) => `'${e}'`).join(", ")})`;
const TERMINAUX_SQL = `(${ETATS_TERMINAUX.map((e) => `'${e}'`).join(", ")})`;

function dictJson(v: unknown, defaut: Dict = {}): Dict {
  if (typeof v !== "string") return defaut;
  try {
    const d = JSON.parse(v) as unknown;
    return estDict(d) ? d : defaut;
  } catch {
    return defaut;
  }
}

function listeJson(v: unknown): string[] {
  if (typeof v !== "string") return [];
  try {
    const l = JSON.parse(v) as unknown;
    return Array.isArray(l) ? l.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

const num = (v: unknown): number | null => (v === null || v === undefined ? null : nombre(v));

export function jobDeLigne(r: Dict): Job {
  return {
    id: String(r["id"]),
    userId: Number(r["user_id"]),
    chatId: String(r["chat_id"]),
    callId: String(r["call_id"] ?? ""),
    label: String(r["label"] ?? ""),
    command: String(r["command"] ?? ""),
    cwd: String(r["cwd"] ?? ""),
    state: String(r["state"]) as EtatJob,
    wakeOn: listeJson(r["wake_on_json"]),
    resumeNote: String(r["resume_note"] ?? ""),
    wake: Number(r["wake"]) !== 0,
    depth: Number(r["depth"] ?? 0),
    turn: dictJson(r["turn_json"]),
    host: String(r["host"] ?? ""),
    pid: num(r["pid"]),
    exitCode: num(r["exit_code"]),
    signal: r["exit_signal"] === null || r["exit_signal"] === undefined ? null : String(r["exit_signal"]),
    killBy: String(r["kill_by"] ?? ""),
    lastSeq: Number(r["last_seq"] ?? 0),
    lastLine: String(r["last_line"] ?? ""),
    createdAt: Number(r["created_at"]),
    startedAt: num(r["started_at"]),
    endedAt: num(r["ended_at"]),
    inline: Number(r["inline_result"] ?? 0) !== 0,
  };
}

export function estActif(e: EtatJob): boolean {
  return ETATS_ACTIFS.includes(e);
}

export function estTerminal(e: EtatJob): boolean {
  return ETATS_TERMINAUX.includes(e);
}

/** Enregistre un job sous verrou d'écriture : limites par conversation puis par compte vérifiées dans la même transaction (JB-10). */
export async function enregistrerJob(
  base: Base,
  d: DemandeJob,
  limites: { parChat: number; parCompte: number },
  maintenant: number,
): Promise<Enregistrement> {
  return base.ecriture(async (tx) => {
    const duCompte = (
      await tx.all(
        `SELECT * FROM shell_jobs WHERE user_id=? AND state IN ${ACTIFS_SQL} ORDER BY created_at`,
        [d.uid],
      )
    ).map(jobDeLigne);
    const duChat = duCompte.filter((j) => j.chatId === d.chatId);
    if (duChat.length >= limites.parChat)
      return { ok: false as const, portee: "chat" as const, actifs: duChat, max: limites.parChat };
    if (duCompte.length >= limites.parCompte)
      return { ok: false as const, portee: "user" as const, actifs: duCompte, max: limites.parCompte };
    let id = "";
    for (let i = 0; i < 8 && !id; i++) {
      const essai = `j-${randomBytes(4).toString("hex")}`;
      if (!(await tx.get("SELECT 1 FROM shell_jobs WHERE id=?", [essai]))) id = essai;
    }
    if (!id) throw new Error("identifiant de job introuvable");
    await tx.run(
      "INSERT INTO shell_jobs(id, user_id, chat_id, call_id, label, command, cwd, state, wake_on_json, resume_note, " +
        "wake, depth, turn_json, host, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'starting', ?, ?, ?, ?, ?, ?, ?)",
      [
        id,
        d.uid,
        d.chatId,
        d.callId,
        d.label,
        d.command,
        d.cwd,
        JSON.stringify(d.wakeOn),
        d.resumeNote,
        d.wake ? 1 : 0,
        d.depth,
        JSON.stringify(d.turn),
        d.host,
        maintenant,
      ],
    );
    const job = jobDeLigne((await tx.get("SELECT * FROM shell_jobs WHERE id=?", [id]))!);
    return { ok: true as const, job, actifsChat: duChat.length + 1 };
  });
}

export async function lireJob(x: Executeur, uid: number, id: string): Promise<Job | null> {
  const r = await x.get(`SELECT * FROM shell_jobs WHERE id=? AND user_id=? AND kill_by <> '${DETACHE}'`, [
    id,
    uid,
  ]);
  return r ? jobDeLigne(r) : null;
}

/** Jobs d'une conversation, ou du compte sans `chatId`, les plus récents d'abord. */
export async function listerJobs(x: Executeur, uid: number, chatId: string | null): Promise<Job[]> {
  const lignes =
    chatId === null
      ? await x.all(
          `SELECT * FROM shell_jobs WHERE user_id=? AND kill_by <> '${DETACHE}' ORDER BY created_at DESC`,
          [uid],
        )
      : await x.all(
          `SELECT * FROM shell_jobs WHERE user_id=? AND chat_id=? AND kill_by <> '${DETACHE}' ORDER BY created_at DESC`,
          [uid, chatId],
        );
  return lignes.map(jobDeLigne);
}

/** Jobs actifs de tous les comptes (veille confiée aux hôtes d'outils). */
export async function jobsActifs(x: Executeur): Promise<Job[]> {
  return (await x.all(`SELECT * FROM shell_jobs WHERE state IN ${ACTIFS_SQL} ORDER BY created_at`)).map(
    jobDeLigne,
  );
}

export async function compterActifs(x: Executeur, uid: number, chatId: string | null): Promise<number> {
  const r =
    chatId === null
      ? await x.get(`SELECT COUNT(*) AS n FROM shell_jobs WHERE user_id=? AND state IN ${ACTIFS_SQL}`, [uid])
      : await x.get(
          `SELECT COUNT(*) AS n FROM shell_jobs WHERE user_id=? AND chat_id=? AND state IN ${ACTIFS_SQL}`,
          [uid, chatId],
        );
  return Number(r?.["n"] ?? 0);
}

/** Dernier seq acquitté du compte : le plus grand reçu pour un de ses jobs. */
export async function dernierSeqDuCompte(x: Executeur, uid: number): Promise<number> {
  const r = await x.get("SELECT MAX(last_seq) AS s FROM shell_jobs WHERE user_id=?", [uid]);
  return Number(r?.["s"] ?? 0);
}

/** `starting` → `running` (pid ; aussi pour un job déjà passé `running` par ses événements, sans pid) ou `failed` (message) ; rend le job changé, `null` s'il n'est pas à ce compte ou déjà lancé. */
export async function poserLancement(
  base: Base,
  uid: number,
  id: string,
  maj: { state: "running" | "failed"; pid: number | null; erreur: string },
  maintenant: number,
): Promise<Job | null> {
  return base.ecriture(async (tx) => {
    const r =
      maj.state === "running"
        ? await tx.run(
            "UPDATE shell_jobs SET state='running', pid=?, started_at=COALESCE(started_at, ?) " +
              "WHERE id=? AND user_id=? AND (state='starting' OR (state='running' AND pid IS NULL))",
            [maj.pid, maintenant, id, uid],
          )
        : await tx.run(
            "UPDATE shell_jobs SET state='failed', ended_at=?, last_line=? WHERE id=? AND user_id=? AND state IN ('starting', 'running')",
            [maintenant, maj.erreur, id, uid],
          );
    if (r.changes === 0) return null;
    return jobDeLigne((await tx.get("SELECT * FROM shell_jobs WHERE id=?", [id]))!);
  });
}

export async function poserArret(
  x: Executeur,
  uid: number,
  ids: readonly string[],
  par: string,
): Promise<void> {
  for (const id of ids)
    await x.run("UPDATE shell_jobs SET kill_by=? WHERE id=? AND user_id=? AND kill_by=''", [par, id, uid]);
}

/** Jobs `starting` depuis avant `avant` (lancement jamais confirmé) passés en `failed`. */
export async function echouerLancementsPerdus(base: Base, avant: number, maintenant: number): Promise<Job[]> {
  return base.ecriture(async (tx) => {
    const lignes = (
      await tx.all("SELECT * FROM shell_jobs WHERE state='starting' AND created_at < ?", [avant])
    ).map(jobDeLigne);
    for (const j of lignes)
      await tx.run(
        "UPDATE shell_jobs SET state='failed', ended_at=?, last_line='launch never confirmed' WHERE id=?",
        [maintenant, j.id],
      );
    return lignes;
  });
}

export interface Insertion {
  readonly job: Job;
  readonly change: boolean;
  readonly charge: ChargeEvenement;
  readonly kind: string;
  readonly livre: boolean;
}

/** Événement inséré pour un job de ce compte : `null` s'il existe déjà `(job_id, seq)` ; état du job mis à jour (terminal sans retour arrière, `starting` → `running` si l'agent le dit vivant). */
export async function insererEvenement(
  tx: Executeur,
  job: Job,
  charge: ChargeEvenement,
  kind: string,
  livreA: number | null,
  maintenant: number,
): Promise<Insertion | null> {
  const r = await tx.run(
    "INSERT INTO shell_job_events(job_id, user_id, chat_id, seq, kind, payload_json, created_at, delivered_at, delivered_in) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(job_id, seq) DO NOTHING",
    [
      job.id,
      job.userId,
      job.chatId,
      charge.seq,
      kind,
      JSON.stringify(charge),
      maintenant,
      livreA,
      livreA === null ? "" : "agent",
    ],
  );
  if (r.changes === 0) return null;
  const derniere = charge.tail.at(-1) ?? charge.line ?? null;
  const terminal = estTerminal(job.state);
  const versTerminal = !terminal && estTerminal(charge.state);
  const versRunning = job.state === "starting" && charge.state === "running";
  await tx.run(
    "UPDATE shell_jobs SET last_seq=CASE WHEN last_seq < ? THEN ? ELSE last_seq END, last_line=? " +
      (versTerminal ? ", state=?, ended_at=?, exit_code=?, exit_signal=?" : "") +
      (versRunning ? ", state='running', started_at=COALESCE(started_at, ?)" : "") +
      " WHERE id=?",
    [
      charge.seq,
      charge.seq,
      derniere ?? job.lastLine,
      ...(versTerminal ? [charge.state, maintenant, charge.exit_code, charge.signal] : []),
      ...(versRunning ? [maintenant] : []),
      job.id,
    ],
  );
  const neuf = jobDeLigne((await tx.get("SELECT * FROM shell_jobs WHERE id=?", [job.id]))!);
  return { job: neuf, change: neuf.state !== job.state, charge, kind, livre: livreA !== null };
}

export async function nombreEvenements(x: Executeur, jobId: string): Promise<number> {
  return Number(
    (await x.get("SELECT COUNT(*) AS n FROM shell_job_events WHERE job_id=?", [jobId]))?.["n"] ?? 0,
  );
}

export async function evenementExiste(x: Executeur, jobId: string, seq: number): Promise<boolean> {
  return (await x.get("SELECT 1 FROM shell_job_events WHERE job_id=? AND seq=?", [jobId, seq])) !== undefined;
}

const SELECT_ATTENTE =
  "SELECT e.id, e.job_id, e.chat_id, e.seq, e.kind, e.payload_json, e.created_at, j.label, j.resume_note, j.wake, j.depth, j.turn_json " +
  "FROM shell_job_events e JOIN shell_jobs j ON j.id = e.job_id ";

function evenementDeLigne(r: Dict): EvenementEnAttente | null {
  const charge = lireCharge(String(r["payload_json"] ?? "{}"));
  if (charge === null) return null;
  return {
    id: Number(r["id"]),
    jobId: String(r["job_id"]),
    chatId: String(r["chat_id"]),
    seq: Number(r["seq"]),
    kind: String(r["kind"]),
    charge: { ...charge, trigger: String(r["kind"]) as ChargeEvenement["trigger"] },
    label: String(r["label"] ?? ""),
    resumeNote: String(r["resume_note"] ?? ""),
    wake: Number(r["wake"]) !== 0,
    depth: Number(r["depth"] ?? 0),
    turn: dictJson(r["turn_json"]),
    createdAt: Number(r["created_at"]),
  };
}

/** Événements non livrés d'une conversation, dans l'ordre d'arrivée (lecture seule). */
export async function enAttente(x: Executeur, uid: number, chatId: string): Promise<EvenementEnAttente[]> {
  const lignes = await x.all(
    SELECT_ATTENTE + "WHERE e.user_id=? AND e.chat_id=? AND e.delivered_at IS NULL ORDER BY e.id",
    [uid, chatId],
  );
  return lignes.map(evenementDeLigne).filter((e): e is EvenementEnAttente => e !== null);
}

/** Prise atomique des non livrés d'une conversation (`UPDATE … WHERE delivered_at IS NULL`, marque unique) : ni perte ni doublon (JB-08). */
export async function prendre(
  base: Base,
  uid: number,
  chatId: string,
  marque: string,
  maintenant: number,
): Promise<EvenementEnAttente[]> {
  return base.ecriture(async (tx) => {
    const r = await tx.run(
      "UPDATE shell_job_events SET delivered_at=?, delivered_in=? WHERE user_id=? AND chat_id=? AND delivered_at IS NULL",
      [maintenant, marque, uid, chatId],
    );
    if (r.changes === 0) return [];
    const lignes = await tx.all(
      SELECT_ATTENTE + "WHERE e.user_id=? AND e.chat_id=? AND e.delivered_in=? ORDER BY e.id",
      [uid, chatId, marque],
    );
    return lignes.map(evenementDeLigne).filter((e): e is EvenementEnAttente => e !== null);
  });
}

/** Résultat rendu par `execute_shell` : job marqué (ses événements à venir naîtront livrés) et événements en attente livrés ; nombre marqué. */
export async function livrerDuJob(
  base: Base,
  uid: number,
  jobId: string,
  maintenant: number,
): Promise<number> {
  return base.ecriture(async (tx) => {
    await tx.run("UPDATE shell_jobs SET inline_result=1 WHERE id=? AND user_id=?", [jobId, uid]);
    const r = await tx.run(
      "UPDATE shell_job_events SET delivered_at=?, delivered_in='shell' WHERE user_id=? AND job_id=? AND delivered_at IS NULL",
      [maintenant, uid, jobId],
    );
    return r.changes;
  });
}

/** Préfixe des marques de livraison pas encore confirmées (le run qui les porte n'a rien enregistré). */
export const EN_VOL = "taken:";

/** Livraisons enregistrées par leur run : la marque perd son préfixe `EN_VOL`. */
export async function confirmer(base: Base, ids: readonly number[]): Promise<void> {
  for (let i = 0; i < ids.length; i += 500) {
    const tranche = ids.slice(i, i + 500);
    await base.run(
      `UPDATE shell_job_events SET delivered_in=SUBSTR(delivered_in, ${EN_VOL.length + 1}) ` +
        `WHERE delivered_in LIKE '${EN_VOL}%' AND id IN (${tranche.map(() => "?").join(",")})`,
      [...tranche],
    );
  }
}

/** Démarrage : les livraisons jamais confirmées (runs coupés par l'arrêt du process) redeviennent non livrées ; rend leur nombre. */
export async function relacherEnVol(base: Base): Promise<number> {
  return (
    await base.run(
      `UPDATE shell_job_events SET delivered_at=NULL, delivered_in='' WHERE delivered_in LIKE '${EN_VOL}%'`,
    )
  ).changes;
}

/** Rend non livrés des événements pris pour une livraison qui n'a pas été persistée. */
export async function liberer(base: Base, ids: readonly number[]): Promise<number> {
  if (!ids.length) return 0;
  let n = 0;
  for (let i = 0; i < ids.length; i += 500) {
    const tranche = ids.slice(i, i + 500);
    n += (
      await base.run(
        `UPDATE shell_job_events SET delivered_at=NULL, delivered_in='' WHERE id IN (${tranche.map(() => "?").join(",")})`,
        [...tranche],
      )
    ).changes;
  }
  return n;
}

export async function compterEnAttente(x: Executeur, uid: number, jobId: string): Promise<number> {
  return Number(
    (
      await x.get(
        "SELECT COUNT(*) AS n FROM shell_job_events WHERE user_id=? AND job_id=? AND delivered_at IS NULL",
        [uid, jobId],
      )
    )?.["n"] ?? 0,
  );
}

/** Conversations qui ont des événements non livrés (réarmement au démarrage). */
export async function conversationsEnAttente(x: Executeur): Promise<{ uid: number; chatId: string }[]> {
  const lignes = await x.all(
    "SELECT DISTINCT user_id, chat_id FROM shell_job_events WHERE delivered_at IS NULL ORDER BY user_id, chat_id",
  );
  return lignes.map((r) => ({ uid: Number(r["user_id"]), chatId: String(r["chat_id"]) }));
}

/** Jobs d'une conversation supprimée : hors de toute liste, gardés jusqu'à leur purge sur l'hôte (réessayée par le balayage). */
export const DETACHE = "chat_deleted";

/** Détache les jobs de conversations supprimées (événements effacés, état terminal, purge due) ; rend leurs ids. */
export async function detacherJobsDesChats(
  base: Base,
  uid: number,
  chatIds: readonly string[],
): Promise<string[]> {
  if (!chatIds.length) return [];
  return base.ecriture(async (tx) => {
    const ids: string[] = [];
    for (let i = 0; i < chatIds.length; i += 500) {
      const tranche = chatIds.slice(i, i + 500);
      const marques = tranche.map(() => "?").join(",");
      const lignes = await tx.all(`SELECT id FROM shell_jobs WHERE user_id=? AND chat_id IN (${marques})`, [
        uid,
        ...tranche,
      ]);
      ids.push(...lignes.map((l) => String(l["id"])));
      await tx.run(`DELETE FROM shell_job_events WHERE user_id=? AND chat_id IN (${marques})`, [
        uid,
        ...tranche,
      ]);
      await tx.run(
        `UPDATE shell_jobs SET state=CASE WHEN state IN ${ACTIFS_SQL} THEN 'killed' ELSE state END, ` +
          `kill_by='${DETACHE}', ended_at=0 WHERE user_id=? AND chat_id IN (${marques})`,
        [uid, ...tranche],
      );
    }
    return ids;
  });
}

/** Conversations du compte qui ont un job actif (épargnées par le plafond des conversations récentes). */
export async function chatsAvecJobActif(x: Executeur, uid: number): Promise<Set<string>> {
  const lignes = await x.all(
    `SELECT DISTINCT chat_id FROM shell_jobs WHERE user_id=? AND state IN ${ACTIFS_SQL}`,
    [uid],
  );
  return new Set(lignes.map((l) => String(l["chat_id"])));
}

/** Jobs actifs lancés avant `avant` et pas encore arrêtés par le core (plafond de durée). */
export async function auDelaDuPlafond(x: Executeur, avant: number): Promise<Job[]> {
  return (
    await x.all(
      `SELECT * FROM shell_jobs WHERE state IN ${ACTIFS_SQL} AND COALESCE(started_at, created_at) < ? AND kill_by <> 'max_runtime'`,
      [avant],
    )
  ).map(jobDeLigne);
}

/** Jobs terminés avant `avant` (rétention). */
export async function terminesAvant(x: Executeur, avant: number): Promise<Job[]> {
  return (
    await x.all(`SELECT * FROM shell_jobs WHERE state IN ${TERMINAUX_SQL} AND ended_at < ?`, [avant])
  ).map(jobDeLigne);
}

export async function supprimerJobs(base: Base, ids: readonly string[]): Promise<void> {
  for (const id of ids) {
    await base.run("DELETE FROM shell_job_events WHERE job_id=?", [id]);
    await base.run("DELETE FROM shell_jobs WHERE id=?", [id]);
  }
}

/** Titre et meta d'une conversation du compte, `null` si elle n'existe pas. */
export async function lireConversation(
  x: Executeur,
  uid: number,
  chatId: string,
): Promise<{ title: string; meta: Dict } | null> {
  const r = await x.get("SELECT title, meta_json FROM chats WHERE id=? AND user_id=?", [chatId, uid]);
  if (!r) return null;
  let meta: Dict;
  try {
    const m = typeof r["meta_json"] === "string" && r["meta_json"] ? pyJsonLoads(r["meta_json"]) : {};
    meta = estDict(m) ? m : {};
  } catch {
    meta = {};
  }
  return { title: String(r["title"] ?? ""), meta };
}

/** Titres des conversations du compte (listes `/jobs all`). */
export async function titres(
  x: Executeur,
  uid: number,
  chatIds: readonly string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const uniques = [...new Set(chatIds)];
  for (let i = 0; i < uniques.length; i += 500) {
    const tranche = uniques.slice(i, i + 500);
    const lignes = await x.all(
      `SELECT id, title FROM chats WHERE user_id=? AND id IN (${tranche.map(() => "?").join(",")})`,
      [uid, ...tranche],
    );
    for (const l of lignes) out.set(String(l["id"]), String(l["title"] ?? ""));
  }
  return out;
}
