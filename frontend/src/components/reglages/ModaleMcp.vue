<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/reglages/ModaleMcp.vue — gabarit migré de includes/modals/mcp.html. -->
<script setup lang="ts">
import { domaineReglages } from "../../features/reglages/domaine";

const rg = domaineReglages();
</script>

<template>
  <Transition name="modal">
    <div
      v-if="rg.showMcpManagerModal"
      data-a11y-modal
      role="dialog"
      aria-modal="true"
      aria-label="Serveurs MCP externes"
      class="fixed inset-0 z-[6000] flex items-center justify-center bg-slate-900/80 p-4"
      @click.self="rg.closeMcpManager"
    >
      <div
        class="bg-white rounded-2xl shadow-2xl ring-1 ring-slate-200 w-full max-w-lg overflow-hidden flex flex-col max-h-[80vh]"
      >
        <div class="p-5 border-b border-slate-200 flex justify-between items-center shrink-0">
          <h3 class="text-lg font-bold text-slate-800 flex items-center gap-2">
            <div class="w-8 h-8 bg-blue-50 text-blue-600 rounded-lg flex items-center justify-center">
              <i class="ph ph-plug"></i>
            </div>
            Serveurs MCP externes
          </h3>
          <button
            aria-label="Fermer"
            class="w-8 h-8 rounded-lg text-slate-400 hover:bg-slate-100 flex items-center justify-center transition-colors"
            @click="rg.closeMcpManager"
          >
            <i class="ph ph-x"></i>
          </button>
        </div>
        <div class="flex-1 overflow-y-auto p-5 space-y-5 custom-scrollbar">
          <div class="space-y-4">
            <div class="flex justify-between items-end">
              <h4 class="font-bold text-slate-800 text-sm">Connecteurs enregistrés</h4>
              <span class="text-[10px] font-bold text-slate-400 bg-slate-100 px-2 py-0.5 rounded"
                >{{ rg.filteredMcpServers.length }} / {{ (rg.settings.mcp_servers || []).length }}</span
              >
            </div>
            <div v-if="rg.settings.mcp_servers && rg.settings.mcp_servers.length > 4" class="relative">
              <i
                class="ph ph-magnifying-glass absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400 text-xs"
              ></i>
              <input
                v-model="rg.mcpSearch"
                type="text"
                placeholder="Rechercher un serveur..."
                class="w-full pl-7 pr-2 py-1.5 bg-slate-50 border border-slate-200 rounded-md text-xs focus:border-blue-500 outline-none"
              />
            </div>
            <div
              v-if="rg.filteredMcpServers.length > 0"
              class="space-y-2 overflow-y-auto custom-scrollbar"
              style="max-height: 420px"
            >
              <div
                v-for="srv in rg.filteredMcpServers"
                :key="srv.id || srv._idx"
                class="flex items-center gap-3 bg-slate-50 p-2.5 rounded-lg border border-slate-200 group"
              >
                <div
                  class="w-8 h-8 rounded-md bg-white flex items-center justify-center border border-slate-100 text-slate-500 shrink-0"
                >
                  <i class="ph text-lg" :class="srv.type === 'stdio' ? 'ph-terminal-window' : 'ph-globe'"></i>
                </div>
                <div class="flex-1 min-w-0">
                  <div
                    class="font-bold text-sm text-slate-800 truncate flex items-center gap-1.5"
                    :class="!srv.visible && 'opacity-50'"
                  >
                    {{ srv.name }}
                    <span
                      v-if="rg.mcpHasCreds(srv)"
                      title="Identifiants gérés côté serveur"
                      class="text-[9.5px] font-semibold px-1 py-0.5 rounded bg-emerald-50 text-emerald-700 border border-emerald-100"
                      >auth</span
                    >
                  </div>
                  <div
                    class="text-[10px] text-slate-500 font-mono truncate"
                    :class="!srv.visible && 'opacity-50'"
                  >
                    {{ srv.type === "stdio" ? "> " + srv.command : srv.url }}
                  </div>
                </div>
                <button
                  class="w-7 h-7 flex items-center justify-center rounded hover:bg-slate-200 transition-colors"
                  :class="srv.visible ? 'text-blue-600' : 'text-slate-400'"
                  @click="rg.toggleServerVisibility(srv._idx)"
                >
                  <i class="ph" :class="srv.visible ? 'ph-eye' : 'ph-eye-slash'"></i>
                </button>
                <button
                  v-if="rg.user && rg.user.role === 'admin'"
                  class="w-7 h-7 flex items-center justify-center rounded hover:bg-slate-200 text-slate-400 hover:text-slate-700 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 transition-all"
                  title="Modifier (admin)"
                  @click="rg.editMcpServer(srv._idx)"
                >
                  <i class="ph ph-pencil-simple"></i>
                </button>
                <button
                  v-if="rg.user && rg.user.role === 'admin'"
                  class="w-7 h-7 flex items-center justify-center rounded hover:bg-red-100 text-slate-400 hover:text-red-600 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 transition-all"
                  title="Supprimer (admin)"
                  @click="rg.removeMcpServer(srv._idx)"
                >
                  <i class="ph ph-trash"></i>
                </button>
              </div>
            </div>
            <div
              v-else-if="rg.mcpSearch"
              class="text-center py-6 bg-slate-50 rounded-lg border border-dashed border-slate-200 text-xs text-slate-400"
            >
              Aucun résultat pour "{{ rg.mcpSearch }}".
            </div>
            <div
              v-else
              class="text-center py-6 bg-slate-50 rounded-lg border border-dashed border-slate-200 text-xs text-slate-400"
            >
              Aucun serveur enregistré.
            </div>
          </div>

          <div class="space-y-2">
            <div class="flex justify-between items-end">
              <div>
                <h4 class="font-bold text-slate-800 text-sm">Bibliothèque partagée</h4>
                <p class="text-[11px] text-slate-500">
                  Publiée pour tous. L'œil l'affiche dans votre panneau MCP.
                </p>
              </div>
              <button
                v-if="rg.user && rg.user.role === 'admin'"
                class="bg-slate-100 text-slate-700 px-2.5 py-1 rounded-lg text-xs font-bold hover:bg-slate-200 transition-colors shrink-0"
                @click="rg.newSharedMcp()"
              >
                <i class="ph ph-plus"></i> Publier
              </button>
            </div>

            <div v-if="(rg.sharedMcpServers || []).length" class="space-y-2">
              <div
                v-for="srv in rg.sharedMcpServers"
                :key="srv.id"
                class="flex items-center gap-3 bg-slate-50 p-2.5 rounded-lg border border-slate-200 group"
              >
                <div
                  class="w-8 h-8 rounded-md bg-white flex items-center justify-center border border-slate-100 text-slate-500 shrink-0"
                >
                  <i class="ph text-lg" :class="srv.type === 'stdio' ? 'ph-terminal-window' : 'ph-globe'"></i>
                </div>
                <div class="flex-1 min-w-0">
                  <div
                    class="font-bold text-sm text-slate-800 truncate flex items-center gap-1.5"
                    :class="!rg.isSharedVisible(srv.id) && 'opacity-50'"
                  >
                    {{ srv.name }}
                    <span
                      v-if="rg.mcpHasCreds(srv)"
                      title="Identifiants gérés côté serveur"
                      class="text-[9.5px] font-semibold px-1 py-0.5 rounded bg-emerald-50 text-emerald-700 border border-emerald-100"
                      >auth</span
                    >
                    <span
                      v-if="!srv.enabled"
                      class="text-[9.5px] font-semibold px-1 py-0.5 rounded bg-slate-200 text-slate-600"
                      >désactivé</span
                    >
                  </div>

                  <div
                    class="text-[10px] text-slate-500 font-mono truncate"
                    :class="!rg.isSharedVisible(srv.id) && 'opacity-50'"
                  >
                    {{
                      srv.url || srv.command || (srv.type === "stdio" ? "serveur local" : "serveur distant")
                    }}
                  </div>
                </div>
                <button
                  :title="
                    rg.isSharedVisible(srv.id) ? 'Masquer du panneau MCP' : 'Afficher dans le panneau MCP'
                  "
                  class="w-7 h-7 flex items-center justify-center rounded hover:bg-slate-200 transition-colors"
                  :class="rg.isSharedVisible(srv.id) ? 'text-blue-600' : 'text-slate-400'"
                  @click="rg.toggleSharedVisibility(srv.id)"
                >
                  <i class="ph" :class="rg.isSharedVisible(srv.id) ? 'ph-eye' : 'ph-eye-slash'"></i>
                </button>
                <button
                  v-if="rg.user && rg.user.role === 'admin'"
                  title="Modifier (admin)"
                  class="w-7 h-7 flex items-center justify-center rounded hover:bg-slate-200 text-slate-400 hover:text-slate-700 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 transition-all"
                  @click="rg.editSharedMcp(srv)"
                >
                  <i class="ph ph-pencil-simple"></i>
                </button>
                <button
                  v-if="rg.user && rg.user.role === 'admin'"
                  title="Dépublier (admin)"
                  class="w-7 h-7 flex items-center justify-center rounded hover:bg-red-100 text-slate-400 hover:text-red-600 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 transition-all"
                  @click="rg.deleteSharedMcp(srv)"
                >
                  <i class="ph ph-trash"></i>
                </button>
              </div>
            </div>
            <div
              v-else
              class="text-center py-4 bg-slate-50 rounded-lg border border-dashed border-slate-200 text-xs text-slate-400"
            >
              Aucun serveur publié.<span v-if="!(rg.user && rg.user.role === 'admin')">
                Un administrateur peut en publier pour tout le monde.</span
              >
            </div>

            <div
              v-if="rg.sharedMcpForm"
              class="bg-blue-50/50 p-3 rounded-xl border border-blue-100 space-y-2"
            >
              <div class="flex items-center justify-between">
                <div class="text-xs font-semibold text-slate-600">
                  {{ rg.sharedMcpForm.id ? "Modifier" : "Publier un serveur" }}
                </div>

                <select
                  class="text-[10px] py-0.5 px-1.5 rounded border border-slate-200 bg-white outline-none text-slate-600"
                  @change="
                    rg.applyMcpPreset('shared', ($event.target as HTMLInputElement).value);
                    ($event.target as HTMLInputElement).value = '';
                  "
                >
                  <option value="">Recette…</option>
                  <option value="wikijs">Wiki.js</option>
                  <option value="wikijs_local">Wiki.js local</option>
                  <option value="jenkins">Jenkins</option>
                </select>
              </div>
              <div class="flex gap-2">
                <input
                  v-model="rg.sharedMcpForm.name"
                  placeholder="Nom (ex: Jenkins)"
                  class="w-1/3 bg-white border border-slate-200 rounded-md p-1.5 text-xs focus:border-blue-500 outline-none"
                />
                <select
                  v-model="rg.sharedMcpForm.type"
                  class="w-1/4 bg-white border border-slate-200 rounded-md p-1.5 text-xs focus:border-blue-500 outline-none"
                >
                  <option value="http">HTTP</option>
                  <option value="sse">SSE</option>
                  <option value="stdio">Local</option>
                </select>
                <input
                  v-if="rg.sharedMcpForm.type !== 'stdio'"
                  v-model="rg.sharedMcpForm.url"
                  :placeholder="
                    rg.sharedMcpForm.type === 'http' ? 'http://…:4445/mcp' : 'https://…/mcp-server/sse'
                  "
                  class="flex-1 min-w-0 bg-white border border-slate-200 rounded-md p-1.5 text-xs font-mono focus:border-blue-500 outline-none"
                />
                <input
                  v-else
                  v-model="rg.sharedMcpForm.command"
                  placeholder="Commande shell…"
                  class="flex-1 min-w-0 bg-white border border-slate-200 rounded-md p-1.5 text-xs font-mono focus:border-blue-500 outline-none"
                />
              </div>
              <div
                v-if="rg.sharedMcpForm.type !== 'stdio'"
                class="bg-white border border-slate-200 rounded-md p-2"
              >
                <div class="flex items-center justify-between mb-1.5">
                  <span class="text-xs font-semibold text-slate-500">Authentification</span>
                  <select
                    v-model="rg.sharedMcpForm.auth_mode"
                    class="text-[10px] py-0.5 px-1.5 rounded border border-slate-200 bg-white outline-none"
                  >
                    <option value="">Aucune</option>
                    <option value="bearer">Bearer (jeton)</option>
                    <option value="basic">Basic (user + token)</option>
                    <option value="header">Clé d'API (en-tête)</option>
                    <option value="raw">Authorization brut</option>
                  </select>
                </div>
                <div v-if="rg.sharedMcpForm.auth_mode === 'basic'" class="flex gap-1.5">
                  <input
                    v-model="rg.sharedMcpForm.auth_user"
                    placeholder="username"
                    class="w-1/3 bg-slate-50 border border-slate-200 rounded p-1 text-[11px] font-mono outline-none focus:bg-white focus:border-blue-500"
                  />
                  <input
                    v-model="rg.sharedMcpForm.auth_secret"
                    type="password"
                    :placeholder="rg.sharedMcpForm.has_auth ? 'inchangé' : 'API token / password'"
                    class="flex-1 bg-slate-50 border border-slate-200 rounded p-1 text-[11px] font-mono outline-none focus:bg-white focus:border-blue-500"
                  />
                </div>
                <div v-else-if="rg.sharedMcpForm.auth_mode === 'bearer'" class="flex gap-1.5">
                  <input
                    v-model="rg.sharedMcpForm.auth_secret"
                    type="password"
                    :placeholder="rg.sharedMcpForm.has_auth ? 'inchangé' : 'jeton seul, sans « Bearer »'"
                    class="flex-1 bg-slate-50 border border-slate-200 rounded p-1 text-[11px] font-mono outline-none focus:bg-white focus:border-blue-500"
                  />
                </div>
                <div v-else-if="rg.sharedMcpForm.auth_mode === 'header'" class="flex gap-1.5">
                  <input
                    v-model="rg.sharedMcpForm.auth_user"
                    placeholder="X-API-Key"
                    class="w-1/3 bg-slate-50 border border-slate-200 rounded p-1 text-[11px] font-mono outline-none focus:bg-white focus:border-blue-500"
                  />
                  <input
                    v-model="rg.sharedMcpForm.auth_secret"
                    type="password"
                    :placeholder="rg.sharedMcpForm.has_auth ? 'inchangé' : 'valeur de la clé'"
                    class="flex-1 bg-slate-50 border border-slate-200 rounded p-1 text-[11px] font-mono outline-none focus:bg-white focus:border-blue-500"
                  />
                </div>
                <div v-else-if="rg.sharedMcpForm.auth_mode === 'raw'" class="flex gap-1.5">
                  <input
                    v-model="rg.sharedMcpForm.auth_secret"
                    type="password"
                    :placeholder="
                      rg.sharedMcpForm.has_auth ? 'inchangé' : 'Bearer eyJ… ou Basic dXNlcjpwYXNz'
                    "
                    class="flex-1 bg-slate-50 border border-slate-200 rounded p-1 text-[11px] font-mono outline-none focus:bg-white focus:border-blue-500"
                  />
                </div>
                <div v-else class="text-[10px] text-slate-400 italic px-1">Aucun header d'auth envoyé.</div>

                <div class="mt-2 pt-2 border-t border-slate-100">
                  <div class="flex items-center justify-between mb-1">
                    <span class="text-[11px] font-semibold text-slate-500">En-têtes</span>
                    <button
                      type="button"
                      title="Ajouter un en-tête"
                      class="w-5 h-5 flex items-center justify-center rounded text-slate-500 hover:bg-slate-100 border border-slate-200"
                      @click="rg.mcpAddPair(rg.sharedMcpForm, 'headers')"
                    >
                      <i class="ph ph-plus text-[10px]"></i>
                    </button>
                  </div>
                  <div
                    v-for="(h, hi) in rg.sharedMcpForm.headers || []"
                    :key="'sh' + hi"
                    class="flex gap-1.5 mb-1"
                  >
                    <input
                      v-model="h.name"
                      placeholder="X-API-Key"
                      class="w-1/3 bg-slate-50 border border-slate-200 rounded p-1 text-[11px] font-mono outline-none focus:bg-white focus:border-blue-500"
                    />
                    <input
                      v-model="h.value"
                      type="password"
                      :placeholder="h.has_value ? 'inchangé' : 'valeur'"
                      class="flex-1 min-w-0 bg-slate-50 border border-slate-200 rounded p-1 text-[11px] font-mono outline-none focus:bg-white focus:border-blue-500"
                    />
                    <button
                      type="button"
                      title="Retirer"
                      class="w-5 h-5 shrink-0 flex items-center justify-center rounded text-slate-400 hover:bg-red-50 hover:text-red-600"
                      @click="rg.mcpRemovePair(rg.sharedMcpForm, 'headers', hi)"
                    >
                      <i class="ph ph-x text-[10px]"></i>
                    </button>
                  </div>
                  <div
                    v-if="!(rg.sharedMcpForm.headers || []).length"
                    class="text-[10px] text-slate-400 italic px-1"
                  >
                    Aucun.
                  </div>
                </div>
              </div>

              <div v-else class="bg-white border border-slate-200 rounded-md p-2">
                <div class="flex items-center justify-between mb-1">
                  <span class="text-xs font-semibold text-slate-500">Variables</span>
                  <button
                    type="button"
                    title="Ajouter une variable"
                    class="w-5 h-5 flex items-center justify-center rounded text-slate-500 hover:bg-slate-100 border border-slate-200"
                    @click="rg.mcpAddPair(rg.sharedMcpForm, 'env')"
                  >
                    <i class="ph ph-plus text-[10px]"></i>
                  </button>
                </div>
                <div v-for="(e, ei) in rg.sharedMcpForm.env || []" :key="'se' + ei" class="flex gap-1.5 mb-1">
                  <input
                    v-model="e.name"
                    placeholder="WIKIJS_TOKEN"
                    class="w-1/3 bg-slate-50 border border-slate-200 rounded p-1 text-[11px] font-mono outline-none focus:bg-white focus:border-blue-500"
                  />
                  <input
                    v-model="e.value"
                    type="password"
                    :placeholder="e.has_value ? 'inchangé' : 'valeur'"
                    class="flex-1 min-w-0 bg-slate-50 border border-slate-200 rounded p-1 text-[11px] font-mono outline-none focus:bg-white focus:border-blue-500"
                  />
                  <button
                    type="button"
                    title="Retirer"
                    class="w-5 h-5 shrink-0 flex items-center justify-center rounded text-slate-400 hover:bg-red-50 hover:text-red-600"
                    @click="rg.mcpRemovePair(rg.sharedMcpForm, 'env', ei)"
                  >
                    <i class="ph ph-x text-[10px]"></i>
                  </button>
                </div>
                <div
                  v-if="!(rg.sharedMcpForm.env || []).length"
                  class="text-[10px] text-slate-400 italic px-1"
                >
                  Aucune.
                </div>
              </div>
              <div class="flex items-center justify-between gap-2">
                <label class="flex items-center gap-2 text-[11px] text-slate-600 cursor-pointer">
                  <input v-model="rg.sharedMcpForm.enabled" type="checkbox" class="accent-blue-600" />
                  Actif
                </label>
                <div class="flex items-center gap-2">
                  <span
                    v-if="rg.mcpTest.scope === 'shared' && rg.mcpTest.msg"
                    class="text-[11px] font-medium"
                    :class="rg.mcpTest.ok ? 'text-emerald-700' : 'text-red-600'"
                  >
                    <i class="ph" :class="rg.mcpTest.ok ? 'ph-check-circle' : 'ph-warning-circle'"></i>
                    {{ rg.mcpTest.msg }}
                  </span>
                  <span v-if="rg.sharedMcpError" class="text-[11px] text-red-600">{{
                    rg.sharedMcpError
                  }}</span>
                  <button
                    :disabled="rg.mcpTest.busy"
                    class="px-2.5 py-1 rounded-md text-xs font-medium text-slate-600 hover:bg-slate-100 disabled:opacity-50"
                    @click="rg.testMcpServer('shared')"
                  >
                    <i
                      class="ph"
                      :class="
                        rg.mcpTest.busy && rg.mcpTest.scope === 'shared' ? 'ph-spinner' : 'ph-plugs-connected'
                      "
                    ></i>
                    Tester
                  </button>
                  <button
                    class="px-2.5 py-1 rounded-md text-xs font-medium text-slate-600 hover:bg-slate-100"
                    @click="rg.cancelSharedMcp()"
                  >
                    Annuler
                  </button>
                  <button
                    :disabled="rg.sharedMcpSaving"
                    class="bg-slate-800 text-white px-3 py-1.5 rounded-md text-xs font-bold hover:bg-slate-700 disabled:opacity-50 transition-colors"
                    @click="rg.saveSharedMcp()"
                  >
                    {{
                      rg.sharedMcpSaving ? "Publication…" : rg.sharedMcpForm.id ? "Enregistrer" : "Publier"
                    }}
                  </button>
                </div>
              </div>
            </div>
          </div>

          <div class="bg-white p-4 rounded-xl border border-slate-200 space-y-4">
            <div class="flex justify-between items-center">
              <div>
                <h4 class="font-bold text-slate-800 text-sm">Serveurs Custom</h4>
                <p class="text-[11px] text-slate-500">Hébergez vos propres outils.</p>
              </div>
              <button
                class="bg-slate-100 text-slate-700 px-3 py-1.5 rounded-lg text-xs font-bold hover:bg-slate-200 transition-colors"
                @click="rg.triggerMcpUpload"
              >
                <i class="ph ph-upload-simple"></i> Uploader
              </button>
              <input
                :ref="
                  (el) => {
                    rg.mcpFileInput = el as typeof rg.mcpFileInput;
                  }
                "
                type="file"
                webkitdirectory
                directory
                multiple
                class="hidden"
                @change="rg.handleMcpUpload"
              />
            </div>
            <div
              v-if="rg.customMcpList.length === 0"
              class="text-center py-3 bg-slate-50 rounded-lg border border-dashed border-slate-200 text-xs text-slate-400"
            >
              Aucun serveur installé.
            </div>
            <div v-else class="grid grid-cols-1 gap-2 max-h-32 overflow-y-auto custom-scrollbar">
              <div
                v-for="srv in rg.customMcpList"
                :key="srv.name"
                class="flex items-center justify-between bg-slate-50 p-2 rounded-lg border border-slate-200 group"
              >
                <div class="flex items-center gap-2">
                  <i class="ph ph-folder text-orange-500"></i
                  ><span class="text-xs font-medium text-slate-700">{{ srv.name }}</span>
                </div>
                <div
                  class="flex gap-1 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity"
                >
                  <button
                    class="w-6 h-6 bg-white rounded text-blue-600 border border-slate-200 hover:bg-blue-50 text-xs"
                    @click="rg.useCustomServer(srv)"
                  >
                    <i class="ph ph-plus"></i>
                  </button>
                  <button
                    class="w-6 h-6 bg-white rounded text-red-500 border border-slate-200 hover:bg-red-50 text-xs"
                    @click="rg.deleteCustomServer(srv.name)"
                  >
                    <i class="ph ph-trash"></i>
                  </button>
                </div>
              </div>
            </div>
          </div>

          <div class="bg-blue-50/50 p-4 rounded-xl border border-blue-100">
            <div class="flex items-center justify-between mb-2">
              <div class="text-xs font-semibold text-slate-500">
                {{ rg.newMcp._idx != null ? "Modifier" : "Ajouter manuellement" }}
              </div>

              <select
                class="text-[10px] py-0.5 px-1.5 rounded border border-slate-200 bg-white outline-none text-slate-600"
                @change="
                  rg.applyMcpPreset('perso', ($event.target as HTMLInputElement).value);
                  ($event.target as HTMLInputElement).value = '';
                "
              >
                <option value="">Recette…</option>
                <option value="wikijs">Wiki.js</option>
                <option value="wikijs_local">Wiki.js local</option>
                <option value="jenkins">Jenkins</option>
              </select>
            </div>
            <div class="flex gap-2 mb-2">
              <input
                v-model="rg.newMcp.name"
                placeholder="Nom (ex: Git)"
                class="w-1/3 bg-white border border-slate-200 rounded-md p-1.5 text-xs focus:border-blue-500 outline-none"
              />
              <select
                v-model="rg.newMcp.type"
                class="w-1/4 bg-white border border-slate-200 rounded-md p-1.5 text-xs focus:border-blue-500 outline-none"
              >
                <option value="http">HTTP</option>
                <option value="sse">SSE</option>
                <option v-if="rg.user && rg.user.role === 'admin'" value="stdio">Local</option>
              </select>
            </div>
            <div class="flex gap-2 mb-2">
              <input
                v-if="rg.newMcp.type !== 'stdio'"
                v-model="rg.newMcp.url"
                :placeholder="rg.newMcp.type === 'http' ? 'http://…:4445/mcp' : 'URL...'"
                class="flex-1 bg-white border border-slate-200 rounded-md p-1.5 text-xs font-mono focus:border-blue-500 outline-none"
              />
              <input
                v-else
                v-model="rg.newMcp.command"
                placeholder="Commande shell..."
                class="flex-1 bg-white border border-slate-200 rounded-md p-1.5 text-xs font-mono focus:border-blue-500 outline-none"
              />
            </div>

            <div
              v-if="rg.newMcp.type !== 'stdio'"
              class="bg-white border border-slate-200 rounded-md p-2 mb-2"
            >
              <div class="flex items-center justify-between mb-1.5">
                <span class="text-xs font-semibold text-slate-500">Authentification</span>
                <select
                  v-model="rg.newMcp.auth_mode"
                  class="text-[10px] py-0.5 px-1.5 rounded border border-slate-200 bg-white outline-none"
                >
                  <option value="">Aucune</option>
                  <option value="bearer">Bearer (jeton)</option>
                  <option value="basic">Basic (user + token)</option>
                  <option value="header">Clé d'API (en-tête)</option>
                  <option value="raw">Authorization brut</option>
                </select>
              </div>
              <div v-if="rg.newMcp.auth_mode === 'basic'" class="flex gap-1.5">
                <input
                  v-model="rg.newMcp.auth_user"
                  placeholder="username"
                  class="w-1/3 bg-slate-50 border border-slate-200 rounded p-1 text-[11px] font-mono outline-none focus:bg-white focus:border-blue-500"
                />
                <input
                  v-model="rg.newMcp.auth_secret"
                  type="password"
                  :placeholder="rg.newMcp.has_auth ? 'inchangé' : 'API token / password'"
                  class="flex-1 bg-slate-50 border border-slate-200 rounded p-1 text-[11px] font-mono outline-none focus:bg-white focus:border-blue-500"
                />
              </div>
              <div v-else-if="rg.newMcp.auth_mode === 'bearer'" class="flex gap-1.5">
                <input
                  v-model="rg.newMcp.auth_secret"
                  type="password"
                  :placeholder="rg.newMcp.has_auth ? 'inchangé' : 'jeton seul, sans « Bearer »'"
                  class="flex-1 bg-slate-50 border border-slate-200 rounded p-1 text-[11px] font-mono outline-none focus:bg-white focus:border-blue-500"
                />
              </div>
              <div v-else-if="rg.newMcp.auth_mode === 'header'" class="flex gap-1.5">
                <input
                  v-model="rg.newMcp.auth_user"
                  placeholder="X-API-Key"
                  class="w-1/3 bg-slate-50 border border-slate-200 rounded p-1 text-[11px] font-mono outline-none focus:bg-white focus:border-blue-500"
                />
                <input
                  v-model="rg.newMcp.auth_secret"
                  type="password"
                  :placeholder="rg.newMcp.has_auth ? 'inchangé' : 'valeur de la clé'"
                  class="flex-1 bg-slate-50 border border-slate-200 rounded p-1 text-[11px] font-mono outline-none focus:bg-white focus:border-blue-500"
                />
              </div>
              <div v-else-if="rg.newMcp.auth_mode === 'raw'" class="flex gap-1.5">
                <input
                  v-model="rg.newMcp.auth_secret"
                  type="password"
                  :placeholder="rg.newMcp.has_auth ? 'inchangé' : 'Bearer eyJ... ou Basic dXNlcjpwYXNz'"
                  class="flex-1 bg-slate-50 border border-slate-200 rounded p-1 text-[11px] font-mono outline-none focus:bg-white focus:border-blue-500"
                />
              </div>
              <div v-else class="text-[10px] text-slate-400 italic px-1">Aucun header d'auth envoyé.</div>

              <div class="mt-2 pt-2 border-t border-slate-100">
                <div class="flex items-center justify-between mb-1">
                  <span class="text-[11px] font-semibold text-slate-500">En-têtes</span>
                  <button
                    type="button"
                    title="Ajouter un en-tête"
                    class="w-5 h-5 flex items-center justify-center rounded text-slate-500 hover:bg-slate-100 border border-slate-200"
                    @click="rg.mcpAddPair(rg.newMcp, 'headers')"
                  >
                    <i class="ph ph-plus text-[10px]"></i>
                  </button>
                </div>
                <div v-for="(h, hi) in rg.newMcp.headers || []" :key="'ph' + hi" class="flex gap-1.5 mb-1">
                  <input
                    v-model="h.name"
                    placeholder="X-API-Key"
                    class="w-1/3 bg-slate-50 border border-slate-200 rounded p-1 text-[11px] font-mono outline-none focus:bg-white focus:border-blue-500"
                  />
                  <input
                    v-model="h.value"
                    type="password"
                    :placeholder="h.has_value ? 'inchangé' : 'valeur'"
                    class="flex-1 min-w-0 bg-slate-50 border border-slate-200 rounded p-1 text-[11px] font-mono outline-none focus:bg-white focus:border-blue-500"
                  />
                  <button
                    type="button"
                    title="Retirer"
                    class="w-5 h-5 shrink-0 flex items-center justify-center rounded text-slate-400 hover:bg-red-50 hover:text-red-600"
                    @click="rg.mcpRemovePair(rg.newMcp, 'headers', hi)"
                  >
                    <i class="ph ph-x text-[10px]"></i>
                  </button>
                </div>
                <div v-if="!(rg.newMcp.headers || []).length" class="text-[10px] text-slate-400 italic px-1">
                  Aucun.
                </div>
              </div>
            </div>

            <div v-else class="bg-white border border-slate-200 rounded-md p-2 mb-2">
              <div class="flex items-center justify-between mb-1">
                <span class="text-xs font-semibold text-slate-500">Variables</span>
                <button
                  type="button"
                  title="Ajouter une variable"
                  class="w-5 h-5 flex items-center justify-center rounded text-slate-500 hover:bg-slate-100 border border-slate-200"
                  @click="rg.mcpAddPair(rg.newMcp, 'env')"
                >
                  <i class="ph ph-plus text-[10px]"></i>
                </button>
              </div>
              <div v-for="(e, ei) in rg.newMcp.env || []" :key="'pe' + ei" class="flex gap-1.5 mb-1">
                <input
                  v-model="e.name"
                  placeholder="WIKIJS_TOKEN"
                  class="w-1/3 bg-slate-50 border border-slate-200 rounded p-1 text-[11px] font-mono outline-none focus:bg-white focus:border-blue-500"
                />
                <input
                  v-model="e.value"
                  type="password"
                  :placeholder="e.has_value ? 'inchangé' : 'valeur'"
                  class="flex-1 min-w-0 bg-slate-50 border border-slate-200 rounded p-1 text-[11px] font-mono outline-none focus:bg-white focus:border-blue-500"
                />
                <button
                  type="button"
                  title="Retirer"
                  class="w-5 h-5 shrink-0 flex items-center justify-center rounded text-slate-400 hover:bg-red-50 hover:text-red-600"
                  @click="rg.mcpRemovePair(rg.newMcp, 'env', ei)"
                >
                  <i class="ph ph-x text-[10px]"></i>
                </button>
              </div>
              <div v-if="!(rg.newMcp.env || []).length" class="text-[10px] text-slate-400 italic px-1">
                Aucune.
              </div>
            </div>
            <div class="flex justify-end items-center gap-2">
              <span
                v-if="rg.mcpTest.scope === 'perso' && rg.mcpTest.msg"
                class="text-[11px] font-medium mr-auto"
                :class="rg.mcpTest.ok ? 'text-emerald-700' : 'text-red-600'"
              >
                <i class="ph" :class="rg.mcpTest.ok ? 'ph-check-circle' : 'ph-warning-circle'"></i>
                {{ rg.mcpTest.msg }}
              </span>
              <button
                :disabled="rg.mcpTest.busy"
                class="px-2.5 py-1 rounded-md text-xs font-medium text-slate-600 hover:bg-slate-100 disabled:opacity-50"
                @click="rg.testMcpServer('perso')"
              >
                <i
                  class="ph"
                  :class="
                    rg.mcpTest.busy && rg.mcpTest.scope === 'perso' ? 'ph-spinner' : 'ph-plugs-connected'
                  "
                ></i>
                Tester
              </button>
              <button
                v-if="rg.newMcp._idx != null"
                class="px-2.5 py-1 rounded-md text-xs font-medium text-slate-600 hover:bg-slate-100"
                @click="rg.cancelMcpEdit()"
              >
                Annuler
              </button>
              <button
                class="bg-slate-800 text-white px-3 py-1.5 rounded-md text-xs font-bold hover:bg-slate-700 transition-colors"
                @click="rg.addMcpServer"
              >
                <i class="ph" :class="rg.newMcp._idx != null ? 'ph-check' : 'ph-plus'"></i>
                {{ rg.newMcp._idx != null ? "Enregistrer" : "Ajouter" }}
              </button>
            </div>
          </div>
        </div>
        <div class="p-4 border-t border-slate-200 bg-white flex justify-end shrink-0">
          <button
            class="px-4 py-2 bg-blue-600 text-white hover:bg-blue-700 rounded-lg font-medium text-sm transition-colors shadow-sm"
            @click="rg.closeMcpManager"
          >
            Fermer
          </button>
        </div>
      </div>
    </div>
  </Transition>
</template>
