<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/studio/MenuContexteStudio.vue — menu du clic droit sur la capture : sous-menus d'actions sur l'élément, le point ou la zone, décrits par une table. -->
<script setup lang="ts">
import { RACCOURCIS_TOUCHES } from "../../features/studio/dialogue";
import { domaineStudio } from "../../features/studio/domaine";

interface Entree {
  faire: () => void;
  icone: string;
  libelle: string;
  sansElement?: string;
  siElement?: boolean;
  delai?: boolean;
  sep?: boolean;
  bleu?: boolean;
}

const sd = domaineStudio();
const LARGE = "min-w-[210px] max-h-[70vh] overflow-y-auto custom-scrollbar";
const e = (faire: () => unknown, icone: string, libelle: string, plus: Partial<Entree> = {}): Entree => ({
  faire: () => void faire(),
  icone: `ph-${icone} text-slate-400`,
  libelle,
  ...plus,
});
const script = (kind: string, icone: string, libelle: string, plus?: Partial<Entree>): Entree =>
  e(() => sd.ctxScript(kind), icone, libelle, plus);

const SOUS_MENUS: { id: string; icone: string; libelle: string; panneau: string; entrees: Entree[] }[] = [
  {
    id: "script",
    icone: "ph-code",
    libelle: "Script",
    panneau: "min-w-[230px] max-h-[70vh] overflow-y-auto custom-scrollbar",
    entrees: [
      script("if", "git-branch", "Si présent…", { siElement: true }),
      script("if_missing", "git-branch", "Si absent…", { siElement: true }),
      script("else", "arrow-elbow-down-right", "Sinon"),
      script("loop", "repeat", "Répéter"),
      script("wait", "hourglass", "Attendre l'élément", {
        sansElement: "Attendre l'écran stable",
        delai: true,
        sep: true,
      }),
      script("pause", "timer", "Pause", { delai: true }),
      script("wait_gone", "hourglass-low", "Attendre sa disparition", { siElement: true, delai: true }),
      script("check", "check-square", "Vérifier présent", { siElement: true }),
      script("check_gone", "x-square", "Vérifier absent", { siElement: true }),
      script("var", "brackets-curly", "Lire sa valeur (variable)", { siElement: true }),
      script("click", "cursor-click", "Écrire le clic (sans l'exécuter)", { sep: true }),
      script("double_click", "cursor-click", "Écrire un double-clic"),
      script("right_click", "cursor", "Écrire un clic droit"),
      script("set_value", "text-t", "Écrire une saisie…"),
      script("focus", "app-window", "Fenêtre au premier plan…", { sep: true }),
      script("note", "note-pencil", "Note…"),
    ],
  },
  {
    id: "clics",
    icone: "ph-cursor-click text-slate-400",
    libelle: "Clics",
    panneau: "min-w-[190px]",
    entrees: [
      e(() => sd.ctxAct("click"), "cursor-click", "Cliquer"),
      e(() => sd.ctxAct("double_click"), "cursor-click", "Double-cliquer"),
      e(() => sd.ctxAct("triple_click"), "cursor-click", "Triple-cliquer"),
      e(() => sd.ctxAct("right_click"), "cursor", "Clic droit"),
      e(() => sd.ctxAct("middle_click"), "mouse", "Clic milieu"),
    ],
  },
  {
    id: "ctrl",
    icone: "ph-sliders text-slate-400",
    libelle: "Contrôle (fiable)",
    panneau: LARGE,
    entrees: [
      e(() => sd.ctxSemantic("toggle"), "toggle-left", "Basculer (case/bouton)"),
      e(() => sd.ctxSemantic("check"), "check-square", "Cocher"),
      e(() => sd.ctxSemantic("uncheck"), "square", "Décocher"),
      e(() => sd.ctxSemantic("select"), "list-checks", "Sélectionner (liste/onglet)"),
      e(() => sd.ctxSemantic("expand"), "caret-down", "Déplier"),
      e(() => sd.ctxSemantic("collapse"), "caret-up", "Replier"),
      e(() => sd.ctxSemantic("scroll_into_view"), "arrows-in", "Amener dans la vue"),
      e(() => sd.ctxSetValue(), "text-t", "Définir la valeur…"),
    ],
  },
  {
    id: "saisie",
    icone: "ph-keyboard text-slate-400",
    libelle: "Saisie",
    panneau: "min-w-[190px]",
    entrees: [
      e(() => sd.ctxType(), "keyboard", "Taper…"),
      e(() => sd.ctxPaste(), "clipboard-text", "Coller…"),
      e(() => sd.ctxCopy(), "copy", "Copier"),
    ],
  },
  {
    id: "keys",
    icone: "ph-command text-slate-400",
    libelle: "Touches",
    panneau: LARGE,
    entrees: RACCOURCIS_TOUCHES.map((k) =>
      e(() => sd.ctxKeyPreset(k.keys), "keyboard", k.label, { icone: "ph-keyboard text-slate-300" }),
    ),
  },
  {
    id: "souris",
    icone: "ph-mouse text-slate-400",
    libelle: "Souris",
    panneau: "min-w-[190px]",
    entrees: [
      e(() => sd.ctxMove(), "hand-pointing", "Survoler (déplacer)"),
      e(() => sd.ctxDragFrom(), "arrows-out-cardinal", "Glisser-déposer depuis ici…"),
      e(() => sd.ctxScroll("up"), "arrow-fat-up", "Défiler vers le haut"),
      e(() => sd.ctxScroll("down"), "arrow-fat-down", "Défiler vers le bas"),
    ],
  },
  {
    id: "lecture",
    icone: "ph-text-aa text-slate-400",
    libelle: "Lecture",
    panneau: "min-w-[190px]",
    entrees: [
      e(() => sd.ctxRead(), "text-aa", "Lire (OCR) la zone"),
      e(() => sd.ctxAsk(), "sparkle", "Demander au modèle…", { icone: "ph-sparkle", bleu: true }),
    ],
  },
];

/** Script seulement dans l'onglet Script ; Contrôle et les entrées propres à un élément seulement sur un élément. */
const visible = (id: string): boolean =>
  id === "script" ? sd.studioTab === "script" : id !== "ctrl" || !!sd.studioCtxMenu?.el;
</script>

<template>
  <template v-if="sd.studioCtxMenu">
    <div
      class="fixed inset-0 z-[60]"
      @click="sd.closeStudioCtx"
      @contextmenu.prevent="sd.closeStudioCtx"
    ></div>
    <div
      class="fixed z-[61] min-w-[210px] bg-white rounded-lg shadow-xl border border-slate-200 py-1 text-sm elpis-ctx-menu"
      :style="{ left: sd.studioCtxMenu.x + 'px', top: sd.studioCtxMenu.y + 'px' }"
    >
      <div class="px-3 py-1 text-xs text-slate-400 border-b border-slate-100 mb-1 truncate">
        {{
          sd.studioCtxMenu.el
            ? "« " +
              sd.elementDisplay(sd.studioCtxMenu.el) +
              " »" +
              (sd.studioCtxMenu.el.role ? " · " + sd.studioCtxMenu.el.role : "")
            : "point " + sd.studioCtxMenu.point?.join(", ")
        }}
      </div>
      <!-- Un sous-menu par ligne de SOUS_MENUS ; Script (onglet Script ouvert) écrit au curseur, ciblé sur l'élément cliqué -->
      <template v-for="m in SOUS_MENUS" :key="m.id">
        <div v-if="visible(m.id)" class="relative" @mouseenter="sd.studioCtxSub = m.id">
          <button
            class="w-full text-left px-3 py-1.5 flex items-center gap-2"
            :class="[
              m.id === 'script' ? 'hover:bg-blue-50 text-blue-700' : 'hover:bg-slate-50',
              sd.studioCtxSub === m.id ? (m.id === 'script' ? 'bg-blue-50' : 'bg-slate-50') : '',
            ]"
            @click="sd.studioCtxSub = sd.studioCtxSub === m.id ? '' : m.id"
          >
            <i class="ph" :class="m.icone"></i> {{ m.libelle }}
            <i
              class="ph ph-caret-right ml-auto text-xs"
              :class="m.id === 'script' ? 'text-blue-300' : 'text-slate-300'"
            ></i>
          </button>
          <div
            v-if="sd.studioCtxSub === m.id"
            class="absolute bg-white rounded-lg shadow-xl border border-slate-200 py-1 z-[62]"
            :class="[m.panneau, sd.ctxSubPos()]"
          >
            <div v-if="m.id === 'script'" class="px-3 pt-0.5 pb-1 text-xs text-slate-400 truncate">
              S'insère au curseur{{
                sd.studioCtxMenu.el ? " — cible : " + sd.elementDisplay(sd.studioCtxMenu.el) : ""
              }}
            </div>
            <template v-for="x in m.entrees" :key="x.libelle">
              <template v-if="!x.siElement || sd.studioCtxMenu.el">
                <div v-if="x.sep" class="my-1 border-t border-slate-100"></div>
                <button
                  class="w-full text-left px-3 py-1.5 flex items-center gap-2"
                  :class="x.bleu ? 'hover:bg-blue-50 text-blue-700' : 'hover:bg-slate-50'"
                  @click="x.faire()"
                >
                  <i class="ph" :class="x.icone"></i>
                  {{ x.sansElement && !sd.studioCtxMenu.el ? x.sansElement : x.libelle }}
                  <span
                    v-if="x.delai"
                    class="ml-auto text-xs text-slate-400"
                    title="Délai (champ « Délai » de la palette)"
                    >{{ sd.autoWaitSec }} s</span
                  >
                </button>
              </template>
            </template>
          </div>
        </div>
      </template>
    </div>
  </template>
</template>
