// SPDX-License-Identifier: MIT
/** frontend/src/features/chat/jobs/client.ts — routes des tâches de fond : liste, arrêt, interrupteur de réveil, saisie en cours ; JSON validé par les schémas du contrat. */
import { schemaReponseArretJobs, schemaReponseJobs, schemaReponseReveilChat } from "@elpis/contracts";
import type { ReponseArretJobs, ReponseJobs } from "@elpis/contracts";

export type FetchJobs = (
  url: string,
  options?: Record<string, unknown>,
  soft?: boolean,
) => Promise<Response | null>;

export interface CorpsArret {
  ids?: string[];
  chat_id?: string;
  all?: boolean;
}

const JSON_ENTETES = { "Content-Type": "application/json" };

async function lire<T>(
  res: Response | null,
  schema: { safeParse(x: unknown): { success: true; data: T } | { success: false } },
): Promise<T | null> {
  if (!res || !res.ok) return null;
  const brut: unknown = await res.json().catch(() => null);
  const r = schema.safeParse(brut);
  return r.success ? r.data : null;
}

/** `GET /api/jobs` : une conversation, ou tout le compte (`chatId` nul). */
export async function chargerJobs(fetchAuth: FetchJobs, chatId: string | null): Promise<ReponseJobs | null> {
  const url = chatId ? "/api/jobs?chat_id=" + encodeURIComponent(chatId) : "/api/jobs?scope=all";
  return lire(await fetchAuth(url, {}, true), schemaReponseJobs);
}

/** `POST /api/jobs/stop`. */
export async function arreterJobs(fetchAuth: FetchJobs, corps: CorpsArret): Promise<ReponseArretJobs | null> {
  const res = await fetchAuth(
    "/api/jobs/stop",
    { method: "POST", headers: JSON_ENTETES, body: JSON.stringify(corps) },
    true,
  );
  return lire(res, schemaReponseArretJobs);
}

/** `PUT /api/saved/chats/:id/wake` : rend la valeur effective, ou nul en cas d'échec. */
export async function reglerReveil(
  fetchAuth: FetchJobs,
  chatId: string,
  desactive: boolean,
): Promise<boolean | null> {
  const res = await fetchAuth(
    "/api/saved/chats/" + encodeURIComponent(chatId) + "/wake",
    { method: "PUT", headers: JSON_ENTETES, body: JSON.stringify({ wake_disabled: desactive }) },
    true,
  );
  const r = await lire(res, schemaReponseReveilChat);
  return r ? r.wake_disabled : null;
}

/** `POST /api/chat/:id/composing` : prévient le core que l'utilisateur écrit (TTL 20 s côté core). */
export async function signalerSaisie(fetchAuth: FetchJobs, chatId: string): Promise<boolean> {
  const res = await fetchAuth(
    "/api/chat/" + encodeURIComponent(chatId) + "/composing",
    { method: "POST" },
    true,
  );
  return !!res && res.ok;
}
