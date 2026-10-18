<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/chat/page/InfoCompression.vue — compressions déjà faites de la conversation (rounds, plafond). -->
<script setup lang="ts">
import { CLE_COMPOSEUR, domaine } from "../../../features/chat/page/domaines";

const comp = domaine(CLE_COMPOSEUR);
</script>

<template>
  <transition name="fade">
    <div
      v-if="
        !comp.liveGen &&
        comp.compressionState &&
        (comp.compressionState.round > 0 || comp.compressionState.reason === 'max_reached')
      "
      class="mb-2 flex items-center justify-center gap-2 text-[11px] text-slate-400 tabular-nums select-none"
    >
      <span
        v-if="comp.compressionState.round > 0"
        class="flex items-center gap-1 font-mono text-slate-400"
        :title="
          'Conversation déjà compressée ' +
          comp.compressionState.round +
          ' fois' +
          (comp.compressionState.max > 0 ? ' (maximum ' + comp.compressionState.max + ')' : '') +
          ' — tape /compact pour relancer.'
        "
      >
        <i class="ph ph-arrows-in-simple" style="font-size: 10px"></i>{{ comp.compressionState.round
        }}{{ comp.compressionState.max > 0 ? "/" + comp.compressionState.max : "" }}
      </span>
      <span
        v-if="comp.compressionState.reason === 'max_reached'"
        class="flex items-center gap-1 text-amber-600/90"
        title="Limite de compressions atteinte pour cette conversation. Si le contexte sature, les messages les plus anciens seront écartés automatiquement."
      >
        <i class="ph ph-prohibit" style="font-size: 11px"></i> Compression max atteinte
      </span>
    </div>
  </transition>
</template>
