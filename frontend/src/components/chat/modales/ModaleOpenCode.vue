<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/chat/modales/ModaleOpenCode.vue — installation d'opencode sur le poste (commande par plateforme, archive LAN, familles d'outils publiées, resynchronisation). -->
<script setup lang="ts">
import { domaineModales } from "../../../features/chat/modales/domaine";

const m = domaineModales();
</script>

<template>
  <Transition name="modal">
    <div
      v-if="m.showOpenCodeModal && m.features.opencode"
      data-a11y-modal
      role="dialog"
      aria-modal="true"
      aria-label="OpenCode"
      class="fixed inset-0 z-[6000] flex items-center justify-center bg-slate-900/80 p-4"
      @click.self="m.showOpenCodeModal = false"
    >
      <div class="bg-white rounded-2xl w-full max-w-lg shadow-2xl border border-slate-200 overflow-hidden">
        <div class="px-5 py-4 border-b border-slate-100 flex items-center justify-between">
          <div class="flex items-center gap-3">
            <div class="w-9 h-9 rounded-lg bg-blue-600 flex items-center justify-center text-white">
              <i class="ph ph-terminal text-lg"></i>
            </div>
            <h3 class="text-base font-bold text-slate-900">OpenCode</h3>
          </div>
          <button
            aria-label="Fermer"
            class="w-8 h-8 rounded-lg hover:bg-slate-100 text-slate-500 transition-colors flex items-center justify-center"
            @click="m.showOpenCodeModal = false"
          >
            <i class="ph ph-x text-lg"></i>
          </button>
        </div>
        <div class="p-5 space-y-4">
          <div class="grid grid-cols-3 gap-2">
            <button
              :class="
                m.openCodePlatform === 'linux'
                  ? 'bg-blue-50 border-blue-500 text-blue-700'
                  : 'bg-white border-slate-200 text-slate-700 hover:bg-slate-50'
              "
              class="py-2.5 rounded-lg border-2 transition-all flex flex-col items-center gap-1"
              @click="m.openCodePlatform = 'linux'"
            >
              <i class="ph ph-linux-logo text-xl"></i>
              <span class="text-xs font-semibold">Linux</span>
            </button>
            <button
              :class="
                m.openCodePlatform === 'windows'
                  ? 'bg-blue-50 border-blue-500 text-blue-700'
                  : 'bg-white border-slate-200 text-slate-700 hover:bg-slate-50'
              "
              class="py-2.5 rounded-lg border-2 transition-all flex flex-col items-center gap-1"
              @click="m.openCodePlatform = 'windows'"
            >
              <i class="ph ph-windows-logo text-xl"></i>
              <span class="text-xs font-semibold">Windows</span>
            </button>
            <button
              :class="
                m.openCodePlatform === 'macos'
                  ? 'bg-blue-50 border-blue-500 text-blue-700'
                  : 'bg-white border-slate-200 text-slate-700 hover:bg-slate-50'
              "
              class="py-2.5 rounded-lg border-2 transition-all flex flex-col items-center gap-1"
              @click="m.openCodePlatform = 'macos'"
            >
              <i class="ph ph-apple-logo text-xl"></i>
              <span class="text-xs font-semibold">macOS</span>
            </button>
          </div>
          <!-- Blocs de commande UNIQUEMENT (demande user 2026-09-03) : libellé
                       court, code, bouton Copier — aucun texte explicatif. -->
          <div>
            <div class="text-[11px] font-semibold uppercase tracking-wide text-slate-400 mb-1">
              Installer · mettre à jour
            </div>
            <div
              class="relative bg-slate-900 rounded-lg p-3 pr-20 font-mono text-xs text-green-300 overflow-x-auto border border-slate-800"
            >
              <code class="break-all">{{ m.openCodeCommand }}</code>
              <button
                aria-label="Copier la commande d'installation"
                class="absolute top-1.5 right-1.5 px-2 py-0.5 text-xs bg-slate-800 hover:bg-slate-700 text-white rounded border border-slate-700 flex items-center gap-1 transition-colors"
                @click="m.copyOpenCodeCommand('install')"
              >
                <i :class="m.openCodeCopied === 'install' ? 'ph ph-check text-green-400' : 'ph ph-copy'"></i>
                {{ m.openCodeCopied === "install" ? "Copié" : "Copier" }}
              </button>
            </div>
          </div>
          <!-- Une entrée MCP par famille d'outils côté opencode = une bascule
                       chacune dans son TUI. Ce choix-ci est celui qui DURE : celui du
                       TUI n'est pas persisté et un re-sync réécrit la config. -->
          <div v-if="m.openCodeFamilies.length">
            <div class="text-[11px] font-semibold uppercase tracking-wide text-slate-400 mb-1">Outils</div>
            <div class="flex flex-wrap gap-2">
              <button
                v-for="f in m.openCodeFamilies"
                :key="f.name"
                type="button"
                :aria-pressed="m.opencodeFamilyOn(f.name) ? 'true' : 'false'"
                :class="
                  m.opencodeFamilyOn(f.name)
                    ? 'bg-blue-50 border-blue-500 text-blue-700'
                    : 'bg-white border-slate-200 text-slate-500 hover:bg-slate-50'
                "
                class="px-3 py-1.5 rounded-lg border-2 text-xs font-semibold transition-colors flex items-center gap-1.5"
                @click="m.toggleOpencodeFamily(f.name)"
              >
                <i :class="m.opencodeFamilyOn(f.name) ? 'ph ph-check-circle' : 'ph ph-circle'"></i>
                {{ f.label }}
              </button>
            </div>
          </div>
          <div>
            <div class="text-[11px] font-semibold uppercase tracking-wide text-slate-400 mb-1">
              Config seule
            </div>
            <div
              class="relative bg-slate-900 rounded-lg p-3 pr-20 font-mono text-xs text-green-300 overflow-x-auto border border-slate-800"
            >
              <code class="break-all">{{ m.openCodeSyncCommand }}</code>
              <button
                aria-label="Copier la commande de mise à jour de la config"
                class="absolute top-1.5 right-1.5 px-2 py-0.5 text-xs bg-slate-800 hover:bg-slate-700 text-white rounded border border-slate-700 flex items-center gap-1 transition-colors"
                @click="m.copyOpenCodeCommand('sync')"
              >
                <i :class="m.openCodeCopied === 'sync' ? 'ph ph-check text-green-400' : 'ph ph-copy'"></i>
                {{ m.openCodeCopied === "sync" ? "Copié" : "Copier" }}
              </button>
            </div>
          </div>
          <button
            class="w-full px-4 py-2 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-lg text-sm font-medium transition-colors flex items-center justify-center gap-2"
            @click="m.downloadOpenCodeBundle"
          >
            <i class="ph ph-download-simple"></i>
            Archive {{ m.openCodePlatform === "windows" ? ".zip" : ".tar.gz" }}
          </button>
        </div>
      </div>
    </div>
  </Transition>
</template>
