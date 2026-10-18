<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/chat/modales/ModaleAide.vue — documentation intégrée (guide utilisateur ou développeur) rendue en Markdown purifié. -->
<script setup lang="ts">
import { domaineModales } from "../../../features/chat/modales/domaine";

const m = domaineModales();
</script>

<!-- eslint-disable vue/no-v-html -- HTML produit par le moteur Markdown : purifié (crochet de marked) ou échappé. -->

<template>
  <Transition name="modal">
    <div
      v-if="m.showHelpModal"
      data-a11y-modal
      role="dialog"
      aria-modal="true"
      aria-label="Documentation"
      class="fixed inset-0 z-[6000] flex items-center justify-center bg-slate-900/80 p-4"
      @click.self="m.showHelpModal = false"
    >
      <div
        class="bg-slate-50 rounded-2xl shadow-2xl ring-1 ring-slate-200 w-full max-w-5xl max-h-[90vh] overflow-hidden flex flex-col"
      >
        <div class="p-5 border-b border-slate-200 flex justify-between items-center gap-3 bg-white shrink-0">
          <h2 class="text-lg font-bold text-slate-800 flex items-center gap-2 min-w-0">
            <div
              class="w-8 h-8 rounded-lg bg-blue-50 flex items-center justify-center text-blue-600 shrink-0"
            >
              <i class="ph ph-book-open text-lg"></i>
            </div>
            <span class="truncate">Documentation</span>
          </h2>
          <div class="flex items-center gap-3 shrink-0">
            <!-- Bascule guide utilisateur / doc développeur -->
            <div
              class="flex items-center gap-1 bg-slate-100 rounded-lg p-1"
              role="tablist"
              aria-label="Type de documentation"
            >
              <button
                role="tab"
                :aria-selected="m.helpDoc === 'user' ? 'true' : 'false'"
                :class="
                  m.helpDoc === 'user'
                    ? 'bg-white text-blue-600 shadow-sm'
                    : 'text-slate-500 hover:text-slate-700'
                "
                class="px-3 py-1.5 rounded-md text-sm font-medium transition-colors flex items-center gap-1.5"
                @click="m.switchHelpDoc('user')"
              >
                <i class="ph ph-book-open"></i> Utilisateur
              </button>
              <button
                role="tab"
                :aria-selected="m.helpDoc === 'dev' ? 'true' : 'false'"
                :class="
                  m.helpDoc === 'dev'
                    ? 'bg-white text-blue-600 shadow-sm'
                    : 'text-slate-500 hover:text-slate-700'
                "
                class="px-3 py-1.5 rounded-md text-sm font-medium transition-colors flex items-center gap-1.5"
                @click="m.switchHelpDoc('dev')"
              >
                <i class="ph ph-code"></i> Développeur
              </button>
            </div>
            <button
              aria-label="Fermer"
              class="w-8 h-8 rounded-lg hover:bg-slate-100 text-slate-500 transition-colors flex items-center justify-center"
              @click="m.showHelpModal = false"
            >
              <i class="ph ph-x text-lg"></i>
            </button>
          </div>
        </div>
        <div
          :ref="(el) => (m.helpBodyRef = el)"
          class="flex-1 overflow-y-auto p-6 md:p-10 bg-white custom-scrollbar relative"
        >
          <div
            v-if="m.isLoadingReadme"
            class="absolute inset-0 flex flex-col items-center justify-center bg-white z-10 text-slate-400"
          >
            <i class="ph ph-spinner-gap animate-spin text-4xl mb-3"></i>
            <p class="font-medium text-sm">Chargement...</p>
          </div>
          <div
            class="markdown-body max-w-4xl mx-auto"
            @click="m.handleMarkdownClick"
            v-html="m.renderMarkdown(m.readmeContent)"
          ></div>
        </div>
      </div>
    </div>
  </Transition>
</template>
