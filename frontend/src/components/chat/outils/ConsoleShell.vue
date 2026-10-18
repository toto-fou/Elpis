<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/chat/outils/ConsoleShell.vue — terminal en direct d'un segment : commandes execute_shell et sorties ANSI, suivi du bas. -->
<script setup lang="ts">
import { computed, onBeforeUnmount, onBeforeUpdate, onMounted, onUpdated, useTemplateRef } from "vue";

import { htmlConsoleShell, texteConsoleShell } from "../../../features/chat/outils/format";
import type { GroupeSegment, MetaConsoleShell } from "../../../features/chat/outils/types";
import { copierTexte, messageErreur } from "../../../utils/dom";

const props = defineProps<{ grp: GroupeSegment; meta: MetaConsoleShell; cle: string }>();
const emit = defineEmits<{ fermer: []; notifier: [message: string, type?: string] }>();

const corps = useTemplateRef<HTMLPreElement>("corps");
const html = computed(() => htmlConsoleShell(props.grp));
let suivre = true;
let observateur: ResizeObserver | null = null;

function enBas(): void {
  const el = corps.value;
  if (el) el.scrollTop = el.scrollHeight;
}

onMounted(() => {
  enBas();
  const el = corps.value;
  if (el && typeof ResizeObserver !== "undefined") {
    let visible = el.clientHeight > 0;
    observateur = new ResizeObserver(() => {
      const maintenant = el.clientHeight > 0;
      if (maintenant && !visible) enBas();
      visible = maintenant;
    });
    observateur.observe(el);
  }
});
onBeforeUpdate(() => {
  const el = corps.value;
  suivre = !el || el.scrollHeight - el.scrollTop - el.clientHeight < 48;
});
onUpdated(() => {
  if (suivre) enBas();
});
onBeforeUnmount(() => observateur?.disconnect());

async function copier(): Promise<void> {
  const brut = texteConsoleShell(props.grp);
  if (!brut) {
    emit("notifier", "Aucune sortie à copier.");
    return;
  }
  try {
    await copierTexte(brut);
    emit("notifier", "Sortie du terminal copiée");
  } catch (e) {
    emit("notifier", "Impossible de copier : " + messageErreur(e), "error");
  }
}
</script>

<!-- eslint-disable vue/no-v-html -- HTML de la console : commande échappée, sortie passée par ansiToHtml (échappement puis spans de couleur). -->
<template>
  <div class="shell-live mt-2">
    <div class="shell-live-header">
      <span class="shell-live-dot" :class="props.meta.dot"></span>
      <i class="ph ph-terminal-window" style="font-size: 12px"></i>
      <span class="shell-live-cmd truncate">{{ props.meta.title }}</span>
      <span class="ml-auto shrink-0 tabular-nums shell-live-status">{{ props.meta.chip }}</span>
      <button
        type="button"
        class="shell-live-copy"
        title="Copier la sortie"
        aria-label="Copier la sortie du terminal"
        @click="copier"
      >
        <i class="ph ph-copy" style="font-size: 11px"></i>
      </button>
      <button
        type="button"
        class="shell-live-copy"
        title="Fermer"
        aria-label="Fermer le terminal"
        @click="emit('fermer')"
      >
        <i class="ph ph-x" style="font-size: 10px"></i>
      </button>
    </div>
    <pre
      ref="corps"
      class="shell-live-body custom-scrollbar"
      :data-shell-live="props.cle"
      v-html="html"
    ></pre>
    <div v-if="props.meta.truncated" class="shell-live-note">
      Sortie en direct tronquée (64 Ko) — le résultat complet est conservé côté sandbox.
    </div>
  </div>
</template>
