<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/chat/page/ContexteJetons.vue — contexte en jetons dans la rangée du composeur (premier affichage d'Elpis) : « utilisés / fenêtre » au repos ; pendant le tour, durée, débit et « mesurés + générés / fenêtre ». -->
<script setup lang="ts">
import { CLE_MODELES, domaine } from "../../../features/chat/page/domaines";

const mod = domaine(CLE_MODELES);
</script>

<template>
  <div
    v-if="mod.liveGen"
    class="shrink min-w-0 overflow-hidden flex items-center gap-2 px-1.5 text-[11px] font-mono text-slate-500 tabular-nums select-none whitespace-nowrap"
    data-contexte-jetons="direct"
  >
    <span
      class="inline-block w-1.5 h-1.5 rounded-full bg-blue-500 animate-pulse shrink-0"
      aria-hidden="true"
    ></span>
    <span>{{ mod.liveGen.secLabel }}</span>
    <template v-if="mod.liveGen.tokPerSec !== null">
      <span class="text-slate-300" aria-hidden="true">·</span>
      <span title="Vitesse de génération">↑ {{ mod.liveGen.tokPerSec }} jetons/s</span>
    </template>
    <template v-if="mod.liveGen.ctxLabel">
      <span class="text-slate-300" aria-hidden="true">·</span>
      <span
        class="flex items-center gap-1"
        :class="mod.kvTextClass(mod.liveGen.pct)"
        :title="
          'Contexte : ' +
          mod.liveGen.ctxLabel +
          ' jetons (' +
          mod.liveGen.pct +
          ' %) — dernier prompt mesuré par le moteur, + jetons générés depuis (réflexion comprise), / fenêtre'
        "
      >
        <i class="ph ph-database text-[10px]" aria-hidden="true"></i>{{ mod.liveGen.ctxLabel }}
      </span>
    </template>
  </div>
  <div
    v-else-if="mod.ctxUsage && mod.ctxUsage.total"
    class="shrink min-w-0 overflow-hidden flex items-center gap-1 px-1.5 text-[11px] font-mono tabular-nums select-none whitespace-nowrap"
    :class="mod.kvTextClass(mod.ctxUsage.pct)"
    :title="
      'Contexte réel à la fin du dernier tour : ' +
      mod.ctxUsage.used.toLocaleString('fr-FR') +
      ' / ' +
      mod.ctxUsage.total.toLocaleString('fr-FR') +
      ' jetons (' +
      mod.ctxUsage.pct +
      ' %)' +
      (mod.ctxUsage.persisted ? ' — valeur enregistrée, restaurée au chargement' : '')
    "
    data-contexte-jetons="repos"
  >
    <i class="ph ph-database text-[10px]" aria-hidden="true"></i>{{ mod.fmtCtxUsage(mod.ctxUsage) }}
  </div>
</template>
