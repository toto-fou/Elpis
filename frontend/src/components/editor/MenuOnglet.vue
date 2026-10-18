<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/editor/MenuOnglet.vue — menu contextuel d'un onglet de l'éditeur (clic droit, Maj+F10) : chaque entrée émet son action, le parent ferme le menu comme avant. -->
<script setup lang="ts">
const props = defineProps<{
  ouvert: boolean;
  x: number;
  y: number;
  chemin: string;
  nbOnglets: number;
  epingle: boolean;
  visionneuse: boolean;
  nbModifies: number;
}>();
const emit = defineEmits<{
  clore: [];
  fermer: [chemin: string];
  "fermer-autres": [chemin: string];
  "fermer-droite": [chemin: string];
  "tout-fermer": [];
  scinder: [chemin: string];
  copier: [chemin: string];
  localiser: [chemin: string];
  epingler: [chemin: string];
  joindre: [chemin: string];
  "tout-enregistrer": [];
}>();

function fermer(): void {
  emit("fermer", props.chemin);
  emit("clore");
}
</script>

<template>
  <div
    v-if="props.ouvert"
    class="fixed inset-0 z-[999]"
    @click="emit('clore')"
    @contextmenu.prevent="emit('clore')"
  >
    <div
      class="absolute min-w-[200px] bg-white border border-slate-200 rounded-md shadow-lg py-1 text-[12px]"
      :style="{ left: props.x + 'px', top: props.y + 'px' }"
      @click.stop
    >
      <button
        class="w-full text-left px-3 py-1.5 hover:bg-slate-100 text-slate-700 flex items-center gap-2"
        @click="fermer"
      >
        <i class="ph ph-x text-slate-400"></i>Fermer
      </button>
      <button
        :disabled="props.nbOnglets <= 1"
        class="w-full text-left px-3 py-1.5 hover:bg-slate-100 text-slate-700 disabled:text-slate-300 disabled:hover:bg-transparent flex items-center gap-2"
        @click="emit('fermer-autres', props.chemin)"
      >
        <i class="ph ph-x-circle text-slate-400"></i>Fermer les autres
      </button>
      <button
        class="w-full text-left px-3 py-1.5 hover:bg-slate-100 text-slate-700 flex items-center gap-2"
        @click="emit('fermer-droite', props.chemin)"
      >
        <i class="ph ph-arrow-right text-slate-400"></i>Fermer ceux à droite
      </button>
      <button
        class="w-full text-left px-3 py-1.5 hover:bg-slate-100 text-slate-700 flex items-center gap-2"
        @click="emit('tout-fermer')"
      >
        <i class="ph ph-x-square text-slate-400"></i>Tout fermer
      </button>
      <div v-if="!props.visionneuse" class="h-px bg-slate-200 my-1"></div>
      <button
        v-if="!props.visionneuse"
        class="w-full text-left px-3 py-1.5 hover:bg-slate-100 text-slate-700 flex items-center gap-2"
        @click="emit('scinder', props.chemin)"
      >
        <i class="ph ph-columns text-slate-400"></i>Ouvrir à droite (vue scindée)
      </button>
      <button
        class="w-full text-left px-3 py-1.5 hover:bg-slate-100 text-slate-700 flex items-center gap-2"
        @click="emit('copier', props.chemin)"
      >
        <i class="ph ph-copy text-slate-400"></i>Copier le chemin
      </button>
      <button
        class="w-full text-left px-3 py-1.5 hover:bg-slate-100 text-slate-700 flex items-center gap-2"
        @click="emit('localiser', props.chemin)"
      >
        <i class="ph ph-crosshair text-slate-400"></i>Localiser<kbd
          class="ml-auto text-[10px] text-slate-400 font-mono"
          >Alt+L</kbd
        >
      </button>
      <button
        class="w-full text-left px-3 py-1.5 hover:bg-slate-100 text-slate-700 flex items-center gap-2"
        @click="emit('epingler', props.chemin)"
      >
        <i class="ph ph-push-pin text-slate-400"></i>{{ props.epingle ? "Désépingler" : "Épingler" }}
      </button>
      <button
        v-if="!props.visionneuse"
        class="w-full text-left px-3 py-1.5 hover:bg-slate-100 text-slate-700 flex items-center gap-2"
        @click="emit('joindre', props.chemin)"
      >
        <i class="ph ph-paperclip text-slate-400"></i>Joindre au chat
      </button>
      <div class="h-px bg-slate-200 my-1"></div>
      <button
        :disabled="!props.nbModifies"
        class="w-full text-left px-3 py-1.5 hover:bg-slate-100 text-slate-700 disabled:text-slate-300 disabled:hover:bg-transparent flex items-center gap-2"
        @click="emit('tout-enregistrer')"
      >
        <i class="ph ph-floppy-disk-back text-slate-400"></i>Tout enregistrer<kbd
          class="ml-auto text-[10px] text-slate-400 font-mono"
          >Ctrl+Alt+S</kbd
        >
      </button>
    </div>
  </div>
</template>
