<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/chat/modales/RemplissageTemplate.vue — variables d'un template de prompt (« /template », Paramètres) : saisie, Entrée insère, Échap annule ; le texte est inséré dans le composeur, jamais envoyé. -->
<script setup lang="ts">
import { domaineModales } from "../../../features/chat/modales/domaine";

const m = domaineModales();
</script>

<template>
  <div
    v-if="m.templateFill.open"
    data-template-fill
    role="dialog"
    aria-modal="true"
    aria-labelledby="tpl-fill-title"
    class="fixed inset-0 z-[6000] flex items-center justify-center bg-slate-900/80 p-4"
    @click.self="m.cancelTemplateFill()"
  >
    <div
      class="bg-white rounded-xl shadow-xl w-full max-w-lg p-5 space-y-3"
      @keydown.esc.stop.prevent="m.cancelTemplateFill()"
    >
      <div class="flex items-center gap-2 min-w-0">
        <i class="ph ph-brackets-curly text-slate-400 text-xl shrink-0" aria-hidden="true"></i>
        <h3 id="tpl-fill-title" class="font-semibold text-slate-900 text-sm truncate">
          {{ m.templateFill.template ? m.templateFill.template.title || m.templateFill.template.name : "" }}
        </h3>
        <span v-if="m.templateFill.template" class="ml-auto shrink-0 text-[11px] font-mono text-slate-400"
          >/template {{ m.templateFill.template.name }}</span
        >
      </div>
      <div class="space-y-2.5 max-h-[60vh] overflow-y-auto custom-scrollbar pr-1">
        <div v-for="f in m.templateFill.fields" :key="f.name" data-template-row>
          <label :for="'tpl-f-' + f.name" class="text-[11px] font-medium text-slate-500 block mb-1">
            {{ f.name.split("_").join(" ") }}<span v-if="f.required" class="text-red-400"> *</span>
          </label>
          <textarea
            v-if="f.type === 'textarea'"
            :id="'tpl-f-' + f.name"
            v-model="m.templateFill.values[f.name]"
            data-template-field
            rows="4"
            :placeholder="f.placeholder"
            class="set-textarea"
            style="min-height: 5rem"
            @keydown="m.templateFillKeydown($event, f)"
          ></textarea>
          <select
            v-else-if="f.type === 'select'"
            :id="'tpl-f-' + f.name"
            v-model="m.templateFill.values[f.name]"
            data-template-field
            class="set-select"
            @keydown="m.templateFillKeydown($event, f)"
          >
            <option v-for="o in f.options" :key="o" :value="o">{{ o }}</option>
          </select>
          <input
            v-else
            :id="'tpl-f-' + f.name"
            v-model="m.templateFill.values[f.name]"
            data-template-field
            :placeholder="f.placeholder"
            class="set-input"
            @keydown="m.templateFillKeydown($event, f)"
          />
        </div>
      </div>
      <p v-if="m.templateFill.error" class="text-xs text-red-600" role="alert" data-template-error>
        {{ m.templateFill.error }}
      </p>
      <div class="flex items-center justify-end gap-2 pt-1">
        <button type="button" class="skl-btn skl-btn--secondary" @click="m.cancelTemplateFill()">
          Annuler
        </button>
        <button
          type="button"
          data-template-insert
          class="skl-btn bg-blue-600 text-white hover:bg-blue-700"
          @click="m.submitTemplateFill()"
        >
          <i class="ph ph-arrow-bend-down-left" aria-hidden="true"></i> Insérer
        </button>
      </div>
    </div>
  </div>
</template>
