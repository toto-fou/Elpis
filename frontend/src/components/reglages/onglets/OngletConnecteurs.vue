<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/reglages/onglets/OngletConnecteurs.vue — onglet « connectors » des Paramètres. -->
<script setup lang="ts">
import AideOnglet from "../AideOnglet.vue";
import { domaineReglages } from "../../../features/reglages/domaine";

const rg = domaineReglages();
const titre = "Comptes Git";
</script>

<template>
  <!-- eslint-disable vue/multiline-html-element-content-newline -->
  <div class="space-y-5 max-w-xl">
    <AideOnglet :titre="titre"
      >Vos jetons Git (GitHub, GitLab, Bitbucket, Gitea), pour le push/pull et les PR
      authentifiés.</AideOnglet
    >

    <div v-if="rg.gitConnectors.length" class="space-y-2">
      <div v-for="c in rg.gitConnectors" :key="c.id" class="border border-slate-200 rounded-xl p-3.5">
        <div class="flex items-center gap-3">
          <i class="ph ph-git-branch text-lg text-slate-400 shrink-0"></i>
          <div class="flex-1 min-w-0">
            <div class="text-sm font-medium text-slate-800 truncate">
              {{ c.host }}<span v-if="c.label" class="text-slate-500 font-normal"> · {{ c.label }}</span>
            </div>
            <div class="text-xs text-slate-500">
              {{ c.provider_type }}<span v-if="c.username"> · {{ c.username }}</span>
            </div>
          </div>
          <span
            v-if="rg.gitConnTest[c.id]"
            class="text-xs shrink-0"
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
            class="px-2 py-1 text-xs rounded-md border border-slate-200 text-slate-600 hover:bg-slate-50 shrink-0"
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
          class="text-xs text-amber-600 mt-2 leading-snug"
        >
          {{ rg.gitConnTest[c.id]?.hint }}
        </p>
      </div>
    </div>
    <p v-else-if="!rg.gitConnForm" class="text-sm text-slate-500 py-4 text-center">
      Aucun connecteur configuré.
    </p>

    <div v-if="rg.gitConnForm" class="border border-blue-200 bg-blue-50/40 rounded-xl p-4 space-y-2.5">
      <div class="text-sm font-medium text-slate-700">
        {{ rg.gitConnForm.id ? "Modifier le connecteur" : "Nouveau connecteur" }}
      </div>

      <div>
        <label class="text-xs font-medium text-slate-500">Service</label>
        <select
          v-model="rg.gitConnForm.provider_type"
          class="set-select w-full mt-0.5"
          @change="rg.parseGitRepoUrl()"
        >
          <option v-for="t in rg.gitConnTypes" :key="t" :value="t">{{ t }}</option>
        </select>
      </div>

      <div v-if="!rg.gitConnForm.id">
        <label class="text-xs font-medium text-slate-500">URL du dépôt à cloner</label>
        <input
          v-model="rg.gitConnForm.repo_url"
          placeholder="https://git.example.lan/team/repo.git"
          class="set-input mt-0.5"
          @change="rg.parseGitRepoUrl()"
          @blur="rg.parseGitRepoUrl()"
        />
        <p v-if="rg.gitConnForm.host" class="text-xs text-slate-500 mt-1">
          Host détecté : <span class="font-mono text-slate-600">{{ rg.gitConnForm.host }}</span>
        </p>
      </div>

      <div class="grid grid-cols-2 gap-2.5">
        <div>
          <label class="text-xs font-medium text-slate-500">Login</label>
          <input v-model="rg.gitConnForm.username" placeholder="utilisateur" class="set-input mt-0.5" />
        </div>
        <div>
          <label class="text-xs font-medium text-slate-500">{{
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
        class="text-xs text-slate-500 hover:text-slate-700 flex items-center gap-1"
        @click="rg.gitConnAdvanced = !rg.gitConnAdvanced"
      >
        <i class="ph" :class="rg.gitConnAdvanced ? 'ph-minus' : 'ph-plus'"></i> Paramètres avancés
      </button>
      <div v-if="rg.gitConnAdvanced" class="space-y-2.5 pt-2 border-t border-blue-100">
        <div>
          <label class="text-xs font-medium text-slate-500">host (override)</label>
          <input
            v-model="rg.gitConnForm.host"
            placeholder="git.example.lan:3000 (host:port, sans http://)"
            class="set-input mt-0.5"
          />
        </div>
        <div>
          <label class="text-xs font-medium text-slate-500">api_base (PR / test)</label>
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
</template>
