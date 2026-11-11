// SPDX-License-Identifier: MIT
/** apps/core/test/aides.ts — app de test avec un journal muet, requête à en-têtes seuls, lignes récentes du journal de sécurité, ligne d'audit réduite aux champs v0. */
import { readdirSync, readFileSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";

import { etatEcritureAudit } from "@elpis/securite";
import type { FastifyInstance } from "fastify";

import { creerApp } from "../src/app";
import type { OptionsApp } from "../src/app";
import { Journal } from "../src/journal";

export const lignesJournal: string[] = [];
export const journalMuet = new Journal({ niveau: "trace", sortie: (l) => lignesJournal.push(l) });

export function appTest(
  options: Partial<OptionsApp> & Pick<OptionsApp, "familles">,
): Promise<FastifyInstance> {
  return creerApp({ mode: "main", journal: journalMuet, ...options });
}

/** Première ligne de la réponse à des en-têtes seuls annonçant `octets` (corps jamais envoyé) ; « aucune réponse » après 5 s : le serveur attendait le corps. */
export function enTetesSeules(
  port: number,
  methode: string,
  chemin: string,
  entetes = "",
  octets = 50 * 1024 * 1024,
): Promise<string> {
  return new Promise((fini) => {
    const s = connect(port, "127.0.0.1", () =>
      s.write(
        `${methode} ${chemin} HTTP/1.1\r\nHost: lan.test\r\ncontent-type: application/json\r\n${entetes}` +
          `Content-Length: ${octets}\r\nConnection: close\r\n\r\n`,
      ),
    );
    const delai = setTimeout(() => {
      s.destroy();
      fini("aucune réponse");
    }, 5_000);
    let d = "";
    s.on("data", (m: Buffer) => {
      d += m.toString("latin1");
      if (!d.includes("\r\n")) return;
      clearTimeout(delai);
      s.destroy();
      fini(d.slice(0, d.indexOf("\r\n")));
    });
    s.on("error", () => undefined);
  });
}

/** Écart voulu : les deux effacements du Python (route Starlette, middleware de session) ramenés à la forme unique du TS (HttpOnly, Max-Age=0). */
export function effacementUnifie(python: string): string {
  const route = /^([^=]+)=""; expires=([^;]+); Max-Age=0; Path=\/; SameSite=(\w+)(; Secure)?$/u.exec(python);
  if (route !== null)
    return `${route[1]}=""; path=/; expires=${route[2]}; Max-Age=0; httponly; samesite=${route[3]}${route[4] ? "; secure" : ""}`;
  const session = /^([^=]+)=null; path=\/; (expires=Thu, 01 Jan 1970 00:00:00 GMT); (httponly; .*)$/u.exec(
    python,
  );
  if (session !== null) return `${session[1]}=""; path=/; ${session[2]}; Max-Age=0; ${session[3]}`;
  return python;
}

/** Lignes du journal de sécurité configuré (tous ses fichiers), plus récentes d'abord ; `actionPrefix` et `limit` (100) comme l'ancien `readRecentAuditLines`. */
export function lignesAuditRecentes(
  f: { limit?: number; actionPrefix?: string } = {},
): Record<string, unknown>[] {
  const dossier = etatEcritureAudit().dossier;
  const sortie: Record<string, unknown>[] = [];
  let noms: string[];
  try {
    noms = readdirSync(dossier).filter((n) => /^audit-\d{4}-\d{2}-\d{2}\.jsonl$/u.test(n));
  } catch {
    return sortie;
  }
  for (const nom of noms.sort().reverse())
    for (const ligne of readFileSync(join(dossier, nom), "utf8").split("\n").reverse()) {
      if (!ligne) continue;
      const rec = JSON.parse(ligne) as Record<string, unknown>;
      if (f.actionPrefix && !String(rec["action"] ?? "").startsWith(f.actionPrefix)) continue;
      sortie.push(rec);
      if (sortie.length >= (f.limit ?? 100)) return sortie;
    }
  return sortie;
}

/** Ligne du journal de sécurité (v0 ou v1) réduite aux champs du format Python : les vecteurs v0 restent comparables. */
export function champsAuditV0(ligne: string): Record<string, unknown> {
  const { action, details, service, ts, user_id, username } = JSON.parse(ligne) as Record<string, unknown>;
  return { action, details, service, ts, user_id, username };
}

/** Actions du journal de sécurité ajoutées par le TS : écarts voulus à la référence Python, retirés des lignes comparées aux vecteurs. */
export const ACTIONS_PROPRES_AU_TS: ReadonlySet<string> = new Set([
  "admin.audit.search",
  "auth.bootstrap",
  "auth.logout",
  "auth.password.change",
  "auth.password.change.denied",
  "admin.user.create",
  "admin.user.delete",
  "admin.user.role",
  "admin.user.password_reset",
  "admin.user.groups",
  "admin.group.create",
  "admin.group.update",
  "admin.group.delete",
  "admin.oauth_client.delete",
  "admin.security.https",
  "admin.security.listen",
  "admin.security.sessions.clear_user_revocation",
  "admin.config.patch",
  "admin.config.file_save",
  "admin.config.compression",
  "admin.metrics.export",
  "admin.runs.export",
  "admin.llm_traffic.read",
  "admin.llm_traffic.delete",
  "admin.restart",
  "admin.restart.failed",
]);

/** Lignes d'audit brutes sans les actions propres au TS. */
export function sansActionsTs(lignes: readonly string[]): string[] {
  return lignes.filter(
    (l) => !ACTIONS_PROPRES_AU_TS.has(String((JSON.parse(l) as { action?: unknown }).action)),
  );
}
