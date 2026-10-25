<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/reglages/PanneauMcp.vue — gabarit migré de includes/main/panel_mcp.html. -->
<script setup lang="ts">
import { domaineReglages } from "../../features/reglages/domaine";

const rg = domaineReglages();
</script>

<template>
  <div
    v-if="rg.settings.enable_mcp"
    class="elpis-slide-panel h-full shrink-0 flex flex-col bg-slate-50 z-20 border-l border-slate-200"
    :class="rg.showMcpPanel ? 'w-[280px] opacity-100' : 'w-0 opacity-0 overflow-hidden pointer-events-none'"
  >
    <div class="h-16 flex items-center justify-between px-4 border-b border-slate-200 shrink-0 bg-white">
      <h3 class="font-bold text-slate-800 flex items-center gap-2 text-sm">
        <i class="ph ph-plug text-blue-600 text-lg"></i> MCP
      </h3>
      <button
        class="text-slate-400 hover:text-slate-800 p-1 hover:bg-slate-100 rounded-md transition-colors"
        @click="rg.showMcpPanel = false"
      >
        <i class="ph ph-x text-base"></i>
      </button>
    </div>

    <div class="flex-1 overflow-y-auto p-4 custom-scrollbar space-y-6">
      <div class="bg-white p-3.5 rounded-xl shadow-sm border border-slate-200">
        <div class="text-xs font-semibold text-slate-500 mb-3">Internes</div>

        <div v-if="rg.mcpUserCategories.length === 0" class="text-center py-3 text-xs text-slate-400 italic">
          Aucune catégorie d'outils active pour le moment.<br />Un administrateur peut en activer via la
          modale MCP (Paramètres → MCP).
        </div>

        <div v-else class="space-y-1.5">
          <template v-for="cat in rg.mcpUserCategories" :key="cat.name">
            <div
              v-if="cat.name === 'browser'"
              class="flex items-center gap-2 p-1.5 hover:bg-slate-50 rounded-lg transition-colors"
            >
              <div
                class="text-xs font-semibold text-slate-700 flex items-center gap-2.5 cursor-pointer flex-1 min-w-0"
                @click="rg.localTools[cat.name] = !rg.localTools[cat.name]"
              >
                <div
                  class="w-6 h-6 rounded flex items-center justify-center shrink-0"
                  :class="rg.mcpCategoryBgClass(cat)"
                >
                  <i class="ph text-sm" :class="cat.icon || 'ph-package'"></i>
                </div>
                <span>{{ cat.label || cat.name }}</span>
              </div>
              <span v-if="rg.catToolsCount(cat)" class="text-xs text-slate-400 shrink-0">{{
                rg.catToolsCount(cat)
              }}</span>
              <span
                v-if="rg.localTools[cat.name] && (cat.tools || []).length"
                role="button"
                tabindex="0"
                title="Choisir les outils"
                class="w-6 h-6 flex items-center justify-center rounded hover:bg-slate-100 text-slate-400 hover:text-slate-700 transition-colors shrink-0 cursor-pointer"
                @click.prevent.stop="rg.toggleToolCatOpen(cat.name)"
                @keydown.enter.prevent.stop="rg.toggleToolCatOpen(cat.name)"
                @keydown.space.prevent.stop="rg.toggleToolCatOpen(cat.name)"
              >
                <i
                  class="ph ph-caret-right text-sm transition-transform"
                  :class="rg.openToolCats[cat.name] ? 'rotate-90' : ''"
                ></i>
              </span>
              <button
                v-if="rg.localTools[cat.name]"
                type="button"
                title="Voir la cartographie AX Memory"
                class="w-6 h-6 flex items-center justify-center rounded hover:bg-blue-100 text-slate-400 hover:text-blue-600 transition-colors shrink-0"
                @click="rg.openAxModal()"
              >
                <i class="ph ph-git-branch text-sm"></i>
              </button>
              <label class="relative inline-flex items-center cursor-pointer shrink-0">
                <input v-model="rg.localTools[cat.name]" type="checkbox" class="sr-only peer" />
                <div
                  class="w-9 h-5 bg-slate-200 border border-slate-300 rounded-full peer peer-focus:outline-none transition-colors after:content-[''] after:absolute after:top-[1px] after:left-[1px] after:bg-white after:border after:border-slate-300 after:rounded-full after:h-4 after:w-4 after:transition-all after:shadow-sm peer-checked:after:translate-x-full peer-checked:after:border-white"
                  :class="rg.mcpCategoryToggleClass(cat)"
                ></div>
              </label>
            </div>

            <label
              v-else
              class="flex items-center gap-2 cursor-pointer group p-1.5 hover:bg-slate-50 rounded-lg transition-colors"
            >
              <span class="text-xs font-semibold text-slate-700 flex items-center gap-2.5 flex-1 min-w-0">
                <div
                  class="w-6 h-6 rounded flex items-center justify-center shrink-0"
                  :class="rg.mcpCategoryBgClass(cat)"
                >
                  <i class="ph text-sm" :class="cat.icon || 'ph-package'"></i>
                </div>
                <span class="truncate">{{ cat.label || cat.name }}</span>
              </span>
              <span v-if="rg.catToolsCount(cat)" class="text-xs text-slate-400 shrink-0">{{
                rg.catToolsCount(cat)
              }}</span>

              <span
                v-if="rg.localTools[cat.name] && (cat.tools || []).length"
                role="button"
                tabindex="0"
                title="Choisir les outils"
                class="w-6 h-6 flex items-center justify-center rounded hover:bg-slate-100 text-slate-400 hover:text-slate-700 transition-colors shrink-0 cursor-pointer"
                @click.prevent.stop="rg.toggleToolCatOpen(cat.name)"
                @keydown.enter.prevent.stop="rg.toggleToolCatOpen(cat.name)"
                @keydown.space.prevent.stop="rg.toggleToolCatOpen(cat.name)"
              >
                <i
                  class="ph ph-caret-right text-sm transition-transform"
                  :class="rg.openToolCats[cat.name] ? 'rotate-90' : ''"
                ></i>
              </span>
              <span class="relative inline-flex items-center shrink-0">
                <input v-model="rg.localTools[cat.name]" type="checkbox" class="sr-only peer" />
                <div
                  class="w-9 h-5 bg-slate-200 border border-slate-300 rounded-full peer peer-focus:outline-none transition-colors after:content-[''] after:absolute after:top-[1px] after:left-[1px] after:bg-white after:border after:border-slate-300 after:rounded-full after:h-4 after:w-4 after:transition-all after:shadow-sm peer-checked:after:translate-x-full peer-checked:after:border-white"
                  :class="rg.mcpCategoryToggleClass(cat)"
                ></div>
              </span>
            </label>

            <div
              v-if="rg.localTools[cat.name] && rg.openToolCats[cat.name] && (cat.tools || []).length"
              class="pl-9 pr-1.5 pb-2 -mt-0.5"
            >
              <div v-if="rg.catToolsCount(cat)" class="flex items-center pb-1">
                <button
                  type="button"
                  class="text-xs text-slate-400 hover:text-blue-600 transition-colors"
                  @click="rg.resetCatTools(cat)"
                >
                  Tout
                </button>
              </div>
              <label
                v-for="t in cat.tools"
                :key="t.name"
                class="flex items-center gap-2 py-0.5 cursor-pointer"
              >
                <input
                  type="checkbox"
                  :checked="rg.isToolOn(t.name)"
                  class="w-3.5 h-3.5 rounded border-slate-300 text-blue-600 cursor-pointer shrink-0"
                  @change="rg.toggleTool(t.name)"
                />
                <span
                  class="text-xs truncate flex-1 min-w-0"
                  :class="rg.isToolOn(t.name) ? 'text-slate-600' : 'text-slate-400 line-through'"
                  >{{ t.title || t.name }}</span
                >

                <span
                  role="button"
                  tabindex="0"
                  title="Détail de l'outil"
                  class="w-4 h-4 flex items-center justify-center rounded text-slate-300 hover:text-blue-600 hover:bg-blue-50 transition-colors shrink-0 cursor-pointer"
                  @click.prevent.stop="rg.openToolInfo(t, cat)"
                  @keydown.enter.prevent.stop="rg.openToolInfo(t, cat)"
                  @keydown.space.prevent.stop="rg.openToolInfo(t, cat)"
                >
                  <i class="ph ph-info text-xs"></i>
                </span>
              </label>
            </div>

            <div v-if="cat.name === 'desktop' && rg.localTools[cat.name]" class="pl-9 pr-1.5 pb-2 -mt-0.5">
              <div class="flex items-center gap-2">
                <span class="text-xs text-slate-400 shrink-0">Cible</span>
                <select
                  v-model="rg.desktopActiveTarget"
                  class="flex-1 min-w-0 text-xs bg-white border border-slate-200 rounded-md px-2 py-1 outline-none focus:ring-1 focus:ring-blue-500"
                  @focus="rg.ensureDesktopTargets()"
                  @change="rg.setDesktopActiveTarget(rg.desktopActiveTarget)"
                >
                  <option value="">(défaut)</option>
                  <option v-for="t in rg.studioTargets" :key="t.name" :value="t.name">
                    {{ t.name }} ({{ t.os }})
                  </option>
                </select>
              </div>
            </div>
          </template>
        </div>
      </div>

      <div
        v-if="rg.manifestServers && rg.manifestServers.length > 0"
        class="bg-white p-3.5 rounded-xl shadow-sm border border-slate-200"
      >
        <div class="text-xs font-semibold text-slate-500 mb-3">Déclarés</div>
        <div class="space-y-1">
          <label
            v-for="srv in rg.manifestServers"
            :key="'mf-' + srv.name"
            class="flex items-center justify-between cursor-pointer group p-1.5 hover:bg-slate-50 rounded-lg transition-colors"
          >
            <span
              class="text-xs font-semibold text-slate-700 flex items-center gap-2 truncate pr-2"
              :title="srv.description || srv.name"
            >
              <div
                class="w-6 h-6 rounded flex items-center justify-center bg-slate-50 text-slate-500 shrink-0"
              >
                <i class="ph" :class="srv.type === 'stdio' ? 'ph-terminal-window' : 'ph-globe'"></i>
              </div>
              <span class="truncate">{{ srv.name }}</span>
            </span>
            <div class="relative inline-flex items-center shrink-0">
              <input v-model="rg.manifestTools[srv.name]" type="checkbox" class="sr-only peer" />
              <div
                class="w-9 h-5 bg-slate-200 border border-slate-300 rounded-full peer peer-checked:bg-blue-600 peer-checked:border-blue-600 peer-focus:outline-none transition-colors after:content-[''] after:absolute after:top-[1px] after:left-[1px] after:bg-white after:border after:border-slate-300 after:rounded-full after:h-4 after:w-4 after:transition-all after:shadow-sm peer-checked:after:translate-x-full peer-checked:after:border-white"
              ></div>
            </div>
          </label>
        </div>
      </div>

      <div class="bg-white p-3.5 rounded-xl shadow-sm border border-slate-200">
        <div class="flex justify-between items-center mb-2">
          <span class="text-xs font-semibold text-slate-500">Externes</span>
          <div class="flex items-center gap-1">
            <span
              v-if="rg.pinnedServers.length > 0"
              class="bg-blue-50 text-blue-600 text-xs font-bold px-1.5 py-0.5 rounded"
              >{{ rg.pinnedServers.length }}</span
            >
            <button
              class="w-6 h-6 flex items-center justify-center rounded hover:bg-blue-100 text-slate-400 hover:text-blue-600 transition-colors"
              title="Gérer / ajouter un serveur"
              @click="
                rg.showMcpManagerModal = true;
                rg.loadCustomMcpServers();
                rg.loadSharedMcpServers();
              "
            >
              <i class="ph ph-plus text-xs font-bold"></i>
            </button>
          </div>
        </div>

        <div v-if="rg.pinnedServers.length > 0" class="space-y-1">
          <label
            v-for="srv in rg.pinnedServers"
            :key="srv.id"
            class="flex items-center justify-between cursor-pointer group p-1.5 hover:bg-slate-50 rounded-lg transition-colors"
          >
            <span
              class="text-xs font-semibold text-slate-700 flex items-center gap-2 truncate pr-2"
              :title="srv.shared ? srv.name + ' — publié pour tous' : srv.name"
            >
              <div
                class="w-6 h-6 rounded flex items-center justify-center bg-slate-50 text-slate-500 shrink-0"
              >
                <i class="ph" :class="srv.type === 'stdio' ? 'ph-terminal-window' : 'ph-globe'"></i>
              </div>
              <span class="truncate">{{ srv.name }}</span>
              <i v-if="srv.shared" class="ph ph-users-three text-slate-400 shrink-0" aria-hidden="true"></i>
            </span>
            <div class="relative inline-flex items-center shrink-0">
              <input
                type="checkbox"
                :checked="rg.config.active_mcp_ids.includes(srv.id)"
                class="sr-only peer"
                @change="rg.activateExternalServer(srv.id)"
              />
              <div
                class="w-9 h-5 bg-slate-200 border border-slate-300 rounded-full peer peer-checked:bg-blue-600 peer-checked:border-blue-600 peer-focus:outline-none transition-colors after:content-[''] after:absolute after:top-[1px] after:left-[1px] after:bg-white after:border after:border-slate-300 after:rounded-full after:h-4 after:w-4 after:transition-all after:shadow-sm peer-checked:after:translate-x-full peer-checked:after:border-white"
              ></div>
            </div>
          </label>
        </div>
        <div v-else class="text-center py-3 text-xs text-slate-400">Aucun serveur externe.</div>
      </div>
    </div>
  </div>
</template>
