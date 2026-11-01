<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/agents/PanneauOutils.vue — onglet Outils de la fiche : catégories d'outils cochables, puis serveurs MCP de l'agent. -->
<script setup lang="ts">
import { domaineReglages } from "../../features/reglages/domaine";
import LigneOutil from "./LigneOutil.vue";

const rg = domaineReglages();
</script>

<template>
  <div v-if="rg.agentForm" class="flex flex-col gap-3">
    <span
      class="text-[13px] font-semibold text-slate-800"
      :title="
        rg.agentForm._template
          ? 'Catégories entières. Aucune sélection : celles du modèle.'
          : 'Catégories entières. Aucune sélection : socle par défaut (Fichiers, Terminal, Git).'
      "
      >Catégories</span
    >
    <p v-if="(rg.mcpUserCategories || []).length === 0" class="text-xs text-slate-500 italic">
      Aucune catégorie d'outils disponible.
    </p>
    <div v-else class="grid gap-2 grid-cols-[repeat(auto-fit,minmax(180px,1fr))]" data-agent-categories>
      <LigneOutil
        v-for="cat in rg.mcpUserCategories"
        :key="cat.name"
        :libelle="cat.label || cat.name"
        :icone="cat.icon || 'ph-package'"
        :coche="rg.agentForm.tool_categories.includes(cat.name)"
        :data-agent-cat="cat.name"
        @bascule="rg.toggleAgentCat(cat.name)"
      />
    </div>
    <template v-if="(rg.agentMcpChoices || []).length">
      <span
        class="mt-2 text-[13px] font-semibold text-slate-800"
        title="L'agent se connecte à ces serveurs en plus des outils cochés, même s'ils ne sont pas actifs dans le chat."
        >Serveurs MCP</span
      >
      <div class="grid gap-2 grid-cols-[repeat(auto-fit,minmax(180px,1fr))]" data-agent-serveurs>
        <LigneOutil
          v-for="srv in rg.agentMcpChoices"
          :key="srv.id"
          :libelle="srv.name || srv.id"
          icone="ph-plug"
          :coche="rg.agentForm.mcp_server_ids.includes(srv.id)"
          :data-agent-mcp="srv.id"
          @bascule="rg.toggleAgentMcp(srv.id)"
        />
      </div>
    </template>
  </div>
</template>
