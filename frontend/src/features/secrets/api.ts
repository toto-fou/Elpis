// SPDX-License-Identifier: MIT
/** frontend/src/features/secrets/api.ts — coffre « Secrets » vu du navigateur : routes du compte (`/api/secrets*`), de la console (`/api/admin/secrets*`) et secrets attachés à une conversation ; réponses validées par les contrats, refus rendus en français par leur code `secret_*` (le `detail` anglais pour un code inconnu). */
import { schemaReponseSecret, schemaReponseSecrets, schemaReponseSecretsChat } from "@elpis/contracts";
import type { CorpsCreationSecret, CorpsMajSecret, Secret } from "@elpis/contracts";

import type { ClientHttp } from "../../platform/http/client";
import { messageErreur } from "../../platform/http/resultat";
import type { ApiResult } from "../../platform/http/resultat";
import { messageSecret } from "./format";

/** Propriétaire des secrets lus : le compte de la session, ou l'instance (console). */
export type PorteeCoffre = "compte" | "instance";

/** Issue d'un appel : la valeur, ou le message du refus et son code. */
export type IssueSecrets<T> =
  | { readonly ok: true; readonly valeur: T }
  | { readonly ok: false; readonly message: string; readonly code: string | null };

function echec<T>(r: ApiResult<unknown>): IssueSecrets<T> {
  const erreur = "erreur" in r ? r.erreur : null;
  const brut = erreur?.brut;
  const code =
    brut && typeof brut === "object" && typeof (brut as Record<string, unknown>)["code"] === "string"
      ? String((brut as Record<string, unknown>)["code"])
      : null;
  const detail = erreur?.detail ?? null;
  return { ok: false, message: messageSecret(code, detail) ?? (detail || messageErreur(r)), code };
}

function issue<T, U>(r: ApiResult<T>, lire: (v: T) => U): IssueSecrets<U> {
  return r.type === "ok" ? { ok: true, valeur: lire(r.valeur) } : echec<U>(r);
}

const JSON_ENTETES = { "Content-Type": "application/json" };
const corps = (method: string, donnees: unknown): RequestInit => ({
  method,
  headers: JSON_ENTETES,
  body: JSON.stringify(donnees),
});
const segment = (v: number | string): string => encodeURIComponent(String(v));

export function creerApiSecrets(http: ClientHttp) {
  const racine = (p: PorteeCoffre): string => (p === "instance" ? "/api/admin/secrets" : "/api/secrets");
  const unSecret = (s: { secret: Secret }): Secret => s.secret;

  return {
    async lister(p: PorteeCoffre): Promise<IssueSecrets<Secret[]>> {
      const r = await http.requete(racine(p), {}, { schema: schemaReponseSecrets });
      return issue(r, (v) => v.secrets);
    },
    async creer(donnees: CorpsCreationSecret): Promise<IssueSecrets<Secret>> {
      const r = await http.requete("/api/secrets", corps("POST", donnees), { schema: schemaReponseSecret });
      return issue(r, unSecret);
    },
    async modifier(id: number, donnees: CorpsMajSecret): Promise<IssueSecrets<Secret>> {
      const r = await http.requete(`/api/secrets/${segment(id)}`, corps("PUT", donnees), {
        schema: schemaReponseSecret,
      });
      return issue(r, unSecret);
    },
    async tourner(p: PorteeCoffre, id: number, valeur: string): Promise<IssueSecrets<Secret>> {
      const r = await http.requete(`${racine(p)}/${segment(id)}/rotate`, corps("POST", { value: valeur }), {
        schema: schemaReponseSecret,
      });
      return issue(r, unSecret);
    },
    async verifier(id: number): Promise<IssueSecrets<Secret>> {
      const r = await http.requete(
        `/api/secrets/${segment(id)}/verify`,
        { method: "POST" },
        { schema: schemaReponseSecret },
      );
      return issue(r, unSecret);
    },
    async supprimer(p: PorteeCoffre, id: number): Promise<IssueSecrets<true>> {
      const r = await http.requete(`${racine(p)}/${segment(id)}`, { method: "DELETE" });
      return issue(r, () => true as const);
    },
    async attaches(chatId: string): Promise<IssueSecrets<Secret[]>> {
      const r = await http.requete(
        `/api/chats/${segment(chatId)}/secrets`,
        {},
        {
          schema: schemaReponseSecretsChat,
        },
      );
      return issue(r, (v) => v.secrets);
    },
    async attacher(chatId: string, ids: readonly number[]): Promise<IssueSecrets<Secret[]>> {
      const r = await http.requete(`/api/chats/${segment(chatId)}/secrets`, corps("PUT", { ids }), {
        schema: schemaReponseSecretsChat,
      });
      return issue(r, (v) => v.secrets);
    },
  };
}

export type ApiSecrets = ReturnType<typeof creerApiSecrets>;
