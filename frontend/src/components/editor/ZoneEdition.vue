<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/editor/ZoneEdition.vue — zone d'édition : éditeur Monaco principal, diff, panneau droit (code, aperçu web, rendu Markdown/SVG), visionneuses (image, hex, Office), aperçu web plein. -->
<script setup lang="ts">
import GrilleOffice from "./GrilleOffice.vue";
import MenuCode from "./MenuCode.vue";
import { domaineEditeur } from "../../features/editor/domaine";

const ed = domaineEditeur();
</script>

<!-- eslint-disable vue/no-v-html -- rendu Markdown du moteur du chat (purifié) et SVG purifié par DOMPurify (renderSvgSafe). -->
<template>
  <div class="flex-1 relative min-h-0">
    <div v-show="ed.editorMode === 'code'" class="w-full h-full flex overflow-hidden">
      <div
        class="relative h-full min-w-0"
        :style="{ width: ed.splitView ? 'calc(' + ed.splitRatio + '% - 2px)' : '100%' }"
        :class="ed.splitView && ed.activePane === 'left' ? 'elpis-pane-focus' : ''"
        @mousedown="ed.splitView && (ed.activePane = 'left')"
      >
        <div
          v-show="!ed.activeTabPath"
          class="absolute inset-0 flex items-center justify-center text-slate-600 pointer-events-none select-none text-sm font-medium"
        >
          Sélectionnez un fichier
        </div>
        <div
          v-if="ed.isTypingEffect && ed.activeTabPath"
          class="absolute top-2 right-4 z-20 bg-blue-600 text-white text-[10px] font-bold px-2 py-1 rounded shadow animate-pulse"
        >
          ÉCRITURE...
        </div>
        <div
          id="monaco-editor"
          class="editor-layer"
          :class="{ active: !ed.isDiffView && !ed.mdPreview && !ed.svgPreview && !ed.activeIsViewer }"
        ></div>
        <div
          id="monaco-diff-editor"
          class="editor-layer"
          :class="{ active: ed.isDiffView && !ed.mdPreview && !ed.svgPreview && !ed.activeIsViewer }"
        ></div>

        <div
          v-if="ed.activeFileViewMode === 'image' && ed.imageViewerPath"
          data-image-viewer
          class="absolute inset-0 z-10 overflow-auto custom-scrollbar flex p-6"
          :class="ed.imageZoom === 'fit' ? 'items-center justify-center' : ''"
          style="
            background-image:
              linear-gradient(45deg, #2a2a2b 25%, transparent 25%),
              linear-gradient(-45deg, #2a2a2b 25%, transparent 25%),
              linear-gradient(45deg, transparent 75%, #2a2a2b 75%),
              linear-gradient(-45deg, transparent 75%, #2a2a2b 75%);
            background-size: 16px 16px;
            background-position:
              0 0,
              0 8px,
              8px -8px,
              -8px 0px;
            background-color: #1e1e1e;
          "
          @wheel="ed.onImageWheel"
        >
          <img
            :src="ed.imageViewerPath"
            :alt="ed.activeTabPath ?? undefined"
            class="max-w-full max-h-full shadow-2xl rounded m-auto"
            :style="ed.imageStyle"
            style="image-rendering: -webkit-optimize-contrast"
            @load="ed.onImageLoad"
          />
        </div>

        <div
          v-if="ed.activeFileViewMode === 'image' && ed.imageViewerPath"
          class="absolute bottom-3 right-3 z-20 flex items-center gap-0.5 rounded-lg bg-[#252526]/95 border border-white/10 shadow-lg px-1 py-0.5 text-[11px] text-slate-300"
        >
          <button
            class="w-6 h-6 rounded hover:bg-white/10 flex items-center justify-center"
            title="Dézoomer"
            aria-label="Dézoomer"
            @click="ed.imageZoomBy(1 / 1.25)"
          >
            <i class="ph ph-minus"></i>
          </button>
          <button
            class="min-w-[52px] h-6 px-1 rounded hover:bg-white/10 font-mono tabular-nums"
            title="Taille réelle (100 %)"
            @click="ed.imageZoomSet(1)"
          >
            {{ ed.imageZoomLabel }}
          </button>
          <button
            class="w-6 h-6 rounded hover:bg-white/10 flex items-center justify-center"
            title="Zoomer"
            aria-label="Zoomer"
            @click="ed.imageZoomBy(1.25)"
          >
            <i class="ph ph-plus"></i>
          </button>
          <button
            class="w-6 h-6 rounded hover:bg-white/10 flex items-center justify-center"
            :class="ed.imageZoom === 'fit' ? 'text-blue-300' : ''"
            title="Ajuster à la fenêtre"
            aria-label="Ajuster"
            @click="ed.imageZoomSet('fit')"
          >
            <i class="ph ph-arrows-in"></i>
          </button>
        </div>

        <div
          v-if="ed.activeFileViewMode === 'hex'"
          class="absolute inset-0 z-10 bg-[#1e1e1e] overflow-auto custom-scrollbar p-3 font-mono text-[11.5px] leading-relaxed"
        >
          <div v-if="ed.hexViewerLoading" class="flex items-center justify-center h-32">
            <i class="ph ph-spinner-gap animate-spin text-slate-500 text-xl"></i>
          </div>
          <template v-else-if="ed.hexViewerData && ed.hexViewerData.path === ed.activeTabPath">
            <div class="text-[10px] text-slate-500 mb-2 px-1 flex items-center gap-2">
              <i class="ph ph-binary"></i>
              <span
                >Fichier binaire — {{ ed.hexViewerData.size.toLocaleString("fr-FR") }} octets · affichage des
                4 premiers Ko</span
              >
            </div>
            <div class="space-y-0.5">
              <div
                v-for="(row, i) in ed.hexViewerLines"
                :key="i"
                class="flex gap-4 text-slate-300 hover:bg-white/5 px-1 rounded"
              >
                <span class="text-slate-500 shrink-0 select-none">{{ row.offset }}</span>
                <span class="text-amber-400 shrink-0 whitespace-pre">{{ row.hex }}</span>
                <span class="text-emerald-400 shrink-0 select-none">|{{ row.ascii }}|</span>
              </div>
            </div>
          </template>
          <div v-else class="text-slate-500 text-center py-8">Aucun contenu</div>
        </div>

        <div
          v-if="ed.activeTabPath && ed.activeFileViewMode === 'office' && ed.officeActive"
          class="absolute inset-0 z-10 flex flex-col bg-[#1e1e1e]"
          role="region"
          aria-label="Aperçu du document"
        >
          <div class="h-8 shrink-0 flex items-center gap-2 px-2 border-b border-white/10 bg-[#252526]">
            <i
              class="ph text-sm shrink-0"
              :class="
                {
                  docx: 'ph-file-doc text-blue-400',
                  pptx: 'ph-file-ppt text-orange-400',
                  xlsx: 'ph-file-xls text-emerald-400',
                  pdf: 'ph-file-pdf text-rose-400',
                }[ed.officeActive.kind ?? '']
              "
            ></i>
            <div
              v-if="ed.officeActive.kind === 'xlsx'"
              class="flex items-center rounded bg-black/20 p-0.5"
              role="group"
              aria-label="Vue"
            >
              <button
                :aria-pressed="ed.officeActive.view === 'grid' ? 'true' : 'false'"
                class="h-6 px-2 rounded text-[11px] flex items-center gap-1"
                :class="
                  ed.officeActive.view === 'grid'
                    ? 'bg-white/10 text-white'
                    : 'text-slate-400 hover:text-slate-200'
                "
                title="Valeurs des cellules"
                @click="ed.officeSetView('grid')"
              >
                <i class="ph ph-table text-xs"></i>Grille
              </button>
              <button
                :aria-pressed="ed.officeActive.view === 'pages' ? 'true' : 'false'"
                class="h-6 px-2 rounded text-[11px] flex items-center gap-1"
                :class="
                  ed.officeActive.view === 'pages'
                    ? 'bg-white/10 text-white'
                    : 'text-slate-400 hover:text-slate-200'
                "
                title="Mise en page d'impression, graphiques compris"
                @click="ed.officeSetView('pages')"
              >
                <i class="ph ph-file-text text-xs"></i>Pages
              </button>
            </div>
            <span
              v-if="
                ed.officeActive.status === 'ready' && ed.officeActive.pages && ed.officeActive.pages.truncated
              "
              class="text-[10px] font-bold px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-300"
              :title="'Aperçu limité aux ' + ed.officeActive.pages.count + ' premières pages'"
              >Tronqué</span
            >

            <span
              v-if="
                ed.officeActive.status === 'ready' && ed.officeActive.pages && ed.officeActive.pages.partial
              "
              class="text-[10px] font-bold px-2 py-0.5 rounded-full bg-blue-500/15 text-blue-300"
              :title="'Premières pages affichées — le document complet se prépare'"
              >Début</span
            >
            <div class="flex-1"></div>
            <button
              :disabled="ed.officeActive.status === 'loading'"
              class="w-7 h-7 rounded flex items-center justify-center text-slate-400 hover:text-white hover:bg-white/5 disabled:opacity-40"
              title="Recharger l'aperçu"
              aria-label="Recharger l'aperçu"
              @click="ed.officeReload()"
            >
              <i class="ph ph-arrows-clockwise text-sm"></i>
            </button>
            <button
              class="w-7 h-7 rounded flex items-center justify-center text-slate-400 hover:text-white hover:bg-white/5"
              title="Télécharger l'original"
              aria-label="Télécharger l'original"
              @click="ed.downloadFile(ed.activeTabPath)"
            >
              <i class="ph ph-download-simple text-sm"></i>
            </button>
          </div>
          <div class="flex-1 min-h-0 relative">
            <div
              v-if="ed.officeActive.status === 'loading'"
              class="absolute inset-0 flex items-center justify-center"
              aria-live="polite"
            >
              <div v-if="ed.officeActive.spin" class="flex items-center gap-2 text-xs text-slate-400">
                <i class="ph ph-spinner-gap animate-spin text-base"></i>
                <span
                  >{{ ed.officeActive.kind === "pdf" ? "Chargement…" : "Conversion…" }}
                  {{ Math.max(0, Math.floor((ed.officeNow - Number(ed.officeActive.startedAt)) / 1000)) }}
                  s</span
                >
              </div>
            </div>
            <div
              v-else-if="ed.officeActive.status === 'error'"
              class="absolute inset-0 flex flex-col items-center justify-center gap-3"
              role="alert"
            >
              <div class="flex items-center gap-2 text-sm text-slate-300">
                <i class="ph ph-warning-circle text-amber-400 text-lg"></i>
                <span :title="ed.officeActive.error?.message">{{ ed.officeActive.error?.message }}</span>
              </div>
              <div class="flex items-center gap-2">
                <button
                  class="h-7 px-3 rounded text-xs bg-blue-600 hover:bg-blue-500 text-white"
                  @click="ed.officeReload()"
                >
                  Réessayer
                </button>
                <button
                  class="h-7 px-3 rounded text-xs text-slate-300 hover:bg-white/5 border border-white/10"
                  @click="ed.downloadFile(ed.activeTabPath)"
                >
                  Télécharger
                </button>
                <button
                  v-if="ed.officeActive.kind === 'docx' && ed.officeActive.error?.code === 'soffice_missing'"
                  class="h-7 px-3 rounded text-xs text-slate-300 hover:bg-white/5 border border-white/10"
                  title="Texte brut extrait du document"
                  @click="ed.officeUseText()"
                >
                  Texte
                </button>
              </div>
            </div>
            <template v-else-if="ed.officeActive.status === 'ready'">
              <iframe
                v-if="ed.officeActive.view === 'pages' && ed.officeActive.pdfUrl"
                :key="ed.officeActive.pdfUrl + ':' + ed.officeActive.reloadSeq"
                :src="ed.officeActive.pdfUrl + (ed.officeActive.kind === 'pptx' ? '#view=Fit' : '#view=FitH')"
                title="Pages"
                class="absolute inset-0 w-full h-full border-0 bg-[#525659]"
              ></iframe>
              <GrilleOffice
                v-else-if="ed.officeActive.view === 'grid' && ed.officeActive.grid"
                :key="ed.activeTabPath + ':' + ed.officeActive.key + ':' + ed.officeActive.reloadSeq"
                :doc-key="ed.officeActive.key ?? ''"
                :sheets="ed.officeActive.grid.sheets"
                :chunk-size="ed.officeActive.grid.chunk"
                :fetch-chunk="ed.officeFetchChunk"
              ></GrilleOffice>
            </template>
          </div>
        </div>

        <div
          v-if="ed.activeTabPath && ed.activeFileViewMode === 'docx'"
          class="absolute top-2 left-1/2 -translate-x-1/2 z-20 bg-amber-500/15 border border-amber-500/30 text-amber-300 text-[10px] font-bold px-3 py-1 rounded-full flex items-center gap-1.5 backdrop-blur-sm"
        >
          <i class="ph ph-lock text-xs"></i> Lecture seule (.docx)
        </div>

        <div
          v-if="ed.fimLoading"
          class="absolute top-2 right-4 z-20 bg-blue-600 text-white text-[10px] font-bold px-2.5 py-1 rounded shadow-lg flex items-center gap-1.5 animate-pulse"
        >
          <i class="ph ph-spinner-gap animate-spin text-xs"></i> Complétion...
        </div>
      </div>

      <div
        v-show="ed.splitView"
        class="w-1 hover:w-1.5 bg-slate-700 hover:bg-blue-500 cursor-col-resize shrink-0 z-30 transition-colors relative group"
        title="Redimensionner les panneaux"
        @mousedown="ed.splitResizeStart"
        @touchstart.prevent="ed.splitResizeStart"
      >
        <div class="absolute inset-y-0 -left-1 -right-1"></div>
      </div>

      <div
        v-show="ed.splitView"
        class="relative h-full min-w-0 flex flex-col bg-[#1e1e1e]"
        :style="{ width: 'calc(' + (100 - ed.splitRatio) + '% - 2px)' }"
        :class="ed.splitMode === 'code' && ed.activePane === 'right' ? 'elpis-pane-focus' : ''"
        @mousedown="ed.splitMode === 'code' && (ed.activePane = 'right')"
      >
        <div
          v-if="ed.splitMode === 'code'"
          class="h-6 shrink-0 bg-[#252526] border-b border-black/20 flex items-center gap-2 px-2 text-[11px] text-slate-400 select-none"
        >
          <i class="ph ph-columns text-[10px] text-blue-400 shrink-0"></i>
          <span class="truncate font-mono flex-1" :title="ed.splitTabPath ?? undefined">{{
            ed.splitTabPath ? ed.splitTabPath.split("/").pop() : "Cliquez un onglet →"
          }}</span>
          <button
            title="Fermer la vue scindée"
            class="hover:text-white shrink-0 w-4 h-4 flex items-center justify-center"
            @click="ed.exitSplit"
          >
            <i class="ph ph-x text-[11px]"></i>
          </button>
        </div>

        <div
          v-else-if="ed.splitMode === 'render'"
          class="h-6 shrink-0 bg-[#252526] border-b border-black/20 flex items-center gap-2 px-2 text-[11px] text-slate-400 select-none"
        >
          <i class="ph ph-eye text-[10px] text-blue-400 shrink-0"></i>
          <span class="truncate flex-1">{{
            ed.renderPaneKind === "md"
              ? "Aperçu Markdown"
              : ed.renderPaneKind === "svg"
                ? "Aperçu SVG"
                : "Aperçu"
          }}</span>
          <button
            title="Fermer l'aperçu"
            class="hover:text-white shrink-0 w-4 h-4 flex items-center justify-center"
            @click="ed.exitSplit"
          >
            <i class="ph ph-x text-[11px]"></i>
          </button>
        </div>

        <div
          v-else
          class="h-7 shrink-0 bg-[#252526] border-b border-black/20 flex items-center gap-1.5 px-2 text-[11px] text-slate-400 select-none"
        >
          <div class="flex items-center bg-black/25 rounded p-0.5 shrink-0">
            <button
              title="Fichier de la sandbox (statique)"
              :aria-pressed="ed.previewSource === 'file'"
              class="px-1.5 py-0.5 rounded text-[10px] font-bold transition"
              :class="
                ed.previewSource === 'file'
                  ? 'bg-blue-500/20 text-blue-300'
                  : 'text-slate-500 hover:text-slate-300'
              "
              @click="ed.previewSource = 'file'"
            >
              <i class="ph ph-file-html"></i>
            </button>
            <button
              title="Serveur qui tourne dans la sandbox (localhost:port)"
              :aria-pressed="ed.previewSource === 'server'"
              class="px-1.5 py-0.5 rounded text-[10px] font-bold transition"
              :class="
                ed.previewSource === 'server'
                  ? 'bg-blue-500/20 text-blue-300'
                  : 'text-slate-500 hover:text-slate-300'
              "
              @click="ed.previewSource = 'server'"
            >
              <i class="ph ph-hard-drives"></i>
            </button>
          </div>
          <template v-if="ed.previewSource === 'file'">
            <input
              v-model="ed.previewPath"
              aria-label="Chemin du fichier à prévisualiser"
              placeholder="index.html"
              class="bg-black/25 rounded px-1.5 py-0.5 border-none outline-none flex-1 min-w-0 font-mono text-[10.5px] text-slate-300 focus:ring-1 focus:ring-blue-500/50"
            />
          </template>
          <template v-else>
            <input
              v-model="ed.previewServerUrl"
              aria-label="Adresse du serveur dans la sandbox"
              placeholder="localhost:8080/"
              class="bg-black/25 rounded px-1.5 py-0.5 border-none outline-none flex-1 min-w-0 font-mono text-[10.5px] text-slate-300 focus:ring-1 focus:ring-blue-500/50"
              @keydown.enter="ed.commitPreviewServerUrl"
              @blur="ed.commitPreviewServerUrl"
            />
            <span
              v-if="ed.previewServerHostWarn"
              class="shrink-0 text-amber-400 text-[10px]"
              :title="
                'L’aperçu passe toujours par votre sandbox : l’hôte « ' +
                ed.previewServerHostWarn +
                ' » a été ignoré, seuls le port et le chemin sont utilisés.'
              "
            >
              <i class="ph ph-warning"></i>
            </span>
          </template>

          <button
            v-if="ed.previewSource === 'file'"
            :aria-pressed="ed.previewLive"
            :title="
              ed.previewLive
                ? 'Live activé — enregistre et recharge pendant la frappe'
                : 'Live : enregistrer et recharger pendant la frappe'
            "
            class="px-1.5 py-0.5 rounded text-[10px] font-bold shrink-0 flex items-center gap-1 transition"
            :class="
              ed.previewLive
                ? 'bg-emerald-500/20 text-emerald-300'
                : 'text-slate-500 hover:text-slate-300 hover:bg-white/5'
            "
            @click="ed.togglePreviewLive()"
          >
            <i class="ph" :class="ed.previewLive ? 'ph-broadcast' : 'ph-pause'"></i> Live
          </button>
          <button
            title="Recharger l'aperçu"
            class="shrink-0 w-5 h-5 flex items-center justify-center rounded hover:bg-white/5 hover:text-white"
            @click="ed.reloadPreview()"
          >
            <i class="ph ph-arrow-clockwise text-[11px]"></i>
          </button>
          <button
            title="Ouvrir dans un onglet du navigateur"
            class="shrink-0 w-5 h-5 flex items-center justify-center rounded hover:bg-white/5 hover:text-white"
            @click="ed.openPreviewInNewTab()"
          >
            <i class="ph ph-arrow-square-out text-[11px]"></i>
          </button>
          <button
            title="Fermer l'aperçu"
            class="shrink-0 w-5 h-5 flex items-center justify-center rounded hover:bg-white/5 hover:text-white"
            @click="ed.exitSplit"
          >
            <i class="ph ph-x text-[11px]"></i>
          </button>
        </div>

        <div class="flex-1 relative min-h-0">
          <div v-show="ed.splitMode === 'code'" class="absolute inset-0">
            <div id="monaco-editor-2" class="absolute inset-0"></div>
            <div
              v-show="!ed.splitTabPath"
              class="absolute inset-0 flex items-center justify-center text-slate-600 text-sm pointer-events-none select-none"
            >
              Cliquez un onglet pour l'ouvrir ici
            </div>
          </div>

          <div
            v-if="ed.splitView && ed.splitMode === 'render'"
            class="absolute inset-0 overflow-auto custom-scrollbar"
            :class="ed.renderPaneKind === 'md' ? 'bg-white' : ''"
          >
            <div
              v-if="ed.renderPaneKind === 'md'"
              class="markdown-body max-w-3xl mx-auto px-6 py-5"
              v-html="ed.renderMarkdown(ed.renderPaneSource)"
            ></div>
            <div
              v-else-if="ed.renderPaneKind === 'svg'"
              class="min-h-full flex items-center justify-center p-6 elpis-svg-checker"
            >
              <div class="elpis-svg-preview-wrap" v-html="ed.renderSvgSafe(ed.renderPaneSource)"></div>
            </div>
            <div v-else class="absolute inset-0 flex items-center justify-center text-slate-500 text-xs">
              Aperçu disponible pour Markdown et SVG
            </div>
          </div>

          <div v-if="ed.splitView && ed.splitMode === 'preview'" class="absolute inset-0 bg-white">
            <div
              v-if="ed.previewSource === 'file' && !ed.previewPath"
              class="absolute inset-0 flex flex-col items-center justify-center text-slate-400 bg-slate-50"
            >
              <i class="ph ph-browser text-3xl mb-2"></i>
              <p class="text-xs">Indiquez un fichier .html</p>
            </div>

            <iframe
              v-else
              :key="ed.previewKey"
              :src="ed.previewSrc"
              sandbox="allow-scripts allow-forms allow-popups allow-modals"
              title="Aperçu de la page"
              class="w-full h-full border-none bg-white"
            ></iframe>
          </div>
        </div>
      </div>
    </div>

    <MenuCode />

    <div v-if="ed.editorMode === 'preview'" class="w-full h-full bg-white relative">
      <div
        v-if="ed.previewSource === 'file' && !ed.previewPath"
        class="absolute inset-0 flex flex-col items-center justify-center text-slate-400 bg-slate-50"
      >
        <i class="ph ph-browser text-4xl mb-2"></i>
        <p class="text-sm">Aucun fichier</p>
      </div>

      <iframe
        v-else
        :key="ed.previewKey"
        :src="ed.previewSrc"
        sandbox="allow-scripts allow-forms allow-popups allow-modals"
        class="w-full h-full border-none bg-white"
      ></iframe>
    </div>
  </div>
</template>
