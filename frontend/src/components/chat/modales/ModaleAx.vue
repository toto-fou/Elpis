<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/chat/modales/ModaleAx.vue — mémoire AX : sites appris par les sessions Playwright, arbre ASCII par site, renvoi vers la console. -->
<script setup lang="ts">
import { domaineModales } from "../../../features/chat/modales/domaine";

const m = domaineModales();
</script>

<template>
  <Transition name="modal">
    <div
      v-if="m.showAxModal"
      data-a11y-modal
      role="dialog"
      aria-modal="true"
      aria-label="AX Memory"
      class="fixed inset-0 z-[6000] flex items-center justify-center bg-slate-900/80 p-4"
      @click.self="m.showAxModal = false"
    >
      <div
        class="bg-white rounded-2xl shadow-2xl ring-1 ring-slate-200 w-full max-w-4xl overflow-hidden flex flex-col max-h-[85vh]"
      >
        <div class="px-5 py-4 border-b border-slate-100 flex items-center justify-between shrink-0">
          <div class="flex items-center gap-2.5">
            <div class="w-8 h-8 rounded-lg bg-blue-100 text-blue-600 flex items-center justify-center">
              <i class="ph ph-tree-structure"></i>
            </div>
            <div>
              <h3 class="font-bold text-slate-800 text-sm">AX Memory -- Cartographie connue du LLM</h3>
              <p class="text-[10px] text-slate-400">
                Arbres DOM appris lors des sessions Playwright. {{ m.axSites.length }} site(s) indexe(s).
              </p>
            </div>
          </div>
          <div class="flex items-center gap-1.5">
            <button
              title="Rafraichir"
              class="w-8 h-8 rounded-lg hover:bg-slate-100 text-slate-500 transition-colors flex items-center justify-center"
              @click="m.loadAxSites()"
            >
              <i class="ph ph-arrow-clockwise"></i>
            </button>
            <button
              aria-label="Fermer"
              class="w-8 h-8 rounded-lg hover:bg-slate-100 text-slate-400 transition-colors flex items-center justify-center"
              @click="m.showAxModal = false"
            >
              <i class="ph ph-x text-lg"></i>
            </button>
          </div>
        </div>
        <div class="flex-1 overflow-y-auto p-5 custom-scrollbar">
          <div v-if="m.axLoading" class="flex items-center justify-center py-12">
            <i class="ph ph-spinner-gap animate-spin text-2xl text-blue-500"></i>
          </div>
          <div v-else-if="m.axSites.length === 0" class="text-center py-12 text-slate-500 text-sm italic">
            <i class="ph ph-tree-structure text-4xl text-slate-300 block mb-2"></i>
            Aucun site dans la memoire AX pour l'instant.<br />
            Lance une session Playwright sur un site pour l'indexer.
          </div>
          <div v-else class="space-y-2">
            <div
              v-for="site in m.axSites"
              :key="site.site"
              class="border border-slate-200 rounded-lg overflow-hidden hover:border-slate-300 transition-colors"
            >
              <div class="flex items-center gap-3 p-3 bg-slate-50">
                <button
                  class="flex-1 text-left flex items-center gap-2 min-w-0"
                  @click="m.toggleAxSite(site.site)"
                >
                  <i
                    :class="[
                      'ph',
                      m.axExpanded[site.site] ? 'ph-caret-down' : 'ph-caret-right',
                      'text-slate-400 text-sm shrink-0',
                    ]"
                  ></i>
                  <span class="font-mono text-sm font-semibold text-slate-800 truncate">{{ site.site }}</span>
                  <span
                    v-if="site.has_credentials"
                    class="text-[10px] px-1.5 py-0.5 bg-green-100 text-green-700 rounded font-medium shrink-0"
                    ><i class="ph ph-key text-[9px]"></i> {{ site.cred_username }}</span
                  >
                  <span class="text-xs text-slate-500 ml-2 shrink-0"
                    >{{ site.elements }} elements · {{ site.paths }} pages ·
                    {{ site.transitions }} transitions</span
                  >
                </button>
              </div>
              <div v-if="m.axExpanded[site.site]" class="bg-slate-950 text-slate-200 text-xs font-mono">
                <div v-if="m.axTreeLoading[site.site]" class="p-4 text-slate-400 italic">Chargement...</div>
                <pre
                  v-else-if="m.axTrees[site.site]"
                  class="p-4 overflow-x-auto whitespace-pre leading-relaxed"
                  >{{ m.axTrees[site.site] }}</pre>
                <div v-else class="p-4 text-slate-500 italic">(vide)</div>
              </div>
            </div>
          </div>
        </div>
        <div
          v-if="m.user?.role === 'admin' || m.user?.role === 'moderator'"
          class="px-5 py-3 border-t border-slate-100 bg-slate-50/50 flex items-center justify-between shrink-0"
        >
          <div class="text-[11px] text-slate-500">
            <i class="ph ph-info"></i> Actions de suppression disponibles dans le panel admin.
          </div>
          <!-- La mémoire AX vit désormais dans Maintenance (refonte
                       2026-08-01) : section « Mémoire AX », accessible depuis la
                       barre d'ancres de la page. -->
          <button
            class="text-[11px] px-3 py-1.5 bg-slate-900 hover:bg-slate-800 text-white rounded-md transition-colors font-medium"
            @click="
              m.showAxModal = false;
              m.goToAdmin('vision');
            "
          >
            Gérer <i class="ph ph-arrow-right" aria-hidden="true"></i>
          </button>
        </div>
      </div>
    </div>
  </Transition>
</template>
