// SPDX-License-Identifier: MIT
/** packages/contracts/src/schemas.ts — schémas JSON (draft 2020-12) des contrats, pour le frontend en JavaScript. */
import { z } from "zod";

import { schemaErreur422, schemaErreurApi, schemaErreurPydantic } from "./erreurs";
import { SCHEMAS_EVENEMENTS, schemaEvenementFlux, schemaFichierModifie, schemaImageRef } from "./evenements";
import { CONTRATS_REST } from "./rest/registre";
import { LOOP_EVENTS, NOT_DISPLAYED, STREAM_EVENT_TYPES } from "./stream-events.gen";
import { schemaEvenementSysteme } from "./systeme";
import { schemaControleTerminal, schemaTrameTerminalServeur } from "./terminal";

/** `GET /api/saved/chats/:chat_id` → `rest-get-api-saved-chats-chat_id`. */
function nomRest(methode: string, chemin: string): string {
  return `rest-${methode.toLowerCase()}${chemin.replace(/[/:]+/gu, "-")}`;
}

export function schemasJson(): Record<string, unknown> {
  const out: Record<string, unknown> = {
    "erreur-api": z.toJSONSchema(schemaErreurApi),
    "erreur-pydantic": z.toJSONSchema(schemaErreurPydantic),
    "erreur-422": z.toJSONSchema(schemaErreur422),
    "fichier-modifie": z.toJSONSchema(schemaFichierModifie),
    "image-ref": z.toJSONSchema(schemaImageRef),
    "evenement-flux": z.toJSONSchema(schemaEvenementFlux),
    "registre-evenements": {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "string",
      enum: [...STREAM_EVENT_TYPES],
      "x-loop-events": [...LOOP_EVENTS],
      "x-not-displayed": [...NOT_DISPLAYED],
    },
  };
  for (const [type, schema] of Object.entries(SCHEMAS_EVENEMENTS))
    out[`evenement-${type}`] = z.toJSONSchema(schema);
  out["evenement-systeme"] = z.toJSONSchema(schemaEvenementSysteme);
  out["terminal-trame-serveur"] = z.toJSONSchema(schemaTrameTerminalServeur);
  out["terminal-controle"] = z.toJSONSchema(schemaControleTerminal);
  for (const r of CONTRATS_REST) {
    if (r.reponse !== null) out[nomRest(r.methode, r.chemin)] = z.toJSONSchema(r.reponse, { io: "output" });
    if (r.corps !== undefined)
      out[`${nomRest(r.methode, r.chemin)}-corps`] = z.toJSONSchema(r.corps, { io: "input" });
  }
  return out;
}
