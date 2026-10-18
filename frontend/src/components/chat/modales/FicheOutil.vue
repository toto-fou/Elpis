<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/chat/modales/FicheOutil.vue — fiche d'un outil du panneau MCP : nom, serveur et description déclarée. -->
<script setup lang="ts">
import { domaineModales } from "../../../features/chat/modales/domaine";

const m = domaineModales();
</script>

<template>
  <!-- Fiche d'un outil — ouverte par le bouton « i » d'une case du panneau
           Outils. Elle vit ICI et non dans le panneau : celui-ci passe en
           ``overflow-hidden`` quand il glisse, et clipperait tout débordement.
           Le texte vient du registre MCP (description déclarée par le serveur,
           bornée à 220 caractères) — rien n'est inventé côté navigateur. -->
  <div
    v-if="m.toolInfo"
    data-a11y-modal
    role="dialog"
    aria-modal="true"
    aria-label="Détail de l'outil"
    class="fixed inset-0 z-[6000] flex items-center justify-center bg-slate-900/80 p-4"
    @click.self="m.closeToolInfo()"
  >
    <div
      class="bg-white rounded-2xl shadow-2xl ring-1 ring-slate-200 w-full max-w-md overflow-hidden flex flex-col max-h-[80vh]"
    >
      <div class="px-5 py-4 border-b border-slate-100 flex items-start justify-between gap-3 shrink-0">
        <div class="min-w-0">
          <h3 class="font-bold text-slate-800 text-sm truncate">{{ m.toolInfo.title || m.toolInfo.name }}</h3>
          <p class="text-[10px] text-slate-400 truncate">
            <span class="font-mono">{{ m.toolInfo.name }}</span>
            <span v-if="m.toolInfo.cat"> · {{ m.toolInfo.cat }}</span>
            <span v-if="m.toolInfo.read_only"> · lecture seule</span>
          </p>
        </div>
        <button
          aria-label="Fermer"
          class="w-8 h-8 rounded-lg hover:bg-slate-100 text-slate-400 transition-colors flex items-center justify-center shrink-0"
          @click="m.closeToolInfo()"
        >
          <i class="ph ph-x text-lg"></i>
        </button>
      </div>
      <div class="flex-1 overflow-y-auto px-5 py-4 custom-scrollbar">
        <p v-if="m.toolInfo.description" class="text-xs text-slate-600 whitespace-pre-line leading-relaxed">
          {{ m.toolInfo.description }}
        </p>
        <p v-else class="text-xs text-slate-400 italic">Cet outil ne déclare pas de description.</p>
      </div>
    </div>
  </div>
</template>
