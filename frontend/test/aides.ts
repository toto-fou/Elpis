// SPDX-License-Identifier: MIT
/** frontend/test/aides.ts — faux `fetch` pilotable et réponses JSON pour les tests de session et de HTTP. */
import { nextTick } from "vue";

import type { Compte } from "../src/features/auth/session";

export const COMPTE_A: Compte = { id: 1, username: "alice", is_admin: false, role: "user", avatar: null };
export const COMPTE_B: Compte = { id: 2, username: "bob", is_admin: true, role: "admin", avatar: null };

/** Laisse passer les rendus en attente, une macrotâche et le rendu qui suit. */
export async function vider(): Promise<void> {
  for (let i = 0; i < 6; i++) await nextTick();
  await new Promise((r) => setTimeout(r, 0));
  await nextTick();
}

export function json(corps: unknown, statut = 200): Response {
  return new Response(JSON.stringify(corps), {
    status: statut,
    headers: { "content-type": "application/json" },
  });
}

export function texte(corps: string, statut: number): Response {
  return new Response(corps, { status: statut, headers: { "content-type": "text/plain; charset=utf-8" } });
}

interface Attente {
  readonly url: string;
  readonly init: RequestInit | undefined;
  repondre(r: Response): void;
  echouer(e: unknown): void;
}

/** `fetch` dont chaque appel attend qu'on le résolve à la main (réponses tardives, concurrentes). */
export function fetchManuel() {
  const appels: Attente[] = [];
  const fetch = (url: string, init?: RequestInit): Promise<Response> =>
    new Promise<Response>((repondre, echouer) => {
      appels.push({ url, init, repondre, echouer });
    });
  return { fetch, appels };
}

export function abandon(): Error {
  const e = new Error("aborted");
  e.name = "AbortError";
  return e;
}

/** Réponse de `GET /api/sandbox/me` conforme au contrat (`schemaReponseBacMoi`), conteneur actif par défaut. */
export function bacMoi(
  container: Record<string, unknown> = { exists: true, running: true, container_name: "elpis-sb-alice" },
) {
  return {
    user_mode: "docker",
    effective_mode: "docker",
    force_admin: false,
    image: "elpis/sandbox:test",
    limits: { memory_mb: 2048, cpu_quota_pct: 100, pids_max: 512, timeout_s: 600 },
    idle_kill_hours: 24,
    image_status: { status: "loaded", image: "elpis/sandbox:test", archive_path: null, progress_msg: "" },
    network_profile_id: "isolated",
    network_profiles: [
      {
        id: "isolated",
        name: "Isolé",
        mode: "none",
        ips: [],
        description: "",
        domains: [],
        ports: [],
        dns: [],
      },
    ],
    network_profile_locked: false,
    daemon_ok: true,
    daemon_info: "",
    container,
  };
}

/** Session de terminal conforme au contrat (`schemaSessionTerminal`). */
export function sessionTerminal(id: string, name: string) {
  return { id, uid: 1, tid: null, name, created_at: 1_760_000_000, last_connected_at: 1_760_000_000 };
}
