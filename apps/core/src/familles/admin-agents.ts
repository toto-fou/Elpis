// SPDX-License-Identifier: MIT
/** apps/core/src/familles/admin-agents.ts — `/api/admin/agents` (propre au TS) : lecture seule et réflexion des sous-agents par type, budget de réflexion, sous-agents simultanés et plafonds par tour, section `agents` de config.json. */
import { estDict, getPy, poserCle } from "@elpis/commun";
import type { Dict } from "@elpis/commun";
import { auditEvent, TYPES_AGENTS_REGLABLES } from "@elpis/securite";
import type { FastifyRequest } from "fastify";

import { lireConfigJson, modifierConfigJson } from "../administration/config-sous-verrou";
import {
  assainirReglagesAgents,
  BORNES_BUDGET_REFLEXION,
  BORNES_JETONS_ENFANTS,
  BORNES_PARALLELE,
  BORNES_TACHES_PAR_TOUR,
  reglagesAgentsDepuis,
} from "../outils/integres/reglages-taches";
import type { ReglagesAgents } from "../outils/integres/reglages-taches";
import type { Journal } from "../journal";
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
      max_parallel: [...BORNES_PARALLELE],
      max_tasks_per_turn: [...BORNES_TACHES_PAR_TOUR],
      max_child_tokens_per_turn: [...BORNES_JETONS_ENFANTS],
      thinking_budget_tokens: [...BORNES_BUDGET_REFLEXION],
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
  auditEvent({
    userId: req.utilisateur?.id ?? null,
    username: req.utilisateur?.username ?? null,
    action: "admin.agents.update",
    details: {
      max_parallel: ecrit.max_parallel,
      max_tasks_per_turn: ecrit.max_tasks_per_turn,
      max_child_tokens_per_turn: ecrit.max_child_tokens_per_turn,
      forced: ecrit.read_only.forced,
      thinking: ecrit.thinking.defaults,
      thinking_budget_tokens: ecrit.thinking_budget_tokens,
    },
  });
  dep.journal.info(
    `[admin] réglages des sous-agents enregistrés (max_parallel=${ecrit.max_parallel}, max_tasks_per_turn=${ecrit.max_tasks_per_turn}, max_child_tokens_per_turn=${ecrit.max_child_tokens_per_turn})`,
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
