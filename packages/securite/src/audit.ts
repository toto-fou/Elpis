// SPDX-License-Identifier: MIT
/** packages/securite/src/audit.ts — journal d'audit JSONL quotidien (security/audit.py) : ligne triée, HMAC facultatif, écriture O_APPEND atomique. */
import { createHash, createHmac } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { join, resolve } from "node:path";

import { arrondiEntierPy, floatPy, pyJsonDumps, reprFlottant, strPy, veritePy } from "@elpis/commun";

import { journalDe } from "./ports";

const PIPE_BUF = 4096;
const DOSSIER_PROD = "/var/lib/elpis/audit";
const BLANCS_ASCII = new Set([0x20, 0x09, 0x0a, 0x0d, 0x0b, 0x0c]);

export interface ReglagesAudit {
  service?: string;
  auditDir: string;
  hmacKeyPath: string;
  maintenant?: () => number;
}

export interface EvenementAudit {
  userId: number | null;
  username: string | null;
  action: string;
  details?: unknown;
}

export interface FiltresAudit {
  limit?: number;
  sinceTs?: number | null;
  actionPrefix?: string | null;
  userId?: number | null;
}

interface Etat {
  service: string;
  dossier: string;
  cle: Buffer | null;
  maintenant: () => number;
}

let etat: Etat | null = null;

function erreurDeDroits(e: unknown): boolean {
  const code = (e as { code?: unknown }).code;
  return code === "EACCES" || code === "EPERM";
}

function inscriptible(dossier: string): boolean {
  try {
    mkdirSync(dossier, { recursive: true });
    const test = join(dossier, ".write_test");
    closeSync(openSync(test, "a"));
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
  mkdirSync(repli, { recursive: true });
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

/** `configure` : service, dossier (créé, 0750 si possible) et clé HMAC (≥ 32 octets après retrait des blancs ASCII ; illisible = sans HMAC). */
export function configureAudit(r: ReglagesAudit): void {
  mkdirSync(r.auditDir, { recursive: true });
  try {
    chmodSync(r.auditDir, 0o750);
  } catch (e) {
    if (!erreurDeDroits(e)) throw e;
  }
  let cle: Buffer | null = null;
  try {
    if (existsSync(r.hmacKeyPath)) {
      const brute = stripAscii(readFileSync(r.hmacKeyPath));
      if (brute.length >= 32) cle = brute;
      else
        journalDe("audit").warn(
          `clé HMAC de ${r.hmacKeyPath} trop courte (${brute.length} octet(s) < 32) : audit sans HMAC`,
        );
    }
  } catch (e) {
    if (!erreurDeDroits(e)) throw e;
  }
  etat = {
    service: r.service || "main",
    dossier: r.auditDir,
    cle,
    maintenant: r.maintenant ?? (() => Date.now() / 1000),
  };
}

/** Oublie la configuration (tests) : le prochain événement se reconfigure depuis l'environnement. */
export function oublierConfigurationAudit(): void {
  etat = null;
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
      etat = { service, dossier: auditDir, cle: null, maintenant: () => Date.now() / 1000 };
    }
  }
  return etat as Etat;
}

/** Jour UTC et `isoformat()` de `datetime.fromtimestamp(t, utc)` (microsecondes arrondies au pair, omises si nulles). */
function horodatage(t: number): { jour: string; iso: string } {
  let s = Math.floor(t);
  let us = arrondiEntierPy((t - s) * 1e6);
  if (us >= 1_000_000) {
    s += 1;
    us -= 1_000_000;
  }
  const d = new Date(s * 1000);
  const p = (n: number, l = 2): string => String(n).padStart(l, "0");
  const jour = `${p(d.getUTCFullYear(), 4)}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
  const heure = `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
  return { jour, iso: `${jour}T${heure}${us ? `.${p(us, 6)}` : ""}+00:00` };
}

interface Enregistrement {
  action: string;
  details: unknown;
  iso: string;
  service: string;
  ts: number;
  userId: number | null;
  username: string | null;
}

function texte(v: unknown): string {
  return pyJsonDumps(v, { ensureAscii: false, sortKeys: true });
}

/** `json.dumps(record, sort_keys=True, ensure_ascii=False)` à partir de `details` déjà sérialisé ; `ts` reste un flottant Python. */
function serialiser(r: Enregistrement, details: string, hmac?: string): string {
  const champs: [string, string][] = [
    ["action", texte(r.action)],
    ["details", details],
    ...(hmac === undefined ? [] : ([["hmac", texte(hmac)]] as [string, string][])),
    ["iso", texte(r.iso)],
    ["service", texte(r.service)],
    ["ts", reprFlottant(r.ts)],
    ["user_id", texte(r.userId)],
    ["username", texte(r.username)],
  ];
  return `{${champs.map(([k, v]) => `"${k}": ${v}`).join(", ")}}`;
}

function ligne(r: Enregistrement, cle: Buffer | null): Buffer {
  const details = texte(r.details);
  const sansHmac = serialiser(r, details);
  if (!sansHmac.isWellFormed()) throw new Error("demi-paire UTF-16 : ligne non encodable en UTF-8");
  if (!cle) return Buffer.from(`${sansHmac}\n`, "utf8");
  const hmac = createHmac("sha256", cle).update(sansHmac, "utf8").digest("hex");
  return Buffer.from(`${serialiser(r, details, hmac)}\n`, "utf8");
}

/** `str(details)[:500]` : 500 points de code au plus, sans parcourir un texte plus long. */
function resume(details: unknown): string {
  const s = strPy(details);
  let fin = 0;
  for (let n = 0; n < 500 && fin < s.length; n++) fin += (s.codePointAt(fin) ?? 0) > 0xffff ? 2 : 1;
  return s.slice(0, fin);
}

/** `audit_event` : une ligne dans audit-AAAA-MM-JJ.jsonl, en un seul write O_APPEND ; ne lève jamais. */
export function auditEvent(e: EvenementAudit): void {
  try {
    const s = etatCourant();
    const t = s.maintenant();
    const { jour, iso } = horodatage(t);
    const r: Enregistrement = {
      action: e.action,
      details: veritePy(e.details) ? e.details : {},
      iso,
      service: s.service,
      ts: t,
      userId: e.userId,
      username: e.username,
    };
    let octets = ligne(r, s.cle);
    if (octets.length > PIPE_BUF) {
      r.details = { _truncated: true, _orig_len: octets.length, summary: resume(r.details) };
      octets = ligne(r, s.cle);
    }
    mkdirSync(s.dossier, { recursive: true });
    const fd = openSync(`${s.dossier}/audit-${jour}.jsonl`, "a", 0o640);
    try {
      writeSync(fd, octets);
    } finally {
      closeSync(fd);
    }
  } catch (erreur) {
    try {
      journalDe("audit").error("audit_event a échoué (non-bloquant)", erreur);
    } catch {
      /* comme Python : même le journal ne doit pas faire lever l'audit */
    }
  }
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
}): void {
  auditEvent({
    userId: e.userId,
    username: e.username,
    action: (e.success ?? true) ? "auth.login" : "auth.login.denied",
    details: {
      ip: e.ip ?? null,
      user_agent: Array.from(e.userAgent || "")
        .slice(0, 200)
        .join(""),
      reason: e.reason ?? null,
    },
  });
}

/** `rec.get(cle, defaut)` : lève comme Python si la ligne n'est pas un objet (la lecture s'arrête alors). */
function getPy(rec: unknown, cle: string, defaut: unknown): unknown {
  if (rec === null || typeof rec !== "object" || Array.isArray(rec))
    throw new TypeError("ligne d'audit sans .get");
  return Object.hasOwn(rec, cle) ? (rec as Record<string, unknown>)[cle] : defaut;
}

function egalEntier(v: unknown, n: number): boolean {
  return (typeof v === "number" || typeof v === "boolean") && Number(v) === n;
}

/** `read_recent_audit_lines` : fichiers du jour puis de la veille, plus récentes d'abord ; ne lève jamais. */
export function readRecentAuditLines(f: FiltresAudit = {}): unknown[] {
  const out: unknown[] = [];
  const limite = f.limit ?? 100;
  try {
    const s = etatCourant();
    if (!existsSync(s.dossier)) return out;
    const t = s.maintenant();
    for (const jour of [horodatage(t).jour, horodatage(t - 86_400).jour]) {
      let data: string;
      try {
        data = readFileSync(`${s.dossier}/audit-${jour}.jsonl`).toString("utf8");
      } catch {
        continue;
      }
      for (const texte of data.split(/\r\n|\r|\n/u).reverse()) {
        if (!texte) continue;
        let rec: unknown;
        try {
          rec = JSON.parse(texte);
        } catch {
          continue;
        }
        if (f.sinceTs !== null && f.sinceTs !== undefined && floatPy(getPy(rec, "ts", 0)) < f.sinceTs)
          continue;
        if (f.actionPrefix && !strPy(getPy(rec, "action", "")).startsWith(f.actionPrefix)) continue;
        if (f.userId !== null && f.userId !== undefined && !egalEntier(getPy(rec, "user_id", null), f.userId))
          continue;
        out.push(rec);
        if (out.length >= limite) return out;
      }
    }
  } catch {
    return out;
  }
  return out;
}
