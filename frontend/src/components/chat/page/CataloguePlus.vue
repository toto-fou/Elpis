<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/chat/page/CataloguePlus.vue — « + » du composeur en catalogue (interface nouvelle) : joindre, partages reçus, insérer (skills, prompts, gabarits en sous-menus), mode plan et compactage, commande « / » en raccourci. -->
<script setup lang="ts">
import { computed, nextTick, ref, useTemplateRef, watch } from "vue";

import { CLE_COMPOSEUR, CLE_PAGE, domaine } from "../../../features/chat/page/domaines";
import { publierElement } from "../../../features/chat/page/element";
import {
  contientFocus,
  elementActif,
  focusPremiere,
  naviguerMenu,
} from "../../../features/chat/page/menu-clavier";
import type { GabaritCatalogue, PromptCatalogue, SkillCatalogue } from "../../../features/chat/page/types";
import PartagesRecus from "./PartagesRecus.vue";

type SousMenu = "skills" | "prompts" | "gabarits";

const emit = defineEmits<{ ancre: [el: HTMLDivElement | null] }>();
const comp = domaine(CLE_COMPOSEUR);
const p = domaine(CLE_PAGE);
publierElement(useTemplateRef<HTMLDivElement>("ancre"), (el) => emit("ancre", el));
const bouton = useTemplateRef<HTMLButtonElement>("bouton");
const menu = useTemplateRef<HTMLDivElement>("menu");
const sousMenu: { el: HTMLDivElement | null } = { el: null };
const sous = ref<SousMenu | null>(null);

const INSERER: readonly { id: SousMenu; libelle: string; icone: string; commande: string }[] = [
  { id: "skills", libelle: "Skills", icone: "ph-graduation-cap", commande: "/skills" },
  { id: "prompts", libelle: "Prompts", icone: "ph-bookmark-simple", commande: "/prompt" },
  { id: "gabarits", libelle: "Gabarits", icone: "ph-brackets-curly", commande: "/template" },
];

const skills = computed(() => {
  const vus = new Set<string>();
  return Object.values(comp.skillsByScope)
    .flat()
    .filter((s) => s.name && !vus.has(s.name) && vus.add(s.name));
});
const epingles = computed(() => new Set(comp.pinnedSkills.map((s) => s.name)));
const compacterPossible = computed(() => !!comp.currentChatId && !comp.isStreaming);

let parChoix = false;
// Fermé par un choix : le focus va où l'action le met (saisie, fenêtre), pas au « + ».
function fermer(): void {
  parChoix = true;
  comp.showComposerPlus = false;
}

function basculer(): void {
  comp.showComposerPlus = !comp.showComposerPlus;
  if (!comp.showComposerPlus) return;
  comp.refreshInboxCount();
  void nextTick(() => focusPremiere(menu.value));
}

// Fermé par Échap ou un clic extérieur alors que le focus y était : il revient au « + ».
watch(
  () => comp.showComposerPlus,
  (ouvert) => {
    const choix = parChoix;
    parChoix = false;
    if (ouvert) return;
    const avait = contientFocus(menu.value);
    sous.value = null;
    if (avait && !choix) void nextTick(() => bouton.value?.focus());
  },
);

function ouvrirSous(id: SousMenu, clavier: boolean): void {
  sous.value = sous.value === id && !clavier ? null : id;
  if (sous.value === "skills") comp.loadAllSkills();
  if (sous.value === "prompts") comp.loadSavedPrompts();
  if (sous.value === "gabarits") comp.loadTemplates();
  if (clavier) void nextTick(() => focusPremiere(sousMenu.el));
}

function surToucheMenu(e: KeyboardEvent): void {
  if (!menu.value || naviguerMenu(e, menu.value)) return;
  const id = elementActif()?.dataset.sous as SousMenu | undefined;
  if (id && (e.key === "ArrowRight" || e.key === "Enter" || e.key === " ")) {
    e.preventDefault();
    ouvrirSous(id, true);
  }
}

function surToucheSous(e: KeyboardEvent): void {
  e.stopPropagation();
  if (sousMenu.el && naviguerMenu(e, sousMenu.el)) return;
  if (e.key === "ArrowLeft") {
    e.preventDefault();
    const id = sous.value;
    sous.value = null;
    void nextTick(() => menu.value?.querySelector<HTMLElement>(`[data-sous="${id}"]`)?.focus());
  }
}

function joindre(): void {
  fermer();
  comp.triggerFileUpload();
}

function partages(): void {
  fermer();
  comp.showSharedPrompts = true;
  comp.loadSharedPrompts();
  comp.refreshInboxCount();
}

function basculerSkill(s: SkillCatalogue): void {
  if (epingles.value.has(s.name)) comp.removePinnedSkill(s.name);
  else comp.pinnedSkills = [...comp.pinnedSkills, { name: s.name, description: s.description ?? "" }];
}

// Le prompt s'ajoute au brouillon (jamais envoyé) : l'utilisateur relit puis décide.
function insererPrompt(pr: PromptCatalogue): void {
  fermer();
  const brouillon = p.inputMessage.replace(/\s+$/, "");
  p.inputMessage = brouillon ? `${brouillon}\n\n${pr.content}` : pr.content;
  void nextTick(() => {
    const zone = p.inputRef instanceof HTMLTextAreaElement ? p.inputRef : null;
    zone?.focus();
    zone?.setSelectionRange(zone.value.length, zone.value.length);
    void p.handleInputInput();
  });
}

function insererGabarit(g: GabaritCatalogue): void {
  fermer();
  comp.openTemplate(g);
}

function basculerPlan(): void {
  if (!comp.isStreaming) comp.setPlanMode(!comp.planMode);
}

function compacter(): void {
  if (!compacterPossible.value) return;
  fermer();
  comp.manualCompress();
}

const ITEM =
  "w-full text-left px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-100 focus:bg-slate-100 focus:outline-none rounded-lg flex items-center gap-2.5 transition-colors disabled:opacity-50 aria-disabled:opacity-50";
const RACCOURCI = "ml-auto font-mono text-[11px] text-slate-500";
</script>

<template>
  <div ref="ancre" class="relative flex items-center">
    <button
      ref="bouton"
      type="button"
      class="w-8 h-8 flex items-center justify-center text-slate-500 hover:text-blue-600 hover:bg-slate-100 rounded-lg transition-colors relative"
      :class="comp.inboxCount > 0 || comp.showComposerPlus ? 'text-blue-600' : ''"
      title="Plus d'actions"
      aria-label="Plus d'actions"
      aria-haspopup="menu"
      :aria-expanded="comp.showComposerPlus ? 'true' : 'false'"
      data-catalogue-plus
      @click.prevent="basculer"
    >
      <i class="ph ph-plus text-lg" aria-hidden="true"></i>
      <span
        v-if="comp.inboxCount > 0 && !comp.showComposerPlus"
        class="absolute -top-1 -right-1 min-w-[16px] h-4 bg-red-500 text-white text-[10px] font-bold rounded-full flex items-center justify-center px-1 leading-none shadow-sm"
        :aria-label="`${comp.inboxCount} partage(s) reçu(s)`"
        >{{ comp.inboxCount > 99 ? "99+" : comp.inboxCount }}</span
      >
    </button>

    <Transition name="popover-up">
      <div
        v-if="comp.showComposerPlus && !comp.showSharedPrompts"
        ref="menu"
        role="menu"
        aria-label="Plus d'actions"
        class="absolute bottom-full left-0 mb-2 w-64 bg-white border border-slate-200 rounded-xl shadow-xl z-50 p-1.5 space-y-0.5"
        @keydown="surToucheMenu"
      >
        <button type="button" role="menuitem" :class="ITEM" @click.stop="joindre">
          <i class="ph ph-paperclip text-slate-500 text-base" aria-hidden="true"></i>
          <span class="flex-1">Joindre un fichier</span>
        </button>
        <button type="button" role="menuitem" :class="ITEM" @click.stop="partages">
          <i class="ph ph-tray text-slate-500 text-base" aria-hidden="true"></i>
          <span class="flex-1">Partages reçus</span>
          <span
            v-if="comp.inboxCount > 0"
            class="ml-auto bg-red-500 text-white text-[10px] font-bold rounded-full px-1.5 leading-[14px] min-w-[16px] text-center"
            >{{ comp.inboxCount > 99 ? "99+" : comp.inboxCount }}</span
          >
        </button>

        <div class="h-px bg-slate-100 my-1" role="separator"></div>
        <div class="px-3 pt-0.5 pb-0.5 text-xs font-semibold text-slate-500" aria-hidden="true">Insérer</div>
        <div v-for="it in INSERER" :key="it.id" class="relative">
          <button
            type="button"
            role="menuitem"
            aria-haspopup="menu"
            :aria-expanded="sous === it.id ? 'true' : 'false'"
            :data-sous="it.id"
            :class="[ITEM, sous === it.id ? 'bg-slate-100' : '']"
            @click.stop="ouvrirSous(it.id, false)"
          >
            <i class="ph text-slate-500 text-base" :class="it.icone" aria-hidden="true"></i>
            <span class="flex-1">{{ it.libelle }}</span>
            <kbd :class="RACCOURCI">{{ it.commande }}</kbd>
            <i class="ph ph-caret-right text-[11px] text-slate-500" aria-hidden="true"></i>
          </button>
          <div
            v-if="sous === it.id"
            :ref="(el) => (sousMenu.el = el as HTMLDivElement | null)"
            role="menu"
            :aria-label="it.libelle"
            class="absolute left-full bottom-0 ml-1 w-60 max-w-[70vw] max-h-72 overflow-y-auto bg-white border border-slate-200 rounded-xl shadow-xl z-[60] p-1.5 space-y-0.5"
            :data-sous-menu="it.id"
            @keydown="surToucheSous"
          >
            <template v-if="it.id === 'skills'">
              <button
                v-for="s in skills"
                :key="s.name"
                type="button"
                role="menuitemcheckbox"
                :aria-checked="epingles.has(s.name) ? 'true' : 'false'"
                :title="s.description"
                :class="ITEM"
                @click.stop="basculerSkill(s)"
              >
                <span
                  class="w-4 h-4 rounded border flex items-center justify-center shrink-0"
                  :class="epingles.has(s.name) ? 'bg-blue-600 border-blue-600' : 'border-slate-300'"
                  aria-hidden="true"
                >
                  <i v-if="epingles.has(s.name)" class="ph ph-check text-white text-[10px]"></i>
                </span>
                <span class="font-mono text-xs truncate">{{ s.name }}</span>
              </button>
              <div v-if="!skills.length" class="px-3 py-2 text-xs text-slate-500">Aucun skill</div>
            </template>
            <template v-else-if="it.id === 'prompts'">
              <button
                v-for="pr in comp.savedPromptsList"
                :key="pr.id"
                type="button"
                role="menuitem"
                :title="pr.content"
                :class="ITEM"
                @click.stop="insererPrompt(pr)"
              >
                <span class="truncate">{{ pr.title || pr.content }}</span>
              </button>
              <div v-if="!comp.savedPromptsList.length" class="px-3 py-2 text-xs text-slate-500">
                Aucun prompt
              </div>
            </template>
            <template v-else>
              <button
                v-for="g in comp.templatesAll"
                :key="g.name"
                type="button"
                role="menuitem"
                :title="g.name"
                :class="ITEM"
                @click.stop="insererGabarit(g)"
              >
                <span class="truncate">{{ g.title || g.name }}</span>
              </button>
              <div v-if="!comp.templatesAll.length" class="px-3 py-2 text-xs text-slate-500">
                Aucun gabarit
              </div>
            </template>
          </div>
        </div>

        <div class="h-px bg-slate-100 my-1" role="separator"></div>
        <div class="px-3 pt-0.5 pb-0.5 text-xs font-semibold text-slate-500" aria-hidden="true">
          Conversation
        </div>
        <button
          type="button"
          role="menuitemcheckbox"
          :aria-checked="comp.planMode ? 'true' : 'false'"
          :aria-disabled="comp.isStreaming ? 'true' : undefined"
          :title="comp.isStreaming ? 'Hors génération' : 'Outils d\'écriture retirés jusqu\'à la réponse'"
          :class="ITEM"
          data-catalogue-plan
          @click.stop="basculerPlan"
        >
          <span
            class="w-4 h-4 rounded border flex items-center justify-center shrink-0"
            :class="comp.planMode ? 'bg-blue-600 border-blue-600' : 'border-slate-300'"
            aria-hidden="true"
          >
            <i v-if="comp.planMode" class="ph ph-check text-white text-[10px]"></i>
          </span>
          <span class="flex-1">Mode plan</span>
          <kbd :class="RACCOURCI">/plan</kbd>
        </button>
        <button
          type="button"
          role="menuitem"
          :aria-disabled="compacterPossible ? undefined : 'true'"
          :title="
            compacterPossible ? 'Résumer l\'historique ancien' : 'Conversation en cours, hors génération'
          "
          :class="ITEM"
          data-catalogue-compacter
          @click.stop="compacter"
        >
          <i class="ph ph-arrows-in-simple text-slate-500 text-base" aria-hidden="true"></i>
          <span class="flex-1">Compacter</span>
          <kbd :class="RACCOURCI">/compact</kbd>
        </button>
      </div>
    </Transition>

    <PartagesRecus />
  </div>
</template>
