<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/chat/modales/FormulaireAssistant.vue — cadrage générique d'un assistant de création (skill, routine) piloté par un descripteur, avant l'ouverture du chat. -->
<script setup lang="ts">
import { computed } from "vue";

import { ASSISTANTS } from "../../../features/chat/coeur/assistants";
import type { ChampAssistant } from "../../../features/chat/coeur/assistants";
import { domaineModales } from "../../../features/chat/modales/domaine";

const m = domaineModales();
const d = computed(() => ASSISTANTS[m.assistantForm.id] ?? null);

// Les champs « demi » consécutifs forment une rangée.
const rangees = computed<ChampAssistant[][]>(() => {
  const out: ChampAssistant[][] = [];
  for (const c of d.value?.champs ?? []) {
    const derniere = out[out.length - 1];
    if (c.demi && derniere?.[0]?.demi) derniere.push(c);
    else out.push([c]);
  }
  return out;
});
</script>

<template>
  <!-- z-[6000] : AU-DESSUS de la modal Paramètres (z-[5000]), qui se ferme au lancement.
       PAS de data-a11y-modal : l'union _anyBigModalOpen fait un premier-match querySelector — l'ajouter ici casserait le focus-trap des Paramètres quand les deux sont ouvertes. -->
  <div
    v-if="m.assistantForm.open && d"
    role="dialog"
    aria-modal="true"
    :aria-label="d.titre"
    class="fixed inset-0 z-[6000] flex items-center justify-center bg-slate-900/80 p-4"
    @click.self="m.assistantForm.open = false"
  >
    <div class="bg-white rounded-xl shadow-xl w-full max-w-md p-5 space-y-3">
      <div class="flex items-center gap-2">
        <i class="ph ph-sparkle text-slate-400 text-xl"></i>
        <h3 class="font-semibold text-slate-900 text-sm">{{ d.titre }}</h3>
      </div>
      <p class="text-xs text-slate-500">{{ d.intro }}</p>
      <div v-for="rangee in rangees" :key="rangee[0]?.cle" class="flex gap-3">
        <div v-for="c in rangee" :key="c.cle" :class="rangee.length > 1 ? 'flex-1' : 'w-full'">
          <label class="text-[11px] font-medium text-slate-500 block mb-1"
            >{{ c.libelle }}
            <span v-if="c.requis" class="text-red-400">*</span>
            <span v-else class="text-slate-400">(optionnel)</span></label
          >
          <input
            v-if="c.type === 'input'"
            v-model="m.assistantForm.valeurs[c.cle]"
            :placeholder="c.placeholder"
            class="set-input"
          />
          <textarea
            v-else-if="c.type === 'textarea'"
            v-model="m.assistantForm.valeurs[c.cle]"
            rows="2"
            :placeholder="c.placeholder"
            class="set-textarea"
            style="min-height: 3.5rem"
          ></textarea>
          <div v-else class="flex gap-1">
            <button
              v-for="opt in c.options"
              :key="opt"
              type="button"
              class="text-[11px] px-2 py-1.5 rounded-md border transition-colors"
              :class="
                m.assistantForm.valeurs[c.cle] === opt
                  ? 'bg-blue-600 border-blue-600 text-white'
                  : 'bg-white border-slate-200 text-slate-600 hover:border-blue-300'
              "
              @click="m.assistantForm.valeurs[c.cle] = m.assistantForm.valeurs[c.cle] === opt ? '' : opt"
            >
              {{ opt }}
            </button>
          </div>
        </div>
      </div>
      <div class="flex items-center justify-end gap-2 pt-1">
        <button class="skl-btn skl-btn--secondary" @click="m.assistantForm.open = false">Annuler</button>
        <button class="skl-btn bg-blue-600 text-white hover:bg-blue-700" @click="m.lancerAssistantForm">
          <i class="ph ph-sparkle"></i> {{ d.bouton }}
        </button>
      </div>
    </div>
  </div>
</template>
