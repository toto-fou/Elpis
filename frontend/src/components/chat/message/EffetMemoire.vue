<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/chat/message/EffetMemoire.vue — une écriture en mémoire du message : libellé, détail lu dans le journal (op), annuler, gérer. -->
<script setup lang="ts">
import { computed } from "vue";

import { CLE_FIL, domaine } from "../../../features/chat/page/domaines";

import type { LigneEffet } from "../../../features/chat/message/types";

const props = defineProps<{ line: LigneEffet }>();
const fil = domaine(CLE_FIL);
const detail = computed(() => fil.effectDetail(props.line));
</script>

<template>
  <div
    class="elpis-effect"
    :class="{ 'is-error': line.error, 'is-full': line.full, 'is-open': fil.effectIsOpen(line) }"
    data-effect-memory
  >
    <button
      type="button"
      class="elpis-effect-head"
      :disabled="line.running"
      :aria-expanded="fil.effectIsOpen(line) ? 'true' : 'false'"
      @click="fil.toggleEffect(line)"
    >
      <i class="ph ph-brain elpis-effect-ico" aria-hidden="true"></i>
      <span class="elpis-effect-label" :class="line.running ? 'mem-wave' : ''">{{ line.label }}</span>
      <span v-if="line.storeLabel" class="elpis-effect-store">· {{ line.storeLabel }}</span>
      <span v-if="line.title" class="elpis-effect-title">{{ line.title }}</span>
      <span v-if="detail?.data?.undone" class="elpis-effect-tag" data-effect-undone>annulé</span>
      <i v-if="!line.running" class="ph ph-caret-right elpis-effect-caret" aria-hidden="true"></i>
    </button>
    <div v-if="fil.effectIsOpen(line)" class="elpis-effect-body" data-effect-body>
      <p v-if="line.full" class="elpis-effect-msg">
        Budget plein : l'assistant doit regrouper ou retirer des notes.
      </p>
      <p v-else-if="line.error" class="elpis-effect-msg is-error">
        {{ line.message || "L'écriture a échoué." }}
      </p>
      <template v-else-if="line.op">
        <p v-if="!detail || detail.state === 'loading'" class="elpis-effect-msg">Chargement…</p>
        <p v-else-if="detail.state === 'error'" class="elpis-effect-msg is-error">{{ detail.error }}</p>
        <template v-else-if="detail.data">
          <p v-if="detail.data.action === 'rewrite'" class="elpis-effect-msg">
            {{ detail.data.n_before }} note{{ (detail.data.n_before ?? 0) > 1 ? "s" : "" }} →
            {{ detail.data.n_after }} note{{ (detail.data.n_after ?? 0) > 1 ? "s" : "" }}
          </p>
          <div
            v-for="(t, ti) in detail.data.removed"
            :key="'r' + ti"
            class="elpis-effect-entry is-removed"
            data-effect-removed
          >
            {{ t }}
          </div>
          <div
            v-for="(t, ti) in detail.data.added"
            :key="'a' + ti"
            class="elpis-effect-entry is-added"
            data-effect-added
          >
            {{ t }}
          </div>
        </template>
      </template>
      <template v-else>
        <div v-if="line.content" class="elpis-effect-entry is-added">{{ line.content }}</div>
        <div v-else-if="line.target" class="elpis-effect-entry is-removed">{{ line.target }}</div>
      </template>
      <p v-if="detail?.state === 'ok' && detail.error" class="elpis-effect-msg is-error" role="alert">
        {{ detail.error }}
      </p>
      <div class="elpis-effect-actions">
        <button
          v-if="line.op && detail?.data?.can_undo"
          type="button"
          class="elpis-effect-btn"
          data-effect-undo
          :disabled="detail?.undoing"
          @click="fil.undoMemoryEffect(line)"
        >
          Annuler
        </button>
        <button type="button" class="elpis-effect-btn" data-effect-manage @click="fil.manageMemory()">
          Gérer la mémoire
        </button>
      </div>
    </div>
  </div>
</template>
