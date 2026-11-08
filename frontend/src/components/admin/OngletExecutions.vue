<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/admin/OngletExecutions.vue — Activité › Exécutions. -->
<script setup lang="ts">
import { computed } from "vue";

import { domaineAdmin } from "../../features/admin/domaine";
import { heureLocale, isoUtc } from "../../features/admin/horodatage";
import { classeEtatRun, libGenre, libStatut } from "../../features/admin/libelles-activite";
import ChoixPeriode from "./ChoixPeriode.vue";
import EnteteTri from "./EnteteTri.vue";
import EtatActualisation from "./EtatActualisation.vue";
import PiedListe from "./PiedListe.vue";

const adm = domaineAdmin();
const estAdmin = computed(() => !!adm.user && adm.user.role === "admin");
const f = computed(() => adm.admRunsFilter);
const filtree = computed(
  () => !!(f.value.q || f.value.kind || f.value.status || f.value.userId !== null || f.value.runId),
);
const COMPTES_MAX = 50;
const comptes = computed(() => adm.admRunsAccounts.slice(0, COMPTES_MAX));
const comptesAutres = computed(() => Math.max(0, adm.admRunsAccounts.length - COMPTES_MAX));
const ouvrir = (id: string): void => {
  if (estAdmin.value) void adm.showRunDetails(id, [id], { admin: true });
};
const STATUTS_RUN = ["ok", "error", "cancelled", "timeout", "running", "lost"];
</script>

<template>
  <div class="space-y-3" :aria-busy="adm.admRunsLoading ? 'true' : 'false'">
    <div class="relative flex flex-wrap items-center justify-between gap-2">
      <ChoixPeriode :periode="adm.admRunsScope" @choisir="adm.setAdmRunsScope($event)" />
      <EtatActualisation
        :chargement="adm.admRunsLoading"
        :derniere-maj="adm.admRunsDerniereMaj"
        :echec="adm.admRunsEchec"
        @actualiser="adm.loadAdminRuns(true)"
      />
      <div class="adm-progression" :class="{ 'is-on': adm.admRunsLoading }" aria-hidden="true"></div>
    </div>

    <div class="adm-card">
      <div class="adm-card__head">
        <div class="adm-card__title flex items-center gap-2">
          <i class="ph ph-users adm-card__icon" aria-hidden="true"></i>
          <span title="Tokens, temps du modèle, outils et pics de la sandbox, sous-agents compris"
            >Par compte</span
          >
        </div>
        <span class="adm-row__hint ml-auto">Cliquer un compte filtre la liste ci-dessous</span>
      </div>
      <div class="overflow-x-auto">
        <table class="adm-table w-full">
          <thead>
            <tr>
              <th class="text-left">Compte</th>
              <th class="text-right">Exécutions</th>
              <th class="text-right" title="Exécutions terminées autrement que « ok »">Échecs</th>
              <th
                class="text-right"
                title="Tokens d'entrée, dont la part relue du cache (le reste est l'entrée utile)"
              >
                Entrée
              </th>
              <th class="text-right" title="Tokens générés, dont la réflexion (le reste est la réponse)">
                Sortie
              </th>
              <th class="text-right" title="Prefill (lecture du prompt) + génération">
                Prefill + génération
              </th>
              <th class="text-right" title="Attente d'un créneau LLM">Attente</th>
              <th class="text-right">Outils (erreurs)</th>
              <th class="text-right">Fichiers</th>
              <th class="text-right" title="Pics mesurés sur le conteneur de la sandbox">Sandbox (pics)</th>
            </tr>
          </thead>
          <tbody>
            <tr v-if="!adm.admRunsAccounts.length">
              <td colspan="10" class="text-center adm-empty">Aucune exécution sur la fenêtre choisie.</td>
            </tr>
            <tr
              v-for="a in comptes"
              :key="'ra' + a.user_id"
              tabindex="0"
              class="cursor-pointer"
              :class="adm.admRunsFilter.userId === a.user_id ? 'bg-blue-50' : ''"
              @click="adm.toggleAdmRunsAccount(a)"
              @keydown.enter="adm.toggleAdmRunsAccount(a)"
            >
              <td class="text-xs font-medium">{{ a.username || "#" + a.user_id }}</td>
              <td class="text-right tabular-nums text-xs">
                {{ a.runs }}<span v-if="a.subagents" class="adm-muted"> + {{ a.subagents }} sous-agents</span>
              </td>
              <td class="text-right tabular-nums text-xs" :class="a.failed ? 'text-rose-600' : 'adm-muted'">
                {{ a.failed }}
              </td>
              <td
                class="text-right tabular-nums text-xs whitespace-nowrap"
                :title="adm.admRunsTokensTitle(a)"
              >
                {{ adm.admRunsIn(a) }}
              </td>
              <td
                class="text-right tabular-nums text-xs whitespace-nowrap"
                :title="adm.admRunsTokensTitle(a)"
              >
                {{ adm.admRunsOut(a) }}
              </td>
              <td class="text-right tabular-nums text-xs whitespace-nowrap">
                {{ adm.admRunsDuration(a.prefill_ms) }} + {{ adm.admRunsDuration(a.decode_ms) }}
              </td>
              <td class="text-right tabular-nums text-xs adm-muted">{{ adm.admRunsDuration(a.wait_ms) }}</td>
              <td class="text-right tabular-nums text-xs">
                {{ a.tool_calls }}<span class="adm-muted"> ({{ a.tool_errors }})</span>
              </td>
              <td class="text-right tabular-nums text-xs">{{ a.files_changed }}</td>
              <td class="text-right tabular-nums text-xs adm-muted">
                <template v-if="a.sandbox_cpu_peak != null">
                  {{ Math.round(a.sandbox_cpu_peak) }} % · {{ Math.round(a.sandbox_mem_peak_mb || 0) }} Mio
                </template>
                <template v-else>—</template>
              </td>
            </tr>
            <tr v-if="comptesAutres > 0">
              <td colspan="10" class="text-center adm-empty">
                et {{ comptesAutres.toLocaleString("fr-FR") }} autres comptes (chercher un nom dans la liste
                ci-dessous)
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <div class="adm-card">
      <div class="adm-card__head flex-wrap gap-2">
        <div class="adm-card__title flex items-center gap-2">
          <i class="ph ph-list-magnifying-glass adm-card__icon" aria-hidden="true"></i>
          Exécutions
          <button
            v-if="adm.admRunsFilter.runId"
            type="button"
            class="adm-pill"
            title="Retirer le filtre d'exécution"
            @click="adm.setAdmRunsFilter({ runId: '' })"
          >
            {{ adm.admRunsFilter.runId }} <i class="ph ph-x text-[10px]" aria-hidden="true"></i>
          </button>
          <button
            v-if="adm.admRunsFilter.userId !== null"
            type="button"
            class="adm-pill"
            title="Retirer le filtre de compte"
            @click="adm.setAdmRunsFilter({ userId: null, username: '' })"
          >
            {{ adm.admRunsFilter.username }} <i class="ph ph-x text-[10px]" aria-hidden="true"></i>
          </button>
        </div>
      </div>
      <div class="sup-outils-carte">
        <div class="sup-recherche">
          <i class="ph ph-magnifying-glass" aria-hidden="true"></i>
          <input
            type="search"
            class="set-input"
            placeholder="Compte, modèle ou run_id"
            aria-label="Rechercher une exécution"
            maxlength="100"
            :value="adm.admRunsFilter.q"
            @input="adm.rechercherExecutions(($event.target as HTMLInputElement).value)"
          />
        </div>
        <select
          class="set-select"
          :value="adm.admRunsFilter.kind"
          aria-label="Genre"
          @change="adm.setAdmRunsFilter({ kind: ($event.target as HTMLInputElement).value })"
        >
          <option value="">Premier niveau</option>
          <option value="chat">Tours de chat</option>
          <option value="routine">Routines</option>
          <option value="subagent">Sous-agents</option>
          <option value="compaction">Compactions</option>
          <option value="image">Images</option>
        </select>
        <select
          class="set-select"
          :value="adm.admRunsFilter.status"
          aria-label="Statut"
          @change="adm.setAdmRunsFilter({ status: ($event.target as HTMLInputElement).value })"
        >
          <option value="">Tous statuts</option>
          <option v-for="s in STATUTS_RUN" :key="s" :value="s">{{ libStatut(s) }}</option>
        </select>
        <button
          v-if="filtree"
          type="button"
          class="adm-btn adm-btn--quiet adm-btn--sm sup-effacer"
          @click="adm.effacerFiltresExecutions()"
        >
          <i class="ph ph-x" aria-hidden="true"></i> Effacer les filtres
        </button>
        <span v-else-if="estAdmin" class="adm-row__hint ml-auto">Cliquer une ligne ouvre la chronologie</span>
      </div>
      <div class="sup-liste custom-scrollbar" :aria-busy="adm.admRunsLoading ? 'true' : 'false'">
        <table class="adm-table w-full">
          <thead class="adm-thead--sticky">
            <tr>
              <EnteteTri
                col="started_at"
                libelle="Début"
                :tri="adm.admRunsTri"
                @trier="adm.trierExecutions"
              />
              <EnteteTri col="username" libelle="Compte" :tri="adm.admRunsTri" @trier="adm.trierExecutions" />
              <EnteteTri col="kind" libelle="Genre" :tri="adm.admRunsTri" @trier="adm.trierExecutions" />
              <EnteteTri col="status" libelle="Statut" :tri="adm.admRunsTri" @trier="adm.trierExecutions" />
              <EnteteTri
                col="duration"
                libelle="Durée"
                droite
                :tri="adm.admRunsTri"
                @trier="adm.trierExecutions"
              />
              <EnteteTri
                col="input_tokens"
                libelle="Entrée"
                droite
                titre="Tokens d'entrée, dont la part relue du cache"
                :tri="adm.admRunsTri"
                @trier="adm.trierExecutions"
              />
              <EnteteTri
                col="output_tokens"
                libelle="Sortie"
                droite
                titre="Tokens générés, dont la réflexion"
                :tri="adm.admRunsTri"
                @trier="adm.trierExecutions"
              />
              <th class="text-right" title="Prefill (lecture du prompt) + génération">
                Prefill + génération
              </th>
              <EnteteTri
                col="tool_calls"
                libelle="Outils"
                droite
                :tri="adm.admRunsTri"
                @trier="adm.trierExecutions"
              />
              <EnteteTri col="engine" libelle="Moteur" :tri="adm.admRunsTri" @trier="adm.trierExecutions" />
              <th class="text-left">Run</th>
            </tr>
          </thead>
          <tbody>
            <template v-if="!adm.admRunsItems.length">
              <tr v-if="adm.admRunsLoading && !adm.admRunsDerniereMaj">
                <td colspan="11"><div class="adm-skeleton w-full"></div></td>
              </tr>
              <tr v-else-if="adm.admRunsEchec">
                <td colspan="11" class="text-center adm-empty adm-empty--error">
                  Exécutions indisponibles ·
                  <button type="button" class="adm-link" @click="adm.loadAdminRuns()">Réessayer</button>
                </td>
              </tr>
              <tr v-else>
                <td colspan="11" class="text-center adm-empty">Aucune exécution pour ces filtres.</td>
              </tr>
            </template>
            <tr
              v-for="r in adm.admRunsItems"
              :key="r.id"
              :tabindex="estAdmin ? 0 : -1"
              :class="[estAdmin ? 'sup-ligne' : '', adm.admRunsSurligne === r.id ? 'is-flash is-sel' : '']"
              :title="estAdmin ? 'Ouvrir la chronologie' : r.id"
              @click="ouvrir(r.id)"
              @keydown.enter="ouvrir(r.id)"
            >
              <td class="sup-quand">
                <time :datetime="isoUtc(r.started_at)" :title="isoUtc(r.started_at)">{{
                  heureLocale(r.started_at)
                }}</time>
              </td>
              <td class="text-xs">{{ r.username || "#" + r.user_id }}</td>
              <td class="text-xs">{{ libGenre(r.kind) }}</td>
              <td>
                <span class="sup-etat" :class="classeEtatRun(r.status)">{{ libStatut(r.status) }}</span>
              </td>
              <td class="text-right tabular-nums text-xs">
                {{ r.ended_at ? adm.admRunsDuration((r.ended_at - r.started_at) * 1000) : "—" }}
              </td>
              <td
                class="text-right tabular-nums text-xs whitespace-nowrap"
                :title="adm.admRunsTokensTitle(r)"
              >
                {{ adm.admRunsIn(r) }}
              </td>
              <td
                class="text-right tabular-nums text-xs whitespace-nowrap"
                :title="adm.admRunsTokensTitle(r)"
              >
                {{ adm.admRunsOut(r) }}
              </td>
              <td class="text-right tabular-nums text-xs whitespace-nowrap">
                {{ adm.admRunsDuration(r.prefill_ms) }} + {{ adm.admRunsDuration(r.decode_ms) }}
              </td>
              <td class="text-right tabular-nums text-xs">
                {{ r.tool_calls
                }}<span v-if="r.tool_errors" class="text-rose-600"> ({{ r.tool_errors }})</span>
              </td>
              <td class="text-xs adm-muted truncate max-w-[10rem]" :title="r.model">
                {{ r.engine || r.model || "—" }}
              </td>
              <td>
                <span class="sup-mono adm-muted" :title="r.id">{{ r.id.slice(0, 12) }}</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <PiedListe
        :page="adm.admRunsPage"
        :par-page="adm.admRunsParPage"
        :total="adm.admRunsTotal"
        :nb-lignes="adm.admRunsItems.length"
        :chargement="adm.admRunsLoading"
        unite="exécutions"
        @page="adm.setAdmRunsPage"
      />
    </div>
  </div>
</template>
