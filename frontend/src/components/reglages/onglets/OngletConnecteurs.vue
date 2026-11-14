<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/reglages/onglets/OngletConnecteurs.vue — Paramètres › Secrets › Comptes Git : comptes désignés par l'URL d'un serveur, d'une organisation ou d'un dépôt, jeton en écriture seule. -->
<script setup lang="ts">
import { nextTick, ref } from "vue";

import { nomTypeGit } from "../../../features/reglages/connecteurs-git";
import { domaineReglages } from "../../../features/reglages/domaine";
import { cibleCompte } from "../../../utils/portee-git";

const rg = domaineReglages();
const niveaux = ref<HTMLElement | null>(null);

/** Flèches dans « Utiliser ce compte pour » : le niveau voisin est choisi et prend le focus. */
function niveauVoisin(pas: number): void {
  const f = rg.gitConnForm;
  if (!f?.niveaux.length) return;
  const i = f.niveaux.indexOf(f.portee);
  f.portee = f.niveaux[i < 0 ? 0 : (i + pas + f.niveaux.length) % f.niveaux.length] ?? f.portee;
  void nextTick(() => niveaux.value?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus());
}
</script>

<template>
  <!-- eslint-disable vue/multiline-html-element-content-newline -->
  <div class="space-y-5 max-w-xl" data-onglet-git>
    <p class="text-xs text-slate-500 leading-snug" data-regle>
      Un compte sert pour les dépôts placés sous son URL (serveur, organisation ou dépôt). Si plusieurs
      conviennent, le plus précis est pris.
    </p>
    <div v-if="rg.gitConnectors.length" class="space-y-2">
      <div v-for="c in rg.gitConnectors" :key="c.id" class="border border-slate-200 rounded-xl p-3.5">
        <div class="flex items-center gap-3">
          <i class="ph ph-git-branch text-lg text-slate-400 shrink-0"></i>
          <div class="flex-1 min-w-0">
            <div class="text-sm font-medium text-slate-800 truncate" data-portee-compte>
              {{ cibleCompte(c)
              }}<span v-if="c.label" class="text-slate-500 font-normal"> · {{ c.label }}</span>
              <span
                v-if="c.path === null"
                class="ml-1.5 text-xs font-normal text-amber-600"
                title="Ce compte ne sert à aucun dépôt : modifiez-le pour choisir à quoi il sert."
                data-sans-portee
                >inactif</span
              >
              <span
                v-if="c.to_verify"
                class="ml-1.5 text-xs font-normal text-amber-600"
                title="Jeton importé de votre sandbox : vérifiez-le dans Secrets web, ou saisissez-le ici."
                data-a-verifier
                >à vérifier</span
              >
            </div>
            <div class="text-xs text-slate-500">
              {{ nomTypeGit(c.provider_type) }}<span v-if="c.username"> · {{ c.username }}</span>
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
            aria-label="Modifier le compte"
            class="w-7 h-7 rounded-md text-slate-500 hover:bg-slate-100 hover:text-slate-700 flex items-center justify-center shrink-0"
            @click="rg.editGitConnector(c)"
          >
            <i class="ph ph-pencil-simple" aria-hidden="true"></i>
          </button>
          <button
            title="Supprimer"
            aria-label="Supprimer le compte"
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
    <p v-else-if="!rg.gitConnForm" class="text-sm text-slate-500 py-4 text-center">Aucun compte Git.</p>

    <div v-if="rg.gitConnForm" class="border border-blue-200 bg-blue-50/40 rounded-xl p-4 space-y-2.5">
      <div class="text-sm font-medium text-slate-700">
        {{ rg.gitConnForm.id ? "Modifier le compte" : "Nouveau compte" }}
      </div>

      <div>
        <label for="git-url" class="text-xs font-medium text-slate-500">URL</label>
        <input
          id="git-url"
          v-model="rg.gitConnForm.repo_url"
          placeholder="https://git.example.lan/equipe/depot.git"
          autocomplete="off"
          spellcheck="false"
          aria-describedby="git-url-aide"
          class="set-input mt-0.5 font-mono"
          data-url
          @input="rg.readGitConnUrl()"
          @change="rg.parseGitRepoUrl()"
        />
        <p id="git-url-aide" class="text-xs text-slate-500 mt-1 leading-snug">
          URL de votre serveur Git, d'une organisation ou d'un dépôt.
        </p>
      </div>

      <div v-if="rg.gitConnForm.niveaux.length">
        <div id="git-portee-lbl" class="text-xs font-medium text-slate-500">Utiliser ce compte pour</div>
        <div
          ref="niveaux"
          class="flex flex-wrap gap-1.5 mt-1"
          role="radiogroup"
          aria-labelledby="git-portee-lbl"
          @keydown.left.prevent="niveauVoisin(-1)"
          @keydown.up.prevent="niveauVoisin(-1)"
          @keydown.right.prevent="niveauVoisin(1)"
          @keydown.down.prevent="niveauVoisin(1)"
        >
          <button
            v-for="(n, i) in rg.gitConnForm.niveaux"
            :key="n"
            type="button"
            role="radio"
            class="px-2 py-0.5 text-xs rounded-md border transition-colors"
            :class="
              rg.gitConnForm.portee === n
                ? 'border-blue-300 bg-blue-50 text-blue-700'
                : 'border-slate-200 text-slate-600 hover:bg-slate-50'
            "
            :aria-checked="rg.gitConnForm.portee === n ? 'true' : 'false'"
            :tabindex="
              rg.gitConnForm.portee === n ||
              (i === 0 && !rg.gitConnForm.niveaux.includes(rg.gitConnForm.portee))
                ? 0
                : -1
            "
            data-niveau
            @click="rg.gitConnForm.portee = n"
          >
            <span class="font-mono">{{ n }}</span
            ><template v-if="i === 0"> · tout le serveur</template>
          </button>
        </div>
      </div>

      <div>
        <label for="git-type" class="text-xs font-medium text-slate-500">Type de serveur</label>
        <select
          id="git-type"
          v-model="rg.gitConnForm.provider_type"
          class="set-select w-full mt-0.5"
          @change="rg.retypeGitConn()"
        >
          <option v-for="t in rg.gitConnTypes" :key="t" :value="t">{{ nomTypeGit(t) }}</option>
        </select>
      </div>

      <div class="grid grid-cols-2 gap-2.5">
        <div>
          <label for="git-identifiant" class="text-xs font-medium text-slate-500">Identifiant</label>
          <input
            id="git-identifiant"
            v-model="rg.gitConnForm.username"
            placeholder="utilisateur"
            autocomplete="off"
            class="set-input mt-0.5"
          />
        </div>
        <div>
          <label for="git-jeton" class="text-xs font-medium text-slate-500">{{
            rg.gitConnForm.provider_type === "github" ? "Jeton d'accès" : "Jeton ou mot de passe"
          }}</label>
          <input
            id="git-jeton"
            v-model="rg.gitConnForm.token"
            type="password"
            autocomplete="off"
            :placeholder="
              rg.gitConnForm.id ? 'vide : inchangé' : rg.gitConnForm.provider_type === 'github' ? 'ghp_…' : ''
            "
            class="set-input mt-0.5"
          />
        </div>
      </div>
      <div>
        <label for="git-nom" class="text-xs font-medium text-slate-500">Nom du compte (facultatif)</label>
        <input
          id="git-nom"
          v-model="rg.gitConnForm.label"
          placeholder="perso, robot…"
          class="set-input mt-0.5"
        />
      </div>

      <button
        type="button"
        class="text-xs text-slate-500 hover:text-slate-700 flex items-center gap-1"
        @click="rg.gitConnAdvanced = !rg.gitConnAdvanced"
      >
        <i class="ph" :class="rg.gitConnAdvanced ? 'ph-minus' : 'ph-plus'"></i> Avancé
      </button>
      <div v-if="rg.gitConnAdvanced" class="space-y-2.5 pt-2 border-t border-blue-100">
        <div>
          <label for="git-api" class="text-xs font-medium text-slate-500">URL de l'API</label>
          <input
            id="git-api"
            v-model="rg.gitConnForm.api_base"
            placeholder="http://git.example.lan:3000/api/v1"
            aria-describedby="git-api-aide"
            class="set-input mt-0.5 font-mono"
          />
          <p id="git-api-aide" class="text-xs text-slate-500 mt-1 leading-snug">
            Sert à lister vos dépôts et à tester le compte ; vide : déduite de l'URL.
          </p>
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
      <i class="ph ph-plus"></i> Ajouter un compte
    </button>
  </div>
</template>
