<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/editor/ElementArbre.vue — ligne récursive de l'arbre de fichiers (et de l'arbre Git) : sélection, clavier, glisser-déposer, pastilles Git ; remplace le x-template `tree-item-template`. -->
<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";

import { arbre, depotSurDossier, MIME_GLISSER } from "../../features/editor/arbre";
import { metaFichier } from "../../features/editor/meta-fichier";
import type { NoeudArbre } from "../../features/editor/schemas-bac";

export interface MenuArbre {
  event: MouseEvent | KeyboardEvent;
  item: NoeudArbre;
}

const props = defineProps<{ item: NoeudArbre }>();
const emit = defineEmits<{
  "open-file": [chemin: string];
  "context-menu": [charge: MenuArbre];
  download: [chemin: string];
  delete: [chemin: string];
  rename: [chemin: string];
  "move-item": [charge: { oldPath: string; newParent: string }];
}>();

const T = arbre();
const tree = T.state;
const rowRef = ref<HTMLElement | null>(null);
const dragOver = ref(false);
const isFolder = computed(() => props.item.type === "folder");
const isOpen = computed(() => isFolder.value && tree.open.has(props.item.path));
const isActive = computed(() => !isFolder.value && tree.active === props.item.path);
const isSelected = computed(() => tree.selected.size > 1 && tree.selected.has(props.item.path));
const gitCode = computed(() =>
  isFolder.value ? (tree.gitDirs.has(props.item.path) ? "•" : "") : tree.git[props.item.path] || "",
);
const meta = computed(() => metaFichier(props.item.name));
const TITRES_GIT: Readonly<Record<string, string>> = {
  M: "Modifié",
  U: "Non suivi",
  A: "Ajouté",
  D: "Supprimé",
  C: "En conflit",
  "•": "Contient des modifications",
};

watch(
  () => tree.revealSeq,
  () => {
    if (tree.revealPath !== props.item.path) return;
    void nextTick(() => {
      try {
        rowRef.value?.scrollIntoView({ block: "nearest", inline: "nearest" });
      } catch {
        /* ligne démontée */
      }
    });
  },
);

function ordreVisible(): string[] {
  const t = rowRef.value?.closest('[role="tree"]');
  if (!t) return [];
  return Array.from(t.querySelectorAll<HTMLElement>('[role="treeitem"]'), (r) => r.dataset["path"] ?? "");
}

/** Ctrl/Cmd + clic : bascule dans la sélection ; Maj + clic : plage ; sinon ouvre ou plie. */
function handleClick(event?: MouseEvent | KeyboardEvent): void {
  if (event && (event.ctrlKey || event.metaKey)) {
    T.select(props.item.path, "toggle");
    return;
  }
  if (event?.shiftKey) {
    T.select(props.item.path, "range", ordreVisible());
    return;
  }
  T.select(props.item.path, "single");
  if (isFolder.value) T.setOpen(props.item.path, !isOpen.value);
  else emit("open-file", props.item.path);
}

/** Entrée et Espace : comme un clic ; Maj+F10 et touche Menu : menu contextuel ; puis suppression, renommage, navigation. */
function handleKeydown(event: KeyboardEvent): void {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    handleClick(event);
  } else if ((event.key === "F10" && event.shiftKey) || event.key === "ContextMenu") {
    event.preventDefault();
    event.stopPropagation();
    handleRightClick(event);
  }
  if (event.altKey || event.ctrlKey || event.metaKey) return;
  if (event.key === "Delete") {
    event.preventDefault();
    emit("delete", props.item.path);
    return;
  }
  if (event.key === "F2") {
    event.preventDefault();
    emit("rename", props.item.path);
    return;
  }
  if (event.key === "Escape" && tree.selected.size > 1) {
    T.clearSelection();
    return;
  }
  if (T.navKey(event, rowRef.value, props.item)) event.preventDefault();
}

/** Clic droit hors de la sélection : elle se réduit à la ligne visée. */
function handleRightClick(event: MouseEvent | KeyboardEvent): void {
  if (!tree.selected.has(props.item.path)) T.select(props.item.path, "single");
  emit("context-menu", { event, item: props.item });
}

function onDragStart(event: DragEvent): void {
  const dt = event.dataTransfer;
  if (!dt) return;
  dt.setData("text/plain", props.item.path);
  dt.setData(MIME_GLISSER, JSON.stringify(T.targetsFor(props.item.path)));
  dt.effectAllowed = "move";
}

function onDragOver(event: DragEvent): void {
  if (!isFolder.value) return;
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
  dragOver.value = true;
}

function onDragEnter(event: DragEvent): void {
  if (!isFolder.value) return;
  event.preventDefault();
  dragOver.value = true;
}

/** Dépôt sur un dossier : import des fichiers de l'OS ou déplacement interne de la sélection ; le dossier est déplié. */
function onDrop(event: DragEvent): void {
  dragOver.value = false;
  if (!isFolder.value) return;
  event.preventDefault();
  event.stopPropagation();
  const dt = event.dataTransfer;
  if (!dt) return;
  const dossier = props.item.path;
  const { importe, sources } = depotSurDossier(dt, dossier, T.parentOf);
  for (const src of sources) emit("move-item", { oldPath: src, newParent: dossier });
  if (importe || sources.length) T.setOpen(dossier, true);
}
</script>

<template>
  <li class="select-none py-0.5" @contextmenu.stop>
    <div
      ref="rowRef"
      :data-path="item.path"
      class="flex items-center gap-2 py-1 px-2 rounded-md cursor-pointer transition-colors group outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-blue-500"
      :class="
        dragOver
          ? 'bg-blue-500/20 outline outline-1 outline-dashed outline-blue-400'
          : isSelected
            ? 'bg-blue-500/25'
            : isActive
              ? 'bg-white/10 elpis-tree-active'
              : 'hover:bg-[rgba(255,255,255,0.05)]'
      "
      role="treeitem"
      tabindex="0"
      :aria-expanded="isFolder ? (isOpen ? 'true' : 'false') : undefined"
      :aria-selected="isSelected || isActive ? 'true' : 'false'"
      :aria-label="(isFolder ? 'Dossier ' : 'Fichier ') + item.name"
      draggable="true"
      @dragstart.stop="onDragStart"
      @dragover.prevent="onDragOver"
      @dragenter.prevent="onDragEnter"
      @dragleave="dragOver = false"
      @drop.prevent="onDrop"
      @click="handleClick"
      @contextmenu.prevent.stop="handleRightClick"
      @keydown="handleKeydown"
    >
      <span class="shrink-0 flex items-center justify-center w-5">
        <i
          v-if="isFolder"
          class="ph text-slate-400 text-sm transition-transform"
          :class="isOpen ? 'ph-folder-open text-blue-400' : 'ph-folder'"
        ></i>
        <i v-else class="ph text-sm" :class="[meta.icon, meta.color]"></i>
      </span>
      <span
        class="text-xs truncate flex-1 font-mono tracking-tight"
        :class="[
          isFolder ? 'font-medium text-slate-200' : isActive ? 'text-white' : 'text-slate-300',
          gitCode === 'M'
            ? 'elpis-git-m'
            : gitCode === 'U' || gitCode === 'A'
              ? 'elpis-git-u'
              : gitCode === 'C'
                ? 'elpis-git-c'
                : '',
        ]"
        >{{ item.name }}</span
      >
      <span
        v-if="gitCode"
        class="shrink-0 text-[10px] font-mono font-bold w-3 text-center"
        :class="
          gitCode === 'M'
            ? 'elpis-git-m'
            : gitCode === 'C'
              ? 'elpis-git-c'
              : gitCode === 'D'
                ? 'elpis-git-d'
                : 'elpis-git-u'
        "
        :title="TITRES_GIT[gitCode]"
        >{{ gitCode }}</span
      >
    </div>
    <ul
      v-if="isFolder && isOpen"
      role="group"
      class="pl-3 border-l border-[rgba(255,255,255,0.05)] ml-2 mt-0.5 space-y-0.5 mb-1"
    >
      <ElementArbre
        v-for="child in item.children"
        :key="child.path"
        :item="child"
        @open-file="(p) => emit('open-file', p)"
        @download="(p) => emit('download', p)"
        @delete="(p) => emit('delete', p)"
        @rename="(p) => emit('rename', p)"
        @context-menu="(c) => emit('context-menu', c)"
        @move-item="(c) => emit('move-item', c)"
      />
    </ul>
  </li>
</template>
