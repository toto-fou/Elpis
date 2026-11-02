<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/reglages/ModaleMcp.vue — gestionnaire des serveurs MCP à deux volets : liste groupée à gauche, détail éditable à droite. -->
<script setup lang="ts">
import { computed } from "vue";

import { domaineReglages } from "../../features/reglages/domaine";
import DetailMcp from "./DetailMcp.vue";
import ListeMcp from "./ListeMcp.vue";

const rg = domaineReglages();
const total = computed(() => (rg.settings.mcp_servers || []).length + rg.sharedMcpServers.length);
</script>

<template>
  <Transition name="modal">
    <div
      v-if="rg.showMcpManagerModal"
      data-a11y-modal
      role="dialog"
      aria-modal="true"
      aria-labelledby="mcp-titre"
      class="fixed inset-0 z-[6000] flex items-center justify-center bg-slate-900/80 p-4"
      @click.self="rg.closeMcpManager"
    >
      <div
        class="bg-white rounded-2xl shadow-2xl ring-1 ring-slate-200 w-full max-w-[940px] h-[min(640px,calc(100vh-2rem))] overflow-hidden flex flex-col"
      >
        <header class="flex items-center gap-3 px-5 py-3.5 border-b border-slate-200 shrink-0">
          <span class="w-8 h-8 rounded-lg bg-blue-50 text-blue-600 flex items-center justify-center shrink-0">
            <i class="ph ph-plug text-lg" aria-hidden="true"></i>
          </span>
          <div class="flex-1 min-w-0">
            <h3 id="mcp-titre" class="elpis-mcp-titre text-lg font-semibold text-slate-800 leading-tight">
              Serveurs MCP
            </h3>
            <p class="text-xs text-slate-500">
              {{ total }} serveurs · {{ rg.pinnedServers.length }} dans le panneau
            </p>
          </div>
          <button
            type="button"
            aria-label="Fermer"
            title="Fermer"
            class="w-8 h-8 rounded-lg text-slate-500 hover:text-slate-700 hover:bg-slate-100 flex items-center justify-center transition-colors"
            @click="rg.closeMcpManager"
          >
            <i class="ph ph-x" aria-hidden="true"></i>
          </button>
        </header>
        <div
          class="flex-1 min-h-0 grid grid-cols-1 grid-rows-[minmax(0,40%)_minmax(0,1fr)] md:grid-cols-[300px_minmax(0,1fr)] md:grid-rows-1"
        >
          <ListeMcp />
          <DetailMcp />
        </div>
      </div>
    </div>
  </Transition>
</template>
