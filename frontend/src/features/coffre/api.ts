// SPDX-License-Identifier: MIT
/** frontend/src/features/coffre/api.ts — appels du coffre d'identifiants et des jetons de conversation (`/api/coffre*`), réponses validées par les schémas de @elpis/contracts ; le mot de passe n'est qu'envoyé. */
import {
  schemaOk,
  schemaReponseCoffre,
  schemaReponseEntreeCoffre,
  schemaReponseJetonCreds,
  schemaReponseJetonCredsCree,
  schemaReponseJetonsCreds,
} from "@elpis/contracts";

import type { ClientHttp } from "../../platform/http/client";

export interface CorpsEntree {
  nom: string;
  origin: string;
  username: string;
  password: string;
  allow_insecure_tls?: boolean;
}

export interface CorpsMajEntree {
  nom?: string;
  origin?: string;
  username?: string;
  password?: string;
  allow_insecure_tls?: boolean;
}

export interface CorpsJeton {
  chat_id: string;
  entry_id?: number;
  origin?: string;
  username?: string;
  password?: string;
  save?: boolean;
  allow_insecure_tls?: boolean;
}

function json(methode: string, corps?: unknown): RequestInit {
  return corps === undefined
    ? { method: methode }
    : { method: methode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(corps) };
}

export function creerApiCoffre(http: ClientHttp) {
  return {
    lister: () => http.requete("/api/coffre", {}, { schema: schemaReponseCoffre }),
    creer: (corps: CorpsEntree) =>
      http.requete("/api/coffre", json("POST", corps), { schema: schemaReponseEntreeCoffre }),
    modifier: (id: number, corps: CorpsMajEntree) =>
      http.requete(`/api/coffre/${id}`, json("PUT", corps), { schema: schemaReponseEntreeCoffre }),
    confirmer: (id: number, origin: string, password?: string) =>
      http.requete(
        `/api/coffre/${id}/confirmer`,
        json("POST", { origin, ...(password ? { password } : {}) }),
        {
          schema: schemaReponseEntreeCoffre,
        },
      ),
    supprimer: (id: number) => http.requete(`/api/coffre/${id}`, json("DELETE"), { schema: schemaOk }),
    jetons: (chatId: string) =>
      http.requete(
        `/api/coffre/jetons?chat_id=${encodeURIComponent(chatId)}`,
        {},
        {
          schema: schemaReponseJetonsCreds,
        },
      ),
    creerJeton: (corps: CorpsJeton) =>
      http.requete("/api/coffre/jetons", json("POST", corps), { schema: schemaReponseJetonCredsCree }),
    renouveler: (id: number) =>
      http.requete(`/api/coffre/jetons/${id}/renouveler`, json("POST"), { schema: schemaReponseJetonCreds }),
    revoquer: (id: number) => http.requete(`/api/coffre/jetons/${id}`, json("DELETE"), { schema: schemaOk }),
  };
}

export type ApiCoffre = ReturnType<typeof creerApiCoffre>;
