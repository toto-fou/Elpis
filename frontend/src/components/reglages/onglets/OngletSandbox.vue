<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/reglages/onglets/OngletSandbox.vue — onglet « sandbox » des Paramètres. -->
<script setup lang="ts">
import { domaineReglages } from "../../../features/reglages/domaine";

const rg = domaineReglages();
</script>

<template>
  <!-- eslint-disable vue/multiline-html-element-content-newline -->
  <div class="max-w-2xl">
    <div class="mb-4">
      <h3 class="text-base font-semibold text-slate-800 mb-1">Sandbox</h3>
      <p class="text-xs text-slate-500">
        Container Docker isolé pour Robot Framework, les scripts et le shell. Votre dossier de travail y est
        monté sur <code class="font-mono">/work</code>.
      </p>
    </div>

    <div v-if="rg.transitionState.active" class="set-block">
      <div class="flex items-center gap-3 mb-2.5">
        <div
          v-if="!rg.transitionState.error"
          class="w-4 h-4 border-2 border-blue-500 border-t-transparent rounded-full animate-spin motion-reduce:animate-none shrink-0"
          aria-hidden="true"
        ></div>
        <i v-else class="ph ph-warning-circle text-red-500 text-lg shrink-0" aria-hidden="true"></i>
        <div class="flex-1 min-w-0">
          <div class="text-sm font-medium text-slate-800 truncate">
            {{ rg.transitionState.label }}
          </div>
          <div class="text-xs text-slate-500">
            Étape {{ rg.transitionState.step }} sur {{ rg.transitionState.total }}
          </div>
        </div>
        <div class="text-sm font-semibold text-slate-700 tabular-nums shrink-0">
          {{ Math.round(rg.transitionState.progress) }} %
        </div>
      </div>
      <div
        class="h-1.5 bg-white rounded-full overflow-hidden"
        role="progressbar"
        :aria-valuenow="Math.round(rg.transitionState.progress)"
        aria-valuemin="0"
        aria-valuemax="100"
      >
        <div
          :class="[
            'h-full w-full rounded-full transition-transform duration-500 motion-reduce:transition-none',
            rg.transitionState.error ? 'bg-red-400' : 'bg-blue-500',
          ]"
          :style="{
            transformOrigin: 'left',
            transform: 'scaleX(' + rg.transitionState.progress / 100 + ')',
          }"
        ></div>
      </div>
      <p
        v-if="rg.transitionState.error"
        role="alert"
        class="mt-2.5 text-xs text-red-700 flex items-start gap-1.5"
      >
        <i class="ph ph-warning-circle mt-0.5 shrink-0" aria-hidden="true"></i>
        <span>{{ rg.transitionState.error }}</span>
      </p>
      <details v-if="rg.transitionState.containerLogs" class="mt-2.5">
        <summary class="cursor-pointer text-xs text-slate-500 hover:text-slate-700 transition-colors">
          Journal du container
        </summary>
        <pre
          class="mt-1.5 bg-slate-900 text-slate-100 p-2.5 rounded-lg font-mono text-[11px] leading-relaxed overflow-x-auto max-h-48 whitespace-pre-wrap"
          >{{ rg.transitionState.containerLogs }}</pre>
      </details>
    </div>

    <div v-else class="space-y-2">
      <div class="set-block set-block--flush divide-y divide-slate-100">
        <div class="set-row items-start">
          <div
            v-if="rg.sandboxStatus.tone === 'busy'"
            class="w-2.5 h-2.5 mt-1.5 border-2 border-blue-500 border-t-transparent rounded-full animate-spin motion-reduce:animate-none shrink-0"
            aria-hidden="true"
          ></div>
          <span
            v-else
            :class="['w-2.5 h-2.5 mt-1.5 rounded-full shrink-0', rg.sandboxTone.dot]"
            aria-hidden="true"
          ></span>

          <div class="flex-1 min-w-0">
            <div class="text-sm font-medium text-slate-800">{{ rg.sandboxStatus.label }}</div>
            <div v-if="rg.sandboxStatus.mono" class="font-mono text-[11px] text-slate-500 truncate">
              {{ rg.sandboxStatus.mono }}
            </div>
            <div v-else-if="rg.sandboxStatus.detail && !rg.sandboxTone.alert" class="text-xs text-slate-500">
              {{ rg.sandboxStatus.detail }}
            </div>
          </div>

          <button
            v-if="rg.sandboxStatus.action"
            :disabled="rg.sandboxBusy"
            class="shrink-0 -mt-0.5 px-3 py-1.5 bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 rounded-lg text-xs font-medium transition-colors flex items-center gap-1.5"
            @click="
              rg.sandboxStatus.action === 'start'
                ? rg.restartSandboxContainer('start')
                : rg.changeSandboxMode('docker')
            "
          >
            <i class="ph ph-play" aria-hidden="true"></i> Démarrer
          </button>
          <button
            :disabled="rg.sandboxBusy"
            aria-label="Rafraîchir l'état de la sandbox"
            class="shrink-0 -mt-1 w-8 h-8 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-white flex items-center justify-center transition-colors disabled:opacity-50"
            @click="rg.loadSandboxState()"
          >
            <i class="ph ph-arrow-clockwise" aria-hidden="true"></i>
          </button>
        </div>

        <div v-if="rg.sandboxTone.alert && rg.sandboxStatus.detail" role="alert" class="set-row--sub pt-0">
          <span
            :class="[
              'block rounded-lg px-2.5 py-1.5 text-xs whitespace-pre-wrap break-words',
              rg.sandboxTone.alert,
            ]"
            >{{ rg.sandboxStatus.detail }}</span
          >
        </div>

        <div v-if="rg.sandboxStatus.tone === 'ok' && rg.sandboxState.stats" class="set-row text-xs">
          <span class="w-2.5 shrink-0" aria-hidden="true"></span>
          <div class="flex flex-wrap items-center gap-x-6 gap-y-1">
            <span v-if="rg.sandboxState.stats.cpu" class="text-slate-500"
              >CPU
              <span class="font-medium text-slate-700 tabular-nums">{{
                rg.sandboxState.stats.cpu
              }}</span></span
            >
            <span v-if="rg.sandboxState.stats.mem" class="text-slate-500"
              >RAM
              <span class="font-medium text-slate-700 tabular-nums">{{
                rg.sandboxState.stats.mem
              }}</span></span
            >
            <span v-if="rg.sandboxState.stats.pids" class="text-slate-500"
              >PIDs
              <span class="font-medium text-slate-700 tabular-nums">{{
                rg.sandboxState.stats.pids
              }}</span></span
            >
          </div>
        </div>

        <div
          v-if="rg.sandboxState.network_profiles && rg.sandboxState.network_profiles.length > 1"
          class="set-row"
          data-net-menu
          @keydown="rg.onNetMenuKeydown"
        >
          <span class="w-2.5 shrink-0" aria-hidden="true"></span>
          <span id="sandbox-net-label" class="text-sm text-slate-800 flex-1 min-w-0">
            Réseau
            <span
              v-if="rg.sandboxState.network_profile_locked"
              class="ml-1.5 inline-flex items-center gap-1 text-xs text-slate-500 align-middle"
              title="Profil imposé par l'administrateur"
            >
              <i class="ph ph-lock-simple" aria-hidden="true"></i> Imposé
            </span>
          </span>
          <div class="relative shrink-0">
            <button
              id="sandbox-net-profile"
              type="button"
              :disabled="rg.sandboxBusy || rg.sandboxState.network_profile_locked"
              aria-haspopup="listbox"
              aria-labelledby="sandbox-net-label"
              :aria-expanded="rg.netMenuOpen ? 'true' : 'false'"
              class="flex items-center gap-2 w-56 px-3 py-2 rounded-lg border border-slate-200 bg-white text-sm text-slate-700 hover:border-slate-300 disabled:opacity-60 disabled:cursor-not-allowed focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 transition-colors"
              @click="rg.toggleNetMenu()"
            >
              <span class="flex-1 text-left truncate">{{
                rg.activeNetProfile ? rg.activeNetProfile.name : "—"
              }}</span>
              <span class="text-xs text-slate-500 shrink-0">{{
                rg.netProfileMode(rg.activeNetProfile)
              }}</span>
              <i
                class="ph ph-caret-down text-slate-400 shrink-0 transition-transform motion-reduce:transition-none"
                :class="rg.netMenuOpen && 'rotate-180'"
                aria-hidden="true"
              ></i>
            </button>
            <Transition name="popover">
              <div
                v-if="rg.netMenuOpen"
                role="listbox"
                aria-labelledby="sandbox-net-label"
                class="absolute right-0 top-full mt-2 w-80 max-h-64 overflow-y-auto custom-scrollbar bg-white rounded-xl shadow-2xl border border-slate-200 z-[200]"
              >
                <div
                  v-for="prof in rg.sandboxState.network_profiles"
                  :key="prof.id"
                  role="option"
                  tabindex="0"
                  :aria-selected="prof.id === rg.sandboxState.network_profile_id ? 'true' : 'false'"
                  class="px-3 py-2.5 cursor-pointer border-b border-slate-50 last:border-b-0 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500 transition-colors"
                  :class="prof.id === rg.sandboxState.network_profile_id ? 'bg-blue-50' : 'hover:bg-slate-50'"
                  @click="rg.pickNetProfile(prof.id)"
                  @keydown.enter.prevent="rg.pickNetProfile(prof.id)"
                  @keydown.space.prevent="rg.pickNetProfile(prof.id)"
                >
                  <div class="flex items-center gap-2">
                    <span
                      class="w-1.5 h-1.5 rounded-full shrink-0"
                      :class="
                        prof.id === rg.sandboxState.network_profile_id ? 'bg-blue-500' : 'bg-transparent'
                      "
                      aria-hidden="true"
                    ></span>
                    <span
                      class="text-sm truncate"
                      :class="
                        prof.id === rg.sandboxState.network_profile_id
                          ? 'text-blue-700 font-medium'
                          : 'text-slate-700'
                      "
                      >{{ prof.name }}</span
                    >
                    <span class="ml-auto text-xs text-slate-500 shrink-0">{{ rg.netProfileMode(prof) }}</span>
                  </div>
                  <div class="text-xs text-slate-500 mt-0.5 pl-3.5">
                    {{ rg.netProfileDetail(prof) }}
                  </div>
                </div>
              </div>
            </Transition>
          </div>
        </div>

        <div v-if="rg.activeNetProfile" class="set-row--sub text-xs text-slate-500">
          <span v-if="rg.activeNetProfile.description">{{ rg.activeNetProfile.description }}</span>
          <span v-else-if="rg.activeNetProfile.mode === 'none'">Aucun accès réseau sortant.</span>
          <span v-else-if="rg.activeNetProfile.mode === 'bridge'">Accès réseau complet.</span>
          <span v-else>Accès limité aux adresses listées.</span>
          <div
            v-if="rg.activeNetProfile.mode === 'allowlist_ip' && (rg.activeNetProfile.ips || []).length"
            class="flex flex-wrap gap-1 mt-1.5"
          >
            <span
              v-for="ip in (rg.activeNetProfile.ips || []).slice(0, 8)"
              :key="ip"
              class="font-mono text-[11px] px-1.5 py-0.5 bg-slate-100 text-slate-600 rounded"
              >{{ ip }}</span
            >
            <span
              v-if="(rg.activeNetProfile.ips || []).length > 8"
              class="text-[11px] text-slate-500 px-1 self-center"
              >+{{ (rg.activeNetProfile.ips || []).length - 8 }}</span
            >
          </div>
        </div>

        <div
          v-if="
            rg.sandboxState.effective_mode === 'docker' && rg.sandboxState.daemon_ok && rg.sandboxState.image
          "
          class="set-row items-start"
        >
          <span class="w-2.5 shrink-0" aria-hidden="true"></span>
          <dl class="flex-1 min-w-0 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-xs">
            <dt class="text-slate-500">Image</dt>
            <dd class="font-mono text-[11px] text-slate-700 truncate">
              {{ rg.sandboxState.image }}
            </dd>
            <template v-if="rg.sandboxState.limits && rg.sandboxState.limits.memory_mb">
              <dt class="text-slate-500">RAM max</dt>
              <dd class="text-slate-700 tabular-nums">{{ rg.sandboxState.limits.memory_mb }} Mo</dd>
            </template>
            <template v-if="rg.sandboxState.limits && rg.sandboxState.limits.cpu_quota_pct">
              <dt class="text-slate-500">CPU</dt>
              <dd class="text-slate-700 tabular-nums">{{ rg.sandboxState.limits.cpu_quota_pct }} %</dd>
            </template>
            <template v-if="rg.sandboxState.limits && rg.sandboxState.limits.pids_max">
              <dt class="text-slate-500">PIDs max</dt>
              <dd class="text-slate-700 tabular-nums">{{ rg.sandboxState.limits.pids_max }}</dd>
            </template>
            <template v-if="rg.sandboxState.limits && rg.sandboxState.limits.timeout_s">
              <dt class="text-slate-500">Timeout</dt>
              <dd class="text-slate-700 tabular-nums">{{ rg.sandboxState.limits.timeout_s }} s</dd>
            </template>
          </dl>
        </div>
      </div>

      <div v-if="rg.sandboxStatus.tone === 'ok'" class="flex justify-end gap-2">
        <button
          :disabled="rg.sandboxBusy"
          class="px-3 py-1.5 bg-white text-slate-700 border border-slate-200 hover:bg-slate-50 disabled:opacity-50 rounded-lg text-xs font-medium transition-colors flex items-center gap-1.5"
          @click="rg.restartSandboxContainer('restart')"
        >
          <i class="ph ph-arrows-clockwise" aria-hidden="true"></i> Redémarrer
        </button>
        <button
          :disabled="rg.sandboxBusy"
          class="px-3 py-1.5 bg-white text-red-600 border border-red-200 hover:bg-red-50 disabled:opacity-50 rounded-lg text-xs font-medium transition-colors flex items-center gap-1.5"
          @click="rg.destroySandboxContainer"
        >
          <i class="ph ph-trash" aria-hidden="true"></i> Détruire
        </button>
      </div>
    </div>

    <div class="set-block set-block--flush mt-8">
      <div class="set-row">
        <i class="ph ph-broom text-slate-400 text-lg w-5 shrink-0" aria-hidden="true"></i>
        <div class="flex-1 min-w-0">
          <div class="text-sm text-slate-800">Vider le dossier de travail</div>
          <div class="text-xs text-slate-500">
            Supprime définitivement tous vos fichiers. Vos skills et votre mémoire ne sont pas concernés.
          </div>
        </div>
        <button
          class="shrink-0 px-3 py-1.5 bg-white text-red-600 border border-red-200 hover:bg-red-50 rounded-lg text-xs font-medium transition-colors flex items-center gap-1.5"
          @click="rg.clearSandbox"
        >
          <i class="ph ph-trash" aria-hidden="true"></i> Vider
        </button>
      </div>
    </div>
  </div>
</template>
