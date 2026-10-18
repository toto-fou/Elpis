<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/skills/NoeudSkill.vue — nœud récursif de l'arbre des skills (domaine, skill, fichier) ; l'état replié vit dans l'ensemble du parent. -->
<script setup lang="ts">
import { computed } from "vue";
import type { ResumeSkill } from "@elpis/contracts";

import type { NoeudSkill as Noeud } from "../../features/skills/arbre";

const props = withDefaults(
  defineProps<{ node: Noeud; selectedKey?: string; activeFileKey?: string; collapsed: Set<string> }>(),
  { selectedKey: "", activeFileKey: "" },
);
const emit = defineEmits<{
  "select-skill": [skill: ResumeSkill | undefined];
  "open-file": [payload: { skill: ResumeSkill | undefined; path: string | undefined }];
  toggle: [key: string];
}>();

const isExpandable = computed(() => (props.node.children || []).length > 0);
const isOpen = computed(() => !props.collapsed.has(props.node.key));
const isSelected = computed(() => props.node.kind === "skill" && props.node.key === props.selectedKey);
const isFileActive = computed(() => props.node.kind === "file" && props.node.key === props.activeFileKey);
const rowClass = computed(() => {
  if (isSelected.value) return "bg-blue-50 ring-1 ring-blue-200";
  if (isFileActive.value) return "bg-blue-50/60 ring-1 ring-blue-100";
  return "hover:bg-slate-50";
});
const labelClass = computed(() => {
  if (props.node.kind === "domain") return "text-[11px] font-semibold text-slate-500";
  if (props.node.kind === "file") return "font-mono text-[11px] text-slate-500";
  return "font-mono text-sm font-medium text-slate-800";
});

function handleClick(): void {
  if (props.node.kind === "skill") emit("select-skill", props.node.skill);
  else if (props.node.kind === "file") emit("open-file", { skill: props.node.skill, path: props.node.path });
  else emit("toggle", props.node.key);
}
const onSelectSkill = (p: ResumeSkill | undefined): void => emit("select-skill", p);
const onOpenFile = (p: { skill: ResumeSkill | undefined; path: string | undefined }): void =>
  emit("open-file", p);
const onToggle = (k: string): void => emit("toggle", k);
</script>

<template>
  <li class="select-none">
    <div
      class="flex items-center gap-1 py-1 px-1.5 rounded-md cursor-pointer transition-colors group outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-blue-500"
      role="treeitem"
      tabindex="0"
      :aria-expanded="isExpandable ? (isOpen ? 'true' : 'false') : undefined"
      :aria-selected="isSelected ? 'true' : undefined"
      :aria-label="
        (node.kind === 'domain' ? 'Domaine ' : node.kind === 'file' ? 'Fichier ' : 'Skill ') + node.label
      "
      :class="rowClass"
      @click="handleClick"
      @keydown.enter.prevent="handleClick"
      @keydown.space.prevent="handleClick"
    >
      <button
        v-if="isExpandable"
        type="button"
        tabindex="-1"
        class="w-4 h-4 shrink-0 rounded text-slate-400 hover:text-slate-600 flex items-center justify-center"
        :title="isOpen ? 'Replier' : 'Déplier'"
        :aria-label="(isOpen ? 'Replier ' : 'Déplier ') + node.label"
        @click.stop="onToggle(node.key)"
      >
        <i class="ph text-[10px]" :class="isOpen ? 'ph-caret-down' : 'ph-caret-right'"></i>
      </button>
      <span v-else class="w-4 shrink-0"></span>
      <span class="shrink-0 flex items-center justify-center w-5">
        <i
          v-if="node.kind === 'domain'"
          class="ph text-sm text-amber-500"
          :class="isOpen ? 'ph-folder-open' : 'ph-folder'"
        ></i>
        <i
          v-else-if="node.kind === 'skill'"
          class="ph ph-graduation-cap text-sm"
          :class="isSelected ? 'text-blue-600' : 'text-slate-400'"
        ></i>
        <i
          v-else
          class="ph ph-file-code text-[13px]"
          :class="isFileActive ? 'text-blue-600' : 'text-slate-400'"
        ></i>
      </span>
      <span class="min-w-0 flex-1 py-0.5">
        <span class="flex items-center gap-1.5">
          <span class="truncate" :class="labelClass">{{ node.label }}</span>
          <span
            v-if="node.kind === 'skill' && node.childSkillCount"
            class="text-[10px] font-mono px-1 rounded bg-slate-100 text-slate-500 shrink-0"
            :title="node.childSkillCount + ' sous-skill(s)'"
            >{{ node.childSkillCount }}</span
          >
          <i
            v-else-if="
              node.kind === 'skill' && node.skill && node.skill.is_folder && (node.skill.files || []).length
            "
            class="ph ph-paperclip text-[11px] text-slate-400 shrink-0"
            title="Agent Skill : contient des fichiers/scripts"
          ></i>
        </span>
        <span
          v-if="node.kind === 'skill' && node.skill && node.skill.description"
          class="block text-[10.5px] text-slate-500 truncate leading-tight"
          >{{ node.skill.description }}</span
        >
      </span>
    </div>
    <ul
      v-if="isExpandable && isOpen"
      role="group"
      class="pl-2.5 border-l border-slate-200 ml-[15px] mt-0.5 space-y-0.5 mb-1"
    >
      <NoeudSkill
        v-for="c in node.children"
        :key="c.key"
        :node="c"
        :selected-key="selectedKey"
        :active-file-key="activeFileKey"
        :collapsed="collapsed"
        @select-skill="onSelectSkill"
        @open-file="onOpenFile"
        @toggle="onToggle"
      ></NoeudSkill>
    </ul>
  </li>
</template>
