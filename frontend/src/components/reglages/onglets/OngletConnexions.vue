<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/reglages/onglets/OngletConnexions.vue — Paramètres › Secrets : jetons personnels d'un genre, « Jetons MCP » (outils, applications autorisées) ou « Remote » (un jeton par poste relié). -->
<script setup lang="ts">
import { computed } from "vue";

import type { GenreJeton } from "../../../features/reglages/connexions";
import { domaineReglages } from "../../../features/reglages/domaine";

const props = defineProps<{ genre: GenreJeton }>();
const rg = domaineReglages();
const remote = computed(() => props.genre === "opencode");
/** Jetons, jeton montré et formulaire de ce genre seulement : l'autre partie garde les siens. */
const jetons = computed(() => rg.cnxState.tokens.filter((t) => t.kind === props.genre));
const montre = computed(() => (rg.cnxState.reveal?.item.kind === props.genre ? rg.cnxState.reveal : null));
const formulaire = computed(() => (rg.cnxState.form?.kind === props.genre ? rg.cnxState.form : null));
/** Création possible : jetons d'outils permis par l'administrateur, ou Remote activé. */
const creable = computed(() =>
  remote.value ? rg.cnxState.opencode : !rg.cnxState.policy || rg.cnxState.policy.tools_enabled,
);
</script>

<template>
  <!-- eslint-disable vue/multiline-html-element-content-newline -->
  <div class="space-y-5 max-w-2xl" :data-jetons="genre">
    <p class="text-xs text-slate-500 leading-snug" data-protection>
      <template v-if="remote">Un jeton par poste relié en Remote : le révoquer déconnecte ce poste. </template
      >Elpis ne garde que l'empreinte d'un jeton : sa valeur n'est montrée qu'à sa création.
    </p>
    <div
      v-if="montre"
      class="border rounded-xl p-4 space-y-3"
      :class="montre.token ? 'border-amber-300 bg-amber-50/60' : 'border-slate-200'"
      data-jeton-montre
    >
      <div class="flex items-center gap-2">
        <i class="ph ph-key text-slate-500" aria-hidden="true"></i>
        <div class="text-sm font-medium text-slate-800 flex-1 truncate">
          {{ montre.item.name }}
        </div>
        <button
          aria-label="Fermer"
          class="w-7 h-7 rounded-md text-slate-500 hover:bg-slate-100 flex items-center justify-center"
          @click="rg.cnxCloseReveal()"
        >
          <i class="ph ph-x" aria-hidden="true"></i>
        </button>
      </div>
      <template v-if="montre.token">
        <p class="text-xs text-amber-700">Copiez ce jeton maintenant : il ne sera plus affiché.</p>
        <div class="flex items-center gap-2">
          <code
            class="flex-1 min-w-0 truncate font-mono text-xs bg-white border border-slate-200 rounded-md px-2.5 py-1.5 select-all"
            >{{ montre.token }}</code
          >
          <button
            class="px-2.5 py-1.5 text-xs rounded-md border border-slate-200 text-slate-600 hover:bg-slate-50 shrink-0"
            @click="rg.cnxCopy(montre.token)"
          >
            Copier
          </button>
        </div>
      </template>
      <p v-else class="text-xs text-slate-500">
        Remplacez <code class="font-mono">&lt;VOTRE_JETON&gt;</code> par le jeton copié à sa création.
      </p>
      <div class="flex flex-wrap gap-1" role="tablist">
        <button
          v-for="b in rg.cnxBlocks()"
          :key="b.id"
          role="tab"
          :aria-selected="rg.cnxState.tab === b.id ? 'true' : 'false'"
          class="h-7 px-2.5 rounded-md text-xs transition-colors"
          :class="
            rg.cnxState.tab === b.id
              ? 'bg-blue-50 text-blue-700 font-semibold'
              : 'text-slate-600 hover:bg-slate-100'
          "
          @click="rg.cnxState.tab = b.id"
        >
          {{ b.label }}
        </button>
      </div>
      <template v-for="b in rg.cnxBlocks()" :key="'blk' + b.id">
        <div v-if="rg.cnxState.tab === b.id" class="relative">
          <pre
            class="font-mono text-xs leading-relaxed bg-slate-50 border border-slate-200 rounded-lg p-3 max-h-64 overflow-auto custom-scrollbar whitespace-pre"
            >{{ b.text }}</pre>
          <button
            class="absolute top-2 right-2 px-2 py-1 text-xs rounded-md border border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
            @click="rg.cnxCopy(b.text)"
          >
            Copier
          </button>
        </div>
      </template>
      <div
        v-if="montre.item.kind === 'tools'"
        class="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500"
      >
        <span>Schémas :</span>
        <template v-for="f in montre.item.families" :key="'sch' + f">
          <a :href="rg.cnxSchemaHref(f)" target="_blank" rel="noopener" class="text-blue-600 hover:underline"
            >{{ f }} (MCP)</a
          >
        </template>
      </div>
    </div>

    <div v-if="jetons.length" class="space-y-2">
      <div
        v-for="t in jetons"
        :key="t.id"
        class="border border-slate-200 rounded-xl p-3.5 flex items-center gap-3"
        data-jeton
      >
        <i
          class="ph text-lg text-slate-400 shrink-0"
          :class="remote ? 'ph-terminal-window' : 'ph-key'"
          aria-hidden="true"
        ></i>
        <div class="flex-1 min-w-0">
          <div class="text-sm font-medium text-slate-800 truncate">
            {{ t.name }}
            <span class="text-slate-400 font-normal font-mono text-xs">…{{ t.hint }}</span>
          </div>
          <div class="text-xs text-slate-500 truncate">
            <template v-if="t.families.length">{{ t.families.join(", ") }} · </template>créé le
            {{ rg.cnxDate(t.created_at) }} ·
            {{ t.last_used_at ? "utilisé le " + rg.cnxDate(t.last_used_at) : "jamais utilisé" }}
            <template v-if="t.expires_at"> · expire le {{ rg.cnxDate(t.expires_at) }}</template>
          </div>
        </div>
        <button
          :title="remote ? 'Commande de connexion' : 'Configuration des clients'"
          :aria-label="remote ? 'Commande de connexion' : 'Configuration des clients'"
          class="w-7 h-7 rounded-md text-slate-500 hover:bg-slate-100 hover:text-slate-700 flex items-center justify-center shrink-0"
          @click="rg.cnxShowConfig(t)"
        >
          <i class="ph ph-brackets-curly" aria-hidden="true"></i>
        </button>
        <button
          :disabled="rg.cnxState.busy"
          title="Régénérer"
          aria-label="Régénérer le jeton"
          class="w-7 h-7 rounded-md text-slate-500 hover:bg-slate-100 hover:text-slate-700 flex items-center justify-center shrink-0"
          @click="rg.cnxRegenerate(t)"
        >
          <i class="ph ph-arrows-clockwise" aria-hidden="true"></i>
        </button>
        <button
          title="Révoquer"
          aria-label="Révoquer le jeton"
          class="w-7 h-7 rounded-md text-slate-500 hover:bg-red-50 hover:text-red-600 flex items-center justify-center shrink-0"
          @click="rg.cnxRevoke(t)"
        >
          <i class="ph ph-trash" aria-hidden="true"></i>
        </button>
      </div>
    </div>
    <p v-else-if="!formulaire" class="text-sm text-slate-500 py-4 text-center">
      {{ remote ? "Aucun poste relié." : "Aucun jeton." }}
    </p>

    <div v-if="formulaire" class="border border-blue-200 bg-blue-50/40 rounded-xl p-4 space-y-2.5">
      <div class="text-sm font-medium text-slate-700">Nouveau jeton</div>
      <div>
        <label :for="'cnx-name-' + genre" class="text-xs font-medium text-slate-500">Nom</label>
        <input
          :id="'cnx-name-' + genre"
          v-model="formulaire.name"
          maxlength="80"
          :placeholder="remote ? 'ex. poste du bureau' : 'ex. VS Code du bureau, agent CI'"
          class="set-input mt-0.5"
          data-nom-jeton
        />
      </div>
      <template v-if="!remote && rg.cnxState.policy">
        <div>
          <div class="text-xs font-medium text-slate-500 mb-1">Familles d'outils</div>
          <div class="flex flex-wrap gap-x-4 gap-y-1.5">
            <label
              v-for="f in rg.cnxState.policy.families"
              :key="'cf' + f.name"
              class="inline-flex items-center gap-1.5 text-sm text-slate-700 cursor-pointer"
            >
              <input v-model="formulaire.families[f.name]" type="checkbox" class="rounded border-slate-300" />
              {{ f.label }} <span class="font-mono text-xs text-slate-400">{{ f.name }}</span>
            </label>
          </div>
          <p v-if="formulaire.families.desktop" class="text-xs text-amber-700 mt-1">
            « desktop » pilote vos machines hors de la sandbox.
          </p>
        </div>
        <div>
          <label for="cnx-days" class="text-xs font-medium text-slate-500">Durée de validité</label>
          <div class="flex items-center gap-2 mt-0.5">
            <input
              id="cnx-days"
              v-model.number="formulaire.days"
              type="number"
              min="0"
              :max="rg.cnxState.policy.max_days || 3650"
              class="set-input w-28"
            />
            <span class="text-xs text-slate-500"
              >jours<template v-if="rg.cnxState.policy.max_days">
                (maximum {{ rg.cnxState.policy.max_days }})</template
              ><template v-else> (0 = sans limite)</template></span
            >
          </div>
        </div>
      </template>
      <p v-if="rg.cnxState.error" class="text-xs text-red-600">{{ rg.cnxState.error }}</p>
      <div class="flex items-center gap-2 pt-1">
        <button
          :disabled="rg.cnxState.busy"
          class="px-3.5 py-1.5 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm font-medium transition-colors disabled:opacity-50"
          @click="rg.cnxCreate()"
        >
          Créer
        </button>
        <button
          class="px-3 py-1.5 text-sm font-medium text-slate-600 hover:bg-slate-100 rounded-lg transition-colors"
          @click="rg.cnxCancel()"
        >
          Annuler
        </button>
      </div>
    </div>
    <button
      v-if="!formulaire"
      :disabled="!creable"
      data-nouveau-jeton
      class="w-full px-3 py-2 border border-dashed border-slate-300 rounded-lg text-sm text-slate-500 hover:border-blue-300 hover:text-blue-600 transition-colors flex items-center justify-center gap-1.5 disabled:opacity-50"
      @click="rg.cnxNew(genre)"
    >
      <i class="ph ph-plus" aria-hidden="true"></i> Nouveau jeton
    </button>
    <p v-if="!creable" class="text-xs text-slate-500" data-desactive>
      {{
        remote
          ? "Remote est désactivé par l'administrateur."
          : "Les jetons d'outils sont désactivés par l'administrateur."
      }}
    </p>

    <div v-if="!remote && (rg.cnxState.oauthEnabled || rg.cnxState.grants.length)" class="pt-2 space-y-2">
      <div class="text-sm font-medium text-slate-700">Applications autorisées</div>
      <p class="text-xs text-slate-500">
        Un client MCP peut aussi se connecter avec la seule adresse
        <span class="font-mono">{{ rg.cnxState.bridgeUrl || "/api/mcp-bridge" }}</span> : Elpis vous demande
        alors votre accord.
      </p>
      <div
        v-for="g in rg.cnxState.grants"
        :key="g.grant_id"
        class="border border-slate-200 rounded-xl p-3.5 flex items-center gap-3"
      >
        <i class="ph ph-plugs-connected text-lg text-slate-400 shrink-0" aria-hidden="true"></i>
        <div class="flex-1 min-w-0">
          <div class="text-sm font-medium text-slate-800 truncate" :title="g.client_id">
            {{ g.client_name }}
          </div>
          <div class="text-xs text-slate-500 truncate">
            {{ g.families.join(", ") }}
            · autorisé le {{ rg.cnxDate(g.created_at) }} ·
            {{ g.last_used_at ? "utilisé le " + rg.cnxDate(g.last_used_at) : "jamais utilisé" }}
          </div>
        </div>
        <button
          title="Retirer l'accès"
          aria-label="Retirer l'accès"
          class="w-7 h-7 rounded-md text-slate-500 hover:bg-red-50 hover:text-red-600 flex items-center justify-center shrink-0"
          @click="rg.cnxRevokeGrant(g)"
        >
          <i class="ph ph-trash" aria-hidden="true"></i>
        </button>
      </div>
      <p v-if="!rg.cnxState.grants.length" class="text-sm text-slate-500 py-2 text-center">
        Aucune application autorisée.
      </p>
    </div>
  </div>
</template>
