<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/chat/message/LigneInterruption.vue — ligne « Interrompue : cause » sous le texte partiel d'une réponse en échec : action adaptée, détail technique copiable au clavier. -->
<script setup lang="ts">
import { computed, inject } from "vue";

import { interruption } from "../../../features/chat/message/interruption";
import type { EntreeMessage } from "../../../features/chat/message/types";
import { CLE_COMPOSEUR, CLE_FIL, domaine } from "../../../features/chat/page/domaines";

const props = defineProps<{ entry: EntreeMessage }>();
const fil = domaine(CLE_FIL);
const composeur = inject(CLE_COMPOSEUR, null);

const i = computed(() => interruption(props.entry.msg));
const reprise = computed(() => !!(props.entry.msg.tool_history?.length || props.entry.msg.content?.trim()));
const action = computed(() => {
  if (fil.isStreaming) return null;
  if (i.value.action === "reprendre") return reprise.value ? "Reprendre" : "Réessayer";
  if (i.value.action === "nouveau" && composeur) return "Nouveau chat";
  return null;
});

function agir(): void {
  if (i.value.action === "nouveau") void composeur?.startNewChat();
  else void fil.resumeAfterError(props.entry.idx);
}

async function copier(): Promise<void> {
  try {
    await globalThis.navigator.clipboard.writeText(i.value.detail);
    fil.showToast("Détail copié");
  } catch {
    fil.showToast("Copie impossible", "error");
  }
}
</script>

<template>
  <div
    role="status"
    class="mt-2 pt-2 border-t border-slate-200 flex items-center gap-2 flex-wrap text-[13px]"
    :title="i.detail"
    data-interruption
  >
    <i class="ph ph-warning text-amber-600 shrink-0" aria-hidden="true"></i>
    <span class="text-slate-800 min-w-0">Interrompue : {{ i.cause }}</span>
    <button
      v-if="action"
      type="button"
      class="min-h-6 px-2.5 py-0.5 rounded-lg border border-slate-200 bg-white text-xs font-semibold text-slate-700 hover:bg-slate-50 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
      data-interruption-action
      @click="agir"
    >
      {{ action }}
    </button>
    <button
      v-if="i.detail"
      type="button"
      class="min-h-6 px-2 py-0.5 rounded-lg text-xs text-slate-500 hover:text-slate-700 hover:bg-slate-100 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
      data-copier-detail
      @click="copier"
    >
      Copier le détail
    </button>
  </div>
</template>
