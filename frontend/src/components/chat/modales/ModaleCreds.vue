<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/chat/modales/ModaleCreds.vue — commande /creds : jeton ⟦creds:…⟧ pour la conversation, depuis le coffre ou un identifiant ponctuel ; jetons actifs avec renouvellement et révocation. -->
<script setup lang="ts">
import { nextTick, ref, watch } from "vue";

import { CLE_CREDS, domaineRacine } from "../../../app/racine/domaine";

const c = domaineRacine(CLE_CREDS);
const dialogue = ref<HTMLElement | null>(null);

watch(
  () => c.showCredsModal,
  (ouvert) => {
    if (ouvert) void nextTick(() => dialogue.value?.focus());
  },
);
</script>

<template>
  <!-- eslint-disable vue/multiline-html-element-content-newline -->
  <Transition name="modal">
    <div
      v-if="c.showCredsModal"
      data-a11y-modal
      role="dialog"
      aria-modal="true"
      aria-label="Identifiants"
      class="fixed inset-0 z-[6000] flex items-center justify-center bg-slate-900/80 p-4"
      @click.self="c.fermerCreds()"
    >
      <div
        ref="dialogue"
        tabindex="-1"
        class="bg-white rounded-2xl shadow-2xl ring-1 ring-slate-200 w-full max-w-lg overflow-hidden flex flex-col max-h-[85vh] focus:outline-none"
      >
        <div class="px-5 py-4 border-b border-slate-100 flex items-center justify-between shrink-0">
          <div class="flex items-center gap-2.5">
            <div class="w-8 h-8 rounded-lg bg-blue-100 text-blue-600 flex items-center justify-center">
              <i class="ph ph-key" aria-hidden="true"></i>
            </div>
            <div>
              <h3 class="font-bold text-slate-800 text-sm">Identifiants</h3>
              <p class="text-[10px] text-slate-400">
                Accès temporaire (30 min) pour cette conversation, limité à une origine.
              </p>
            </div>
          </div>
          <button
            type="button"
            aria-label="Fermer"
            class="w-8 h-8 rounded-lg hover:bg-slate-100 text-slate-400 transition-colors flex items-center justify-center"
            @click="c.fermerCreds()"
          >
            <i class="ph ph-x text-lg" aria-hidden="true"></i>
          </button>
        </div>

        <form
          class="flex-1 overflow-y-auto p-5 space-y-4 custom-scrollbar"
          autocomplete="off"
          @submit.prevent="c.validerCreds()"
        >
          <div class="flex gap-1" role="tablist" aria-label="Source de l'identifiant">
            <button
              type="button"
              role="tab"
              :aria-selected="c.credsMode === 'coffre'"
              class="px-3 py-1.5 text-sm rounded-lg transition-colors"
              :class="
                c.credsMode === 'coffre'
                  ? 'bg-blue-600 text-white font-medium'
                  : 'text-slate-600 hover:bg-slate-100'
              "
              @click="c.credsMode = 'coffre'"
            >
              Coffre
            </button>
            <button
              type="button"
              role="tab"
              :aria-selected="c.credsMode === 'ponctuel'"
              class="px-3 py-1.5 text-sm rounded-lg transition-colors"
              :class="
                c.credsMode === 'ponctuel'
                  ? 'bg-blue-600 text-white font-medium'
                  : 'text-slate-600 hover:bg-slate-100'
              "
              @click="c.credsMode = 'ponctuel'"
            >
              Saisie
            </button>
          </div>

          <div v-if="c.credsMode === 'coffre'" class="space-y-2">
            <p v-if="!c.credsEntries.length" class="text-sm text-slate-500 text-center py-3">
              Coffre vide. Ajoutez une entrée dans Paramètres › Coffre, ou saisissez un identifiant.
            </p>
            <label
              v-for="e in c.credsEntries"
              :key="e.id"
              class="flex items-center gap-3 border rounded-xl p-3 cursor-pointer"
              :class="[
                c.credsEntree === e.id ? 'border-blue-300 bg-blue-50/40' : 'border-slate-200',
                e.origin_confirmed ? '' : 'opacity-60 cursor-not-allowed',
              ]"
            >
              <input
                v-model="c.credsEntree"
                type="radio"
                name="creds-entree"
                :value="e.id"
                :disabled="!e.origin_confirmed"
              />
              <span class="min-w-0 flex-1">
                <span class="block text-sm font-medium text-slate-800 truncate">{{ e.nom }}</span>
                <span class="block text-xs text-slate-500 truncate">
                  {{ e.origin || "origine inconnue" }} · {{ e.username }}
                </span>
              </span>
              <span v-if="!e.origin_confirmed" class="text-xs text-amber-600 shrink-0">à confirmer</span>
            </label>
          </div>

          <div v-else class="space-y-2.5">
            <div>
              <label for="creds-origine" class="text-xs font-medium text-slate-500">Origine</label>
              <input
                id="creds-origine"
                v-model="c.credsOrigine"
                placeholder="https://intranet.example.lan:8443"
                autocomplete="off"
                class="set-input mt-0.5"
              />
            </div>
            <div class="grid grid-cols-2 gap-2.5">
              <div>
                <label for="creds-identifiant" class="text-xs font-medium text-slate-500">Identifiant</label>
                <input
                  id="creds-identifiant"
                  v-model="c.credsIdentifiant"
                  autocomplete="off"
                  class="set-input mt-0.5"
                />
              </div>
              <div>
                <label for="creds-mdp" class="text-xs font-medium text-slate-500">Mot de passe</label>
                <input
                  id="creds-mdp"
                  v-model="c.credsMotDePasse"
                  type="password"
                  autocomplete="new-password"
                  class="set-input mt-0.5"
                />
              </div>
            </div>
            <label class="flex items-center gap-2 text-sm text-slate-600">
              <input v-model="c.credsEnregistrer" type="checkbox" />
              Enregistrer dans le coffre
            </label>
            <label
              class="flex items-center gap-2 text-sm text-slate-600"
              title="Autorise la saisie même si le certificat du site n'est pas approuvé (réseau privé)"
            >
              <input v-model="c.credsCertificat" type="checkbox" />
              Certificat non vérifié accepté
            </label>
          </div>

          <p v-if="c.credsErreur" role="alert" class="text-xs text-red-600">{{ c.credsErreur }}</p>

          <div class="flex items-center gap-2">
            <button
              type="submit"
              :disabled="c.credsBusy"
              class="px-3.5 py-1.5 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm font-medium transition-colors disabled:opacity-50"
            >
              Insérer
            </button>
            <button
              type="button"
              class="px-3 py-1.5 text-sm font-medium text-slate-600 hover:bg-slate-100 rounded-lg transition-colors"
              @click="c.fermerCreds()"
            >
              Annuler
            </button>
          </div>

          <div v-if="c.credsTokens.length" class="pt-3 border-t border-slate-100 space-y-2">
            <div class="text-xs font-medium text-slate-500">Accès actifs sur cette conversation</div>
            <div
              v-for="j in c.credsTokens"
              :key="j.id"
              class="flex items-center gap-2 border border-slate-200 rounded-lg px-3 py-2"
            >
              <span class="min-w-0 flex-1">
                <span class="block text-sm text-slate-800 truncate">{{ j.label }}</span>
                <span class="block text-xs text-slate-500 truncate">
                  {{ j.origin }} · {{ c.credsExpire(j) }} · {{ j.uses_left }}
                  {{ j.uses_left > 1 ? "usages" : "usage" }}
                </span>
              </span>
              <button
                type="button"
                title="Renouveler pour 30 min"
                class="px-2 py-1 text-xs rounded-md border border-slate-200 text-slate-600 hover:bg-slate-50 shrink-0"
                @click="c.renouvelerCreds(j)"
              >
                Renouveler
              </button>
              <button
                type="button"
                title="Révoquer l'accès"
                class="px-2 py-1 text-xs rounded-md border border-slate-200 text-red-600 hover:bg-red-50 shrink-0"
                @click="c.revoquerCreds(j)"
              >
                Révoquer
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  </Transition>
</template>
