<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/chat/modales/ModaleApprentissage.vue — « Enregistrer comme procédure » : gestes retenus et écartés de la conversation, paramètres, confirm par geste à effet, aperçu ; crée une version non approuvée. -->
<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";

import { CLE_APPRENTISSAGE, domaineRacine } from "../../../app/racine/domaine";

const a = domaineRacine(CLE_APPRENTISSAGE);
const dialogue = ref<HTMLElement | null>(null);
const choix = computed(() => a.choix);
const complet = computed(() => a.apercu.erreurs.length === 0 && a.apercu.lines.length > 0 && !a.occupe);

watch(
  () => a.ouvert,
  (o) => {
    if (o) void nextTick(() => dialogue.value?.focus());
  },
);
</script>

<template>
  <Transition name="modal">
    <div
      v-if="a.ouvert"
      data-a11y-modal
      role="dialog"
      aria-modal="true"
      aria-label="Enregistrer comme procédure"
      class="fixed inset-0 z-[6000] flex items-center justify-center bg-slate-900/80 p-4"
      @click.self="a.fermer()"
    >
      <div
        ref="dialogue"
        tabindex="-1"
        class="bg-white rounded-2xl shadow-2xl ring-1 ring-slate-200 w-full max-w-2xl overflow-hidden flex flex-col max-h-[88vh] focus:outline-none"
      >
        <div class="px-5 py-4 border-b border-slate-100 flex items-center justify-between shrink-0">
          <div class="flex items-center gap-2.5">
            <div class="w-8 h-8 rounded-lg bg-blue-100 text-blue-600 flex items-center justify-center">
              <i class="ph ph-list-checks" aria-hidden="true"></i>
            </div>
            <div>
              <h3 class="font-bold text-slate-800 text-sm">Enregistrer comme procédure</h3>
              <p class="text-[10px] text-slate-400">
                Les gestes réussis de cette conversation. La version créée n'est jamais approuvée d'office.
              </p>
            </div>
          </div>
          <button
            type="button"
            aria-label="Fermer"
            class="w-7 h-7 rounded-md text-slate-500 hover:bg-slate-100 flex items-center justify-center"
            @click="a.fermer()"
          >
            <i class="ph ph-x" aria-hidden="true"></i>
          </button>
        </div>

        <div class="overflow-y-auto p-5 space-y-4 text-sm">
          <p v-if="a.chargement" class="text-slate-500">Lecture de la conversation…</p>
          <p v-else-if="a.erreur" class="text-red-600" role="alert">{{ a.erreur }}</p>

          <template v-if="a.termine">
            <p class="text-slate-700">
              Procédure « {{ a.termine.id }} » enregistrée (version {{ a.termine.version }}), non approuvée.
              Une routine ne l'exécutera qu'après votre approbation.
            </p>
            <div class="flex justify-end gap-2">
              <button
                type="button"
                class="px-3 py-1.5 text-xs rounded-md border border-slate-200 text-slate-600 hover:bg-slate-50"
                @click="a.fermer()"
              >
                Fermer
              </button>
              <button
                type="button"
                class="px-3 py-1.5 text-xs rounded-md bg-slate-800 text-white hover:bg-slate-700"
                @click="a.ouvrirProcedures()"
              >
                Ouvrir les procédures
              </button>
            </div>
          </template>

          <template v-else-if="a.brouillon && choix">
            <p v-if="!a.brouillon.noeuds.length" class="text-slate-500">
              Aucun geste navigateur réussi à retenir dans cette conversation.
            </p>

            <div class="grid grid-cols-2 gap-3">
              <label class="space-y-1 text-xs text-slate-500">
                Nom
                <input
                  v-model="choix.id"
                  type="text"
                  maxlength="64"
                  class="w-full border border-slate-200 rounded-md px-2 py-1.5 text-sm text-slate-800"
                />
                <span v-if="a.brouillon.existantes.some((e) => e.id === choix?.id)" class="text-amber-600">
                  Existe déjà : une nouvelle version sera créée.
                </span>
              </label>
              <label class="space-y-1 text-xs text-slate-500">
                Description
                <input
                  v-model="choix.description"
                  type="text"
                  maxlength="500"
                  class="w-full border border-slate-200 rounded-md px-2 py-1.5 text-sm text-slate-800"
                />
              </label>
            </div>
            <p class="text-xs text-slate-500">Site : {{ a.brouillon.origin }}</p>

            <div v-if="a.brouillon.noeuds.length" class="space-y-1.5">
              <h4 class="text-xs font-semibold text-slate-600">Gestes retenus</h4>
              <div v-for="n in a.brouillon.noeuds" :key="n.id" class="flex items-center gap-2 text-xs">
                <input
                  type="checkbox"
                  :checked="a.garde(n.id)"
                  :aria-label="`Garder : ${n.libelle}`"
                  @change="a.basculerGarde(n.id)"
                />
                <span class="font-mono text-slate-700 flex-1 min-w-0 break-words">{{ n.libelle }}</span>
                <label v-if="n.effet" class="flex items-center gap-1 shrink-0 text-slate-600">
                  <input v-model="choix.confirm[String(n.id)]" type="checkbox" :disabled="!a.garde(n.id)" />
                  Demander mon accord
                </label>
                <input
                  v-if="n.waitForRequis"
                  v-model="choix.wait_for[String(n.id)]"
                  type="text"
                  placeholder="Cible attendue après connexion (ex. role=heading|name=Accueil)"
                  class="border border-slate-200 rounded-md px-2 py-1 w-64"
                />
              </div>
            </div>

            <div v-if="a.brouillon.params.length" class="space-y-1.5">
              <h4 class="text-xs font-semibold text-slate-600">Paramètres proposés</h4>
              <label v-for="p in a.brouillon.params" :key="p.nom" class="flex items-center gap-2 text-xs">
                <input v-model="choix.params[p.nom]" type="checkbox" />
                <span class="font-medium text-slate-700">{{ p.nom }}</span>
                <span class="text-slate-500 truncate" :title="p.valeur"
                  >valeur actuelle : « {{ p.valeur }} »</span
                >
                <span class="text-slate-400 shrink-0">{{
                  choix.params[p.nom] ? "paramètre" : "littéral"
                }}</span>
              </label>
            </div>

            <div v-if="a.brouillon.ecartes.length" class="space-y-1">
              <h4 class="text-xs font-semibold text-slate-600">Écartés</h4>
              <ul class="text-xs text-slate-500 space-y-0.5">
                <li v-for="(e, i) in a.brouillon.ecartes" :key="i">
                  <span class="font-mono">{{ e.quoi }}</span> — {{ e.raison }}
                </li>
              </ul>
            </div>

            <div class="space-y-1">
              <h4 class="text-xs font-semibold text-slate-600">Aperçu</h4>
              <pre
                v-if="a.apercu.lines.length"
                class="text-xs text-slate-700 bg-slate-50 rounded-md p-2 overflow-x-auto whitespace-pre-wrap"
                >{{ a.apercu.lines.join("\n") }}</pre>
              <p v-for="(e, i) in a.apercu.erreurs" :key="i" class="text-xs text-red-600" role="alert">
                {{ e }}
              </p>
            </div>

            <div class="flex justify-end gap-2">
              <button
                type="button"
                class="px-3 py-1.5 text-xs rounded-md border border-slate-200 text-slate-600 hover:bg-slate-50"
                @click="a.fermer()"
              >
                Annuler
              </button>
              <button
                type="button"
                class="px-3 py-1.5 text-xs rounded-md bg-slate-800 text-white hover:bg-slate-700 disabled:opacity-50"
                :disabled="!complet"
                @click="a.enregistrer()"
              >
                Enregistrer
              </button>
            </div>
          </template>
        </div>
      </div>
    </div>
  </Transition>
</template>
