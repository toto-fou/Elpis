<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/chat/page/MenuConversation.vue — entrées du menu « Conversation » : Renommer… (F2), Rechercher, Exporter › (formats dépliés sur place), Archiver, Supprimer ; le parent porte le role="menu". -->
<script setup lang="ts">
import { ref } from "vue";

import { FORMATS_EXPORT } from "../../../features/chat/page/conversation";
import type { ActionConversation } from "../../../features/chat/page/conversation";

const emit = defineEmits<{ action: [action: ActionConversation] }>();
const exporter = ref(false);
const ITEM =
  "w-full text-left px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-100 focus:bg-slate-100 focus:outline-none rounded-lg flex items-center gap-2.5 transition-colors";
const RACCOURCI = "ml-auto font-mono text-[11px] text-slate-500";
</script>

<template>
  <button
    type="button"
    role="menuitem"
    :class="ITEM"
    data-conv-action="renommer"
    @click="emit('action', 'renommer')"
  >
    <i class="ph ph-pencil-simple text-slate-500" aria-hidden="true"></i> Renommer…
    <kbd :class="RACCOURCI">F2</kbd>
  </button>
  <button
    type="button"
    role="menuitem"
    :class="ITEM"
    data-conv-action="rechercher"
    @click="emit('action', 'rechercher')"
  >
    <i class="ph ph-magnifying-glass text-slate-500" aria-hidden="true"></i> Rechercher
  </button>
  <button
    type="button"
    role="menuitem"
    aria-haspopup="true"
    :aria-expanded="exporter ? 'true' : 'false'"
    :class="ITEM"
    data-conv-action="exporter"
    @click.stop="exporter = !exporter"
  >
    <i class="ph ph-export text-slate-500" aria-hidden="true"></i> Exporter
    <i
      class="ph ph-caret-right ml-auto text-[11px] text-slate-500 transition-transform"
      :class="exporter ? 'rotate-90' : ''"
      aria-hidden="true"
    ></i>
  </button>
  <div v-if="exporter" class="pl-6 flex flex-col gap-0.5" role="group" aria-label="Exporter">
    <button
      v-for="f in FORMATS_EXPORT"
      :key="f.id"
      type="button"
      role="menuitem"
      :class="ITEM"
      :data-conv-export="f.id"
      @click="emit('action', `exporter:${f.id}`)"
    >
      {{ f.libelle }}
    </button>
  </div>
  <button
    type="button"
    role="menuitem"
    :class="ITEM"
    data-conv-action="apprendre"
    title="Garder les gestes navigateur réussis de cette conversation comme procédure"
    @click="emit('action', 'apprendre')"
  >
    <i class="ph ph-list-checks text-slate-500" aria-hidden="true"></i> Enregistrer comme procédure…
  </button>
  <div class="h-px bg-slate-100 my-1 mx-2" role="separator"></div>
  <button
    type="button"
    role="menuitem"
    :class="ITEM"
    data-conv-action="archiver"
    @click="emit('action', 'archiver')"
  >
    <i class="ph ph-archive text-slate-500" aria-hidden="true"></i> Archiver
  </button>
  <div class="h-px bg-slate-100 my-1 mx-2" role="separator"></div>
  <button
    type="button"
    role="menuitem"
    :class="[ITEM, 'text-red-600 hover:bg-red-50 focus:bg-red-50']"
    data-conv-action="supprimer"
    @click="emit('action', 'supprimer')"
  >
    <i class="ph ph-trash text-red-500" aria-hidden="true"></i> Supprimer
  </button>
</template>
