<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/reglages/onglets/OngletProcedures.vue — onglet « Procédures » des Paramètres : versions enregistrées par l'assistant, résumé lisible, approbation (seule une version approuvée s'exécute sans vous), suppression. -->
<script setup lang="ts">
import { onMounted } from "vue";

import { CLE_PROCEDURES, domaineRacine } from "../../../app/racine/domaine";
import { cleVersion } from "../../../app/racine/procedures";
import AideOnglet from "../AideOnglet.vue";

const p = domaineRacine(CLE_PROCEDURES);
const titre = "Procédures";
const date = (t: number): string =>
  new Date(t * 1000).toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" });

onMounted(() => void p.chargerProcedures());
</script>

<template>
  <!-- eslint-disable vue/multiline-html-element-content-newline -->
  <div class="space-y-5 max-w-xl">
    <AideOnglet :titre="titre"
      >Les gestes que l'assistant a gardés pour un site. Dans une conversation, ils demandent votre accord par
      un bouton. Une routine ou un sous-agent n'exécute qu'une version que vous avez approuvée ici : une
      version créée ou réparée par l'assistant ne l'est jamais.</AideOnglet
    >

    <p v-if="p.procedures_charge && !p.procedures.length" class="text-sm text-slate-500">
      Aucune procédure enregistrée.
    </p>

    <div v-for="pr in p.procedures" :key="pr.id" class="border border-slate-200 rounded-xl p-3.5 space-y-2">
      <div class="flex items-center gap-3">
        <i class="ph ph-list-checks text-lg text-slate-400 shrink-0" aria-hidden="true"></i>
        <div class="flex-1 min-w-0">
          <div class="text-sm font-medium text-slate-800 truncate">{{ pr.id }}</div>
          <div class="text-xs text-slate-500 truncate" :title="pr.description">
            {{ pr.origin }} · {{ pr.description }}
          </div>
        </div>
        <button
          type="button"
          class="px-2 py-1 text-xs rounded-md border border-slate-200 text-slate-600 hover:bg-slate-50 shrink-0"
          :title="
            p.armee === pr.id ? 'Cliquez encore pour supprimer toutes les versions' : 'Supprimer la procédure'
          "
          :disabled="p.occupee"
          @click="p.supprimer(pr.id, 0)"
        >
          {{ p.armee === pr.id ? "Confirmer" : "Supprimer" }}
        </button>
      </div>

      <div
        v-for="v in pr.versions"
        :key="v.version"
        class="border-t border-slate-100 pt-2 space-y-1.5"
        :data-version="cleVersion(pr.id, v.version)"
      >
        <div class="flex items-center gap-2 text-xs">
          <button
            type="button"
            class="font-medium text-slate-700 hover:underline"
            :aria-expanded="p.ouverte === cleVersion(pr.id, v.version)"
            @click="p.voir(pr.id, v.version)"
          >
            Version {{ v.version }}
          </button>
          <span class="text-slate-500 truncate flex-1"
            >{{ date(v.created_at)
            }}<template v-if="v.parent_version !== null">
              · réparation de la v{{ v.parent_version }}</template
            ></span
          >
          <span v-if="v.approved_at !== null" class="text-emerald-600 shrink-0" title="Approuvée par vous">
            Approuvée
          </span>
          <button
            type="button"
            class="px-2 py-1 rounded-md border border-slate-200 text-slate-600 hover:bg-slate-50 shrink-0"
            :title="
              p.armee === cleVersion(pr.id, v.version)
                ? 'Cliquez encore pour supprimer'
                : 'Supprimer cette version'
            "
            :disabled="p.occupee"
            @click="p.supprimer(pr.id, v.version)"
          >
            {{ p.armee === cleVersion(pr.id, v.version) ? "Confirmer" : "Supprimer" }}
          </button>
        </div>
        <div v-if="p.ouverte === cleVersion(pr.id, v.version)" class="space-y-2">
          <pre
            class="text-xs text-slate-700 bg-slate-50 rounded-md p-2 overflow-x-auto whitespace-pre-wrap"
            >{{ (p.resumes[cleVersion(pr.id, v.version)]?.lines ?? ["Chargement…"]).join("\n") }}</pre>
          <template v-if="p.resumes[cleVersion(pr.id, v.version)]">
            <div
              v-for="q in p.resumes[cleVersion(pr.id, v.version)]?.params ?? []"
              :key="q.name"
              class="flex items-center gap-2 text-xs"
            >
              <span class="font-medium text-slate-700 w-24 truncate" :title="q.name">{{ q.name }}</span>
              <span class="text-slate-500 shrink-0">{{
                q.type === "creds" ? "Identifiant (/creds)" : q.type
              }}</span>
              <span
                v-if="q.type === 'creds'"
                class="text-slate-500 flex-1"
                title="Fourni à chaque exécution en conversation par la commande /creds ; jamais disponible en routine."
                >fourni à chaque exécution en conversation ; jamais disponible en routine</span
              >
              <template v-if="q.type !== 'creds' && p.choix[cleVersion(pr.id, v.version)]?.[q.name]">
                <label class="flex items-center gap-1 shrink-0">
                  <input
                    v-model="p.choix[cleVersion(pr.id, v.version)]![q.name]!.libre"
                    type="checkbox"
                    :disabled="v.approved_at !== null"
                  />
                  Libre (choisie par l'assistant)
                </label>
                <input
                  v-if="!p.choix[cleVersion(pr.id, v.version)]![q.name]!.libre"
                  v-model="p.choix[cleVersion(pr.id, v.version)]![q.name]!.valeur"
                  type="text"
                  class="border border-slate-200 rounded-md px-2 py-1 flex-1 min-w-0"
                  placeholder="Valeur figée"
                  :aria-label="`Valeur figée de ${q.name}`"
                  :disabled="v.approved_at !== null"
                />
              </template>
            </div>
            <p v-if="p.erreurNombre(pr.id, v.version)" class="text-xs text-red-600" role="alert">
              {{ p.erreurNombre(pr.id, v.version) }}
            </p>
            <div class="flex justify-end gap-2">
              <button
                v-if="v.approved_at === null"
                type="button"
                class="px-2 py-1 text-xs rounded-md border border-slate-200 text-slate-600 hover:bg-slate-50 disabled:opacity-50"
                :disabled="p.occupee || !p.pret(pr.id, v.version)"
                title="Autoriser cette version à s'exécuter sans vous (routines, sous-agents), avec ces paramètres"
                @click="p.approuver(pr.id, v.version)"
              >
                Approuver
              </button>
              <button
                v-else
                type="button"
                class="px-2 py-1 text-xs rounded-md border border-slate-200 text-slate-600 hover:bg-slate-50"
                :disabled="p.occupee"
                @click="p.retirer(pr.id, v.version)"
              >
                Retirer l'approbation
              </button>
            </div>
          </template>
        </div>
      </div>
    </div>
  </div>
</template>
