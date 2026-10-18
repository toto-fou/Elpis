<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/admin/PageSousAgents.vue — page Sandbox › Sous-agents : lecture seule par type (défaut, imposition) et sous-agents simultanés par tour. -->
<script setup lang="ts">
import { domaineAdmin } from "../../features/admin/domaine";

const adm = domaineAdmin();
</script>

<template>
  <div v-if="adm.adminTab === 'sandbox-agents'" class="animate-[fadeIn_0.2s]">
    <div class="space-y-6 min-w-0">
      <section id="sandbox-agents-ro" class="adm-card scroll-mt-32">
        <header class="adm-card__head">
          <i class="ph ph-lock-simple adm-card__icon" aria-hidden="true"></i>
          <div>
            <h3 class="adm-card__title">Lecture seule</h3>
            <p class="adm-card__hint">
              Un sous-agent en lecture seule n'écrit aucun fichier, ne fait aucun commit et ne lance ni tâche
              de fond ni shell. Par défaut : le compte peut la lever dans Paramètres › Agents. Imposée : ni le
              compte ni l'agent principal ne la lèvent.
            </p>
          </div>
        </header>
        <div class="adm-rows">
          <div class="adm-row" data-agent-type="explore">
            <div>
              <span class="adm-row__label font-mono" title="Explore le code et répond, sans rien modifier."
                >explore</span
              >
              <span class="sr-only">Explore le code et répond, sans rien modifier.</span>
            </div>
            <div class="flex items-center gap-6 flex-wrap">
              <label class="relative inline-flex items-center gap-2 cursor-pointer w-fit">
                <input
                  id="ag-ro-defaut-explore"
                  v-model="adm.agentsConfig.read_only.defaults.explore"
                  type="checkbox"
                  data-field="agents:read_only.defaults.explore"
                  aria-label="Lecture seule par défaut"
                  class="sr-only peer"
                />
                <span
                  class="set-switch-track block peer-checked:bg-blue-600 peer-checked:border-blue-600"
                ></span>
                <span class="text-sm text-slate-700">Lecture seule par défaut</span>
              </label>
              <label class="relative inline-flex items-center gap-2 cursor-pointer w-fit">
                <input
                  id="ag-ro-impose-explore"
                  v-model="adm.agentsConfig.read_only.forced.explore"
                  type="checkbox"
                  data-field="agents:read_only.forced.explore"
                  aria-label="Imposer"
                  class="sr-only peer"
                />
                <span
                  class="set-switch-track block peer-checked:bg-blue-600 peer-checked:border-blue-600"
                ></span>
                <span class="text-sm text-slate-700">Imposer</span>
              </label>
            </div>
          </div>
          <div class="adm-row" data-agent-type="implement">
            <div>
              <span
                class="adm-row__label font-mono"
                title="Écrit la modification et la vérifie, sans commiter."
                >implement</span
              >
              <span class="sr-only">Écrit la modification et la vérifie, sans commiter.</span>
            </div>
            <div class="flex items-center gap-6 flex-wrap">
              <label class="relative inline-flex items-center gap-2 cursor-pointer w-fit">
                <input
                  id="ag-ro-defaut-implement"
                  v-model="adm.agentsConfig.read_only.defaults.implement"
                  type="checkbox"
                  data-field="agents:read_only.defaults.implement"
                  aria-label="Lecture seule par défaut"
                  class="sr-only peer"
                />
                <span
                  class="set-switch-track block peer-checked:bg-blue-600 peer-checked:border-blue-600"
                ></span>
                <span class="text-sm text-slate-700">Lecture seule par défaut</span>
              </label>
              <label class="relative inline-flex items-center gap-2 cursor-pointer w-fit">
                <input
                  id="ag-ro-impose-implement"
                  v-model="adm.agentsConfig.read_only.forced.implement"
                  type="checkbox"
                  data-field="agents:read_only.forced.implement"
                  aria-label="Imposer"
                  class="sr-only peer"
                />
                <span
                  class="set-switch-track block peer-checked:bg-blue-600 peer-checked:border-blue-600"
                ></span>
                <span class="text-sm text-slate-700">Imposer</span>
              </label>
            </div>
          </div>
          <div class="adm-row" data-agent-type="verify">
            <div>
              <span class="adm-row__label font-mono" title="Lance les tests et diagnostique.">verify</span>
              <span class="sr-only">Lance les tests et diagnostique.</span>
            </div>
            <div class="flex items-center gap-6 flex-wrap">
              <label class="relative inline-flex items-center gap-2 cursor-pointer w-fit">
                <input
                  id="ag-ro-defaut-verify"
                  v-model="adm.agentsConfig.read_only.defaults.verify"
                  type="checkbox"
                  data-field="agents:read_only.defaults.verify"
                  aria-label="Lecture seule par défaut"
                  class="sr-only peer"
                />
                <span
                  class="set-switch-track block peer-checked:bg-blue-600 peer-checked:border-blue-600"
                ></span>
                <span class="text-sm text-slate-700">Lecture seule par défaut</span>
              </label>
              <label class="relative inline-flex items-center gap-2 cursor-pointer w-fit">
                <input
                  id="ag-ro-impose-verify"
                  v-model="adm.agentsConfig.read_only.forced.verify"
                  type="checkbox"
                  data-field="agents:read_only.forced.verify"
                  aria-label="Imposer"
                  class="sr-only peer"
                />
                <span
                  class="set-switch-track block peer-checked:bg-blue-600 peer-checked:border-blue-600"
                ></span>
                <span class="text-sm text-slate-700">Imposer</span>
              </label>
            </div>
          </div>
          <div class="adm-row" data-agent-type="web">
            <div>
              <span
                class="adm-row__label font-mono"
                title="Recherche web sur un navigateur réel, avec sources."
                >web</span
              >
              <span class="sr-only">Recherche web sur un navigateur réel, avec sources.</span>
            </div>
            <div class="flex items-center gap-6 flex-wrap">
              <label class="relative inline-flex items-center gap-2 cursor-pointer w-fit">
                <input
                  id="ag-ro-defaut-web"
                  v-model="adm.agentsConfig.read_only.defaults.web"
                  type="checkbox"
                  data-field="agents:read_only.defaults.web"
                  aria-label="Lecture seule par défaut"
                  class="sr-only peer"
                />
                <span
                  class="set-switch-track block peer-checked:bg-blue-600 peer-checked:border-blue-600"
                ></span>
                <span class="text-sm text-slate-700">Lecture seule par défaut</span>
              </label>
              <label class="relative inline-flex items-center gap-2 cursor-pointer w-fit">
                <input
                  id="ag-ro-impose-web"
                  v-model="adm.agentsConfig.read_only.forced.web"
                  type="checkbox"
                  data-field="agents:read_only.forced.web"
                  aria-label="Imposer"
                  class="sr-only peer"
                />
                <span
                  class="set-switch-track block peer-checked:bg-blue-600 peer-checked:border-blue-600"
                ></span>
                <span class="text-sm text-slate-700">Imposer</span>
              </label>
            </div>
          </div>
          <div class="adm-row" data-agent-type="pr">
            <div>
              <span class="adm-row__label font-mono" title="Branche, commite et ouvre la pull request."
                >pr</span
              >
              <span class="sr-only">Branche, commite et ouvre la pull request.</span>
            </div>
            <div class="flex items-center gap-6 flex-wrap">
              <label class="relative inline-flex items-center gap-2 cursor-pointer w-fit">
                <input
                  id="ag-ro-defaut-pr"
                  v-model="adm.agentsConfig.read_only.defaults.pr"
                  type="checkbox"
                  data-field="agents:read_only.defaults.pr"
                  aria-label="Lecture seule par défaut"
                  class="sr-only peer"
                />
                <span
                  class="set-switch-track block peer-checked:bg-blue-600 peer-checked:border-blue-600"
                ></span>
                <span class="text-sm text-slate-700">Lecture seule par défaut</span>
              </label>
              <label class="relative inline-flex items-center gap-2 cursor-pointer w-fit">
                <input
                  id="ag-ro-impose-pr"
                  v-model="adm.agentsConfig.read_only.forced.pr"
                  type="checkbox"
                  data-field="agents:read_only.forced.pr"
                  aria-label="Imposer"
                  class="sr-only peer"
                />
                <span
                  class="set-switch-track block peer-checked:bg-blue-600 peer-checked:border-blue-600"
                ></span>
                <span class="text-sm text-slate-700">Imposer</span>
              </label>
            </div>
          </div>
          <div class="adm-row" data-agent-type="custom">
            <div>
              <span class="adm-row__label" title="Agents créés par les comptes dans Paramètres › Agents."
                >Agents personnalisés</span
              >
              <span class="sr-only">Agents créés par les comptes dans Paramètres › Agents.</span>
            </div>
            <div class="flex items-center gap-6 flex-wrap">
              <label class="relative inline-flex items-center gap-2 cursor-pointer w-fit">
                <input
                  id="ag-ro-defaut-custom"
                  v-model="adm.agentsConfig.read_only.defaults.custom"
                  type="checkbox"
                  data-field="agents:read_only.defaults.custom"
                  aria-label="Lecture seule par défaut"
                  class="sr-only peer"
                />
                <span
                  class="set-switch-track block peer-checked:bg-blue-600 peer-checked:border-blue-600"
                ></span>
                <span class="text-sm text-slate-700">Lecture seule par défaut</span>
              </label>
              <label class="relative inline-flex items-center gap-2 cursor-pointer w-fit">
                <input
                  id="ag-ro-impose-custom"
                  v-model="adm.agentsConfig.read_only.forced.custom"
                  type="checkbox"
                  data-field="agents:read_only.forced.custom"
                  aria-label="Imposer"
                  class="sr-only peer"
                />
                <span
                  class="set-switch-track block peer-checked:bg-blue-600 peer-checked:border-blue-600"
                ></span>
                <span class="text-sm text-slate-700">Imposer</span>
              </label>
            </div>
          </div>
        </div>
      </section>

      <section id="sandbox-agents-parallel" class="adm-card scroll-mt-32">
        <header class="adm-card__head">
          <i class="ph ph-arrows-split adm-card__icon" aria-hidden="true"></i>
          <div>
            <h3 class="adm-card__title">Parallélisme</h3>
            <span class="sr-only"
              >Sous-agents d'un même tour lancés ensemble ; les suivants attendent qu'une place se
              libère.</span
            >
          </div>
        </header>
        <div class="adm-rows">
          <div class="adm-row">
            <div>
              <label
                class="adm-row__label"
                title="Sous-agents d'un même tour lancés ensemble ; les suivants attendent qu'une place se libère."
                for="ag-parallele"
                >Sous-agents simultanés par tour</label
              >
              <span class="sr-only"
                >Sous-agents d'un même tour lancés ensemble ; les suivants attendent qu'une place se
                libère.</span
              >
            </div>
            <div class="flex items-center gap-2">
              <input
                id="ag-parallele"
                v-model.number="adm.agentsConfig.max_parallel"
                data-field="agents:max_parallel"
                type="number"
                :min="adm.agentsBounds[0]"
                :max="adm.agentsBounds[1]"
                class="set-input adm-num font-mono"
              />
              <span class="adm-unit">de {{ adm.agentsBounds[0] }} à {{ adm.agentsBounds[1] }}</span>
            </div>
          </div>
          <p
            v-if="
              !Number.isInteger(adm.agentsConfig.max_parallel) ||
              adm.agentsConfig.max_parallel < adm.agentsBounds[0] ||
              adm.agentsConfig.max_parallel > adm.agentsBounds[1]
            "
            role="alert"
            class="py-2 text-[11px] text-red-600 flex items-center gap-1.5"
          >
            <i class="ph ph-warning-circle shrink-0" aria-hidden="true"></i>
            Un nombre entier de {{ adm.agentsBounds[0] }} à {{ adm.agentsBounds[1] }}.
          </p>
        </div>
      </section>
    </div>
  </div>
</template>
