// SPDX-License-Identifier: MIT
/** frontend/src/features/code/api.ts — appels `/api/code/*` de la page Code : JSON validé par les schémas C2, `null` en cas d'échec ou de réponse hors contrat. */
import {
  schemaOk,
  schemaReponseAgentsCode,
  schemaReponseClientsCode,
  schemaReponseCommandeCode,
  schemaReponseCommandesCode,
  schemaReponseConfigCode,
  schemaReponseJetonCode,
  schemaReponseMessagesCode,
  schemaReponseModelesCode,
  schemaReponsePermissionsCode,
  schemaReponseQuestionsCode,
  schemaReponseSanteCode,
  schemaReponseSessionsCode,
} from "@elpis/contracts";
import type { z } from "zod";

import type { HttpLegacy } from "../../platform/http/legacy";

type Fetch = HttpLegacy["fetchJsonAuth"];
type Sortie<S extends z.ZodType> = z.output<S> | null;

const JSON_ENTETES = { "Content-Type": "application/json" };

export function creerApiCode(fetchJsonAuth: Fetch) {
  const lire = async <S extends z.ZodType>(
    schema: S,
    url: string,
    init?: RequestInit,
    opts?: Parameters<Fetch>[2],
  ): Promise<Sortie<S>> => {
    const brut = await fetchJsonAuth(url, init, opts);
    if (brut === null) return null;
    const r = schema.safeParse(brut);
    return r.success ? (r.data as z.output<S>) : null;
  };
  const doux = { soft: true };
  const poster = <S extends z.ZodType>(
    schema: S,
    url: string,
    corps?: unknown,
    opts?: Parameters<Fetch>[2],
  ) =>
    lire(
      schema,
      url,
      corps === undefined
        ? { method: "POST" }
        : { method: "POST", headers: JSON_ENTETES, body: JSON.stringify(corps) },
      opts,
    );
  const session = (sid: string): string => `/api/code/sessions/${sid}`;
  return {
    sante: () => lire(schemaReponseSanteCode, "/api/code/health", {}, doux),
    config: () => lire(schemaReponseConfigCode, "/api/code/config", {}, doux),
    sessions: () => lire(schemaReponseSessionsCode, "/api/code/sessions", {}, doux),
    messages: (sid: string) => lire(schemaReponseMessagesCode, `${session(sid)}/messages`, {}, doux),
    commandes: () => lire(schemaReponseCommandesCode, "/api/code/commands", {}, doux),
    modeles: () => lire(schemaReponseModelesCode, "/api/code/models", {}, doux),
    agents: () => lire(schemaReponseAgentsCode, "/api/code/agents", {}, doux),
    clients: () => lire(schemaReponseClientsCode, "/api/code/clients", {}, doux),
    permissions: (sid: string) => lire(schemaReponsePermissionsCode, `${session(sid)}/permissions`, {}, doux),
    questions: (sid: string) => lire(schemaReponseQuestionsCode, `${session(sid)}/questions`, {}, doux),
    renommer: (sid: string, title: string) =>
      poster(schemaReponseCommandeCode, `${session(sid)}/rename`, { title }),
    repondrePermission: (sid: string, pid: string, response: string) =>
      poster(schemaReponseCommandeCode, `${session(sid)}/permissions/${pid}`, { response }),
    repondreQuestion: (sid: string, qid: string, corps: unknown, errorMsg: string) =>
      poster(schemaReponseCommandeCode, `${session(sid)}/questions/${qid}`, corps, { errorMsg }),
    supprimer: (sid: string) => lire(schemaOk, session(sid), { method: "DELETE" }),
    action: (sid: string, action: string) =>
      poster(schemaReponseCommandeCode, `${session(sid)}/action`, { action }),
    nouvelle: (client: string) =>
      poster(schemaReponseCommandeCode, "/api/code/new", client ? { client } : {}),
    quitter: (cid: string) =>
      poster(schemaReponseCommandeCode, `/api/code/clients/${encodeURIComponent(cid)}/exit`),
    commande: (sid: string, command: string, args: string) =>
      poster(schemaReponseCommandeCode, `${session(sid)}/command`, { command, arguments: args }),
    prompt: (sid: string, corps: unknown) =>
      poster(schemaReponseCommandeCode, `${session(sid)}/prompt`, corps),
    interrompre: (sid: string) => poster(schemaReponseCommandeCode, `${session(sid)}/abort`),
    creerJeton: () => poster(schemaReponseJetonCode, "/api/code/token", { name: "opencode" }),
    tournerJeton: () => poster(schemaReponseJetonCode, "/api/code/token/rotate"),
  };
}
export type ApiCode = ReturnType<typeof creerApiCode>;
