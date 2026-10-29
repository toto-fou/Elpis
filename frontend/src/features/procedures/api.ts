// SPDX-License-Identifier: MIT
/** frontend/src/features/procedures/api.ts — accords humains des gestes sensibles d'une procédure (`/api/procedures/approbations*`), réponses validées par les schémas de @elpis/contracts. */
import type { ChoixApprentissageDto, ChoixParametre } from "@elpis/contracts";
import type { ZodType } from "zod";
import {
  schemaReponseApercu,
  schemaReponseApprobations,
  schemaReponseBrouillon,
  schemaReponseEnregistrementProcedure,
  schemaReponseApprobationVersion,
  schemaReponseDecisionApprobation,
  schemaReponseProcedures,
  schemaReponseRetraitApprobation,
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
    approuver: (id: string, version: number, params: Record<string, ChoixParametre>) =>
      http.requete(
        `${chemin(id, version)}/approve`,
        { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ params }) },
        { schema: schemaReponseApprobationVersion },
      ),
    retirer: (id: string, version: number) =>
      http.requete(
        `${chemin(id, version)}/unapprove`,
        { method: "POST" },
        { schema: schemaReponseRetraitApprobation },
      ),
    supprimer: (id: string, version?: number) =>
      http.requete(chemin(id, version), { method: "DELETE" }, { schema: schemaReponseSuppressionProcedure }),
  };
}

/** « Enregistrer comme procédure » : brouillon d'une conversation, aperçu, enregistrement d'une version non approuvée. */
export function creerApiApprentissage(http: ClientHttp) {
  const post = <T>(
    etape: string,
    schema: ZodType<T>,
    corps: { chat_id: string; origin?: string; choix?: ChoixApprentissageDto; empreinte?: string },
  ) =>
    http.requete(
      `/api/procedures/apprendre/${etape}`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(corps) },
      { schema },
    );
  return {
    brouillon: (chat_id: string, origin?: string) =>
      post("brouillon", schemaReponseBrouillon, { chat_id, ...(origin ? { origin } : {}) }),
    apercu: (chat_id: string, choix: ChoixApprentissageDto, origin?: string) =>
      post("apercu", schemaReponseApercu, { chat_id, choix, ...(origin ? { origin } : {}) }),
    enregistrer: (chat_id: string, choix: ChoixApprentissageDto, origin: string, empreinte: string) =>
      post("enregistrer", schemaReponseEnregistrementProcedure, { chat_id, choix, origin, empreinte }),
  };
}
