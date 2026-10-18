<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/chat/modales/ModaleAPropos.vue — fenêtre « À propos » : nom, logo, version, équipe et moteur de l'instance. -->
<script setup lang="ts">
import { LOGO_ELPIS } from "../../../features/communs/logo";
import { domaineModales } from "../../../features/chat/modales/domaine";

const m = domaineModales();
</script>

<template>
  <Transition name="modal">
    <div
      v-if="m.showInfoModal"
      data-a11y-modal
      role="dialog"
      aria-modal="true"
      aria-label="À propos"
      class="fixed inset-0 z-[6000] flex items-center justify-center bg-slate-900/80 p-4"
      @click.self="m.showInfoModal = false"
    >
      <div class="bg-white rounded-2xl shadow-2xl ring-1 ring-slate-200 w-full max-w-sm overflow-hidden">
        <div class="p-4 flex justify-end">
          <button
            aria-label="Fermer"
            class="w-8 h-8 rounded-lg text-slate-400 hover:bg-slate-100 flex items-center justify-center transition-colors"
            @click="m.showInfoModal = false"
          >
            <i class="ph ph-x"></i>
          </button>
        </div>
        <div class="px-6 pb-8 text-center -mt-2">
          <div class="mx-auto mb-5 flex items-center justify-center">
            <img
              :src="m.appInfo.logoUrl || LOGO_ELPIS"
              :alt="m.appInfo.name"
              class="w-20 h-20 rounded-[20px] object-cover shadow-lg"
            />
          </div>
          <h4 class="font-bold text-xl text-slate-900 tracking-tight">{{ m.appInfo.name }}</h4>
          <p v-if="m.appInfo.description" class="text-sm text-slate-500 mt-1.5 px-2">
            {{ m.appInfo.description }}
          </p>
          <div
            class="mt-2 inline-block px-2.5 py-1 bg-slate-100 text-slate-600 rounded-md text-[11px] font-semibold border border-slate-200"
          >
            v{{ m.appInfo.version }}
          </div>
          <div class="mt-5 bg-slate-50 border border-slate-200 rounded-xl p-4 text-sm text-left space-y-3">
            <div v-if="m.appInfo.teamName" class="flex justify-between items-center">
              <span class="text-slate-500 font-medium text-xs">Équipe</span>
              <span class="font-semibold text-slate-800 text-xs">{{ m.appInfo.teamName }}</span>
            </div>
            <div v-if="m.appInfo.teamName" class="h-px bg-slate-200 w-full"></div>
            <div class="flex justify-between items-center">
              <span class="text-slate-500 font-medium text-xs">Moteur LLM</span>
              <span class="font-bold text-blue-600 text-xs bg-blue-50 px-1.5 py-0.5 rounded">{{
                m.appInfo.engine
              }}</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  </Transition>
</template>
