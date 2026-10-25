<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/routines/PageRoutines.vue — page des routines : en-tête (retour, actions), liste, vue lecture ou formulaire. -->
<script setup lang="ts">
import BoutonAssistant from "../communs/BoutonAssistant.vue";
import FormulaireRoutine from "./FormulaireRoutine.vue";
import ListeRoutines from "./ListeRoutines.vue";
import VueRoutine from "./VueRoutine.vue";
import { domaineRoutines } from "../../features/routines/domaine";

const rt = domaineRoutines();
</script>

<template>
  <div
    v-if="rt.currentView === 'routines'"
    role="region"
    aria-label="Gestion des routines"
    class="elpis-routines-page absolute inset-0 z-[45] bg-white flex flex-col"
  >
    <!-- == Header ================================================ -->
    <header
      class="h-16 shrink-0 flex items-center justify-between gap-3 px-4 bg-white border-b border-slate-200"
    >
      <div class="flex items-center gap-3 min-w-0 shrink-0">
        <button
          :title="rt.routineIsEditing ? 'Annuler et revenir' : 'Retour au chat'"
          class="w-9 h-9 rounded-lg text-slate-500 hover:bg-slate-50 hover:text-slate-700 flex items-center justify-center transition-colors shrink-0"
          @click="rt.routineIsEditing ? rt.cancelRoutineEdit() : rt.closeRoutinesPage()"
        >
          <i class="ph ph-arrow-left text-lg"></i>
        </button>
        <i class="ph ph-clock-countdown text-blue-500 text-2xl shrink-0"></i>
        <div class="min-w-0">
          <h2 class="font-bold text-base text-slate-900 tracking-tight leading-tight">
            <span
              v-if="rt.routineDirty"
              class="text-amber-700"
              title="Modifications non enregistrées"
              aria-label="Modifications non enregistrées"
              data-routine-dirty
              >● </span
            >{{
              !rt.routineIsEditing
                ? "Routines"
                : rt.routineEditMode === "edit"
                  ? "Modifier la routine"
                  : "Nouvelle routine"
            }}
          </h2>
          <p
            v-if="!rt.routineIsEditing"
            class="text-xs text-slate-500 truncate"
            title="L’assistant exécute une tâche planifiée avec les outils MCP et les skills choisis"
          >
            Tâches planifiées
          </p>
          <p v-else class="text-xs text-slate-500 truncate">
            {{ rt.routineForm.name || "Sans nom" }} · {{ rt.scheduleSummary }}
          </p>
        </div>
      </div>

      <div v-if="!rt.routineIsEditing" class="flex items-center gap-1.5 shrink-0">
        <button
          class="text-xs px-3 py-1.5 rounded-md bg-blue-600 text-white hover:bg-blue-700 transition-colors flex items-center gap-1.5"
          @click="rt.startCreateRoutine"
        >
          <i class="ph ph-plus"></i> Nouvelle
        </button>
        <BoutonAssistant
          title="Créer une routine en dialoguant : l'assistant pose les questions et l'enregistre en pause"
          @click="rt.ouvrirAssistant('routine')"
        />
        <button
          title="Rafraîchir"
          class="w-9 h-9 rounded-md text-slate-500 hover:bg-slate-50 transition-colors flex items-center justify-center"
          @click="rt.loadRoutines"
        >
          <i class="ph ph-arrow-clockwise" :class="rt.routinesLoading && 'animate-spin'"></i>
        </button>
      </div>
    </header>

    <!-- == Body: two columns (list | editor) ===================== -->
    <div class="flex-1 flex min-h-0">
      <ListeRoutines />
      <!-- RIGHT: editor / placeholder -->
      <div class="flex-1 flex flex-col min-h-0">
        <!-- Vide : seulement si aucune routine (sinon on auto-affiche la vue). -->
        <div
          v-if="rt.routineEditMode === ''"
          class="flex-1 flex flex-col items-center justify-center text-center px-6"
        >
          <i class="ph ph-clock-countdown text-slate-300 text-3xl block mb-3"></i>
          <p v-if="rt.routinesLoading" class="text-sm text-slate-400">Chargement…</p>
          <template v-else-if="rt.routines.length === 0">
            <p class="text-sm text-slate-500">Aucune routine planifiée.</p>
            <button
              class="mt-3 text-xs px-3 py-1.5 rounded-md bg-blue-600 text-white hover:bg-blue-700 transition-colors"
              @click="rt.startCreateRoutine"
            >
              Créer une routine
            </button>
            <BoutonAssistant class="mt-2" @click="rt.ouvrirAssistant('routine')" />
          </template>
          <p v-else class="text-sm text-slate-500">
            Sélectionnez une routine à gauche pour voir ses exécutions.
          </p>
        </div>

        <VueRoutine v-else-if="rt.routineEditMode === 'view' && rt.viewed" />
        <FormulaireRoutine v-else />
      </div>
    </div>
  </div>
</template>
