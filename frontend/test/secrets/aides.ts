// SPDX-License-Identifier: MIT
/** frontend/test/secrets/aides.ts — secrets factices conformes au contrat, faux serveur du coffre (routes, corps reçus, refus `{detail, code}`) et client HTTP branché dessus. */
import type { Secret } from "@elpis/contracts";

import { GestionnaireSession } from "../../src/features/auth/session";
import { creerApiSecrets } from "../../src/features/secrets/api";
import { ClientHttp } from "../../src/platform/http/client";

export function secret(id: number, o: Partial<Secret> = {}): Secret {
  return {
    id,
    name: `s${id}`,
    kind: "web-login",
    owner: "user",
    scope: { origins: ["https://intranet.example.lan:8443"] },
    username: "admin",
    state: "active",
    version: 1,
    policy: { subagents: true, routines: false, confirm_first_use: false, tls: "strict" },
    meta: {},
    key_current: true,
    use_count: 0,
    last_used_at: null,
    created_at: 1_700_000_000,
    updated_at: 1_700_000_000,
    rotated_at: null,
    ...o,
  };
}

export function json(corps: unknown, statut = 200): Response {
  return new Response(JSON.stringify(corps), {
    status: statut,
    headers: { "content-type": "application/json" },
  });
}

export const refus = (statut: number, code: string, detail: string): Response =>
  json({ detail, code }, statut);

export interface Appel {
  readonly url: string;
  readonly methode: string;
  readonly corps: unknown;
}

/** Client du coffre sur un faux `fetch` : `route` répond, `appels` garde chaque requête (corps JSON décodé). */
export function fauxServeur(route: (url: string, methode: string, corps: unknown) => Response) {
  const appels: Appel[] = [];
  const fetch = (url: string, init?: RequestInit): Promise<Response> => {
    const methode = init?.method ?? "GET";
    const corps: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    appels.push({ url, methode, corps });
    return Promise.resolve(route(url, methode, corps));
  };
  const api = creerApiSecrets(new ClientHttp(new GestionnaireSession(), fetch));
  return { api, appels };
}
