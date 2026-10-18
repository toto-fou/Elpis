<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/studio/PageStudio.vue — page Studio : capture annotée d'une cible desktop, arbre UIA, inspecteur, mini-chat de pilotage, éditeur du script d'automatisation, exécution et rapport. -->
<script setup lang="ts">
import { domaineStudio } from "../../features/studio/domaine";

const sd = domaineStudio();

function poserDefilement(el: unknown): void {
  sd.studioChatScrollEl = (el as HTMLElement | null) ?? null;
}
function poserSaisieModale(el: unknown): void {
  sd.textModalInput = (el as HTMLTextAreaElement | null) ?? null;
}
</script>

<template>
  <div
    v-if="sd.currentView === 'studio'"
    role="region"
    aria-label="Annotation Studio"
    class="elpis-studio-page absolute inset-0 z-[45] bg-white flex flex-col"
  >
    <!-- == Header ================================================ -->
    <header class="h-16 shrink-0 flex items-center justify-between px-4 bg-white border-b border-slate-200">
      <div class="flex items-center gap-3 min-w-0">
        <button
          title="Retour au chat"
          class="w-9 h-9 rounded-lg text-slate-500 hover:bg-slate-100 hover:text-slate-700 flex items-center justify-center transition-colors shrink-0"
          @click="sd.closeStudio"
        >
          <i class="ph ph-arrow-left text-lg"></i>
        </button>
        <i class="ph ph-bounding-box text-blue-500 text-2xl shrink-0"></i>
        <div class="min-w-0">
          <h2 class="font-bold text-base text-slate-900 tracking-tight leading-tight">Studio</h2>
        </div>
        <!-- Outil du stage (Inspecter / Zone / Glisser) : placé ICI, à côté du titre, plutôt qu'en surimpression sur -->
        <template v-if="sd.studioFrame.imageUrl">
          <div class="w-px h-5 bg-slate-200 shrink-0"></div>
          <div
            class="flex items-center h-8 rounded-md border border-slate-200 bg-white overflow-hidden text-[11px] shrink-0"
          >
            <button
              title="Survoler / cliquer un élément"
              class="px-2.5 h-full flex items-center gap-1 transition-colors"
              :class="
                sd.studioStageMode === 'inspect'
                  ? 'bg-blue-50 text-blue-700 font-medium'
                  : 'text-slate-500 hover:bg-slate-50'
              "
              @click="sd.studioStageMode = 'inspect'"
            >
              <i class="ph ph-cursor"></i> Inspecter
            </button>
            <button
              title="Tracer une zone (OCR / demander au modèle)"
              class="px-2.5 h-full flex items-center gap-1 transition-colors border-l border-slate-200"
              :class="
                sd.studioStageMode === 'select'
                  ? 'bg-blue-50 text-blue-700 font-medium'
                  : 'text-slate-500 hover:bg-slate-50'
              "
              @click="sd.studioStageMode = 'select'"
            >
              <i class="ph ph-bounding-box"></i> Zone
            </button>
            <button
              title="Glisser-déposer : presse sur la source et trace jusqu'à la cible"
              class="px-2.5 h-full flex items-center gap-1 transition-colors border-l border-slate-200"
              :class="
                sd.studioStageMode === 'drag'
                  ? 'bg-blue-50 text-blue-700 font-medium'
                  : 'text-slate-500 hover:bg-slate-50'
              "
              @click="sd.studioStageMode = 'drag'"
            >
              <i class="ph ph-arrows-out-cardinal"></i> Glisser
            </button>
          </div>
          <!-- Plans (couches) : ne voir que le 1er plan, le 2e… et limiter la profondeur dans la fenêtre -->
          <div class="relative shrink-0">
            <button
              title="Plans : n'afficher que certaines fenêtres, limiter la profondeur"
              class="h-8 px-2.5 rounded-md border text-[11px] flex items-center gap-1.5 transition-colors"
              :class="
                sd.studioLayerActive
                  ? 'border-blue-300 bg-blue-50 text-blue-700'
                  : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'
              "
              @click="sd.toggleStudioLayers()"
            >
              <i class="ph ph-stack"></i> Plans
              <span v-if="sd.studioLayerActive" class="text-[10px] px-1 rounded bg-blue-100 text-blue-700"
                >{{ sd.studioLayerFiltered.length }}/{{ sd.studioElements.length }}</span
              >
            </button>
            <template v-if="sd.studioLayersOpen">
              <div class="fixed inset-0 z-[54]" @click="sd.studioLayersOpen = false"></div>
              <div
                class="absolute left-0 top-full mt-1 z-[55] w-72 bg-white rounded-lg shadow-xl border border-slate-200 p-2 text-left"
              >
                <div class="flex items-center justify-between mb-1">
                  <span class="text-[11px] font-semibold text-slate-700 flex items-center gap-1.5"
                    ><i class="ph ph-stack"></i> Fenêtres (ordre Z)</span
                  >
                  <button class="text-[10.5px] text-blue-600 hover:underline" @click="sd.showAllLayers()">
                    Tout afficher
                  </button>
                </div>
                <p v-if="!sd.studioLayers.length" class="text-[11px] text-slate-400 py-1">
                  Aucune fenêtre dans la capture.
                </p>
                <div
                  v-for="l in sd.studioLayers"
                  :key="l.index"
                  class="flex items-center gap-1.5 rounded-md px-1 py-1 hover:bg-slate-50"
                >
                  <button
                    :title="sd.isLayerOn(l.index) ? 'Masquer ce plan' : 'Afficher ce plan'"
                    class="w-4 h-4 rounded border flex items-center justify-center shrink-0"
                    :class="
                      sd.isLayerOn(l.index)
                        ? 'bg-blue-600 border-blue-600 text-white'
                        : 'border-slate-300 bg-white text-transparent'
                    "
                    @click="sd.toggleLayer(l.index)"
                  >
                    <i class="ph ph-check text-[10px]"></i>
                  </button>
                  <button
                    class="flex-1 min-w-0 text-left text-[11px] truncate"
                    :class="sd.isLayerOn(l.index) ? 'text-slate-700' : 'text-slate-400'"
                    :title="'Voir ce plan seul — ' + (l.label || '')"
                    @click="sd.soloLayer(l.index)"
                  >
                    {{ sd.layerLabel(l) }}
                  </button>
                  <span class="text-[10px] text-slate-400 shrink-0">{{ l.count }}</span>
                  <button
                    title="Ce plan seul"
                    class="text-[10px] px-1 rounded text-slate-400 hover:text-blue-600 hover:bg-blue-50 shrink-0"
                    @click="sd.soloLayer(l.index)"
                  >
                    seul
                  </button>
                </div>
                <div class="mt-2 pt-2 border-t border-slate-100 flex items-center gap-1 text-[10.5px]">
                  <span
                    class="text-slate-500 mr-1"
                    title="Ne garder que les N premiers niveaux de chaque fenêtre"
                    >Profondeur</span
                  >
                  <button
                    v-for="d in [0, 1, 2, 3, 4]"
                    :key="d"
                    class="px-1.5 h-5 rounded border"
                    :class="
                      sd.studioDepthMax === d
                        ? 'border-blue-300 bg-blue-50 text-blue-700'
                        : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'
                    "
                    @click="sd.setDepthMax(d)"
                  >
                    {{ d === 0 ? "toutes" : "≤ " + d }}
                  </button>
                </div>
              </div>
            </template>
          </div>
        </template>
      </div>
      <div class="flex items-center gap-1.5 shrink-0">
        <span v-if="sd.studioLive" class="flex items-center gap-1 text-[11px] font-medium text-blue-600 mr-1">
          <span class="w-1.5 h-1.5 rounded-full bg-blue-500 animate-pulse"></span> LIVE
        </span>
        <select
          v-model="sd.selectedTarget"
          title="Machine cible"
          class="text-xs px-2 h-8 rounded-md border border-slate-200 bg-white outline-none focus:ring-1 focus:ring-blue-500 max-w-[180px]"
        >
          <option value="" disabled>Choisir une cible…</option>
          <option v-for="t in sd.studioTargets" :key="t.name" :value="t.name">
            {{ t.name }} ({{ t.os }})
          </option>
        </select>
        <!-- Split-button : action principale « Capturer » (texte constant) + flèche déroulante (Lire / Vider) -->
        <div class="relative">
          <div class="flex items-center h-8 rounded-md overflow-hidden shadow-sm">
            <button
              :disabled="sd.studioCapturing || !sd.selectedTarget"
              title="Capturer la cible (selon le mode choisi à gauche)"
              class="text-xs pl-3 pr-2.5 h-full bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 transition-colors flex items-center gap-1.5"
              @click="sd.captureAndAnnotate"
            >
              <i class="ph" :class="sd.studioCapturing ? 'ph-spinner animate-spin' : 'ph-scan'"></i>
              Capturer
            </button>
            <button
              :disabled="!sd.selectedTarget"
              title="Autres actions (Lire, Vider)"
              class="px-1.5 h-full bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 border-l border-blue-500/50 transition-colors flex items-center"
              :class="sd.studioActionsOpen ? 'bg-blue-700' : ''"
              @click="sd.toggleStudioActions()"
            >
              <i class="ph ph-caret-down text-xs"></i>
            </button>
          </div>
          <template v-if="sd.studioActionsOpen">
            <div class="fixed inset-0 z-[54]" @click="sd.studioActionsOpen = false"></div>
            <div
              class="absolute right-0 top-full mt-1 z-[55] w-44 bg-white rounded-lg shadow-xl border border-slate-200 p-1 text-left"
            >
              <button
                :disabled="sd.studioReading || !sd.selectedTarget"
                title="Lire le texte visible (OCR) — vide = plein écran, ou décris une zone dans la barre"
                class="w-full text-left px-2 py-1.5 rounded-md text-[11px] flex items-center gap-2 text-slate-600 hover:bg-slate-50 disabled:opacity-50 transition-colors"
                @click="sd.studioActionRead()"
              >
                <i class="ph" :class="sd.studioReading ? 'ph-spinner animate-spin' : 'ph-text-aa'"></i> Lire
                (OCR)
              </button>
              <button
                :disabled="!sd.studioFrame.imageUrl && !sd.studioError"
                title="Vider la scène (image + annotations)"
                class="w-full text-left px-2 py-1.5 rounded-md text-[11px] flex items-center gap-2 text-slate-600 hover:bg-slate-50 disabled:opacity-40 transition-colors"
                @click="sd.studioActionClear()"
              >
                <i class="ph ph-broom"></i> Vider
              </button>
            </div>
          </template>
        </div>
        <!-- Réglages Studio : sélection d'écran(s) capturé(s)/piloté(s) -->
        <div class="relative">
          <button
            title="Réglages de capture (mode vision, requête, écran)"
            aria-label="Réglages de capture"
            class="h-8 w-8 rounded-md border transition-colors flex items-center justify-center shrink-0"
            :class="
              sd.studioSettingsOpen
                ? 'border-blue-300 bg-blue-50 text-blue-700'
                : 'border-slate-200 text-slate-600 hover:bg-slate-100'
            "
            @click="sd.toggleStudioSettings()"
          >
            <i class="ph ph-gear text-sm"></i>
          </button>
          <template v-if="sd.studioSettingsOpen">
            <div class="fixed inset-0 z-[54]" @click="sd.studioSettingsOpen = false"></div>
            <div
              class="absolute right-0 top-full mt-1 z-[55] w-72 bg-white rounded-lg shadow-xl border border-slate-200 p-3 text-left"
            >
              <!-- Mode de capture : VRAI toggle (switch) -->
              <div class="flex items-center justify-between gap-2">
                <span class="text-[11px] font-semibold text-slate-700 flex items-center gap-1.5"
                  ><i class="ph ph-eye"></i> Annoter par vision</span
                >
                <button
                  type="button"
                  role="switch"
                  :aria-checked="!sd.studioRaw"
                  :title="
                    sd.studioRaw
                      ? 'Désactivé — capture brute + arbre d\'éléments (a11y)'
                      : 'Activé — boxes annotées par le modèle de vision'
                  "
                  class="relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-1"
                  :class="!sd.studioRaw ? 'bg-blue-600' : 'bg-slate-300'"
                  @click="sd.studioRaw = !sd.studioRaw"
                >
                  <span
                    class="inline-block h-4 w-4 rounded-full bg-white shadow transform transition-transform"
                    :class="!sd.studioRaw ? 'translate-x-[18px]' : 'translate-x-0.5'"
                  ></span>
                </button>
              </div>
              <p class="text-[10px] text-slate-400 mt-1 mb-3 leading-snug">
                Activé : boxes annotées par le modèle. Désactivé : capture + arbre d'éléments (a11y), plus
                rapide.
              </p>
              <!-- Requête d'annotation : vide = tout détecter ; Entrée = capturer -->
              <div class="text-[11px] font-semibold text-slate-700 mb-1.5 flex items-center gap-1.5">
                <i class="ph ph-magnifying-glass"></i> Quoi annoter ?
              </div>
              <input
                v-model="sd.studioPrompt"
                type="text"
                placeholder="Vide = tout détecter"
                class="w-full text-xs px-2.5 py-1.5 rounded-md border border-slate-200 outline-none focus:ring-1 focus:ring-blue-500 mb-3"
                @keydown.enter="sd.captureAndAnnotate"
              />
              <!-- Écran -->
              <div class="text-[11px] font-semibold text-slate-700 mb-1.5 flex items-center gap-1.5">
                <i class="ph ph-monitor"></i> Écran capturé / piloté
              </div>
              <p v-if="!sd.selectedTarget" class="text-[11px] text-slate-400">
                Choisissez d'abord une cible.
              </p>
              <p v-else-if="!sd.studioMonitors.length" class="text-[11px] text-slate-400">
                Aucun écran détecté (agent injoignable ?).
              </p>
              <div v-else class="space-y-1">
                <button
                  v-for="m in sd.studioMonitors"
                  :key="m.index"
                  class="w-full text-left px-2 py-1.5 rounded-md border text-[11px] flex items-center gap-2 transition-colors"
                  :class="
                    sd.studioMonitor === m.index
                      ? 'border-blue-400 bg-blue-50 text-blue-700'
                      : 'border-slate-200 text-slate-600 hover:bg-slate-50'
                  "
                  @click="sd.selectMonitor(m.index)"
                >
                  <i class="ph shrink-0" :class="m.index === 0 ? 'ph-squares-four' : 'ph-monitor'"></i>
                  <span class="flex-1 truncate">{{ m.label }}</span>
                  <span class="text-[10px] text-slate-400 shrink-0">{{ m.width }}×{{ m.height }}</span>
                  <i v-if="sd.studioMonitor === m.index" class="ph ph-check text-blue-600 shrink-0"></i>
                </button>
              </div>
              <p class="text-[10px] text-slate-400 mt-2 leading-snug">
                « Tous les écrans » = vue d'ensemble ; un écran précis = capture + clics ciblés dessus.
              </p>
            </div>
          </template>
        </div>
      </div>
    </header>

    <!-- == Body: stage | tabbed rail ============================= -->
    <div class="flex-1 flex min-h-0">
      <!-- STAGE -->
      <div class="flex-1 flex flex-col min-h-0 bg-slate-50">
        <!-- Empty state -->
        <div
          v-if="!sd.studioFrame.imageUrl"
          class="flex-1 flex flex-col items-center justify-center text-center px-6"
        >
          <i class="ph ph-monitor text-slate-300 text-4xl block mb-3"></i>
          <p class="text-sm font-medium text-slate-600 mb-1">
            Pilotez une machine, annotez l'écran, composez des automatisations.
          </p>
          <p v-if="sd.studioTargets.length === 0" class="text-sm text-slate-500 max-w-md">
            Aucune machine cible configurée. Ajoutez un agent de contrôle dans
            <span class="font-medium text-slate-600">Admin → Vision &amp; Desktop</span>.
          </p>
          <template v-else>
            <p class="text-sm text-slate-500">Choisissez une cible puis « Capturer &amp; annoter »,</p>
            <p class="text-sm text-slate-500">
              ou demandez une action dans l'onglet <span class="font-medium text-slate-600">Assistant</span>.
            </p>
          </template>
          <p v-if="sd.studioError" class="mt-3 text-xs text-red-500">{{ sd.studioError }}</p>
        </div>

        <!-- Annotated frame. The SVG FILLS the stage and 'meet' fits the whole screenshot inside it -->
        <div v-else class="relative flex-1 min-h-0 flex items-center justify-center p-4 overflow-hidden">
          <!-- Outil du stage (Inspecter / Zone / Glisser) déplacé dans le header, à côté du titre -->
          <svg
            v-bind="{
              viewBox: '0 0 ' + (sd.studioFrame.imgW || 1) + ' ' + (sd.studioFrame.imgH || 1),
              preserveAspectRatio: 'xMidYMid meet',
            }"
            class="w-full h-full"
            :style="{
              display: 'block',
              touchAction: 'none',
              cursor:
                sd.studioStageMode === 'select' || sd.studioStageMode === 'drag' || sd.studioDragFrom
                  ? 'crosshair'
                  : 'default',
            }"
            @pointerdown="sd.selStart($event)"
            @pointermove="sd.selMove($event)"
            @pointerup="sd.selEnd($event)"
            @contextmenu.prevent="sd.openStudioCtx($event)"
          >
            <image
              :href="sd.studioFrame.imageUrl"
              x="0"
              y="0"
              :width="sd.studioFrame.imgW || 1"
              :height="sd.studioFrame.imgH || 1"
              @load="sd.onStageImgLoad($event)"
            />
            <!-- Boxes d'éléments : UNIQUEMENT en mode Inspecter -->
            <g v-if="sd.studioStageMode === 'inspect'">
              <g v-for="el in sd.studioOverlayElements" :key="el.id">
                <!-- Grands cadres (fenêtre/conteneur) : NON dessinés en permanence + pointer-events:none → ils ne bloquent pas -->
                <rect
                  :x="el.box[0]"
                  :y="el.box[1]"
                  :width="el.box[2] - el.box[0]"
                  :height="el.box[3] - el.box[1]"
                  :fill="sd.isContainerBox(el) ? 'none' : 'transparent'"
                  :stroke="
                    sd.isContainerBox(el)
                      ? el.id === sd.hoveredElementId || el.id === sd.selectedElementId
                        ? sd.boxStroke(el)
                        : 'none'
                      : sd.boxStroke(el)
                  "
                  :stroke-width="el.id === sd.hoveredElementId || el.id === sd.selectedElementId ? 4 : 2"
                  vector-effect="non-scaling-stroke"
                  :style="{
                    pointerEvents: sd.isContainerBox(el) ? 'none' : 'auto',
                    cursor: 'pointer',
                  }"
                  @mouseenter="sd.highlightElement(el.id)"
                  @mouseleave="sd.clearHighlight()"
                  @click.stop="sd.onBoxClick(el, $event)"
                >
                  <title>
                    {{ sd.elementDisplay(el) }}{{ el.role ? " · " + el.role : ""
                    }}{{ el.auto_id ? " · #" + el.auto_id : "" }} — clic pour agir
                  </title>
                </rect>
                <text
                  v-if="el.id === sd.hoveredElementId"
                  :x="el.box[0]"
                  :y="Math.max(12, el.box[1] - 4)"
                  :font-size="Math.max(11, (sd.studioFrame.imgH || 1000) / 55)"
                  fill="#f59e0b"
                  style="paint-order: stroke; stroke: #fff; stroke-width: 3px"
                >
                  {{ sd.elementDisplay(el) }}
                </text>
              </g>
            </g>
            <!-- Sélection de zone (rubber-band) -->
            <rect
              v-if="sd.studioSel"
              :x="Math.min(sd.studioSel.x1, sd.studioSel.x2)"
              :y="Math.min(sd.studioSel.y1, sd.studioSel.y2)"
              :width="Math.abs(sd.studioSel.x2 - sd.studioSel.x1)"
              :height="Math.abs(sd.studioSel.y2 - sd.studioSel.y1)"
              fill="rgba(37,99,235,0.12)"
              stroke="#2563eb"
              stroke-dasharray="6"
              vector-effect="non-scaling-stroke"
              style="pointer-events: none"
            ></rect>
            <!-- Tracé du glisser-déposer (source → cible) -->
            <g v-if="sd.studioDrag" style="pointer-events: none">
              <line
                :x1="sd.studioDrag.x1"
                :y1="sd.studioDrag.y1"
                :x2="sd.studioDrag.x2"
                :y2="sd.studioDrag.y2"
                stroke="#7c3aed"
                stroke-width="3"
                stroke-dasharray="7"
                vector-effect="non-scaling-stroke"
              ></line>
              <circle
                :cx="sd.studioDrag.x1"
                :cy="sd.studioDrag.y1"
                r="6"
                fill="#7c3aed"
                vector-effect="non-scaling-stroke"
              ></circle>
              <circle
                :cx="sd.studioDrag.x2"
                :cy="sd.studioDrag.y2"
                r="9"
                fill="rgba(124,58,237,0.35)"
                stroke="#7c3aed"
                stroke-width="2"
                vector-effect="non-scaling-stroke"
              ></circle>
            </g>
          </svg>
          <!-- Inspecteur : l'élément sous le pointeur (le plus profond), son fil d'ancêtres -->
          <div
            v-if="sd.studioInspectInfo && sd.studioStageMode === 'inspect'"
            class="absolute bottom-3 left-3 right-3 z-20 flex justify-center pointer-events-none"
          >
            <div
              class="pointer-events-auto max-w-full bg-white/95 backdrop-blur border border-slate-200 shadow-lg rounded-lg text-[11px] elpis-studio-inspector"
            >
              <div class="flex items-center gap-1 px-2.5 h-8 min-w-0">
                <template v-for="c in sd.studioInspectInfo.crumbs" :key="c.id">
                  <button
                    :title="'Sélectionner ' + (c.role || '') + ' — ' + sd.elementDisplay(c)"
                    class="text-slate-500 hover:text-blue-700 truncate max-w-[120px] shrink-0"
                    @click="sd.selectStudioElement(c.id, true)"
                  >
                    {{ sd.elementDisplay(c) }}
                  </button>
                  <i class="ph ph-caret-right text-slate-300 text-[9px] shrink-0"></i>
                </template>
                <span
                  class="font-semibold text-slate-800 truncate max-w-[200px]"
                  :title="sd.elementDisplay(sd.studioInspectInfo.el)"
                  >{{ sd.elementDisplay(sd.studioInspectInfo.el) }}</span
                >
                <span class="text-slate-400 shrink-0">· {{ sd.studioInspectInfo.el.role || "vision" }}</span>
                <span class="w-px h-4 bg-slate-200 mx-1 shrink-0"></span>
                <span
                  class="text-[9px] font-semibold px-1 rounded shrink-0"
                  :class="sd.qualityClass(sd.studioInspectInfo.quality)"
                  :title="'Qualité de la cible : ' + sd.qualityLabel(sd.studioInspectInfo.quality)"
                  >{{ sd.qualityLabel(sd.studioInspectInfo.quality) }}</span
                >
                <code
                  class="font-mono text-[10.5px] text-slate-700 truncate max-w-[380px]"
                  :title="sd.studioInspectInfo.target"
                  >{{ sd.studioInspectInfo.target || "—" }}</code
                >
                <button
                  title="Copier la cible"
                  class="w-6 h-6 rounded hover:bg-slate-100 text-slate-400 hover:text-slate-700 flex items-center justify-center shrink-0"
                  @click="sd.copyStudioTarget()"
                >
                  <i class="ph ph-copy"></i>
                </button>
                <button
                  title="Fiche de l'élément"
                  class="w-6 h-6 rounded flex items-center justify-center shrink-0"
                  :class="
                    sd.studioInspectOpen
                      ? 'bg-blue-50 text-blue-700'
                      : 'hover:bg-slate-100 text-slate-400 hover:text-slate-700'
                  "
                  @click="sd.studioInspectOpen = !sd.studioInspectOpen"
                >
                  <i class="ph ph-info"></i>
                </button>
              </div>
              <div
                v-if="sd.studioInspectOpen"
                class="border-t border-slate-100 px-2.5 py-1.5 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 max-h-40 overflow-y-auto custom-scrollbar"
              >
                <template v-for="row in sd.studioInspectRows" :key="row.k">
                  <span class="text-slate-400">{{ row.k }}</span>
                  <span class="font-mono text-slate-700 truncate" :title="row.v">{{ row.v }}</span>
                </template>
              </div>
            </div>
          </div>
          <!-- Bandeau « armé » : clic droit → Glisser depuis ici → on attend la destination. -->
          <div
            v-if="sd.studioDragFrom"
            class="absolute top-2 left-1/2 -translate-x-1/2 z-20 flex items-center gap-2 px-3 py-1.5 rounded-full bg-blue-600 text-white text-[11px] shadow-lg"
          >
            <i class="ph ph-arrows-out-cardinal"></i>
            Cliquez la destination du glisser
            <button class="ml-1 underline/30 hover:underline" @click="sd.cancelStudioDrag()">
              Annuler (Échap)
            </button>
          </div>
        </div>
      </div>

      <!-- ARBRE EN COLONNE : à côté de l'image et du code (env de code complet) -->
      <div
        v-if="sd.studioTreeDock && sd.studioFrame.imageUrl"
        class="relative shrink-0 border-l border-slate-200 flex flex-col min-h-0 bg-white"
        :style="{ width: sd.studioTreeWidth + 'px' }"
      >
        <!-- Poignée : glisser vers la gauche élargit l'arbre ; double-clic = défaut. -->
        <div
          title="Élargir l'arbre (double-clic : largeur par défaut)"
          class="absolute -left-1 top-0 bottom-0 w-2 cursor-col-resize z-10 hover:bg-blue-400/40 transition-colors"
          @pointerdown="sd.studioTreeDockDragStart($event)"
          @dblclick="sd.studioTreeDockReset()"
        ></div>
        <!-- En-tête de la colonne -->
        <div class="h-11 shrink-0 flex items-center gap-1.5 px-3 border-b border-slate-200">
          <i class="ph ph-tree-structure text-slate-500 shrink-0"></i>
          <span class="text-[11px] font-semibold text-slate-600">Arbre</span>
          <span v-if="sd.studioElements.length" class="text-[10px] text-slate-400 shrink-0"
            >{{ sd.studioLayerActive ? sd.studioLayerFiltered.length + "/" : ""
            }}{{ sd.studioElements.length }}</span
          >
          <button
            title="Masquer l'arbre"
            class="ml-auto w-6 h-6 rounded hover:bg-slate-100 text-slate-400 hover:text-slate-700 flex items-center justify-center shrink-0"
            @click="sd.toggleStudioTreeDock()"
          >
            <i class="ph ph-sidebar-simple"></i>
          </button>
        </div>
        <!-- recherche + replier/déplier -->
        <div class="px-2 py-1.5 border-b border-slate-100 shrink-0 flex items-center gap-1.5">
          <div class="relative flex-1">
            <i
              class="ph ph-magnifying-glass absolute left-2 top-1/2 -translate-y-1/2 text-slate-400 text-xs pointer-events-none"
            ></i>
            <input
              v-model="sd.studioFilter"
              type="text"
              placeholder="Filtrer (nom, rôle, auto_id)…"
              class="w-full text-xs pl-6 pr-2 py-1.5 rounded-md border border-slate-200 outline-none focus:ring-1 focus:ring-blue-500"
            />
          </div>
          <button
            title="Tout replier"
            class="text-slate-400 hover:text-slate-700 p-1 shrink-0"
            @click="sd.collapseAllTree()"
          >
            <i class="ph ph-arrows-in-line-vertical"></i>
          </button>
          <button
            title="Tout déplier"
            class="text-slate-400 hover:text-slate-700 p-1 shrink-0"
            @click="sd.expandAllTree()"
          >
            <i class="ph ph-arrows-out-line-vertical"></i>
          </button>
          <span
            v-if="sd.studioFrame.treeCapped"
            class="text-[9px] font-semibold px-1 rounded bg-amber-100 text-amber-700 shrink-0"
            :title="
              'L\'agent a atteint son plafond de nœuds (' +
              sd.studioFrame.treeNodes +
              ') : des éléments profonds peuvent manquer. Réglage : desktop.studio_max_nodes'
            "
            >tronqué</span
          >
          <button
            v-if="sd.studioElements.length"
            title="Audit d'accessibilité : contrôles interactifs sans nom ni auto_id"
            class="text-[10px] px-1.5 py-0.5 rounded border shrink-0 flex items-center gap-1"
            :class="
              sd.studioAuditOpen
                ? 'border-blue-300 bg-blue-50 text-blue-700'
                : sd.studioAudit.unnamed
                  ? 'border-amber-200 bg-amber-50 text-amber-700'
                  : 'border-slate-200 text-slate-500 hover:bg-slate-50'
            "
            @click="sd.toggleStudioAudit()"
          >
            <i class="ph ph-warning-circle"></i> Audit
            <span v-if="sd.studioAudit.rows.length">{{ sd.studioAudit.rows.length }}</span>
          </button>
        </div>
        <!-- Audit a11y : ce que l'appli devrait nommer pour être automatisable sans chemin -->
        <div
          v-if="sd.studioAuditOpen"
          class="border-b border-slate-200 bg-amber-50/40 shrink-0 max-h-56 overflow-y-auto custom-scrollbar elpis-studio-audit"
        >
          <div class="px-2.5 py-1.5 flex items-center gap-2 text-[11px]">
            <span class="text-slate-700"
              ><b>{{ sd.studioAudit.rows.length }}</b> contrôle(s) à nommer sur
              {{ sd.studioAudit.interactive }} interactif(s)</span
            >
            <span class="text-[10px] text-slate-400 truncate"
              >— sans nom ni auto_id, le script vise par chemin, voisin ou position</span
            >
            <button
              :disabled="!sd.studioAudit.rows.length"
              title="Exporter en CSV"
              class="ml-auto text-[10px] px-1.5 py-0.5 rounded border border-slate-200 text-slate-600 hover:bg-white disabled:opacity-40 shrink-0"
              @click="sd.exportStudioAudit()"
            >
              <i class="ph ph-download-simple"></i> CSV
            </button>
          </div>
          <div v-if="!sd.studioAudit.rows.length" class="px-2.5 pb-2 text-[11px] text-emerald-700">
            Tous les contrôles interactifs portent un nom et un auto_id.
          </div>
          <div
            v-for="r in sd.studioAudit.rows"
            :key="r.id"
            class="px-2.5 py-1 text-[10.5px] flex items-center gap-2 cursor-pointer hover:bg-white/80 border-t border-amber-100/60"
            :class="r.id === sd.selectedElementId ? 'bg-blue-50' : ''"
            @click="sd.selectStudioElement(r.id, true)"
          >
            <i class="ph shrink-0 text-slate-400" :class="sd.roleIcon(r.role)"></i>
            <span class="text-slate-700 shrink-0">{{ r.role }}</span>
            <span class="text-[9px] px-1 rounded bg-amber-100 text-amber-800 shrink-0"
              >sans {{ r.missing }}</span
            >
            <span
              v-if="r.volatile"
              title="auto_id « view_N » de Chromium (Edge, Chrome, Electron) : réassigné à chaque relance, non fiable"
              class="text-[9px] px-1 rounded bg-rose-100 text-rose-700 shrink-0"
              >id volatil</span
            >
            <span v-if="r.near" class="text-slate-500 truncate">près de « {{ r.near }} »</span>
            <code
              class="ml-auto font-mono text-[9.5px] text-slate-400 truncate max-w-[45%]"
              :title="r.path"
              >{{ r.path }}</code
            >
          </div>
        </div>
        <div class="flex-1 overflow-y-auto p-1 custom-scrollbar">
          <div v-if="sd.studioElements.length === 0" class="text-center py-10 px-4">
            <i class="ph ph-tree-structure text-slate-300 text-2xl block mb-2"></i>
            <p v-if="!sd.studioFrame.imageUrl" class="text-xs text-slate-400">
              Capture la cible (« Capturer &amp; annoter ») pour explorer son arbre d'éléments.
            </p>
            <p v-else class="text-xs text-slate-400">
              Aucun élément d'accessibilité exposé par la cible.<br />Vérifiez l'agent (UIA / AT-SPI), ou
              capturez en mode <span class="font-medium text-slate-600">Vision</span>.
            </p>
          </div>
          <div
            v-if="sd.studioElements.length && sd.studioTreeRows.length === 0"
            class="text-center py-6 px-4 text-xs text-slate-400"
          >
            Aucun élément ne correspond.
          </div>
          <div
            v-for="row in sd.studioTreeRows"
            :key="row.el.id"
            :data-el-id="row.el.id"
            class="flex items-center gap-1 pr-1.5 py-1 rounded-md cursor-pointer transition-colors"
            :class="
              row.el.id === sd.selectedElementId
                ? 'bg-blue-50 ring-1 ring-blue-200'
                : row.el.id === sd.hoveredElementId
                  ? 'bg-amber-50'
                  : 'hover:bg-slate-50'
            "
            :style="{ paddingLeft: 4 + row.depth * 12 + 'px' }"
            @mouseenter="sd.highlightElement(row.el.id)"
            @mouseleave="sd.clearHighlight()"
            @click="sd.selectStudioElement(row.el.id)"
            @contextmenu.prevent="sd.openNodeCtx($event, row.el)"
          >
            <button
              v-if="row.hasChildren"
              class="text-slate-400 hover:text-slate-700 shrink-0 w-4 leading-none"
              @click.stop="sd.toggleTreeCollapse(row.el.id)"
            >
              <i class="ph text-xs" :class="row.collapsed ? 'ph-caret-right' : 'ph-caret-down'"></i>
            </button>
            <span v-else class="w-4 shrink-0"></span>
            <i class="ph shrink-0 text-slate-400 text-xs" :class="sd.roleIcon(row.el.role)"></i>
            <span
              class="text-xs truncate flex-1"
              :class="sd.elementName(row.el) ? 'text-slate-700' : 'text-slate-400 italic'"
              >{{ sd.elementDisplay(row.el) }}</span
            >
            <span
              v-if="row.el.auto_id"
              class="text-[9px] font-mono text-blue-500 bg-blue-50 px-1 rounded shrink-0 max-w-[84px] truncate"
              :title="'auto_id : ' + row.el.auto_id"
              >{{ row.el.auto_id }}</span
            >
            <i
              v-if="row.el.states && row.el.states.includes('focused')"
              class="ph ph-keyboard text-emerald-500 text-[10px] shrink-0"
              title="focus clavier"
            ></i>
          </div>
        </div>
        <!-- Élément SÉLECTIONNÉ → actions (UIA-first via auto_id) -->
        <div v-if="sd.selectedElement" class="border-t border-slate-200 shrink-0 px-2.5 py-2 bg-slate-50/70">
          <div class="text-[11px] mb-1.5 flex items-center gap-1 min-w-0">
            <i class="ph shrink-0 text-slate-400" :class="sd.roleIcon(sd.selectedElement.role)"></i>
            <span class="font-medium text-slate-700 truncate">{{
              sd.elementDisplay(sd.selectedElement)
            }}</span>
            <span v-if="sd.selectedElement.role" class="text-[10px] text-slate-400 shrink-0"
              >· {{ sd.selectedElement.role }}</span
            >
            <span
              v-if="sd.selectedElement.auto_id"
              class="text-[9px] font-mono text-blue-500 truncate shrink-0"
              >#{{ sd.selectedElement.auto_id }}</span
            >
          </div>
          <div class="flex flex-wrap gap-1">
            <button
              class="text-[11px] px-2 py-1 rounded-md border border-slate-200 text-slate-700 hover:bg-white hover:border-blue-300 flex items-center gap-1"
              @click="sd.actOnElement(sd.selectedElement, 'click')"
            >
              <i class="ph ph-cursor-click text-[10px]"></i> Cliquer
            </button>
            <button
              class="text-[11px] px-2 py-1 rounded-md border border-slate-200 text-slate-700 hover:bg-white hover:border-blue-300"
              @click="sd.actOnElement(sd.selectedElement, 'double_click')"
            >
              Double-clic
            </button>
            <button
              class="text-[11px] px-2 py-1 rounded-md border border-slate-200 text-slate-700 hover:bg-white hover:border-blue-300"
              @click="sd.actOnElement(sd.selectedElement, 'right_click')"
            >
              Clic droit
            </button>
          </div>
        </div>
        <!-- Texte lu (OCR) -->
        <div v-if="sd.studioText" class="border-t border-slate-200 shrink-0 max-h-[40%] flex flex-col">
          <div class="px-4 h-9 flex items-center justify-between border-b border-slate-100 shrink-0">
            <span class="text-xs font-semibold text-blue-700 flex items-center gap-1.5"
              ><i class="ph ph-text-aa"></i> Texte lu</span
            >
            <span class="text-[10px] text-slate-400 truncate max-w-[140px]" :title="sd.studioText.region">{{
              sd.studioText.region
            }}</span>
          </div>
          <pre
            class="flex-1 overflow-auto p-3 text-[11px] leading-snug text-slate-700 whitespace-pre-wrap break-words font-mono custom-scrollbar"
            >{{ sd.studioText.text }}</pre>
        </div>
        <div class="px-3 py-2 border-t border-slate-100 text-[11px] text-slate-400 shrink-0">
          Survole = surligne · clic = sélectionne ·
          <span class="font-medium text-slate-500">clic droit</span> = toutes les actions (glisser, molette,
          touche…). Clic par <span class="font-medium text-slate-500">auto_id</span> UIA si dispo.
        </div>
      </div>
      <!-- Arbre replié : fine bande pour le rouvrir -->
      <div
        v-else-if="sd.studioFrame.imageUrl"
        title="Afficher l'arbre d'éléments"
        class="shrink-0 w-7 border-l border-slate-200 bg-slate-50/60 hover:bg-slate-100 cursor-pointer flex flex-col items-center pt-2 gap-1"
        @click="sd.toggleStudioTreeDock()"
      >
        <i class="ph ph-tree-structure text-slate-400"></i>
        <span v-if="sd.studioElements.length" class="text-[9px] font-semibold text-slate-400">{{
          sd.studioElements.length
        }}</span>
      </div>

      <!-- TABBED RAIL -->
      <div
        class="relative shrink-0 border-l border-slate-200 flex flex-col min-h-0"
        :style="{ width: (sd.studioTab === 'script' ? sd.autoRailWidth : 420) + 'px' }"
      >
        <!-- Poignée : la section Script s'étire vers la gauche (glisser), double-clic = largeur par défaut -->
        <div
          v-if="sd.studioTab === 'script'"
          title="Étirer la section Script (double-clic : largeur par défaut)"
          class="absolute -left-1 top-0 bottom-0 w-2 cursor-col-resize z-10 hover:bg-blue-400/40 transition-colors"
          @pointerdown="sd.autoRailDragStart($event)"
          @dblclick="sd.autoRailReset()"
        ></div>
        <!-- Tab bar — 3 onglets à plat -->
        <div class="h-11 shrink-0 flex items-stretch border-b border-slate-200 text-[11px] font-semibold">
          <button
            class="flex-1 min-w-0 flex items-center justify-center gap-1 px-1 transition-colors"
            :class="
              sd.studioTab === 'assistant'
                ? 'text-blue-700 border-b-2 border-blue-600 bg-blue-50/40'
                : 'text-slate-500 hover:text-slate-700 hover:bg-slate-50'
            "
            @click="sd.studioTab = 'assistant'"
          >
            <i class="ph ph-chat-circle-dots shrink-0"></i> <span class="truncate">Assistant</span>
          </button>
          <button
            class="flex-1 min-w-0 flex items-center justify-center gap-1 px-1 transition-colors"
            :class="
              sd.studioTab === 'script'
                ? 'text-blue-700 border-b-2 border-blue-600 bg-blue-50/40'
                : 'text-slate-500 hover:text-slate-700 hover:bg-slate-50'
            "
            @click="
              sd.studioTab = 'script';
              sd.autoRefreshList();
            "
          >
            <i class="ph ph-code shrink-0"></i> <span class="truncate">Script</span>
            <span v-if="sd.autoLineCount" class="text-[10px] text-slate-400 shrink-0">{{
              sd.autoLineCount
            }}</span>
          </button>
        </div>

        <!-- TAB: Assistant (mini-chat) -->
        <div v-show="sd.studioTab === 'assistant'" class="flex-1 flex flex-col min-h-0">
          <!-- (passe 6, F17) ref + @scroll : stick-to-bottom du mini-chat -->
          <div
            :ref="poserDefilement"
            class="flex-1 overflow-y-auto p-3 space-y-3 custom-scrollbar"
            @scroll="sd.onStudioChatScroll"
          >
            <div v-if="sd.studioChatMessages.length === 0" class="text-center py-10 px-4">
              <i class="ph ph-cursor-click text-slate-300 text-2xl block mb-2"></i>
              <p class="text-xs text-slate-400">
                Demande une action (« ouvre le menu Fichier », « clique sur Enregistrer ») ou clique
                directement une box sur l'image.
              </p>
            </div>
            <div
              v-for="(m, mi) in sd.studioChatMessages"
              :key="mi"
              class="flex"
              :class="m.role === 'user' ? 'justify-end' : 'justify-start'"
            >
              <div
                class="max-w-[85%] rounded-lg px-3 py-2 text-sm break-words"
                :class="m.role === 'user' ? 'bg-blue-600 text-white' : 'bg-slate-100 text-slate-800'"
              >
                <!-- pastilles d'actions desktop -->
                <div v-if="m.steps && m.steps.length" class="flex flex-wrap gap-1 mb-1">
                  <span
                    v-for="(s, si) in m.steps"
                    :key="si"
                    class="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium"
                    :class="
                      s.status === 'error'
                        ? 'bg-red-100 text-red-600'
                        : s.status === 'running'
                          ? 'bg-amber-100 text-amber-700'
                          : 'bg-emerald-100 text-emerald-700'
                    "
                  >
                    <i
                      class="ph"
                      :class="
                        s.status === 'running'
                          ? 'ph-spinner animate-spin'
                          : s.status === 'error'
                            ? 'ph-x'
                            : 'ph-check'
                      "
                    ></i>
                    {{ s.name }}
                  </span>
                </div>
                <span v-if="m.content" class="whitespace-pre-wrap">{{ m.content }}</span>
                <span
                  v-else-if="m.streaming"
                  class="elpis-typing text-slate-400"
                  role="status"
                  aria-label="génération en cours"
                  ><span></span><span></span><span></span
                ></span>
              </div>
            </div>
          </div>
          <!-- Composer -->
          <div class="border-t border-slate-100 p-2 shrink-0">
            <div class="flex items-center gap-2 mb-1.5">
              <button
                :title="
                  sd.autoComposeOn
                    ? 'Arrêter la composition par l\'IA'
                    : 'Composer par l\'IA : l\'assistant agit pas à pas, chaque action réussie devient une ligne du script, ce qui apparaît devient une attente nommée'
                "
                class="h-6 px-2 rounded-md text-[10.5px] font-medium flex items-center gap-1 transition-colors"
                :class="
                  sd.autoComposeOn
                    ? 'bg-violet-600 text-white hover:bg-violet-700'
                    : 'border border-slate-200 text-slate-600 hover:bg-slate-50'
                "
                @click="sd.toggleAutoCompose()"
              >
                <i class="ph ph-magic-wand"></i>
                {{ sd.autoComposeOn ? "Composition en cours" : "Composer par l'IA" }}
              </button>
              <span v-if="sd.autoComposeOn" class="text-[10px] text-slate-500 truncate"
                >Décrivez l'objectif : le script s'écrit dans l'onglet Script.</span
              >
            </div>
            <div class="flex items-end gap-2">
              <textarea
                v-model="sd.studioChatInput"
                rows="2"
                :disabled="sd.studioChatStreaming || !sd.selectedTarget"
                :placeholder="sd.selectedTarget ? 'Décrivez une action…' : 'Choisissez une cible…'"
                class="flex-1 text-xs px-2.5 py-1.5 rounded-lg border border-slate-200 bg-white outline-none focus:ring-1 focus:ring-blue-500 resize-none disabled:bg-slate-50"
                @keydown.enter.exact.prevent="sd.studioChatSend()"
              ></textarea>
              <button
                v-if="!sd.studioChatStreaming"
                :disabled="!sd.selectedTarget || !sd.studioChatInput.trim()"
                title="Envoyer (Entrée)"
                class="w-9 h-9 rounded-lg bg-blue-600 text-white flex items-center justify-center hover:bg-blue-700 disabled:opacity-40 transition-colors shrink-0"
                @click="sd.studioChatSend()"
              >
                <i class="ph ph-paper-plane-right"></i>
              </button>
              <button
                v-else
                title="Arrêter"
                class="w-9 h-9 rounded-lg border border-slate-200 text-slate-600 flex items-center justify-center hover:bg-slate-100 transition-colors shrink-0"
                @click="sd.studioChatStop()"
              >
                <i class="ph ph-stop"></i>
              </button>
            </div>
          </div>
        </div>

        <!-- TAB: Script — LE CODE EST LE DOCUMENT -->
        <div v-show="sd.studioTab === 'script'" class="flex-1 flex min-h-0">
          <!-- Colonne gauche : Mes scripts + Plan (repliable) -->
          <div
            v-if="sd.autoListOpen"
            class="w-[210px] shrink-0 border-r border-slate-200 flex flex-col min-h-0 bg-slate-50/60"
          >
            <div class="h-9 shrink-0 flex items-center justify-between pl-2 pr-1 border-b border-slate-200">
              <span class="text-[10.5px] font-semibold text-slate-500 truncate">Mes scripts</span>
              <div class="flex items-center">
                <button
                  title="Nouveau script"
                  class="w-6 h-6 rounded hover:bg-slate-200 text-slate-500 flex items-center justify-center"
                  @click="sd.autoNew()"
                >
                  <i class="ph ph-plus text-xs"></i>
                </button>
                <button
                  title="Replier"
                  class="w-6 h-6 rounded hover:bg-slate-200 text-slate-400 flex items-center justify-center"
                  @click="sd.autoListOpen = false"
                >
                  <i class="ph ph-caret-left text-xs"></i>
                </button>
              </div>
            </div>
            <div class="max-h-44 overflow-y-auto custom-scrollbar p-1 border-b border-slate-200">
              <div v-if="!sd.autoScripts.length" class="text-[10.5px] text-slate-400 italic px-1.5 py-2">
                Aucun script enregistré.
              </div>
              <div
                v-for="it in sd.autoScripts"
                :key="it.slug"
                class="group flex items-center rounded-md"
                :class="
                  sd.autoCurrent === it.slug
                    ? 'bg-blue-50 text-blue-700'
                    : 'text-slate-600 hover:bg-slate-100'
                "
              >
                <button
                  :title="it.path"
                  class="flex-1 min-w-0 text-left px-1.5 py-1 text-[11px] truncate"
                  @click="sd.autoOpen(it)"
                >
                  {{ it.name }}
                </button>
                <button
                  title="Supprimer ce script"
                  class="w-5 h-5 mr-0.5 rounded text-slate-300 hover:text-red-500 hover:bg-red-50 items-center justify-center hidden group-hover:flex shrink-0"
                  @click="sd.autoDelete(it)"
                >
                  <i class="ph ph-trash text-[11px]"></i>
                </button>
              </div>
            </div>
            <div class="h-8 shrink-0 flex items-center justify-between px-2 border-b border-slate-200">
              <span class="text-[10.5px] font-semibold text-slate-500">Plan</span>
              <span class="text-[10px] text-slate-400"
                >{{ sd.autoLineCount }} ligne{{ sd.autoLineCount > 1 ? "s" : "" }}</span
              >
            </div>
            <div class="flex-1 overflow-y-auto custom-scrollbar p-1">
              <div v-if="!sd.autoOutline.length" class="text-[10.5px] text-slate-400 italic px-1.5 py-2">
                Le plan suit le code : une ligne par action.
              </div>
              <div
                v-for="row in sd.autoOutline"
                :key="row.line"
                class="group flex items-center gap-1 rounded-md"
                :style="{ paddingLeft: 4 + row.indent * 10 + 'px' }"
                :class="sd.autoCursorLine === row.line ? 'bg-blue-50' : 'hover:bg-slate-100'"
              >
                <i
                  class="ph text-[11px] shrink-0"
                  :class="{
                    'ph-git-branch text-violet-600': row.kind === 'block',
                    'ph-hourglass text-amber-500': row.kind === 'wait',
                    'ph-check-square text-emerald-600': row.kind === 'check',
                    'ph-note text-slate-400': row.kind === 'note',
                    'ph-app-window text-blue-600': row.kind === 'window',
                    'ph-cursor-click text-slate-500': row.kind === 'action',
                    'ph-terminal text-slate-400': row.kind === 'code',
                  }"
                ></i>
                <button
                  :title="'Ligne ' + (row.line + 1)"
                  class="flex-1 min-w-0 text-left py-0.5 text-[10.5px] text-slate-600 truncate font-mono"
                  @click="sd.autoGotoLine(row.line)"
                >
                  {{ row.text }}
                </button>
                <span
                  v-if="row.anchor === 'uia'"
                  title="Élément exposé par Windows (AutomationId) : le plus fiable"
                  class="text-[8.5px] px-1 rounded bg-emerald-100 text-emerald-700 shrink-0"
                  >UIA</span
                >
                <span
                  v-else-if="row.anchor === 'nom'"
                  title="Libellé + rôle de l'arbre d'accessibilité"
                  class="text-[8.5px] px-1 rounded bg-blue-100 text-blue-700 shrink-0"
                  >nom</span
                >
                <span
                  v-else-if="row.anchor === 'coords'"
                  title="Coordonnées : dernier recours, fragile si l'écran change"
                  class="text-[8.5px] px-1 rounded bg-amber-100 text-amber-700 shrink-0"
                  >x,y</span
                >
                <button
                  title="Retirer cette ligne"
                  class="w-4 h-4 mr-0.5 rounded text-slate-300 hover:text-red-500 items-center justify-center hidden group-hover:flex shrink-0"
                  @click="sd.autoDeleteLine(row.line)"
                >
                  <i class="ph ph-x text-[10px]"></i>
                </button>
              </div>
            </div>
          </div>
          <div
            v-else
            class="w-6 shrink-0 border-r border-slate-200 bg-slate-50/60 flex flex-col items-center pt-1"
          >
            <button
              title="Mes scripts et plan"
              class="w-5 h-5 rounded hover:bg-slate-200 text-slate-400 flex items-center justify-center"
              @click="sd.autoListOpen = true"
            >
              <i class="ph ph-caret-right text-xs"></i>
            </button>
          </div>

          <!-- Zone principale : barre · palette · éditeur · aide IA -->
          <div class="flex-1 flex flex-col min-h-0 min-w-0">
            <div class="shrink-0 px-2 py-1.5 border-b border-slate-200 flex items-center gap-1.5">
              <button
                :title="
                  sd.autoRecording
                    ? 'Arrêter l\'enregistrement'
                    : 'Enregistrer : chaque action s\'écrit dans le code, au curseur'
                "
                class="h-7 px-2 rounded-md text-[11px] font-medium flex items-center gap-1.5 transition-colors shrink-0"
                :class="
                  sd.autoRecording
                    ? 'bg-red-600 text-white hover:bg-red-700'
                    : 'border border-slate-200 text-slate-600 hover:bg-slate-50'
                "
                @click="sd.toggleAutoRecording()"
              >
                <span
                  class="w-2 h-2 rounded-full"
                  :class="sd.autoRecording ? 'bg-white animate-pulse' : 'bg-red-500'"
                ></span>
                {{ sd.autoRecording ? "REC" : "Enregistrer" }}
              </button>
              <input
                v-model="sd.autoName"
                type="text"
                placeholder="Nom du script"
                class="flex-1 min-w-0 h-7 text-[11px] px-2 rounded-md border border-slate-200 outline-none focus:ring-1 focus:ring-blue-500"
              />
              <span
                v-if="sd.autoDirty"
                class="text-[10px] text-slate-400 shrink-0"
                title="Modifications non enregistrées"
                >·</span
              >
              <span
                v-if="sd.autoIgnored"
                class="text-[10px] text-amber-600 shrink-0"
                :title="sd.autoIgnored + ' action(s) en échec technique, non écrite(s)'"
                >{{ sd.autoIgnored }} ✗</span
              >
              <span
                v-if="sd.autoNeedsVision"
                class="text-[10px] text-amber-600 shrink-0"
                title="Le script lit du texte à l'écran : il exige Elpis (ELPIS_URL) sur la VM"
                >vision</span
              >
              <button
                :disabled="sd.autoSaving"
                title="Enregistrer dans la sandbox (automations/<nom>.py)"
                class="h-7 px-2 rounded-md text-[11px] font-medium bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 flex items-center gap-1 shrink-0"
                @click="sd.autoSave()"
              >
                <i class="ph" :class="sd.autoSaving ? 'ph-spinner animate-spin' : 'ph-floppy-disk'"></i>
                Enregistrer
              </button>
              <div class="relative shrink-0">
                <div class="flex items-stretch h-7 rounded-md overflow-hidden border border-emerald-300">
                  <button
                    :disabled="!sd.selectedTarget || !!sd.autoRun?.running"
                    title="Exécuter le script sur la machine cible (agent dans la session interactive)"
                    class="px-2 text-[11px] font-medium bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50 flex items-center gap-1"
                    @click="sd.autoRunStart('run')"
                  >
                    <i class="ph" :class="!!sd.autoRun?.running ? 'ph-spinner animate-spin' : 'ph-play'"></i>
                    Exécuter
                  </button>
                  <button
                    :disabled="!sd.selectedTarget"
                    title="Autres modes : vol à blanc, trace, plusieurs machines"
                    class="px-1 border-l border-emerald-300 bg-emerald-50 text-emerald-700 hover:bg-emerald-100 disabled:opacity-50 flex items-center"
                    @click="sd.autoRunMenuOpen = !sd.autoRunMenuOpen"
                  >
                    <i class="ph ph-caret-down text-[10px]"></i>
                  </button>
                </div>
                <template v-if="sd.autoRunMenuOpen">
                  <div class="fixed inset-0 z-[54]" @click="sd.autoRunMenuOpen = false"></div>
                  <!-- Ancré à DROITE (le rail est le bord de la page : left-0 + w-72 débordait). -->
                  <div
                    class="absolute right-0 top-8 z-[55] w-72 max-h-[70vh] overflow-y-auto custom-scrollbar bg-white rounded-lg shadow-xl border border-slate-200 py-1 text-[11px] elpis-run-menu"
                  >
                    <button
                      :disabled="!!sd.autoRun?.running"
                      class="disabled:opacity-50 w-full text-left px-3 py-1.5 hover:bg-slate-50"
                      @click="sd.autoRunStart('dry')"
                    >
                      <div class="font-medium text-slate-800">Vol à blanc</div>
                      <div class="text-[10.5px] text-slate-500">
                        Résout chaque cible sur la machine, n'envoie aucune entrée.
                      </div>
                    </button>
                    <button
                      :disabled="!!sd.autoRun?.running"
                      class="disabled:opacity-50 w-full text-left px-3 py-1.5 hover:bg-slate-50 border-t border-slate-100"
                      @click="sd.autoRunStart('trace')"
                    >
                      <div class="font-medium text-slate-800">Exécuter avec trace</div>
                      <div class="text-[10.5px] text-slate-500">
                        Capture + arbre à chaque étape, visualiseur dans le rapport.
                      </div>
                    </button>
                    <div class="border-t border-slate-100 px-3 pt-1.5 pb-1">
                      <div class="font-medium text-slate-800 mb-1">Sur plusieurs machines</div>
                      <label
                        v-for="t in sd.studioTargets"
                        :key="t.name"
                        class="flex items-center gap-1.5 py-0.5 cursor-pointer"
                      >
                        <input
                          type="checkbox"
                          :checked="!!sd.autoRunTargets[t.name]"
                          class="rounded border-slate-300"
                          @change="sd.autoRunToggleTargets(t.name)"
                        />
                        <span class="truncate">{{ t.name }}</span
                        ><span class="text-[10px] text-slate-400">{{ t.os || "" }}</span>
                      </label>
                      <button
                        :disabled="!!sd.autoRun?.running"
                        class="disabled:opacity-50 mt-1 w-full h-6 rounded border border-emerald-300 text-emerald-700 hover:bg-emerald-50 text-[11px]"
                        @click="sd.autoRunMatrix()"
                      >
                        Lancer la matrice
                      </button>
                    </div>
                  </div>
                </template>
              </div>
              <div class="relative shrink-0">
                <button
                  title="Télécharger le script : seul (.py) ou avec le runtime (.zip)"
                  class="h-7 w-7 rounded-md border flex items-center justify-center"
                  :class="
                    sd.autoDlOpen
                      ? 'border-blue-300 bg-blue-50 text-blue-700'
                      : 'border-slate-200 text-slate-600 hover:bg-slate-50'
                  "
                  @click="sd.toggleAutoDl()"
                >
                  <i class="ph" :class="sd.autoDlBusy ? 'ph-spinner animate-spin' : 'ph-download-simple'"></i>
                </button>
                <template v-if="sd.autoDlOpen">
                  <div class="fixed inset-0 z-[54]" @click="sd.autoDlOpen = false"></div>
                  <div
                    class="absolute right-0 top-8 z-[55] w-72 bg-white rounded-lg shadow-xl border border-slate-200 py-1 text-[11px]"
                  >
                    <button class="w-full text-left px-3 py-2 hover:bg-slate-50" @click="sd.autoDownload()">
                      <div class="font-medium text-slate-800 flex items-center gap-1.5">
                        <i class="ph ph-file-py text-slate-400"></i> Script seul (.py)
                      </div>
                      <div class="text-[10.5px] text-slate-500 mt-0.5">
                        Le runtime est déjà sur la machine (agent Elpis installé) : rien à retélécharger.
                      </div>
                    </button>
                    <button
                      class="w-full text-left px-3 py-2 hover:bg-slate-50 border-t border-slate-100"
                      @click="sd.autoDownloadBundle(false)"
                    >
                      <div class="font-medium text-slate-800 flex items-center gap-1.5">
                        <i class="ph ph-package text-slate-400"></i> Script + runtime (.zip)
                      </div>
                      <div class="text-[10.5px] text-slate-500 mt-0.5">
                        elpis_auto, backends, requirements.txt, lanceurs run.bat / run.sh (venv local,
                        dépendances par pip). Pour un projet à part ou une machine sans l'agent.
                      </div>
                    </button>
                    <button
                      class="w-full text-left px-3 py-2 hover:bg-slate-50 border-t border-slate-100"
                      @click="sd.autoDownloadBundle(true)"
                    >
                      <div class="font-medium text-slate-800 flex items-center gap-1.5">
                        <i class="ph ph-package text-slate-400"></i> Script + runtime + wheels hors ligne
                        (.zip, ~18 Mo)
                      </div>
                      <div class="text-[10.5px] text-slate-500 mt-0.5">
                        Idem, plus les dépendances Python (wheels cp311) pour une machine sans internet :
                        Python 3.11 ou python-win de l'agent.
                      </div>
                    </button>
                  </div>
                </template>
              </div>
              <button
                title="Copier le code"
                class="h-7 w-7 rounded-md border border-slate-200 text-slate-600 hover:bg-slate-50 flex items-center justify-center shrink-0"
                @click="sd.autoCopyCode()"
              >
                <i class="ph ph-copy"></i>
              </button>
              <button
                title="Aide-mémoire de l'API elpis_auto"
                class="h-7 w-7 rounded-md border flex items-center justify-center shrink-0"
                :class="
                  sd.autoHelpOpen
                    ? 'border-blue-300 bg-blue-50 text-blue-700'
                    : 'border-slate-200 text-slate-600 hover:bg-slate-50'
                "
                @click="sd.autoHelpOpen = !sd.autoHelpOpen"
              >
                <i class="ph ph-question"></i>
              </button>
            </div>

            <!-- Palette : insérer au curseur -->
            <div
              class="shrink-0 px-2 py-1 border-b border-slate-100 flex items-center gap-1 flex-wrap text-[10.5px]"
            >
              <span class="text-slate-400 mr-0.5">Insérer</span>
              <button
                title="Si l'élément sélectionné est présent…"
                class="h-6 px-1.5 rounded border border-slate-200 text-slate-600 hover:bg-slate-50 flex items-center gap-1"
                @click="sd.autoInsertIf('exists')"
              >
                <i class="ph ph-git-branch"></i> Si présent
              </button>
              <button
                title="Si l'élément sélectionné est absent…"
                class="h-6 px-1.5 rounded border border-slate-200 text-slate-600 hover:bg-slate-50"
                @click="sd.autoInsertIf('missing')"
              >
                Si absent
              </button>
              <button
                title="Sinon"
                class="h-6 px-1.5 rounded border border-slate-200 text-slate-600 hover:bg-slate-50"
                @click="sd.autoInsertElse()"
              >
                Sinon
              </button>
              <button
                title="Répéter N fois"
                class="h-6 px-1.5 rounded border border-slate-200 text-slate-600 hover:bg-slate-50 flex items-center gap-1"
                @click="sd.autoInsertLoop()"
              >
                <i class="ph ph-repeat"></i> Répéter
              </button>
              <span class="w-px h-4 bg-slate-200 mx-0.5"></span>
              <button
                title="Attendre l'élément sélectionné (ou l'écran stable)"
                class="h-6 px-1.5 rounded border border-slate-200 text-slate-600 hover:bg-slate-50 flex items-center gap-1"
                @click="sd.autoInsertWait()"
              >
                <i class="ph ph-hourglass"></i> Attendre
              </button>
              <button
                title="Vérifier l'élément sélectionné (échec du script si faux)"
                class="h-6 px-1.5 rounded border border-slate-200 text-slate-600 hover:bg-slate-50 flex items-center gap-1"
                @click="sd.autoInsertCheck()"
              >
                <i class="ph ph-check-square"></i> Vérifier
              </button>
              <!-- Délai par défaut = la variable TIMEOUT en tête du script (lue et réécrite dans le code) : tout ce qui attend écrit timeout=TIMEOUT. -->
              <label
                class="h-6 flex items-center gap-1 text-slate-500"
                title="Délai par défaut (s) : la variable TIMEOUT en tête du script, utilisée par tout ce qui attend (timeout=TIMEOUT). Délai sans activité à l'écran : tant que ça bouge, le script attend. Pour une seule étape, remplacer timeout=TIMEOUT par une valeur (timeout=120)."
                >Délai
                <input
                  type="number"
                  min="1"
                  max="3600"
                  step="1"
                  :value="sd.autoWaitSec"
                  class="h-6 w-12 px-1 rounded border border-slate-200 bg-white text-slate-700 text-center outline-none focus:ring-1 focus:ring-blue-500"
                  @change="sd.autoSetWaitSec(($event.target as HTMLInputElement).value)"
                />
                s
              </label>
              <button
                :title="
                  'Pause fixe de ' +
                  sd.autoWaitSec +
                  ' s (s.wait.seconds) — préférer Attendre, qui rend la main dès que c\'est prêt'
                "
                class="h-6 px-1.5 rounded border border-slate-200 text-slate-600 hover:bg-slate-50 flex items-center gap-1"
                @click="sd.autoInsertPause()"
              >
                <i class="ph ph-timer"></i> Pause
              </button>
              <button
                title="Mettre une fenêtre au premier plan"
                class="h-6 px-1.5 rounded border border-slate-200 text-slate-600 hover:bg-slate-50 flex items-center gap-1"
                @click="sd.autoInsertFocus()"
              >
                <i class="ph ph-app-window"></i> Fenêtre
              </button>
              <button
                title="Lire la valeur de l'élément sélectionné dans une variable"
                class="h-6 px-1.5 rounded border border-slate-200 text-slate-600 hover:bg-slate-50 flex items-center gap-1"
                @click="sd.autoInsertVar()"
              >
                <i class="ph ph-brackets-curly"></i> Variable
              </button>
              <button
                title="Note dans le script"
                class="h-6 px-1.5 rounded border border-slate-200 text-slate-600 hover:bg-slate-50 flex items-center gap-1"
                @click="sd.autoInsertNote()"
              >
                <i class="ph ph-note"></i> Note
              </button>
              <span class="ml-auto">
                <button
                  :title="
                    sd.autoClearArmed
                      ? 'Cliquer encore pour repartir d\'un script vide'
                      : 'Repartir d\'un script vide'
                  "
                  class="h-6 px-1.5 rounded flex items-center gap-1"
                  :class="
                    sd.autoClearArmed
                      ? 'bg-red-600 text-white'
                      : 'text-slate-400 hover:text-red-600 hover:bg-red-50'
                  "
                  @click="sd.autoClearCode()"
                >
                  <i class="ph ph-broom"></i><span v-if="sd.autoClearArmed">Confirmer</span>
                </button>
              </span>
            </div>

            <!-- Aide-mémoire de l'API -->
            <div
              v-if="sd.autoHelpOpen"
              class="shrink-0 max-h-40 overflow-y-auto custom-scrollbar border-b border-slate-200 bg-slate-50 px-3 py-2"
            >
              <pre class="text-[10px] leading-4 text-slate-600 whitespace-pre-wrap font-mono">{{
                sd.API_HELP
              }}</pre>
            </div>

            <!-- Éditeur : Monaco monté dans ce conteneur ; le textarea reste tant qu'il n'est pas prêt -->
            <div class="flex-1 min-h-0 relative bg-slate-900">
              <div
                v-if="sd.studioTab === 'script'"
                class="absolute inset-0"
                @vue:mounted="sd.autoMountEditor($event.el)"
                @vue:unmounted="sd.autoUnmountEditor()"
              ></div>
              <textarea
                v-if="!sd.autoEditorReady"
                :value="sd.autoCode"
                spellcheck="false"
                aria-label="Code du script"
                class="auto-code absolute inset-0 w-full h-full resize-none bg-slate-900 text-slate-100 font-mono text-[11.5px] leading-5 p-3 outline-none custom-scrollbar"
                @input="sd.autoOnTextarea($event)"
                @click="sd.autoOnTextarea($event)"
                @keyup="sd.autoOnTextarea($event)"
              ></textarea>
            </div>

            <!-- Aide IA : une demande en français → des lignes au curseur -->
            <!-- Exécution sur la VM : état, étapes du rapport, réparations, capture d'échec -->
            <div
              v-if="sd.autoRun"
              class="shrink-0 border-t border-slate-200 bg-slate-50/70 elpis-run-panel"
              :class="sd.autoRunOpen ? 'max-h-64' : ''"
            >
              <div class="px-2 py-1 flex items-center gap-2 text-[11px]">
                <i
                  class="ph shrink-0"
                  :class="
                    sd.autoRun.running
                      ? 'ph-spinner animate-spin text-blue-600'
                      : sd.autoRun.error
                        ? 'ph-warning text-red-600'
                        : sd.autoRun.code === 0
                          ? 'ph-check-circle text-emerald-600'
                          : 'ph-x-circle text-red-600'
                  "
                ></i>
                <span class="font-medium text-slate-800 truncate">{{
                  sd.autoRun.running
                    ? (sd.autoRun.mode === "matrix"
                        ? sd.autoRun.summary
                        : "En cours sur " + sd.autoRun.target + "…") +
                      (sd.autoRun.warning ? " — " + sd.autoRun.warning : "")
                    : sd.autoRun.error ||
                      (sd.autoRun.report && sd.autoRun.report.summary) ||
                      sd.autoRun.summary ||
                      "Terminé (code " + sd.autoRun.code + ")"
                }}</span>
                <span
                  v-if="sd.autoRun.mode === 'dry'"
                  class="text-[9px] px-1 rounded bg-blue-100 text-blue-700 shrink-0"
                  >vol à blanc</span
                >
                <span
                  v-if="sd.autoRun.mode === 'trace'"
                  class="text-[9px] px-1 rounded bg-violet-100 text-violet-700 shrink-0"
                  >trace</span
                >
                <span
                  v-if="sd.autoRun.report && sd.autoRun.report.healed && sd.autoRun.report.healed.length"
                  class="text-[9px] px-1 rounded bg-amber-100 text-amber-700 shrink-0"
                  >{{ sd.autoRun.report.healed.length }} réparation(s)</span
                >
                <button
                  v-if="sd.autoRun.running && sd.autoRun.run_id"
                  class="ml-auto text-[10px] px-1.5 rounded border border-slate-200 text-slate-600 hover:bg-white shrink-0"
                  @click="sd.autoRunStop()"
                >
                  Stop
                </button>
                <button
                  :class="sd.autoRun.running && sd.autoRun.run_id ? '' : 'ml-auto'"
                  class="text-[10px] px-1.5 rounded text-slate-500 hover:bg-white shrink-0"
                  @click="sd.autoRunOpen = !sd.autoRunOpen"
                >
                  <i class="ph" :class="sd.autoRunOpen ? 'ph-caret-down' : 'ph-caret-up'"></i>
                </button>
                <button
                  title="Fermer"
                  class="text-slate-400 hover:text-slate-700 shrink-0"
                  @click="sd.autoRunClose()"
                >
                  <i class="ph ph-x"></i>
                </button>
              </div>
              <div
                v-if="sd.autoRunOpen"
                class="max-h-52 overflow-y-auto custom-scrollbar border-t border-slate-100 bg-white"
              >
                <template v-if="sd.autoRun.matrix">
                  <div
                    v-for="r in sd.autoRun.matrix.results"
                    :key="r.target"
                    class="px-2 py-1 text-[10.5px] flex items-center gap-2 border-b border-slate-50"
                  >
                    <i
                      class="ph shrink-0"
                      :class="r.ok ? 'ph-check text-emerald-600' : 'ph-x text-red-600'"
                    ></i>
                    <span class="font-medium text-slate-700 shrink-0">{{ r.target }}</span>
                    <span class="text-slate-500 truncate">{{ r.summary || r.message || r.error || "" }}</span>
                    <span v-if="r.duration_s" class="ml-auto text-slate-400 shrink-0"
                      >{{ r.duration_s }} s</span
                    >
                  </div>
                </template>
                <template v-else>
                  <div
                    v-for="st in sd.autoRunSteps"
                    :key="st.index"
                    class="px-2 py-1 text-[10.5px] flex items-center gap-2 border-b border-slate-50"
                    :class="st.ok ? '' : 'bg-red-50'"
                  >
                    <i
                      class="ph shrink-0"
                      :class="st.ok ? 'ph-check text-emerald-600' : 'ph-x text-red-600'"
                    ></i>
                    <button
                      v-if="st.line"
                      :title="'Ligne ' + st.line"
                      class="font-mono text-slate-400 shrink-0 hover:text-blue-700"
                      @click="sd.autoGotoLine(st.line - 1)"
                    >
                      l.{{ st.line }}
                    </button>
                    <span class="text-slate-700 truncate">{{ st.label }}</span>
                    <span
                      v-if="st.method"
                      class="text-[9px] px-1 rounded bg-slate-100 text-slate-500 shrink-0"
                      >{{ st.method }}{{ st.resolved_by ? " · " + st.resolved_by : "" }}</span
                    >
                    <span v-if="st.waited_ms" class="text-[9px] text-amber-600 shrink-0"
                      >attendu {{ st.waited_ms }} ms</span
                    >
                    <span class="text-slate-400 shrink-0">{{ st.ms }} ms</span>
                    <button
                      v-if="st.healed && st.healed.suggest"
                      :title="'Réparé par ' + st.healed.by + ' → ' + st.healed.suggest"
                      class="text-[9px] px-1.5 rounded border border-amber-300 bg-amber-50 text-amber-800 hover:bg-amber-100 shrink-0"
                      @click="sd.autoApplyHeal(st)"
                    >
                      Appliquer {{ st.healed.suggest }}
                    </button>
                    <a
                      v-if="st.screenshot"
                      :href="sd.autoRunFileUrl(st.screenshot)"
                      target="_blank"
                      title="Capture de l'échec"
                      class="text-[9px] px-1 rounded border border-slate-200 text-slate-600 hover:bg-slate-50 shrink-0"
                      ><i class="ph ph-image"></i> capture</a
                    >
                    <a
                      v-if="st.trace_png"
                      :href="sd.autoRunFileUrl(st.trace_png)"
                      target="_blank"
                      title="Capture de l'étape (trace)"
                      class="text-[9px] px-1 rounded border border-slate-200 text-slate-600 hover:bg-slate-50 shrink-0"
                      ><i class="ph ph-image"></i
                    ></a>
                    <button
                      v-if="!st.ok && !st.dry"
                      :disabled="sd.autoRepairBusy"
                      title="Demander au modèle une ligne de remplacement (étape, erreur, arbre, éléments)"
                      class="text-[9px] px-1.5 rounded border border-blue-200 text-blue-700 hover:bg-blue-50 disabled:opacity-50 shrink-0 flex items-center gap-1"
                      @click="sd.autoRepairWithAi(st)"
                    >
                      <i class="ph" :class="sd.autoRepairBusy ? 'ph-spinner animate-spin' : 'ph-sparkle'"></i>
                      Réparer
                    </button>
                    <span v-if="st.error" class="text-red-600 truncate max-w-[40%]" :title="st.error">{{
                      st.error
                    }}</span>
                  </div>
                  <div
                    v-if="!sd.autoRunSteps.length && sd.autoRun.log && sd.autoRun.log.length"
                    class="px-2 py-1 font-mono text-[9.5px] text-slate-500 whitespace-pre-wrap"
                  >
                    {{ sd.autoRun.log.slice(-12).join("\n") }}
                  </div>
                  <div
                    v-if="
                      !sd.autoRunSteps.length &&
                      !(sd.autoRun.log && sd.autoRun.log.length) &&
                      !sd.autoRun.running
                    "
                    class="px-2 py-2 text-[10.5px] text-slate-400"
                  >
                    Aucune étape rapportée.
                  </div>
                </template>
              </div>
            </div>
            <div class="shrink-0 border-t border-slate-200 px-2 py-1.5 flex items-center gap-1.5 bg-white">
              <i class="ph ph-sparkle text-blue-500 shrink-0"></i>
              <input
                v-model="sd.autoAiPrompt"
                type="text"
                :disabled="sd.autoAiBusy"
                placeholder="Demander à l'IA : « clique sur Enregistrer puis attends la fenêtre Confirmation »"
                class="flex-1 min-w-0 h-7 text-[11px] px-2 rounded-md border border-slate-200 outline-none focus:ring-1 focus:ring-blue-500 disabled:opacity-60"
                @keydown.enter.prevent="sd.autoAiAsk()"
              />
              <button
                v-if="!sd.autoAiBusy"
                :disabled="!sd.autoAiPrompt.trim()"
                title="Insérer les lignes proposées au curseur"
                class="h-7 px-2 rounded-md text-[11px] font-medium border border-blue-200 text-blue-700 hover:bg-blue-50 disabled:opacity-50 shrink-0"
                @click="sd.autoAiAsk()"
              >
                Insérer
              </button>
              <button
                v-else
                title="Arrêter"
                class="h-7 px-2 rounded-md text-[11px] border border-slate-200 text-slate-600 flex items-center gap-1 shrink-0"
                @click="sd.autoAiStop()"
              >
                <i class="ph ph-spinner animate-spin"></i> Stop
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Menu contextuel (clic droit sur le stage) → action sur élément/point/zone -->
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
        <div class="px-3 py-1 text-[11px] text-slate-400 border-b border-slate-100 mb-1 truncate">
          {{
            sd.studioCtxMenu.el
              ? "« " +
                sd.elementDisplay(sd.studioCtxMenu.el) +
                " »" +
                (sd.studioCtxMenu.el.role ? " · " + sd.studioCtxMenu.el.role : "")
              : "point " + sd.studioCtxMenu.point?.join(", ")
          }}
        </div>

        <!-- Script (onglet Script ouvert) : blocs et lignes ÉCRITS au curseur, ciblés sur l'élément cliqué, sans rien -->
        <div v-if="sd.studioTab === 'script'" class="relative" @mouseenter="sd.studioCtxSub = 'script'">
          <button
            class="w-full text-left px-3 py-1.5 hover:bg-blue-50 text-blue-700 flex items-center gap-2"
            :class="sd.studioCtxSub === 'script' ? 'bg-blue-50' : ''"
            @click="sd.studioCtxSub = sd.studioCtxSub === 'script' ? '' : 'script'"
          >
            <i class="ph ph-code"></i> Script <i class="ph ph-caret-right text-blue-300 ml-auto text-xs"></i>
          </button>
          <div
            v-if="sd.studioCtxSub === 'script'"
            class="absolute min-w-[230px] max-h-[70vh] overflow-y-auto custom-scrollbar bg-white rounded-lg shadow-xl border border-slate-200 py-1 z-[62]"
            :class="sd.ctxSubPos()"
          >
            <div class="px-3 pt-0.5 pb-1 text-[10px] text-slate-400 truncate">
              S'insère au curseur{{
                sd.studioCtxMenu.el ? " — cible : " + sd.elementDisplay(sd.studioCtxMenu.el) : ""
              }}
            </div>
            <template v-if="sd.studioCtxMenu.el">
              <button
                class="w-full text-left px-3 py-1.5 hover:bg-slate-50 flex items-center gap-2"
                @click="sd.ctxScript('if')"
              >
                <i class="ph ph-git-branch text-slate-400"></i> Si présent…
              </button>
              <button
                class="w-full text-left px-3 py-1.5 hover:bg-slate-50 flex items-center gap-2"
                @click="sd.ctxScript('if_missing')"
              >
                <i class="ph ph-git-branch text-slate-400"></i> Si absent…
              </button>
            </template>
            <button
              class="w-full text-left px-3 py-1.5 hover:bg-slate-50 flex items-center gap-2"
              @click="sd.ctxScript('else')"
            >
              <i class="ph ph-arrow-elbow-down-right text-slate-400"></i> Sinon
            </button>
            <button
              class="w-full text-left px-3 py-1.5 hover:bg-slate-50 flex items-center gap-2"
              @click="sd.ctxScript('loop')"
            >
              <i class="ph ph-repeat text-slate-400"></i> Répéter
            </button>
            <div class="my-1 border-t border-slate-100"></div>
            <button
              class="w-full text-left px-3 py-1.5 hover:bg-slate-50 flex items-center gap-2"
              @click="sd.ctxScript('wait')"
            >
              <i class="ph ph-hourglass text-slate-400"></i>
              {{ sd.studioCtxMenu.el ? "Attendre l'élément" : "Attendre l'écran stable" }}
              <span class="ml-auto text-[10px] text-slate-400" title="Délai (champ « Délai » de la palette)"
                >{{ sd.autoWaitSec }} s</span
              >
            </button>
            <button
              class="w-full text-left px-3 py-1.5 hover:bg-slate-50 flex items-center gap-2"
              @click="sd.ctxScript('pause')"
            >
              <i class="ph ph-timer text-slate-400"></i> Pause
              <span class="ml-auto text-[10px] text-slate-400">{{ sd.autoWaitSec }} s</span>
            </button>
            <template v-if="sd.studioCtxMenu.el">
              <button
                class="w-full text-left px-3 py-1.5 hover:bg-slate-50 flex items-center gap-2"
                @click="sd.ctxScript('wait_gone')"
              >
                <i class="ph ph-hourglass-low text-slate-400"></i> Attendre sa disparition
                <span class="ml-auto text-[10px] text-slate-400">{{ sd.autoWaitSec }} s</span>
              </button>
              <button
                class="w-full text-left px-3 py-1.5 hover:bg-slate-50 flex items-center gap-2"
                @click="sd.ctxScript('check')"
              >
                <i class="ph ph-check-square text-slate-400"></i> Vérifier présent
              </button>
              <button
                class="w-full text-left px-3 py-1.5 hover:bg-slate-50 flex items-center gap-2"
                @click="sd.ctxScript('check_gone')"
              >
                <i class="ph ph-x-square text-slate-400"></i> Vérifier absent
              </button>
              <button
                class="w-full text-left px-3 py-1.5 hover:bg-slate-50 flex items-center gap-2"
                @click="sd.ctxScript('var')"
              >
                <i class="ph ph-brackets-curly text-slate-400"></i> Lire sa valeur (variable)
              </button>
            </template>
            <div class="my-1 border-t border-slate-100"></div>
            <button
              class="w-full text-left px-3 py-1.5 hover:bg-slate-50 flex items-center gap-2"
              @click="sd.ctxScript('click')"
            >
              <i class="ph ph-cursor-click text-slate-400"></i> Écrire le clic (sans l'exécuter)
            </button>
            <button
              class="w-full text-left px-3 py-1.5 hover:bg-slate-50 flex items-center gap-2"
              @click="sd.ctxScript('double_click')"
            >
              <i class="ph ph-cursor-click text-slate-400"></i> Écrire un double-clic
            </button>
            <button
              class="w-full text-left px-3 py-1.5 hover:bg-slate-50 flex items-center gap-2"
              @click="sd.ctxScript('right_click')"
            >
              <i class="ph ph-cursor text-slate-400"></i> Écrire un clic droit
            </button>
            <button
              class="w-full text-left px-3 py-1.5 hover:bg-slate-50 flex items-center gap-2"
              @click="sd.ctxScript('set_value')"
            >
              <i class="ph ph-text-t text-slate-400"></i> Écrire une saisie…
            </button>
            <div class="my-1 border-t border-slate-100"></div>
            <button
              class="w-full text-left px-3 py-1.5 hover:bg-slate-50 flex items-center gap-2"
              @click="sd.ctxScript('focus')"
            >
              <i class="ph ph-app-window text-slate-400"></i> Fenêtre au premier plan…
            </button>
            <button
              class="w-full text-left px-3 py-1.5 hover:bg-slate-50 flex items-center gap-2"
              @click="sd.ctxScript('note')"
            >
              <i class="ph ph-note-pencil text-slate-400"></i> Note…
            </button>
          </div>
        </div>

        <!-- Clics -->
        <div class="relative" @mouseenter="sd.studioCtxSub = 'clics'">
          <button
            class="w-full text-left px-3 py-1.5 hover:bg-slate-50 flex items-center gap-2"
            :class="sd.studioCtxSub === 'clics' ? 'bg-slate-50' : ''"
            @click="sd.studioCtxSub = sd.studioCtxSub === 'clics' ? '' : 'clics'"
          >
            <i class="ph ph-cursor-click text-slate-400"></i> Clics
            <i class="ph ph-caret-right text-slate-300 ml-auto text-xs"></i>
          </button>
          <div
            v-if="sd.studioCtxSub === 'clics'"
            class="absolute min-w-[190px] bg-white rounded-lg shadow-xl border border-slate-200 py-1 z-[62]"
            :class="sd.ctxSubPos()"
          >
            <button
              class="w-full text-left px-3 py-1.5 hover:bg-slate-50 flex items-center gap-2"
              @click="sd.ctxAct('click')"
            >
              <i class="ph ph-cursor-click text-slate-400"></i> Cliquer
            </button>
            <button
              class="w-full text-left px-3 py-1.5 hover:bg-slate-50 flex items-center gap-2"
              @click="sd.ctxAct('double_click')"
            >
              <i class="ph ph-cursor-click text-slate-400"></i> Double-cliquer
            </button>
            <button
              class="w-full text-left px-3 py-1.5 hover:bg-slate-50 flex items-center gap-2"
              @click="sd.ctxAct('triple_click')"
            >
              <i class="ph ph-cursor-click text-slate-400"></i> Triple-cliquer
            </button>
            <button
              class="w-full text-left px-3 py-1.5 hover:bg-slate-50 flex items-center gap-2"
              @click="sd.ctxAct('right_click')"
            >
              <i class="ph ph-cursor text-slate-400"></i> Clic droit
            </button>
            <button
              class="w-full text-left px-3 py-1.5 hover:bg-slate-50 flex items-center gap-2"
              @click="sd.ctxAct('middle_click')"
            >
              <i class="ph ph-mouse text-slate-400"></i> Clic milieu
            </button>
          </div>
        </div>

        <!-- Contrôle (sémantique UIA) — uniquement sur un ÉLÉMENT -->
        <div v-if="sd.studioCtxMenu.el" class="relative" @mouseenter="sd.studioCtxSub = 'ctrl'">
          <button
            class="w-full text-left px-3 py-1.5 hover:bg-slate-50 flex items-center gap-2"
            :class="sd.studioCtxSub === 'ctrl' ? 'bg-slate-50' : ''"
            @click="sd.studioCtxSub = sd.studioCtxSub === 'ctrl' ? '' : 'ctrl'"
          >
            <i class="ph ph-sliders text-slate-400"></i> Contrôle (fiable)
            <i class="ph ph-caret-right text-slate-300 ml-auto text-xs"></i>
          </button>
          <div
            v-if="sd.studioCtxSub === 'ctrl'"
            class="absolute min-w-[210px] max-h-[70vh] overflow-y-auto custom-scrollbar bg-white rounded-lg shadow-xl border border-slate-200 py-1 z-[62]"
            :class="sd.ctxSubPos()"
          >
            <button
              class="w-full text-left px-3 py-1.5 hover:bg-slate-50 flex items-center gap-2"
              @click="sd.ctxSemantic('toggle')"
            >
              <i class="ph ph-toggle-left text-slate-400"></i> Basculer (case/bouton)
            </button>
            <button
              class="w-full text-left px-3 py-1.5 hover:bg-slate-50 flex items-center gap-2"
              @click="sd.ctxSemantic('check')"
            >
              <i class="ph ph-check-square text-slate-400"></i> Cocher
            </button>
            <button
              class="w-full text-left px-3 py-1.5 hover:bg-slate-50 flex items-center gap-2"
              @click="sd.ctxSemantic('uncheck')"
            >
              <i class="ph ph-square text-slate-400"></i> Décocher
            </button>
            <button
              class="w-full text-left px-3 py-1.5 hover:bg-slate-50 flex items-center gap-2"
              @click="sd.ctxSemantic('select')"
            >
              <i class="ph ph-list-checks text-slate-400"></i> Sélectionner (liste/onglet)
            </button>
            <button
              class="w-full text-left px-3 py-1.5 hover:bg-slate-50 flex items-center gap-2"
              @click="sd.ctxSemantic('expand')"
            >
              <i class="ph ph-caret-down text-slate-400"></i> Déplier
            </button>
            <button
              class="w-full text-left px-3 py-1.5 hover:bg-slate-50 flex items-center gap-2"
              @click="sd.ctxSemantic('collapse')"
            >
              <i class="ph ph-caret-up text-slate-400"></i> Replier
            </button>
            <button
              class="w-full text-left px-3 py-1.5 hover:bg-slate-50 flex items-center gap-2"
              @click="sd.ctxSemantic('scroll_into_view')"
            >
              <i class="ph ph-arrows-in text-slate-400"></i> Amener dans la vue
            </button>
            <button
              class="w-full text-left px-3 py-1.5 hover:bg-slate-50 flex items-center gap-2"
              @click="sd.ctxSetValue()"
            >
              <i class="ph ph-text-t text-slate-400"></i> Définir la valeur…
            </button>
          </div>
        </div>

        <!-- Saisie -->
        <div class="relative" @mouseenter="sd.studioCtxSub = 'saisie'">
          <button
            class="w-full text-left px-3 py-1.5 hover:bg-slate-50 flex items-center gap-2"
            :class="sd.studioCtxSub === 'saisie' ? 'bg-slate-50' : ''"
            @click="sd.studioCtxSub = sd.studioCtxSub === 'saisie' ? '' : 'saisie'"
          >
            <i class="ph ph-keyboard text-slate-400"></i> Saisie
            <i class="ph ph-caret-right text-slate-300 ml-auto text-xs"></i>
          </button>
          <div
            v-if="sd.studioCtxSub === 'saisie'"
            class="absolute min-w-[190px] bg-white rounded-lg shadow-xl border border-slate-200 py-1 z-[62]"
            :class="sd.ctxSubPos()"
          >
            <button
              class="w-full text-left px-3 py-1.5 hover:bg-slate-50 flex items-center gap-2"
              @click="sd.ctxType()"
            >
              <i class="ph ph-keyboard text-slate-400"></i> Taper…
            </button>
            <button
              class="w-full text-left px-3 py-1.5 hover:bg-slate-50 flex items-center gap-2"
              @click="sd.ctxPaste()"
            >
              <i class="ph ph-clipboard-text text-slate-400"></i> Coller…
            </button>
            <button
              class="w-full text-left px-3 py-1.5 hover:bg-slate-50 flex items-center gap-2"
              @click="sd.ctxCopy()"
            >
              <i class="ph ph-copy text-slate-400"></i> Copier
            </button>
          </div>
        </div>

        <!-- Touches / raccourcis (presets préconfigurés) -->
        <div class="relative" @mouseenter="sd.studioCtxSub = 'keys'">
          <button
            class="w-full text-left px-3 py-1.5 hover:bg-slate-50 flex items-center gap-2"
            :class="sd.studioCtxSub === 'keys' ? 'bg-slate-50' : ''"
            @click="sd.studioCtxSub = sd.studioCtxSub === 'keys' ? '' : 'keys'"
          >
            <i class="ph ph-command text-slate-400"></i> Touches
            <i class="ph ph-caret-right text-slate-300 ml-auto text-xs"></i>
          </button>
          <div
            v-if="sd.studioCtxSub === 'keys'"
            class="absolute min-w-[210px] max-h-[70vh] overflow-y-auto custom-scrollbar bg-white rounded-lg shadow-xl border border-slate-200 py-1 z-[62]"
            :class="sd.ctxSubPos()"
          >
            <button
              v-for="k in sd.KEY_PRESETS"
              :key="k.keys"
              class="w-full text-left px-3 py-1.5 hover:bg-slate-50 flex items-center gap-2"
              @click="sd.ctxKeyPreset(k.keys)"
            >
              <i class="ph ph-keyboard text-slate-300"></i> {{ k.label }}
            </button>
          </div>
        </div>

        <!-- Souris -->
        <div class="relative" @mouseenter="sd.studioCtxSub = 'souris'">
          <button
            class="w-full text-left px-3 py-1.5 hover:bg-slate-50 flex items-center gap-2"
            :class="sd.studioCtxSub === 'souris' ? 'bg-slate-50' : ''"
            @click="sd.studioCtxSub = sd.studioCtxSub === 'souris' ? '' : 'souris'"
          >
            <i class="ph ph-mouse text-slate-400"></i> Souris
            <i class="ph ph-caret-right text-slate-300 ml-auto text-xs"></i>
          </button>
          <div
            v-if="sd.studioCtxSub === 'souris'"
            class="absolute min-w-[190px] bg-white rounded-lg shadow-xl border border-slate-200 py-1 z-[62]"
            :class="sd.ctxSubPos()"
          >
            <button
              class="w-full text-left px-3 py-1.5 hover:bg-slate-50 flex items-center gap-2"
              @click="sd.ctxMove()"
            >
              <i class="ph ph-hand-pointing text-slate-400"></i> Survoler (déplacer)
            </button>
            <button
              class="w-full text-left px-3 py-1.5 hover:bg-slate-50 flex items-center gap-2"
              @click="sd.ctxDragFrom()"
            >
              <i class="ph ph-arrows-out-cardinal text-slate-400"></i> Glisser-déposer depuis ici…
            </button>
            <button
              class="w-full text-left px-3 py-1.5 hover:bg-slate-50 flex items-center gap-2"
              @click="sd.ctxScroll('up')"
            >
              <i class="ph ph-arrow-fat-up text-slate-400"></i> Défiler vers le haut
            </button>
            <button
              class="w-full text-left px-3 py-1.5 hover:bg-slate-50 flex items-center gap-2"
              @click="sd.ctxScroll('down')"
            >
              <i class="ph ph-arrow-fat-down text-slate-400"></i> Défiler vers le bas
            </button>
          </div>
        </div>

        <!-- Lecture -->
        <div class="relative" @mouseenter="sd.studioCtxSub = 'lecture'">
          <button
            class="w-full text-left px-3 py-1.5 hover:bg-slate-50 flex items-center gap-2"
            :class="sd.studioCtxSub === 'lecture' ? 'bg-slate-50' : ''"
            @click="sd.studioCtxSub = sd.studioCtxSub === 'lecture' ? '' : 'lecture'"
          >
            <i class="ph ph-text-aa text-slate-400"></i> Lecture
            <i class="ph ph-caret-right text-slate-300 ml-auto text-xs"></i>
          </button>
          <div
            v-if="sd.studioCtxSub === 'lecture'"
            class="absolute min-w-[190px] bg-white rounded-lg shadow-xl border border-slate-200 py-1 z-[62]"
            :class="sd.ctxSubPos()"
          >
            <button
              class="w-full text-left px-3 py-1.5 hover:bg-slate-50 flex items-center gap-2"
              @click="sd.ctxRead()"
            >
              <i class="ph ph-text-aa text-slate-400"></i> Lire (OCR) la zone
            </button>
            <button
              class="w-full text-left px-3 py-1.5 hover:bg-blue-50 text-blue-700 flex items-center gap-2"
              @click="sd.ctxAsk()"
            >
              <i class="ph ph-sparkle"></i> Demander au modèle…
            </button>
          </div>
        </div>
      </div>
    </template>

    <!-- Modale de saisie PROPRE (remplace window.prompt) : Taper / Coller / Valeur / Lancer -->
    <div
      v-if="sd.studioTextModal"
      class="fixed inset-0 z-[70] bg-black/40 flex items-center justify-center p-4"
      @click.self="sd.textModalCancel()"
      @keydown.escape="sd.textModalCancel()"
    >
      <div class="bg-white rounded-xl shadow-2xl border border-slate-200 w-[min(92vw,540px)] p-4">
        <div class="text-sm font-semibold text-slate-800 mb-2">{{ sd.studioTextModal.title }}</div>
        <textarea
          :ref="poserSaisieModale"
          v-model="sd.studioTextModal.value"
          :placeholder="sd.studioTextModal.placeholder"
          rows="5"
          class="w-full text-sm px-3 py-2 rounded-lg border border-slate-200 outline-none focus:ring-2 focus:ring-blue-500 font-mono resize-y"
          @keydown.ctrl.enter="sd.textModalOk()"
          @keydown.meta.enter="sd.textModalOk()"
        ></textarea>
        <div class="flex items-center justify-between mt-3">
          <span class="text-[10px] text-slate-400">Ctrl+Entrée pour valider · multi-ligne autorisé</span>
          <div class="flex items-center gap-2">
            <button
              class="text-sm px-3 py-1.5 rounded-md border border-slate-200 text-slate-600 hover:bg-slate-50"
              @click="sd.textModalCancel()"
            >
              Annuler
            </button>
            <button
              class="text-sm px-3 py-1.5 rounded-md bg-blue-600 text-white hover:bg-blue-700"
              @click="sd.textModalOk()"
            >
              Valider
            </button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
