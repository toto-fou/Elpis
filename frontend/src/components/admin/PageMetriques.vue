<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/admin/PageMetriques.vue — page Supervision › Métriques. -->
<script setup lang="ts">
import { domaineAdmin } from "../../features/admin/domaine";

const adm = domaineAdmin();
</script>

<template>
  <div v-if="adm.adminTab === 'dashboard'" class="adm-dash animate-[fadeIn_0.2s]">
    <div class="adm-dash__bar">
      <div class="adm-seg" role="group" aria-label="Période">
        <button
          v-for="s in [
            { h: 24, l: '24 h' },
            { h: 168, l: '7 j' },
            { h: 720, l: '30 j' },
          ]"
          :key="'sc' + s.h"
          type="button"
          :class="['adm-seg__btn', adm.dashboardScope === s.h ? 'is-active' : '']"
          :aria-pressed="adm.dashboardScope === s.h ? 'true' : 'false'"
          @click="adm.setDashboardScope(s.h)"
        >
          {{ s.l }}
        </button>
      </div>

      <div class="relative" data-dash-menu>
        <button
          type="button"
          class="adm-btn adm-btn--icon adm-tool"
          title="Options"
          aria-label="Options du tableau de bord"
          aria-haspopup="dialog"
          :aria-expanded="adm.dashMenu ? 'true' : 'false'"
          @click="adm.dashMenu = adm.dashMenu ? null : 'main'"
        >
          <i class="ph ph-dots-three" aria-hidden="true"></i>
        </button>
        <div
          v-if="adm.dashMenu"
          class="adm-pop adm-dash__menu"
          role="dialog"
          aria-label="Options du tableau de bord"
        >
          <template v-if="adm.dashMenu === 'main'">
            <div class="adm-pop__body">
              <button type="button" class="adm-menu__item" @click="adm.dashMenu = 'widgets'">
                <i class="ph ph-squares-four" aria-hidden="true"></i> Widgets
                <i class="ph ph-caret-right adm-menu__go" aria-hidden="true"></i>
              </button>
              <button type="button" class="adm-menu__item" @click="adm.dashMenu = 'export'">
                <i class="ph ph-export" aria-hidden="true"></i> Exporter
                <i class="ph ph-caret-right adm-menu__go" aria-hidden="true"></i>
              </button>
              <button
                type="button"
                class="adm-menu__item"
                @click="
                  adm.dashMenu = 'collect';
                  adm.loadScrapeToken();
                "
              >
                <i class="ph ph-plugs-connected" aria-hidden="true"></i> Collecte Prometheus
                <i class="ph ph-caret-right adm-menu__go" aria-hidden="true"></i>
              </button>
            </div>
            <div class="adm-pop__head"><span>Actualisation</span></div>
            <div class="adm-pop__body">
              <div class="adm-dash__rate">
                <span title="Indicateurs, graphes et tableaux">Indicateurs</span>
                <div class="adm-stepper">
                  <button
                    type="button"
                    class="adm-stepper__btn"
                    :class="adm.dashboardPollMs <= 2000 ? 'is-off' : ''"
                    aria-label="Actualiser les indicateurs plus souvent"
                    @click="adm.pollFaster"
                  >
                    <i class="ph ph-minus" aria-hidden="true"></i>
                  </button>
                  <span class="adm-stepper__val tabular-nums">{{ adm.pollLabel() }}</span>
                  <button
                    type="button"
                    class="adm-stepper__btn"
                    :class="adm.dashboardPollMs >= 60000 ? 'is-off' : ''"
                    aria-label="Actualiser les indicateurs moins souvent"
                    @click="adm.pollSlower"
                  >
                    <i class="ph ph-plus" aria-hidden="true"></i>
                  </button>
                </div>
              </div>
              <div class="adm-dash__rate">
                <span title="Graphes processeur, mémoire et disque">Temps réel</span>
                <div class="adm-stepper">
                  <button
                    type="button"
                    class="adm-stepper__btn"
                    :class="adm.livePollMs <= 500 ? 'is-off' : ''"
                    aria-label="Actualiser le temps réel plus souvent"
                    @click="adm.liveFaster"
                  >
                    <i class="ph ph-minus" aria-hidden="true"></i>
                  </button>
                  <span class="adm-stepper__val tabular-nums">{{ adm.livePollLabel() }}</span>
                  <button
                    type="button"
                    class="adm-stepper__btn"
                    :class="adm.livePollMs >= 10000 ? 'is-off' : ''"
                    aria-label="Actualiser le temps réel moins souvent"
                    @click="adm.liveSlower"
                  >
                    <i class="ph ph-plus" aria-hidden="true"></i>
                  </button>
                </div>
              </div>
            </div>
          </template>

          <template v-else>
            <div class="adm-pop__head">
              <button type="button" class="adm-pop__back" @click="adm.dashMenu = 'main'">
                <i class="ph ph-caret-left" aria-hidden="true"></i>
                {{ { widgets: "Widgets", export: "Exporter", collect: "Collecte Prometheus" }[adm.dashMenu] }}
              </button>
              <button
                v-if="adm.dashMenu === 'widgets'"
                type="button"
                class="adm-btn adm-btn--quiet adm-btn--sm"
                title="Revenir à la sélection par défaut"
                @click="adm.resetWidgetPrefs()"
              >
                Défaut
              </button>
            </div>

            <div
              v-if="adm.dashMenu === 'widgets'"
              class="adm-pop__body max-h-80 overflow-y-auto custom-scrollbar"
            >
              <button
                v-for="w in adm.allWidgetsList()"
                :key="w.id"
                type="button"
                class="adm-pick"
                :aria-pressed="w.visible ? 'true' : 'false'"
                @click="adm.toggleWidgetVisibility(w.id)"
              >
                <span class="adm-pick__box" :class="w.visible ? 'is-on' : ''">
                  <i v-if="w.visible" class="ph ph-check" aria-hidden="true"></i>
                </span>
                <span class="adm-pick__label">{{ w.title }}</span>
                <span v-if="w.isDefault" class="adm-tag" title="Affiché par défaut">défaut</span>
                <span class="adm-tag adm-tag--soft">{{
                  w.type === "value" ? "Indicateur" : w.type === "table" ? "Tableau" : "Graphe"
                }}</span>
              </button>
            </div>

            <div v-else-if="adm.dashMenu === 'export'" class="adm-pop__body adm-dash__exports">
              <span title="Registre de consommation (CSV)">Consommation</span>
              <div class="flex gap-1">
                <button
                  v-for="d in [
                    { d: 1, l: '24 h' },
                    { d: 7, l: '7 j' },
                    { d: 30, l: '30 j' },
                  ]"
                  :key="'eu' + d.d"
                  type="button"
                  class="adm-btn adm-tool adm-btn--sm"
                  :aria-label="'Exporter la consommation sur ' + d.l"
                  @click="
                    adm.exportUsage(d.d);
                    adm.dashMenu = null;
                  "
                >
                  {{ d.l }}
                </button>
              </div>
              <span title="Compteurs d'événements (CSV)">Compteurs</span>
              <div class="flex gap-1">
                <button
                  v-for="d in [
                    { d: 1, l: '24 h' },
                    { d: 7, l: '7 j' },
                    { d: 30, l: '30 j' },
                  ]"
                  :key="'em' + d.d"
                  type="button"
                  class="adm-btn adm-tool adm-btn--sm"
                  :aria-label="'Exporter les compteurs sur ' + d.l"
                  @click="
                    adm.exportMetrics(d.d);
                    adm.dashMenu = null;
                  "
                >
                  {{ d.l }}
                </button>
              </div>
            </div>

            <div v-else-if="adm.dashMenu === 'collect'" class="adm-pop__body space-y-3 p-3">
              <div class="flex items-center gap-2">
                <code class="adm-code flex-1 truncate">{{ adm.prometheusUrl() }}</code>
                <button
                  type="button"
                  class="adm-btn adm-btn--icon"
                  title="Copier l'URL"
                  aria-label="Copier l'URL"
                  @click="adm.copyPrometheusUrl()"
                >
                  <i class="ph ph-copy" aria-hidden="true"></i>
                </button>
              </div>
              <p class="adm-row__hint" title="Un collecteur n'a pas de session : il s'authentifie par jeton.">
                Jeton : <code>Authorization: Bearer</code> ou <code>?token=</code>
              </p>
              <div v-if="adm.scrapeToken.configured" class="flex items-center gap-2">
                <code class="adm-code flex-1 truncate">{{ adm.scrapeToken.token }}</code>
                <button
                  type="button"
                  class="adm-btn adm-btn--icon"
                  title="Copier le jeton"
                  aria-label="Copier le jeton"
                  @click="adm.copyScrapeToken()"
                >
                  <i class="ph ph-copy" aria-hidden="true"></i>
                </button>
              </div>
              <div class="flex gap-2">
                <button type="button" class="adm-btn adm-tool" @click="adm.setScrapeToken('generate')">
                  <i class="ph ph-key" aria-hidden="true"></i>
                  {{ adm.scrapeToken.configured ? "Régénérer" : "Générer un jeton" }}
                </button>
                <button
                  v-if="adm.scrapeToken.configured"
                  type="button"
                  class="adm-btn adm-btn--danger"
                  @click="adm.setScrapeToken('revoke')"
                >
                  Révoquer
                </button>
              </div>
            </div>
          </template>
        </div>
      </div>
    </div>

    <p
      v-if="adm.dashboardLoading && !(adm.dashboardData.layout || []).length"
      class="adm-empty flex items-center gap-2"
      role="status"
      data-dash-chargement
    >
      <i class="ph ph-spinner-gap animate-spin" aria-hidden="true"></i> Chargement des métriques…
    </p>

    <section v-if="adm.kpiGroups.length" class="adm-kpis" aria-labelledby="dash-kpis-h">
      <h2 id="dash-kpis-h" class="sr-only">Indicateurs</h2>
      <div v-for="g in adm.kpiGroups" :key="'kg-' + g.id" class="adm-kpis__group">
        <h3 class="adm-kpis__label">{{ g.label }}</h3>
        <div class="adm-kpis__grid">
          <div
            v-for="widget in g.items"
            :key="widget.id"
            class="adm-kpi"
            :class="adm.kpiState(widget.id) ? 'adm-kpi--' + adm.kpiState(widget.id) : ''"
          >
            <div class="adm-kpi__icon">
              <i
                class="ph"
                :class="
                  (adm.dashboardData.data[widget.id] && adm.dashboardData.data[widget.id]?.icon) ||
                  'ph-chart-bar'
                "
                aria-hidden="true"
              ></i>
            </div>
            <div class="min-w-0 flex-1">
              <div class="adm-kpi__title" :title="widget.title">
                {{ widget.title
                }}<span v-if="adm.kpiState(widget.id)" class="sr-only">
                  ({{ adm.kpiState(widget.id) === "danger" ? "alerte" : "à surveiller" }})</span
                >
              </div>
              <div class="adm-kpi__value">
                {{
                  adm.dashboardData.data[widget.id] && adm.dashboardData.data[widget.id]?.value != null
                    ? adm.dashboardData.data[widget.id]?.value
                    : "—"
                }}
              </div>
              <div class="adm-kpi__unit">
                {{ adm.dashboardData.data[widget.id] && adm.dashboardData.data[widget.id]?.unit }}
              </div>

              <div
                v-if="adm.dashboardData.data[widget.id] && adm.dashboardData.data[widget.id]?.detail"
                class="adm-kpi__detail"
              >
                {{ adm.dashboardData.data[widget.id]?.detail }}
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>

    <section v-if="adm.chartGroups.length" aria-labelledby="dash-charts-h">
      <h2 id="dash-charts-h" class="sr-only">Graphiques</h2>
      <div class="flex flex-wrap -mx-2">
        <template v-for="g in adm.chartGroups" :key="'cg-' + g.id">
          <div
            v-for="widget in g.items"
            :key="widget.id"
            :class="{
              'w-full': widget.width === 'full',
              'w-full md:w-1/2': widget.width === '1/2',
              'w-full md:w-1/4': widget.width === '1/4',
            }"
            class="px-2 mb-4"
          >
            <div class="adm-card h-full flex flex-col">
              <header class="adm-card__head">
                <i
                  class="ph adm-card__icon"
                  :class="widget.type === 'table' ? 'ph-table' : 'ph-chart-line'"
                  aria-hidden="true"
                ></i>
                <div>
                  <h3 class="adm-card__title">{{ widget.title }}</h3>
                </div>
                <div class="adm-card__actions">
                  <button
                    v-if="widget.purge"
                    type="button"
                    class="adm-btn adm-btn--icon adm-btn--icon-danger"
                    :title="'Réinitialiser « ' + widget.title + ' »'"
                    :aria-label="'Réinitialiser « ' + widget.title + ' »'"
                    @click="adm.resetWidget(widget)"
                  >
                    <i class="ph ph-eraser" aria-hidden="true"></i>
                  </button>
                </div>
              </header>

              <div v-if="widget.type === 'table'" class="p-4 overflow-x-auto">
                <p
                  v-if="adm.dashboardData.data[widget.id] && adm.dashboardData.data[widget.id]?.error"
                  class="adm-empty"
                >
                  {{ adm.dashboardData.data[widget.id]?.error }}
                </p>
                <p
                  v-else-if="
                    !(
                      adm.dashboardData.data[widget.id] &&
                      adm.dashboardData.data[widget.id]?.rows &&
                      adm.dashboardData.data[widget.id]?.rows?.length
                    )
                  "
                  class="adm-empty"
                >
                  Aucune donnée sur la période.
                </p>
                <table v-else class="adm-table">
                  <thead>
                    <tr>
                      <th
                        v-for="col in adm.dashboardData.data[widget.id]?.columns"
                        :key="'h' + widget.id + col.key"
                        :class="col.align === 'right' ? 'text-right' : ''"
                      >
                        {{ col.label }}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr
                      v-for="(row, ri) in adm.dashboardData.data[widget.id]?.rows"
                      :key="'r' + widget.id + ri"
                    >
                      <td
                        v-for="col in adm.dashboardData.data[widget.id]?.columns"
                        :key="'c' + widget.id + ri + col.key"
                        :class="col.align === 'right' ? 'text-right tabular-nums' : ''"
                      >
                        {{ row[col.key] }}
                      </td>
                    </tr>
                  </tbody>
                </table>
                <p
                  v-if="
                    adm.dashboardData.data[widget.id] &&
                    adm.dashboardData.data[widget.id]?.meta &&
                    adm.dashboardData.data[widget.id]?.meta?.timezone
                  "
                  class="adm-row__hint mt-2"
                >
                  Heures en {{ adm.dashboardData.data[widget.id]?.meta?.timezone }}.
                </p>
              </div>

              <div
                v-else
                class="relative flex-1 p-4"
                :style="widget.width === '1/4' ? 'min-height:180px' : 'min-height:220px'"
              >
                <div
                  v-if="adm.dashboardData.data[widget.id] && adm.dashboardData.data[widget.id]?.error"
                  class="absolute inset-0 flex items-center justify-center adm-empty adm-empty--error"
                >
                  {{ adm.dashboardData.data[widget.id]?.error }}
                </div>
                <div
                  v-else-if="!adm.dashboardData.data[widget.id]?.labels?.length"
                  class="absolute inset-0 flex flex-col items-center justify-center gap-1"
                >
                  <i class="ph ph-chart-bar text-3xl adm-empty__icon" aria-hidden="true"></i>
                  <span class="adm-empty">Aucune donnée</span>
                </div>
                <canvas :id="'chart_' + widget.id" role="img" :aria-label="adm.chartSummary(widget)"></canvas>
              </div>
            </div>
          </div>
        </template>
      </div>
    </section>

    <p
      v-if="(adm.dashboardData.layout || []).length && !adm.kpiGroups.length && !adm.chartGroups.length"
      class="adm-empty"
    >
      Aucun widget affiché · Options › Widgets
    </p>
  </div>
</template>
