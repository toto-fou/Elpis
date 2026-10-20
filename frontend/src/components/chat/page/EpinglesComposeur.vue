<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/chat/page/EpinglesComposeur.vue — collections RAG actives, skills épinglés par /skill et image à modifier, au-dessus de la saisie. -->
<script setup lang="ts">
import { CLE_COMPOSEUR, CLE_IMAGE, domaine } from "../../../features/chat/page/domaines";

const comp = domaine(CLE_COMPOSEUR);
const img = domaine(CLE_IMAGE);

// Bulle d'une pastille : auteur d'une collection partagée, puis sa description.
function titreCollection(c: { description: string; auteur: string | null }): string {
  return [c.auteur ? `Partagée par ${c.auteur}` : "", c.description].filter(Boolean).join("\n");
}
</script>

<template>
  <div
    v-if="comp.ragActives.length > 0"
    class="flex flex-wrap gap-1.5 px-3 pt-3 pb-1"
    role="list"
    aria-label="Collections interrogées dans cette conversation"
    data-rag-actives
  >
    <span
      v-for="c in comp.ragActives"
      :key="c.id"
      class="elpis-rag-chip"
      role="listitem"
      :title="titreCollection(c) || undefined"
      :data-rag-collection="c.id"
    >
      <i class="ph ph-books elpis-rag-chip__icone" aria-hidden="true"></i>
      <span class="elpis-rag-chip__nom">{{ c.name }}</span>
      <span v-if="c.auteur" class="elpis-rag-chip__auteur">{{ c.auteur }}</span>
      <button
        type="button"
        class="elpis-rag-chip__retirer"
        :aria-label="`Ne plus interroger ${c.name}`"
        title="Retirer"
        @click="comp.retirerCollectionRag(c.id)"
      >
        <i class="ph ph-x" aria-hidden="true"></i>
      </button>
    </span>
  </div>
  <div v-if="comp.pinnedSkills.length > 0" class="flex flex-wrap gap-1.5 px-3 pt-3 pb-1">
    <span
      v-for="sk in comp.pinnedSkills"
      :key="sk.name"
      class="inline-flex items-center gap-1.5 pl-2 pr-1 py-1 rounded-lg bg-blue-50 border border-blue-200 text-[11px] text-blue-700 max-w-[240px]"
      :title="sk.description"
    >
      <i class="ph ph-graduation-cap text-blue-400" style="font-size: 12px"></i>
      <span class="font-mono font-medium truncate">{{ sk.name }}</span>
      <button
        type="button"
        class="text-blue-300 hover:text-blue-600 transition-colors shrink-0"
        @click="comp.removePinnedSkill(sk.name)"
      >
        <i class="ph ph-x" style="font-size: 11px"></i>
      </button>
    </span>
  </div>
  <div v-if="img.imageMode && img.imageEditRef" class="flex flex-wrap gap-2 px-3 pt-3 pb-1" data-image-ref>
    <div class="relative group/file">
      <div class="elpis-img-refchip">
        <img :src="img.imageEditRef.thumb_url || img.imageEditRef.url" alt="Image à modifier" />
        <span class="elpis-img-refchip__label">À modifier</span>
      </div>
      <button
        type="button"
        title="Retirer"
        aria-label="Retirer l’image à modifier"
        class="absolute -top-1.5 -right-1.5 w-5 h-5 flex items-center justify-center rounded-full opacity-0 group-hover/file:opacity-100 focus-visible:opacity-100 transition-all z-20 bg-slate-700 text-white hover:bg-slate-900 shadow-md"
        @click="img.clearImageEditRef()"
      >
        <i class="ph ph-x text-[10px]" aria-hidden="true"></i>
      </button>
    </div>
  </div>
</template>
