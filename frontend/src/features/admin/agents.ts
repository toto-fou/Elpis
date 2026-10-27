// SPDX-License-Identifier: MIT
/** frontend/src/features/admin/agents.ts — console › Sandbox › Sous-agents : lecture seule et réflexion par type, budget de réflexion, sous-agents simultanés et plafonds par tour, section `agents` de config.json (`/api/admin/agents`). */
import {
  BORNES_BUDGET_REFLEXION_AGENTS,
  BORNES_JETONS_ENFANTS_AGENTS,
  BORNES_PARALLELE_AGENTS,
  BORNES_TACHES_PAR_TOUR_AGENTS,
  schemaReponseReglagesAgents,
  schemaReponseReglagesAgentsEcrits,
} from "@elpis/contracts";
import type { CorpsReglagesAgents } from "@elpis/contracts";
import type { Ref } from "vue";

import { journal } from "../../platform/journal";
import { corpsJson, detailErreur, lireSchema } from "../../utils/lecture-json";
import type { BaseAdmin } from "./etat";

const ENTETES_JSON = { "Content-Type": "application/json" };

export function creerAgentsAdmin(b: BaseAdmin) {
  const { vue, ctx, e, lien } = b;
  const { ref } = vue;
  const agentsBounds: Ref<readonly [number, number]> = ref([...BORNES_PARALLELE_AGENTS]);
  const agentsBoundsReflexion: Ref<readonly [number, number]> = ref([...BORNES_BUDGET_REFLEXION_AGENTS]);
  const agentsBoundsTaches: Ref<readonly [number, number]> = ref([...BORNES_TACHES_PAR_TOUR_AGENTS]);
  const agentsBoundsJetons: Ref<readonly [number, number]> = ref([...BORNES_JETONS_ENFANTS_AGENTS]);
  const agentsSaving = ref(false);

  async function loadAgentsConfig(): Promise<void> {
    try {
      const d = await lireSchema(await ctx.fetchAuth("/api/admin/agents"), schemaReponseReglagesAgents);
      if (!d) return;
      e.agentsConfig.value = d.config;
      agentsBounds.value = d.bounds.max_parallel;
      agentsBoundsReflexion.value = d.bounds.thinking_budget_tokens;
      agentsBoundsTaches.value = d.bounds.max_tasks_per_turn;
      agentsBoundsJetons.value = d.bounds.max_child_tokens_per_turn;
      lien.markAdminStoreClean("agents");
    } catch (err) {
      journal.avertir("[admin] loadAgentsConfig failed", err);
    }
  }

  /** Section entière envoyée ; un type ou un mode inconnu, un nombre hors bornes est refusé par le core (400). */
  async function saveAgentsConfig(): Promise<boolean> {
    if (agentsSaving.value) return false;
    agentsSaving.value = true;
    try {
      const corps: CorpsReglagesAgents = { agents: e.agentsConfig.value };
      const res = await ctx.fetchAuth("/api/admin/agents", {
        method: "POST",
        headers: ENTETES_JSON,
        body: JSON.stringify(corps),
      });
      if (!res || !res.ok) {
        const detail = detailErreur(await corpsJson(res), res ? "HTTP " + res.status : "sans réponse");
        ctx.showToast("Sauvegarde refusée : " + detail, "error");
        return false;
      }
      const d = await lireSchema(res, schemaReponseReglagesAgentsEcrits);
      if (!d) return false;
      e.agentsConfig.value = d.config;
      return true;
    } catch {
      return false;
    } finally {
      agentsSaving.value = false;
    }
  }

  return {
    agentsConfig: e.agentsConfig,
    agentsBounds,
    agentsBoundsReflexion,
    agentsBoundsTaches,
    agentsBoundsJetons,
    agentsSaving,
    loadAgentsConfig,
    saveAgentsConfig,
  };
}
