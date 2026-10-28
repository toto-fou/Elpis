<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/reglages/onglets/OngletCoffre.vue — onglet « coffre » des Paramètres : identifiants liés à une origine exacte, mot de passe en écriture seule. -->
<script setup lang="ts">
import { onMounted } from "vue";

import { domaineReglages } from "../../../features/reglages/domaine";
import AideOnglet from "../AideOnglet.vue";

const rg = domaineReglages();
const titre = "Coffre";

onMounted(() => void rg.loadCoffre());
</script>

<template>
  <!-- eslint-disable vue/multiline-html-element-content-newline -->
  <div class="space-y-5 max-w-xl">
    <AideOnglet :titre="titre"
      >Vos identifiants de sites, chiffrés. Chacun n'est utilisable que sur son origine exacte (schéma, hôte,
      port), jamais lu par l'assistant : la commande /creds lui en donne un accès temporaire, limité à la
      conversation.</AideOnglet
    >

    <div v-if="rg.coffreItems.length" class="space-y-2">
      <div v-for="e in rg.coffreItems" :key="e.id" class="border border-slate-200 rounded-xl p-3.5">
        <div class="flex items-center gap-3">
          <i class="ph ph-key text-lg text-slate-400 shrink-0" aria-hidden="true"></i>
          <div class="flex-1 min-w-0">
            <div class="text-sm font-medium text-slate-800 truncate">
              {{ e.nom }}
              <span v-if="!e.origin_confirmed" class="text-xs font-normal text-amber-600">
                · à confirmer</span
              >
            </div>
            <div class="text-xs text-slate-500 truncate">
              {{ e.origin || "origine inconnue" }} · {{ e.username }} · ••••
            </div>
            <div class="text-xs text-slate-500">
              {{ e.use_count }} {{ e.use_count > 1 ? "usages" : "usage" }}
            </div>
          </div>
          <button
            v-if="!e.origin_confirmed"
            type="button"
            title="Confirmer l'origine du site"
            class="px-2 py-1 text-xs rounded-md border border-slate-200 text-slate-600 hover:bg-slate-50 shrink-0"
            @click="rg.confirmCoffre(e)"
          >
            Confirmer
          </button>
          <button
            type="button"
            title="Modifier"
            aria-label="Modifier l'entrée"
            class="w-7 h-7 rounded-md text-slate-500 hover:bg-slate-100 hover:text-slate-700 flex items-center justify-center shrink-0"
            @click="rg.editCoffre(e)"
          >
            <i class="ph ph-pencil-simple" aria-hidden="true"></i>
          </button>
          <button
            type="button"
            title="Supprimer"
            aria-label="Supprimer l'entrée"
            class="w-7 h-7 rounded-md text-slate-500 hover:bg-red-50 hover:text-red-600 flex items-center justify-center shrink-0"
            @click="rg.deleteCoffre(e)"
          >
            <i class="ph ph-trash" aria-hidden="true"></i>
          </button>
        </div>
        <p v-if="!e.origin_confirmed" class="text-xs text-amber-600 mt-2 leading-snug">
          Entrée reprise de l'ancienne mémoire des sites : elle ne sert qu'après confirmation de son origine.
        </p>
      </div>
    </div>
    <p v-else-if="!rg.coffreForm" class="text-sm text-slate-500 py-4 text-center">Aucune entrée.</p>

    <form
      v-if="rg.coffreForm"
      class="border border-blue-200 bg-blue-50/40 rounded-xl p-4 space-y-2.5"
      autocomplete="off"
      @submit.prevent="rg.saveCoffre()"
    >
      <div class="text-sm font-medium text-slate-700">
        {{ rg.coffreForm.id ? "Modifier l'entrée" : "Nouvelle entrée" }}
      </div>
      <div class="grid grid-cols-2 gap-2.5">
        <div>
          <label for="coffre-nom" class="text-xs font-medium text-slate-500">Nom</label>
          <input
            id="coffre-nom"
            v-model="rg.coffreForm.nom"
            placeholder="intranet"
            maxlength="40"
            class="set-input mt-0.5"
          />
        </div>
        <div>
          <label for="coffre-origine" class="text-xs font-medium text-slate-500">Origine</label>
          <input
            id="coffre-origine"
            v-model="rg.coffreForm.origin"
            placeholder="https://intranet.example.lan:8443"
            class="set-input mt-0.5"
          />
        </div>
        <div>
          <label for="coffre-identifiant" class="text-xs font-medium text-slate-500">Identifiant</label>
          <input
            id="coffre-identifiant"
            v-model="rg.coffreForm.username"
            placeholder="utilisateur"
            autocomplete="off"
            class="set-input mt-0.5"
          />
        </div>
        <div>
          <label for="coffre-mdp" class="text-xs font-medium text-slate-500">Mot de passe</label>
          <input
            id="coffre-mdp"
            v-model="rg.coffreForm.password"
            type="password"
            autocomplete="new-password"
            :placeholder="rg.coffreForm.id ? 'vide = inchangé' : 'mot de passe'"
            class="set-input mt-0.5"
          />
        </div>
      </div>
      <p v-if="rg.coffreErreur" role="alert" class="text-xs text-red-600">{{ rg.coffreErreur }}</p>
      <div class="flex items-center gap-2 pt-1">
        <button
          type="submit"
          :disabled="rg.coffreBusy"
          class="px-3.5 py-1.5 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm font-medium transition-colors disabled:opacity-50"
        >
          {{ rg.coffreForm.id ? "Enregistrer" : "Ajouter" }}
        </button>
        <button
          type="button"
          class="px-3 py-1.5 text-sm font-medium text-slate-600 hover:bg-slate-100 rounded-lg transition-colors"
          @click="rg.cancelCoffre()"
        >
          Annuler
        </button>
      </div>
    </form>
    <button
      v-if="!rg.coffreForm"
      type="button"
      class="w-full px-3 py-2 border border-dashed border-slate-300 rounded-lg text-sm text-slate-500 hover:border-blue-300 hover:text-blue-600 transition-colors flex items-center justify-center gap-1.5"
      @click="rg.newCoffre()"
    >
      <i class="ph ph-plus" aria-hidden="true"></i> Ajouter une entrée
    </button>
  </div>
</template>
