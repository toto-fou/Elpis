<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/reglages/onglets/OngletMemoire.vue — onglet « memory » des Paramètres. -->
<script setup lang="ts">
import { domaineReglages } from "../../../features/reglages/domaine";

const rg = domaineReglages();
</script>

<template>
  <!-- eslint-disable vue/multiline-html-element-content-newline -->
  <div class="space-y-5 max-w-2xl">
    <div class="flex items-start justify-between gap-3">
      <div>
        <h3 class="text-base font-semibold text-slate-800 mb-1">Mémoire long-terme</h3>
        <p class="text-xs text-slate-500">
          Ce que l'assistant retient de vous entre les conversations. Il la cure lui-même ; « Éditer » corrige
          ou retire ce qu'il a mal retenu.
        </p>
      </div>

      <div class="shrink-0 flex items-center gap-2">
        <template v-if="!rg.memoryEditing">
          <button
            :disabled="rg.userMemoryLoading"
            aria-label="Rafraîchir la mémoire"
            class="px-2.5 py-1.5 bg-white border border-slate-200 hover:bg-slate-50 rounded-md text-xs font-medium text-slate-600 transition-colors inline-flex items-center gap-1.5"
            @click="rg.loadUserMemory()"
          >
            <i
              class="ph ph-arrow-clockwise"
              :class="rg.userMemoryLoading ? 'animate-spin' : ''"
              aria-hidden="true"
            ></i>
            Rafraîchir
          </button>
          <button
            v-if="rg.userMemory"
            data-mem-edit
            aria-label="Éditer la mémoire"
            class="px-2.5 py-1.5 bg-white border border-slate-200 hover:bg-slate-50 rounded-md text-xs font-medium text-slate-600 transition-colors inline-flex items-center gap-1.5"
            @click="rg.startMemoryEdit()"
          >
            <i class="ph ph-pencil-simple" aria-hidden="true"></i> Éditer
          </button>
        </template>
        <template v-else>
          <button
            :disabled="rg.memorySaving"
            data-mem-cancel
            class="px-2.5 py-1.5 bg-white border border-slate-200 hover:bg-slate-50 disabled:opacity-50 rounded-md text-xs font-medium text-slate-600 transition-colors"
            @click="rg.cancelMemoryEdit()"
          >
            Annuler
          </button>
          <button
            :disabled="rg.memorySaving || rg.memoryOverLimit"
            data-mem-save
            class="px-2.5 py-1.5 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 rounded-md text-xs font-medium text-white transition-colors inline-flex items-center gap-1.5"
            @click="rg.saveMemoryEdit()"
          >
            <i
              class="ph"
              :class="rg.memorySaving ? 'ph-spinner-gap animate-spin' : 'ph-check'"
              aria-hidden="true"
            ></i>
            Enregistrer
          </button>
        </template>
      </div>
    </div>

    <div class="bg-slate-50 rounded-xl">
      <label class="set-row cursor-pointer hover:bg-white/60 transition-colors rounded-xl">
        <i class="ph ph-notebook text-slate-400 text-lg w-5"></i>
        <div class="flex-1 min-w-0">
          <div class="text-sm text-slate-800">Activer la mémoire long-terme</div>
          <div class="text-[11px] text-slate-500">
            Désactivée par défaut — rien n'est mémorisé tant qu'elle est éteinte. Une fois activée,
            l'assistant retient des faits durables (profil, préférences, notes).
          </div>
        </div>
        <div class="relative inline-flex items-center shrink-0">
          <input
            v-model="rg.settings.memory_enabled"
            type="checkbox"
            class="sr-only peer"
            @change="rg.persistMemoryEnabled()"
          />
          <div class="set-switch-track peer-checked:bg-blue-600 peer-checked:border-blue-600"></div>
        </div>
      </label>
    </div>

    <div v-if="rg.userMemoryLoading && !rg.userMemory" class="text-center py-8 text-slate-400">
      <i class="ph ph-spinner-gap animate-spin text-xl" aria-hidden="true"></i>
    </div>
    <div v-else-if="rg.userMemoryError" class="text-xs text-amber-600 bg-amber-500/10 rounded-lg px-3 py-2">
      {{ rg.userMemoryError }}
    </div>

    <template v-else-if="rg.userMemory">
      <div>
        <div class="flex items-center justify-between mb-1.5">
          <div class="text-sm font-medium text-slate-700 flex items-center gap-2">
            <i class="ph ph-user-circle text-slate-400" aria-hidden="true"></i> Profil utilisateur
          </div>
          <span
            class="text-[11px] font-mono tabular-nums"
            data-mem-count-user
            :class="rg.memoryOver('user') ? 'text-red-500 font-semibold' : 'text-slate-400'"
            >{{ rg.memoryEditing ? rg.memoryDraftChars("user") : rg.userMemory.user_md.chars }} /
            {{ rg.userMemory.user_md.limit }}</span
          >
        </div>
        <template v-if="!rg.memoryEditing">
          <div
            v-if="rg.userMemory.user_md.entries && rg.userMemory.user_md.entries.length"
            class="space-y-1.5"
          >
            <div
              v-for="(e, i) in rg.userMemory.user_md.entries"
              :key="'u' + i"
              class="bg-slate-50 border border-slate-200 rounded-lg px-3 py-2"
            >
              <div
                class="text-[13px] text-slate-700 leading-relaxed whitespace-pre-wrap break-words"
                data-mem-text
              >
                {{ e }}
              </div>
              <div v-if="rg.memoryOrigin('user', i)" class="mem-origin" data-mem-origin>
                {{ rg.memoryOrigin("user", i)?.date }} ·
                <button
                  v-if="rg.memoryOrigin('user', i)?.canOpen"
                  type="button"
                  class="mem-origin-link"
                  :title="'Ouvrir le chat ' + rg.memoryOrigin('user', i)?.label"
                  @click="rg.openMemoryOrigin('user', i)"
                >
                  {{ rg.memoryOrigin("user", i)?.label }}
                </button>
                <span v-else>{{ rg.memoryOrigin("user", i)?.label }}</span>
              </div>
            </div>
          </div>
          <div v-else class="text-xs text-slate-400 italic px-1 py-1.5">Rien pour l'instant.</div>
        </template>
        <div v-else class="space-y-1.5">
          <div v-for="(e, i) in rg.memoryDraft.user" :key="'du' + i" class="flex items-start gap-1.5">
            <textarea
              v-model="rg.memoryDraft.user[i]"
              rows="2"
              data-mem-entry-user
              aria-label="Entrée de profil"
              class="set-textarea mem-entry-input text-[13px] leading-relaxed"
            ></textarea>
            <button
              aria-label="Supprimer cette entrée"
              class="shrink-0 mt-1 w-7 h-7 flex items-center justify-center bg-white border border-slate-200 hover:bg-red-50 hover:border-red-200 hover:text-red-600 text-slate-500 rounded-md transition-colors"
              @click="rg.removeMemoryEntry('user', i)"
            >
              <i class="ph ph-trash text-xs" aria-hidden="true"></i>
            </button>
          </div>
          <button
            data-mem-add-user
            class="px-2.5 py-1.5 bg-white border border-slate-200 hover:bg-slate-50 rounded-md text-xs font-medium text-slate-600 transition-colors inline-flex items-center gap-1.5"
            @click="rg.addMemoryEntry('user')"
          >
            <i class="ph ph-plus" aria-hidden="true"></i> Ajouter
          </button>
        </div>
      </div>

      <div>
        <div class="flex items-center justify-between mb-1.5">
          <div class="text-sm font-medium text-slate-700 flex items-center gap-2">
            <i class="ph ph-note text-slate-400" aria-hidden="true"></i> Notes
          </div>
          <span
            class="text-[11px] font-mono tabular-nums"
            data-mem-count-memory
            :class="rg.memoryOver('memory') ? 'text-red-500 font-semibold' : 'text-slate-400'"
            >{{ rg.memoryEditing ? rg.memoryDraftChars("memory") : rg.userMemory.memory_md.chars }} /
            {{ rg.userMemory.memory_md.limit }}</span
          >
        </div>
        <template v-if="!rg.memoryEditing">
          <div
            v-if="rg.userMemory.memory_md.entries && rg.userMemory.memory_md.entries.length"
            class="space-y-1.5"
          >
            <div
              v-for="(e, i) in rg.userMemory.memory_md.entries"
              :key="'m' + i"
              class="bg-slate-50 border border-slate-200 rounded-lg px-3 py-2"
            >
              <div
                class="text-[13px] text-slate-700 leading-relaxed whitespace-pre-wrap break-words"
                data-mem-text
              >
                {{ e }}
              </div>
              <div v-if="rg.memoryOrigin('memory', i)" class="mem-origin" data-mem-origin>
                {{ rg.memoryOrigin("memory", i)?.date }} ·
                <button
                  v-if="rg.memoryOrigin('memory', i)?.canOpen"
                  type="button"
                  class="mem-origin-link"
                  :title="'Ouvrir le chat ' + rg.memoryOrigin('memory', i)?.label"
                  @click="rg.openMemoryOrigin('memory', i)"
                >
                  {{ rg.memoryOrigin("memory", i)?.label }}
                </button>
                <span v-else>{{ rg.memoryOrigin("memory", i)?.label }}</span>
              </div>
            </div>
          </div>
          <div v-else class="text-xs text-slate-400 italic px-1 py-1.5">Rien pour l'instant.</div>
        </template>
        <div v-else class="space-y-1.5">
          <div v-for="(e, i) in rg.memoryDraft.memory" :key="'dm' + i" class="flex items-start gap-1.5">
            <textarea
              v-model="rg.memoryDraft.memory[i]"
              rows="2"
              data-mem-entry-memory
              aria-label="Entrée de notes"
              class="set-textarea mem-entry-input text-[13px] leading-relaxed"
            ></textarea>
            <button
              aria-label="Supprimer cette entrée"
              class="shrink-0 mt-1 w-7 h-7 flex items-center justify-center bg-white border border-slate-200 hover:bg-red-50 hover:border-red-200 hover:text-red-600 text-slate-500 rounded-md transition-colors"
              @click="rg.removeMemoryEntry('memory', i)"
            >
              <i class="ph ph-trash text-xs" aria-hidden="true"></i>
            </button>
          </div>
          <button
            data-mem-add-memory
            class="px-2.5 py-1.5 bg-white border border-slate-200 hover:bg-slate-50 rounded-md text-xs font-medium text-slate-600 transition-colors inline-flex items-center gap-1.5"
            @click="rg.addMemoryEntry('memory')"
          >
            <i class="ph ph-plus" aria-hidden="true"></i> Ajouter
          </button>
        </div>
      </div>

      <div
        v-if="rg.memorySaveError"
        role="alert"
        data-mem-error
        class="text-xs text-red-600 bg-red-500/10 rounded-lg px-3 py-2"
      >
        {{ rg.memorySaveError }}
      </div>

      <div
        v-if="
          !rg.memoryEditing &&
          (rg.userMemory.user_md.chars ||
            rg.userMemory.memory_md.chars ||
            (rg.userMemory.scopes && rg.userMemory.scopes.length))
        "
        class="border-t border-slate-200 pt-4 flex items-start justify-between gap-3"
      >
        <div class="min-w-0">
          <div class="text-sm font-medium text-slate-700">Effacer la mémoire</div>
          <div class="text-[11px] text-slate-500">
            Supprime définitivement tout ce que l'assistant a retenu (profil, notes, scopes). Irréversible.
          </div>
        </div>
        <button
          :disabled="rg.userMemoryDeleting"
          class="shrink-0 px-2.5 py-1.5 bg-white border border-red-200 text-red-600 hover:bg-red-50 disabled:opacity-50 rounded-md text-xs font-medium transition-colors inline-flex items-center gap-1.5"
          @click="rg.deleteUserMemory()"
        >
          <i
            class="ph"
            :class="rg.userMemoryDeleting ? 'ph-spinner-gap animate-spin' : 'ph-trash'"
            aria-hidden="true"
          ></i>
          Effacer tout
        </button>
      </div>
    </template>
  </div>
</template>
