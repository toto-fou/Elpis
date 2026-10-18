// SPDX-License-Identifier: MIT
/** apps/core/src/routines/magasin.ts — routines planifiées et journal de leurs exécutions (scheduling/routines_store.py) : CRUD cloisonné par propriétaire, admission atomique, transitions terminales, rétention, dédup des webhooks. */
import {
  entierOuNulPy,
  ErreurJsonPy,
  ErreurLecturePy,
  estDict,
  intPy,
  lowerPy,
  prefixePy,
  pyJsonDumps,
  pyJsonLoads,
  reprPy,
  stripPy,
  strPy,
  veritePy,
  versFlottantPy,
} from "@elpis/commun";
import type { Dict } from "@elpis/commun";
import { castInt, hasTable } from "@elpis/db";
import type { Base, Executeur, Ligne, Valeur } from "@elpis/db";

import { journal } from "../journal";

const log = journal("routines");

/** Champs secrets jamais persistés dans le snapshot MCP d'une routine : re-résolus à l'exécution. */
export const MCP_SECRET_KEYS: readonly string[] = [
  "auth",
  "authorization",
  "headers",
  "token",
  "api_key",
  "apikey",
  "password",
  "secret",
  "basic_auth",
  "bearer",
  "auth_secret",
  "auth_enc",
  "key_scheme",
  "headers_enc",
  "env",
  "env_enc",
  "extra_scheme",
];
const SECRETS = new Set(MCP_SECRET_KEYS);

export const NOTIFY_ON_VALUES: readonly string[] = ["all", "error", "none"];
export const KEEP_MAX = 500;
export const RUN_FILES_MAX = 40;
export const RUN_FILE_PATH_MAX = 400;

/** `time.time()`. */
function maintenant(): number {
  return Date.now() / 1000;
}

const dumps = (v: unknown): string => pyJsonDumps(v, { ensureAscii: false });

/** `json.loads(x or défaut)` sous `except Exception` : vide ou illisible rend `defaut`. */
function chargerOu(texte: unknown, defaut: () => unknown): unknown {
  if (typeof texte !== "string" || !texte) return defaut();
  try {
    return pyJsonLoads(texte);
  } catch {
    return defaut();
  }
}

/** Ids de skills : textes non vides, rognés, dédupliqués dans l'ordre. */
export function sanitizeSkills(value: unknown): string[] {
  const out: string[] = [];
  if (!Array.isArray(value)) return out;
  for (const brut of value) {
    if (typeof brut !== "string") continue;
    const s = stripPy(brut);
    if (s && !out.includes(s)) out.push(s);
  }
  return out;
}

export function normNotifyOn(value: unknown): string {
  const v = lowerPy(stripPy(strPy(veritePy(value) ? value : "all")));
  return NOTIFY_ON_VALUES.includes(v) ? v : "all";
}

/** Compteur « conservés » borné [0, KEEP_MAX] ; tout ce qui n'est pas un entier (booléen compris) vaut 0. */
export function normKeep(value: unknown): number {
  if (typeof value === "boolean") return 0;
  const n = entierOuNulPy(value);
  return n === null ? 0 : Math.max(0, Math.min(KEEP_MAX, n));
}

/** Titre d'une notification de fin de run : source unique de l'émetteur et du renommage. */
export function routineNotificationTitle(
  name: string | null | undefined,
  routineId: number,
  ok: boolean,
): string {
  const label = stripPy(name || "") || `Routine #${intPy(routineId)}`;
  return ok ? `Routine « ${label} » terminée` : `Routine « ${label} » en échec`;
}

/** Chemins produits par un run : textes non vides, rognés, tronqués, dédupliqués, bornés, dans l'ordre d'écriture. */
export function sanitizeRunFiles(value: unknown): string[] {
  const out: string[] = [];
  if (!Array.isArray(value)) return out;
  for (const brut of value) {
    if (typeof brut !== "string") continue;
    const p = prefixePy(stripPy(brut), RUN_FILE_PATH_MAX);
    if (p && !out.includes(p)) out.push(p);
    if (out.length >= RUN_FILES_MAX) break;
  }
  return out;
}

/** Forme des serveurs MCP gardée (type, url, catégories…), secrets retirés. */
export function stripMcpSecrets(servers: unknown): Dict[] {
  const out: Dict[] = [];
  if (!Array.isArray(servers)) return out;
  for (const s of servers) {
    if (!estDict(s)) continue;
    out.push(Object.fromEntries(Object.entries(s).filter(([k]) => !SECRETS.has(k))));
  }
  return out;
}

/** `float` des colonnes REAL : `1.0` reste `1.0` dans les réponses. */
function flottant(v: unknown): unknown {
  return typeof v === "number" ? versFlottantPy(v) : v;
}

/** `_row_to_routine` : JSON décodés, booléens et compteurs normalisés ; le secret du webhook ne sort jamais (seulement `webhook_has_secret`). */
export function rowToRoutine(row: Ligne): Dict {
  const d: Dict = { ...row };
  for (const c of ["created_at", "updated_at"]) if (Object.hasOwn(d, c)) d[c] = flottant(d[c]);
  d["mcp_snapshot"] = chargerOu(d["mcp_snapshot"], () => []);
  d["skills"] = sanitizeSkills(chargerOu(d["skills"], () => []));
  d["thinking_mode"] = veritePy(d["thinking_mode"]);
  d["enabled"] = veritePy(d["enabled"]);
  d["connector_id"] = veritePy(d["connector_id"]) ? intPy(d["connector_id"]) : null;
  d["agents_enabled"] = veritePy(d["agents_enabled"]);
  const secret = d["webhook_secret"];
  delete d["webhook_secret"];
  d["webhook_has_secret"] = veritePy(secret);
  d["webhook_enabled"] = veritePy(d["webhook_enabled"]);
  delete d["webhook_mode"];
  delete d["webhook_url"];
  const filtre = chargerOu(d["webhook_filter"], () => ({}));
  d["webhook_filter"] = estDict(filtre) ? filtre : {};
  d["trigger_after_id"] = veritePy(d["trigger_after_id"]) ? entierOuNulPy(d["trigger_after_id"]) : null;
  d["trigger_after_on"] = veritePy(d["trigger_after_on"]) ? d["trigger_after_on"] : "ok";
  d["runs_keep"] = normKeep(d["runs_keep"]);
  d["notify_on"] = normNotifyOn(d["notify_on"]);
  d["notify_keep"] = normKeep(d["notify_keep"]);
  return d;
}

/** Ligne d'un run telle que `dict(row)` : instants en flottants. */
function ligneRun(row: Ligne): Dict {
  const d: Dict = { ...row };
  for (const c of ["started_at", "ended_at", "heartbeat_at"]) if (Object.hasOwn(d, c)) d[c] = flottant(d[c]);
  return d;
}

/** Erreur de `json.loads` de la famille ValueError ; `RecursionError` remonte comme en Python. */
function estValueError(e: unknown): boolean {
  return e instanceof ErreurJsonPy || (e instanceof ErreurLecturePy && e.nature !== "RecursionError");
}

export async function purgeWebhookDeliveries(base: Base, ttlS = 86400.0): Promise<number> {
  try {
    const n = (
      await base.run("DELETE FROM editor_webhook_deliveries WHERE received_at < ?", [maintenant() - ttlS])
    ).changes;
    if (n) log.info(`[maintenance] ${n} livraison(s) webhook purgée(s).`);
    return n;
  } catch (e) {
    log.debug({ err: e }, "[maintenance] purge_webhook_deliveries failed (non-fatal)");
    return 0;
  }
}

/** Runs terminés de plus de `retentionDays` jours ; un run `running` n'est jamais touché ; `<= 0` : rien. */
export async function purgeRoutineRuns(base: Base, retentionDays = 180): Promise<number> {
  if (retentionDays <= 0) return 0;
  try {
    const n = (
      await base.run("DELETE FROM editor_routine_runs WHERE started_at < ? AND status != 'running'", [
        maintenant() - retentionDays * 86400,
      ])
    ).changes;
    if (n) log.info(`[maintenance] ${n} editor_routine_runs purgé(s) (>${retentionDays}j).`);
    return n;
  } catch (e) {
    log.debug({ err: e }, "[maintenance] purge_routine_runs failed (non-fatal)");
    return 0;
  }
}

export interface ChampsRoutine {
  name: string;
  cron_expr: string;
  model: string | null;
  system_prompt: string;
  task_prompt: string;
  connector_id?: number | null;
  mcp_servers: unknown;
  skills?: unknown;
  thinking_mode?: boolean;
  enabled?: boolean;
  trigger_after_id?: number | null;
  trigger_after_on?: string;
  agents_enabled?: boolean;
  runs_keep?: unknown;
  notify_on?: unknown;
  notify_keep?: unknown;
}

export async function createRoutine(base: Base, ownerUserId: number, c: ChampsRoutine): Promise<number> {
  const t = maintenant();
  const on = c.trigger_after_on ?? "ok";
  return base.transaction((tx) =>
    tx.insertId(
      "INSERT INTO editor_routines(owner_user_id, name, cron_expr, model, " +
        "connector_id, system_prompt, task_prompt, mcp_snapshot, skills, " +
        "thinking_mode, enabled, created_at, updated_at, trigger_after_id, " +
        "trigger_after_on, agents_enabled, runs_keep, notify_on, notify_keep) " +
        "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      [
        intPy(ownerUserId),
        c.name,
        c.cron_expr,
        c.model || null,
        c.connector_id ? intPy(c.connector_id) : null,
        c.system_prompt || "",
        c.task_prompt || "",
        dumps(stripMcpSecrets(c.mcp_servers)),
        dumps(sanitizeSkills(c.skills ?? null)),
        c.thinking_mode ? 1 : 0,
        (c.enabled ?? true) ? 1 : 0,
        t,
        t,
        c.trigger_after_id ? intPy(c.trigger_after_id) : null,
        ["ok", "error", "always"].includes(on) ? on : "ok",
        c.agents_enabled ? 1 : 0,
        normKeep(c.runs_keep ?? 0),
        normNotifyOn(c.notify_on ?? "all"),
        normKeep(c.notify_keep ?? 0),
      ],
    ),
  );
}

/** Routines du compte, plus récentes d'abord, avec l'état de leur dernier run et le nombre de runs en cours (deux requêtes agrégées). */
export async function listRoutines(x: Executeur, ownerUserId: number): Promise<Dict[]> {
  const uid = intPy(ownerUserId);
  const rows = (
    await x.all("SELECT * FROM editor_routines WHERE owner_user_id=? ORDER BY created_at DESC", [uid])
  ).map(rowToRoutine);
  if (!rows.length) return rows;
  const derniers = new Map<number, Dict>();
  for (const rr of await x.all(
    "SELECT routine_id, status, started_at, ended_at, duration_ms " +
      "FROM editor_routine_runs r WHERE owner_user_id=? AND id=(" +
      "  SELECT id FROM editor_routine_runs " +
      "  WHERE routine_id=r.routine_id AND owner_user_id=r.owner_user_id " +
      "  ORDER BY started_at DESC, id DESC LIMIT 1)",
    [uid],
  )) {
    const d: Dict = { ...rr, started_at: flottant(rr["started_at"]), ended_at: flottant(rr["ended_at"]) };
    derniers.set(intPy(d["routine_id"]), d);
  }
  const enCours = new Map<number, number>();
  for (const rr of await x.all(
    "SELECT routine_id, COUNT(*) AS n FROM editor_routine_runs " +
      "WHERE owner_user_id=? AND status='running' GROUP BY routine_id",
    [uid],
  ))
    enCours.set(intPy(rr["routine_id"]), intPy(rr["n"]));
  for (const r of rows) {
    r["last_run"] = derniers.get(intPy(r["id"])) ?? null;
    r["running_count"] = enCours.get(intPy(r["id"])) ?? 0;
  }
  return rows;
}

/** Cloisonnée : la routine n'est rendue qu'à son propriétaire. */
export async function getRoutine(x: Executeur, routineId: number, ownerUserId: number): Promise<Dict | null> {
  const row = await x.get("SELECT * FROM editor_routines WHERE id=? AND owner_user_id=?", [
    intPy(routineId),
    intPy(ownerUserId),
  ]);
  return row ? rowToRoutine(row) : null;
}

/** Par id seul : réservé à l'exécuteur et à la livraison webhook, jamais à une route de compte. */
export async function getRoutineInternal(x: Executeur, routineId: number): Promise<Dict | null> {
  const row = await x.get("SELECT * FROM editor_routines WHERE id=?", [intPy(routineId)]);
  return row ? rowToRoutine(row) : null;
}

const UPDATABLE = [
  "name",
  "cron_expr",
  "model",
  "connector_id",
  "system_prompt",
  "task_prompt",
  "mcp_snapshot",
  "skills",
  "thinking_mode",
  "enabled",
  "trigger_after_id",
  "trigger_after_on",
  "agents_enabled",
  "runs_keep",
  "notify_on",
  "notify_keep",
] as const;

/** Champs où `null` est une valeur à écrire (NULL), pas « inchangé ». */
const NULLABLE = new Set(["model", "connector_id", "trigger_after_id"]);
const BOOLEENS = new Set(["thinking_mode", "enabled", "agents_enabled"]);

/** UPDATE cloisonné (clé absente = inchangée) ; un renommage réécrit les titres du récap ; vrai si la routine existe et a été touchée. */
export async function updateRoutine(
  base: Base,
  routineId: number,
  ownerUserId: number,
  champs: Readonly<Record<string, unknown>>,
): Promise<boolean> {
  const f: Record<string, unknown> = { ...champs };
  if (Object.hasOwn(f, "mcp_servers")) {
    f["mcp_snapshot"] = dumps(stripMcpSecrets(f["mcp_servers"]));
    delete f["mcp_servers"];
  }
  if (Object.hasOwn(f, "skills")) f["skills"] = dumps(sanitizeSkills(f["skills"]));
  for (const k of ["runs_keep", "notify_keep"]) if (Object.hasOwn(f, k)) f[k] = normKeep(f[k]);
  if (Object.hasOwn(f, "notify_on")) f["notify_on"] = normNotifyOn(f["notify_on"]);
  const sets: string[] = [];
  const params: Valeur[] = [];
  for (const k of UPDATABLE) {
    if (!Object.hasOwn(f, k)) continue;
    const brut = f[k];
    if ((brut === null || brut === undefined) && !NULLABLE.has(k)) continue;
    sets.push(`${k}=?`);
    params.push(BOOLEENS.has(k) ? (veritePy(brut) ? 1 : 0) : ((brut ?? null) as Valeur));
  }
  const rid = intPy(routineId);
  const uid = intPy(ownerUserId);
  if (!sets.length)
    return (
      (await base.get("SELECT 1 AS un FROM editor_routines WHERE id=? AND owner_user_id=?", [rid, uid])) !==
      undefined
    );
  sets.push("updated_at=?");
  params.push(maintenant(), rid, uid);
  return base.transaction(async (tx) => {
    const touchee =
      (await tx.run(`UPDATE editor_routines SET ${sets.join(", ")} WHERE id=? AND owner_user_id=?`, params))
        .changes > 0;
    if (touchee && Object.hasOwn(f, "name") && (await hasTable(tx, "notifications"))) {
      const nom = f["name"] as string | null;
      for (const [kind, ok] of [
        ["routine_ok", true],
        ["routine_error", false],
      ] as const)
        await tx.run(
          "UPDATE notifications SET title=? WHERE owner_user_id=? AND ref_type='routine' AND ref_id=? AND kind=?",
          [routineNotificationTitle(nom, rid, ok), uid, rid, kind],
        );
    }
    return touchee;
  });
}

/** Déclencheur webhook (cloisonné) ; un champ `undefined` reste inchangé ; faux si rien à écrire ou routine absente. */
export async function setRoutineWebhook(
  base: Base,
  routineId: number,
  ownerUserId: number,
  o: { enabled?: boolean; secret?: string; filter?: Dict },
): Promise<boolean> {
  const sets: string[] = [];
  const params: Valeur[] = [];
  if (o.enabled !== undefined) {
    sets.push("webhook_enabled=?");
    params.push(o.enabled ? 1 : 0);
  }
  if (o.secret !== undefined) {
    sets.push("webhook_secret=?");
    params.push(o.secret);
  }
  if (o.filter !== undefined) {
    sets.push("webhook_filter=?");
    params.push(dumps(o.filter));
  }
  if (!sets.length) return false;
  sets.push("updated_at=?");
  params.push(maintenant(), intPy(routineId), intPy(ownerUserId));
  const r = await base.run(
    `UPDATE editor_routines SET ${sets.join(", ")} WHERE id=? AND owner_user_id=?`,
    params,
  );
  return r.changes > 0;
}

/** Secret par id seul : réservé à la vérification de la livraison publique. */
export async function getRoutineWebhookSecret(x: Executeur, routineId: number): Promise<string | null> {
  const row = await x.get<{ webhook_secret: unknown }>(
    "SELECT webhook_secret FROM editor_routines WHERE id=?",
    [intPy(routineId)],
  );
  return row && typeof row.webhook_secret === "string" && row.webhook_secret ? row.webhook_secret : null;
}

/** Vrai à la première présentation d'une livraison (à traiter), faux si rejouée ; purge du TTL au passage. */
export async function recordWebhookDelivery(
  base: Base,
  deliveryId: string,
  routineId: number,
  ttlS = 86400.0,
): Promise<boolean> {
  const t = maintenant();
  return base.transaction(async (tx) => {
    await tx.run("DELETE FROM editor_webhook_deliveries WHERE received_at < ?", [t - ttlS]);
    const r = await tx.run(
      "INSERT INTO editor_webhook_deliveries(delivery_id, routine_id, received_at) VALUES(?,?,?) " +
        "ON CONFLICT(delivery_id, routine_id) DO NOTHING",
      [prefixePy(deliveryId, 128), intPy(routineId), t],
    );
    return r.changes > 0;
  });
}

/** Retire la marque de dédup d'une livraison dont le lancement a échoué ; ne lève jamais. */
export async function forgetWebhookDelivery(
  base: Base,
  deliveryId: string,
  routineId: number,
): Promise<boolean> {
  const id = prefixePy(deliveryId, 128);
  try {
    const r = await base.run("DELETE FROM editor_webhook_deliveries WHERE delivery_id=? AND routine_id=?", [
      id,
      intPy(routineId),
    ]);
    return r.changes > 0;
  } catch (e) {
    log.warn(
      { err: e },
      `[webhooks] dédup non retirée pour la livraison ${reprPy(id)} (routine ${routineId}) — un retry sera ignoré`,
    );
    return false;
  }
}

export async function setRoutineEnabled(
  base: Base,
  routineId: number,
  ownerUserId: number,
  enabled: boolean,
): Promise<boolean> {
  const r = await base.run(
    "UPDATE editor_routines SET enabled=?, updated_at=? WHERE id=? AND owner_user_id=?",
    [enabled ? 1 : 0, maintenant(), intPy(routineId), intPy(ownerUserId)],
  );
  return r.changes > 0;
}

/** DELETE cloisonné (runs en CASCADE) ; même transaction : pointeurs d'enchaînement des avales, dédup webhook, récap. */
export async function deleteRoutine(base: Base, routineId: number, ownerUserId: number): Promise<boolean> {
  const rid = intPy(routineId);
  const uid = intPy(ownerUserId);
  return base.transaction(async (tx) => {
    const supprimee =
      (await tx.run("DELETE FROM editor_routines WHERE id=? AND owner_user_id=?", [rid, uid])).changes > 0;
    if (supprimee) {
      await tx.run(
        "UPDATE editor_routines SET trigger_after_id=NULL, updated_at=? WHERE trigger_after_id=?",
        [maintenant(), rid],
      );
      await tx.run("DELETE FROM editor_webhook_deliveries WHERE routine_id=?", [rid]);
      if (await hasTable(tx, "notifications"))
        await tx.run("DELETE FROM notifications WHERE owner_user_id=? AND ref_type='routine' AND ref_id=?", [
          uid,
          rid,
        ]);
    }
    return supprimee;
  });
}

/** Toutes les routines actives, tous comptes (lu par le leader). */
export async function listEnabledRoutines(x: Executeur): Promise<Dict[]> {
  return (await x.all("SELECT * FROM editor_routines WHERE enabled=1")).map(rowToRoutine);
}

/** Routines avales actives pointant « après » cette routine. */
export async function listChainedRoutines(x: Executeur, afterRoutineId: number): Promise<Dict[]> {
  return (
    await x.all("SELECT * FROM editor_routines WHERE enabled=1 AND trigger_after_id=?", [
      intPy(afterRoutineId),
    ])
  ).map(rowToRoutine);
}

/** Garde anti-double déclenchement par routine et par minute, atomique entre process ; vrai si ce tick la gagne. */
export async function claimMinuteFire(base: Base, routineId: number, minuteKey: string): Promise<boolean> {
  return base.ecriture(
    async (tx) =>
      (
        await tx.run(
          "UPDATE editor_routines SET last_fire_minute=? " +
            "WHERE id=? AND (last_fire_minute IS NULL OR last_fire_minute != ?)",
          [minuteKey, intPy(routineId), minuteKey],
        )
      ).changes > 0,
  );
}

/** Runs `running` de la routine ; avec `freshAfterS`, seulement ceux au battement frais (un orphelin ne compte pas). */
export async function countRunningForRoutine(
  x: Executeur,
  routineId: number,
  freshAfterS: number | null = null,
): Promise<number> {
  const r =
    freshAfterS !== null
      ? await x.get<{ n: unknown }>(
          "SELECT COUNT(*) AS n FROM editor_routine_runs " +
            "WHERE routine_id=? AND status='running' AND heartbeat_at >= ?",
          [intPy(routineId), maintenant() - freshAfterS],
        )
      : await x.get<{ n: unknown }>(
          "SELECT COUNT(*) AS n FROM editor_routine_runs WHERE routine_id=? AND status='running'",
          [intPy(routineId)],
        );
  return intPy(r?.n ?? 0);
}

export interface Admission {
  trigger: string;
  cap: number;
  workerBootId: string;
  overlapFreshAfterS?: number | null;
}

/** Admission atomique (écriture exclusive) : plafond de runs simultanés du compte et, avec `overlapFreshAfterS`, un seul run actif par routine ; id du run créé ou `null`. */
export async function admitAndInsertRun(
  base: Base,
  routineId: number,
  ownerUserId: number,
  a: Admission,
): Promise<number | null> {
  const rid = intPy(routineId);
  const uid = intPy(ownerUserId);
  return base.ecriture(async (tx) => {
    const fraicheur = a.overlapFreshAfterS ?? null;
    if (fraicheur !== null) {
      const actifs = await tx.get<{ n: unknown }>(
        "SELECT COUNT(*) AS n FROM editor_routine_runs " +
          "WHERE routine_id=? AND status='running' AND heartbeat_at >= ?",
        [rid, maintenant() - fraicheur],
      );
      if (intPy(actifs?.n ?? 0) > 0) return null;
    }
    const enCours = await tx.get<{ n: unknown }>(
      "SELECT COUNT(*) AS n FROM editor_routine_runs WHERE owner_user_id=? AND status='running'",
      [uid],
    );
    if (intPy(enCours?.n ?? 0) >= intPy(a.cap)) return null;
    const t = maintenant();
    return tx.insertId(
      "INSERT INTO editor_routine_runs(routine_id, owner_user_id, status, " +
        '"trigger", started_at, worker_boot_id, heartbeat_at) ' +
        "VALUES(?,?,'running',?,?,?,?)",
      [rid, uid, a.trigger, t, a.workerBootId, t],
    );
  });
}

/** Run non lancé (plafond, routine désactivée…) journalisé `skipped`, terminal dès l'insertion. */
export async function insertSkippedRun(
  base: Base,
  routineId: number,
  ownerUserId: number,
  o: { trigger: string; reason: string },
): Promise<number> {
  const t = maintenant();
  return base.transaction(async (tx) => {
    const runId = await tx.insertId(
      "INSERT INTO editor_routine_runs(routine_id, owner_user_id, status, " +
        '"trigger", started_at, ended_at, duration_ms, error) ' +
        "VALUES(?,?,'skipped',?,?,?,0,?)",
      [intPy(routineId), intPy(ownerUserId), o.trigger, t, t, prefixePy(o.reason || "", 500)],
    );
    await enforceRunsKeep(tx, runId);
    return runId;
  });
}

/** `runs_keep` de la routine du run : seuls les runs terminés les plus récents restent ; un run `running` n'est ni compté ni supprimé. */
export async function enforceRunsKeep(x: Executeur, runId: number): Promise<number> {
  const row = await x.get<{ rid: unknown; keep: unknown }>(
    "SELECT r.routine_id AS rid, t.runs_keep AS keep FROM editor_routine_runs r " +
      "JOIN editor_routines t ON t.id=r.routine_id WHERE r.id=?",
    [intPy(runId)],
  );
  if (!row) return 0;
  const keep = normKeep(row.keep);
  if (keep <= 0) return 0;
  const rid = intPy(row.rid);
  const r = await x.run(
    "DELETE FROM editor_routine_runs WHERE routine_id=? AND status!='running' " +
      "AND id NOT IN (SELECT id FROM (SELECT id FROM editor_routine_runs WHERE routine_id=? " +
      "AND status!='running' ORDER BY started_at DESC, id DESC LIMIT ?) AS garde)",
    [rid, rid, keep],
  );
  return r.changes;
}

/** Transition terminale gardée `WHERE status='running'`, puis `runs_keep` dans la même transaction. */
async function terminer(base: Base, runId: number, sql: string, params: Valeur[]): Promise<boolean> {
  return base.transaction(async (tx) => {
    const fait = (await tx.run(sql, params)).changes > 0;
    if (fait) await enforceRunsKeep(tx, runId);
    return fait;
  });
}

export interface Bilan {
  inputTokens?: number;
  outputTokens?: number;
  durationMs?: number;
  summary?: string;
  files?: readonly unknown[] | null;
}

export async function markRunOk(
  base: Base,
  runId: number,
  b: Bilan & { toolLimitReached?: boolean } = {},
): Promise<boolean> {
  return terminer(
    base,
    runId,
    "UPDATE editor_routine_runs SET status='ok', ended_at=?, duration_ms=?, " +
      "input_tokens=?, output_tokens=?, summary=?, tool_limit_reached=?, files=? " +
      "WHERE id=? AND status='running'",
    [
      maintenant(),
      intPy(b.durationMs ?? 0),
      intPy(b.inputTokens ?? 0),
      intPy(b.outputTokens ?? 0),
      prefixePy(b.summary || "", 4000),
      b.toolLimitReached ? 1 : 0,
      dumps(sanitizeRunFiles(b.files ?? null)),
      intPy(runId),
    ],
  );
}

/** Échec avec son bilan (réponse partielle, jetons, fichiers) : une génération interrompue garde ce qu'elle a fait. */
export async function markRunError(
  base: Base,
  runId: number,
  b: Bilan & { error: string },
): Promise<boolean> {
  return terminer(
    base,
    runId,
    "UPDATE editor_routine_runs SET status='error', ended_at=?, " +
      "duration_ms=?, error=?, summary=?, input_tokens=?, output_tokens=?, " +
      "files=? WHERE id=? AND status='running'",
    [
      maintenant(),
      intPy(b.durationMs ?? 0),
      prefixePy(b.error || "", 1000),
      prefixePy(b.summary || "", 4000),
      intPy(b.inputTokens ?? 0),
      intPy(b.outputTokens ?? 0),
      dumps(sanitizeRunFiles(b.files ?? null)),
      intPy(runId),
    ],
  );
}

/** Run admis requalifié `skipped` (routine supprimée ou désactivée avant son démarrage). */
export async function markRunSkipped(
  base: Base,
  runId: number,
  o: { reason: string; durationMs?: number },
): Promise<boolean> {
  return terminer(
    base,
    runId,
    "UPDATE editor_routine_runs SET status='skipped', ended_at=?, duration_ms=?, error=? WHERE id=? AND status='running'",
    [maintenant(), intPy(o.durationMs ?? 0), prefixePy(o.reason || "", 500), intPy(runId)],
  );
}

/** Arrêt volontaire (bouton « Arrêter ») : statut terminal dédié, sans résumé ni fichiers. */
export async function markRunCancelled(base: Base, runId: number, durationMs = 0): Promise<boolean> {
  return terminer(
    base,
    runId,
    "UPDATE editor_routine_runs SET status='cancelled', ended_at=?, duration_ms=? WHERE id=? AND status='running'",
    [maintenant(), intPy(durationMs), intPy(runId)],
  );
}

/** Un run précis, cloisonné par propriétaire. */
export async function getRun(x: Executeur, runId: number, ownerUserId: number): Promise<Dict | null> {
  const r = await x.get("SELECT * FROM editor_routine_runs WHERE id=? AND owner_user_id=?", [
    intPy(runId),
    intPy(ownerUserId),
  ]);
  return r ? ligneRun(r) : null;
}

export async function heartbeatRun(base: Base, runId: number): Promise<boolean> {
  const r = await base.run("UPDATE editor_routine_runs SET heartbeat_at=? WHERE id=? AND status='running'", [
    maintenant(),
    intPy(runId),
  ]);
  return r.changes > 0;
}

/** Runs `running` au battement périmé passés `orphaned` (durée = dernier signe de vie − départ) ; nombre réconcilié. */
export async function reconcileOrphans(base: Base, staleAfterS = 300.0): Promise<number> {
  const t = maintenant();
  const duree = castInt("ROUND((COALESCE(heartbeat_at, started_at) - started_at) * 1000)", base.dialecte);
  const r = await base.run(
    `UPDATE editor_routine_runs SET status='orphaned', ended_at=?, duration_ms=${duree}, ` +
      "error='reconciled: heartbeat périmé (processus arrêté ?)' " +
      "WHERE status='running' AND (heartbeat_at IS NULL OR heartbeat_at < ?)",
    [t, t - staleAfterS],
  );
  return r.changes;
}

/** Journal des runs d'une routine (cloisonné), plus récents d'abord ; `files` décodé. */
export async function listRuns(
  x: Executeur,
  routineId: number,
  ownerUserId: number,
  o: { limit?: number; offset?: number } = {},
): Promise<Dict[]> {
  const limite = Math.max(1, Math.min(intPy(o.limit || 50), 500));
  const decalage = Math.max(0, intPy(o.offset || 0));
  const lignes = await x.all(
    "SELECT * FROM editor_routine_runs WHERE routine_id=? AND owner_user_id=? " +
      "ORDER BY started_at DESC, id DESC LIMIT ? OFFSET ?",
    [intPy(routineId), intPy(ownerUserId), limite, decalage],
  );
  return lignes.map((r) => {
    const d = ligneRun(r);
    try {
      d["files"] = sanitizeRunFiles(
        pyJsonLoads(typeof d["files"] === "string" && d["files"] ? d["files"] : "[]"),
      );
    } catch (e) {
      if (!estValueError(e)) throw e;
      d["files"] = [];
    }
    return d;
  });
}
