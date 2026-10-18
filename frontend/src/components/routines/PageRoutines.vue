<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/routines/PageRoutines.vue — page des routines : en-tête (retour, menu des groupes, actions), liste, vue lecture ou formulaire. -->
<script setup lang="ts">
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
    <!-- En création/édition : la flèche ANNULE (retour vue/liste), le titre devient celui du formulaire, et le header -->
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
            {{
              !rt.routineIsEditing
                ? "Routines"
                : rt.routineEditMode === "edit"
                  ? "Modifier la routine"
                  : "Nouvelle routine"
            }}
          </h2>
          <p v-if="!rt.routineIsEditing" class="text-xs text-slate-500 truncate">
            Tâches récurrentes automatisées : l'agent exécute une tâche planifiée avec les outils MCP et les
            skills choisis.
          </p>
          <p v-else class="text-xs text-slate-500 truncate">
            {{ rt.routineForm.name || "Sans nom" }} · {{ rt.scheduleSummary }}
          </p>
        </div>
      </div>

      <!-- Menu des groupes de configuration (création/édition seulement) -->
      <nav
        v-if="rt.routineIsEditing"
        aria-label="Sections de la configuration"
        class="flex items-center gap-1 min-w-0 overflow-x-auto"
        data-routine-tabs
      >
        <button
          v-for="t in rt.routineEditTabs"
          :key="t.id"
          type="button"
          :aria-current="rt.routineEditTab === t.id ? 'true' : undefined"
          class="px-3 py-1.5 rounded-md text-xs font-medium transition-colors shrink-0 flex items-center gap-1.5"
          :class="
            rt.routineEditTab === t.id
              ? 'bg-slate-100 text-slate-900'
              : 'text-slate-500 hover:text-slate-700 hover:bg-slate-50'
          "
          @click="rt.routineEditTab = t.id"
        >
          <i
            class="ph text-sm"
            :class="[t.icon, rt.routineEditTab === t.id ? 'text-blue-600' : 'text-slate-400']"
          ></i
          >{{ t.label }}
        </button>
      </nav>

      <div v-if="!rt.routineIsEditing" class="flex items-center gap-1.5 shrink-0">
        <button
          class="text-xs px-3 py-1.5 rounded-md bg-blue-600 text-white hover:bg-blue-700 transition-colors flex items-center gap-1.5"
          @click="rt.startCreateRoutine"
        >
          <i class="ph ph-plus"></i> Nouvelle
        </button>
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
