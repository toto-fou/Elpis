<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/reglages/ModaleReglages.vue — gabarit migré de includes/modals/settings.html. -->
<script setup lang="ts">
import { domaineReglages } from "../../features/reglages/domaine";
import RecadrageImage from "../communs/RecadrageImage.vue";
import OngletSkills from "../skills/OngletSkills.vue";
import CaseLectureSeuleAgent from "./CaseLectureSeuleAgent.vue";

const rg = domaineReglages();
</script>

<template>
  <!-- eslint-disable vue/multiline-html-element-content-newline -->
  <Transition name="modal">
    <div
      v-if="rg.showSettingsModal"
      data-a11y-modal
      role="dialog"
      aria-modal="true"
      aria-label="Paramètres"
      class="fixed inset-0 z-[5000] flex items-center justify-center bg-slate-900/80 p-4"
      @click.self="rg.closeSettings()"
    >
      <div
        :ref="
          (el) => {
            rg.settingsDialogEl = el as typeof rg.settingsDialogEl;
          }
        "
        tabindex="-1"
        class="bg-white rounded-2xl shadow-2xl ring-1 ring-slate-200 w-full max-w-4xl overflow-hidden flex flex-col h-[85vh] max-h-[780px] focus:outline-none"
      >
        <div class="px-5 py-4 border-b border-slate-100 flex justify-between items-center shrink-0">
          <h2 class="text-base font-semibold text-slate-800 flex items-center gap-2.5">
            <div class="w-7 h-7 rounded-lg bg-slate-100 flex items-center justify-center text-slate-600">
              <i class="ph ph-sliders text-base"></i>
            </div>
            Paramètres
          </h2>
          <button
            aria-label="Fermer les paramètres"
            class="w-8 h-8 rounded-lg hover:bg-slate-100 text-slate-500 hover:text-slate-700 transition-colors flex items-center justify-center"
            @click="rg.closeSettings()"
          >
            <i class="ph ph-x text-lg" aria-hidden="true"></i>
          </button>
        </div>

        <div class="flex flex-1 min-h-0 overflow-hidden">
          <aside
            class="w-52 shrink-0 bg-slate-50 border-r border-slate-200 overflow-y-auto custom-scrollbar p-3"
          >
            <div class="text-[11px] font-semibold text-slate-500 px-2.5 mb-1.5 mt-1">Compte</div>
            <button
              :class="
                rg.settingsTab === 'profile'
                  ? 'bg-white text-blue-600 shadow-sm font-medium'
                  : 'text-slate-600 hover:bg-white/60 hover:text-slate-800'
              "
              class="w-full flex items-center gap-2.5 px-2.5 py-1.5 rounded-md text-sm transition-colors mb-0.5"
              @click="rg.settingsTab = 'profile'"
            >
              <i
                class="ph text-base"
                :class="rg.settingsTab === 'profile' ? 'ph-user-circle' : 'ph-user'"
              ></i>
              Profil
            </button>
            <button
              :class="
                rg.settingsTab === 'chat'
                  ? 'bg-white text-blue-600 shadow-sm font-medium'
                  : 'text-slate-600 hover:bg-white/60 hover:text-slate-800'
              "
              class="w-full flex items-center gap-2.5 px-2.5 py-1.5 rounded-md text-sm transition-colors mb-0.5"
              @click="rg.settingsTab = 'chat'"
            >
              <i class="ph ph-chat-circle text-base"></i> Chat
            </button>
            <button
              :class="
                rg.settingsTab === 'compaction'
                  ? 'bg-white text-blue-600 shadow-sm font-medium'
                  : 'text-slate-600 hover:bg-white/60 hover:text-slate-800'
              "
              class="w-full flex items-center gap-2.5 px-2.5 py-1.5 rounded-md text-sm transition-colors mb-0.5"
              @click="rg.settingsTab = 'compaction'"
            >
              <i class="ph ph-arrows-in-line-horizontal text-base"></i> Compaction
            </button>
            <button
              :class="
                rg.settingsTab === 'ai_models'
                  ? 'bg-white text-blue-600 shadow-sm font-medium'
                  : 'text-slate-600 hover:bg-white/60 hover:text-slate-800'
              "
              class="w-full flex items-center gap-2.5 px-2.5 py-1.5 rounded-md text-sm transition-colors mb-0.5"
              @click="
                rg.settingsTab = 'ai_models';
                rg.loadLlmConnectors();
              "
            >
              <i class="ph ph-sparkle text-base"></i> Modèles IA
            </button>
            <button
              :class="
                rg.settingsTab === 'appearance'
                  ? 'bg-white text-blue-600 shadow-sm font-medium'
                  : 'text-slate-600 hover:bg-white/60 hover:text-slate-800'
              "
              class="w-full flex items-center gap-2.5 px-2.5 py-1.5 rounded-md text-sm transition-colors mb-0.5"
              @click="rg.settingsTab = 'appearance'"
            >
              <i class="ph ph-palette text-base"></i> Apparence
            </button>
            <button
              :class="
                rg.settingsTab === 'features'
                  ? 'bg-white text-blue-600 shadow-sm font-medium'
                  : 'text-slate-600 hover:bg-white/60 hover:text-slate-800'
              "
              class="w-full flex items-center gap-2.5 px-2.5 py-1.5 rounded-md text-sm transition-colors mb-0.5"
              @click="rg.settingsTab = 'features'"
            >
              <i class="ph ph-toggle-right text-base"></i> Fonctionnalités
            </button>
            <button
              :class="
                rg.settingsTab === 'usage'
                  ? 'bg-white text-blue-600 shadow-sm font-medium'
                  : 'text-slate-600 hover:bg-white/60 hover:text-slate-800'
              "
              class="w-full flex items-center gap-2.5 px-2.5 py-1.5 rounded-md text-sm transition-colors mb-0.5"
              @click="
                rg.settingsTab = 'usage';
                rg.loadUsageData();
              "
            >
              <i class="ph ph-chart-line text-base"></i> Utilisation
            </button>
            <button
              :class="
                rg.settingsTab === 'connexions'
                  ? 'bg-white text-blue-600 shadow-sm font-medium'
                  : 'text-slate-600 hover:bg-white/60 hover:text-slate-800'
              "
              class="w-full flex items-center gap-2.5 px-2.5 py-1.5 rounded-md text-sm transition-colors mb-0.5"
              @click="
                rg.settingsTab = 'connexions';
                rg.loadConnexions();
              "
            >
              <i class="ph ph-key text-base"></i> Connexions
            </button>

            <div class="text-[11px] font-semibold text-slate-500 px-2.5 mt-4 mb-1.5">Données</div>
            <button
              :class="
                rg.settingsTab === 'memory'
                  ? 'bg-white text-blue-600 shadow-sm font-medium'
                  : 'text-slate-600 hover:bg-white/60 hover:text-slate-800'
              "
              class="w-full flex items-center gap-2.5 px-2.5 py-1.5 rounded-md text-sm transition-colors mb-0.5"
              @click="
                rg.settingsTab = 'memory';
                rg.loadUserMemory();
              "
            >
              <i class="ph ph-brain text-base"></i> Mémoire
            </button>
            <button
              :class="
                rg.settingsTab === 'agents'
                  ? 'bg-white text-blue-600 shadow-sm font-medium'
                  : 'text-slate-600 hover:bg-white/60 hover:text-slate-800'
              "
              class="w-full flex items-center gap-2.5 px-2.5 py-1.5 rounded-md text-sm transition-colors mb-0.5"
              @click="
                rg.settingsTab = 'agents';
                rg.loadMcpUserCategories();
                rg.loadAgentTemplates();
              "
            >
              <i class="ph ph-users-three text-base"></i> Agents
            </button>
            <button
              :class="
                rg.settingsTab === 'prompts'
                  ? 'bg-white text-blue-600 shadow-sm font-medium'
                  : 'text-slate-600 hover:bg-white/60 hover:text-slate-800'
              "
              class="w-full flex items-center gap-2.5 px-2.5 py-1.5 rounded-md text-sm transition-colors mb-0.5"
              @click="
                rg.settingsTab = 'prompts';
                rg.loadSavedPrompts();
                rg.loadPromptTemplates();
              "
            >
              <i class="ph ph-bookmarks-simple text-base"></i> Prompts
            </button>
            <button
              :class="
                rg.settingsTab === 'skills'
                  ? 'bg-white text-blue-600 shadow-sm font-medium'
                  : 'text-slate-600 hover:bg-white/60 hover:text-slate-800'
              "
              class="w-full flex items-center gap-2.5 px-2.5 py-1.5 rounded-md text-sm transition-colors mb-0.5"
              @click="
                rg.settingsTab = 'skills';
                rg.openSkillsTab();
              "
            >
              <i class="ph ph-graduation-cap text-base"></i> Skills
            </button>
            <button
              :class="
                rg.settingsTab === 'archives'
                  ? 'bg-white text-blue-600 shadow-sm font-medium'
                  : 'text-slate-600 hover:bg-white/60 hover:text-slate-800'
              "
              class="w-full flex items-center gap-2.5 px-2.5 py-1.5 rounded-md text-sm transition-colors mb-0.5"
              @click="
                rg.settingsTab = 'archives';
                rg.loadArchives && rg.loadArchives();
              "
            >
              <i class="ph ph-archive text-base"></i> Archives
            </button>
            <button
              :class="
                rg.settingsTab === 'sandbox'
                  ? 'bg-white text-blue-600 shadow-sm font-medium'
                  : 'text-slate-600 hover:bg-white/60 hover:text-slate-800'
              "
              class="w-full flex items-center gap-2.5 px-2.5 py-1.5 rounded-md text-sm transition-colors mb-0.5"
              @click="
                rg.settingsTab = 'sandbox';
                rg.loadSandboxState();
              "
            >
              <i class="ph ph-cube text-base"></i> Sandbox
            </button>
            <button
              :class="
                rg.settingsTab === 'connectors'
                  ? 'bg-white text-blue-600 shadow-sm font-medium'
                  : 'text-slate-600 hover:bg-white/60 hover:text-slate-800'
              "
              class="w-full flex items-center gap-2.5 px-2.5 py-1.5 rounded-md text-sm transition-colors mb-0.5"
              @click="
                rg.settingsTab = 'connectors';
                rg.loadGitConnectors();
              "
            >
              <i class="ph ph-git-fork text-base"></i> Connecteurs
            </button>
          </aside>

          <div
            class="flex-1 min-h-0 bg-white"
            :class="
              rg.settingsTab === 'skills'
                ? 'overflow-hidden flex flex-col'
                : 'overflow-y-auto custom-scrollbar p-6'
            "
          >
            <OngletSkills />

            <div v-if="rg.settingsTab === 'memory'" class="space-y-5 max-w-2xl">
              <div class="flex items-start justify-between gap-3">
                <div>
                  <h3 class="text-base font-semibold text-slate-800 mb-1">Mémoire long-terme</h3>
                  <p class="text-xs text-slate-500">
                    Ce que l'assistant retient de vous entre les conversations. Il la cure lui-même ; « Éditer
                    » corrige ou retire ce qu'il a mal retenu.
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
              <div
                v-else-if="rg.userMemoryError"
                class="text-xs text-amber-600 bg-amber-500/10 rounded-lg px-3 py-2"
              >
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
                    <div
                      v-for="(e, i) in rg.memoryDraft.user"
                      :key="'du' + i"
                      class="flex items-start gap-1.5"
                    >
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
                      >{{
                        rg.memoryEditing ? rg.memoryDraftChars("memory") : rg.userMemory.memory_md.chars
                      }}
                      / {{ rg.userMemory.memory_md.limit }}</span
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
                    <div
                      v-for="(e, i) in rg.memoryDraft.memory"
                      :key="'dm' + i"
                      class="flex items-start gap-1.5"
                    >
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
                      Supprime définitivement tout ce que l'assistant a retenu (profil, notes, scopes).
                      Irréversible.
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

            <div v-if="rg.settingsTab === 'agents'" class="space-y-5 max-w-2xl">
              <div>
                <h3 class="text-base font-semibold text-slate-800 mb-1">Agents</h3>
                <p class="text-xs text-slate-500">
                  Sous-missions déléguées à des agents éphémères via l'outil
                  <span class="font-mono">task</span>, et agents personnalisés façon OpenCode.
                </p>
              </div>

              <p
                v-if="!rg.features.agents"
                class="text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2"
              >
                Sous-agents désactivés sur cette instance (réglage administrateur).
              </p>
              <div class="bg-slate-50 rounded-xl">
                <label class="set-row cursor-pointer hover:bg-white/60 transition-colors rounded-xl">
                  <i class="ph ph-users-three text-slate-400 text-lg w-5"></i>
                  <div class="flex-1 min-w-0">
                    <div class="text-sm text-slate-800">Activer les sous-agents</div>
                    <div class="text-[11px] text-slate-500">
                      Désactivés par défaut. Une fois activés, l'assistant peut déléguer une sous-mission
                      (explorer, implémenter, vérifier, chercher sur le web, ouvrir une PR) à un agent isolé
                      via l'outil task.
                    </div>
                  </div>
                  <div class="relative inline-flex items-center shrink-0">
                    <input
                      v-model="rg.settings.agents_enabled"
                      type="checkbox"
                      class="sr-only peer"
                      @change="rg.persistAgentsEnabled()"
                    />
                    <div class="set-switch-track peer-checked:bg-blue-600 peer-checked:border-blue-600"></div>
                  </div>
                </label>
              </div>

              <p
                v-if="
                  rg.settings.agents_enabled && rg.agentBank.length && !rg.agentBank.some((a) => a.enabled)
                "
                class="text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2"
                data-agents-none-active
              >
                Aucun agent actif : outil task indisponible.
              </p>

              <div>
                <div class="flex items-center justify-between mb-1.5">
                  <div class="text-sm font-medium text-slate-700 flex items-center gap-2">
                    <i class="ph ph-users-three text-slate-400" aria-hidden="true"></i> Banque d'agents
                  </div>
                  <span
                    class="text-[11px] text-slate-400 font-mono"
                    title="Agents personnalisés (les modèles ne comptent pas)"
                    >{{ rg.agentCustomCount }} / {{ rg.CUSTOM_AGENTS_MAX }}</span
                  >
                </div>
                <p id="agents-lecture-seule-aide" class="text-[11px] text-slate-500 mb-2">
                  Lecture seule : l'agent n'écrit aucun fichier, ne fait aucun commit et ne lance ni tâche de
                  fond ni shell ; il garde la lecture.
                </p>
                <div class="space-y-2" data-agent-bank>
                  <div
                    v-for="a in rg.agentBank"
                    :key="a.name"
                    class="border border-slate-200 rounded-xl p-3.5"
                    :class="{ 'opacity-60': !a.enabled }"
                    :data-agent-row="a.name"
                  >
                    <div class="flex items-center gap-3">
                      <img
                        v-if="a.icon === 'ph-robot'"
                        :src="rg.logoApp"
                        alt=""
                        data-logo-sous-agent
                        class="w-5 h-5 rounded-full object-cover shrink-0"
                      />
                      <i
                        v-else
                        class="ph text-lg text-slate-400 shrink-0"
                        :class="a.icon"
                        aria-hidden="true"
                      ></i>
                      <div class="flex-1 min-w-0">
                        <div class="flex items-center gap-2 min-w-0">
                          <span class="text-sm font-mono font-medium text-slate-800 truncate">{{
                            a.name
                          }}</span>
                          <span
                            v-if="a.template"
                            class="text-[10px] font-medium px-1.5 py-0.5 rounded shrink-0"
                            :class="a.modified ? 'bg-blue-50 text-blue-700' : 'bg-slate-100 text-slate-500'"
                            :title="a.modified ? 'Modèle livré, personnalisé' : 'Modèle livré'"
                            data-agent-badge
                            >{{ a.modified ? "modifié" : "modèle" }}</span
                          >
                        </div>
                        <div class="text-[11px] text-slate-500 truncate">{{ a.description }}</div>
                      </div>
                      <div class="flex items-center gap-1 shrink-0 max-w-[38%] overflow-hidden">
                        <span
                          v-for="cat in a.tool_categories"
                          :key="cat"
                          class="text-[10.5px] px-1.5 py-0.5 rounded bg-slate-100 text-slate-600 whitespace-nowrap"
                          >{{
                            ((rg.mcpUserCategories || []).find((c) => c.name === cat) || {}).label || cat
                          }}</span
                        >
                        <span
                          v-for="sid in a.mcp_server_ids"
                          :key="sid"
                          class="text-[10.5px] px-1.5 py-0.5 rounded bg-slate-100 text-slate-600 whitespace-nowrap inline-flex items-center gap-1"
                          ><i class="ph ph-plug text-[10px]" aria-hidden="true"></i
                          >{{
                            ((rg.agentMcpChoices || []).find((s) => s.id === sid) || {}).name || sid
                          }}</span
                        >
                      </div>

                      <label
                        class="relative inline-flex items-center shrink-0 cursor-pointer"
                        :title="a.enabled ? 'Actif' : 'Désactivé — absent du roster'"
                      >
                        <input
                          type="checkbox"
                          :checked="a.enabled"
                          class="sr-only peer"
                          :aria-label="'Activer ' + a.name"
                          :data-agent-enabled="a.name"
                          @change="rg.toggleAgentEnabled(a)"
                        />
                        <span
                          class="set-switch-track block peer-checked:bg-blue-600 peer-checked:border-blue-600"
                        ></span>
                      </label>
                      <button
                        title="Modifier"
                        :aria-label="'Modifier ' + a.name"
                        :data-agent-edit="a.name"
                        class="w-7 h-7 rounded-md text-slate-500 hover:bg-slate-100 hover:text-slate-700 flex items-center justify-center shrink-0"
                        @click="rg.startEditAgent(a)"
                      >
                        <i class="ph ph-pencil-simple" aria-hidden="true"></i>
                      </button>
                      <button
                        title="Dupliquer"
                        :aria-label="'Dupliquer ' + a.name"
                        :data-agent-dup="a.name"
                        class="w-7 h-7 rounded-md text-slate-500 hover:bg-slate-100 hover:text-slate-700 flex items-center justify-center shrink-0"
                        @click="rg.duplicateAgent(a)"
                      >
                        <i class="ph ph-copy" aria-hidden="true"></i>
                      </button>
                      <button
                        v-if="a.template && a.modified"
                        title="Réinitialiser"
                        :aria-label="'Réinitialiser ' + a.name"
                        :data-agent-reset="a.name"
                        class="w-7 h-7 rounded-md text-slate-500 hover:bg-slate-100 hover:text-slate-700 flex items-center justify-center shrink-0"
                        @click="rg.resetAgentToTemplate(a)"
                      >
                        <i class="ph ph-arrow-counter-clockwise" aria-hidden="true"></i>
                      </button>
                      <button
                        v-if="!a.template"
                        title="Supprimer"
                        aria-label="Supprimer l'agent"
                        class="w-7 h-7 rounded-md text-slate-500 hover:bg-red-50 hover:text-red-600 flex items-center justify-center shrink-0"
                        @click="rg.deleteCustomAgent(a)"
                      >
                        <i class="ph ph-trash" aria-hidden="true"></i>
                      </button>
                    </div>
                    <CaseLectureSeuleAgent
                      :agent="a"
                      aide="agents-lecture-seule-aide"
                      @basculer="rg.toggleAgentReadOnly(a)"
                    />
                  </div>
                </div>
                <p
                  v-if="!rg.agentBank.length && !rg.agentForm"
                  class="text-sm text-slate-500 py-3 text-center"
                >
                  Aucun agent.
                </p>
              </div>

              <div
                v-if="rg.agentForm"
                class="border border-blue-200 bg-blue-50/40 rounded-xl p-4 space-y-2.5"
              >
                <div class="text-sm font-medium text-slate-700">
                  {{
                    rg.agentForm._template
                      ? "Modifier le modèle"
                      : rg.agentForm._idx >= 0
                        ? "Modifier l'agent"
                        : "Nouvel agent"
                  }}
                </div>
                <div>
                  <label class="text-[11px] font-medium text-slate-500">Nom</label>

                  <div
                    v-if="rg.agentForm._template"
                    class="set-input font-mono mt-0.5 bg-slate-50 text-slate-600 select-all"
                    data-agent-name-locked
                  >
                    {{ rg.agentForm.name }}
                  </div>
                  <input
                    v-else
                    v-model="rg.agentForm.name"
                    placeholder="docs-writer"
                    class="set-input font-mono mt-0.5"
                  />
                  <p class="text-[10.5px] text-slate-500 mt-1">
                    {{
                      rg.agentForm._template
                        ? "Modèle livré — dupliquez-le pour une variante sous un autre nom."
                        : "1-32 caractères : a-z, 0-9, tirets. C'est la valeur que le modèle passe à l'outil task."
                    }}
                  </p>
                </div>
                <div>
                  <label class="text-[11px] font-medium text-slate-500">Description</label>
                  <input
                    v-model="rg.agentForm.description"
                    maxlength="200"
                    :placeholder="
                      rg.agentForm._template
                        ? rg.agentForm._tplSummary || 'description du modèle'
                        : 'rédige la documentation du dépôt'
                    "
                    class="set-input mt-0.5"
                  />
                  <p class="text-[10.5px] text-slate-500 mt-1">
                    Une ligne — sert au modèle pour choisir cet agent.
                  </p>
                </div>
                <div>
                  <div class="flex items-center justify-between gap-2">
                    <label class="text-[11px] font-medium text-slate-500">Prompt système</label>
                    <button
                      v-if="rg.agentFormPromptDiffers"
                      data-agent-prompt-restore
                      title="Rendre la persona livrée avec ce modèle"
                      class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg border border-slate-200 bg-white text-slate-600 hover:bg-slate-50 text-[11px] font-semibold transition-colors"
                      @click="rg.restoreTemplatePrompt()"
                    >
                      <i class="ph ph-arrow-counter-clockwise text-[13px]" aria-hidden="true"></i> Prompt
                      livré
                    </button>
                    <button
                      v-else-if="!(rg.agentForm.prompt || '').trim()"
                      title="Insère la structure des agents intégrés : rôle, objectif, guidage outil, méthode, effort, contraintes, rapport, exemples"
                      class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg border border-blue-200 bg-blue-50 text-blue-700 hover:bg-blue-100 hover:border-blue-300 text-[11px] font-semibold transition-colors"
                      @click="rg.insertAgentTemplate()"
                    >
                      <i class="ph ph-file-text text-[13px]" aria-hidden="true"></i> Gabarit
                    </button>
                  </div>
                  <textarea
                    v-model="rg.agentForm.prompt"
                    rows="10"
                    placeholder="Tu es un spécialiste de… — bouton Gabarit pour la structure recommandée"
                    class="set-textarea font-mono mt-0.5 w-full"
                  ></textarea>
                  <p class="text-[10.5px] text-slate-500 mt-1">
                    {{
                      rg.agentForm._template
                        ? "Identique au livré = l'agent suit les mises à jour du modèle."
                        : "Remplace le prompt de base pour cet agent."
                    }}
                  </p>
                </div>

                <div>
                  <label class="text-[11px] font-medium text-slate-500">Outils locaux</label>
                  <div
                    v-if="(rg.mcpUserCategories || []).length === 0"
                    class="text-[11px] text-slate-400 italic mt-1"
                  >
                    Aucune catégorie d'outils disponible.
                  </div>
                  <div v-else class="grid grid-cols-2 gap-x-2 gap-y-0.5 mt-1">
                    <label
                      v-for="cat in rg.mcpUserCategories"
                      :key="cat.name"
                      class="flex items-center justify-between gap-2 cursor-pointer p-1.5 hover:bg-slate-50 rounded-lg transition-colors"
                    >
                      <span class="text-xs font-semibold text-slate-700 flex items-center gap-2.5 min-w-0">
                        <span
                          class="w-6 h-6 rounded flex items-center justify-center shrink-0"
                          :class="rg.mcpCategoryBgClass(cat)"
                        >
                          <i class="ph text-sm" :class="cat.icon || 'ph-package'" aria-hidden="true"></i>
                        </span>
                        <span class="truncate">{{ cat.label || cat.name }}</span>
                      </span>
                      <span class="relative inline-flex items-center shrink-0">
                        <input
                          type="checkbox"
                          :checked="rg.agentForm.tool_categories.includes(cat.name)"
                          class="sr-only peer"
                          @change="rg.toggleAgentCat(cat.name)"
                        />
                        <span
                          class="set-switch-track block peer-checked:bg-blue-600 peer-checked:border-blue-600"
                        ></span>
                      </span>
                    </label>
                  </div>
                  <p class="text-[10.5px] text-slate-500 mt-1">
                    {{
                      rg.agentForm._template
                        ? "Catégories entières. Aucune sélection = celles du modèle."
                        : "Catégories entières. Aucune sélection = socle par défaut : Fichiers, Terminal, Git."
                    }}
                  </p>
                </div>
                <div v-if="(rg.agentMcpChoices || []).length">
                  <label class="text-[11px] font-medium text-slate-500">Serveurs MCP</label>
                  <div class="grid grid-cols-2 gap-x-2 gap-y-0.5 mt-1">
                    <label
                      v-for="srv in rg.agentMcpChoices"
                      :key="srv.id"
                      class="flex items-center justify-between gap-2 cursor-pointer p-1.5 hover:bg-slate-50 rounded-lg transition-colors"
                    >
                      <span class="text-xs font-semibold text-slate-700 flex items-center gap-2.5 min-w-0">
                        <span
                          class="w-6 h-6 rounded bg-slate-100 text-slate-500 flex items-center justify-center shrink-0"
                        >
                          <i class="ph ph-plug text-sm" aria-hidden="true"></i>
                        </span>
                        <span class="truncate">{{ srv.name || srv.id }}</span>
                      </span>
                      <span class="relative inline-flex items-center shrink-0">
                        <input
                          type="checkbox"
                          :checked="rg.agentForm.mcp_server_ids.includes(srv.id)"
                          class="sr-only peer"
                          @change="rg.toggleAgentMcp(srv.id)"
                        />
                        <span
                          class="set-switch-track block peer-checked:bg-blue-600 peer-checked:border-blue-600"
                        ></span>
                      </span>
                    </label>
                  </div>
                  <p class="text-[10.5px] text-slate-500 mt-1">
                    L'agent se connecte à ces serveurs en plus des outils locaux cochés — même s'ils ne sont
                    pas actifs dans le chat.
                  </p>
                </div>
                <div>
                  <label class="text-[11px] font-medium text-slate-500">Budget d'itérations</label>
                  <input
                    v-model="rg.agentForm.max_iters"
                    type="number"
                    min="1"
                    :max="rg.CUSTOM_ITERS_MAX"
                    :placeholder="
                      rg.agentForm._template && rg.agentForm._tplIters
                        ? String(rg.agentForm._tplIters)
                        : 'défaut'
                    "
                    class="set-input font-mono mt-0.5"
                  />
                  <p class="text-[10.5px] text-slate-500 mt-1">
                    Nombre d'appels d'outils avant arrêt. Vide = valeur par défaut.
                  </p>
                </div>
                <div v-if="rg.agentFormError" class="text-xs text-red-600 bg-red-500/10 rounded-lg px-3 py-2">
                  {{ rg.agentFormError }}
                </div>
                <div class="flex items-center gap-2 pt-1">
                  <button
                    class="px-3.5 py-1.5 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm font-medium transition-colors"
                    @click="rg.saveAgentForm()"
                  >
                    {{ rg.agentForm._template || rg.agentForm._idx >= 0 ? "Enregistrer" : "Ajouter" }}
                  </button>
                  <button
                    class="px-3 py-1.5 text-sm font-medium text-slate-600 hover:bg-slate-100 rounded-lg transition-colors"
                    @click="rg.cancelAgentForm()"
                  >
                    Annuler
                  </button>
                </div>
              </div>
              <button
                v-if="!rg.agentForm"
                class="w-full px-3 py-2 border border-dashed border-slate-300 rounded-lg text-sm text-slate-500 hover:border-blue-300 hover:text-blue-600 transition-colors flex items-center justify-center gap-1.5"
                @click="rg.startCreateAgent()"
              >
                <i class="ph ph-plus"></i> Créer un agent
              </button>
            </div>

            <div v-if="rg.settingsTab === 'connexions'" class="space-y-5 max-w-2xl">
              <div>
                <h3 class="text-base font-semibold text-slate-800 mb-1">Connexions</h3>
                <p class="text-xs text-slate-500">
                  Jetons pour utiliser vos outils Elpis depuis un autre client (MCP, OpenAPI, opencode). Un
                  jeton n'est affiché qu'une fois : en cas de perte, régénérez-le.
                </p>
              </div>

              <div
                v-if="rg.cnxState.reveal"
                class="border rounded-xl p-4 space-y-3"
                :class="rg.cnxState.reveal.token ? 'border-amber-300 bg-amber-50/60' : 'border-slate-200'"
              >
                <div class="flex items-center gap-2">
                  <i class="ph ph-key text-slate-500" aria-hidden="true"></i>
                  <div class="text-sm font-medium text-slate-800 flex-1 truncate">
                    {{ rg.cnxState.reveal.item.name }}
                  </div>
                  <button
                    aria-label="Fermer"
                    class="w-7 h-7 rounded-md text-slate-500 hover:bg-slate-100 flex items-center justify-center"
                    @click="rg.cnxCloseReveal()"
                  >
                    <i class="ph ph-x" aria-hidden="true"></i>
                  </button>
                </div>
                <template v-if="rg.cnxState.reveal.token">
                  <p class="text-xs text-amber-700">Copiez ce jeton maintenant : il ne sera plus affiché.</p>
                  <div class="flex items-center gap-2">
                    <code
                      class="flex-1 min-w-0 truncate font-mono text-xs bg-white border border-slate-200 rounded-md px-2.5 py-1.5 select-all"
                      >{{ rg.cnxState.reveal.token }}</code
                    >
                    <button
                      class="px-2.5 py-1.5 text-xs rounded-md border border-slate-200 text-slate-600 hover:bg-slate-50 shrink-0"
                      @click="rg.cnxCopy(rg.cnxState.reveal.token)"
                    >
                      Copier
                    </button>
                  </div>
                </template>
                <p v-else class="text-xs text-slate-500">
                  Remplacez <code class="font-mono">&lt;VOTRE_JETON&gt;</code> par le jeton copié à sa
                  création.
                </p>
                <div class="flex flex-wrap gap-1" role="tablist">
                  <button
                    v-for="b in rg.cnxBlocks()"
                    :key="b.id"
                    role="tab"
                    :aria-selected="rg.cnxState.tab === b.id ? 'true' : 'false'"
                    class="h-7 px-2.5 rounded-md text-xs transition-colors"
                    :class="
                      rg.cnxState.tab === b.id
                        ? 'bg-blue-50 text-blue-700 font-semibold'
                        : 'text-slate-600 hover:bg-slate-100'
                    "
                    @click="rg.cnxState.tab = b.id"
                  >
                    {{ b.label }}
                  </button>
                </div>
                <template v-for="b in rg.cnxBlocks()" :key="'blk' + b.id">
                  <div v-if="rg.cnxState.tab === b.id" class="relative">
                    <pre
                      class="font-mono text-[11px] leading-relaxed bg-slate-50 border border-slate-200 rounded-lg p-3 max-h-64 overflow-auto custom-scrollbar whitespace-pre"
                      >{{ b.text }}</pre>
                    <button
                      class="absolute top-2 right-2 px-2 py-1 text-[11px] rounded-md border border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
                      @click="rg.cnxCopy(b.text)"
                    >
                      Copier
                    </button>
                  </div>
                </template>
                <div
                  v-if="rg.cnxState.reveal.item.kind === 'tools'"
                  class="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-slate-500"
                >
                  <span>Schémas :</span>
                  <template v-for="f in rg.cnxState.reveal.item.families" :key="'sch' + f">
                    <a
                      :href="rg.cnxSchemaHref(f)"
                      target="_blank"
                      rel="noopener"
                      class="text-blue-600 hover:underline"
                      >{{ f }} (MCP)</a
                    >
                  </template>
                </div>
              </div>

              <div v-if="rg.cnxState.tokens.length" class="space-y-2">
                <div
                  v-for="t in rg.cnxState.tokens"
                  :key="t.id"
                  class="border border-slate-200 rounded-xl p-3.5 flex items-center gap-3"
                >
                  <i
                    class="ph text-lg text-slate-400 shrink-0"
                    :class="t.kind === 'opencode' ? 'ph-terminal-window' : 'ph-key'"
                    aria-hidden="true"
                  ></i>
                  <div class="flex-1 min-w-0">
                    <div class="text-sm font-medium text-slate-800 truncate">
                      {{ t.name }}
                      <span class="text-slate-400 font-normal font-mono text-xs">…{{ t.hint }}</span>
                    </div>
                    <div class="text-[11px] text-slate-500 truncate">
                      {{ rg.cnxKindLabel(t.kind)
                      }}<template v-if="t.families.length"> · {{ t.families.join(", ") }}</template> · créé le
                      {{ rg.cnxDate(t.created_at) }} ·
                      {{ t.last_used_at ? "utilisé le " + rg.cnxDate(t.last_used_at) : "jamais utilisé" }}
                      <template v-if="t.expires_at"> · expire le {{ rg.cnxDate(t.expires_at) }}</template>
                    </div>
                  </div>
                  <button
                    title="Configuration des clients"
                    aria-label="Configuration des clients"
                    class="w-7 h-7 rounded-md text-slate-500 hover:bg-slate-100 hover:text-slate-700 flex items-center justify-center shrink-0"
                    @click="rg.cnxShowConfig(t)"
                  >
                    <i class="ph ph-brackets-curly" aria-hidden="true"></i>
                  </button>
                  <button
                    :disabled="rg.cnxState.busy"
                    title="Régénérer"
                    aria-label="Régénérer le jeton"
                    class="w-7 h-7 rounded-md text-slate-500 hover:bg-slate-100 hover:text-slate-700 flex items-center justify-center shrink-0"
                    @click="rg.cnxRegenerate(t)"
                  >
                    <i class="ph ph-arrows-clockwise" aria-hidden="true"></i>
                  </button>
                  <button
                    title="Révoquer"
                    aria-label="Révoquer le jeton"
                    class="w-7 h-7 rounded-md text-slate-500 hover:bg-red-50 hover:text-red-600 flex items-center justify-center shrink-0"
                    @click="rg.cnxRevoke(t)"
                  >
                    <i class="ph ph-trash" aria-hidden="true"></i>
                  </button>
                </div>
              </div>
              <p v-else-if="!rg.cnxState.form" class="text-sm text-slate-500 py-4 text-center">
                Aucun jeton.
              </p>

              <div
                v-if="rg.cnxState.form"
                class="border border-blue-200 bg-blue-50/40 rounded-xl p-4 space-y-2.5"
              >
                <div class="text-sm font-medium text-slate-700">Nouveau jeton</div>
                <div class="grid grid-cols-2 gap-2.5">
                  <div>
                    <label for="cnx-name" class="text-[11px] font-medium text-slate-500">Nom</label>
                    <input
                      id="cnx-name"
                      v-model="rg.cnxState.form.name"
                      maxlength="80"
                      placeholder="ex. VS Code du bureau, agent CI"
                      class="set-input mt-0.5"
                    />
                  </div>
                  <div>
                    <label for="cnx-kind" class="text-[11px] font-medium text-slate-500">Type</label>
                    <select id="cnx-kind" v-model="rg.cnxState.form.kind" class="set-select w-full mt-0.5">
                      <option value="tools">Outils (MCP, OpenAPI)</option>
                      <option v-if="rg.cnxState.opencode" value="opencode">opencode (plugin)</option>
                    </select>
                  </div>
                </div>
                <template v-if="rg.cnxState.form.kind === 'tools' && rg.cnxState.policy">
                  <div>
                    <div class="text-[11px] font-medium text-slate-500 mb-1">Familles d'outils</div>
                    <div class="flex flex-wrap gap-x-4 gap-y-1.5">
                      <label
                        v-for="f in rg.cnxState.policy.families"
                        :key="'cf' + f.name"
                        class="inline-flex items-center gap-1.5 text-sm text-slate-700 cursor-pointer"
                      >
                        <input
                          v-model="rg.cnxState.form.families[f.name]"
                          type="checkbox"
                          class="rounded border-slate-300"
                        />
                        {{ f.label }} <span class="font-mono text-[11px] text-slate-400">{{ f.name }}</span>
                      </label>
                    </div>
                    <p v-if="rg.cnxState.form.families.desktop" class="text-[11px] text-amber-700 mt-1">
                      « desktop » pilote vos machines hors de la sandbox.
                    </p>
                  </div>
                  <div>
                    <label for="cnx-days" class="text-[11px] font-medium text-slate-500"
                      >Durée de validité</label
                    >
                    <div class="flex items-center gap-2 mt-0.5">
                      <input
                        id="cnx-days"
                        v-model.number="rg.cnxState.form.days"
                        type="number"
                        min="0"
                        :max="rg.cnxState.policy.max_days || 3650"
                        class="set-input w-28"
                      />
                      <span class="text-xs text-slate-500"
                        >jours<template v-if="rg.cnxState.policy.max_days">
                          (maximum {{ rg.cnxState.policy.max_days }})</template
                        ><template v-else> (0 = sans limite)</template></span
                      >
                    </div>
                  </div>
                </template>
                <p v-if="rg.cnxState.error" class="text-xs text-red-600">{{ rg.cnxState.error }}</p>
                <div class="flex items-center gap-2 pt-1">
                  <button
                    :disabled="rg.cnxState.busy"
                    class="px-3.5 py-1.5 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm font-medium transition-colors disabled:opacity-50"
                    @click="rg.cnxCreate()"
                  >
                    Créer
                  </button>
                  <button
                    class="px-3 py-1.5 text-sm font-medium text-slate-600 hover:bg-slate-100 rounded-lg transition-colors"
                    @click="rg.cnxCancel()"
                  >
                    Annuler
                  </button>
                </div>
              </div>
              <button
                v-if="!rg.cnxState.form"
                :disabled="
                  !!(rg.cnxState.policy && !rg.cnxState.policy.tools_enabled && !rg.cnxState.opencode)
                "
                class="w-full px-3 py-2 border border-dashed border-slate-300 rounded-lg text-sm text-slate-500 hover:border-blue-300 hover:text-blue-600 transition-colors flex items-center justify-center gap-1.5 disabled:opacity-50"
                @click="rg.cnxNew()"
              >
                <i class="ph ph-plus" aria-hidden="true"></i> Nouveau jeton
              </button>
              <p
                v-if="rg.cnxState.policy && !rg.cnxState.policy.tools_enabled"
                class="text-[11px] text-slate-500"
              >
                Les jetons d'outils sont désactivés par l'administrateur.
              </p>

              <div v-if="rg.cnxState.oauthEnabled || rg.cnxState.grants.length" class="pt-2 space-y-2">
                <div class="text-sm font-medium text-slate-700">Applications autorisées</div>
                <p class="text-[11px] text-slate-500">
                  Un client MCP peut aussi se connecter avec la seule adresse
                  <span class="font-mono">{{ rg.cnxState.bridgeUrl || "/api/mcp-bridge" }}</span> : Elpis vous
                  demande alors votre accord.
                </p>
                <div
                  v-for="g in rg.cnxState.grants"
                  :key="g.grant_id"
                  class="border border-slate-200 rounded-xl p-3.5 flex items-center gap-3"
                >
                  <i class="ph ph-plugs-connected text-lg text-slate-400 shrink-0" aria-hidden="true"></i>
                  <div class="flex-1 min-w-0">
                    <div class="text-sm font-medium text-slate-800 truncate" :title="g.client_id">
                      {{ g.client_name }}
                    </div>
                    <div class="text-[11px] text-slate-500 truncate">
                      {{ g.families.join(", ") }}
                      · autorisé le {{ rg.cnxDate(g.created_at) }} ·
                      {{ g.last_used_at ? "utilisé le " + rg.cnxDate(g.last_used_at) : "jamais utilisé" }}
                    </div>
                  </div>
                  <button
                    title="Retirer l'accès"
                    aria-label="Retirer l'accès"
                    class="w-7 h-7 rounded-md text-slate-500 hover:bg-red-50 hover:text-red-600 flex items-center justify-center shrink-0"
                    @click="rg.cnxRevokeGrant(g)"
                  >
                    <i class="ph ph-trash" aria-hidden="true"></i>
                  </button>
                </div>
                <p v-if="!rg.cnxState.grants.length" class="text-sm text-slate-500 py-2 text-center">
                  Aucune application autorisée.
                </p>
              </div>
            </div>

            <div v-if="rg.settingsTab === 'connectors'" class="space-y-5 max-w-xl">
              <div>
                <h3 class="text-base font-semibold text-slate-800 mb-1">Connecteurs Git</h3>
                <p class="text-xs text-slate-500">
                  Vos tokens Git (GitHub, GitLab, Bitbucket, Gitea), stockés côté serveur. Servent au
                  push/pull et aux PR/MR authentifiés.
                </p>
              </div>

              <div v-if="rg.gitConnectors.length" class="space-y-2">
                <div
                  v-for="c in rg.gitConnectors"
                  :key="c.id"
                  class="border border-slate-200 rounded-xl p-3.5"
                >
                  <div class="flex items-center gap-3">
                    <i class="ph ph-git-branch text-lg text-slate-400 shrink-0"></i>
                    <div class="flex-1 min-w-0">
                      <div class="text-sm font-medium text-slate-800 truncate">
                        {{ c.host
                        }}<span v-if="c.label" class="text-slate-500 font-normal"> · {{ c.label }}</span>
                      </div>
                      <div class="text-[11px] text-slate-500">
                        {{ c.provider_type }}<span v-if="c.username"> · {{ c.username }}</span>
                      </div>
                    </div>
                    <span
                      v-if="rg.gitConnTest[c.id]"
                      class="text-[11px] shrink-0"
                      :class="
                        rg.gitConnTest[c.id]?.testing
                          ? 'text-slate-500'
                          : rg.gitConnTest[c.id]?.ok
                            ? 'text-green-600'
                            : 'text-red-500'
                      "
                    >
                      {{
                        rg.gitConnTest[c.id]?.testing
                          ? "…"
                          : rg.gitConnTest[c.id]?.ok
                            ? "✓ " + (rg.gitConnTest[c.id]?.login || "OK")
                            : "✗ " + (rg.gitConnTest[c.id]?.error || "échec")
                      }}
                    </span>
                    <button
                      title="Tester la connexion"
                      class="px-2 py-1 text-[11px] rounded-md border border-slate-200 text-slate-600 hover:bg-slate-50 shrink-0"
                      @click="rg.testGitConnector(c)"
                    >
                      Tester
                    </button>
                    <button
                      title="Modifier"
                      aria-label="Modifier le connecteur"
                      class="w-7 h-7 rounded-md text-slate-500 hover:bg-slate-100 hover:text-slate-700 flex items-center justify-center shrink-0"
                      @click="rg.editGitConnector(c)"
                    >
                      <i class="ph ph-pencil-simple" aria-hidden="true"></i>
                    </button>
                    <button
                      title="Supprimer"
                      aria-label="Supprimer le connecteur"
                      class="w-7 h-7 rounded-md text-slate-500 hover:bg-red-50 hover:text-red-600 flex items-center justify-center shrink-0"
                      @click="rg.deleteGitConnector(c)"
                    >
                      <i class="ph ph-trash" aria-hidden="true"></i>
                    </button>
                  </div>
                  <p
                    v-if="rg.gitConnTest[c.id] && rg.gitConnTest[c.id]?.hint && !rg.gitConnTest[c.id]?.ok"
                    class="text-[10.5px] text-amber-600 mt-2 leading-snug"
                  >
                    {{ rg.gitConnTest[c.id]?.hint }}
                  </p>
                </div>
              </div>
              <p v-else-if="!rg.gitConnForm" class="text-sm text-slate-500 py-4 text-center">
                Aucun connecteur configuré.
              </p>

              <div
                v-if="rg.gitConnForm"
                class="border border-blue-200 bg-blue-50/40 rounded-xl p-4 space-y-2.5"
              >
                <div class="text-sm font-medium text-slate-700">
                  {{ rg.gitConnForm.id ? "Modifier le connecteur" : "Nouveau connecteur" }}
                </div>

                <div>
                  <label class="text-[11px] font-medium text-slate-500">Service</label>
                  <select
                    v-model="rg.gitConnForm.provider_type"
                    class="set-select w-full mt-0.5"
                    @change="rg.parseGitRepoUrl()"
                  >
                    <option v-for="t in rg.gitConnTypes" :key="t" :value="t">{{ t }}</option>
                  </select>
                </div>

                <div v-if="!rg.gitConnForm.id">
                  <label class="text-[11px] font-medium text-slate-500">URL du dépôt à cloner</label>
                  <input
                    v-model="rg.gitConnForm.repo_url"
                    placeholder="https://git.example.lan/team/repo.git"
                    class="set-input mt-0.5"
                    @change="rg.parseGitRepoUrl()"
                    @blur="rg.parseGitRepoUrl()"
                  />
                  <p v-if="rg.gitConnForm.host" class="text-[10.5px] text-slate-500 mt-1">
                    Host détecté : <span class="font-mono text-slate-600">{{ rg.gitConnForm.host }}</span>
                  </p>
                </div>

                <div class="grid grid-cols-2 gap-2.5">
                  <div>
                    <label class="text-[11px] font-medium text-slate-500">Login</label>
                    <input
                      v-model="rg.gitConnForm.username"
                      placeholder="utilisateur"
                      class="set-input mt-0.5"
                    />
                  </div>
                  <div>
                    <label class="text-[11px] font-medium text-slate-500">{{
                      rg.gitConnForm.provider_type === "github" ? "Token (PAT)" : "Mot de passe / token"
                    }}</label>
                    <input
                      v-model="rg.gitConnForm.token"
                      type="password"
                      :placeholder="
                        rg.gitConnForm.id
                          ? 'vide = inchangé'
                          : rg.gitConnForm.provider_type === 'github'
                            ? 'ghp_…'
                            : 'mot de passe ou token'
                      "
                      class="set-input mt-0.5"
                    />
                  </div>
                </div>
                <input
                  v-model="rg.gitConnForm.label"
                  placeholder="Label (optionnel, ex. perso ou ci-bot)"
                  class="set-input"
                />

                <button
                  type="button"
                  class="text-[11px] text-slate-500 hover:text-slate-700 flex items-center gap-1"
                  @click="rg.gitConnAdvanced = !rg.gitConnAdvanced"
                >
                  <i class="ph" :class="rg.gitConnAdvanced ? 'ph-minus' : 'ph-plus'"></i> Paramètres avancés
                </button>
                <div v-if="rg.gitConnAdvanced" class="space-y-2.5 pt-2 border-t border-blue-100">
                  <div>
                    <label class="text-[11px] font-medium text-slate-500">host (override)</label>
                    <input
                      v-model="rg.gitConnForm.host"
                      placeholder="git.example.lan:3000 (host:port, sans http://)"
                      class="set-input mt-0.5"
                    />
                  </div>
                  <div>
                    <label class="text-[11px] font-medium text-slate-500">api_base (PR / test)</label>
                    <input
                      v-model="rg.gitConnForm.api_base"
                      placeholder="http://git.example.lan:3000/api/v1 (Gitea/GitLab HTTP)"
                      class="set-input mt-0.5"
                    />
                  </div>
                </div>
                <div class="flex items-center gap-2 pt-1">
                  <button
                    :disabled="rg.gitConnBusy"
                    class="px-3.5 py-1.5 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm font-medium transition-colors disabled:opacity-50"
                    @click="rg.saveGitConnector()"
                  >
                    {{ rg.gitConnForm.id ? "Enregistrer" : "Ajouter" }}
                  </button>
                  <button
                    class="px-3 py-1.5 text-sm font-medium text-slate-600 hover:bg-slate-100 rounded-lg transition-colors"
                    @click="rg.cancelGitConnector()"
                  >
                    Annuler
                  </button>
                </div>
              </div>
              <button
                v-if="!rg.gitConnForm"
                class="w-full px-3 py-2 border border-dashed border-slate-300 rounded-lg text-sm text-slate-500 hover:border-blue-300 hover:text-blue-600 transition-colors flex items-center justify-center gap-1.5"
                @click="rg.newGitConnector()"
              >
                <i class="ph ph-plus"></i> Ajouter un connecteur
              </button>
            </div>

            <div v-if="rg.settingsTab === 'ai_models'" class="space-y-5 max-w-xl">
              <div>
                <h3 class="text-base font-semibold text-slate-800 mb-1">Modèles IA</h3>
                <p class="text-xs text-slate-500">
                  Connectez des fournisseurs d'IA avec votre clé API : leurs modèles apparaissent dans le
                  sélecteur de modèle du chat. Votre clé est chiffrée côté serveur et n'est jamais réaffichée.
                </p>
              </div>

              <div v-if="rg.llmConnShared.length" class="set-block">
                <div class="flex items-center gap-2 mb-2.5">
                  <i class="ph ph-broadcast text-slate-400 text-sm"></i>
                  <span class="text-xs font-semibold text-slate-700">Fournis par l'administrateur</span>
                </div>
                <div class="space-y-1.5">
                  <div
                    v-for="c in rg.llmConnShared"
                    :key="'sh' + c.id"
                    class="flex items-center gap-2.5 text-sm"
                  >
                    <i class="ph ph-plugs-connected text-slate-400 text-sm"></i>
                    <span class="font-medium text-slate-700 truncate">{{
                      c.label || rg.llmPresetLabel(c.provider_type)
                    }}</span>
                    <span class="text-[11px] text-slate-400">{{ rg.llmPresetLabel(c.provider_type) }}</span>
                    <span
                      v-if="c.default_model"
                      class="ml-auto text-[11px] font-mono text-slate-400 truncate max-w-[45%]"
                      :title="c.default_model"
                      >{{ c.default_model }}</span
                    >
                  </div>
                </div>
              </div>

              <div>
                <div class="flex items-center justify-between mb-2">
                  <span class="text-xs font-semibold text-slate-700">Mes fournisseurs</span>
                  <button
                    v-if="!rg.llmConnForm && rg.llmConnectors.length && rg.llmConnAllowed.length"
                    class="text-xs font-medium text-blue-600 hover:text-blue-700 flex items-center gap-1"
                    @click="rg.newLlmConnector()"
                  >
                    <i class="ph ph-plus"></i> Ajouter
                  </button>
                </div>

                <p
                  v-if="rg.llmConnectors.length && !rg.llmConnAllowed.length && !rg.llmConnForm"
                  class="text-xs text-slate-400 mb-2"
                >
                  Aucun fournisseur cloud n'est ouvert aux comptes par l'administrateur : utilisez les
                  serveurs qu'il fournit.
                </p>
                <div
                  v-if="rg.llmConnectors.length"
                  class="set-block !p-0 divide-y divide-slate-100 overflow-hidden"
                >
                  <div
                    v-for="c in rg.llmConnectors"
                    :key="'lc' + c.id"
                    class="group flex items-center gap-3 px-3.5 py-2.5"
                  >
                    <i class="ph ph-plugs-connected text-slate-400"></i>
                    <div class="min-w-0 flex-1">
                      <div class="flex items-center gap-2">
                        <span class="text-sm font-medium text-slate-800 truncate">{{
                          c.label || rg.llmPresetLabel(c.provider_type)
                        }}</span>
                        <span
                          class="text-[10px] px-1.5 py-0.5 rounded bg-slate-100 text-slate-500 shrink-0"
                          >{{ rg.llmPresetLabel(c.provider_type) }}</span
                        >
                        <span
                          v-if="'provider_allowed' in c && c.provider_allowed === false"
                          class="text-[10px] px-1.5 py-0.5 rounded bg-amber-50 text-amber-700 shrink-0"
                          title="Ce fournisseur n'est plus ouvert aux comptes par l'administrateur : ce connecteur reste enregistré mais n'est pas utilisable."
                          >fermé par l'administrateur</span
                        >
                      </div>
                      <div class="flex items-center gap-2 mt-0.5 text-[11px] text-slate-400 min-w-0">
                        <span v-if="c.default_model" class="font-mono truncate" :title="c.default_model">{{
                          c.default_model
                        }}</span>
                        <span v-else>Modèle choisi dans le chat</span>
                        <template v-if="rg.llmConnTest[c.id]">
                          <span class="text-slate-300">·</span>
                          <span
                            v-if="rg.llmConnTest[c.id]?.testing"
                            class="flex items-center gap-0.5 shrink-0"
                            ><i class="ph ph-spinner-gap animate-spin"></i> test…</span
                          >
                          <span
                            v-else-if="rg.llmConnTest[c.id]?.ok"
                            class="text-emerald-600 flex items-center gap-0.5 shrink-0"
                            ><i class="ph ph-check-circle"></i>
                            {{ rg.llmConnTest[c.id]?.models_count }} modèles</span
                          >
                          <span
                            v-else
                            class="text-red-500 flex items-center gap-0.5 shrink-0"
                            :title="rg.llmConnTest[c.id]?.hint || rg.llmConnTest[c.id]?.error"
                            ><i class="ph ph-warning-circle"></i> échec</span
                          >
                        </template>
                      </div>
                    </div>
                    <div
                      class="flex items-center gap-0.5 opacity-50 group-hover:opacity-100 transition-opacity"
                    >
                      <button
                        class="w-7 h-7 flex items-center justify-center rounded-md text-slate-400 hover:text-blue-600 hover:bg-blue-50 transition-colors"
                        title="Tester la connexion"
                        @click="rg.testLlmConnector(c)"
                      >
                        <i class="ph ph-pulse"></i>
                      </button>
                      <button
                        class="w-7 h-7 flex items-center justify-center rounded-md text-slate-400 hover:text-blue-600 hover:bg-blue-50 transition-colors"
                        title="Modifier"
                        @click="rg.editLlmConnector(c)"
                      >
                        <i class="ph ph-pencil-simple"></i>
                      </button>
                      <button
                        class="w-7 h-7 flex items-center justify-center rounded-md text-slate-400 hover:text-red-600 hover:bg-red-50 transition-colors"
                        title="Supprimer"
                        @click="rg.deleteLlmConnector(c)"
                      >
                        <i class="ph ph-trash"></i>
                      </button>
                    </div>
                  </div>
                </div>

                <div v-else-if="!rg.llmConnForm" class="set-block text-center py-7">
                  <i class="ph ph-sparkle text-2xl text-slate-300"></i>
                  <p class="text-sm text-slate-500 mt-2">Aucun fournisseur connecté.</p>
                  <p class="text-xs text-slate-400 mt-0.5 mb-3.5 max-w-xs mx-auto">
                    Ajoutez Anthropic, OpenAI ou un autre fournisseur avec votre clé pour utiliser ses modèles
                    dans le chat.
                  </p>
                  <button
                    v-if="rg.llmConnAllowed.length"
                    class="px-3.5 py-1.5 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm font-medium inline-flex items-center gap-1.5 transition-colors"
                    @click="rg.newLlmConnector()"
                  >
                    <i class="ph ph-plus"></i> Ajouter un fournisseur
                  </button>
                  <p v-else class="text-xs text-slate-400 max-w-xs mx-auto">
                    Aucun fournisseur cloud n'est ouvert aux comptes par l'administrateur : utilisez les
                    serveurs qu'il fournit.
                  </p>
                </div>

                <div v-if="rg.llmConnForm" class="set-block mt-2 space-y-3">
                  <div class="flex items-center gap-2">
                    <i class="ph ph-plus-circle text-blue-500"></i>
                    <span class="text-sm font-semibold text-slate-700">{{
                      rg.llmConnForm.id ? "Modifier le fournisseur" : "Nouveau fournisseur"
                    }}</span>
                  </div>
                  <div v-if="!rg.llmConnForm.id">
                    <label class="text-[11px] font-medium text-slate-500 block mb-1">Fournisseur</label>
                    <select v-model="rg.llmConnForm.provider_type" class="set-select w-full">
                      <option v-for="pt in rg.llmConnAllowed" :key="pt" :value="pt">
                        {{ rg.llmPresetLabel(pt) }}
                      </option>
                    </select>
                    <p
                      v-if="rg.llmConnPresets[rg.llmConnForm.provider_type]"
                      class="text-[11px] text-slate-400 mt-1 font-mono truncate"
                    >
                      → {{ rg.llmConnPresets[rg.llmConnForm.provider_type]?.base_url }}
                    </p>
                  </div>
                  <div>
                    <label class="text-[11px] font-medium text-slate-500 block mb-1">Clé API</label>
                    <input
                      v-model="rg.llmConnForm.api_key"
                      type="password"
                      :placeholder="rg.llmConnForm.id ? 'Vide = clé inchangée' : 'sk-…'"
                      class="set-input"
                    />
                  </div>
                  <div class="grid grid-cols-2 gap-3">
                    <div>
                      <label class="text-[11px] font-medium text-slate-500 block mb-1"
                        >Modèle par défaut <span class="text-slate-400 font-normal">(optionnel)</span></label
                      >
                      <input
                        v-model="rg.llmConnForm.default_model"
                        placeholder="ex. claude-sonnet-4-6"
                        class="set-input"
                      />
                    </div>
                    <div>
                      <label class="text-[11px] font-medium text-slate-500 block mb-1"
                        >Nom <span class="text-slate-400 font-normal">(optionnel)</span></label
                      >
                      <input v-model="rg.llmConnForm.label" placeholder="ex. perso" class="set-input" />
                    </div>
                  </div>
                  <div class="flex items-center gap-2 pt-0.5">
                    <button
                      :disabled="rg.llmConnBusy"
                      class="px-3.5 py-1.5 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm font-medium disabled:opacity-50 inline-flex items-center gap-1.5 transition-colors"
                      @click="rg.saveLlmConnector()"
                    >
                      <i v-if="rg.llmConnBusy" class="ph ph-spinner-gap animate-spin"></i>
                      {{ rg.llmConnForm.id ? "Enregistrer" : "Ajouter" }}
                    </button>
                    <button
                      class="px-3 py-1.5 text-sm font-medium text-slate-600 hover:bg-slate-100 rounded-lg transition-colors"
                      @click="rg.cancelLlmConnector()"
                    >
                      Annuler
                    </button>
                  </div>
                </div>
              </div>
            </div>

            <div v-if="rg.settingsTab === 'profile'" class="space-y-5 max-w-xl">
              <div>
                <h3 class="text-base font-semibold text-slate-800 mb-1">Profil</h3>
                <p class="text-xs text-slate-500">Vos informations de compte.</p>
              </div>

              <div class="flex items-center gap-4 p-4 bg-slate-50 rounded-xl">
                <div class="w-14 h-14 rounded-xl flex items-center justify-center shrink-0 overflow-hidden">
                  <img
                    v-if="rg.user.avatar"
                    :src="'/avatars/' + rg.user.avatar"
                    class="w-full h-full object-cover"
                  />
                  <div
                    v-else
                    class="w-full h-full bg-blue-600 flex items-center justify-center text-white font-bold text-xl"
                  >
                    {{ rg.user.username.substring(0, 2).toUpperCase() }}
                  </div>
                </div>
                <div class="flex-1 min-w-0">
                  <div class="font-semibold text-slate-800">{{ rg.user.username }}</div>
                  <div
                    class="text-[11px] font-semibold mt-0.5"
                    :class="
                      rg.user.role === 'admin'
                        ? 'elpis-role-admin'
                        : rg.user.role === 'moderator'
                          ? 'text-amber-600'
                          : 'text-slate-500'
                    "
                  >
                    {{
                      rg.user.role === "admin"
                        ? "Administrateur"
                        : rg.user.role === "moderator"
                          ? "Modérateur"
                          : "Utilisateur"
                    }}
                  </div>
                </div>
                <div class="flex items-center gap-1.5 shrink-0">
                  <label
                    class="px-3 py-1.5 bg-white border border-slate-200 hover:bg-slate-50 rounded-md text-xs font-medium text-slate-600 cursor-pointer transition-colors"
                    >Photo<input type="file" class="hidden" accept="image/*" @change="rg.uploadAvatar"
                  /></label>
                  <button
                    v-if="rg.user.avatar"
                    aria-label="Supprimer la photo"
                    class="px-2 py-1.5 bg-white border border-slate-200 hover:bg-red-50 hover:border-red-200 hover:text-red-600 text-slate-500 rounded-md text-xs transition-colors"
                    @click="rg.removeAvatar"
                  >
                    <i class="ph ph-trash" aria-hidden="true"></i>
                  </button>
                </div>
              </div>

              <div class="set-block">
                <div
                  class="flex items-center justify-between cursor-pointer"
                  @click="rg.showPasswordChange = !rg.showPasswordChange"
                >
                  <div class="flex items-center gap-2 text-sm font-medium text-slate-700">
                    <i class="ph ph-lock-key text-slate-400"></i> Mot de passe
                  </div>
                  <i
                    class="ph text-slate-400 text-xs transition-transform"
                    :class="rg.showPasswordChange ? 'ph-caret-up' : 'ph-caret-down'"
                  ></i>
                </div>
                <div v-if="rg.showPasswordChange" class="space-y-2.5 mt-3 pt-3 border-t border-slate-100">
                  <input
                    v-model="rg.passwordForm.old_password"
                    type="password"
                    aria-label="Mot de passe actuel"
                    placeholder="Mot de passe actuel"
                    class="set-input"
                  />
                  <input
                    v-model="rg.passwordForm.new_password"
                    type="password"
                    aria-label="Nouveau mot de passe"
                    placeholder="Nouveau mot de passe"
                    class="set-input"
                  />
                  <input
                    v-model="rg.passwordForm.confirm_password"
                    type="password"
                    aria-label="Confirmation du mot de passe"
                    placeholder="Confirmation"
                    class="set-input"
                  />
                  <p
                    v-if="
                      rg.passwordForm.new_password &&
                      rg.passwordForm.confirm_password &&
                      rg.passwordForm.new_password !== rg.passwordForm.confirm_password
                    "
                    role="alert"
                    class="text-xs text-red-500"
                  >
                    Les mots de passe ne correspondent pas.
                  </p>
                  <button
                    :disabled="
                      rg.passwordSaving ||
                      !rg.passwordForm.old_password ||
                      !rg.passwordForm.new_password ||
                      rg.passwordForm.new_password !== rg.passwordForm.confirm_password
                    "
                    class="w-full bg-blue-600 hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed text-white py-2 rounded-lg font-medium text-sm transition-colors inline-flex items-center justify-center gap-2"
                    @click="rg.changeMyPassword"
                  >
                    <i v-if="rg.passwordSaving" class="ph ph-spinner-gap animate-spin" aria-hidden="true"></i>
                    {{ rg.passwordSaving ? "Mise à jour…" : "Mettre à jour" }}
                  </button>
                </div>
              </div>
            </div>

            <div v-if="rg.settingsTab === 'usage'" class="space-y-5 max-w-2xl">
              <div class="flex items-start justify-between gap-4 flex-wrap">
                <div>
                  <h3 class="text-base font-semibold text-slate-800 mb-1">Utilisation</h3>
                  <p class="text-xs text-slate-500">Votre activité sur la période sélectionnée.</p>
                </div>

                <div
                  class="flex items-center gap-0.5 bg-slate-100 rounded-lg p-0.5 text-xs font-medium shrink-0"
                >
                  <button
                    v-for="d in [1, 7, 30, 90]"
                    :key="d"
                    :class="
                      rg.usageDays === d
                        ? 'bg-white text-blue-600 shadow-sm'
                        : 'text-slate-500 hover:text-slate-700'
                    "
                    class="px-2.5 py-1 rounded-md transition-colors"
                    @click="rg.setUsageDays(d)"
                  >
                    {{ d }} j
                  </button>
                </div>
              </div>

              <div
                v-if="rg.usageLoading && !rg.usageData"
                role="status"
                class="flex items-center gap-2 text-sm text-slate-500 py-8 justify-center"
              >
                <i class="ph ph-spinner-gap animate-spin" aria-hidden="true"></i> Chargement des métriques…
              </div>

              <div
                v-else-if="rg.usageError && !rg.usageData"
                role="alert"
                class="flex items-center gap-2 text-sm text-red-500 py-8 justify-center"
              >
                <i class="ph ph-warning-circle" aria-hidden="true"></i> {{ rg.usageError }}
              </div>

              <template v-else-if="rg.usageData">
                <div class="set-block">
                  <div class="flex items-center gap-2 text-sm font-medium text-slate-700 mb-3">
                    <i class="ph ph-coins text-blue-500" aria-hidden="true"></i>
                    <span
                      title="Tokens envoyés au modèle et générés par lui, toutes requêtes comprises (itérations d'outils, routines, sous-agents)"
                      >Tokens</span
                    >
                    <span
                      class="ml-auto text-xl font-bold text-slate-800 tabular-nums"
                      :title="(rg.usageData.tokens?.total || 0).toLocaleString('fr-FR') + ' tokens'"
                      >{{ rg.usageFmt(rg.usageData.tokens?.total) }}</span
                    >
                  </div>
                  <div class="space-y-1.5" role="list">
                    <div
                      v-for="b in rg.usageBars"
                      :key="'ub-' + b.key"
                      role="listitem"
                      class="flex items-center gap-2 text-[11px]"
                      :title="b.title"
                    >
                      <span
                        class="w-20 shrink-0 truncate"
                        :class="b.sub ? 'pl-3 text-slate-500' : 'font-medium text-slate-700'"
                        >{{ b.label }}</span
                      >
                      <div class="flex-1 h-2 rounded-full bg-slate-100 overflow-hidden">
                        <div
                          class="h-full rounded-full"
                          :class="b.cls"
                          :style="{ width: rg.usageWidth(b.value, rg.usageBarMax) }"
                        ></div>
                      </div>
                      <span class="w-14 shrink-0 text-right font-semibold text-slate-700 tabular-nums">{{
                        rg.usageFmt(b.value)
                      }}</span>
                      <span class="w-28 shrink-0 text-slate-400 tabular-nums truncate">{{ b.note }}</span>
                    </div>
                  </div>

                  <div
                    v-if="rg.usageData.tokens?.by_source && rg.usageData.tokens?.by_source.length > 1"
                    class="mt-4 pt-3 border-t border-slate-100 space-y-1.5"
                  >
                    <div
                      v-for="s in rg.usageData.tokens?.by_source"
                      :key="'us-' + s.source"
                      class="flex items-center gap-2 text-[11px]"
                      :title="rg.usageSourceTitle(s)"
                    >
                      <span class="w-20 shrink-0 truncate text-slate-500">{{
                        rg.usageSourceLabel(s.source)
                      }}</span>
                      <div class="flex-1 h-1.5 rounded-full bg-slate-100 overflow-hidden">
                        <div
                          class="h-full rounded-full bg-blue-500"
                          :style="{ width: rg.usageWidth(s.tokens, rg.usageSourceMax) }"
                        ></div>
                      </div>
                      <span class="w-14 shrink-0 text-right font-semibold text-slate-700 tabular-nums">{{
                        rg.usageFmt(s.tokens)
                      }}</span>
                      <span class="w-28 shrink-0 text-slate-400 tabular-nums">{{ s.turns }} tours</span>
                    </div>
                  </div>
                </div>

                <div class="grid grid-cols-2 gap-3">
                  <div class="set-block">
                    <div class="flex items-center gap-2 text-sm font-medium text-slate-700 mb-3">
                      <i class="ph ph-chats-circle text-blue-500"></i> Conversations
                    </div>
                    <div class="flex items-baseline gap-4">
                      <div>
                        <span class="text-xl font-bold text-slate-800 tabular-nums">{{
                          rg.usageData.chats?.active
                        }}</span>
                        <span class="text-[11px] text-slate-500">actives</span>
                      </div>
                      <div>
                        <span class="text-xl font-bold text-slate-600 tabular-nums">{{
                          rg.usageData.chats?.archived
                        }}</span>
                        <span class="text-[11px] text-slate-500">archivées</span>
                      </div>
                    </div>
                  </div>
                  <div class="set-block">
                    <div class="flex items-center gap-2 text-sm font-medium text-slate-700 mb-3">
                      <i class="ph ph-paper-plane-tilt text-blue-500"></i> Messages
                    </div>
                    <div class="flex items-baseline gap-4">
                      <div>
                        <span class="text-xl font-bold text-slate-800 tabular-nums">{{
                          rg.usageData.messages?.sent
                        }}</span>
                        <span class="text-[11px] text-slate-500">envoyés</span>
                      </div>
                      <div>
                        <span class="text-xl font-bold text-slate-600 tabular-nums">{{
                          rg.usageData.messages?.received
                        }}</span>
                        <span class="text-[11px] text-slate-500">reçus</span>
                      </div>
                    </div>
                  </div>
                </div>

                <div v-if="(rg.usageData.routines?.runs ?? 0) > 0" class="set-block">
                  <div class="flex items-center gap-2 text-sm font-medium text-slate-700 mb-3">
                    <i class="ph ph-clock-countdown text-blue-500"></i> Routines
                  </div>
                  <div class="flex items-baseline gap-4 flex-wrap">
                    <div>
                      <span class="text-xl font-bold text-slate-800 tabular-nums">{{
                        rg.usageData.routines?.runs
                      }}</span>
                      <span class="text-[11px] text-slate-500">exécutions</span>
                    </div>
                    <div>
                      <span class="text-base font-bold text-emerald-600 tabular-nums">{{
                        rg.usageData.routines?.ok
                      }}</span>
                      <span class="text-[11px] text-slate-500">ok</span>
                    </div>
                    <div v-if="(rg.usageData.routines?.error ?? 0) > 0">
                      <span class="text-base font-bold text-red-500 tabular-nums">{{
                        rg.usageData.routines?.error
                      }}</span>
                      <span class="text-[11px] text-slate-500">erreurs</span>
                    </div>
                  </div>
                </div>

                <p class="text-[11px] text-slate-500">
                  Données agrégées localement, jamais transmises à l'extérieur.
                </p>
              </template>
            </div>

            <div v-if="rg.settingsTab === 'chat'" class="space-y-5 max-w-xl">
              <div>
                <h3 class="text-base font-semibold text-slate-800 mb-1">Chat</h3>
                <p class="text-xs text-slate-500">Comportement et présentation des conversations.</p>
              </div>

              <div>
                <label class="block text-xs font-medium text-slate-600 mb-1.5">Prompt système</label>
                <textarea
                  v-model="rg.settings.system_prompt"
                  rows="4"
                  placeholder="Instructions personnalisées pour l'assistant…"
                  class="set-textarea"
                ></textarea>
              </div>

              <div
                class="bg-slate-50 rounded-lg p-3.5"
                :class="rg.settings.skin === 'llamacpp' ? 'opacity-50' : ''"
              >
                <div class="flex justify-between items-center mb-2">
                  <span class="text-sm text-slate-700">Largeur</span>
                  <span
                    class="text-[11px] font-mono text-blue-600 bg-white px-2 py-0.5 rounded border border-slate-200"
                    >{{ rg.settings.chat_width }}%</span
                  >
                </div>
                <input
                  v-model.number="rg.settings.chat_width"
                  type="range"
                  min="30"
                  max="100"
                  step="5"
                  :disabled="rg.settings.skin === 'llamacpp'"
                  class="set-range w-full"
                />
                <p v-if="rg.settings.skin === 'llamacpp'" class="text-[10px] text-slate-500 mt-1.5">
                  Largeur fixe (colonne centrée) imposée par l'habillage llama.cpp.
                </p>
              </div>

              <div class="bg-slate-50 rounded-xl">
                <label class="set-row cursor-pointer hover:bg-white/60 transition-colors rounded-xl">
                  <i class="ph ph-brain text-slate-400 text-lg w-5"></i>
                  <div class="flex-1 min-w-0">
                    <div class="text-sm text-slate-800">Masquer le raisonnement</div>
                    <div class="text-[11px] text-slate-500">
                      Cache les blocs « thinking » des réponses. Le raisonnement reste produit, il n'est
                      simplement plus affiché.
                    </div>
                  </div>
                  <div class="relative inline-flex items-center shrink-0">
                    <input v-model="rg.settings.hide_thinking" type="checkbox" class="sr-only peer" />
                    <div class="set-switch-track peer-checked:bg-blue-600 peer-checked:border-blue-600"></div>
                  </div>
                </label>
              </div>

              <div class="bg-slate-50 rounded-xl">
                <label class="set-row cursor-pointer hover:bg-white/60 transition-colors rounded-xl">
                  <i class="ph ph-terminal-window text-slate-400 text-lg w-5"></i>
                  <div class="flex-1 min-w-0">
                    <div class="text-sm text-slate-800">Terminal en direct</div>
                    <div class="text-[11px] text-slate-500">
                      Affiche la sortie des commandes shell exécutées par l'assistant en temps réel, dans la
                      conversation. Désactivé, la sortie reste visible dans le détail de l'outil.
                    </div>
                  </div>
                  <div class="relative inline-flex items-center shrink-0">
                    <input
                      v-model="rg.settings.live_shell_enabled"
                      type="checkbox"
                      class="sr-only peer"
                      @change="rg.persistLiveShell"
                    />
                    <div class="set-switch-track peer-checked:bg-blue-600 peer-checked:border-blue-600"></div>
                  </div>
                </label>
              </div>

              <div class="bg-slate-50 rounded-xl">
                <label class="set-row cursor-pointer hover:bg-white/60 transition-colors rounded-xl">
                  <i class="ph ph-timer text-slate-400 text-lg w-5"></i>
                  <div class="flex-1 min-w-0">
                    <div class="text-sm text-slate-800">Me réveiller quand une tâche de fond se termine</div>
                    <div class="text-[11px] text-slate-500">
                      Une tâche lancée par l'assistant peut relancer la conversation toute seule à sa fin ou
                      sur un événement. Désactivé, le résultat est joint à votre prochain message. Réglable
                      aussi conversation par conversation.
                    </div>
                  </div>
                  <div class="relative inline-flex items-center shrink-0">
                    <input
                      v-model="rg.settings.jobs_wake"
                      type="checkbox"
                      data-jobs-wake
                      class="sr-only peer"
                      @change="rg.persistJobsWake"
                    />
                    <div class="set-switch-track peer-checked:bg-blue-600 peer-checked:border-blue-600"></div>
                  </div>
                </label>
              </div>

              <div
                v-if="rg.features.voice_stt || rg.features.voice_tts"
                class="bg-slate-50 rounded-xl overflow-hidden divide-y divide-slate-200/70"
              >
                <label
                  v-if="rg.features.voice_stt"
                  class="set-row cursor-pointer hover:bg-white/60 transition-colors"
                >
                  <i class="ph ph-microphone text-slate-400 text-lg w-5"></i>
                  <div class="flex-1 min-w-0">
                    <div class="text-sm text-slate-800">Dictée</div>
                    <div class="text-[11px] text-slate-500">
                      Un bouton micro dans la zone de saisie. Le texte s'écrit phrase après phrase ; l'envoi
                      reste manuel.
                    </div>
                  </div>
                  <div class="relative inline-flex items-center shrink-0">
                    <input
                      v-model="rg.settings.voice_input_enabled"
                      type="checkbox"
                      :disabled="!rg.voiceMicSupported"
                      class="sr-only peer"
                      @change="rg.persistVoiceInput"
                    />
                    <div class="set-switch-track peer-checked:bg-blue-600 peer-checked:border-blue-600"></div>
                  </div>
                </label>
                <label
                  v-if="rg.features.voice_tts"
                  class="set-row cursor-pointer hover:bg-white/60 transition-colors"
                >
                  <i class="ph ph-speaker-high text-slate-400 text-lg w-5"></i>
                  <div class="flex-1 min-w-0">
                    <div class="text-sm text-slate-800">Réponse vocale</div>
                    <div class="text-[11px] text-slate-500">
                      Lit les réponses à voix haute pendant qu'elles s'écrivent. Le bouton « lire » de chaque
                      message reste disponible sans cela.
                    </div>
                  </div>
                  <div class="relative inline-flex items-center shrink-0">
                    <input
                      v-model="rg.settings.voice_reply_enabled"
                      type="checkbox"
                      :disabled="!rg.voiceReadSupported"
                      class="sr-only peer"
                      @change="rg.persistVoiceReply"
                    />
                    <div class="set-switch-track peer-checked:bg-blue-600 peer-checked:border-blue-600"></div>
                  </div>
                </label>

                <label
                  v-if="rg.features.voice_tts && rg.settings.voice_reply_enabled"
                  class="set-row set-row--sub cursor-pointer hover:bg-white/60 transition-colors"
                >
                  <i class="ph ph-wrench text-slate-400 text-lg w-5"></i>
                  <div class="flex-1 min-w-0">
                    <div class="text-sm text-slate-800">Lire entre les outils</div>
                    <div class="text-[11px] text-slate-500">
                      Lit aussi ce que l'assistant annonce avant chaque appel d'outil, pas seulement la
                      réponse finale.
                    </div>
                  </div>
                  <div class="relative inline-flex items-center shrink-0">
                    <input
                      v-model="rg.settings.voice_reply_tools_enabled"
                      type="checkbox"
                      class="sr-only peer"
                      @change="rg.persistVoiceReplyTools"
                    />
                    <div class="set-switch-track peer-checked:bg-blue-600 peer-checked:border-blue-600"></div>
                  </div>
                </label>

                <p
                  v-if="rg.features.voice_stt && !rg.voiceMicSupported"
                  class="text-[11px] text-amber-700 bg-amber-50 border-t border-amber-200 px-3 py-2"
                >
                  Micro indisponible : {{ rg.voiceCompatInfo.dictee.raison }}
                </p>
                <p
                  v-if="rg.features.voice_tts && !rg.voiceReadSupported"
                  class="text-[11px] text-amber-700 bg-amber-50 border-t border-amber-200 px-3 py-2"
                >
                  {{ rg.voiceCompatInfo.lecture.raison }}
                </p>
                <p
                  v-if="rg.voiceCompatInfo.avertissement && (rg.voiceMicSupported || rg.voiceReadSupported)"
                  class="text-[11px] text-slate-500 border-t border-slate-200 px-3 py-2"
                >
                  {{ rg.voiceCompatInfo.avertissement }}
                </p>
              </div>

              <div class="bg-slate-50 rounded-xl">
                <label
                  class="set-row transition-colors rounded-xl"
                  :class="
                    rg.notifyOSSupported && rg.notifyOSSecure
                      ? 'cursor-pointer hover:bg-white/60'
                      : 'opacity-50 cursor-not-allowed'
                  "
                >
                  <i class="ph ph-bell-ringing text-slate-400 text-lg w-5"></i>
                  <div class="flex-1 min-w-0">
                    <div class="text-sm text-slate-800">Notifications système</div>
                    <div class="text-[11px] text-slate-500">
                      Affiche une notification du système d'exploitation (routines, scénarios, rapports…)
                      quand cette fenêtre n'est pas au premier plan.
                      <span v-if="!rg.notifyOSSupported" class="text-amber-600"
                        >Non supporté par ce navigateur.</span
                      >
                      <span v-else-if="!rg.notifyOSSecure" class="text-amber-600"
                        >Indisponible : nécessite HTTPS ou http://localhost (page non sécurisée).</span
                      >
                    </div>
                  </div>
                  <div class="relative inline-flex items-center shrink-0">
                    <input
                      type="checkbox"
                      class="sr-only peer"
                      :checked="rg.notifyOSEnabled"
                      :disabled="!rg.notifyOSSupported || !rg.notifyOSSecure"
                      @change="rg.toggleNotifyOS"
                    />
                    <div class="set-switch-track peer-checked:bg-blue-600 peer-checked:border-blue-600"></div>
                  </div>
                </label>
              </div>

              <div class="bg-slate-50 rounded-xl px-3.5 py-3">
                <div class="flex items-center justify-between gap-3">
                  <div class="text-xs min-w-0">
                    <div class="font-medium text-slate-700">Effacer les conversations</div>
                    <div class="text-[11px] text-slate-500">
                      Supprime tous les chats actifs — irréversible. Les archives ne sont pas affectées.
                    </div>
                  </div>
                  <button
                    class="shrink-0 px-3 py-1.5 bg-white text-red-600 border border-red-200 hover:bg-red-50 rounded-md text-xs font-medium transition-colors flex items-center gap-1"
                    @click="rg.clearAllChats"
                  >
                    <i class="ph ph-trash"></i> Effacer
                  </button>
                </div>
              </div>
            </div>

            <div v-if="rg.settingsTab === 'compaction'" class="space-y-5 max-w-xl">
              <div>
                <h3 class="text-base font-semibold text-slate-800 mb-1">Compaction</h3>
                <p class="text-xs text-slate-500">
                  Quand l'assistant résume les anciens tours pour libérer du contexte.
                </p>
              </div>

              <div class="bg-slate-50 rounded-xl">
                <label class="set-row cursor-pointer hover:bg-white/60 transition-colors rounded-xl">
                  <i class="ph ph-arrows-in-line-horizontal text-slate-400 text-lg w-5"></i>
                  <div class="flex-1 min-w-0">
                    <div class="text-sm text-slate-800">Compaction automatique</div>
                    <div class="text-[11px] text-slate-500">
                      Désactivée par défaut. Une fois activée, l'assistant résume tout seul les anciens tours
                      quand le contexte se remplit.
                    </div>
                  </div>
                  <div class="relative inline-flex items-center shrink-0">
                    <input
                      v-model="rg.settings.compression_enabled"
                      type="checkbox"
                      class="sr-only peer"
                      @change="rg.persistCompressionEnabled()"
                    />
                    <div class="set-switch-track peer-checked:bg-blue-600 peer-checked:border-blue-600"></div>
                  </div>
                </label>
              </div>

              <div v-if="rg.settings.compression_enabled" class="bg-slate-50 rounded-lg p-3.5">
                <div class="flex justify-between items-center gap-3">
                  <label for="set-compact-unit" class="text-sm text-slate-700">Seuil</label>
                  <select
                    id="set-compact-unit"
                    class="set-select set-control--sm shrink-0"
                    :value="rg.compactionUnit"
                    @change="rg.setCompactionUnit(($event.target as HTMLInputElement).value)"
                  >
                    <option value="auto">Auto</option>
                    <option value="pct">Pourcentage</option>
                    <option value="tokens">Tokens</option>
                  </select>
                </div>

                <div v-if="rg.compactionUnit === 'pct'" class="mt-3">
                  <div class="flex justify-between items-center mb-2">
                    <span class="text-[11px] text-slate-500">Part de la fenêtre</span>
                    <span
                      class="text-[11px] font-mono text-blue-600 bg-white px-2 py-0.5 rounded border border-slate-200"
                      >{{ rg.compactionPct }} %</span
                    >
                  </div>
                  <input
                    type="range"
                    min="30"
                    max="95"
                    step="5"
                    :value="rg.compactionPct"
                    class="set-range w-full"
                    @input="rg.setCompactionPct(($event.target as HTMLInputElement).value)"
                    @change="rg.persistCompactionThreshold()"
                  />
                </div>

                <div v-else-if="rg.compactionUnit === 'tokens'" class="mt-3">
                  <label for="set-compact-tokens" class="block text-[11px] text-slate-500 mb-2"
                    >Tokens de contexte</label
                  >
                  <div class="flex items-center gap-2">
                    <input
                      id="set-compact-tokens"
                      type="number"
                      min="2048"
                      max="4000000"
                      step="1000"
                      placeholder="80000"
                      :value="rg.settings.compression_threshold_tokens || ''"
                      class="set-input max-w-[9rem]"
                      @input="rg.setCompactionTokens(($event.target as HTMLInputElement).value)"
                      @change="rg.persistCompactionThreshold()"
                    />
                    <span
                      class="text-[11px] font-mono text-blue-600 bg-white px-2 py-0.5 rounded border border-slate-200"
                      >{{ rg.compactionTokensLabel }}</span
                    >
                  </div>
                </div>

                <p class="text-[11px] text-slate-500 mt-2">{{ rg.compactionThresholdHint }}</p>
              </div>

              <div v-if="rg.settings.compression_enabled" class="bg-slate-50 rounded-lg p-3.5">
                <div class="flex justify-between items-center gap-3">
                  <label for="set-compact-rounds" class="text-sm text-slate-700">Compactions max</label>
                  <select
                    id="set-compact-rounds"
                    class="set-select set-control--sm shrink-0"
                    :value="rg.compactionRoundsMode"
                    @change="rg.setCompactionRoundsMode(($event.target as HTMLInputElement).value)"
                  >
                    <option value="auto">Auto</option>
                    <option value="custom">Nombre</option>
                    <option value="unlimited">Illimité</option>
                  </select>
                </div>

                <div v-if="rg.compactionRoundsMode === 'custom'" class="mt-3">
                  <label for="set-compact-rounds-n" class="block text-[11px] text-slate-500 mb-2"
                    >Par conversation</label
                  >
                  <input
                    id="set-compact-rounds-n"
                    type="number"
                    min="1"
                    max="200"
                    step="1"
                    placeholder="24"
                    :value="
                      (rg.settings.compression_max_rounds ?? 0) > 0 ? rg.settings.compression_max_rounds : ''
                    "
                    class="set-input max-w-[6rem]"
                    @input="rg.setCompactionRounds(($event.target as HTMLInputElement).value)"
                    @change="rg.persistCompactionMaxRounds()"
                  />
                </div>

                <p class="text-[11px] text-slate-500 mt-2">{{ rg.compactionRoundsHint }}</p>
              </div>

              <div class="bg-slate-50 rounded-lg px-3.5 py-3 space-y-2">
                <div v-if="rg.settings.compression_enabled" class="flex gap-2.5 text-[11px] text-slate-500">
                  <i class="ph ph-infinity text-slate-400 text-base shrink-0"></i>
                  <span
                    >La compaction s'intercale entre deux appels d'outils : une tâche de plusieurs heures
                    tient sans jamais saturer la fenêtre.</span
                  >
                </div>
                <div class="flex gap-2.5 text-[11px] text-slate-500">
                  <i class="ph ph-terminal text-slate-400 text-base shrink-0"></i>
                  <span
                    >La commande <span class="font-mono">/compact</span> reste disponible dans tous les cas,
                    seuil ou pas.</span
                  >
                </div>
              </div>
            </div>

            <div v-if="rg.settingsTab === 'appearance'" class="space-y-5 max-w-xl">
              <div>
                <h3 class="text-base font-semibold text-slate-800 mb-1">Apparence</h3>
                <p class="text-xs text-slate-500">Identité visuelle de l'assistant dans le chat.</p>
              </div>

              <div class="bg-slate-50 rounded-xl">
                <div class="set-row">
                  <i class="ph ph-moon text-slate-400 text-lg w-5" aria-hidden="true"></i>
                  <div class="flex-1 min-w-0">
                    <div
                      id="set-theme-mode-lbl"
                      class="text-sm text-slate-800"
                      title="Système suit la préférence du poste. S'applique à tout : chat, barre latérale, fenêtres et éditeur."
                    >
                      Mode
                    </div>
                  </div>
                  <div class="adm-seg" role="radiogroup" aria-labelledby="set-theme-mode-lbl">
                    <button
                      v-for="m in [
                        { v: 'system', l: 'Système' },
                        { v: 'light', l: 'Clair' },
                        { v: 'dark', l: 'Sombre' },
                      ]"
                      :key="m.v"
                      type="button"
                      role="radio"
                      :aria-checked="rg.themeMode === m.v ? 'true' : 'false'"
                      class="adm-seg__btn"
                      :class="rg.themeMode === m.v ? 'is-active' : ''"
                      @click="rg.applyThemeMode(m.v)"
                    >
                      {{ m.l }}
                    </button>
                  </div>
                </div>
              </div>

              <div>
                <label class="block text-xs font-medium text-slate-600 mb-2" for="set-skin">Habillage</label>
                <select
                  id="set-skin"
                  class="set-select w-full"
                  :value="rg.settings.skin || ''"
                  @change="rg.settings.skin = ($event.target as HTMLInputElement).value"
                >
                  <option v-for="sk in rg.APP_SKINS" :key="sk.id || 'defaut'" :value="sk.id">
                    {{ sk.label }}
                  </option>
                </select>
                <p class="text-[11px] text-slate-500 mt-1.5 leading-snug">{{ rg.skinCourant.desc }}</p>
              </div>

              <div v-if="rg.mascottesOffertes">
                <label class="block text-xs font-medium text-slate-600 mb-2" for="set-mascotte"
                  >Mascotte</label
                >
                <div class="flex items-start gap-3">
                  <div class="flex-1 min-w-0">
                    <select
                      id="set-mascotte"
                      class="set-select w-full"
                      :value="rg.settings.welcome_mascot ?? 'boite_or'"
                      @change="rg.settings.welcome_mascot = ($event.target as HTMLInputElement).value"
                    >
                      <option v-for="m in rg.MASCOTTES" :key="m.id || 'logo'" :value="m.id">
                        {{ m.label }}
                      </option>
                    </select>

                    <label v-if="rg.mascotteId" class="flex items-start gap-2 mt-2.5 cursor-pointer">
                      <input
                        type="checkbox"
                        :checked="rg.settings.welcome_mascot_anime !== false"
                        class="mt-0.5 rounded border-slate-300 text-blue-600"
                        @change="
                          rg.settings.welcome_mascot_anime = ($event.target as HTMLInputElement).checked
                        "
                      />
                      <span class="text-[11px] text-slate-500 leading-snug">
                        Animer l'accueil.
                        <span v-if="rg.mouvementReduit" class="text-slate-400"
                          >Ton système demande moins de mouvement : décoche pour rendre la scène à
                          l'arrêt.</span
                        >
                        <span v-else class="text-slate-400"
                          >La mascotte joue autour du mot ; décoche pour une image fixe.</span
                        >
                      </span>
                    </label>
                  </div>

                  <div
                    class="w-24 h-24 shrink-0 rounded-xl border border-slate-200 bg-slate-50 flex items-center justify-center overflow-hidden"
                  >
                    <span
                      v-if="rg.mascotteId"
                      class="socle-mascotte"
                      aria-hidden="true"
                      style="width: 96px; height: 96px"
                      :data-perso="rg.mascotteId"
                      data-etat="repos"
                    ></span>
                    <img
                      v-else-if="
                        rg.welcomeConfig && rg.welcomeConfig.type === 'image' && rg.welcomeConfig.image_b64
                      "
                      :src="rg.welcomeConfig.image_b64"
                      alt=""
                      aria-hidden="true"
                      class="w-16 h-16 object-contain"
                    />
                    <i
                      v-else
                      class="ph text-5xl text-blue-500"
                      aria-hidden="true"
                      :class="(rg.welcomeConfig && rg.welcomeConfig.icon) || 'ph-sparkle'"
                    ></i>
                  </div>
                </div>
              </div>

              <div>
                <label class="block text-xs font-medium text-slate-600 mb-1.5" for="set-assistant-nom"
                  >Nom de l'assistant</label
                >
                <div class="flex items-center gap-3">
                  <img
                    :src="rg.logoApp"
                    alt=""
                    data-avatar-assistant
                    class="w-10 h-10 rounded-full object-cover shrink-0 border border-slate-200"
                  />
                  <input
                    id="set-assistant-nom"
                    v-model="rg.settings.assistant_name"
                    type="text"
                    placeholder="Assistant"
                    class="set-input font-medium text-slate-800"
                  />
                </div>
                <p class="text-[11px] text-slate-500 mt-1.5 leading-snug">
                  L'avatar de l'assistant est le logo de l'application, choisi par l'administrateur.
                </p>
              </div>
            </div>

            <div v-if="rg.settingsTab === 'features'" class="space-y-5 max-w-xl">
              <div>
                <h3 class="text-base font-semibold text-slate-800 mb-1">Fonctionnalités</h3>
                <p class="text-xs text-slate-500">
                  Ce que l'assistant peut faire. Chaque module s'active séparément.
                </p>
              </div>

              <div>
                <div class="text-[11px] font-semibold text-slate-500 px-0.5 mb-1.5">Modules</div>
                <div class="bg-slate-50 rounded-xl divide-y divide-slate-200/70">
                  <label
                    class="set-row cursor-pointer hover:bg-white/60 transition-colors first:rounded-t-xl"
                  >
                    <i class="ph ph-plug text-slate-400 text-lg w-5"></i>
                    <div class="flex-1 min-w-0">
                      <div class="text-sm text-slate-800">MCP</div>
                      <div class="text-[11px] text-slate-500">
                        Shell, fichiers, git, navigateur, serveurs MCP.
                      </div>

                      <div
                        v-if="!rg.settings.enable_mcp"
                        class="text-[11px] text-amber-600 mt-1 flex items-start gap-1"
                      >
                        <i class="ph ph-warning-circle mt-px shrink-0" aria-hidden="true"></i>
                        <span>L'assistant ne peut plus qu'écrire ; seule la mémoire reste.</span>
                      </div>
                    </div>
                    <div class="relative inline-flex items-center shrink-0">
                      <input v-model="rg.settings.enable_mcp" type="checkbox" class="sr-only peer" />
                      <div
                        class="set-switch-track peer-checked:bg-blue-600 peer-checked:border-blue-600"
                      ></div>
                    </div>
                  </label>

                  <label class="set-row cursor-pointer hover:bg-white/60 transition-colors">
                    <i class="ph ph-database text-slate-400 text-lg w-5"></i>
                    <div class="flex-1 min-w-0">
                      <div class="text-sm text-slate-800">RAG</div>
                      <div class="text-[11px] text-slate-500">
                        Cherche dans vos documents pour enrichir les réponses.
                      </div>
                    </div>
                    <div class="relative inline-flex items-center shrink-0">
                      <input v-model="rg.settings.enable_rag" type="checkbox" class="sr-only peer" />
                      <div
                        class="set-switch-track peer-checked:bg-blue-600 peer-checked:border-blue-600"
                      ></div>
                    </div>
                  </label>

                  <label
                    v-if="rg.settings.image_ready"
                    class="set-row cursor-pointer hover:bg-white/60 transition-colors"
                    data-feat-image
                  >
                    <i class="ph ph-image text-slate-400 text-lg w-5"></i>
                    <div class="flex-1 min-w-0">
                      <div class="text-sm text-slate-800">Images</div>
                      <div class="text-[11px] text-slate-500">Génération depuis le menu +.</div>
                    </div>
                    <div class="relative inline-flex items-center shrink-0">
                      <input v-model="rg.settings.image_enabled" type="checkbox" class="sr-only peer" />
                      <div
                        class="set-switch-track peer-checked:bg-blue-600 peer-checked:border-blue-600"
                      ></div>
                    </div>
                  </label>

                  <label class="set-row cursor-pointer hover:bg-white/60 transition-colors last:rounded-b-xl">
                    <i class="ph ph-code-block text-slate-400 text-lg w-5"></i>
                    <div class="flex-1 min-w-0">
                      <div class="text-sm text-slate-800">Sandbox</div>
                      <div class="text-[11px] text-slate-500">
                        Panneau de code intégré, avec arborescence de fichiers.
                      </div>
                    </div>
                    <div class="relative inline-flex items-center shrink-0">
                      <input v-model="rg.settings.enable_editor" type="checkbox" class="sr-only peer" />
                      <div
                        class="set-switch-track peer-checked:bg-blue-600 peer-checked:border-blue-600"
                      ></div>
                    </div>
                  </label>
                </div>
              </div>

              <div
                v-if="
                  rg.settings.image_ready && rg.settings.image_enabled !== false && rg.settings.image_prefs
                "
                data-feat-images
              >
                <div class="text-[11px] font-semibold text-slate-500 px-0.5 mb-1.5">Images</div>
                <div class="bg-slate-50 rounded-xl divide-y divide-slate-200/70">
                  <label
                    v-if="!rg.imageStatus || rg.imageStatus.tool_enabled !== false"
                    class="set-row cursor-pointer hover:bg-white/60 transition-colors first:rounded-t-xl"
                    title="Le modèle peut créer une image pendant une réponse (outil generate_image)."
                  >
                    <i class="ph ph-robot text-slate-400 text-lg w-5"></i>
                    <div class="flex-1 min-w-0 text-sm text-slate-800">Par le modèle</div>
                    <div class="relative inline-flex items-center shrink-0">
                      <input v-model="rg.settings.image_tool_enabled" type="checkbox" class="sr-only peer" />
                      <div
                        class="set-switch-track peer-checked:bg-blue-600 peer-checked:border-blue-600"
                      ></div>
                    </div>
                  </label>
                  <div v-if="!rg.imageFixedSizes.length" class="set-row" data-pref-ratio>
                    <i class="ph ph-crop text-slate-400 text-lg w-5"></i>
                    <div class="flex-1 min-w-0 text-sm text-slate-800">Format</div>
                    <div class="flex items-center gap-1 shrink-0" role="group" aria-label="Format">
                      <button
                        v-for="r in rg.imageBaseRatios"
                        :key="r"
                        type="button"
                        class="elpis-img-chip"
                        :aria-pressed="
                          rg.imageBaseRatio(rg.settings.image_prefs.ratio) === r ? 'true' : 'false'
                        "
                        :title="r === '1:1' ? 'Carré' : r"
                        @click="rg.setPrefRatio(r)"
                      >
                        <span
                          class="elpis-img-ratio"
                          :style="
                            rg.ratioBox(
                              rg.imageIsPortrait(rg.settings.image_prefs.ratio) ? rg.imageFlipRatio(r) : r,
                            )
                          "
                          aria-hidden="true"
                        ></span>
                      </button>
                      <button
                        type="button"
                        class="elpis-img-chip elpis-img-chip--icon"
                        :disabled="rg.settings.image_prefs.ratio === '1:1'"
                        :aria-pressed="rg.imageIsPortrait(rg.settings.image_prefs.ratio) ? 'true' : 'false'"
                        title="Portrait / paysage"
                        aria-label="Basculer portrait ou paysage"
                        @click="rg.flipPrefRatio()"
                      >
                        <i class="ph ph-arrows-left-right" aria-hidden="true"></i>
                      </button>
                    </div>
                  </div>
                  <div v-if="!rg.imageFixedSizes.length && rg.imageSides.length > 1" class="set-row">
                    <i class="ph ph-arrows-out text-slate-400 text-lg w-5"></i>
                    <div class="flex-1 min-w-0 text-sm text-slate-800">Taille</div>
                    <select
                      v-model.number="rg.settings.image_prefs.side"
                      class="set-select shrink-0 w-28 font-mono text-xs"
                      aria-label="Taille"
                      title="Plus grand côté"
                    >
                      <option v-for="v in rg.imageSides" :key="v" :value="v">{{ v }} px</option>
                    </select>
                  </div>
                  <div v-if="rg.imageMaxN > 1" class="set-row">
                    <i class="ph ph-squares-four text-slate-400 text-lg w-5"></i>
                    <div class="flex-1 min-w-0 text-sm text-slate-800">Nombre</div>
                    <select
                      v-model.number="rg.settings.image_prefs.n"
                      class="set-select shrink-0 w-28 font-mono text-xs"
                      aria-label="Nombre d’images"
                    >
                      <option v-for="k in rg.imageMaxN" :key="k" :value="k">×{{ k }}</option>
                    </select>
                  </div>
                  <label
                    v-if="!rg.imageStatus || rg.imageStatus.enhance_enabled !== false"
                    class="set-row cursor-pointer hover:bg-white/60 transition-colors"
                    title="Le modèle du chat réécrit la description avant l'envoi au moteur."
                  >
                    <i class="ph ph-magic-wand text-slate-400 text-lg w-5"></i>
                    <div class="flex-1 min-w-0 text-sm text-slate-800">Enrichir</div>
                    <div class="relative inline-flex items-center shrink-0">
                      <input v-model="rg.settings.image_prefs.enhance" type="checkbox" class="sr-only peer" />
                      <div
                        class="set-switch-track peer-checked:bg-blue-600 peer-checked:border-blue-600"
                      ></div>
                    </div>
                  </label>
                  <div
                    v-if="rg.imageStatus && rg.imageStatus.keep_per_user"
                    class="set-row last:rounded-b-xl"
                    data-pref-stored
                  >
                    <i class="ph ph-images text-slate-400 text-lg w-5"></i>
                    <div
                      class="flex-1 min-w-0 text-sm text-slate-800"
                      title="Les plus anciennes sont effacées au-delà de cette limite."
                    >
                      Conservées
                    </div>
                    <span class="text-xs text-slate-500 font-mono tabular-nums shrink-0"
                      >{{ rg.imageStatus.stored || 0 }}/{{ rg.imageStatus.keep_per_user }}</span
                    >
                    <button
                      type="button"
                      class="elpis-img-chip shrink-0"
                      data-pref-gallery
                      @click="rg.openImageGallery('all')"
                    >
                      <i class="ph ph-images" aria-hidden="true"></i><span>Galerie</span>
                    </button>
                  </div>
                </div>
              </div>

              <template v-if="rg.settings.enable_editor">
                <div data-feat-editor-display>
                  <div class="text-[11px] font-semibold text-slate-500 px-0.5 mb-1.5">
                    Éditeur · affichage
                  </div>
                  <div class="bg-slate-50 rounded-xl divide-y divide-slate-200/70">
                    <label
                      class="set-row cursor-pointer hover:bg-white/60 transition-colors first:rounded-t-xl"
                    >
                      <i class="ph ph-paint-roller text-slate-400 text-lg w-5"></i>
                      <div class="flex-1 min-w-0">
                        <div class="text-sm text-slate-800">Thème sombre</div>
                        <div class="text-[11px] text-slate-500">Indépendant du mode sombre de la page.</div>
                      </div>
                      <div class="relative inline-flex items-center shrink-0">
                        <input v-model="rg.settings.editor_dark_mode" type="checkbox" class="sr-only peer" />
                        <div
                          class="set-switch-track peer-checked:bg-blue-600 peer-checked:border-blue-600"
                        ></div>
                      </div>
                    </label>

                    <div class="set-row">
                      <i class="ph ph-text-aa text-slate-400 text-lg w-5"></i>
                      <div class="flex-1 min-w-0 text-sm text-slate-800">Taille de police</div>
                      <div class="shrink-0 flex items-center gap-2">
                        <input
                          v-model.number="rg.settings.editor_font_size"
                          type="range"
                          min="10"
                          max="24"
                          step="1"
                          aria-label="Taille de police de l'éditeur"
                          class="set-range w-28"
                        />
                        <span
                          class="text-[11px] font-mono tabular-nums text-blue-600 bg-white px-1.5 rounded border border-slate-200"
                          >{{ rg.settings.editor_font_size || 14 }}px</span
                        >
                      </div>
                    </div>

                    <div class="set-row">
                      <i class="ph ph-text-t text-slate-400 text-lg w-5"></i>
                      <div class="flex-1 min-w-0 text-sm text-slate-800">Police</div>
                      <select
                        v-model="rg.settings.editor_font_family"
                        aria-label="Police de l'éditeur"
                        class="set-select set-control--sm shrink-0"
                      >
                        <option value="JetBrains Mono">JetBrains Mono</option>
                        <option value="Fira Code">Fira Code</option>
                        <option value="Cascadia Code">Cascadia Code</option>
                        <option value="Consolas">Consolas</option>
                        <option value="Menlo">Menlo</option>
                        <option value="Monaco">Monaco</option>
                        <option value="monospace">Système</option>
                      </select>
                    </div>

                    <div class="set-row">
                      <i class="ph ph-arrows-in-line-horizontal text-slate-400 text-lg w-5"></i>
                      <div class="flex-1 min-w-0 text-sm text-slate-800">Retour à la ligne</div>
                      <select
                        v-model="rg.settings.editor_word_wrap"
                        aria-label="Retour à la ligne"
                        class="set-select set-control--sm shrink-0"
                      >
                        <option value="off">Aucun</option>
                        <option value="on">Activé</option>
                        <option value="bounded">Limité</option>
                      </select>
                    </div>

                    <div class="set-row">
                      <i class="ph ph-arrow-bend-down-right text-slate-400 text-lg w-5"></i>
                      <div class="flex-1 min-w-0 text-sm text-slate-800">Indentation</div>
                      <div class="shrink-0 flex items-center gap-1.5">
                        <select
                          v-model.number="rg.settings.editor_tab_size"
                          aria-label="Largeur d'indentation"
                          class="set-select set-control--sm"
                        >
                          <option :value="2">2</option>
                          <option :value="4">4</option>
                          <option :value="8">8</option>
                        </select>
                        <select
                          v-model="rg.settings.editor_insert_spaces"
                          aria-label="Caractère d'indentation"
                          class="set-select set-control--sm"
                        >
                          <option :value="true">espaces</option>
                          <option :value="false">tabulations</option>
                        </select>
                      </div>
                    </div>

                    <label class="set-row cursor-pointer hover:bg-white/60 transition-colors">
                      <i class="ph ph-map-trifold text-slate-400 text-lg w-5"></i>
                      <div class="flex-1 min-w-0">
                        <div class="text-sm text-slate-800">Minimap</div>
                        <div class="text-[11px] text-slate-500">Aperçu du fichier dans la marge droite.</div>
                      </div>
                      <div class="relative inline-flex items-center shrink-0">
                        <input v-model="rg.settings.editor_minimap" type="checkbox" class="sr-only peer" />
                        <div
                          class="set-switch-track peer-checked:bg-blue-600 peer-checked:border-blue-600"
                        ></div>
                      </div>
                    </label>

                    <label
                      class="set-row cursor-pointer hover:bg-white/60 transition-colors last:rounded-b-xl"
                    >
                      <i class="ph ph-list-numbers text-slate-400 text-lg w-5"></i>
                      <div class="flex-1 min-w-0 text-sm text-slate-800">Numéros de ligne</div>
                      <div class="relative inline-flex items-center shrink-0">
                        <input
                          v-model="rg.settings.editor_line_numbers"
                          type="checkbox"
                          class="sr-only peer"
                        />
                        <div
                          class="set-switch-track peer-checked:bg-blue-600 peer-checked:border-blue-600"
                        ></div>
                      </div>
                    </label>
                  </div>
                </div>

                <div data-feat-editor-behavior>
                  <div class="text-[11px] font-semibold text-slate-500 px-0.5 mb-1.5">
                    Éditeur · comportement
                  </div>
                  <div class="bg-slate-50 rounded-xl divide-y divide-slate-200/70">
                    <label
                      class="set-row cursor-pointer hover:bg-white/60 transition-colors first:rounded-t-xl"
                    >
                      <i class="ph ph-magic-wand text-slate-400 text-lg w-5"></i>
                      <div class="flex-1 min-w-0">
                        <div class="text-sm text-slate-800">Ouverture automatique</div>
                        <div class="text-[11px] text-slate-500">
                          Ouvre l'éditeur quand l'assistant écrit un fichier.
                        </div>
                      </div>
                      <div class="relative inline-flex items-center shrink-0">
                        <input
                          v-model="rg.settings.auto_open_editor_on_write"
                          type="checkbox"
                          class="sr-only peer"
                        />
                        <div
                          class="set-switch-track peer-checked:bg-blue-600 peer-checked:border-blue-600"
                        ></div>
                      </div>
                    </label>

                    <label class="set-row cursor-pointer hover:bg-white/60 transition-colors">
                      <i class="ph ph-eye text-slate-400 text-lg w-5"></i>
                      <div class="flex-1 min-w-0">
                        <div class="text-sm text-slate-800">Aperçu</div>
                        <div class="text-[11px] text-slate-500">Onglet d'exécution HTML/JS.</div>
                      </div>
                      <div class="relative inline-flex items-center shrink-0">
                        <input v-model="rg.settings.enable_preview" type="checkbox" class="sr-only peer" />
                        <div
                          class="set-switch-track peer-checked:bg-blue-600 peer-checked:border-blue-600"
                        ></div>
                      </div>
                    </label>

                    <label class="set-row cursor-pointer hover:bg-white/60 transition-colors">
                      <i class="ph ph-highlighter text-slate-400 text-lg w-5"></i>
                      <div class="flex-1 min-w-0">
                        <div class="text-sm text-slate-800">Surbrillance des modifications</div>
                        <div class="text-[11px] text-slate-500">
                          Teinte brièvement les lignes éditées par l'assistant.
                        </div>
                      </div>
                      <div class="relative inline-flex items-center shrink-0">
                        <input
                          v-model="rg.settings.editor_edit_highlight"
                          type="checkbox"
                          class="sr-only peer"
                        />
                        <div
                          class="set-switch-track peer-checked:bg-blue-600 peer-checked:border-blue-600"
                        ></div>
                      </div>
                    </label>

                    <div class="set-row">
                      <i class="ph ph-floppy-disk text-slate-400 text-lg w-5"></i>
                      <div class="flex-1 min-w-0 text-sm text-slate-800">Sauvegarde automatique</div>
                      <select
                        v-model="rg.settings.editor_auto_save"
                        aria-label="Sauvegarde automatique"
                        class="set-select set-control--sm shrink-0"
                      >
                        <option value="off">Désactivée</option>
                        <option value="30s">Après 30 s sans frappe</option>
                        <option value="1min">Après 1 min sans frappe</option>
                        <option value="2min">Après 2 min sans frappe</option>
                        <option value="on_blur">À la perte du focus</option>
                      </select>
                    </div>

                    <label class="set-row cursor-pointer hover:bg-white/60 transition-colors">
                      <i class="ph ph-crosshair text-slate-400 text-lg w-5"></i>
                      <div class="flex-1 min-w-0">
                        <div class="text-sm text-slate-800">Suivre le fichier ouvert</div>
                        <div class="text-[11px] text-slate-500">
                          L'arbre se positionne sur l'onglet actif.
                        </div>
                      </div>
                      <div class="relative inline-flex items-center shrink-0">
                        <input
                          v-model="rg.settings.editor_follow_active"
                          type="checkbox"
                          class="sr-only peer"
                        />
                        <div
                          class="set-switch-track peer-checked:bg-blue-600 peer-checked:border-blue-600"
                        ></div>
                      </div>
                    </label>

                    <label
                      class="set-row cursor-pointer hover:bg-white/60 transition-colors last:rounded-b-xl"
                    >
                      <i class="ph ph-browsers text-slate-400 text-lg w-5"></i>
                      <div class="flex-1 min-w-0">
                        <div class="text-sm text-slate-800">Mémoriser les onglets</div>
                        <div class="text-[11px] text-slate-500">
                          Rouvre ceux de la dernière session, curseur compris.
                        </div>
                      </div>
                      <div class="relative inline-flex items-center shrink-0">
                        <input
                          v-model="rg.settings.editor_persist_tabs"
                          type="checkbox"
                          class="sr-only peer"
                        />
                        <div
                          class="set-switch-track peer-checked:bg-blue-600 peer-checked:border-blue-600"
                        ></div>
                      </div>
                    </label>
                  </div>
                </div>
              </template>

              <p class="text-[11px] text-slate-500">
                <i class="ph ph-info text-slate-400 align-middle mr-1" aria-hidden="true"></i>Mémoire et
                sous-agents s'activent depuis
                <button
                  class="underline underline-offset-2 hover:text-slate-700 transition-colors"
                  @click="
                    rg.settingsTab = 'memory';
                    rg.loadUserMemory();
                  "
                >
                  Mémoire
                </button>
                et
                <button
                  class="underline underline-offset-2 hover:text-slate-700 transition-colors"
                  @click="
                    rg.settingsTab = 'agents';
                    rg.loadMcpUserCategories();
                    rg.loadAgentTemplates();
                  "
                >
                  Agents</button
                >.
              </p>
            </div>

            <div v-if="rg.settingsTab === 'prompts'" class="space-y-4 max-w-2xl">
              <div class="flex items-center justify-between gap-3">
                <div class="min-w-0">
                  <h3 class="text-base font-semibold text-slate-800 mb-0.5">Prompts</h3>
                  <p v-if="rg.promptsView === 'saved'" class="text-xs text-slate-500" data-prompt-count>
                    <template v-if="rg.promptSearch.trim()">
                      {{ rg.promptsAffiches.length }} sur {{ rg.savedPromptsList.length }}.
                    </template>
                    <template v-else>
                      {{ rg.savedPromptsList.length }} prompt{{
                        rg.savedPromptsList.length > 1 ? "s" : ""
                      }}
                      sauvegardé{{ rg.savedPromptsList.length > 1 ? "s" : "" }}.
                    </template>
                  </p>
                  <p v-else class="text-xs text-slate-500" data-template-count>
                    <template v-if="rg.templateSearch.trim()">
                      {{ rg.templatesAffiches.length }} sur {{ rg.templatesList.length }}.
                    </template>
                    <template v-else>
                      {{ rg.templatesList.length }} template{{ rg.templatesList.length > 1 ? "s" : "" }} ·
                      <span class="font-mono">/template</span>
                    </template>
                  </p>
                </div>
                <div class="shrink-0 flex items-center gap-2">
                  <div
                    role="tablist"
                    aria-label="Type de prompts"
                    class="inline-flex bg-slate-100 rounded-lg p-0.5"
                    data-prompts-view
                  >
                    <button
                      type="button"
                      role="tab"
                      :aria-selected="rg.promptsView === 'saved' ? 'true' : 'false'"
                      data-prompts-view-saved
                      :class="
                        rg.promptsView === 'saved'
                          ? 'bg-white text-slate-800 shadow-sm'
                          : 'text-slate-500 hover:text-slate-700'
                      "
                      class="px-2.5 py-1 rounded-md text-xs font-medium transition-colors"
                      @click="rg.promptsView = 'saved'"
                    >
                      Sauvegardés
                    </button>
                    <button
                      type="button"
                      role="tab"
                      :aria-selected="rg.promptsView === 'templates' ? 'true' : 'false'"
                      data-prompts-view-templates
                      :class="
                        rg.promptsView === 'templates'
                          ? 'bg-white text-slate-800 shadow-sm'
                          : 'text-slate-500 hover:text-slate-700'
                      "
                      class="px-2.5 py-1 rounded-md text-xs font-medium transition-colors"
                      @click="
                        rg.promptsView = 'templates';
                        rg.loadPromptTemplates();
                      "
                    >
                      Templates
                    </button>
                  </div>
                  <button
                    aria-label="Rafraîchir"
                    title="Rafraîchir"
                    class="text-xs text-slate-500 hover:text-slate-700 px-2 py-1 rounded-md hover:bg-slate-100 transition-colors flex items-center gap-1.5"
                    @click="rg.promptsView === 'saved' ? rg.loadSavedPrompts() : rg.loadPromptTemplates()"
                  >
                    <i class="ph ph-arrow-clockwise" aria-hidden="true"></i>
                  </button>
                </div>
              </div>

              <template v-if="rg.promptsView === 'saved'">
                <div v-if="rg.savedPromptsList.length" class="flex items-center gap-2">
                  <div class="relative flex-1 min-w-0">
                    <i
                      class="ph ph-magnifying-glass absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400 text-sm pointer-events-none"
                      aria-hidden="true"
                    ></i>
                    <input
                      v-model="rg.promptSearch"
                      type="search"
                      data-prompt-search
                      placeholder="Rechercher un titre ou un contenu…"
                      aria-label="Rechercher un prompt"
                      class="set-input set-control--sm pl-8"
                    />
                  </div>
                  <select
                    v-model="rg.promptSort"
                    data-prompt-sort
                    aria-label="Trier les prompts"
                    class="set-select set-control--sm shrink-0"
                  >
                    <option value="recent">Plus récents</option>
                    <option value="ancien">Plus anciens</option>
                    <option value="titre">Titre A→Z</option>
                  </select>
                </div>

                <div v-if="rg.savedPromptsList.length === 0" class="text-center p-10 bg-slate-50 rounded-xl">
                  <i class="ph ph-bookmark-simple text-3xl text-slate-300 block mb-2"></i>
                  <p class="text-sm text-slate-500">Aucun prompt sauvegardé.</p>
                </div>
                <div
                  v-else-if="rg.promptsAffiches.length === 0"
                  class="text-center p-8 bg-slate-50 rounded-xl"
                  data-prompt-empty
                >
                  <i class="ph ph-magnifying-glass text-2xl text-slate-300 block mb-2"></i>
                  <p class="text-sm text-slate-500">
                    Aucun prompt ne correspond à « {{ rg.promptSearch.trim() }} ».
                  </p>
                </div>

                <div v-else class="bg-slate-50 rounded-xl divide-y divide-slate-200/70 overflow-hidden">
                  <div v-for="p in rg.promptsAffiches" :key="p.id" data-prompt-item>
                    <div
                      class="flex items-center gap-2.5 px-3 py-2.5 group cursor-pointer hover:bg-white/60 transition-colors"
                      role="button"
                      tabindex="0"
                      :aria-expanded="rg.promptOpen[p.id] ? 'true' : 'false'"
                      @click="rg.togglePrompt(p.id)"
                      @keydown.enter.prevent="rg.togglePrompt(p.id)"
                      @keydown.space.prevent="rg.togglePrompt(p.id)"
                    >
                      <i
                        class="ph ph-caret-right text-slate-400 text-sm shrink-0 transition-transform"
                        :class="rg.promptOpen[p.id] ? 'rotate-90' : ''"
                        aria-hidden="true"
                      ></i>
                      <div class="flex-1 min-w-0">
                        <div class="text-sm text-slate-800 truncate">{{ p.title }}</div>

                        <div
                          v-if="rg.promptExtrait(p)"
                          class="text-[11px] text-slate-500 font-mono truncate"
                          data-prompt-excerpt
                        >
                          {{ rg.promptExtrait(p) }}
                        </div>
                      </div>
                      <span
                        class="text-[11px] text-slate-400 tabular-nums shrink-0"
                        data-prompt-date
                        :title="rg.promptDateFull(p.created_at)"
                        >{{ rg.promptDate(p.created_at) }}</span
                      >

                      <div
                        class="flex gap-1 shrink-0 opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto group-focus-within:opacity-100 group-focus-within:pointer-events-auto transition-opacity"
                      >
                        <button
                          title="Insérer"
                          class="px-2 py-1 text-[11px] font-medium bg-white border border-slate-200 hover:bg-blue-50 hover:border-blue-200 hover:text-blue-600 text-slate-600 rounded-md flex items-center gap-1 transition-colors"
                          @click.stop="rg.usePrompt(p.content)"
                        >
                          <i class="ph ph-arrow-bend-up-left text-[10px]" aria-hidden="true"></i> Insérer
                        </button>

                        <button
                          title="Copier"
                          aria-label="Copier le prompt"
                          data-prompt-copy
                          class="w-6 h-6 flex items-center justify-center bg-white border border-slate-200 hover:bg-blue-50 hover:border-blue-200 hover:text-blue-600 text-slate-500 rounded-md transition-colors"
                          @click.stop="rg.copyPrompt(p.content)"
                        >
                          <i class="ph ph-copy text-[10px]" aria-hidden="true"></i>
                        </button>
                        <button
                          title="En faire un template"
                          aria-label="En faire un template"
                          data-prompt-to-template
                          class="w-6 h-6 flex items-center justify-center bg-white border border-slate-200 hover:bg-blue-50 hover:border-blue-200 hover:text-blue-600 text-slate-500 rounded-md transition-colors"
                          @click.stop="rg.templateFromPrompt(p)"
                        >
                          <i class="ph ph-brackets-curly text-[10px]" aria-hidden="true"></i>
                        </button>
                        <button
                          title="Partager"
                          aria-label="Partager le prompt"
                          class="w-6 h-6 flex items-center justify-center bg-white border border-slate-200 hover:bg-blue-50 hover:border-blue-200 hover:text-blue-600 text-slate-500 rounded-md transition-colors"
                          @click.stop.prevent="rg.openShareModal(p)"
                        >
                          <i class="ph ph-share-network text-[10px]" aria-hidden="true"></i>
                        </button>
                        <button
                          title="Supprimer"
                          aria-label="Supprimer le prompt"
                          class="w-6 h-6 flex items-center justify-center bg-white border border-slate-200 hover:bg-red-50 hover:border-red-200 hover:text-red-600 text-slate-500 rounded-md transition-colors"
                          @click.stop="rg.deleteSavedPrompt(p.id, p.title)"
                        >
                          <i class="ph ph-trash text-[10px]" aria-hidden="true"></i>
                        </button>
                      </div>
                    </div>

                    <div v-if="rg.promptOpen[p.id]" class="px-3 pb-3 pl-9" data-prompt-body>
                      <pre
                        class="m-0 bg-white border border-slate-200 rounded-lg p-2.5 text-[12px] leading-relaxed text-slate-700 font-mono whitespace-pre-wrap break-words max-h-72 overflow-y-auto custom-scrollbar"
                        >{{ p.content }}</pre>
                    </div>
                  </div>
                </div>
              </template>

              <template v-else>
                <div class="flex items-center gap-2">
                  <div v-if="rg.templatesList.length" class="relative flex-1 min-w-0">
                    <i
                      class="ph ph-magnifying-glass absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400 text-sm pointer-events-none"
                      aria-hidden="true"
                    ></i>
                    <input
                      v-model="rg.templateSearch"
                      type="search"
                      data-template-search
                      placeholder="Rechercher un template…"
                      aria-label="Rechercher un template"
                      class="set-input set-control--sm pl-8"
                    />
                  </div>
                  <button
                    v-if="!rg.templateForm"
                    type="button"
                    data-template-new
                    class="ml-auto shrink-0 px-2.5 py-1.5 bg-blue-600 hover:bg-blue-700 rounded-md text-xs font-medium text-white transition-colors inline-flex items-center gap-1.5"
                    @click="rg.startNewTemplate()"
                  >
                    <i class="ph ph-plus" aria-hidden="true"></i> Nouveau
                  </button>
                </div>

                <div v-if="rg.templateForm" class="bg-slate-50 rounded-xl p-3 space-y-2.5" data-template-form>
                  <div class="flex gap-2">
                    <div class="w-40 shrink-0">
                      <label for="tpl-name" class="text-[11px] font-medium text-slate-500 block mb-1"
                        >Raccourci</label
                      >
                      <div class="relative">
                        <span
                          class="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400 text-xs font-mono pointer-events-none"
                          aria-hidden="true"
                          >/</span
                        >
                        <input
                          id="tpl-name"
                          v-model="rg.templateForm.name"
                          data-template-name
                          placeholder="resume"
                          maxlength="40"
                          autocomplete="off"
                          spellcheck="false"
                          class="set-input set-control--sm font-mono pl-6"
                        />
                      </div>
                    </div>
                    <div class="flex-1 min-w-0">
                      <label for="tpl-title" class="text-[11px] font-medium text-slate-500 block mb-1"
                        >Titre</label
                      >
                      <input
                        id="tpl-title"
                        v-model="rg.templateForm.title"
                        data-template-title
                        placeholder="Résumé d'un texte"
                        maxlength="120"
                        class="set-input set-control--sm"
                        @blur="rg.templateTitleBlur()"
                      />
                    </div>
                  </div>
                  <div>
                    <div class="flex items-center justify-between mb-1">
                      <label for="tpl-content" class="text-[11px] font-medium text-slate-500">Contenu</label>
                      <i
                        class="ph ph-question text-slate-400 text-sm cursor-default"
                        :title="rg.templateSyntaxHelp"
                        role="img"
                        aria-label="Syntaxe des variables"
                        data-template-help
                      ></i>
                    </div>
                    <textarea
                      id="tpl-content"
                      v-model="rg.templateForm.content"
                      rows="7"
                      data-template-content
                      spellcheck="false"
                      :placeholder="'Résume {{texte | textarea}} en {{langue | select:options=[\u0022français\u0022,\u0022anglais\u0022]}}.'"
                      class="set-textarea font-mono text-[12px] leading-relaxed"
                    ></textarea>
                  </div>
                  <div class="flex items-center gap-1.5 flex-wrap text-[11px]" data-template-vars>
                    <span class="text-slate-500">Variables</span>
                    <span
                      v-for="v in rg.templateFormVars.vars"
                      :key="'v' + v.name"
                      :title="v.type + (v.required ? ' · requis' : '')"
                      class="px-1.5 py-0.5 rounded bg-white border border-slate-200 font-mono text-slate-600"
                      >{{ v.name }}</span
                    >
                    <span
                      v-for="k in rg.templateFormVars.system"
                      :key="'s' + k"
                      title="Remplie automatiquement"
                      class="px-1.5 py-0.5 rounded bg-blue-50 text-blue-600 font-mono"
                      >{{ k }}</span
                    >
                    <span
                      v-if="!rg.templateFormVars.vars.length && !rg.templateFormVars.system.length"
                      class="text-slate-400"
                      >aucune</span
                    >
                  </div>
                  <p
                    v-if="rg.templateFormError"
                    class="text-xs text-red-600"
                    role="alert"
                    data-template-error
                  >
                    {{ rg.templateFormError }}
                  </p>
                  <div class="flex justify-end gap-2">
                    <button
                      type="button"
                      :disabled="rg.templateSaving"
                      data-template-cancel
                      class="px-2.5 py-1.5 bg-white border border-slate-200 hover:bg-slate-50 disabled:opacity-50 rounded-md text-xs font-medium text-slate-600 transition-colors"
                      @click="rg.cancelTemplateEdit()"
                    >
                      Annuler
                    </button>
                    <button
                      type="button"
                      :disabled="rg.templateSaving"
                      data-template-save
                      class="px-2.5 py-1.5 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 rounded-md text-xs font-medium text-white transition-colors inline-flex items-center gap-1.5"
                      @click="rg.saveTemplate()"
                    >
                      <i
                        class="ph"
                        :class="rg.templateSaving ? 'ph-spinner-gap animate-spin' : 'ph-check'"
                        aria-hidden="true"
                      ></i>
                      Enregistrer
                    </button>
                  </div>
                </div>

                <div
                  v-if="!rg.templatesList.length && !rg.templateForm"
                  class="text-center p-10 bg-slate-50 rounded-xl"
                  data-template-empty
                >
                  <i class="ph ph-brackets-curly text-3xl text-slate-300 block mb-2" aria-hidden="true"></i>
                  <p class="text-sm text-slate-500">Aucun template.</p>
                </div>
                <div
                  v-else-if="rg.templatesList.length && !rg.templatesAffiches.length"
                  class="text-center p-8 bg-slate-50 rounded-xl"
                >
                  <i class="ph ph-magnifying-glass text-2xl text-slate-300 block mb-2" aria-hidden="true"></i>
                  <p class="text-sm text-slate-500">
                    Aucun template ne correspond à « {{ rg.templateSearch.trim() }} ».
                  </p>
                </div>
                <div
                  v-else-if="rg.templatesAffiches.length"
                  class="bg-slate-50 rounded-xl divide-y divide-slate-200/70 overflow-hidden"
                >
                  <div v-for="t in rg.templatesAffiches" :key="t.id" data-template-item>
                    <div
                      class="flex items-center gap-2.5 px-3 py-2.5 group cursor-pointer hover:bg-white/60 transition-colors"
                      role="button"
                      tabindex="0"
                      :aria-expanded="rg.templateOpen[t.id] ? 'true' : 'false'"
                      @click="rg.toggleTemplate(t.id)"
                      @keydown.enter.prevent="rg.toggleTemplate(t.id)"
                      @keydown.space.prevent="rg.toggleTemplate(t.id)"
                    >
                      <i
                        class="ph ph-caret-right text-slate-400 text-sm shrink-0 transition-transform"
                        :class="rg.templateOpen[t.id] ? 'rotate-90' : ''"
                        aria-hidden="true"
                      ></i>
                      <span class="font-mono text-xs text-blue-600 shrink-0">/{{ t.name }}</span>
                      <span class="flex-1 min-w-0 text-sm text-slate-800 truncate">{{ t.title }}</span>
                      <span
                        v-if="rg.templateVarsOf(t).vars.length"
                        class="text-[11px] text-slate-400 tabular-nums shrink-0"
                        :title="
                          rg
                            .templateVarsOf(t)
                            .vars.map((v) => v.name)
                            .join(', ')
                        "
                        >{{ rg.templateVarsOf(t).vars.length }} var.</span
                      >
                      <div
                        class="flex gap-1 shrink-0 opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto group-focus-within:opacity-100 group-focus-within:pointer-events-auto transition-opacity"
                      >
                        <button
                          title="Insérer"
                          data-template-insert-row
                          class="px-2 py-1 text-[11px] font-medium bg-white border border-slate-200 hover:bg-blue-50 hover:border-blue-200 hover:text-blue-600 text-slate-600 rounded-md flex items-center gap-1 transition-colors"
                          @click.stop="rg.insertTemplate(t)"
                        >
                          <i class="ph ph-arrow-bend-up-left text-[10px]" aria-hidden="true"></i> Insérer
                        </button>
                        <button
                          title="Éditer"
                          aria-label="Éditer le template"
                          data-template-edit
                          class="w-6 h-6 flex items-center justify-center bg-white border border-slate-200 hover:bg-blue-50 hover:border-blue-200 hover:text-blue-600 text-slate-500 rounded-md transition-colors"
                          @click.stop="rg.editTemplate(t)"
                        >
                          <i class="ph ph-pencil-simple text-[10px]" aria-hidden="true"></i>
                        </button>
                        <button
                          title="Supprimer"
                          aria-label="Supprimer le template"
                          data-template-delete
                          class="w-6 h-6 flex items-center justify-center bg-white border border-slate-200 hover:bg-red-50 hover:border-red-200 hover:text-red-600 text-slate-500 rounded-md transition-colors"
                          @click.stop="rg.deleteTemplate(t)"
                        >
                          <i class="ph ph-trash text-[10px]" aria-hidden="true"></i>
                        </button>
                      </div>
                    </div>
                    <div v-if="rg.templateOpen[t.id]" class="px-3 pb-3 pl-9" data-template-body>
                      <pre
                        class="m-0 bg-white border border-slate-200 rounded-lg p-2.5 text-[12px] leading-relaxed text-slate-700 font-mono whitespace-pre-wrap break-words max-h-72 overflow-y-auto custom-scrollbar"
                        >{{ t.content }}</pre>
                    </div>
                  </div>
                </div>
              </template>
            </div>

            <div v-if="rg.settingsTab === 'archives'" class="space-y-4 max-w-2xl">
              <div class="flex items-center justify-between">
                <div>
                  <h3 class="text-base font-semibold text-slate-800 mb-0.5">Archives</h3>
                  <p class="text-xs text-slate-500">
                    {{ rg.archivesList.length }} conversation{{
                      rg.archivesList.length > 1 ? "s" : ""
                    }}
                    archivée{{ rg.archivesList.length > 1 ? "s" : "" }}.
                  </p>
                </div>
                <div class="flex gap-1.5">
                  <button
                    v-if="rg.archivesList.length > 0"
                    class="text-xs px-2 py-1 rounded-md transition-colors"
                    :class="
                      rg.archiveSelectMode ? 'text-white bg-blue-600' : 'text-slate-500 hover:bg-slate-100'
                    "
                    @click="
                      rg.archiveSelectMode = !rg.archiveSelectMode;
                      rg.archiveSelected = [];
                    "
                  >
                    <i class="ph" :class="rg.archiveSelectMode ? 'ph-x' : 'ph-check-square'"></i>
                    {{ rg.archiveSelectMode ? "Annuler" : "Sélection" }}
                  </button>
                  <button
                    v-if="rg.archiveSelectMode && rg.archiveSelected.length > 0"
                    class="text-xs text-slate-600 bg-slate-100 hover:bg-slate-200 px-2 py-1 rounded-md transition-colors"
                    title="Restaurer la sélection"
                    aria-label="Restaurer la sélection"
                    @click="rg.unarchiveSelectedArchives"
                  >
                    <i class="ph ph-arrow-u-up-left" aria-hidden="true"></i> Restaurer
                    {{ rg.archiveSelected.length }}
                  </button>
                  <button
                    v-if="rg.archiveSelectMode && rg.archiveSelected.length > 0"
                    class="text-xs text-red-600 bg-red-50 hover:bg-red-100 px-2 py-1 rounded-md transition-colors"
                    title="Supprimer la sélection"
                    aria-label="Supprimer la sélection"
                    @click="rg.deleteSelectedArchives"
                  >
                    <i class="ph ph-trash" aria-hidden="true"></i> Supprimer {{ rg.archiveSelected.length }}
                  </button>
                  <button
                    aria-label="Rafraîchir les archives"
                    class="text-xs text-slate-500 hover:text-slate-700 px-2 py-1 rounded-md hover:bg-slate-100 transition-colors"
                    @click="rg.loadArchives"
                  >
                    <i class="ph ph-arrow-clockwise" aria-hidden="true"></i>
                  </button>
                </div>
              </div>
              <div v-if="rg.archivesList.length === 0" class="text-center p-10 bg-slate-50 rounded-xl">
                <i class="ph ph-archive text-3xl text-slate-300 block mb-2"></i>
                <p class="text-sm text-slate-500">Aucune archive.</p>
              </div>
              <div v-else class="space-y-1.5">
                <div
                  v-for="c in rg.archivesList"
                  :key="c.id"
                  class="bg-slate-50 hover:bg-white border rounded-lg p-3 flex items-center gap-3 group transition-colors"
                  :class="
                    rg.archiveSelected.includes(c.id)
                      ? 'border-blue-300 bg-blue-50/50'
                      : 'border-transparent hover:border-slate-200'
                  "
                >
                  <div
                    v-if="rg.archiveSelectMode"
                    class="shrink-0 cursor-pointer"
                    @click="rg.toggleArchiveSelect(c.id)"
                  >
                    <div
                      class="w-5 h-5 rounded border flex items-center justify-center transition-colors"
                      :class="
                        rg.archiveSelected.includes(c.id)
                          ? 'bg-blue-600 border-blue-600'
                          : 'border-slate-300 hover:border-blue-400'
                      "
                    >
                      <i v-if="rg.archiveSelected.includes(c.id)" class="ph ph-check text-white text-xs"></i>
                    </div>
                  </div>
                  <div class="min-w-0 flex-1">
                    <div class="font-medium text-slate-800 text-sm truncate">{{ c.title }}</div>
                    <div class="text-[11px] text-slate-500 mt-0.5">
                      {{ new Date(c.updated_at * 1000).toLocaleString("fr-FR") }}
                    </div>
                  </div>
                  <div
                    v-if="!rg.archiveSelectMode"
                    class="flex gap-1 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity"
                  >
                    <button
                      title="Restaurer"
                      aria-label="Restaurer la conversation"
                      class="w-7 h-7 flex items-center justify-center bg-white border border-slate-200 hover:bg-slate-100 text-slate-600 rounded-md text-xs transition-colors"
                      @click="rg.restoreArchive(c.id)"
                    >
                      <i class="ph ph-arrow-u-up-left" aria-hidden="true"></i>
                    </button>
                    <button
                      title="Supprimer"
                      aria-label="Supprimer la conversation"
                      class="w-7 h-7 flex items-center justify-center bg-white border border-slate-200 hover:bg-red-50 hover:border-red-200 hover:text-red-600 text-slate-500 rounded-md text-xs transition-colors"
                      @click="rg.deleteArchive(c.id, c.title)"
                    >
                      <i class="ph ph-trash" aria-hidden="true"></i>
                    </button>
                  </div>
                </div>
              </div>
            </div>

            <div v-if="rg.settingsTab === 'sandbox'" class="max-w-2xl">
              <div class="mb-4">
                <h3 class="text-base font-semibold text-slate-800 mb-1">Sandbox</h3>
                <p class="text-xs text-slate-500">
                  Container Docker isolé pour Robot Framework, les scripts et le shell. Votre dossier de
                  travail y est monté sur <code class="font-mono">/work</code>.
                </p>
              </div>

              <div v-if="rg.transitionState.active" class="set-block">
                <div class="flex items-center gap-3 mb-2.5">
                  <div
                    v-if="!rg.transitionState.error"
                    class="w-4 h-4 border-2 border-blue-500 border-t-transparent rounded-full animate-spin motion-reduce:animate-none shrink-0"
                    aria-hidden="true"
                  ></div>
                  <i v-else class="ph ph-warning-circle text-red-500 text-lg shrink-0" aria-hidden="true"></i>
                  <div class="flex-1 min-w-0">
                    <div class="text-sm font-medium text-slate-800 truncate">
                      {{ rg.transitionState.label }}
                    </div>
                    <div class="text-xs text-slate-500">
                      Étape {{ rg.transitionState.step }} sur {{ rg.transitionState.total }}
                    </div>
                  </div>
                  <div class="text-sm font-semibold text-slate-700 tabular-nums shrink-0">
                    {{ Math.round(rg.transitionState.progress) }} %
                  </div>
                </div>
                <div
                  class="h-1.5 bg-white rounded-full overflow-hidden"
                  role="progressbar"
                  :aria-valuenow="Math.round(rg.transitionState.progress)"
                  aria-valuemin="0"
                  aria-valuemax="100"
                >
                  <div
                    :class="[
                      'h-full w-full rounded-full transition-transform duration-500 motion-reduce:transition-none',
                      rg.transitionState.error ? 'bg-red-400' : 'bg-blue-500',
                    ]"
                    :style="{
                      transformOrigin: 'left',
                      transform: 'scaleX(' + rg.transitionState.progress / 100 + ')',
                    }"
                  ></div>
                </div>
                <p
                  v-if="rg.transitionState.error"
                  role="alert"
                  class="mt-2.5 text-xs text-red-700 flex items-start gap-1.5"
                >
                  <i class="ph ph-warning-circle mt-0.5 shrink-0" aria-hidden="true"></i>
                  <span>{{ rg.transitionState.error }}</span>
                </p>
                <details v-if="rg.transitionState.containerLogs" class="mt-2.5">
                  <summary
                    class="cursor-pointer text-xs text-slate-500 hover:text-slate-700 transition-colors"
                  >
                    Journal du container
                  </summary>
                  <pre
                    class="mt-1.5 bg-slate-900 text-slate-100 p-2.5 rounded-lg font-mono text-[11px] leading-relaxed overflow-x-auto max-h-48 whitespace-pre-wrap"
                    >{{ rg.transitionState.containerLogs }}</pre>
                </details>
              </div>

              <div v-else class="space-y-2">
                <div class="set-block set-block--flush divide-y divide-slate-100">
                  <div class="set-row items-start">
                    <div
                      v-if="rg.sandboxStatus.tone === 'busy'"
                      class="w-2.5 h-2.5 mt-1.5 border-2 border-blue-500 border-t-transparent rounded-full animate-spin motion-reduce:animate-none shrink-0"
                      aria-hidden="true"
                    ></div>
                    <span
                      v-else
                      :class="['w-2.5 h-2.5 mt-1.5 rounded-full shrink-0', rg.sandboxTone.dot]"
                      aria-hidden="true"
                    ></span>

                    <div class="flex-1 min-w-0">
                      <div class="text-sm font-medium text-slate-800">{{ rg.sandboxStatus.label }}</div>
                      <div v-if="rg.sandboxStatus.mono" class="font-mono text-[11px] text-slate-500 truncate">
                        {{ rg.sandboxStatus.mono }}
                      </div>
                      <div
                        v-else-if="rg.sandboxStatus.detail && !rg.sandboxTone.alert"
                        class="text-xs text-slate-500"
                      >
                        {{ rg.sandboxStatus.detail }}
                      </div>
                    </div>

                    <button
                      v-if="rg.sandboxStatus.action"
                      :disabled="rg.sandboxBusy"
                      class="shrink-0 -mt-0.5 px-3 py-1.5 bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 rounded-lg text-xs font-medium transition-colors flex items-center gap-1.5"
                      @click="
                        rg.sandboxStatus.action === 'start'
                          ? rg.restartSandboxContainer('start')
                          : rg.changeSandboxMode('docker')
                      "
                    >
                      <i class="ph ph-play" aria-hidden="true"></i> Démarrer
                    </button>
                    <button
                      :disabled="rg.sandboxBusy"
                      aria-label="Rafraîchir l'état de la sandbox"
                      class="shrink-0 -mt-1 w-8 h-8 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-white flex items-center justify-center transition-colors disabled:opacity-50"
                      @click="rg.loadSandboxState()"
                    >
                      <i class="ph ph-arrow-clockwise" aria-hidden="true"></i>
                    </button>
                  </div>

                  <div
                    v-if="rg.sandboxTone.alert && rg.sandboxStatus.detail"
                    role="alert"
                    class="set-row--sub pt-0"
                  >
                    <span
                      :class="[
                        'block rounded-lg px-2.5 py-1.5 text-xs whitespace-pre-wrap break-words',
                        rg.sandboxTone.alert,
                      ]"
                      >{{ rg.sandboxStatus.detail }}</span
                    >
                  </div>

                  <div v-if="rg.sandboxStatus.tone === 'ok' && rg.sandboxState.stats" class="set-row text-xs">
                    <span class="w-2.5 shrink-0" aria-hidden="true"></span>
                    <div class="flex flex-wrap items-center gap-x-6 gap-y-1">
                      <span v-if="rg.sandboxState.stats.cpu" class="text-slate-500"
                        >CPU
                        <span class="font-medium text-slate-700 tabular-nums">{{
                          rg.sandboxState.stats.cpu
                        }}</span></span
                      >
                      <span v-if="rg.sandboxState.stats.mem" class="text-slate-500"
                        >RAM
                        <span class="font-medium text-slate-700 tabular-nums">{{
                          rg.sandboxState.stats.mem
                        }}</span></span
                      >
                      <span v-if="rg.sandboxState.stats.pids" class="text-slate-500"
                        >PIDs
                        <span class="font-medium text-slate-700 tabular-nums">{{
                          rg.sandboxState.stats.pids
                        }}</span></span
                      >
                    </div>
                  </div>

                  <div
                    v-if="rg.sandboxState.network_profiles && rg.sandboxState.network_profiles.length > 1"
                    class="set-row"
                    data-net-menu
                    @keydown="rg.onNetMenuKeydown"
                  >
                    <span class="w-2.5 shrink-0" aria-hidden="true"></span>
                    <span id="sandbox-net-label" class="text-sm text-slate-800 flex-1 min-w-0">
                      Réseau
                      <span
                        v-if="rg.sandboxState.network_profile_locked"
                        class="ml-1.5 inline-flex items-center gap-1 text-xs text-slate-500 align-middle"
                        title="Profil imposé par l'administrateur"
                      >
                        <i class="ph ph-lock-simple" aria-hidden="true"></i> Imposé
                      </span>
                    </span>
                    <div class="relative shrink-0">
                      <button
                        id="sandbox-net-profile"
                        type="button"
                        :disabled="rg.sandboxBusy || rg.sandboxState.network_profile_locked"
                        aria-haspopup="listbox"
                        aria-labelledby="sandbox-net-label"
                        :aria-expanded="rg.netMenuOpen ? 'true' : 'false'"
                        class="flex items-center gap-2 w-56 px-3 py-2 rounded-lg border border-slate-200 bg-white text-sm text-slate-700 hover:border-slate-300 disabled:opacity-60 disabled:cursor-not-allowed focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 transition-colors"
                        @click="rg.toggleNetMenu()"
                      >
                        <span class="flex-1 text-left truncate">{{
                          rg.activeNetProfile ? rg.activeNetProfile.name : "—"
                        }}</span>
                        <span class="text-xs text-slate-500 shrink-0">{{
                          rg.netProfileMode(rg.activeNetProfile)
                        }}</span>
                        <i
                          class="ph ph-caret-down text-slate-400 shrink-0 transition-transform motion-reduce:transition-none"
                          :class="rg.netMenuOpen && 'rotate-180'"
                          aria-hidden="true"
                        ></i>
                      </button>
                      <Transition name="popover">
                        <div
                          v-if="rg.netMenuOpen"
                          role="listbox"
                          aria-labelledby="sandbox-net-label"
                          class="absolute right-0 top-full mt-2 w-80 max-h-64 overflow-y-auto custom-scrollbar bg-white rounded-xl shadow-2xl border border-slate-200 z-[200]"
                        >
                          <div
                            v-for="prof in rg.sandboxState.network_profiles"
                            :key="prof.id"
                            role="option"
                            tabindex="0"
                            :aria-selected="prof.id === rg.sandboxState.network_profile_id ? 'true' : 'false'"
                            class="px-3 py-2.5 cursor-pointer border-b border-slate-50 last:border-b-0 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500 transition-colors"
                            :class="
                              prof.id === rg.sandboxState.network_profile_id
                                ? 'bg-blue-50'
                                : 'hover:bg-slate-50'
                            "
                            @click="rg.pickNetProfile(prof.id)"
                            @keydown.enter.prevent="rg.pickNetProfile(prof.id)"
                            @keydown.space.prevent="rg.pickNetProfile(prof.id)"
                          >
                            <div class="flex items-center gap-2">
                              <span
                                class="w-1.5 h-1.5 rounded-full shrink-0"
                                :class="
                                  prof.id === rg.sandboxState.network_profile_id
                                    ? 'bg-blue-500'
                                    : 'bg-transparent'
                                "
                                aria-hidden="true"
                              ></span>
                              <span
                                class="text-sm truncate"
                                :class="
                                  prof.id === rg.sandboxState.network_profile_id
                                    ? 'text-blue-700 font-medium'
                                    : 'text-slate-700'
                                "
                                >{{ prof.name }}</span
                              >
                              <span class="ml-auto text-xs text-slate-500 shrink-0">{{
                                rg.netProfileMode(prof)
                              }}</span>
                            </div>
                            <div class="text-xs text-slate-500 mt-0.5 pl-3.5">
                              {{ rg.netProfileDetail(prof) }}
                            </div>
                          </div>
                        </div>
                      </Transition>
                    </div>
                  </div>

                  <div v-if="rg.activeNetProfile" class="set-row--sub text-xs text-slate-500">
                    <span v-if="rg.activeNetProfile.description">{{ rg.activeNetProfile.description }}</span>
                    <span v-else-if="rg.activeNetProfile.mode === 'none'">Aucun accès réseau sortant.</span>
                    <span v-else-if="rg.activeNetProfile.mode === 'bridge'">Accès réseau complet.</span>
                    <span v-else>Accès limité aux adresses listées.</span>
                    <div
                      v-if="
                        rg.activeNetProfile.mode === 'allowlist_ip' && (rg.activeNetProfile.ips || []).length
                      "
                      class="flex flex-wrap gap-1 mt-1.5"
                    >
                      <span
                        v-for="ip in (rg.activeNetProfile.ips || []).slice(0, 8)"
                        :key="ip"
                        class="font-mono text-[11px] px-1.5 py-0.5 bg-slate-100 text-slate-600 rounded"
                        >{{ ip }}</span
                      >
                      <span
                        v-if="(rg.activeNetProfile.ips || []).length > 8"
                        class="text-[11px] text-slate-500 px-1 self-center"
                        >+{{ (rg.activeNetProfile.ips || []).length - 8 }}</span
                      >
                    </div>
                  </div>

                  <div
                    v-if="
                      rg.sandboxState.effective_mode === 'docker' &&
                      rg.sandboxState.daemon_ok &&
                      rg.sandboxState.image
                    "
                    class="set-row items-start"
                  >
                    <span class="w-2.5 shrink-0" aria-hidden="true"></span>
                    <dl class="flex-1 min-w-0 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-xs">
                      <dt class="text-slate-500">Image</dt>
                      <dd class="font-mono text-[11px] text-slate-700 truncate">
                        {{ rg.sandboxState.image }}
                      </dd>
                      <template v-if="rg.sandboxState.limits && rg.sandboxState.limits.memory_mb">
                        <dt class="text-slate-500">RAM max</dt>
                        <dd class="text-slate-700 tabular-nums">{{ rg.sandboxState.limits.memory_mb }} Mo</dd>
                      </template>
                      <template v-if="rg.sandboxState.limits && rg.sandboxState.limits.cpu_quota_pct">
                        <dt class="text-slate-500">CPU</dt>
                        <dd class="text-slate-700 tabular-nums">
                          {{ rg.sandboxState.limits.cpu_quota_pct }} %
                        </dd>
                      </template>
                      <template v-if="rg.sandboxState.limits && rg.sandboxState.limits.pids_max">
                        <dt class="text-slate-500">PIDs max</dt>
                        <dd class="text-slate-700 tabular-nums">{{ rg.sandboxState.limits.pids_max }}</dd>
                      </template>
                      <template v-if="rg.sandboxState.limits && rg.sandboxState.limits.timeout_s">
                        <dt class="text-slate-500">Timeout</dt>
                        <dd class="text-slate-700 tabular-nums">{{ rg.sandboxState.limits.timeout_s }} s</dd>
                      </template>
                    </dl>
                  </div>
                </div>

                <div v-if="rg.sandboxStatus.tone === 'ok'" class="flex justify-end gap-2">
                  <button
                    :disabled="rg.sandboxBusy"
                    class="px-3 py-1.5 bg-white text-slate-700 border border-slate-200 hover:bg-slate-50 disabled:opacity-50 rounded-lg text-xs font-medium transition-colors flex items-center gap-1.5"
                    @click="rg.restartSandboxContainer('restart')"
                  >
                    <i class="ph ph-arrows-clockwise" aria-hidden="true"></i> Redémarrer
                  </button>
                  <button
                    :disabled="rg.sandboxBusy"
                    class="px-3 py-1.5 bg-white text-red-600 border border-red-200 hover:bg-red-50 disabled:opacity-50 rounded-lg text-xs font-medium transition-colors flex items-center gap-1.5"
                    @click="rg.destroySandboxContainer"
                  >
                    <i class="ph ph-trash" aria-hidden="true"></i> Détruire
                  </button>
                </div>
              </div>

              <div class="set-block set-block--flush mt-8">
                <div class="set-row">
                  <i class="ph ph-broom text-slate-400 text-lg w-5 shrink-0" aria-hidden="true"></i>
                  <div class="flex-1 min-w-0">
                    <div class="text-sm text-slate-800">Vider le dossier de travail</div>
                    <div class="text-xs text-slate-500">
                      Supprime définitivement tous vos fichiers. Vos skills et votre mémoire ne sont pas
                      concernés.
                    </div>
                  </div>
                  <button
                    class="shrink-0 px-3 py-1.5 bg-white text-red-600 border border-red-200 hover:bg-red-50 rounded-lg text-xs font-medium transition-colors flex items-center gap-1.5"
                    @click="rg.clearSandbox"
                  >
                    <i class="ph ph-trash" aria-hidden="true"></i> Vider
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div
          class="px-5 py-3 border-t border-slate-100 bg-slate-50 flex justify-between items-center gap-2 shrink-0"
        >
          <span
            v-if="rg.settingsDirty || rg.memoryDirty"
            role="status"
            class="text-[11px] text-slate-500 flex items-center gap-1.5"
            ><span class="w-1.5 h-1.5 rounded-full shrink-0 bg-amber-500" aria-hidden="true"></span>
            Modifications non enregistrées</span
          >
          <span v-else aria-hidden="true"></span>
          <div class="flex items-center gap-2">
            <button
              class="px-4 py-1.5 text-slate-600 hover:bg-slate-200/60 rounded-lg font-medium text-sm transition-colors"
              @click="rg.closeSettings()"
            >
              Fermer
            </button>
            <button
              :disabled="rg.settingsSaving"
              class="px-5 py-1.5 bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-60 disabled:cursor-not-allowed rounded-lg font-medium text-sm transition-colors shadow-sm inline-flex items-center gap-2"
              @click="rg.saveSettings()"
            >
              <i v-if="rg.settingsSaving" class="ph ph-spinner-gap animate-spin" aria-hidden="true"></i>
              {{ rg.settingsSaving ? "Enregistrement…" : "Enregistrer" }}
            </button>
          </div>
        </div>
      </div>
    </div>
  </Transition>
  <RecadrageImage
    :fichier="rg.avatarARecadrer"
    titre="Recadrer la photo de profil"
    forme="rond"
    nom-fichier="avatar"
    @valider="rg.envoyerAvatar"
    @annuler="rg.annulerRecadrageAvatar()"
    @erreur="rg.erreurRecadrageAvatar"
  />
</template>
