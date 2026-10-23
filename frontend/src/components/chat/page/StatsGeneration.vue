<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/chat/page/StatsGeneration.vue — statistiques du tour en cours et occupation du contexte au repos. -->
<script setup lang="ts">
import { CLE_MODELES, domaine } from "../../../features/chat/page/domaines";

const mod = domaine(CLE_MODELES);
</script>

<template>
  <transition name="fade">
    <div
      v-if="mod.liveGen && !mod.imageMode"
      class="shrink min-w-0 overflow-hidden flex items-center gap-2 px-1.5 text-[11px] font-mono text-slate-500 tabular-nums select-none whitespace-nowrap"
    >
      <span class="inline-block w-1.5 h-1.5 rounded-full bg-blue-500 animate-pulse shrink-0"></span>
      <span>{{ mod.liveGen.secLabel }}</span>
      <template v-if="mod.liveGen.tokPerSec !== null">
        <span class="text-slate-300">·</span>
        <span title="Vitesse de génération">↑ {{ mod.liveGen.tokPerSec }} tok/s</span>
      </template>
      <template v-if="mod.liveGen.ctxLabel">
        <span class="text-slate-300">·</span>
        <span
          class="flex items-center gap-1"
          :class="mod.kvTextClass(mod.liveGen.pct)"
          :title="
            'Contexte : ' +
            mod.liveGen.ctxLabel +
            ' tokens (' +
            mod.liveGen.pct +
            '%) — dernier prompt mesuré par le moteur, + jetons générés depuis (réflexion comprise), / fenêtre'
          "
        >
          <i class="ph ph-database text-[10px]"></i>{{ mod.liveGen.ctxLabel }} ctx
        </span>
      </template>
    </div>
  </transition>
  <div
    v-if="!mod.imageMode && !mod.liveGen && mod.ctxUsage && mod.ctxUsage.total"
    class="shrink min-w-0 overflow-hidden flex items-center gap-1 px-1.5 text-[11px] font-mono tabular-nums select-none whitespace-nowrap"
    :class="mod.kvTextClass(mod.ctxUsage.pct)"
    :title="
      'Contexte réel à la fin du dernier tour : ' +
      mod.ctxUsage.used.toLocaleString('fr-FR') +
      ' / ' +
      mod.ctxUsage.total.toLocaleString('fr-FR') +
      ' tokens (' +
      mod.ctxUsage.pct +
      ' %)' +
      (mod.ctxUsage.persisted ? ' — valeur enregistrée, restaurée au chargement' : '')
    "
  >
    <i class="ph ph-database text-[10px]"></i>{{ mod.fmtCtxUsage(mod.ctxUsage) }} ctx
  </div>
</template>
