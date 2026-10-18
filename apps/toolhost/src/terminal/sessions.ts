// SPDX-License-Identifier: MIT
/** apps/toolhost/src/terminal/sessions.ts — sessions nommées du terminal (table `terminal_sessions` de la base de l'hôte) : création plafonnée, liste, renommage, suppression, purge. */
import { randomBytes } from "node:crypto";

import { HttpError, intPy, stripPy, texteOu } from "@elpis/commun";
import { ensureTables } from "@elpis/db";
import type { Base, Executeur } from "@elpis/db";

import { MAX_SESSIONS_PER_USER } from "./pty";

export const SESSION_DB_RETENTION_S = 7 * 24 * 3600;
const SID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const NOM_PAR_DEFAUT_RE = /^Terminal (\p{Nd}+)\n?$/u;
const COLONNES = "id, uid, tid, name, created_at, last_connected_at";

export interface LigneSession {
  id: string;
  uid: number;
  tid: number | null;
  name: string;
  created_at: number;
  last_connected_at: number;
}

/** `_valid_sid` : 1 à 64 caractères `[A-Za-z0-9_-]`, rien d'autre (pas même un saut de ligne final). */
export function sidValide(sid: string): boolean {
  return Boolean(sid) && SID_RE.test(sid);
}

/** `_new_sid` : `t_` + 9 octets aléatoires en base64 URL (~72 bits). */
export function nouveauSid(): string {
  return "t_" + randomBytes(9).toString("base64url");
}

/** `str.strip()[:64]` en points de code. */
export function nomBorne(nom: string): string {
  return Array.from(stripPy(nom)).slice(0, 64).join("");
}

/** `_next_default_session_name` : plus petit « Terminal N » libre parmi les noms par défaut (noms personnalisés ignorés). */
export function nomParDefaut(noms: readonly unknown[]): string {
  const pris = new Set<number>();
  for (const n of noms) {
    const m = NOM_PAR_DEFAUT_RE.exec(stripPy(texteOu(n, "")));
    if (m) pris.add(intPy(m[1]));
  }
  let n = 1;
  while (pris.has(n)) n += 1;
  return `Terminal ${n}`;
}

function maintenant(): number {
  return Math.floor(Date.now() / 1000);
}

function filtreTid(tid: number | null): [string, number[]] {
  return tid === null ? ["tid IS NULL", []] : ["tid = ?", [tid]];
}

function ligne(r: Record<string, unknown>): LigneSession {
  return {
    id: String(r["id"]),
    uid: Number(r["uid"]),
    tid: r["tid"] === null || r["tid"] === undefined ? null : Number(r["tid"]),
    name: String(r["name"]),
    created_at: Number(r["created_at"]),
    last_connected_at: Number(r["last_connected_at"]),
  };
}

/** Registre des sessions sur la base de l'hôte, ouverte à la demande ; la table est assurée une fois par base. */
export class SessionsTerminal {
  private readonly base: () => Promise<Base>;
  private readonly pretes = new WeakMap<Base, Promise<void>>();

  constructor(base: () => Promise<Base>) {
    this.base = base;
  }

  /** `_init_terminal_sessions_table` : une seule création à la fois par base (CREATE concurrents refusés par PostgreSQL). */
  private async prete(): Promise<Base> {
    const b = await this.base();
    let prete = this.pretes.get(b);
    if (prete === undefined) {
      prete = ensureTables(b, ["terminal_sessions"]).then(
        () => undefined,
        (e: unknown) => {
          this.pretes.delete(b);
          throw e;
        },
      );
      this.pretes.set(b, prete);
    }
    await prete;
    return b;
  }

  /** `_insert_session_row` : compte et insertion sous verrou d'écriture ; 429 `limit_reached` au plafond. */
  async inserer(uid: number, tid: number | null, nom: string): Promise<LigneSession> {
    const b = await this.prete();
    const sid = nouveauSid();
    const t = maintenant();
    const [filtre, args] = filtreTid(tid);
    await b.ecriture(async (x: Executeur) => {
      const lignes = await x.valeurs<[unknown]>(
        `SELECT COUNT(*) FROM terminal_sessions WHERE uid = ? AND ${filtre}`,
        [uid, ...args],
      );
      const compte = Number(lignes[0]?.[0] ?? 0);
      if (compte >= MAX_SESSIONS_PER_USER)
        throw new HttpError(429, { error: "limit_reached", max: MAX_SESSIONS_PER_USER, current: compte });
      await x.run(
        "INSERT INTO terminal_sessions (id, uid, tid, name, created_at, last_connected_at) VALUES (?, ?, ?, ?, ?, ?)",
        [sid, uid, tid, nom, t, t],
      );
    });
    return { id: sid, uid, tid, name: nom, created_at: t, last_connected_at: t };
  }

  async lister(uid: number, tid: number | null = null): Promise<LigneSession[]> {
    const b = await this.prete();
    const [filtre, args] = filtreTid(tid);
    const lignes = await b.all(
      `SELECT ${COLONNES} FROM terminal_sessions WHERE uid = ? AND ${filtre} ORDER BY created_at ASC`,
      [uid, ...args],
    );
    return lignes.map(ligne);
  }

  /** `_get_session_row` : la ligne si elle existe et appartient au compte. */
  async obtenir(sid: string, uid: number, tid: number | null = null): Promise<LigneSession | null> {
    const b = await this.prete();
    if (!sidValide(sid)) return null;
    const [filtre, args] = filtreTid(tid);
    const r = await b.get(
      `SELECT ${COLONNES} FROM terminal_sessions WHERE id = ? AND uid = ? AND ${filtre}`,
      [sid, uid, ...args],
    );
    return r ? ligne(r) : null;
  }

  /** `_touch_session_row` : sans erreur propagée. */
  async toucher(sid: string): Promise<void> {
    try {
      const b = await this.prete();
      await b.run("UPDATE terminal_sessions SET last_connected_at = ? WHERE id = ?", [maintenant(), sid]);
    } catch {
      return;
    }
  }

  async renommer(sid: string, uid: number, nom: string, tid: number | null = null): Promise<boolean> {
    const b = await this.prete();
    if (!sidValide(sid)) return false;
    const net = nomBorne(nom);
    if (!net) return false;
    const [filtre, args] = filtreTid(tid);
    const r = await b.run(`UPDATE terminal_sessions SET name = ? WHERE id = ? AND uid = ? AND ${filtre}`, [
      net,
      sid,
      uid,
      ...args,
    ]);
    return r.changes > 0;
  }

  async supprimer(sid: string, uid: number, tid: number | null = null): Promise<boolean> {
    const b = await this.prete();
    if (!sidValide(sid)) return false;
    const [filtre, args] = filtreTid(tid);
    const r = await b.run(`DELETE FROM terminal_sessions WHERE id = ? AND uid = ? AND ${filtre}`, [
      sid,
      uid,
      ...args,
    ]);
    return r.changes > 0;
  }

  /** `_purge_abandoned_session_rows` : lignes sans reconnexion depuis 7 jours ; table absente ou base verrouillée : 0. */
  async purger(maintenantS = Date.now() / 1000): Promise<number> {
    try {
      const b = await this.base();
      const r = await b.run("DELETE FROM terminal_sessions WHERE last_connected_at < ?", [
        Math.trunc(maintenantS - SESSION_DB_RETENTION_S),
      ]);
      return r.changes;
    } catch {
      return 0;
    }
  }
}
