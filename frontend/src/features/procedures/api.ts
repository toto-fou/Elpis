// SPDX-License-Identifier: MIT
/** frontend/src/features/procedures/api.ts — accords humains des gestes sensibles d'une procédure (`/api/procedures/approbations*`), réponses validées par les schémas de @elpis/contracts. */
import {
  schemaReponseApprobations,
  schemaReponseApprobationVersion,
  schemaReponseDecisionApprobation,
  schemaReponseProcedures,
  schemaReponseResumeProcedure,
  schemaReponseSuppressionProcedure,
} from "@elpis/contracts";

import type { ClientHttp } from "../../platform/http/client";

export type DecisionAccord = "approve" | "refuse";

export function creerApiAccords(http: ClientHttp) {
  return {
    enAttente: (chatId: string) =>
      http.requete(
        `/api/procedures/approbations?chat_id=${encodeURIComponent(chatId)}`,
        {},
        { schema: schemaReponseApprobations },
      ),
    decider: (id: string, decision: DecisionAccord) =>
      http.requete(
        `/api/procedures/approbations/${encodeURIComponent(id)}/decision`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ decision }),
        },
        { schema: schemaReponseDecisionApprobation },
      ),
  };
}

/** Écran Procédures : liste, résumé d'une version, approbation, suppression. */
export function creerApiProcedures(http: ClientHttp) {
  const chemin = (id: string, version?: number): string =>
    `/api/procedures/${encodeURIComponent(id)}${version === undefined ? "" : `/versions/${version}`}`;
  return {
    lister: () => http.requete("/api/procedures", {}, { schema: schemaReponseProcedures }),
    resume: (id: string, version: number) =>
      http.requete(chemin(id, version), {}, { schema: schemaReponseResumeProcedure }),
    approuver: (id: string, version: number) =>
      http.requete(
        `${chemin(id, version)}/approve`,
        { method: "POST" },
        { schema: schemaReponseApprobationVersion },
      ),
    supprimer: (id: string, version?: number) =>
      http.requete(chemin(id, version), { method: "DELETE" }, { schema: schemaReponseSuppressionProcedure }),
  };
}
