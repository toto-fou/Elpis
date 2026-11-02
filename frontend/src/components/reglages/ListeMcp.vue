<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/reglages/ListeMcp.vue — volet gauche du gestionnaire MCP : recherche, ajout, serveurs groupés par origine (perso, partagés). -->
<script setup lang="ts">
import { computed } from "vue";

import { domaineReglages } from "../../features/reglages/domaine";
import { ICONES_MCP } from "../../features/reglages/mcp";
import LigneMcp from "./LigneMcp.vue";

const rg = domaineReglages();
const neuf = computed(() => (rg.mcpSel === "nouveau" ? rg.mcpForm : null));
const rien = computed(() => !!rg.mcpSearch.trim() && !rg.mcpListePerso.length && !rg.mcpListePartages.length);

// Flèches haut / bas : passent d'une rangée à l'autre et la sélectionnent.
function clavier(e: KeyboardEvent): void {
  if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
  const cible = e.target instanceof HTMLElement ? e.target.closest<HTMLElement>("[data-mcp-ligne]") : null;
  if (!cible) return;
  e.preventDefault();
  const lignes = [...(e.currentTarget as HTMLElement).querySelectorAll<HTMLElement>("[data-mcp-ligne]")];
  const i = lignes.indexOf(cible) + (e.key === "ArrowDown" ? 1 : -1);
  const suivante = lignes[Math.max(0, Math.min(lignes.length - 1, i))];
  suivante?.focus();
  suivante?.click();
}
</script>

<template>
  <aside
    class="flex flex-col min-h-0 bg-slate-50 border-b md:border-b-0 md:border-r border-slate-200"
    aria-label="Serveurs"
  >
    <div class="flex items-center gap-2 p-3">
      <label
        class="flex-1 min-w-0 flex items-center gap-1.5 h-8 px-2.5 rounded-lg bg-white border border-slate-200 text-slate-500 focus-within:border-blue-500"
      >
        <i class="ph ph-magnifying-glass text-sm" aria-hidden="true"></i>
        <input
          v-model="rg.mcpSearch"
          type="search"
          placeholder="Rechercher"
          aria-label="Rechercher un serveur"
          class="flex-1 min-w-0 bg-transparent outline-none text-[13px] text-slate-800"
        />
      </label>
      <button type="button" class="adm-btn adm-tool adm-btn--sm h-8" @click="rg.mcpNouveau()">
        <i class="ph ph-plus" aria-hidden="true"></i> Ajouter
      </button>
    </div>

    <div class="flex-1 overflow-y-auto custom-scrollbar px-2 pb-3" @keydown="clavier">
      <p v-if="rien" class="px-2.5 py-2 text-[13px] text-slate-500">
        Aucun résultat pour « {{ rg.mcpSearch }} »
      </p>

      <h4 class="flex items-center gap-1.5 px-2.5 pt-3 pb-1 text-xs font-semibold text-slate-500">
        Mes serveurs
        <span class="font-normal text-slate-400">{{ (rg.settings.mcp_servers || []).length }}</span>
      </h4>
      <LigneMcp
        v-if="neuf && neuf.portee === 'perso'"
        cle="nouveau"
        icone="ph-plus"
        :nom="neuf.name || 'Nouveau serveur'"
        sous="Non enregistré"
      />
      <LigneMcp
        v-for="s in rg.mcpListePerso"
        :key="s.id"
        :cle="'p:' + s.id"
        :icone="ICONES_MCP[s.type] || 'ph-globe'"
        :nom="s.name"
        :etat-id="s.id"
        :epingle="!!s.visible"
      />

      <h4 class="flex items-center gap-1.5 px-2.5 pt-4 pb-1 text-xs font-semibold text-slate-500">
        Partagés <span class="font-normal text-slate-400">{{ rg.sharedMcpServers.length }}</span>
      </h4>
      <LigneMcp
        v-if="neuf && neuf.portee === 'partage'"
        cle="nouveau"
        icone="ph-plus"
        :nom="neuf.name || 'Nouveau serveur'"
        sous="Non publié"
      />
      <LigneMcp
        v-for="s in rg.mcpListePartages"
        :key="s.id"
        :cle="'s:' + s.id"
        :icone="ICONES_MCP[s.type] || 'ph-globe'"
        :nom="s.name"
        :etat-id="s.id"
        :desactive="!s.enabled"
        :epingle="s.enabled && rg.isSharedVisible(s.id)"
      />
      <p v-if="!rg.sharedMcpServers.length" class="px-2.5 pb-1 text-[13px] text-slate-500">
        Aucun serveur publié
      </p>
    </div>
  </aside>
</template>
