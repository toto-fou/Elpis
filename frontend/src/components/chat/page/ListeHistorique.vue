<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/chat/page/ListeHistorique.vue — historique du volet groupé par date, à part du volet : ses mises à jour (skin, réglages) ne le rendent pas de nouveau, car TransitionGroup relit la position de chaque ligne à chaque rendu. -->
<script setup lang="ts">
import { computed } from "vue";

import { CLE_BARRE, domaine } from "../../../features/chat/page/domaines";
import LigneHistorique from "./LigneHistorique.vue";

const b = domaine(CLE_BARRE);

// Historique à plat (titre de tranche puis ses conversations) : une conversation garde sa clé en changeant de tranche.
const lignes = computed(() =>
  b.groupedHistory.flatMap((g) => [
    { cle: "tranche-" + g.key, label: g.label, chat: null },
    ...g.items.map((chat) => ({ cle: chat.id, label: "", chat })),
  ]),
);
</script>

<template>
  <!-- Une ligne archivée ou supprimée s'efface, les suivantes remontent (.elpis-ligne-*, style.css) ; chaque ligne se rend seule (LigneHistorique). -->
  <TransitionGroup name="elpis-ligne" tag="div" class="relative flex flex-col space-y-px">
    <template v-for="l in lignes" :key="l.cle">
      <LigneHistorique v-if="l.chat" :chat="l.chat" />
      <div
        v-else
        class="text-[11px] font-semibold tracking-[0.02em] text-slate-400 px-3 pt-4 pb-1.5 first:pt-1.5"
      >
        {{ l.label }}
      </div>
    </template>
  </TransitionGroup>
</template>
