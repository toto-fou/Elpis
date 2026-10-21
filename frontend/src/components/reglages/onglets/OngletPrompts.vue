<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/reglages/onglets/OngletPrompts.vue — onglet « prompts » des Paramètres. -->
<script setup lang="ts">
import { domaineReglages } from "../../../features/reglages/domaine";

const rg = domaineReglages();
</script>

<template>
  <!-- eslint-disable vue/multiline-html-element-content-newline -->
  <div class="space-y-4 max-w-2xl">
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
        <p class="text-sm text-slate-500">Aucun prompt ne correspond à « {{ rg.promptSearch.trim() }} ».</p>
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
            <label for="tpl-name" class="text-[11px] font-medium text-slate-500 block mb-1">Raccourci</label>
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
            <label for="tpl-title" class="text-[11px] font-medium text-slate-500 block mb-1">Titre</label>
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
        <p v-if="rg.templateFormError" class="text-xs text-red-600" role="alert" data-template-error>
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
</template>
