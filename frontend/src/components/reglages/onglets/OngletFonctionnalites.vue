<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/reglages/onglets/OngletFonctionnalites.vue — onglet « features » des Paramètres. -->
<script setup lang="ts">
import AideOnglet from "../AideOnglet.vue";
import { domaineReglages } from "../../../features/reglages/domaine";

const rg = domaineReglages();
</script>

<template>
  <!-- eslint-disable vue/multiline-html-element-content-newline -->
  <div class="space-y-5 max-w-xl">
    <AideOnglet titre="Fonctionnalités"
      >Ce que l'assistant peut faire. Chaque module s'active séparément.</AideOnglet
    >

    <div>
      <div class="text-xs font-semibold text-slate-500 px-0.5 mb-1.5">Modules</div>
      <div class="bg-slate-50 rounded-xl divide-y divide-slate-200/70">
        <label class="set-row cursor-pointer hover:bg-white/60 transition-colors first:rounded-t-xl">
          <i class="ph ph-plug text-slate-400 text-lg w-5"></i>
          <div class="flex-1 min-w-0">
            <div class="text-sm text-slate-800">MCP</div>
            <div class="text-xs text-slate-500">Shell, fichiers, git, navigateur, serveurs MCP.</div>

            <div v-if="!rg.settings.enable_mcp" class="text-xs text-amber-600 mt-1 flex items-start gap-1">
              <i class="ph ph-warning-circle mt-px shrink-0" aria-hidden="true"></i>
              <span>L'assistant ne peut plus qu'écrire ; seule la mémoire reste.</span>
            </div>
          </div>
          <div class="relative inline-flex items-center shrink-0">
            <input v-model="rg.settings.enable_mcp" type="checkbox" class="sr-only peer" />
            <div class="set-switch-track peer-checked:bg-blue-600 peer-checked:border-blue-600"></div>
          </div>
        </label>

        <label
          v-if="rg.settings.image_ready"
          class="set-row cursor-pointer hover:bg-white/60 transition-colors"
          data-feat-image
        >
          <i class="ph ph-image text-slate-400 text-lg w-5"></i>
          <div class="flex-1 min-w-0">
            <div class="text-sm text-slate-800">Images</div>
            <div class="text-xs text-slate-500">Génération depuis le menu +.</div>
          </div>
          <div class="relative inline-flex items-center shrink-0">
            <input v-model="rg.settings.image_enabled" type="checkbox" class="sr-only peer" />
            <div class="set-switch-track peer-checked:bg-blue-600 peer-checked:border-blue-600"></div>
          </div>
        </label>

        <label class="set-row cursor-pointer hover:bg-white/60 transition-colors last:rounded-b-xl">
          <i class="ph ph-code-block text-slate-400 text-lg w-5"></i>
          <div class="flex-1 min-w-0">
            <div class="text-sm text-slate-800">Sandbox</div>
            <div class="text-xs text-slate-500">Panneau de code intégré, avec arborescence de fichiers.</div>
          </div>
          <div class="relative inline-flex items-center shrink-0">
            <input v-model="rg.settings.enable_editor" type="checkbox" class="sr-only peer" />
            <div class="set-switch-track peer-checked:bg-blue-600 peer-checked:border-blue-600"></div>
          </div>
        </label>
      </div>
    </div>

    <div
      v-if="rg.settings.image_ready && rg.settings.image_enabled !== false && rg.settings.image_prefs"
      data-feat-images
    >
      <div class="text-xs font-semibold text-slate-500 px-0.5 mb-1.5">Images</div>
      <div class="bg-slate-50 rounded-xl divide-y divide-slate-200/70">
        <label
          v-if="!rg.imageStatus || rg.imageStatus.tool_enabled !== false"
          class="set-row cursor-pointer hover:bg-white/60 transition-colors first:rounded-t-xl"
          title="Le modèle peut créer une image pendant une réponse (outil generate_image)."
        >
          <i class="ph ph-robot text-slate-400 text-lg w-5"></i>
          <div class="flex-1 min-w-0 text-sm text-slate-800">Par le modèle</div>
          <div class="relative inline-flex items-center shrink-0">
            <input v-model="rg.settings.image_tool_enabled" type="checkbox" class="sr-only peer" />
            <div class="set-switch-track peer-checked:bg-blue-600 peer-checked:border-blue-600"></div>
          </div>
        </label>
        <div v-if="!rg.imageFixedSizes.length" class="set-row" data-pref-ratio>
          <i class="ph ph-crop text-slate-400 text-lg w-5"></i>
          <div class="flex-1 min-w-0 text-sm text-slate-800">Format</div>
          <div class="flex items-center gap-1 shrink-0" role="group" aria-label="Format">
            <button
              v-for="r in rg.imageBaseRatios"
              :key="r"
              type="button"
              class="elpis-img-chip"
              :aria-pressed="rg.imageBaseRatio(rg.settings.image_prefs.ratio) === r ? 'true' : 'false'"
              :title="r === '1:1' ? 'Carré' : r"
              @click="rg.setPrefRatio(r)"
            >
              <span
                class="elpis-img-ratio"
                :style="
                  rg.ratioBox(rg.imageIsPortrait(rg.settings.image_prefs.ratio) ? rg.imageFlipRatio(r) : r)
                "
                aria-hidden="true"
              ></span>
            </button>
            <button
              type="button"
              class="elpis-img-chip elpis-img-chip--icon"
              :disabled="rg.settings.image_prefs.ratio === '1:1'"
              :aria-pressed="rg.imageIsPortrait(rg.settings.image_prefs.ratio) ? 'true' : 'false'"
              title="Portrait / paysage"
              aria-label="Basculer portrait ou paysage"
              @click="rg.flipPrefRatio()"
            >
              <i class="ph ph-arrows-left-right" aria-hidden="true"></i>
            </button>
          </div>
        </div>
        <div v-if="!rg.imageFixedSizes.length && rg.imageSides.length > 1" class="set-row">
          <i class="ph ph-arrows-out text-slate-400 text-lg w-5"></i>
          <div class="flex-1 min-w-0 text-sm text-slate-800">Taille</div>
          <select
            v-model.number="rg.settings.image_prefs.side"
            class="set-select shrink-0 w-28 font-mono text-xs"
            aria-label="Taille"
            title="Plus grand côté"
          >
            <option v-for="v in rg.imageSides" :key="v" :value="v">{{ v }} px</option>
          </select>
        </div>
        <div v-if="rg.imageMaxN > 1" class="set-row">
          <i class="ph ph-squares-four text-slate-400 text-lg w-5"></i>
          <div class="flex-1 min-w-0 text-sm text-slate-800">Nombre</div>
          <select
            v-model.number="rg.settings.image_prefs.n"
            class="set-select shrink-0 w-28 font-mono text-xs"
            aria-label="Nombre d’images"
          >
            <option v-for="k in rg.imageMaxN" :key="k" :value="k">×{{ k }}</option>
          </select>
        </div>
        <label
          v-if="!rg.imageStatus || rg.imageStatus.enhance_enabled !== false"
          class="set-row cursor-pointer hover:bg-white/60 transition-colors"
          title="Le modèle du chat réécrit la description avant l'envoi au moteur."
        >
          <i class="ph ph-magic-wand text-slate-400 text-lg w-5"></i>
          <div class="flex-1 min-w-0 text-sm text-slate-800">Enrichir</div>
          <div class="relative inline-flex items-center shrink-0">
            <input v-model="rg.settings.image_prefs.enhance" type="checkbox" class="sr-only peer" />
            <div class="set-switch-track peer-checked:bg-blue-600 peer-checked:border-blue-600"></div>
          </div>
        </label>
        <div
          v-if="rg.imageStatus && rg.imageStatus.keep_per_user"
          class="set-row last:rounded-b-xl"
          data-pref-stored
        >
          <i class="ph ph-images text-slate-400 text-lg w-5"></i>
          <div
            class="flex-1 min-w-0 text-sm text-slate-800"
            title="Les plus anciennes sont effacées au-delà de cette limite."
          >
            Conservées
          </div>
          <span class="text-xs text-slate-500 font-mono tabular-nums shrink-0"
            >{{ rg.imageStatus.stored || 0 }}/{{ rg.imageStatus.keep_per_user }}</span
          >
          <button
            type="button"
            class="elpis-img-chip shrink-0"
            data-pref-gallery
            @click="rg.openImageGallery('all')"
          >
            <i class="ph ph-images" aria-hidden="true"></i><span>Bibliothèque</span>
          </button>
        </div>
      </div>
    </div>

    <template v-if="rg.settings.enable_editor">
      <div data-feat-editor-display>
        <div class="text-xs font-semibold text-slate-500 px-0.5 mb-1.5">Éditeur · affichage</div>
        <div class="bg-slate-50 rounded-xl divide-y divide-slate-200/70">
          <label class="set-row cursor-pointer hover:bg-white/60 transition-colors first:rounded-t-xl">
            <i class="ph ph-paint-roller text-slate-400 text-lg w-5"></i>
            <div class="flex-1 min-w-0">
              <div class="text-sm text-slate-800">Thème sombre</div>
              <div class="text-xs text-slate-500">Indépendant du mode sombre de la page.</div>
            </div>
            <div class="relative inline-flex items-center shrink-0">
              <input v-model="rg.settings.editor_dark_mode" type="checkbox" class="sr-only peer" />
              <div class="set-switch-track peer-checked:bg-blue-600 peer-checked:border-blue-600"></div>
            </div>
          </label>

          <div class="set-row">
            <i class="ph ph-text-aa text-slate-400 text-lg w-5"></i>
            <div class="flex-1 min-w-0 text-sm text-slate-800">Taille de police</div>
            <div class="shrink-0 flex items-center gap-2">
              <input
                v-model.number="rg.settings.editor_font_size"
                type="range"
                min="10"
                max="24"
                step="1"
                aria-label="Taille de police de l'éditeur"
                class="set-range w-28"
              />
              <span
                class="text-xs font-mono tabular-nums text-blue-600 bg-white px-1.5 rounded border border-slate-200"
                >{{ rg.settings.editor_font_size || 14 }}px</span
              >
            </div>
          </div>

          <div class="set-row">
            <i class="ph ph-text-t text-slate-400 text-lg w-5"></i>
            <div class="flex-1 min-w-0 text-sm text-slate-800">Police</div>
            <select
              v-model="rg.settings.editor_font_family"
              aria-label="Police de l'éditeur"
              class="set-select set-control--sm shrink-0"
            >
              <option value="JetBrains Mono">JetBrains Mono</option>
              <option value="Fira Code">Fira Code</option>
              <option value="Cascadia Code">Cascadia Code</option>
              <option value="Consolas">Consolas</option>
              <option value="Menlo">Menlo</option>
              <option value="Monaco">Monaco</option>
              <option value="monospace">Système</option>
            </select>
          </div>

          <div class="set-row">
            <i class="ph ph-arrows-in-line-horizontal text-slate-400 text-lg w-5"></i>
            <div class="flex-1 min-w-0 text-sm text-slate-800">Retour à la ligne</div>
            <select
              v-model="rg.settings.editor_word_wrap"
              aria-label="Retour à la ligne"
              class="set-select set-control--sm shrink-0"
            >
              <option value="off">Aucun</option>
              <option value="on">Activé</option>
              <option value="bounded">Limité</option>
            </select>
          </div>

          <div class="set-row">
            <i class="ph ph-arrow-bend-down-right text-slate-400 text-lg w-5"></i>
            <div class="flex-1 min-w-0 text-sm text-slate-800">Indentation</div>
            <div class="shrink-0 flex items-center gap-1.5">
              <select
                v-model.number="rg.settings.editor_tab_size"
                aria-label="Largeur d'indentation"
                class="set-select set-control--sm"
              >
                <option :value="2">2</option>
                <option :value="4">4</option>
                <option :value="8">8</option>
              </select>
              <select
                v-model="rg.settings.editor_insert_spaces"
                aria-label="Caractère d'indentation"
                class="set-select set-control--sm"
              >
                <option :value="true">espaces</option>
                <option :value="false">tabulations</option>
              </select>
            </div>
          </div>

          <label class="set-row cursor-pointer hover:bg-white/60 transition-colors">
            <i class="ph ph-map-trifold text-slate-400 text-lg w-5"></i>
            <div class="flex-1 min-w-0">
              <div class="text-sm text-slate-800">Minimap</div>
              <div class="text-xs text-slate-500">Aperçu du fichier dans la marge droite.</div>
            </div>
            <div class="relative inline-flex items-center shrink-0">
              <input v-model="rg.settings.editor_minimap" type="checkbox" class="sr-only peer" />
              <div class="set-switch-track peer-checked:bg-blue-600 peer-checked:border-blue-600"></div>
            </div>
          </label>

          <label class="set-row cursor-pointer hover:bg-white/60 transition-colors last:rounded-b-xl">
            <i class="ph ph-list-numbers text-slate-400 text-lg w-5"></i>
            <div class="flex-1 min-w-0 text-sm text-slate-800">Numéros de ligne</div>
            <div class="relative inline-flex items-center shrink-0">
              <input v-model="rg.settings.editor_line_numbers" type="checkbox" class="sr-only peer" />
              <div class="set-switch-track peer-checked:bg-blue-600 peer-checked:border-blue-600"></div>
            </div>
          </label>
        </div>
      </div>

      <div data-feat-editor-behavior>
        <div class="text-xs font-semibold text-slate-500 px-0.5 mb-1.5">Éditeur · comportement</div>
        <div class="bg-slate-50 rounded-xl divide-y divide-slate-200/70">
          <label class="set-row cursor-pointer hover:bg-white/60 transition-colors first:rounded-t-xl">
            <i class="ph ph-magic-wand text-slate-400 text-lg w-5"></i>
            <div class="flex-1 min-w-0">
              <div class="text-sm text-slate-800">Ouverture automatique</div>
              <div class="text-xs text-slate-500">Ouvre l'éditeur quand l'assistant écrit un fichier.</div>
            </div>
            <div class="relative inline-flex items-center shrink-0">
              <input v-model="rg.settings.auto_open_editor_on_write" type="checkbox" class="sr-only peer" />
              <div class="set-switch-track peer-checked:bg-blue-600 peer-checked:border-blue-600"></div>
            </div>
          </label>

          <label class="set-row cursor-pointer hover:bg-white/60 transition-colors">
            <i class="ph ph-eye text-slate-400 text-lg w-5"></i>
            <div class="flex-1 min-w-0">
              <div class="text-sm text-slate-800">Aperçu</div>
              <div class="text-xs text-slate-500">Onglet d'exécution HTML/JS.</div>
            </div>
            <div class="relative inline-flex items-center shrink-0">
              <input v-model="rg.settings.enable_preview" type="checkbox" class="sr-only peer" />
              <div class="set-switch-track peer-checked:bg-blue-600 peer-checked:border-blue-600"></div>
            </div>
          </label>

          <label class="set-row cursor-pointer hover:bg-white/60 transition-colors">
            <i class="ph ph-highlighter text-slate-400 text-lg w-5"></i>
            <div class="flex-1 min-w-0">
              <div class="text-sm text-slate-800">Surbrillance des modifications</div>
              <div class="text-xs text-slate-500">Teinte brièvement les lignes éditées par l'assistant.</div>
            </div>
            <div class="relative inline-flex items-center shrink-0">
              <input v-model="rg.settings.editor_edit_highlight" type="checkbox" class="sr-only peer" />
              <div class="set-switch-track peer-checked:bg-blue-600 peer-checked:border-blue-600"></div>
            </div>
          </label>

          <div class="set-row">
            <i class="ph ph-floppy-disk text-slate-400 text-lg w-5"></i>
            <div class="flex-1 min-w-0 text-sm text-slate-800">Sauvegarde automatique</div>
            <select
              v-model="rg.settings.editor_auto_save"
              aria-label="Sauvegarde automatique"
              class="set-select set-control--sm shrink-0"
            >
              <option value="off">Désactivée</option>
              <option value="30s">Après 30 s sans frappe</option>
              <option value="1min">Après 1 min sans frappe</option>
              <option value="2min">Après 2 min sans frappe</option>
              <option value="on_blur">À la perte du focus</option>
            </select>
          </div>

          <label class="set-row cursor-pointer hover:bg-white/60 transition-colors">
            <i class="ph ph-crosshair text-slate-400 text-lg w-5"></i>
            <div class="flex-1 min-w-0">
              <div class="text-sm text-slate-800">Suivre le fichier ouvert</div>
              <div class="text-xs text-slate-500">L'arbre se positionne sur l'onglet actif.</div>
            </div>
            <div class="relative inline-flex items-center shrink-0">
              <input v-model="rg.settings.editor_follow_active" type="checkbox" class="sr-only peer" />
              <div class="set-switch-track peer-checked:bg-blue-600 peer-checked:border-blue-600"></div>
            </div>
          </label>

          <label class="set-row cursor-pointer hover:bg-white/60 transition-colors last:rounded-b-xl">
            <i class="ph ph-browsers text-slate-400 text-lg w-5"></i>
            <div class="flex-1 min-w-0">
              <div class="text-sm text-slate-800">Mémoriser les onglets</div>
              <div class="text-xs text-slate-500">Rouvre ceux de la dernière session, curseur compris.</div>
            </div>
            <div class="relative inline-flex items-center shrink-0">
              <input v-model="rg.settings.editor_persist_tabs" type="checkbox" class="sr-only peer" />
              <div class="set-switch-track peer-checked:bg-blue-600 peer-checked:border-blue-600"></div>
            </div>
          </label>
        </div>
      </div>
    </template>

    <p class="text-xs text-slate-500">
      <i class="ph ph-info text-slate-400 align-middle mr-1" aria-hidden="true"></i>Mémoire et sous-agents
      s'activent depuis
      <button
        class="underline underline-offset-2 hover:text-slate-700 transition-colors"
        @click="
          rg.settingsTab = 'memory';
          rg.loadUserMemory();
        "
      >
        Mémoire
      </button>
      et
      <button
        class="underline underline-offset-2 hover:text-slate-700 transition-colors"
        @click="
          rg.settingsTab = 'agents';
          rg.loadMcpUserCategories();
          rg.loadAgentTemplates();
        "
      >
        Agents</button
      >.
    </p>
  </div>
</template>
