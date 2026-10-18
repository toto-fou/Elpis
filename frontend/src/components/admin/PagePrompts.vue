<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/admin/PagePrompts.vue — page Prompts système. -->
<script setup lang="ts">
import { domaineAdmin } from "../../features/admin/domaine";

const adm = domaineAdmin();
</script>

<template>
  <div v-if="adm.adminTab === 'prompts'" class="animate-[fadeIn_0.2s]">
    <div class="grid grid-cols-12 gap-4">
      <div class="col-span-12 lg:col-span-4 space-y-3">
        <div
          v-for="grp in adm.promptsGrouped"
          :key="grp.id"
          class="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden"
        >
          <button
            type="button"
            class="w-full flex items-center gap-2 px-3 py-2.5 text-left hover:bg-slate-50 transition-colors"
            @click="adm.togglePromptGroup(grp.id)"
          >
            <i class="ph text-base text-blue-500" :class="grp.icon"></i>
            <span class="font-semibold text-sm text-slate-700 flex-1">{{ grp.label }}</span>
            <span class="text-[10px] text-slate-400 bg-slate-100 rounded-full px-2 py-0.5">{{
              grp.items.length
            }}</span>
            <i
              class="ph text-slate-400 transition-transform"
              :class="adm.isPromptGroupCollapsed(grp.id) ? 'ph-caret-right' : 'ph-caret-down'"
            ></i>
          </button>
          <div v-show="!adm.isPromptGroupCollapsed(grp.id)" class="px-2 pb-2 space-y-1">
            <button
              v-for="item in grp.items"
              :key="item.category"
              :class="
                adm.promptsSelected === item.category
                  ? 'bg-blue-50 border-blue-300 ring-1 ring-blue-200'
                  : 'border-transparent hover:bg-slate-50'
              "
              class="w-full text-left px-2.5 py-2 rounded-lg border transition-colors flex items-start gap-2.5"
              @click="adm.selectPrompt(item.category)"
            >
              <i
                class="ph text-lg shrink-0 mt-0.5"
                :class="[
                  adm.promptMeta(item.category).icon,
                  adm.promptsSelected === item.category ? 'text-blue-600' : 'text-slate-400',
                ]"
              ></i>
              <span class="min-w-0 flex-1">
                <span class="block text-sm font-medium text-slate-800 truncate">{{
                  adm.promptMeta(item.category).label
                }}</span>
                <span class="block text-[10px] text-slate-400 font-mono truncate"
                  >{{ item.category }}.md · {{ adm.fmtBytes(item.size_chars) }}</span
                >
              </span>
            </button>
          </div>
        </div>
        <div
          v-if="!adm.promptsGrouped.length"
          class="bg-white rounded-2xl border border-slate-200 p-8 text-center text-sm text-slate-400"
        >
          Aucun prompt trouvé.
        </div>
      </div>

      <div class="col-span-12 lg:col-span-8 space-y-4">
        <div
          v-if="!adm.promptsSelected"
          class="bg-white rounded-2xl border border-slate-200 p-12 text-center text-slate-400"
        >
          <i class="ph ph-arrow-left text-3xl mb-2 block opacity-40"></i>
          Sélectionnez un prompt à gauche pour l'éditer.
        </div>

        <template v-else>
          <div class="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
            <div class="px-4 py-3 border-b border-slate-200 flex items-center justify-between gap-4">
              <div class="min-w-0">
                <div class="flex items-center gap-2">
                  <i class="ph text-blue-500" :class="adm.promptMeta(adm.promptsSelected).icon"></i>
                  <span class="font-bold text-sm text-slate-800 truncate">{{
                    adm.promptMeta(adm.promptsSelected).label
                  }}</span>
                  <span
                    v-if="adm.promptsEditorDirty"
                    class="text-[10px] font-bold text-amber-600 px-1.5 py-0.5 bg-amber-50 rounded"
                    >non sauvegardé</span
                  >
                </div>
                <code class="text-[10px] text-slate-400"
                  >{{ adm.promptsSelected }}.md · {{ (adm.promptsEditorText || "").length }} caractères</code
                >
              </div>
              <div class="flex items-center gap-2 shrink-0">
                <button
                  type="button"
                  :disabled="!adm.promptsEditorDirty"
                  title="Recharger depuis le serveur (annule les modifications)"
                  aria-label="Annuler les modifications"
                  class="adm-btn adm-btn--icon"
                  @click="adm.reloadPrompt()"
                >
                  <i class="ph ph-arrow-counter-clockwise" aria-hidden="true"></i>
                </button>
                <button
                  :disabled="!adm.promptsEditorDirty || adm.promptsLoading"
                  type="button"
                  class="adm-btn adm-tool adm-btn--sm"
                  @click="adm.savePrompt()"
                >
                  <i class="ph ph-floppy-disk" aria-hidden="true"></i> Enregistrer
                </button>
              </div>
            </div>
            <textarea
              v-model="adm.promptsEditorText"
              spellcheck="false"
              class="w-full px-4 py-3 font-mono text-[11px] leading-relaxed text-slate-700 bg-slate-50 outline-none resize-none custom-scrollbar"
              style="min-height: 420px"
              @input="adm.promptsEditorDirty = true"
            ></textarea>
          </div>

          <div
            v-if="adm.promptMeta(adm.promptsSelected).usage"
            class="bg-blue-50/50 border border-blue-100 rounded-2xl p-4 flex items-start gap-3"
          >
            <i class="ph ph-info text-blue-500 text-lg mt-0.5"></i>
            <div>
              <div class="text-xs font-semibold text-slate-500 mb-0.5">Où ce prompt est utilisé</div>
              <p class="text-sm text-slate-600">{{ adm.promptMeta(adm.promptsSelected).usage }}</p>
              <p class="text-[11px] text-slate-400 mt-1">
                Modifications prises en compte au prochain appel (cache mtime, pas de redémarrage requis).
              </p>
            </div>
          </div>
        </template>
      </div>
    </div>
  </div>
</template>
