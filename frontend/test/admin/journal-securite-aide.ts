// SPDX-License-Identifier: MIT
/** frontend/test/admin/journal-securite-aide.ts — fabriques des tests du journal de sécurité : lignes, pages, état, vérification et console montée sur un faux réseau. */
import type { EtatJournal, EvenementJournal, VerificationJournal } from "@elpis/contracts";
import * as Vue from "vue";
import { ref } from "vue";

import { setupAdmin } from "../../src/features/admin/console";
import { GestionnaireSession } from "../../src/features/auth/session";
import type { CtxAdmin, RefsAdmin } from "../../src/features/admin/types";
import { ClientHttp } from "../../src/platform/http/client";

export const MAINTENANT = Date.now() / 1000;

export function evenement(n: number, plus: Partial<EvenementJournal> = {}): EvenementJournal {
  return {
    ref: `2026-11-07:${n}`,
    v: 1,
    time: new Date((MAINTENANT - n) * 1000).toISOString(),
    ts: MAINTENANT - n,
    host: "h",
    service: "admin",
    boot: "b".repeat(32),
    seq: n,
    action: "auth.login",
    outcome: "success",
    user_id: 1,
    username: "zoe",
    ip: "10.0.0.1",
    details: { n },
    signed: true,
    kid: "abcd1234",
    ...plus,
  };
}

export function page(events: EvenementJournal[], plus: Record<string, unknown> = {}) {
  return {
    events,
    cursor: null,
    scanned_bytes: 1000,
    budget_reached: false,
    unreadable: 0,
    last_ts: events.at(-1)?.ts ?? null,
    from: "2026-11-07",
    to: "2026-11-07",
    ...plus,
  };
}

export function verification(plus: Partial<VerificationJournal> = {}): VerificationJournal {
  return {
    from: "2026-11-01",
    to: "2026-11-07",
    status: "intact",
    intact: true,
    key_available: true,
    files: 7,
    first_file: "audit-2026-11-01.jsonl",
    last_file: "audit-2026-11-07.jsonl",
    lines: 100,
    v0_lines: 0,
    signed: 100,
    valid: 100,
    unsigned: 0,
    unknown_key: 0,
    invalid_signatures: [],
    unreadable: [],
    gaps: [],
    out_of_order: [],
    unverified: [],
    inconsistent: [],
    misplaced: [],
    duplicates: [],
    writers: 3,
    writers_without_stop: 0,
    uncertain_ends: [],
    reasons: [],
    totals: {
      invalid_signatures: 0,
      unreadable: 0,
      gaps: 0,
      out_of_order: 0,
      unverified: 0,
      inconsistent: 0,
      misplaced: 0,
      late_v0: 0,
      duplicates: 0,
    },
    ...plus,
  };
}

export function etatJournal(plus: Partial<EtatJournal> = {}): EtatJournal {
  return {
    directory: "/var/log/elpis/audit",
    fallback_directory: false,
    mode: "0750",
    group_id: null,
    world_readable: false,
    signed: true,
    kid: "k1",
    files: 8,
    bytes: 4096,
    oldest: "2026-10-01",
    newest: "2026-11-07",
    daily_avg_bytes: 1000,
    disk: { free_bytes: 10 * 1024 ** 3, total_bytes: 20 * 1024 ** 3, days_left: 400 },
    clock_synchronized: true,
    forwarding: {
      expected: false,
      agent: null,
      active: null,
      rule: null,
      collector: null,
      transport: null,
      queue: null,
      certificates: [],
    },
    retention: {
      retention_days: 365,
      hold: false,
      hold_reason: "",
      forwarding_expected: false,
      out_of_bounds: false,
      invalid: false,
      from_witness: false,
      eligible_files: 0,
    },
    write_failures: { count: 0, last_error: null },
    writers: [],
    alerts: [],
    generated_at: MAINTENANT,
    ...plus,
  };
}

export function monter(
  route: (url: string, init?: RequestInit) => Response | Promise<Response>,
  compte = { username: "root", role: "admin", is_admin: 1 },
) {
  const fetchFaux = (url: string, init?: RequestInit): Promise<Response> => Promise.resolve(route(url, init));
  const refs: RefsAdmin = { user: ref(compte), isAdminView: ref(true) };
  const ctx: CtxAdmin = {
    showToast: () => undefined,
    fetchAuth: (url, options) => fetchFaux(url, options),
    openConfirm: () => Promise.resolve(true),
    openChoice: () => Promise.resolve("save"),
    nextTick: () => Vue.nextTick(),
    loadPublicConfig: () => undefined,
    systemAlert: ref(""),
  };
  return { A: setupAdmin(Vue, refs, ctx, new ClientHttp(new GestionnaireSession(), fetchFaux)) };
}
