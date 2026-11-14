<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/reglages/DetailMcp.vue — volet droit du gestionnaire MCP : en-tête (état, Tester, Enregistrer), garde de saisie, panneau, champs, suppression. -->
<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";

import { domaineReglages } from "../../features/reglages/domaine";
import { ICONES_MCP, MODELES_MCP, TYPES_MCP } from "../../features/reglages/mcp";
import ChampsMcp from "./ChampsMcp.vue";
import EtatMcp from "./EtatMcp.vue";

const rg = domaineReglages();
const admin = computed(() => rg.user?.role === "admin");
const f = computed(() => rg.mcpForm);
const partage = computed(() => f.value?.portee === "partage");
const neuf = computed(() => !!f.value && !f.value.id);
const editable = computed(() => !partage.value || admin.value);
const cleTest = computed(() => f.value?.id || "nouveau");
const test = computed(() => rg.mcpTests[cleTest.value]);
const conseilSecret = computed(() => /\b40[13]\b/.test(test.value?.msg ?? ""));
const serveurPartage = computed(() =>
  partage.value && f.value?.id ? rg.sharedMcpServers.find((s) => s.id === f.value?.id) : undefined,
);
const desactive = computed(() => !!serveurPartage.value && !serveurPartage.value.enabled);
const verbe = computed(() => (partage.value ? "Dépublier" : "Supprimer"));
const modeles = computed(() => MODELES_MCP.filter((m) => m.type !== "stdio" || admin.value));
const libelleEnregistrer = computed(() =>
  rg.mcpOccupe ? "Enregistrement…" : neuf.value ? (partage.value ? "Publier" : "Ajouter") : "Enregistrer",
);
const peutEnregistrer = computed(() => rg.mcpSale && !rg.mcpOccupe);
const racine = ref<HTMLElement | null>(null);
const boutonGarde = ref<HTMLButtonElement | null>(null);
const boutonSupprimer = ref<HTMLButtonElement | null>(null);

// Focus jamais perdu : garde et confirmation le prennent, puis le rendent à la ligne choisie ou au bouton d'origine.
watch(
  () => rg.mcpGarde,
  (g, avant) => {
    if (g) void nextTick(() => boutonGarde.value?.focus());
    else if (avant && rg.showMcpManagerModal)
      void nextTick(() =>
        racine.value
          ?.closest("[role=dialog]")
          ?.querySelector<HTMLElement>('[data-mcp-ligne][aria-current="true"]')
          ?.focus(),
      );
  },
);
watch(
  () => rg.mcpConfirmer,
  (c, avant) => {
    if (!c && avant && rg.mcpSel) void nextTick(() => boutonSupprimer.value?.focus());
  },
);

// Le même bouton demande puis confirme, sans bouger ; un double-clic ne vaut pas confirmation.
let demandeA = 0;
function supprimer(): void {
  if (!rg.mcpConfirmer) {
    demandeA = Date.now();
    rg.mcpDemanderSuppression();
  } else if (Date.now() - demandeA >= 400) void rg.mcpSupprimer();
}

async function enregistrer(): Promise<void> {
  if (!peutEnregistrer.value) return;
  if (!(await rg.mcpEnregistrer()) && Object.keys(rg.mcpErreurs).length)
    void nextTick(() => racine.value?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus());
}
</script>

<template>
  <section ref="racine" class="flex flex-col min-w-0 min-h-0">
    <template v-if="f">
      <div class="relative flex flex-wrap items-center gap-3 px-5 py-3.5 border-b border-slate-200">
        <span
          class="w-10 h-10 rounded-xl bg-slate-100 text-slate-600 flex items-center justify-center shrink-0"
        >
          <i
            class="ph text-xl"
            :class="neuf ? 'ph-plus' : ICONES_MCP[f.type] || 'ph-globe'"
            aria-hidden="true"
          ></i>
        </span>
        <div class="flex-1 min-w-[140px]">
          <h4 class="text-base font-semibold text-slate-800 truncate">{{ f.name || "Nouveau serveur" }}</h4>
          <p class="text-xs text-slate-500 flex items-center gap-1">
            <i v-if="partage" class="ph ph-users-three" aria-hidden="true"></i>
            {{ partage ? "Partagé" : "Mes serveurs" }} · {{ TYPES_MCP[f.type] || f.type
            }}<template v-if="desactive"> · Désactivé</template>
          </p>
        </div>
        <div class="flex items-center gap-2">
          <span v-if="editable" aria-live="polite"
            ><EtatMcp :id="cleTest" pastille :long="!(test && test.ok === false)"
          /></span>
          <button
            v-if="editable"
            type="button"
            class="adm-btn adm-tool"
            :disabled="!!test?.busy"
            title="Éprouver la configuration saisie, sans l'enregistrer"
            @click="rg.mcpTester()"
          >
            <i class="ph" :class="test?.busy ? 'ph-spinner' : 'ph-plugs-connected'" aria-hidden="true"></i>
            Tester
          </button>
          <button
            v-if="editable"
            type="button"
            class="adm-btn elpis-mcp-enr"
            :class="rg.mcpGarde ? 'adm-tool' : 'adm-btn--primary'"
            :aria-disabled="peutEnregistrer ? undefined : 'true'"
            @click="enregistrer()"
          >
            <template v-if="rg.mcpFlash && !rg.mcpSale">
              <i class="ph ph-check" aria-hidden="true"></i>
              {{ rg.mcpFlash }}
            </template>
            <template v-else>{{ libelleEnregistrer }}</template>
          </button>
        </div>
        <span v-if="test?.busy" class="elpis-mcp-fil" aria-hidden="true"></span>
      </div>

      <div
        v-if="rg.mcpGarde"
        role="alert"
        class="flex flex-wrap items-center gap-2 px-5 py-2 bg-amber-50 border-b border-amber-200 text-sm"
      >
        <i class="ph ph-warning text-amber-700" aria-hidden="true"></i>
        <span class="flex-1 font-medium text-slate-700">Modifications non enregistrées</span>
        <button type="button" class="adm-btn adm-btn--quiet adm-btn--sm" @click="rg.mcpAbandonner()">
          Abandonner
        </button>
        <button
          ref="boutonGarde"
          :disabled="rg.mcpOccupe"
          type="button"
          class="adm-btn adm-btn--primary adm-btn--sm"
          @click="rg.mcpGardeEnregistrer()"
        >
          Enregistrer
        </button>
      </div>

      <div class="flex-1 overflow-y-auto custom-scrollbar px-5 py-4 space-y-4">
        <div
          v-if="neuf"
          class="flex flex-wrap items-center gap-1.5 p-2.5 rounded-xl border border-dashed border-slate-200 bg-slate-50 max-w-[600px]"
          role="group"
          aria-label="Partir d'un modèle"
        >
          <span class="text-xs font-semibold text-slate-500 mr-1">Modèle</span>
          <button
            v-for="m in modeles"
            :key="m.cle"
            type="button"
            class="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-full border border-slate-200 bg-white text-[13px] font-medium text-slate-700 hover:border-blue-500 hover:text-blue-600 disabled:opacity-50 disabled:cursor-not-allowed"
            :disabled="m.type === 'stdio' && partage"
            :title="m.type === 'stdio' && partage ? 'Serveur local : portée Moi seulement' : undefined"
            @click="rg.mcpAppliquerModele(m.cle)"
          >
            <i class="ph" :class="ICONES_MCP[m.type]" aria-hidden="true"></i>{{ m.libelle }}
          </button>
        </div>

        <label
          v-if="!neuf && !desactive"
          class="flex items-center gap-2.5 px-3 py-2.5 rounded-xl border border-slate-200 bg-slate-50 cursor-pointer max-w-[600px]"
        >
          <i class="ph ph-sidebar-simple text-slate-500" aria-hidden="true"></i>
          <span class="flex-1 text-[13px] font-medium text-slate-700">Afficher dans le panneau</span>
          <span class="relative inline-flex items-center">
            <input
              type="checkbox"
              class="sr-only peer"
              aria-label="Afficher dans le panneau MCP"
              :checked="rg.mcpEstEpingle(f.portee, f.id)"
              @change="rg.mcpBasculerPanneau()"
            />
            <span class="set-switch-track block peer-checked:bg-blue-600 peer-checked:border-blue-600"></span>
          </span>
        </label>

        <p
          v-if="test && test.ok === false"
          class="flex items-center gap-1.5 px-3 py-2 rounded-lg border border-red-200 bg-red-50 text-[13px] text-red-600 max-w-[600px]"
        >
          <i class="ph ph-warning-circle" aria-hidden="true"></i>
          {{ test.msg }}<template v-if="conseilSecret"> : vérifier le secret (Auth)</template>
        </p>
        <p v-if="rg.mcpErreur" role="alert" class="text-[13px] text-red-600">{{ rg.mcpErreur }}</p>

        <p
          v-if="!editable && f.secret_error"
          class="flex items-center gap-1.5 text-xs text-amber-700 max-w-[600px]"
          role="status"
        >
          <i class="ph ph-warning" aria-hidden="true"></i>Secret de ce serveur partagé inutilisable : demandez
          à un administrateur de le ressaisir.
        </p>
        <ChampsMcp v-if="editable" />
        <dl v-else class="grid grid-cols-[88px_minmax(0,1fr)] gap-x-3 gap-y-2.5 text-[13px] max-w-[600px]">
          <dt class="text-slate-500">Type</dt>
          <dd class="text-slate-700">{{ TYPES_MCP[f.type] || f.type }}</dd>
          <dt class="text-slate-500">Adresse</dt>
          <dd class="font-mono text-xs text-slate-700 break-all">{{ f.url || "—" }}</dd>
          <dt class="text-slate-500">Auth</dt>
          <dd class="text-slate-700 flex items-center gap-1.5">
            <i v-if="f.has_auth" class="ph ph-lock-simple" aria-hidden="true"></i>
            {{ f.has_auth ? "Géré par l'administrateur" : "Sans authentification" }}
          </dd>
        </dl>

        <div
          v-if="!neuf && editable"
          class="flex flex-wrap items-center gap-2 pt-3.5 border-t border-slate-100 max-w-[600px]"
        >
          <button
            ref="boutonSupprimer"
            type="button"
            class="adm-btn"
            :class="rg.mcpConfirmer ? 'adm-btn--danger bg-red-50' : 'adm-btn--danger-quiet text-red-600'"
            :disabled="rg.mcpOccupe"
            :aria-describedby="rg.mcpConfirmer ? 'mcp-suppr-q' : undefined"
            @click="supprimer()"
          >
            <i class="ph ph-trash" aria-hidden="true"></i> {{ verbe }}
          </button>
          <template v-if="rg.mcpConfirmer">
            <button type="button" class="adm-btn adm-btn--quiet" @click="rg.mcpAnnulerSuppression()">
              Annuler
            </button>
            <span id="mcp-suppr-q" role="status" class="text-sm text-slate-600"
              >« {{ f.name }} » : cliquez de nouveau pour confirmer.<template v-if="partage">
                Il disparaît de tous les comptes.</template
              ></span
            >
          </template>
        </div>
      </div>
    </template>

    <div v-else class="flex-1 flex flex-col items-center justify-center gap-3 text-slate-500">
      <i class="ph ph-plug text-3xl text-slate-400" aria-hidden="true"></i>
      <span class="text-sm">Aucun serveur choisi</span>
      <button type="button" class="adm-btn adm-btn--primary" @click="rg.mcpNouveau()">
        <i class="ph ph-plus" aria-hidden="true"></i> Ajouter
      </button>
    </div>
  </section>
</template>
