// SPDX-License-Identifier: MIT
/** apps/core/src/familles/admin-agents.ts — `/api/admin/agents` (propre au TS) : lecture seule et réflexion des sous-agents par type, budget de réflexion et plafonds par tour, section `agents` de config.json. */
import { estDict, getPy, poserCle } from "@elpis/commun";
import type { Dict } from "@elpis/commun";
import { TYPES_AGENTS_REGLABLES } from "@elpis/securite";
import type { FastifyRequest } from "fastify";

import { lireConfigJson, modifierConfigJson } from "../administration/config-sous-verrou";
import {
  assainirReglagesAgents,
  BORNES_BUDGET_REFLEXION,
  BORNES_DELAI_FOND,
  BORNES_JETONS_ENFANTS,
  BORNES_TACHES_PAR_TOUR,
  reglagesAgentsDepuis,
} from "../outils/integres/task/reglages";
import type { ReglagesAgents } from "../outils/integres/task/reglages";
import type { Journal } from "../journal";
import { auditerRequete } from "../journal-securite/auditer";
import type { DefinitionRoute, Famille, Traitement } from "../routes";
import { corpsJsonValeurs } from "@elpis/http";

export interface DependancesAdminAgents {
  readonly journal: Journal;
}

function route(methode: DefinitionRoute["methode"], chemin: string, traiter: Traitement): DefinitionRoute {
  return { methode, chemin, processus: ["admin"], acces: "admin", traiter };
}

function vue(r: ReglagesAgents): Dict {
  return {
    config: r,
    types: [...TYPES_AGENTS_REGLABLES],
    bounds: {
      max_tasks_per_turn: [...BORNES_TACHES_PAR_TOUR],
      max_child_tokens_per_turn: [...BORNES_JETONS_ENFANTS],
      thinking_budget_tokens: [...BORNES_BUDGET_REFLEXION],
      background_timeout_s: [...BORNES_DELAI_FOND],
    },
  };
}

async function enregistrer(dep: DependancesAdminAgents, req: FastifyRequest): Promise<Dict> {
  const corps = corpsJsonValeurs(req);
  const nouveau = estDict(corps) ? getPy(corps, "agents", null) : null;
  let r: ReglagesAgents | null = null;
  await modifierConfigJson((cfg) => {
    r = assainirReglagesAgents(nouveau, reglagesAgentsDepuis(getPy(cfg, "agents", null)));
    poserCle(cfg, "agents", r);
  });
  const ecrit = r as unknown as ReglagesAgents;
  auditerRequete(req, "admin.agents.update", {
    max_tasks_per_turn: ecrit.max_tasks_per_turn,
    max_child_tokens_per_turn: ecrit.max_child_tokens_per_turn,
    forced: ecrit.read_only.forced,
    thinking: ecrit.thinking.defaults,
    thinking_budget_tokens: ecrit.thinking_budget_tokens,
    background_timeout_s: ecrit.background_timeout_s,
    user_browser_session_allowed: ecrit.user_browser_session_allowed,
  });
  dep.journal.info(
    `[admin] réglages des sous-agents enregistrés (max_tasks_per_turn=${ecrit.max_tasks_per_turn}, max_child_tokens_per_turn=${ecrit.max_child_tokens_per_turn})`,
  );
  return { ok: true, config: ecrit };
}

export function creerFamilleAdminAgents(dep: DependancesAdminAgents): Famille {
  return {
    nom: "admin-agents",
    routes: [
      route("GET", "/api/admin/agents", () =>
        vue(reglagesAgentsDepuis(getPy(lireConfigJson(), "agents", null))),
      ),
      route("POST", "/api/admin/agents", (req) => enregistrer(dep, req)),
    ],
  };
}
