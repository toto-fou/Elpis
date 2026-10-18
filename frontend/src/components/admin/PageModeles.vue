<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/admin/PageModeles.vue — page Inférence : connecteurs partagés. -->
<script setup lang="ts">
import { domaineAdmin } from "../../features/admin/domaine";

const adm = domaineAdmin();
</script>

<template>
  <div v-if="['inference', 'compression', 'rights'].includes(adm.adminTab)" class="animate-[fadeIn_0.2s]">
    <div class="space-y-6 min-w-0">
      <section v-if="adm.adminTab === 'inference'" id="scheduling" class="adm-card scroll-mt-32">
        <header class="adm-card__head">
          <i class="ph ph-lightning adm-card__icon" aria-hidden="true"></i>
          <div>
            <h3 class="adm-card__title">Planification</h3>
            <span class="sr-only">Comment les requêtes se partagent le moteur intégré.</span>
          </div>
        </header>
        <div v-if="adm.llmScheduling" class="adm-rows">
          <div class="adm-row adm-row--top">
            <div>
              <span class="adm-row__label" title="« Auto » choisit selon les capacités détectées du serveur."
                >Mode</span
              >
              <span class="sr-only">« Auto » choisit selon les capacités détectées du serveur.</span>
            </div>
            <div class="space-y-2">
              <label
                v-for="opt in [
                  { value: 'auto', label: 'Auto', hint: 'Laisse l’application décider.' },
                  {
                    value: 'classic',
                    label: 'Classique',
                    hint: 'Un emplacement par requête — compatible avec toutes les versions.',
                  },
                  {
                    value: 'optimized',
                    label: 'Optimisé',
                    hint: 'Requêtes en parallèle — nécessite un llama-server récent.',
                  },
                ]"
                :key="'sched_' + opt.value"
                :class="
                  adm.llmScheduling.configured_mode === opt.value
                    ? 'border-blue-400 bg-blue-50/50'
                    : 'border-slate-200 hover:bg-slate-50'
                "
                class="flex items-start gap-3 p-3 border rounded-lg cursor-pointer transition-colors"
              >
                <input
                  v-model="adm.llmScheduling.configured_mode"
                  type="radio"
                  :value="opt.value"
                  data-field="scheduling:configured_mode"
                  class="w-4 h-4 mt-0.5 text-blue-600 shrink-0"
                />
                <span class="min-w-0">
                  <span class="block text-sm font-medium text-slate-800">{{ opt.label }}</span>
                  <span class="block text-xs text-slate-500 mt-0.5">{{ opt.hint }}</span>
                </span>
              </label>
            </div>
          </div>

          <div class="adm-row">
            <div>
              <span class="adm-row__label" title="Ce que le serveur applique réellement.">Mode effectif</span>
              <span class="sr-only">Ce que le serveur applique réellement.</span>
            </div>
            <div class="flex items-center gap-2">
              <span
                class="font-mono text-xs text-blue-700 bg-blue-50 border border-blue-200 px-2 py-1 rounded"
                >{{ adm.llmScheduling.effective_mode }}</span
              >
              <button
                :disabled="adm.llmSchedulingProbing"
                class="adm-btn adm-btn--quiet adm-btn--sm"
                title="Re-tester les capacités du serveur"
                @click="adm.probeLlmCapabilities()"
              >
                <i
                  class="ph ph-arrows-clockwise"
                  :class="adm.llmSchedulingProbing ? 'animate-spin' : ''"
                  aria-hidden="true"
                ></i>
                Re-détecter
              </button>
            </div>
          </div>
        </div>
        <div v-else class="px-5 py-6"><div class="adm-skeleton w-48"></div></div>
      </section>

      <section v-if="adm.adminTab === 'compression'" id="compression-rules" class="adm-card scroll-mt-32">
        <header class="adm-card__head">
          <i class="ph ph-arrows-in-line-vertical adm-card__icon" aria-hidden="true"></i>
          <div>
            <h3 class="adm-card__title">Règles</h3>
          </div>
        </header>
        <div v-if="adm.compressionCfg" class="adm-rows">
          <div class="adm-row">
            <div>
              <label
                class="adm-row__label"
                title="N'active rien : chaque utilisateur reste libre de l'activer (désactivée par défaut)."
                for="llm-comp-enabled"
                >Autorisée</label
              >
              <span class="sr-only"
                >N'active rien : chaque utilisateur reste libre de l'activer (désactivée par défaut).</span
              >
            </div>
            <label class="relative inline-flex items-center gap-2 cursor-pointer w-fit">
              <input
                id="llm-comp-enabled"
                v-model="adm.compressionCfg.enabled"
                type="checkbox"
                data-field="compression:enabled"
                class="sr-only peer"
              />
              <span
                class="set-switch-track block peer-checked:bg-blue-600 peer-checked:border-blue-600"
              ></span>
              <span class="text-sm text-slate-700">{{
                adm.compressionCfg.enabled ? "Autorisée" : "Interdite pour tous"
              }}</span>
            </label>
          </div>

          <div v-if="adm.compressionCfg.enabled" class="adm-row">
            <div>
              <label
                class="adm-row__label"
                title="Au-delà, le budget de contexte prend le relais. 0 = sans limite."
                for="llm-comp-max"
                >Compressions par conversation</label
              >
              <span class="sr-only">Au-delà, le budget de contexte prend le relais. 0 = sans limite.</span>
            </div>
            <input
              id="llm-comp-max"
              v-model.number="adm.compressionCfg.max_per_chat"
              data-field="compression:max_per_chat"
              type="number"
              min="0"
              max="10"
              class="set-input adm-num"
            />
          </div>

          <div v-if="adm.compressionCfg.enabled" class="adm-row">
            <div>
              <label
                class="adm-row__label"
                title="Part du contexte à partir de laquelle compacter, pour les comptes qui n'ont pas réglé le leur. 0 = fenêtre pleine."
                for="llm-comp-threshold"
                >Seuil par défaut (%)</label
              >
              <span class="sr-only"
                >Part du contexte à partir de laquelle compacter, pour les comptes qui n'ont pas réglé le
                leur. 0 = fenêtre pleine.</span
              >
            </div>
            <input
              id="llm-comp-threshold"
              v-model.number="adm.compressionCfg.threshold_pct"
              data-field="compression:threshold_pct"
              type="number"
              min="0"
              max="100"
              step="5"
              class="set-input adm-num"
            />
          </div>

          <div v-if="adm.compressionCfg.enabled" class="adm-row">
            <div>
              <label
                class="adm-row__label"
                title="Même rôle, exprimé en tokens — prime sur le pourcentage ci-dessus. 0 = non utilisé."
                for="llm-comp-threshold-tk"
                >Seuil par défaut (tokens)</label
              >
              <span class="sr-only"
                >Même rôle, exprimé en tokens — prime sur le pourcentage ci-dessus. 0 = non utilisé.</span
              >
            </div>
            <input
              id="llm-comp-threshold-tk"
              v-model.number="adm.compressionCfg.threshold_tokens"
              data-field="compression:threshold_tokens"
              type="number"
              min="0"
              max="4000000"
              step="1000"
              placeholder="80000"
              class="set-input adm-num"
            />
          </div>

          <details v-if="adm.compressionCfg.enabled" class="adm-details">
            <summary>Quand se déclenche-t-elle ?</summary>
            <p class="text-xs text-slate-500 mt-2 max-w-[68ch]">
              Au plus tard quand l'occupation réelle du contexte atteint la fenêtre utilisable du modèle
              (n_ctx moins la réserve de génération et une marge) — ce plafond technique est toujours armé.
              Chaque compte peut demander plus tôt, en % du contexte ; ce seuil-là n'agit qu'entre deux tours,
              jamais au milieu d'une réponse en cours. Elle est partielle : seuls les tours les plus anciens
              nécessaires sont résumés. La commande <code class="font-mono">/compact</code> reste disponible
              manuellement, même compression interdite.
            </p>
          </details>
        </div>
        <div v-else class="px-5 py-6"><div class="adm-skeleton w-48"></div></div>
      </section>

      <section v-if="adm.adminTab === 'rights'" id="llm-access" class="adm-card scroll-mt-32">
        <header class="adm-card__head">
          <i class="ph ph-users adm-card__icon" aria-hidden="true"></i>
          <div>
            <h3 class="adm-card__title">Accès utilisateurs</h3>
            <span class="sr-only">Ce que les utilisateurs peuvent brancher et choisir depuis le chat.</span>
          </div>
        </header>
        <div class="adm-rows">
          <div class="adm-row adm-row--top">
            <div>
              <span
                class="adm-row__label"
                title="Services cloud que les comptes non administrateurs peuvent connecter avec leur propre clé. Aucun coché : aucun."
                >Fournisseurs autorisés</span
              >
              <span class="sr-only"
                >Services cloud que les comptes non administrateurs peuvent connecter avec leur propre clé.
                Aucun coché : aucun.</span
              >
            </div>
            <div>
              <div class="flex flex-wrap gap-2">
                <button
                  v-for="pt in adm.admLlmCloudTypes"
                  :key="pt"
                  :aria-pressed="adm.admLlmAllowed.includes(pt) ? 'true' : 'false'"
                  class="px-2.5 py-1 rounded-full text-xs font-medium border transition-colors"
                  :class="
                    adm.admLlmAllowed.includes(pt)
                      ? 'bg-blue-600 text-white border-blue-600'
                      : 'bg-white text-slate-600 border-slate-300 hover:border-blue-300'
                  "
                  @click="adm.toggleAdmAllowed(pt)"
                >
                  {{ adm.admLlmLabel(pt) }}
                </button>
              </div>
              <p v-if="!adm.admLlmCloudTypes.length" class="adm-empty">Aucun fournisseur cloud disponible.</p>
              <p v-else-if="!adm.admLlmAllowed.length" class="adm-empty">
                Aucun ouvert : les comptes non administrateurs n'utilisent que les serveurs partagés ici.
              </p>
            </div>
          </div>

          <div v-if="adm.configForm && adm.configForm.app" class="adm-row">
            <div>
              <label
                class="adm-row__label"
                title="Affiche le choix du modèle et du connecteur dans le chat."
                for="llm-model-selector"
                >Sélecteur de modèle</label
              >
              <span class="sr-only">Affiche le choix du modèle et du connecteur dans le chat.</span>
            </div>
            <label class="relative inline-flex items-center gap-2 cursor-pointer w-fit">
              <input
                id="llm-model-selector"
                v-model="adm.configForm.app.enable_model_selector"
                type="checkbox"
                data-field="config:app.enable_model_selector"
                class="sr-only peer"
              />
              <span
                class="set-switch-track block peer-checked:bg-blue-600 peer-checked:border-blue-600"
              ></span>
              <span class="text-sm text-slate-700">{{
                adm.configForm.app.enable_model_selector ? "Affiché" : "Masqué"
              }}</span>
            </label>
          </div>
        </div>
      </section>
    </div>
  </div>
</template>
