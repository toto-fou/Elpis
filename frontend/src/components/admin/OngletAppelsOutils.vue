<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/admin/OngletAppelsOutils.vue — Activité › Appels d'outils : synthèse par outil et dernières erreurs. -->
<script setup lang="ts">
import { computed } from "vue";

import { domaineAdmin } from "../../features/admin/domaine";
import { nombre } from "../../features/admin/formats";
import { heureLocale, isoUtc } from "../../features/admin/horodatage";
import { classeEtatOutil, estIdExecution, libStatut } from "../../features/admin/libelles-activite";
import ChoixPeriode from "./ChoixPeriode.vue";
import EnteteTri from "./EnteteTri.vue";
import EtatActualisation from "./EtatActualisation.vue";
import PiedListe from "./PiedListe.vue";

const adm = domaineAdmin();
const filtre = computed(() => adm.outilsFiltre);
const filtree = computed(
  () => !!(filtre.value.q || filtre.value.statut || filtre.value.outil || filtre.value.serveur),
);
const STATUTS = [
  ["", "Toutes"],
  ["error", "Erreurs"],
  ["blocked", "Bloqués"],
  ["timeout", "Délais"],
] as const;
const compte = (s: string): number => {
  const t = adm.obsSummary.totals;
  if (s === "error") return t.n_error ?? 0;
  if (s === "blocked") return t.n_blocked ?? 0;
  if (s === "timeout") return t.n_timeout ?? 0;
  return (t.n_error ?? 0) + (t.n_blocked ?? 0) + (t.n_timeout ?? 0);
};
const outils = computed(() => adm.obsSummary.per_tool.map((t) => t.tool_name).sort());
const choisirOutil = (nom: string): void =>
  adm.filtrerOutils({ outil: adm.outilsFiltre.outil === nom ? "" : nom });
const voirRun = (runId: string | null): void => {
  if (!estIdExecution(runId)) return;
  adm.montrerExecution(runId);
  void adm.goAdminOnglet("activity", "runs");
  if (adm.user && adm.user.role === "admin") void adm.showRunDetails(runId, [runId], { admin: true });
};
const tuiles = computed(() => {
  const t = adm.obsSummary.totals;
  return [
    { libelle: "Appels", valeur: t.n },
    { libelle: "Erreurs", valeur: t.n_error ?? 0, teinte: "danger", aide: "Outils terminés en erreur" },
    {
      libelle: "Bloqués",
      valeur: t.n_blocked ?? 0,
      teinte: "warn",
      aide: "Appels refusés par une règle (sandbox, droits)",
    },
    {
      libelle: "Délais dépassés",
      valeur: t.n_timeout ?? 0,
      teinte: "warn",
      aide: "Appels interrompus par leur délai maximal",
    },
    {
      libelle: "Durée cumulée",
      valeur: Math.round((t.total_ms ?? 0) / 1000),
      unite: "s",
      aide: "Temps total passé dans les outils",
    },
  ] as { libelle: string; valeur: number; teinte?: string; aide?: string; unite?: string }[];
});
const TOP_MAX = 50;
const topAffiche = computed(() => adm.obsSummary.per_tool.slice(0, TOP_MAX));
const topAutres = computed(() => Math.max(0, adm.obsSummary.per_tool.length - TOP_MAX));
</script>

<template>
  <div class="space-y-3" :aria-busy="adm.obsLoading ? 'true' : 'false'">
    <div class="relative flex flex-wrap items-center justify-between gap-2">
      <ChoixPeriode :periode="adm.obsScope" @choisir="adm.setObsScope($event)" />
      <EtatActualisation
        :chargement="adm.obsLoading"
        :derniere-maj="adm.obsDerniereMaj"
        :echec="adm.obsEchec"
        @actualiser="adm.rechargerPage(true)"
      />
      <div class="adm-progression" :class="{ 'is-on': adm.obsLoading }" aria-hidden="true"></div>
    </div>

    <div class="grid grid-cols-2 lg:grid-cols-5 gap-3">
      <div
        v-for="t in tuiles"
        :key="t.libelle"
        class="adm-stat"
        :class="t.valeur > 0 && t.teinte ? 'adm-stat--' + t.teinte : ''"
      >
        <div class="adm-stat__label" :title="t.aide">{{ t.libelle }}</div>
        <div class="adm-stat__value">
          {{ t.valeur }}<span v-if="t.unite" class="adm-kpi__unit"> {{ t.unite }}</span>
        </div>
      </div>
    </div>

    <div class="adm-card">
      <div class="adm-card__head">
        <div class="adm-card__title flex items-center gap-2">
          <i class="ph ph-stack adm-card__icon" aria-hidden="true"></i>
          <span title="Appels, échecs et latence moyenne par outil">Top outils</span>
        </div>
        <span class="adm-row__hint ml-auto">
          {{ adm.obsSummary.per_tool.length }} outils observés · cliquer un outil filtre les erreurs
        </span>
      </div>
      <div class="overflow-x-auto">
        <table class="adm-table w-full">
          <thead>
            <tr>
              <th class="text-left">Outil</th>
              <th class="text-right">Appels</th>
              <th class="text-right">Échecs</th>
              <th class="text-right">Taux erreur</th>
              <th class="text-right">Latence moy.</th>
              <th class="text-right">Temps total</th>
            </tr>
          </thead>
          <tbody>
            <tr v-if="adm.obsSummary.per_tool.length === 0">
              <td colspan="6" class="text-center adm-empty">Aucun appel d'outil sur la fenêtre choisie.</td>
            </tr>
            <tr
              v-for="t in topAffiche"
              :key="t.tool_name"
              class="sup-ligne"
              :class="{ 'is-sel': adm.outilsFiltre.outil === t.tool_name }"
              tabindex="0"
              :aria-selected="adm.outilsFiltre.outil === t.tool_name"
              @click="choisirOutil(t.tool_name)"
              @keydown.enter="choisirOutil(t.tool_name)"
            >
              <td class="font-mono">{{ t.tool_name }}</td>
              <td class="text-right tabular-nums font-medium">{{ t.n }}</td>
              <td
                class="text-right tabular-nums"
                :class="t.n_failed > 0 ? 'text-rose-700 font-medium' : 'text-slate-600'"
              >
                {{ t.n_failed }}
              </td>
              <td class="text-right tabular-nums">
                <span
                  :class="
                    t.n > 0 && t.n_failed / t.n >= 0.1
                      ? 'text-rose-700 font-medium'
                      : t.n > 0 && t.n_failed / t.n >= 0.03
                        ? 'text-slate-700'
                        : 'text-slate-600'
                  "
                >
                  <i
                    v-if="t.n > 0 && t.n_failed / t.n >= 0.03 && t.n_failed / t.n < 0.1"
                    class="ph ph-warning text-amber-600"
                    title="Taux d'échec élevé"
                    aria-hidden="true"
                  ></i>
                  {{ t.n > 0 ? Math.round((t.n_failed / t.n) * 1000) / 10 : 0 }}%
                </span>
              </td>
              <td class="text-right tabular-nums">
                <span :class="t.avg_ms >= 1000 ? 'text-rose-700' : 'text-slate-700'">
                  <i
                    v-if="t.avg_ms >= 200 && t.avg_ms < 1000"
                    class="ph ph-warning text-amber-600"
                    title="Appel lent"
                    aria-hidden="true"
                  ></i>
                  {{ t.avg_ms }}<span class="text-slate-500">ms</span>
                </span>
              </td>
              <td class="text-right tabular-nums adm-muted">{{ Math.round(t.total_ms / 100) / 10 }}s</td>
            </tr>
            <tr v-if="topAutres > 0">
              <td colspan="6" class="text-center adm-empty">
                et {{ nombre(topAutres) }} autres outils (choisir un outil dans la liste des erreurs)
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <div class="adm-card">
      <div class="adm-card__head">
        <div class="adm-card__title flex items-center gap-2">
          <i class="ph ph-warning-octagon adm-card__icon" aria-hidden="true"></i>
          Erreurs d'outils
        </div>
      </div>
      <div class="sup-outils-carte">
        <div class="sup-puces" role="group" aria-label="Statut">
          <button
            v-for="[v, l] in STATUTS"
            :key="v"
            type="button"
            class="adm-chip"
            :aria-pressed="adm.outilsFiltre.statut === v"
            @click="adm.filtrerOutils({ statut: v })"
          >
            {{ l }} <b>{{ nombre(compte(v)) }}</b>
          </button>
          <span
            class="adm-muted text-xs self-center"
            title="Les compteurs ignorent l'outil, le serveur et la recherche"
          >
            sur la période
          </span>
        </div>
        <select
          class="set-select"
          aria-label="Outil"
          :value="adm.outilsFiltre.outil"
          @change="adm.filtrerOutils({ outil: ($event.target as HTMLSelectElement).value })"
        >
          <option value="">Tous les outils</option>
          <option
            v-if="adm.outilsFiltre.outil && !outils.includes(adm.outilsFiltre.outil)"
            :value="adm.outilsFiltre.outil"
          >
            {{ adm.outilsFiltre.outil }}
          </option>
          <option v-for="o in outils" :key="o" :value="o">{{ o }}</option>
        </select>
        <div class="sup-recherche">
          <i class="ph ph-magnifying-glass" aria-hidden="true"></i>
          <input
            type="search"
            class="set-input"
            placeholder="Outil, serveur, message ou run_id"
            aria-label="Rechercher une erreur"
            maxlength="100"
            :value="adm.outilsFiltre.q"
            @input="adm.rechercherOutils(($event.target as HTMLInputElement).value)"
          />
        </div>
        <span v-if="adm.outilsFiltre.serveur" class="adm-pill">
          Serveur {{ adm.outilsFiltre.serveur }}
          <button
            type="button"
            aria-label="Retirer le filtre de serveur"
            @click="adm.filtrerOutils({ serveur: '' })"
          >
            <i class="ph ph-x text-[10px]" aria-hidden="true"></i>
          </button>
        </span>
        <button
          v-if="filtree"
          type="button"
          class="adm-btn adm-btn--quiet adm-btn--sm sup-effacer"
          @click="adm.effacerFiltresOutils()"
        >
          <i class="ph ph-x" aria-hidden="true"></i> Effacer les filtres
        </button>
      </div>
      <div class="sup-liste custom-scrollbar" :aria-busy="adm.obsLoading ? 'true' : 'false'">
        <table class="adm-table w-full">
          <thead class="adm-thead--sticky">
            <tr>
              <EnteteTri col="ts" libelle="Quand" :tri="adm.outilsTri" @trier="adm.trierOutils" />
              <EnteteTri col="tool_name" libelle="Outil" :tri="adm.outilsTri" @trier="adm.trierOutils" />
              <EnteteTri col="server_name" libelle="Serveur" :tri="adm.outilsTri" @trier="adm.trierOutils" />
              <EnteteTri col="status" libelle="Statut" :tri="adm.outilsTri" @trier="adm.trierOutils" />
              <EnteteTri
                col="duration_ms"
                libelle="Durée"
                droite
                :tri="adm.outilsTri"
                @trier="adm.trierOutils"
              />
              <th class="text-left">Erreur</th>
              <EnteteTri col="run_id" libelle="Run / nœud" :tri="adm.outilsTri" @trier="adm.trierOutils" />
            </tr>
          </thead>
          <tbody>
            <template v-if="adm.obsFailures.length === 0">
              <tr v-if="adm.obsLoading && !adm.obsDerniereMaj">
                <td colspan="7"><div class="adm-skeleton w-full"></div></td>
              </tr>
              <tr v-else-if="adm.obsEchec">
                <td colspan="7" class="text-center adm-empty adm-empty--error">
                  Erreurs d'outils indisponibles ·
                  <button type="button" class="adm-link" @click="adm.loadToolCalls()">Réessayer</button>
                </td>
              </tr>
              <tr v-else>
                <td colspan="7" class="text-center adm-empty">
                  {{
                    filtree
                      ? "Aucune erreur pour ces filtres sur la période."
                      : "Aucune erreur sur la fenêtre choisie."
                  }}
                </td>
              </tr>
            </template>
            <tr v-for="(f, idx) in adm.obsFailures" :key="idx">
              <td class="sup-quand">
                <time :datetime="isoUtc(f.ts)" :title="isoUtc(f.ts)">{{ heureLocale(f.ts) }}</time>
              </td>
              <td class="font-mono text-xs">{{ f.tool_name }}</td>
              <td class="font-mono text-xs">
                <button
                  v-if="f.server_name"
                  type="button"
                  class="sup-lien-run"
                  :title="'Filtrer sur le serveur ' + f.server_name"
                  @click="adm.filtrerOutils({ serveur: f.server_name })"
                >
                  {{ f.server_name }}
                </button>
                <span v-else class="adm-muted">—</span>
              </td>
              <td>
                <span class="sup-etat" :class="classeEtatOutil(f.status)">{{ libStatut(f.status) }}</span>
              </td>
              <td class="text-right tabular-nums text-xs adm-muted">{{ f.duration_ms }} ms</td>
              <td class="text-xs max-w-xs truncate" :title="f.error_short ?? undefined">
                {{ f.error_short || "—" }}
              </td>
              <td class="text-xs">
                <a
                  v-if="estIdExecution(f.run_id)"
                  href="#activity/runs"
                  class="sup-lien-run"
                  :title="'Ouvrir l\'exécution ' + f.run_id"
                  @click.prevent="voirRun(f.run_id)"
                  >{{ f.run_id.slice(0, 12) }}</a
                >
                <span v-else class="adm-muted font-mono text-xs">{{ f.run_id || "—" }}</span>
                <span v-if="f.node_id" class="adm-muted font-mono"> / {{ f.node_id }}</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <PiedListe
        :page="adm.outilsPage"
        :par-page="adm.outilsParPage"
        :total="adm.outilsTotal"
        :nb-lignes="adm.obsFailures.length"
        :chargement="adm.obsLoading"
        unite="erreurs"
        @page="adm.setOutilsPage"
      />
    </div>
  </div>
</template>
