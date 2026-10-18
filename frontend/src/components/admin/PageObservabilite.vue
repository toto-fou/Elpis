<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/admin/PageObservabilite.vue — pages Appels d'outils et Audit. -->
<script setup lang="ts">
import { domaineAdmin } from "../../features/admin/domaine";

const adm = domaineAdmin();
</script>

<template>
  <div v-if="['tool-calls', 'audit', 'logs'].includes(adm.adminTab)" class="animate-[fadeIn_0.2s] space-y-3">
    <div v-if="adm.adminTab !== 'logs'" class="flex flex-wrap items-center justify-between gap-2">
      <div class="adm-seg" role="group" aria-label="Période">
        <button
          v-for="s in [
            { h: 24, l: '24 h' },
            { h: 168, l: '7 j' },
            { h: 720, l: '30 j' },
          ]"
          :key="'os' + s.h"
          type="button"
          :class="['adm-seg__btn', adm.obsScope === s.h ? 'is-active' : '']"
          :aria-pressed="adm.obsScope === s.h ? 'true' : 'false'"
          @click="adm.setObsScope(s.h)"
        >
          {{ s.l }}
        </button>
      </div>

      <button
        type="button"
        :disabled="adm.obsLoading"
        class="adm-btn adm-tool"
        @click="adm.loadObservability()"
      >
        <i class="ph ph-arrow-clockwise" :class="adm.obsLoading ? 'animate-spin' : ''" aria-hidden="true"></i>
        Recharger
      </button>
    </div>

    <div v-if="adm.adminTab === 'tool-calls'" class="grid grid-cols-2 lg:grid-cols-5 gap-3">
      <div class="adm-stat">
        <div class="adm-stat__label">Appels</div>
        <div class="adm-stat__value">{{ (adm.obsSummary.totals && adm.obsSummary.totals.n) || 0 }}</div>
      </div>
      <div class="adm-stat" :class="{ 'adm-stat--danger': (adm.obsSummary.totals?.n_error ?? 0) > 0 }">
        <div class="adm-stat__label" title="Outils terminés en erreur">Erreurs</div>
        <div class="adm-stat__value">{{ (adm.obsSummary.totals && adm.obsSummary.totals.n_error) || 0 }}</div>
      </div>
      <div class="adm-stat" :class="{ 'adm-stat--warn': (adm.obsSummary.totals?.n_blocked ?? 0) > 0 }">
        <div class="adm-stat__label" title="Appels refusés par une règle (sandbox, droits)">Bloqués</div>
        <div class="adm-stat__value">
          {{ (adm.obsSummary.totals && adm.obsSummary.totals.n_blocked) || 0 }}
        </div>
      </div>
      <div class="adm-stat" :class="{ 'adm-stat--warn': (adm.obsSummary.totals?.n_timeout ?? 0) > 0 }">
        <div class="adm-stat__label" title="Appels interrompus par leur délai maximal">Délais dépassés</div>
        <div class="adm-stat__value">
          {{ (adm.obsSummary.totals && adm.obsSummary.totals.n_timeout) || 0 }}
        </div>
      </div>
      <div class="adm-stat">
        <div class="adm-stat__label" title="Temps total passé dans les outils">Durée cumulée</div>
        <div class="adm-stat__value">
          {{ Math.round(((adm.obsSummary.totals && adm.obsSummary.totals.total_ms) || 0) / 1000)
          }}<span class="adm-kpi__unit"> s</span>
        </div>
      </div>
    </div>

    <div v-if="adm.adminTab === 'tool-calls'" class="adm-card">
      <div class="adm-card__head">
        <div class="adm-card__title flex items-center gap-2">
          <i class="ph ph-stack adm-card__icon" aria-hidden="true"></i>
          <span title="Appels, échecs et latence moyenne par outil">Top outils</span>
        </div>
        <span class="adm-row__hint ml-auto">
          {{ (adm.obsSummary.per_tool || []).length }} outils observés
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
            <tr v-if="!adm.obsSummary.per_tool || adm.obsSummary.per_tool.length === 0">
              <td colspan="6" class="text-center adm-empty">Aucun appel d'outil sur la fenêtre choisie.</td>
            </tr>
            <tr v-for="t in adm.obsSummary.per_tool || []" :key="t.tool_name">
              <td class="font-mono">{{ t.tool_name }}</td>
              <td class="text-right tabular-nums font-medium">{{ t.n }}</td>
              <td
                class="text-right tabular-nums"
                :class="t.n_failed > 0 ? 'text-rose-700 font-medium' : 'text-slate-400'"
              >
                {{ t.n_failed }}
              </td>
              <td class="text-right tabular-nums">
                <span
                  :class="
                    t.n > 0 && t.n_failed / t.n >= 0.1
                      ? 'text-rose-700 font-medium'
                      : t.n > 0 && t.n_failed / t.n >= 0.03
                        ? 'text-amber-600'
                        : 'text-slate-500'
                  "
                >
                  {{ t.n > 0 ? Math.round((t.n_failed / t.n) * 1000) / 10 : 0 }}%
                </span>
              </td>
              <td class="text-right tabular-nums">
                <span
                  :class="
                    t.avg_ms >= 1000 ? 'text-rose-600' : t.avg_ms >= 200 ? 'text-amber-600' : 'text-slate-600'
                  "
                >
                  {{ t.avg_ms }}<span class="text-slate-400">ms</span>
                </span>
              </td>
              <td class="text-right tabular-nums adm-muted">{{ Math.round(t.total_ms / 100) / 10 }}s</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <div v-if="adm.adminTab === 'tool-calls'" class="adm-card">
      <div class="adm-card__head">
        <div class="adm-card__title flex items-center gap-2">
          <i class="ph ph-warning-octagon adm-card__icon" aria-hidden="true"></i>
          Dernières erreurs d'outils
        </div>
        <span class="adm-row__hint ml-auto"> {{ adm.obsFailures.length }} entrées </span>
      </div>
      <div class="max-h-96 overflow-y-auto custom-scrollbar">
        <table class="adm-table w-full">
          <thead class="adm-thead--sticky">
            <tr>
              <th class="text-left">Quand</th>
              <th class="text-left">Outil</th>
              <th class="text-left">Statut</th>
              <th class="text-right">Durée</th>
              <th class="text-left">Erreur</th>
              <th class="text-left">Run / Node</th>
            </tr>
          </thead>
          <tbody>
            <tr v-if="adm.obsFailures.length === 0">
              <td colspan="6" class="text-center adm-empty">Aucune erreur sur la fenêtre choisie.</td>
            </tr>
            <tr v-for="(f, idx) in adm.obsFailures" :key="idx">
              <td class="whitespace-nowrap text-xs adm-muted">{{ adm.fmtTs(f.ts) }}</td>
              <td class="font-mono text-xs">{{ f.tool_name }}</td>
              <td>
                <span
                  :class="[
                    'px-1.5 py-0.5 rounded text-[11px] font-semibold',
                    f.status === 'error'
                      ? 'bg-rose-100 text-rose-700'
                      : f.status === 'blocked'
                        ? 'bg-amber-100 text-amber-700'
                        : f.status === 'timeout'
                          ? 'bg-slate-200 text-slate-700'
                          : 'bg-slate-100 text-slate-600',
                  ]"
                >
                  {{ f.status }}
                </span>
              </td>
              <td class="text-right tabular-nums text-xs adm-muted">{{ f.duration_ms }}ms</td>
              <td class="text-xs max-w-xs truncate" :title="f.error_short ?? undefined">
                {{ f.error_short || "—" }}
              </td>
              <td class="text-xs font-mono adm-muted">
                <span class="text-slate-400">{{ f.run_id }}</span>
                <span v-if="f.node_id" class="text-slate-600">/{{ f.node_id }}</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <div v-if="adm.adminTab === 'audit'" class="adm-card">
      <div class="adm-card__head flex-wrap">
        <div class="adm-card__title flex items-center gap-2">
          <i class="ph ph-shield-check adm-card__icon" aria-hidden="true"></i>
          <span title="Journal signé (HMAC), en ajout seul">Audit récent</span>

          <span
            v-if="adm.obsScope > 168"
            class="px-1.5 py-0.5 rounded text-[10px] font-medium bg-amber-100 text-amber-700"
            title="La lecture du journal d'audit est bornée aux 7 derniers jours, même en scope 30 j."
          >
            limité aux 7 derniers jours
          </span>
        </div>

        <div class="adm-seg adm-seg--sm" role="group" aria-label="Filtre d'audit">
          <button
            v-for="f in [
              { p: '', l: 'Tout' },
              { p: 'auth.', l: 'Connexions' },
              { p: 'code.exec.', l: 'Exécutions' },
              { p: 'user.sandbox.', l: 'Sandbox' },
              { p: 'admin.', l: 'Admin' },
            ]"
            :key="'af' + f.p"
            type="button"
            :class="['adm-seg__btn', adm.obsAuditPrefix === f.p ? 'is-active' : '']"
            :aria-pressed="adm.obsAuditPrefix === f.p ? 'true' : 'false'"
            @click="adm.setObsAuditPrefix(f.p)"
          >
            {{ f.l }}
          </button>
        </div>
      </div>
      <div class="max-h-96 overflow-y-auto custom-scrollbar">
        <table class="adm-table w-full">
          <thead class="adm-thead--sticky">
            <tr>
              <th class="text-left">Quand</th>
              <th class="text-left">Service</th>
              <th class="text-left">Utilisateur</th>
              <th class="text-left">Action</th>
              <th class="text-left">Détails</th>
            </tr>
          </thead>
          <tbody>
            <tr v-if="adm.obsAudit.length === 0">
              <td colspan="5" class="text-center adm-empty">Aucune ligne d'audit pour ce filtre.</td>
            </tr>
            <tr v-for="(a, idx) in adm.obsAudit" :key="idx">
              <td class="whitespace-nowrap text-xs adm-muted">
                {{ a.iso || (adm.fmtTs && adm.fmtTs(a.ts)) }}
              </td>
              <td class="text-xs">
                <span class="px-1.5 py-0.5 rounded text-[11px] font-semibold bg-slate-100 text-slate-600">{{
                  a.service
                }}</span>
              </td>
              <td class="text-xs">
                {{ a.username || "—" }}<span v-if="a.user_id" class="text-slate-400"> #{{ a.user_id }}</span>
              </td>
              <td
                class="px-4 py-2 font-mono text-xs"
                :class="
                  (a.action || '').startsWith('rbac.')
                    ? 'text-rose-700 font-medium'
                    : (a.action || '').startsWith('secret.')
                      ? 'text-purple-700'
                      : (a.action || '').endsWith('.denied')
                        ? 'text-rose-600'
                        : 'text-slate-700'
                "
              >
                {{ a.action }}
              </td>
              <td
                class="text-xs font-mono truncate max-w-md adm-muted"
                :title="JSON.stringify(a.details || {})"
              >
                {{ a.details ? JSON.stringify(a.details).slice(0, 120) : "" }}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <div v-if="adm.adminTab === 'logs'" class="adm-card">
      <header class="adm-card__head flex-wrap">
        <i class="ph ph-terminal-window adm-card__icon" aria-hidden="true"></i>
        <div>
          <h3 class="adm-card__title">Journaux</h3>
          <span class="sr-only">300 dernières entrées, puis flux en direct.</span>
        </div>
        <div class="adm-card__actions">
          <input
            v-model="adm.logFilters.query"
            type="search"
            placeholder="Filtrer…"
            class="set-input text-sm w-40"
            aria-label="Filtrer les journaux"
          />
          <label class="flex items-center gap-1.5 text-xs adm-muted cursor-pointer">
            <input v-model="adm.logAutoScroll" type="checkbox" /> Suivre
          </label>
          <button
            type="button"
            class="adm-btn adm-btn--icon"
            :disabled="adm.logsLoading"
            title="Recharger les journaux"
            @click="adm.loadRecentLogs()"
          >
            <i
              class="ph ph-arrow-clockwise"
              :class="adm.logsLoading ? 'animate-spin' : ''"
              aria-hidden="true"
            ></i>
          </button>
        </div>
      </header>
      <div
        :ref="
          (el) => {
            adm.logsConsoleRef = el as typeof adm.logsConsoleRef;
          }
        "
        role="log"
        aria-live="polite"
        class="max-h-80 overflow-y-auto custom-scrollbar p-3 font-mono text-xs space-y-0.5"
      >
        <p v-if="!adm.filteredLogs.length" class="adm-empty">Aucune entrée pour ce filtre.</p>

        <div v-for="l in adm.filteredLogs" :key="l.id || l.ts + '|' + l.message" class="flex gap-2">
          <span class="adm-muted shrink-0">{{ adm.fmtLogTs(l.ts) }}</span>
          <span
            class="shrink-0 font-semibold"
            :class="
              l.level === 'ERROR' ? 'text-rose-600' : l.level === 'WARNING' ? 'text-amber-600' : 'adm-muted'
            "
            >{{ l.level }}</span
          >
          <span class="adm-muted shrink-0">{{ l.service }}</span>
          <span class="min-w-0 break-all">{{ l.message }}</span>
        </div>
      </div>
    </div>
  </div>
</template>
