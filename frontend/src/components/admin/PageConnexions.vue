<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/admin/PageConnexions.vue — pages Modèles et services (inférence, compression, vision, voix, images, MCP). -->
<script setup lang="ts">
import { computed, ref } from "vue";

import { domaineAdmin } from "../../features/admin/domaine";
import { profilConsole, typeDeclare } from "../../features/admin/moteurs";
import { ONGLETS_IMAGES, ONGLETS_VOIX, ongletsAvecModifications } from "../../features/admin/onglets";
import { interfaceApp } from "../../features/reglages/interface";
import CapacitesMoteur from "./CapacitesMoteur.vue";
import SousOngletsConsole from "./SousOngletsConsole.vue";

const adm = domaineAdmin();
const ui = interfaceApp();

const ongletImages = ref("connexion");
const ongletVoix = ref("dictee");
const ongletsImages = computed(() =>
  ongletsAvecModifications(ONGLETS_IMAGES, "image.", adm.adminPageChanges),
);
const ongletsVoix = computed(() => ongletsAvecModifications(ONGLETS_VOIX, "voice.", adm.adminPageChanges));
/** Interface classique : tout est affiché ; sinon seul l'onglet choisi. */
const surOnglet = (page: "images" | "voice", onglet: string): boolean =>
  ui.classique || (page === "images" ? ongletImages.value : ongletVoix.value) === onglet;

// Type déclaré dans le formulaire (alias compris) et son profil : ce que la console montre et masque.
const typeMoteur = computed(() => typeDeclare(adm.configForm?.llama?.engine));
const profil = computed(() => profilConsole(typeMoteur.value));
// Le rapport décrit le moteur en service : un autre type dans le formulaire attend le redémarrage.
const typeEnAttente = computed(() => !!adm.rapportMoteur && adm.rapportMoteur.type !== typeMoteur.value);
</script>

<template>
  <div
    v-if="['inference', 'compression', 'vision', 'voice', 'images', 'mcp'].includes(adm.adminTab)"
    class="animate-[fadeIn_0.2s]"
  >
    <div class="space-y-6 min-w-0">
      <section v-if="adm.adminTab === 'inference'" id="engine" class="adm-card scroll-mt-32">
        <header class="adm-card__head">
          <i class="ph ph-cpu adm-card__icon" aria-hidden="true"></i>
          <div>
            <h3 class="adm-card__title">Moteur d'inférence</h3>
            <span class="sr-only"
              >Le serveur intégré et les connecteurs partagés par tous les utilisateurs.</span
            >
          </div>
        </header>

        <div class="adm-rows">
          <div class="adm-row adm-row--full adm-row--top">
            <div class="w-full min-w-0">
              <div class="flex items-end justify-between gap-3 mb-2">
                <div>
                  <span
                    id="cnx-engine-lbl"
                    class="adm-row__label"
                    title="Le serveur intégré ou l'un des connecteurs partagés."
                    >Moteur à configurer</span
                  >
                  <span class="sr-only">Le serveur intégré ou l'un des connecteurs partagés.</span>
                </div>
                <button
                  type="button"
                  class="adm-btn adm-tool adm-btn--sm"
                  :class="adm.engineSel === '__new__' ? 'border-blue-300 bg-blue-50 text-blue-700' : ''"
                  @click="
                    adm.engineSel = '__new__';
                    adm.onEngineSelect();
                  "
                >
                  <i class="ph ph-plus" aria-hidden="true"></i> Ajouter
                </button>
              </div>

              <div class="space-y-1.5" role="listbox" aria-labelledby="cnx-engine-lbl">
                <div
                  role="option"
                  tabindex="0"
                  :aria-selected="adm.engineSel === '__local__' ? 'true' : 'false'"
                  class="bg-slate-50 hover:bg-white border rounded-lg p-3 flex items-center gap-3 cursor-pointer transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
                  :class="
                    adm.engineSel === '__local__'
                      ? 'border-blue-300 bg-blue-50/50'
                      : 'border-transparent hover:border-slate-200'
                  "
                  @click="
                    adm.engineSel = '__local__';
                    adm.onEngineSelect();
                  "
                  @keydown.enter.prevent="
                    adm.engineSel = '__local__';
                    adm.onEngineSelect();
                  "
                  @keydown.space.prevent="
                    adm.engineSel = '__local__';
                    adm.onEngineSelect();
                  "
                >
                  <i
                    class="ph ph-cpu text-base shrink-0"
                    :class="adm.engineSel === '__local__' ? 'text-blue-500' : 'text-slate-400'"
                    aria-hidden="true"
                  ></i>
                  <div class="min-w-0 flex-1">
                    <div class="font-medium text-slate-800 text-sm truncate">Moteur local (intégré)</div>
                    <div class="text-[11px] text-slate-500 mt-0.5 font-mono truncate">
                      {{
                        adm.configForm && adm.configForm.llama
                          ? (adm.configForm.llama.url || "").trim() ||
                            (adm.configForm.llama.ip || "127.0.0.1") +
                              ":" +
                              (adm.configForm.llama.port || 8080)
                          : "—"
                      }}
                    </div>
                  </div>
                  <span class="text-[11px] text-slate-400 shrink-0">par défaut</span>
                </div>

                <div
                  v-for="c in adm.admLlmConnectors"
                  :key="'eng' + c.id"
                  role="option"
                  tabindex="0"
                  :aria-selected="String(adm.engineSel) === String(c.id) ? 'true' : 'false'"
                  class="bg-slate-50 hover:bg-white border rounded-lg p-3 flex items-center gap-3 group cursor-pointer transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
                  :class="
                    String(adm.engineSel) === String(c.id)
                      ? 'border-blue-300 bg-blue-50/50'
                      : 'border-transparent hover:border-slate-200'
                  "
                  @click="
                    adm.engineSel = String(c.id);
                    adm.onEngineSelect();
                  "
                  @keydown.enter.prevent="
                    adm.engineSel = String(c.id);
                    adm.onEngineSelect();
                  "
                  @keydown.space.prevent="
                    adm.engineSel = String(c.id);
                    adm.onEngineSelect();
                  "
                >
                  <i
                    class="ph ph-plugs-connected text-base shrink-0"
                    :class="String(adm.engineSel) === String(c.id) ? 'text-blue-500' : 'text-slate-400'"
                    aria-hidden="true"
                  ></i>
                  <div class="min-w-0 flex-1">
                    <div class="flex items-center gap-1.5 min-w-0">
                      <span class="font-medium text-slate-800 text-sm truncate">{{
                        c.label || adm.admLlmLabel(c.provider_type)
                      }}</span>
                      <span
                        class="text-[10px] px-1.5 py-0.5 rounded bg-white text-slate-500 border border-slate-200 shrink-0"
                        >{{ c.provider_type }}</span
                      >
                      <span
                        v-if="c.has_key"
                        class="text-[10px] text-emerald-700 shrink-0"
                        title="Clé API enregistrée"
                        ><i class="ph ph-key" aria-hidden="true"></i
                      ></span>
                      <span v-if="c.enabled === false" class="text-[10px] text-amber-700 shrink-0"
                        >désactivé</span
                      >
                    </div>
                    <div
                      class="text-[11px] mt-0.5 font-mono truncate"
                      :class="
                        adm.admLlmTest[c.id] && !adm.admLlmTest[c.id]?.testing && !adm.admLlmTest[c.id]?.ok
                          ? 'text-red-600'
                          : 'text-slate-500'
                      "
                    >
                      <template v-if="adm.admLlmTest[c.id] && adm.admLlmTest[c.id]?.testing">
                        <i class="ph ph-spinner-gap animate-spin" aria-hidden="true"></i> test en cours…
                      </template>
                      <template v-else-if="adm.admLlmTest[c.id] && adm.admLlmTest[c.id]?.ok">
                        {{ adm.admLlmTest[c.id]?.models_count }} modèle(s) · {{ c.base_url }}
                      </template>
                      <template v-else-if="adm.admLlmTest[c.id]">
                        {{ adm.admLlmTest[c.id]?.hint || adm.admLlmTest[c.id]?.error || "échec" }}
                      </template>
                      <template v-else>{{ c.base_url || "—" }}</template>
                    </div>
                  </div>
                  <div class="flex gap-1 shrink-0">
                    <button
                      type="button"
                      title="Tester la connexion"
                      aria-label="Tester la connexion"
                      class="adm-btn adm-btn--icon adm-tool"
                      @click.stop="adm.testAdmLlmConnector(c)"
                    >
                      <i class="ph ph-pulse" aria-hidden="true"></i>
                    </button>
                    <button
                      type="button"
                      title="Supprimer"
                      aria-label="Supprimer le connecteur"
                      class="adm-btn adm-btn--icon adm-tool adm-btn--icon-danger"
                      @click.stop="adm.deleteAdmLlmConnector(c)"
                    >
                      <i class="ph ph-trash" aria-hidden="true"></i>
                    </button>
                  </div>
                </div>

                <div
                  v-if="!adm.admLlmConnectors.length"
                  class="text-center px-4 py-5 bg-slate-50 rounded-lg border border-dashed border-slate-200"
                >
                  <i class="ph ph-plugs text-2xl text-slate-300 block mb-1" aria-hidden="true"></i>
                  <p class="text-xs text-slate-500">Aucun connecteur partagé. « Ajouter » en crée un.</p>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div class="border-t border-slate-100">
          <div v-if="adm.configForm && adm.configForm.llama" class="adm-rows">
            <div class="adm-row">
              <div>
                <label
                  class="adm-row__label"
                  title="Le type déclaré fait foi : Elpis en utilise les adresses et les capacités. Pris en compte au redémarrage."
                  for="cnx-llama-engine"
                  >Type</label
                >
                <span class="sr-only"
                  >Le type déclaré fait foi : Elpis en utilise les adresses et les capacités. Pris en compte
                  au redémarrage.</span
                >
              </div>
              <div class="min-w-0 space-y-1">
                <select
                  id="cnx-llama-engine"
                  v-model="adm.configForm.llama.engine"
                  data-field="config:llama.engine"
                  class="set-select w-full max-w-sm"
                >
                  <option value="llamacpp">llama.cpp — slots, chargement de modèles</option>
                  <option value="vllm">vLLM — métriques, jetons exacts, lots continus</option>
                  <option value="sglang">SGLang — métriques, jetons exacts, lots continus</option>
                  <option value="generic">OpenAI-compatible (TGI, Ollama, LM Studio…)</option>
                </select>
                <p class="text-[11px] text-slate-500">{{ profil.resume }}</p>
              </div>
            </div>

            <div class="adm-row adm-row--top">
              <div>
                <span
                  class="adm-row__label"
                  title="Sonde du moteur en service : adresses, version, modèle, contexte, métriques, options manquantes."
                  >Capacités</span
                >
                <span class="sr-only"
                  >Sonde du moteur en service : adresses, version, modèle, contexte, métriques, options
                  manquantes.</span
                >
              </div>
              <div class="min-w-0 space-y-1">
                <p v-if="typeEnAttente" class="text-[11px] text-amber-700" data-type-en-attente>
                  Le moteur en service est {{ adm.rapportMoteur?.libelle }} : le type choisi s'applique au
                  redémarrage.
                </p>
                <CapacitesMoteur
                  :rapport="adm.rapportMoteur"
                  :en-cours="adm.rapportMoteurTest"
                  testable
                  @tester="adm.testerMoteurIntegre()"
                />
              </div>
            </div>

            <div class="adm-row">
              <div>
                <span class="adm-row__label" title="Hôte, port, et délai maximal d'une requête."
                  >Adresse</span
                >
                <span class="sr-only">Hôte, port, et délai maximal d'une requête.</span>
              </div>
              <div class="flex items-center gap-2 flex-wrap">
                <input
                  v-model="adm.configForm.llama.ip"
                  data-field="config:llama.ip"
                  placeholder="127.0.0.1"
                  aria-label="Hôte"
                  class="set-input font-mono text-xs flex-1 min-w-[10rem]"
                />
                <input
                  v-model.number="adm.configForm.llama.port"
                  data-field="config:llama.port"
                  type="number"
                  min="1"
                  max="65535"
                  placeholder="Port"
                  aria-label="Port"
                  class="set-input adm-num--sm"
                />
                <input
                  v-model.number="adm.configForm.llama.timeout_sec"
                  data-field="config:llama.timeout_sec"
                  type="number"
                  min="1"
                  max="3600"
                  placeholder="Délai"
                  aria-label="Délai en secondes"
                  class="set-input adm-num--sm"
                />
                <span class="adm-unit">s</span>

                <span
                  v-if="(adm.configForm.llama.url || '').trim()"
                  class="adm-pill"
                  title="L'URL complète (Avancé) remplace l'hôte et le port."
                  >URL complète active</span
                >
              </div>
            </div>

            <div class="adm-row">
              <div>
                <label
                  class="adm-row__label"
                  title="Modèle par défaut : identifiant transmis à l'API (champ « model » de la requête)."
                  for="cnx-llama-model"
                  >Modèle</label
                >
                <span class="sr-only"
                  >Modèle par défaut : identifiant transmis à l'API (champ « model » de la requête).</span
                >
              </div>
              <input
                id="cnx-llama-model"
                v-model="adm.configForm.llama.model"
                data-field="config:llama.model"
                placeholder="local-model"
                class="set-input"
              />
            </div>

            <details class="adm-details adm-details--rows">
              <summary>Avancé</summary>
              <div class="adm-row">
                <div>
                  <label
                    class="adm-row__label"
                    title="Base du serveur ; « /v1 » ou « /v1/chat/completions » en fin d'adresse sont acceptés. Si renseignée, remplace hôte et port."
                    for="cnx-llama-url"
                    >URL du serveur</label
                  >
                  <span class="sr-only"
                    >Base du serveur ; « /v1 » ou « /v1/chat/completions » en fin d'adresse sont acceptés. Si
                    renseignée, remplace hôte et port.</span
                  >
                </div>
                <input
                  id="cnx-llama-url"
                  v-model="adm.configForm.llama.url"
                  data-field="config:llama.url"
                  :placeholder="'http://hote:' + profil.port"
                  class="set-input font-mono text-xs"
                />
              </div>

              <div class="adm-row">
                <div>
                  <label
                    class="adm-row__label"
                    title="Valeur de --api-key du serveur, envoyée en Authorization: Bearer ; jamais réaffichée. Vide = aucune."
                    for="cnx-llama-key"
                    >Clé API</label
                  >
                  <span class="sr-only"
                    >Valeur de --api-key du serveur, envoyée en Authorization: Bearer ; jamais réaffichée.
                    Vide = aucune.</span
                  >
                </div>
                <input
                  id="cnx-llama-key"
                  v-model="adm.configForm.llama.api_key"
                  data-field="config:llama.api_key"
                  type="password"
                  autocomplete="new-password"
                  placeholder="Aucune"
                  class="set-input font-mono text-xs"
                />
              </div>

              <div class="adm-row">
                <div>
                  <span
                    class="adm-row__label"
                    title="Nombre de tentatives et délai initial (doublé à chaque essai)."
                    >Reprise sur échec</span
                  >
                  <span class="sr-only">Nombre de tentatives et délai initial (doublé à chaque essai).</span>
                </div>
                <div class="flex items-center gap-2">
                  <input
                    v-model.number="adm.configForm.llama.retries"
                    data-field="config:llama.retries"
                    type="number"
                    min="0"
                    max="20"
                    aria-label="Tentatives"
                    class="set-input adm-num--sm"
                  />
                  <span class="adm-unit">tentatives, délai</span>
                  <input
                    v-model.number="adm.configForm.llama.retry_backoff_sec"
                    data-field="config:llama.retry_backoff_sec"
                    type="number"
                    step="0.1"
                    min="0"
                    max="60"
                    aria-label="Délai initial en secondes"
                    class="set-input adm-num--sm"
                  />
                  <span class="adm-unit">s</span>
                </div>
              </div>

              <div v-if="!profil.file" class="adm-row" data-concurrence-moteur>
                <div>
                  <span
                    class="adm-row__label"
                    title="Le moteur regroupe lui-même les requêtes (lots continus)."
                    >Capacité</span
                  >
                  <span class="sr-only">Le moteur regroupe lui-même les requêtes (lots continus).</span>
                </div>
                <p class="text-xs text-slate-600">{{ profil.concurrence }}</p>
              </div>
              <div v-if="typeMoteur === 'llamacpp'" class="adm-row">
                <div>
                  <span
                    class="adm-row__label"
                    title="Propre à llama.cpp : modèles chargés en parallèle, conversations par modèle."
                    >Capacité</span
                  >
                  <span class="sr-only"
                    >Propre à llama.cpp : modèles chargés en parallèle, conversations par modèle.</span
                  >
                </div>
                <div class="flex items-center gap-2 flex-wrap">
                  <input
                    v-model.number="adm.configForm.llama.max_models"
                    data-field="config:llama.max_models"
                    type="number"
                    min="1"
                    max="32"
                    aria-label="Modèles simultanés"
                    class="set-input adm-num--sm"
                  />
                  <span class="adm-unit">modèles,</span>
                  <input
                    v-model.number="adm.configForm.llama.max_concurrency"
                    data-field="config:llama.max_concurrency"
                    type="number"
                    min="1"
                    max="64"
                    aria-label="Conversations par modèle"
                    class="set-input adm-num--sm"
                  />
                  <span class="adm-unit">conversations / modèle</span>
                </div>
              </div>
            </details>
          </div>
          <div v-else class="px-5 py-6">
            <div class="adm-skeleton w-48"></div>
          </div>
        </div>

        <teleport to="body">
          <div
            v-if="adm.admLlmForm && adm.adminTab === 'inference'"
            class="adm-drawer-backdrop"
            @click.self="adm.closeEngineDrawer()"
          >
            <aside
              :ref="
                (el) => {
                  adm.engineDrawer = el as typeof adm.engineDrawer;
                }
              "
              class="adm-drawer"
              role="dialog"
              aria-modal="true"
              aria-labelledby="cnx-drawer-title"
              tabindex="-1"
              @keydown.tab="adm.onEngineDrawerKey"
            >
              <header class="adm-drawer__head">
                <i class="ph ph-plugs-connected adm-card__icon" aria-hidden="true"></i>
                <h2 id="cnx-drawer-title" class="adm-drawer__title">
                  {{
                    adm.admLlmForm.id
                      ? adm.engineConnector
                        ? adm.engineConnector.label || adm.admLlmLabel(adm.engineConnector.provider_type)
                        : "Connecteur"
                      : "Nouveau connecteur"
                  }}
                </h2>
                <span v-if="adm.admLlmForm.id && adm.engineConnector" class="adm-pill">{{
                  adm.engineConnector.provider_type
                }}</span>
                <button
                  type="button"
                  class="adm-btn adm-btn--icon ml-auto"
                  aria-label="Fermer"
                  title="Fermer (Échap)"
                  @click="adm.closeEngineDrawer()"
                >
                  <i class="ph ph-x" aria-hidden="true"></i>
                </button>
              </header>

              <div class="adm-drawer__body">
                <p
                  v-if="adm.admLlmForm.id && adm.engineConnector && adm.admLlmTest[adm.engineConnector.id]"
                  class="text-xs"
                  role="status"
                  :class="
                    adm.admLlmTest[adm.engineConnector.id]?.testing
                      ? 'text-slate-500'
                      : adm.admLlmTest[adm.engineConnector.id]?.ok
                        ? 'text-emerald-700'
                        : 'text-red-600'
                  "
                >
                  <span v-if="adm.admLlmTest[adm.engineConnector.id]?.testing"
                    ><i class="ph ph-spinner-gap animate-spin" aria-hidden="true"></i> Test en cours…</span
                  >
                  <span v-else-if="adm.admLlmTest[adm.engineConnector.id]?.ok"
                    ><i class="ph ph-check-circle" aria-hidden="true"></i> Joignable ·
                    {{ adm.admLlmTest[adm.engineConnector.id]?.models_count }} modèle(s)</span
                  >
                  <span v-else
                    ><i class="ph ph-warning-circle" aria-hidden="true"></i>
                    {{
                      adm.admLlmTest[adm.engineConnector.id]?.hint ||
                      adm.admLlmTest[adm.engineConnector.id]?.error ||
                      "Échec"
                    }}</span
                  >
                </p>

                <CapacitesMoteur
                  v-if="
                    adm.admLlmForm.id && adm.engineConnector && adm.admLlmTest[adm.engineConnector.id]?.sonde
                  "
                  :rapport="adm.admLlmTest[adm.engineConnector.id]?.sonde ?? null"
                />

                <label v-if="!adm.admLlmForm.id" class="adm-field">
                  <span class="adm-field__label">Fournisseur</span>
                  <select v-model="adm.admLlmForm.provider_type" class="set-select w-full">
                    <option v-for="pt in adm.admLlmAllProviders" :key="pt" :value="pt">
                      {{ adm.admLlmLabel(pt) }}
                    </option>
                  </select>
                </label>
                <label class="adm-field">
                  <span class="adm-field__label" title="Vide = adresse officielle du fournisseur."
                    >Adresse</span
                  >
                  <input
                    v-model="adm.admLlmForm.base_url"
                    placeholder="http://llm.example.lan:8000/v1"
                    class="set-input font-mono text-xs"
                  />
                </label>
                <label class="adm-field">
                  <span class="adm-field__label">Clé API</span>
                  <input
                    v-model="adm.admLlmForm.api_key"
                    type="password"
                    autocomplete="new-password"
                    :placeholder="
                      adm.admLlmForm.id
                        ? adm.engineConnector && adm.engineConnector.has_key
                          ? 'Enregistrée · vide = inchangée'
                          : 'Aucune'
                        : 'Facultative en local'
                    "
                    class="set-input"
                  />
                </label>
                <div class="grid grid-cols-2 gap-3">
                  <label class="adm-field">
                    <span class="adm-field__label">Modèle</span>
                    <input
                      v-model="adm.admLlmForm.default_model"
                      placeholder="qwen3-coder-30b"
                      title="Modèle par défaut"
                      class="set-input"
                    />
                  </label>
                  <label class="adm-field">
                    <span class="adm-field__label">Libellé</span>
                    <input v-model="adm.admLlmForm.label" placeholder="vLLM interne" class="set-input" />
                  </label>
                </div>

                <div v-if="adm.admLlmForm.provider_type === 'llamacpp'" class="grid grid-cols-3 gap-3">
                  <label class="adm-field">
                    <span class="adm-field__label">Contexte</span>
                    <input
                      v-model.number="adm.admLlmForm.context_window"
                      type="number"
                      min="0"
                      placeholder="auto"
                      title="Tokens par requête — vide : lu sur le serveur"
                      class="set-input"
                    />
                  </label>
                  <label class="adm-field">
                    <span class="adm-field__label">Modèles</span>
                    <input
                      v-model.number="adm.admLlmForm.max_models"
                      type="number"
                      min="0"
                      placeholder="1"
                      title="Modèles simultanés en mémoire sur ce serveur"
                      class="set-input"
                    />
                  </label>
                  <label class="adm-field">
                    <span class="adm-field__label">Requêtes</span>
                    <input
                      v-model.number="adm.admLlmForm.max_concurrency"
                      type="number"
                      min="0"
                      placeholder="auto"
                      title="Requêtes simultanées par modèle — vide : slots du serveur"
                      class="set-input"
                    />
                  </label>
                </div>
                <details class="adm-details">
                  <summary>Avancé</summary>
                  <label class="adm-field mt-2">
                    <span class="adm-field__label" title="Repli si le fournisseur n'expose pas la liste."
                      >Modèles (un par ligne)</span
                    >
                    <textarea
                      v-model="adm.admLlmForm.models_json"
                      rows="3"
                      placeholder="model-a&#10;model-b"
                      class="set-textarea"
                    ></textarea>
                  </label>
                </details>
              </div>

              <footer class="adm-drawer__foot">
                <button
                  v-if="adm.admLlmForm.id && adm.engineConnector"
                  type="button"
                  class="adm-btn adm-btn--quiet adm-btn--danger-quiet mr-auto"
                  @click="adm.deleteAdmLlmConnector(adm.engineConnector)"
                >
                  <i class="ph ph-trash" aria-hidden="true"></i> Supprimer
                </button>
                <button
                  v-if="adm.admLlmForm.id && adm.engineConnector"
                  type="button"
                  class="adm-btn adm-tool"
                  @click="adm.testAdmLlmConnector(adm.engineConnector)"
                >
                  Tester
                </button>
                <button type="button" class="adm-btn adm-btn--quiet" @click="adm.closeEngineDrawer()">
                  Annuler
                </button>
                <button
                  type="button"
                  :disabled="adm.admLlmBusy"
                  class="adm-btn adm-btn--primary"
                  @click="adm.saveAdmLlmConnector()"
                >
                  {{ adm.admLlmForm.id ? "Enregistrer" : "Ajouter" }}
                </button>
              </footer>
            </aside>
          </div>
        </teleport>
      </section>

      <section v-if="adm.adminTab === 'compression'" id="compression-endpoint" class="adm-card scroll-mt-32">
        <header class="adm-card__head">
          <i class="ph ph-arrows-in-line-vertical adm-card__icon" aria-hidden="true"></i>
          <div>
            <h3 class="adm-card__title">Service</h3>
          </div>
        </header>
        <div v-if="adm.compressionCfg" class="adm-rows">
          <div class="adm-row">
            <div>
              <label
                class="adm-row__label"
                title="Vide = le moteur d'inférence principal s'en charge."
                for="cnx-comp-url"
                >Adresse</label
              >
              <span class="sr-only">Vide = le moteur d'inférence principal s'en charge.</span>
            </div>
            <input
              id="cnx-comp-url"
              v-model="adm.compressionCfg.endpoint_url"
              data-field="compression:endpoint_url"
              placeholder="http://hote:port"
              class="set-input font-mono text-xs"
            />
          </div>
          <div class="adm-row">
            <div>
              <label class="adm-row__label" title="Un petit modèle rapide suffit." for="cnx-comp-model"
                >Modèle</label
              >
              <span class="sr-only">Un petit modèle rapide suffit.</span>
            </div>
            <div class="flex items-center gap-2 flex-wrap">
              <input
                id="cnx-comp-model"
                v-model="adm.compressionCfg.endpoint_model"
                data-field="compression:endpoint_model"
                placeholder="modèle"
                class="set-input font-mono text-xs flex-1 min-w-[10rem]"
              />
              <input
                v-model.number="adm.compressionCfg.endpoint_timeout_sec"
                data-field="compression:endpoint_timeout_sec"
                type="number"
                min="10"
                max="600"
                aria-label="Délai en secondes"
                class="set-input adm-num--sm"
              />
              <span class="adm-unit">s</span>
            </div>
          </div>
        </div>
        <div v-else class="px-5 py-6"><div class="adm-skeleton w-48"></div></div>
      </section>

      <section v-if="adm.adminTab === 'vision'" id="vision" class="adm-card scroll-mt-32">
        <header class="adm-card__head">
          <i class="ph ph-scan adm-card__icon" aria-hidden="true"></i>
          <div>
            <h3 class="adm-card__title">Annotation visuelle</h3>
            <span class="sr-only"
              >Détecteur qui repère les éléments d'interface sur une capture d'écran.</span
            >
          </div>
        </header>
        <div v-if="adm.configForm && adm.configForm.vision" class="adm-rows">
          <div class="adm-row">
            <div>
              <label
                class="adm-row__label"
                title="Vide = annotation désactivée, seul l'arbre d'accessibilité est utilisé."
                for="cnx-vision-url"
                >Adresse</label
              >
              <span class="sr-only"
                >Vide = annotation désactivée, seul l'arbre d'accessibilité est utilisé.</span
              >
            </div>
            <input
              id="cnx-vision-url"
              v-model="adm.configForm.vision.endpoint_url"
              data-field="config:vision.endpoint_url"
              placeholder="http://hote:port/parse"
              class="set-input font-mono text-xs"
            />
          </div>

          <div class="adm-row">
            <div>
              <label
                class="adm-row__label"
                title="Comment lire les cadres renvoyés par le détecteur."
                for="cnx-vision-format"
                >Format de réponse</label
              >
              <span class="sr-only">Comment lire les cadres renvoyés par le détecteur.</span>
            </div>
            <select
              id="cnx-vision-format"
              v-model="adm.configForm.vision.format"
              data-field="config:vision.format"
              class="set-select w-full max-w-sm"
            >
              <option value="omniparser">OmniParser</option>
              <option value="florence">Florence-2</option>
              <option value="grounding-dino">Grounding DINO</option>
              <option value="nvidia-locate-anything">NVIDIA LocateAnything</option>
              <option value="llm-chat">LLM multimodal (chat/completions)</option>
              <option value="custom">Personnalisé</option>
            </select>
          </div>

          <div v-if="adm.configForm.vision.format === 'llm-chat'" class="adm-row">
            <div>
              <label
                class="adm-row__label"
                title="Indispensable avec le routeur llama.cpp pour viser le modèle vision."
                for="cnx-vision-model"
                >Modèle</label
              >
              <span class="sr-only"
                >Indispensable avec le routeur llama.cpp pour viser le modèle vision.</span
              >
            </div>
            <input
              id="cnx-vision-model"
              v-model="adm.configForm.vision.model"
              data-field="config:vision.model"
              placeholder="qwen3-vl-8b"
              class="set-input font-mono text-xs max-w-sm"
            />
          </div>

          <div v-if="adm.configForm.vision.format === 'llm-chat'" class="adm-row">
            <div>
              <label
                class="adm-row__label"
                title="Les petites icônes de la barre système n'apparaissent qu'à la seconde passe."
                for="cnx-vision-passes"
                >Passes de détection</label
              >
              <span class="sr-only"
                >Les petites icônes de la barre système n'apparaissent qu'à la seconde passe.</span
              >
            </div>
            <select
              id="cnx-vision-passes"
              v-model.number="adm.configForm.vision.passes"
              data-field="config:vision.passes"
              class="set-select w-full max-w-[16rem]"
            >
              <option :value="1">1 — rapide</option>
              <option :value="2">2 — exhaustif (défaut)</option>
            </select>
          </div>

          <div class="adm-row adm-row--top">
            <div>
              <label
                class="adm-row__label"
                title="Vide = balayage exhaustif. Renseigné, la détection devient une recherche ciblée."
                for="cnx-vision-prompt"
                >Indice de recherche</label
              >
              <span class="sr-only"
                >Vide = balayage exhaustif. Renseigné, la détection devient une recherche ciblée.</span
              >
            </div>
            <textarea
              id="cnx-vision-prompt"
              v-model="adm.configForm.vision.prompt"
              data-field="config:vision.prompt"
              rows="2"
              placeholder="all clickable UI elements"
              class="set-textarea"
            ></textarea>
          </div>

          <details class="adm-details">
            <summary>Où sont les prompts de détection ?</summary>
            <p class="text-xs text-slate-500 mt-2 max-w-[68ch]">
              Dans la page
              <button type="button" class="adm-link" @click="adm.goAdminPage('prompts')">Prompts</button>,
              entrées <code class="font-mono">VISION_DETECT</code>,
              <code class="font-mono">VISION_DETECT_EDGE</code> et
              <code class="font-mono">VISION_DETECT_QUERY</code>. En mode LLM multimodal, prévoyez un délai
              large (60 à 120 s).
            </p>
          </details>
        </div>
      </section>

      <section v-if="adm.adminTab === 'voice'" id="voice" class="adm-card scroll-mt-32">
        <header class="adm-card__head">
          <i class="ph ph-microphone adm-card__icon" aria-hidden="true"></i>
          <div>
            <h3 class="adm-card__title">Moteur vocal</h3>
            <span class="sr-only">Deux services distincts : la dictée et la lecture des réponses.</span>
          </div>
        </header>
        <div v-if="adm.configForm && adm.configForm.voice" class="adm-rows">
          <div class="adm-row">
            <div>
              <label
                class="adm-row__label"
                title="Ouvre les réglages vocaux aux utilisateurs. Chaque utilisateur choisit ensuite, dans ses paramètres, s'il veut dicter et se faire lire les réponses."
                for="cnx-voice-on"
                >Activation</label
              >
              <span class="sr-only"
                >Ouvre les réglages vocaux aux utilisateurs. Chaque utilisateur choisit ensuite, dans ses
                paramètres, s'il veut dicter et se faire lire les réponses.</span
              >
            </div>
            <label class="relative inline-flex items-center gap-2 cursor-pointer w-fit">
              <input
                id="cnx-voice-on"
                v-model="adm.configForm.voice.enabled"
                type="checkbox"
                data-field="config:voice.enabled"
                class="sr-only peer"
              />
              <span
                class="set-switch-track block peer-checked:bg-blue-600 peer-checked:border-blue-600"
              ></span>
              <span class="text-sm text-slate-700">{{
                adm.configForm.voice.enabled ? "Activé" : "Désactivé"
              }}</span>
            </label>
          </div>

          <div v-if="!ui.classique" class="adm-row adm-row--full">
            <SousOngletsConsole
              v-model="ongletVoix"
              label="Réglages de la voix"
              page="voice"
              :onglets="ongletsVoix"
            />
          </div>
          <div
            v-show="surOnglet('voice', 'dictee')"
            id="onglet-voice-dictee"
            class="adm-onglet"
            :role="ui.classique ? undefined : 'tabpanel'"
            :aria-labelledby="ui.classique ? undefined : 'onglet-bouton-voice-dictee'"
          >
            <div v-if="adm.configForm.voice.stt" class="adm-row adm-row--full">
              <span class="text-sm font-medium text-slate-700">Reconnaissance</span>
            </div>

            <template v-if="adm.configForm.voice.stt">
              <div class="adm-row">
                <label class="adm-row__label" for="cnx-voice-stt-url">Adresse</label>
                <input
                  id="cnx-voice-stt-url"
                  v-model="adm.configForm.voice.stt.endpoint_url"
                  data-field="config:voice.stt.endpoint_url"
                  placeholder="http://machine-stt:8090"
                  title="Serveur whisper.cpp. Vide = dictée désactivée."
                  class="set-input font-mono text-xs"
                />
              </div>

              <div class="adm-row">
                <label class="adm-row__label" for="cnx-voice-stt-fmt">Format</label>
                <select
                  id="cnx-voice-stt-fmt"
                  v-model="adm.configForm.voice.stt.format"
                  data-field="config:voice.stt.format"
                  class="set-select w-full max-w-sm"
                >
                  <option value="whisper.cpp">whisper.cpp</option>
                  <option value="openai">Compatible OpenAI</option>
                  <option value="llama-audio">llama-server (GGUF audio)</option>
                </select>
              </div>

              <div class="adm-row">
                <label class="adm-row__label" for="cnx-voice-lang">Langue</label>
                <input
                  id="cnx-voice-lang"
                  v-model="adm.configForm.voice.stt.language"
                  data-field="config:voice.stt.language"
                  placeholder="fr"
                  title="Code ISO à deux lettres. « auto » laisse le modèle deviner, au prix d'un peu de latence."
                  class="set-input adm-num font-mono text-xs"
                />
              </div>

              <div v-if="adm.configForm.voice.stt.endpoint_url" class="adm-row">
                <div>
                  <label class="adm-row__label" title="Lu sur le serveur." for="cnx-voice-stt-model"
                    >Modèle</label
                  >
                  <span class="sr-only">Lu sur le serveur.</span>
                </div>
                <div class="flex items-center gap-2">
                  <span
                    v-if="adm.configForm.voice.stt.format === 'whisper.cpp'"
                    class="text-sm text-slate-600"
                    :title="adm.voiceModels.stt.detail"
                  >
                    {{
                      adm.voiceModels.stt.state === "err"
                        ? adm.voiceModels.stt.error
                        : "Celui chargé au démarrage du serveur"
                    }}
                  </span>
                  <template v-else>
                    <select
                      v-if="adm.voiceModels.stt.models.length"
                      id="cnx-voice-stt-model"
                      v-model="adm.configForm.voice.stt.model"
                      data-field="config:voice.stt.model"
                      class="set-select w-full max-w-sm font-mono text-xs"
                    >
                      <option
                        v-if="
                          adm.configForm.voice.stt.model &&
                          !adm.voiceModels.stt.models.some((m) => m.id === adm.configForm?.voice.stt.model)
                        "
                        :value="adm.configForm.voice.stt.model"
                      >
                        {{ adm.configForm.voice.stt.model }} (absent du serveur)
                      </option>
                      <option v-for="m in adm.voiceModels.stt.models" :key="m.id" :value="m.id">
                        {{ m.label || m.id }}
                      </option>
                    </select>
                    <input
                      v-else
                      id="cnx-voice-stt-model"
                      v-model="adm.configForm.voice.stt.model"
                      data-field="config:voice.stt.model"
                      placeholder="whisper-1"
                      :title="adm.voiceModels.stt.error || 'Liste indisponible : saisie manuelle.'"
                      class="set-input font-mono text-xs"
                    />
                  </template>
                  <button
                    type="button"
                    :disabled="adm.voiceModels.stt.state === 'busy'"
                    class="adm-btn adm-btn--icon"
                    title="Relire sur le serveur"
                    aria-label="Relire les modèles"
                    @click="adm.loadVoiceModels('stt')"
                  >
                    <i
                      class="ph ph-arrows-clockwise"
                      :class="adm.voiceModels.stt.state === 'busy' ? 'animate-spin' : ''"
                      aria-hidden="true"
                    ></i>
                  </button>
                </div>
              </div>
              <div
                v-if="
                  adm.configForm.voice.stt.endpoint_url &&
                  adm.configForm.voice.stt.endpoint_url.startsWith('https')
                "
                class="adm-row"
              >
                <label class="adm-row__label" for="cnx-voice-stt-verify">Certificat</label>
                <label class="relative inline-flex items-center gap-2 cursor-pointer w-fit">
                  <input
                    id="cnx-voice-stt-verify"
                    v-model="adm.configForm.voice.stt.verify"
                    type="checkbox"
                    data-field="config:voice.stt.verify"
                    class="sr-only peer"
                  />
                  <span
                    class="set-switch-track block peer-checked:bg-blue-600 peer-checked:border-blue-600"
                  ></span>
                  <span class="text-sm text-slate-700">{{
                    adm.configForm.voice.stt.verify ? "Vérifié" : "Non vérifié (auto-signé)"
                  }}</span>
                </label>
              </div>

              <div class="adm-row adm-row--top">
                <div>
                  <label
                    class="adm-row__label"
                    title="Termes à reconnaître, séparés par des virgules. Noms propres, jargon métier, sigles. Sur des termes spécialisés, ce champ divise le taux d'erreur par trois."
                    for="cnx-voice-prompt"
                    >Vocabulaire</label
                  >
                  <span class="sr-only"
                    >Termes à reconnaître, séparés par des virgules. Noms propres, jargon métier, sigles. Sur
                    des termes spécialisés, ce champ divise le taux d'erreur par trois.</span
                  >
                </div>
                <textarea
                  id="cnx-voice-prompt"
                  v-model="adm.configForm.voice.stt.prompt"
                  data-field="config:voice.stt.prompt"
                  rows="2"
                  placeholder="Elpis, Qdrant, bubblewrap"
                  class="set-textarea font-mono text-xs"
                ></textarea>
              </div>

              <div class="adm-row">
                <label class="adm-row__label" for="cnx-voice-stt-token">Jeton</label>
                <input
                  id="cnx-voice-stt-token"
                  v-model="adm.configForm.voice.stt.token"
                  data-field="config:voice.stt.token"
                  type="password"
                  autocomplete="new-password"
                  placeholder="facultatif"
                  class="set-input font-mono text-xs"
                />
              </div>
            </template>
          </div>

          <div
            v-show="surOnglet('voice', 'lecture')"
            id="onglet-voice-lecture"
            class="adm-onglet"
            :role="ui.classique ? undefined : 'tabpanel'"
            :aria-labelledby="ui.classique ? undefined : 'onglet-bouton-voice-lecture'"
          >
            <div v-if="adm.configForm.voice.tts" class="adm-row adm-row--full">
              <span class="text-sm font-medium text-slate-700">Synthèse</span>
            </div>

            <template v-if="adm.configForm.voice.tts">
              <div class="adm-row">
                <label class="adm-row__label" for="cnx-voice-tts-url">Adresse</label>
                <input
                  id="cnx-voice-tts-url"
                  v-model="adm.configForm.voice.tts.endpoint_url"
                  data-field="config:voice.tts.endpoint_url"
                  placeholder="http://machine-tts:8091"
                  title="Service Piper de deploy/voice/tts. Vide = lecture désactivée."
                  class="set-input font-mono text-xs"
                />
              </div>

              <div class="adm-row">
                <label class="adm-row__label" for="cnx-voice-tts-fmt">Format</label>
                <select
                  id="cnx-voice-tts-fmt"
                  v-model="adm.configForm.voice.tts.format"
                  data-field="config:voice.tts.format"
                  class="set-select w-full max-w-sm"
                >
                  <option value="elpis-tts">Service Elpis (Piper)</option>
                  <option value="piper-http">Piper (piper.http_server)</option>
                  <option value="openai">Compatible OpenAI</option>
                </select>
              </div>

              <div v-if="adm.configForm.voice.tts.format === 'openai'" class="adm-row">
                <label class="adm-row__label" for="cnx-voice-tts-model">Modèle</label>
                <div class="flex items-center gap-2">
                  <select
                    v-if="adm.voiceModels.tts.models.length"
                    id="cnx-voice-tts-model"
                    v-model="adm.configForm.voice.tts.model"
                    data-field="config:voice.tts.model"
                    class="set-select w-full max-w-sm font-mono text-xs"
                  >
                    <option v-if="!adm.configForm.voice.tts.model" value="" disabled>Choisir…</option>
                    <option v-for="m in adm.voiceModels.tts.models" :key="m.id" :value="m.id">
                      {{ m.label || m.id }}
                    </option>
                  </select>
                  <input
                    v-else
                    id="cnx-voice-tts-model"
                    v-model="adm.configForm.voice.tts.model"
                    data-field="config:voice.tts.model"
                    placeholder="tts-1"
                    :title="adm.voiceModels.tts.error || 'Liste indisponible : saisie manuelle.'"
                    class="set-input font-mono text-xs"
                  />
                  <button
                    type="button"
                    :disabled="adm.voiceModels.tts.state === 'busy'"
                    class="adm-btn adm-btn--icon"
                    title="Relire sur le serveur"
                    aria-label="Relire les modèles"
                    @click="adm.loadVoiceModels('tts')"
                  >
                    <i
                      class="ph ph-arrows-clockwise"
                      :class="adm.voiceModels.tts.state === 'busy' ? 'animate-spin' : ''"
                      aria-hidden="true"
                    ></i>
                  </button>
                </div>
              </div>

              <div class="adm-row">
                <div>
                  <label class="adm-row__label" for="cnx-voice-voix">Voix</label>
                  <p v-if="adm.configForm.voice.tts.format !== 'openai'" class="adm-row__hint">
                    Lue sur le serveur.
                  </p>
                </div>
                <div class="flex items-center gap-2">
                  <select
                    v-if="adm.configForm.voice.tts.format !== 'openai' && adm.voiceModels.tts.models.length"
                    id="cnx-voice-voix"
                    v-model="adm.configForm.voice.tts.voice"
                    data-field="config:voice.tts.voice"
                    class="set-select w-full max-w-sm font-mono text-xs"
                  >
                    <option
                      v-if="
                        adm.configForm.voice.tts.voice &&
                        !adm.voiceModels.tts.models.some((m) => m.id === adm.configForm?.voice.tts.voice)
                      "
                      :value="adm.configForm.voice.tts.voice"
                    >
                      {{ adm.configForm.voice.tts.voice }} (absente du serveur)
                    </option>
                    <option v-for="m in adm.voiceModels.tts.models" :key="m.id" :value="m.id">
                      {{ m.label || m.id }}
                    </option>
                  </select>
                  <input
                    v-else
                    id="cnx-voice-voix"
                    v-model="adm.configForm.voice.tts.voice"
                    data-field="config:voice.tts.voice"
                    :placeholder="
                      adm.configForm.voice.tts.format === 'openai' ? 'alloy' : 'fr_FR-siwis-medium'
                    "
                    :title="
                      adm.configForm.voice.tts.format === 'openai'
                        ? 'Nom de voix du service.'
                        : adm.voiceModels.tts.error || 'Liste indisponible : saisie manuelle.'
                    "
                    class="set-input font-mono text-xs"
                  />
                  <button
                    v-if="adm.configForm.voice.tts.format !== 'openai'"
                    type="button"
                    :disabled="adm.voiceModels.tts.state === 'busy'"
                    class="adm-btn adm-btn--icon"
                    title="Relire sur le serveur"
                    aria-label="Relire les voix"
                    @click="adm.loadVoiceModels('tts')"
                  >
                    <i
                      class="ph ph-arrows-clockwise"
                      :class="adm.voiceModels.tts.state === 'busy' ? 'animate-spin' : ''"
                      aria-hidden="true"
                    ></i>
                  </button>
                </div>
              </div>

              <div class="adm-row">
                <label class="adm-row__label" for="cnx-voice-vitesse">Vitesse</label>
                <div class="flex items-center gap-2">
                  <input
                    id="cnx-voice-vitesse"
                    v-model.number="adm.configForm.voice.tts.speed"
                    data-field="config:voice.tts.speed"
                    type="number"
                    min="0.5"
                    max="2"
                    step="0.1"
                    title="Entre 0,5 et 2. Au-delà, la voix se dégrade."
                    class="set-input adm-num"
                  />
                  <span class="adm-unit">×</span>
                </div>
              </div>

              <div class="adm-row">
                <label class="adm-row__label" for="cnx-voice-tts-token">Jeton</label>
                <input
                  id="cnx-voice-tts-token"
                  v-model="adm.configForm.voice.tts.token"
                  data-field="config:voice.tts.token"
                  type="password"
                  autocomplete="new-password"
                  placeholder="facultatif"
                  title="Service Elpis : contenu de token.env sur la machine de synthèse."
                  class="set-input font-mono text-xs"
                />
              </div>
              <div
                v-if="
                  adm.configForm.voice.tts.endpoint_url &&
                  adm.configForm.voice.tts.endpoint_url.startsWith('https')
                "
                class="adm-row"
              >
                <label class="adm-row__label" for="cnx-voice-tts-verify">Certificat</label>
                <label class="relative inline-flex items-center gap-2 cursor-pointer w-fit">
                  <input
                    id="cnx-voice-tts-verify"
                    v-model="adm.configForm.voice.tts.verify"
                    type="checkbox"
                    data-field="config:voice.tts.verify"
                    class="sr-only peer"
                  />
                  <span
                    class="set-switch-track block peer-checked:bg-blue-600 peer-checked:border-blue-600"
                  ></span>
                  <span class="text-sm text-slate-700">{{
                    adm.configForm.voice.tts.verify ? "Vérifié" : "Non vérifié (auto-signé)"
                  }}</span>
                </label>
              </div>
            </template>
          </div>

          <div class="adm-row adm-row--top">
            <div>
              <span class="adm-row__label" title="Teste les valeurs ci-dessus sans les enregistrer."
                >Vérification</span
              >
              <span class="sr-only">Teste les valeurs ci-dessus sans les enregistrer.</span>
            </div>
            <div>
              <button
                type="button"
                :disabled="adm.voiceTest.state === 'busy'"
                class="adm-btn adm-tool"
                @click="adm.testVoiceConnection"
              >
                <i
                  class="ph"
                  :class="adm.voiceTest.state === 'busy' ? 'ph-circle-notch animate-spin' : 'ph-pulse'"
                  aria-hidden="true"
                ></i>
                {{ adm.voiceTest.state === "busy" ? "Test en cours…" : "Tester les deux services" }}
              </button>

              <div v-if="adm.voiceTest.state === 'done'" class="mt-3 space-y-2">
                <div
                  v-for="part in adm.voiceTest.parts"
                  :key="part.id"
                  class="p-3 rounded-lg border"
                  :class="part.ok ? 'bg-emerald-50 border-emerald-200' : 'bg-rose-50 border-rose-200'"
                >
                  <div class="flex items-start gap-2">
                    <i
                      class="ph text-base shrink-0 mt-0.5"
                      :class="part.ok ? 'ph-check-circle text-emerald-600' : 'ph-x-circle text-rose-600'"
                      aria-hidden="true"
                    ></i>
                    <div class="min-w-0">
                      <div
                        class="text-sm font-medium"
                        :class="part.ok ? 'text-emerald-900' : 'text-rose-900'"
                      >
                        {{ part.title }}
                      </div>
                      <p
                        class="mt-1 text-xs break-words"
                        :class="part.ok ? 'text-emerald-800' : 'text-rose-800'"
                      >
                        {{ part.detail }}
                      </p>
                    </div>
                  </div>
                </div>
                <p v-if="!adm.voiceTest.allOk" class="text-xs text-slate-500">
                  Vérifiez que le service tourne à cette adresse, que le port est ouvert, et que le jeton
                  correspond.
                </p>
                <ul
                  v-if="adm.voiceTest.warnings && adm.voiceTest.warnings.length"
                  class="p-3 rounded-lg bg-amber-50 border border-amber-200 space-y-1"
                >
                  <li
                    v-for="w in adm.voiceTest.warnings"
                    :key="w"
                    class="flex items-start gap-2 text-xs text-amber-800"
                  >
                    <i class="ph ph-warning shrink-0 mt-0.5" aria-hidden="true"></i><span>{{ w }}</span>
                  </li>
                </ul>
              </div>

              <div
                v-else-if="adm.voiceTest.state === 'err'"
                class="mt-3 p-3 rounded-lg bg-rose-50 border border-rose-200"
              >
                <p class="text-xs text-rose-800 break-words">{{ adm.voiceTest.error }}</p>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section v-if="adm.adminTab === 'images'" id="images" class="adm-card scroll-mt-32">
        <header class="adm-card__head">
          <i class="ph ph-image adm-card__icon" aria-hidden="true"></i>
          <div>
            <h3 class="adm-card__title">Images</h3>
            <span class="sr-only">Moteur de génération d'images du chat et de l'outil du modèle.</span>
          </div>
        </header>
        <div v-if="adm.configForm && adm.configForm.image" class="adm-rows">
          <div class="adm-row">
            <label
              class="adm-row__label"
              for="cnx-image-on"
              title="Propose « Images » dans le menu + du chat. Chaque compte peut ensuite couper l'entrée dans ses Paramètres."
              >Activation</label
            >
            <label class="relative inline-flex items-center gap-2 cursor-pointer w-fit">
              <input
                id="cnx-image-on"
                v-model="adm.configForm.image.enabled"
                type="checkbox"
                data-field="config:image.enabled"
                class="sr-only peer"
              />
              <span
                class="set-switch-track block peer-checked:bg-blue-600 peer-checked:border-blue-600"
              ></span>
              <span class="text-sm text-slate-700">{{
                adm.configForm.image.enabled ? "Activé" : "Désactivé"
              }}</span>
            </label>
          </div>

          <div v-if="!ui.classique" class="adm-row adm-row--full">
            <SousOngletsConsole
              v-model="ongletImages"
              label="Réglages des images"
              page="images"
              :onglets="ongletsImages"
            />
          </div>
          <div
            v-show="surOnglet('images', 'connexion')"
            id="onglet-images-connexion"
            class="adm-onglet"
            :role="ui.classique ? undefined : 'tabpanel'"
            :aria-labelledby="ui.classique ? undefined : 'onglet-bouton-images-connexion'"
          >
            <div class="adm-row adm-row--full">
              <span class="text-sm font-medium text-slate-700">Connexion</span>
            </div>
            <div class="adm-row">
              <label class="adm-row__label" for="cnx-image-provider">Moteur</label>
              <select
                id="cnx-image-provider"
                v-model="adm.configForm.image.provider"
                data-field="config:image.provider"
                class="set-select w-full max-w-sm"
              >
                <option value="sdcpp">sd-server (stable-diffusion.cpp)</option>
                <option value="openai">Compatible OpenAI</option>
              </select>
            </div>
            <div class="adm-row">
              <label class="adm-row__label" for="cnx-image-url">Adresse</label>
              <input
                id="cnx-image-url"
                v-model="adm.configForm.image.url"
                data-field="config:image.url"
                :placeholder="
                  adm.configForm.image.provider === 'openai'
                    ? 'https://images.lan/v1'
                    : 'http://machine-gpu:8083'
                "
                title="Vide = génération désactivée."
                class="set-input font-mono text-xs"
              />
            </div>

            <div class="adm-row">
              <label
                class="adm-row__label"
                for="cnx-image-key"
                :title="
                  adm.configForm.image.provider === 'openai'
                    ? 'Envoyée en Bearer au service.'
                    : 'Facultative (proxy devant sd-server).'
                "
                >Clé</label
              >
              <div class="flex items-center gap-2 min-w-0">
                <input
                  id="cnx-image-key"
                  v-model="adm.imageKey.draft"
                  type="password"
                  autocomplete="new-password"
                  :placeholder="
                    adm.imageKey.has
                      ? 'Enregistrée — saisir pour remplacer'
                      : adm.imageKey.stale
                        ? 'À ressaisir'
                        : 'Aucune'
                  "
                  class="set-input font-mono text-xs"
                  @keydown.enter.prevent="adm.saveImageKey(false)"
                />
                <span
                  v-if="!adm.imageKey.has && adm.imageKey.stale"
                  class="elpis-img-status is-warn whitespace-nowrap"
                  title="Clé enregistrée pour une autre adresse"
                  data-image-key-stale
                  >À ressaisir</span
                >
                <button
                  type="button"
                  class="adm-btn"
                  :disabled="!adm.imageKey.draft || adm.imageKey.state === 'busy'"
                  data-image-key-save
                  @click="adm.saveImageKey(false)"
                >
                  Enregistrer
                </button>
                <button
                  v-if="adm.imageKey.has"
                  type="button"
                  class="adm-btn adm-btn--icon"
                  :disabled="adm.imageKey.state === 'busy'"
                  title="Effacer la clé"
                  aria-label="Effacer la clé"
                  @click="adm.saveImageKey(true)"
                >
                  <i class="ph ph-trash" aria-hidden="true"></i>
                </button>
              </div>
            </div>
            <p v-if="adm.imageKey.state === 'err'" class="elpis-img-status is-err px-1">
              {{ adm.imageKey.error }}
            </p>
            <div v-if="adm.configForm.image.url" class="adm-row">
              <label class="adm-row__label" for="cnx-image-model" title="Lu sur le serveur.">Modèle</label>
              <div class="flex items-center gap-2 min-w-0">
                <span
                  v-if="adm.configForm.image.provider === 'sdcpp'"
                  class="text-sm text-slate-600 font-mono truncate"
                  :title="adm.imageModels.error"
                >
                  {{
                    adm.imageModels.state === "err"
                      ? adm.imageModels.error
                      : (adm.imageModels.models[0] &&
                          (adm.imageModels.models[0].label || adm.imageModels.models[0].id)) ||
                        "Celui chargé au démarrage du serveur"
                  }}
                </span>
                <template v-else>
                  <select
                    v-if="adm.imageModels.models.length"
                    id="cnx-image-model"
                    v-model="adm.configForm.image.model"
                    data-field="config:image.model"
                    class="set-select w-full max-w-sm font-mono text-xs"
                  >
                    <option
                      v-if="
                        adm.configForm.image.model &&
                        !adm.imageModels.models.some((m) => m.id === adm.configForm?.image.model)
                      "
                      :value="adm.configForm.image.model"
                    >
                      {{ adm.configForm.image.model }} (absent du serveur)
                    </option>
                    <option v-for="m in adm.imageModels.models" :key="m.id" :value="m.id">
                      {{ m.label || m.id }}
                    </option>
                  </select>
                  <input
                    v-else
                    id="cnx-image-model"
                    v-model="adm.configForm.image.model"
                    data-field="config:image.model"
                    placeholder="gpt-image-1"
                    :title="adm.imageModels.error || 'Liste indisponible : saisie manuelle.'"
                    class="set-input font-mono text-xs"
                  />
                </template>
                <button
                  type="button"
                  :disabled="adm.imageModels.state === 'busy'"
                  class="adm-btn adm-btn--icon"
                  title="Relire sur le serveur"
                  aria-label="Relire les modèles"
                  @click="adm.loadImageModels()"
                >
                  <i
                    class="ph ph-arrows-clockwise"
                    :class="adm.imageModels.state === 'busy' ? 'animate-spin' : ''"
                    aria-hidden="true"
                  ></i>
                </button>
              </div>
            </div>
            <template v-if="adm.configForm.image.url && adm.configForm.image.url.startsWith('https')">
              <div class="adm-row">
                <label class="adm-row__label" for="cnx-image-verify">Certificat</label>
                <label class="relative inline-flex items-center gap-2 cursor-pointer w-fit">
                  <input
                    id="cnx-image-verify"
                    v-model="adm.configForm.image.verify"
                    type="checkbox"
                    data-field="config:image.verify"
                    class="sr-only peer"
                  />
                  <span
                    class="set-switch-track block peer-checked:bg-blue-600 peer-checked:border-blue-600"
                  ></span>
                  <span class="text-sm text-slate-700">{{
                    adm.configForm.image.verify ? "Vérifié" : "Non vérifié"
                  }}</span>
                </label>
              </div>
              <div v-if="adm.configForm.image.verify" class="adm-row adm-row--top">
                <label
                  class="adm-row__label"
                  for="cnx-image-ca"
                  title="Autorité de l'infrastructure interne, au format PEM. Vide : magasin du système."
                  >CA</label
                >
                <textarea
                  id="cnx-image-ca"
                  v-model="adm.configForm.image.ca_pem"
                  data-field="config:image.ca_pem"
                  rows="2"
                  placeholder="-----BEGIN CERTIFICATE-----"
                  class="set-textarea font-mono text-xs"
                ></textarea>
              </div>
            </template>
            <div class="adm-row adm-row--top">
              <span class="adm-row__label" title="Teste les valeurs ci-dessus sans les enregistrer."
                >Vérification</span
              >
              <div class="min-w-0">
                <button
                  type="button"
                  :disabled="adm.imageTest.state === 'busy' || !adm.configForm.image.url"
                  class="adm-btn adm-tool"
                  data-image-test
                  @click="adm.testImageEngine"
                >
                  <i
                    class="ph"
                    :class="adm.imageTest.state === 'busy' ? 'ph-circle-notch animate-spin' : 'ph-pulse'"
                    aria-hidden="true"
                  ></i>
                  {{ adm.imageTest.state === "busy" ? "Test…" : "Tester" }}
                </button>
                <p
                  v-if="adm.imageTest.state === 'done' && adm.imageTest.res"
                  class="elpis-img-status mt-2"
                  :class="adm.imageTest.res.ok ? 'is-ok' : 'is-err'"
                  role="status"
                  data-image-test-result
                >
                  {{ adm.imageTestLine(adm.imageTest.res) }}
                </p>
                <p
                  v-else-if="adm.imageTest.state === 'err'"
                  class="elpis-img-status is-err mt-2"
                  role="status"
                >
                  ✗ {{ adm.imageTest.error }}
                </p>
                <ul
                  v-if="
                    adm.imageTest.state === 'done' &&
                    adm.imageTest.res &&
                    adm.imageTest.res.warnings &&
                    adm.imageTest.res.warnings.length
                  "
                  class="mt-1 space-y-0.5"
                >
                  <li v-for="w in adm.imageTest.res.warnings" :key="w" class="elpis-img-status is-warn">
                    ⚠ {{ w }}
                  </li>
                </ul>
                <p v-if="adm.imageTest.adjusted" class="elpis-img-status mt-1">
                  Limites ajustées au moteur, à enregistrer.
                </p>
              </div>
            </div>
          </div>

          <div
            v-show="surOnglet('images', 'limites')"
            id="onglet-images-limites"
            class="adm-onglet"
            :role="ui.classique ? undefined : 'tabpanel'"
            :aria-labelledby="ui.classique ? undefined : 'onglet-bouton-images-limites'"
          >
            <div class="adm-row adm-row--full">
              <span class="text-sm font-medium text-slate-700">Limites</span>
            </div>
            <div class="adm-row">
              <label
                class="adm-row__label"
                for="cnx-image-maxside"
                title="Plus grand côté qu'un compte peut demander."
                >Côté max</label
              >
              <div class="flex items-center gap-2">
                <input
                  id="cnx-image-maxside"
                  v-model.number="adm.configForm.image.max_side"
                  data-field="config:image.max_side"
                  type="number"
                  min="256"
                  max="4096"
                  step="64"
                  class="set-input adm-num"
                />
                <span class="adm-unit">px</span>
              </div>
            </div>
            <div class="adm-row">
              <label
                class="adm-row__label"
                for="cnx-image-defside"
                title="Taille proposée à un compte qui n'a rien choisi."
                >Côté par défaut</label
              >
              <select
                id="cnx-image-defside"
                v-model.number="adm.configForm.image.default_side"
                data-field="config:image.default_side"
                class="set-select w-full max-w-[10rem] font-mono text-xs"
              >
                <option v-for="v in adm.imageSideChoices" :key="v" :value="v">{{ v }} px</option>
              </select>
            </div>
            <div class="adm-row">
              <label class="adm-row__label" for="cnx-image-n">Par demande</label>
              <div class="flex items-center gap-2">
                <input
                  id="cnx-image-n"
                  v-model.number="adm.configForm.image.max_n"
                  data-field="config:image.max_n"
                  type="number"
                  min="1"
                  max="8"
                  class="set-input adm-num"
                />
                <span class="adm-unit">images</span>
              </div>
            </div>
            <div v-if="adm.configForm.image.provider === 'openai'" class="adm-row">
              <label
                class="adm-row__label"
                for="cnx-image-conc"
                title="Générations simultanées vers ce service, tous processus confondus."
                >Simultanées</label
              >
              <input
                id="cnx-image-conc"
                v-model.number="adm.configForm.image.max_concurrent"
                data-field="config:image.max_concurrent"
                type="number"
                min="1"
                max="8"
                class="set-input adm-num"
              />
            </div>
            <div class="adm-row">
              <label
                class="adm-row__label"
                for="cnx-image-timeout"
                title="Compté à partir du début du calcul (pas de l'attente en file)."
                >Délai</label
              >
              <div class="flex items-center gap-2">
                <input
                  id="cnx-image-timeout"
                  v-model.number="adm.configForm.image.timeout_sec"
                  data-field="config:image.timeout_sec"
                  type="number"
                  min="10"
                  max="1800"
                  class="set-input adm-num"
                />
                <span class="adm-unit">s</span>
              </div>
            </div>
            <div v-if="adm.configForm.image.provider === 'openai'" class="adm-row">
              <label
                class="adm-row__label"
                for="cnx-image-policy"
                title="Fixes : les vrais modèles OpenAI n'acceptent que quelques tailles."
                >Tailles</label
              >
              <select
                id="cnx-image-policy"
                v-model="adm.configForm.image.size_policy"
                data-field="config:image.size_policy"
                class="set-select w-full max-w-[12rem]"
              >
                <option value="free">Libres (pas de 64)</option>
                <option value="fixed">Fixes</option>
              </select>
            </div>
            <div
              v-if="
                adm.configForm.image.provider === 'openai' && adm.configForm.image.size_policy === 'fixed'
              "
              class="adm-row"
            >
              <label class="adm-row__label" for="cnx-image-sizes" title="Séparées par des virgules."
                >Liste</label
              >
              <input
                id="cnx-image-sizes"
                :value="(adm.configForm.image.sizes || []).join(', ')"
                data-field="config:image.sizes"
                placeholder="1024x1024, 1536x1024, 1024x1536"
                class="set-input font-mono text-xs"
                @change="adm.setImageSizesText(($event.target as HTMLInputElement).value)"
              />
            </div>
            <div v-if="adm.configForm.image.provider === 'sdcpp'" class="adm-row">
              <label
                class="adm-row__label"
                for="cnx-image-edit"
                title="Comment le modèle chargé modifie une image."
                >Édition</label
              >
              <select
                id="cnx-image-edit"
                v-model="adm.configForm.image.edit_mode"
                data-field="config:image.edit_mode"
                class="set-select w-full max-w-sm"
              >
                <option value="init">Image de départ (img2img, force)</option>
                <option value="ref">Image de référence (FLUX.2 klein, Qwen-Image-Edit)</option>
              </select>
            </div>
          </div>

          <div
            v-show="surOnglet('images', 'acces')"
            id="onglet-images-acces"
            class="adm-onglet"
            :role="ui.classique ? undefined : 'tabpanel'"
            :aria-labelledby="ui.classique ? undefined : 'onglet-bouton-images-acces'"
          >
            <div class="adm-row adm-row--full">
              <span class="text-sm font-medium text-slate-700">Accès</span>
            </div>
            <div class="adm-row adm-row--top">
              <span
                class="adm-row__label"
                title="Aucun groupe coché : tous les comptes. Les administrateurs ont toujours accès."
                >Groupes</span
              >
              <div
                class="flex flex-wrap gap-1.5"
                role="group"
                aria-label="Groupes autorisés"
                data-field="config:image.groups"
              >
                <button
                  type="button"
                  class="elpis-img-chip"
                  :aria-pressed="!(adm.configForm.image.groups || []).length ? 'true' : 'false'"
                  @click="adm.setImageGroups([])"
                >
                  Tous
                </button>
                <button
                  v-for="g in adm.groupsList"
                  :key="g.id"
                  type="button"
                  class="elpis-img-chip"
                  :aria-pressed="(adm.configForm.image.groups || []).includes(g.id) ? 'true' : 'false'"
                  @click="adm.toggleImageGroup(g.id)"
                >
                  {{ g.name }}
                </button>
                <span
                  v-for="gid in adm.imageGroupsMissing"
                  :key="'x' + gid"
                  class="elpis-img-chip is-gone"
                  title="Groupe supprimé : ne donne accès à personne."
                  >#{{ gid }}
                  <button
                    type="button"
                    class="elpis-img-chip__x"
                    aria-label="Retirer"
                    @click="adm.toggleImageGroup(gid)"
                  >
                    <i class="ph ph-x" aria-hidden="true"></i>
                  </button>
                </span>
              </div>
            </div>
            <div class="adm-row">
              <label
                class="adm-row__label"
                for="cnx-image-tool"
                title="Appels de l'outil generate_image permis par tour du modèle."
                >Outil</label
              >
              <div class="flex items-center gap-2">
                <input
                  id="cnx-image-tool"
                  v-model.number="adm.configForm.image.tool_max_calls"
                  data-field="config:image.tool_max_calls"
                  type="number"
                  min="1"
                  max="20"
                  class="set-input adm-num"
                />
                <span class="adm-unit">appels/tour</span>
              </div>
            </div>
            <div class="adm-row">
              <label
                class="adm-row__label"
                for="cnx-image-enhance"
                title="Le modèle du chat peut réécrire la description avant l'envoi au moteur."
                >Enrichir</label
              >
              <label class="relative inline-flex items-center gap-2 cursor-pointer w-fit">
                <input
                  id="cnx-image-enhance"
                  v-model="adm.configForm.image.enhance_enabled"
                  type="checkbox"
                  data-field="config:image.enhance_enabled"
                  class="sr-only peer"
                />
                <span
                  class="set-switch-track block peer-checked:bg-blue-600 peer-checked:border-blue-600"
                ></span>
                <span class="text-sm text-slate-700">{{
                  adm.configForm.image.enhance_enabled ? "Proposé" : "Retiré"
                }}</span>
              </label>
            </div>
            <div class="adm-row">
              <label
                class="adm-row__label"
                for="cnx-image-keep"
                title="Images gardées par compte ; les plus anciennes sont effacées."
                >Conserver</label
              >
              <div class="flex items-center gap-2">
                <input
                  id="cnx-image-keep"
                  v-model.number="adm.configForm.image.keep_per_user"
                  data-field="config:image.keep_per_user"
                  type="number"
                  min="1"
                  max="1000"
                  class="set-input adm-num"
                />
                <span class="adm-unit">par compte</span>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section v-if="adm.adminTab === 'mcp'" id="mcp" class="adm-card scroll-mt-32">
        <header class="adm-card__head">
          <i class="ph ph-plug adm-card__icon" aria-hidden="true"></i>
          <div>
            <h3 class="adm-card__title">Serveur MCP</h3>
            <span class="sr-only">Pont Model Context Protocol lancé par l'application.</span>
          </div>
        </header>
        <div v-if="adm.configForm && adm.configForm.mcp" class="adm-rows">
          <div class="adm-row">
            <div>
              <label
                class="adm-row__label"
                title="Scanné au démarrage pour les serveurs MCP téléversés."
                for="cnx-mcp-dir"
                >Dossier des serveurs ajoutés</label
              >
              <span class="sr-only">Scanné au démarrage pour les serveurs MCP téléversés.</span>
            </div>
            <input
              id="cnx-mcp-dir"
              v-model="adm.configForm.mcp.servers_dir"
              data-field="config:mcp.servers_dir"
              placeholder="../mcp_custom_servers"
              class="set-input font-mono text-xs"
            />
          </div>

          <div class="adm-row">
            <div>
              <label class="adm-row__label" title="0 = relire à chaque appel." for="cnx-mcp-ttl"
                >Cache de la liste d'outils</label
              >
              <span class="sr-only">0 = relire à chaque appel.</span>
            </div>
            <div class="flex items-center gap-2">
              <input
                id="cnx-mcp-ttl"
                v-model.number="adm.configForm.mcp.tools_cache_ttl_sec"
                data-field="config:mcp.tools_cache_ttl_sec"
                type="number"
                min="0"
                max="86400"
                class="set-input adm-num"
              />
              <span class="adm-unit">s</span>
            </div>
          </div>
        </div>
      </section>

      <section v-if="adm.adminTab === 'mcp'" id="mcp-tokens" class="adm-card scroll-mt-32">
        <header class="adm-card__head">
          <i class="ph ph-key adm-card__icon" aria-hidden="true"></i>
          <div>
            <h3 class="adm-card__title">Jetons d'outils externes</h3>
            <span class="sr-only"
              >Jetons que chaque compte crée dans Paramètres, Connexions, pour brancher ses outils sur un
              client MCP ou OpenAPI.</span
            >
          </div>
        </header>
        <div v-if="adm.configForm && adm.configForm.mcp && adm.configForm.mcp.tokens" class="adm-rows">
          <div class="adm-row">
            <div>
              <label
                class="adm-row__label"
                title="Coupé : les jetons existants cessent de fonctionner et aucun ne peut être créé. Les jetons opencode ne sont pas concernés."
                for="cnx-tok-on"
                >Jetons d'outils</label
              >
              <span class="sr-only"
                >Coupé : les jetons existants cessent de fonctionner et aucun ne peut être créé. Les jetons
                opencode ne sont pas concernés.</span
              >
            </div>
            <label class="relative inline-flex items-center gap-2 cursor-pointer w-fit">
              <input
                id="cnx-tok-on"
                v-model="adm.configForm.mcp.tokens.tools_enabled"
                type="checkbox"
                data-field="config:mcp.tokens.tools_enabled"
                class="sr-only peer"
              />
              <span
                class="set-switch-track block peer-checked:bg-blue-600 peer-checked:border-blue-600"
              ></span>
              <span class="text-sm text-slate-700">{{
                adm.configForm.mcp.tokens.tools_enabled ? "Activés" : "Désactivés"
              }}</span>
            </label>
          </div>

          <div class="adm-row">
            <div>
              <label
                class="adm-row__label"
                title="Séparées par des virgules, parmi fs, shell, git, desktop, browser, skill_run. Retirer une famille la retire aussitôt des jetons existants."
                for="cnx-tok-fam"
                >Familles autorisées</label
              >
              <span class="sr-only"
                >Séparées par des virgules, parmi fs, shell, git, desktop, browser, skill_run. Retirer une
                famille la retire aussitôt des jetons existants.</span
              >
            </div>
            <input
              id="cnx-tok-fam"
              v-model="adm.configForm.mcp.tokens.tools_families"
              data-field="config:mcp.tokens.tools_families"
              placeholder="fs,shell,git,desktop,browser,skill_run"
              class="set-input font-mono text-xs"
            />
          </div>

          <div class="adm-row">
            <div>
              <label class="adm-row__label" title="0 = sans limite." for="cnx-tok-days">Durée maximale</label>
              <span class="sr-only">0 = sans limite.</span>
            </div>
            <div class="flex items-center gap-2">
              <input
                id="cnx-tok-days"
                v-model.number="adm.configForm.mcp.tokens.max_days"
                data-field="config:mcp.tokens.max_days"
                type="number"
                min="0"
                max="3650"
                class="set-input adm-num"
              />
              <span class="adm-unit">jours</span>
            </div>
          </div>

          <div class="adm-row">
            <div>
              <label class="adm-row__label" title="Jetons opencode et d'outils confondus." for="cnx-tok-max"
                >Jetons par compte</label
              >
              <span class="sr-only">Jetons opencode et d'outils confondus.</span>
            </div>
            <input
              id="cnx-tok-max"
              v-model.number="adm.configForm.mcp.tokens.max_per_user"
              data-field="config:mcp.tokens.max_per_user"
              type="number"
              min="1"
              max="1000"
              class="set-input adm-num"
            />
          </div>
        </div>
      </section>

      <section v-if="adm.adminTab === 'mcp'" id="mcp-oauth" class="adm-card scroll-mt-32">
        <header class="adm-card__head">
          <i class="ph ph-shield-check adm-card__icon" aria-hidden="true"></i>
          <div>
            <h3 class="adm-card__title">Autorisation OAuth des clients MCP</h3>
            <span class="sr-only"
              >Un client MCP qui ne reçoit que l'adresse du relais découvre l'autorisation et demande l'accord
              de l'utilisateur. Les familles restent bornées par les jetons d'outils.</span
            >
          </div>
        </header>
        <div v-if="adm.configForm && adm.configForm.mcp && adm.configForm.mcp.oauth" class="adm-rows">
          <div class="adm-row">
            <div>
              <label
                class="adm-row__label"
                title="Coupée : découverte, consentement et jetons OAuth refusés ; les accès déjà accordés cessent de fonctionner. Suit aussi l'interrupteur des jetons d'outils."
                for="cnx-oa-on"
                >Autorisation OAuth</label
              >
              <span class="sr-only"
                >Coupée : découverte, consentement et jetons OAuth refusés ; les accès déjà accordés cessent
                de fonctionner. Suit aussi l'interrupteur des jetons d'outils.</span
              >
            </div>
            <label class="relative inline-flex items-center gap-2 cursor-pointer w-fit">
              <input
                id="cnx-oa-on"
                v-model="adm.configForm.mcp.oauth.enabled"
                type="checkbox"
                data-field="config:mcp.oauth.enabled"
                class="sr-only peer"
              />
              <span
                class="set-switch-track block peer-checked:bg-blue-600 peer-checked:border-blue-600"
              ></span>
              <span class="text-sm text-slate-700">{{
                adm.configForm.mcp.oauth.enabled ? "Activée" : "Désactivée"
              }}</span>
            </label>
          </div>

          <div class="adm-row">
            <div>
              <label
                class="adm-row__label"
                title="Un client s'enregistre seul (RFC 7591). Redirections limitées à la boucle locale et à https. Coupé : seuls les clients déjà connus ou décrits par un document https sont acceptés."
                for="cnx-oa-dcr"
                >Enregistrement dynamique</label
              >
              <span class="sr-only"
                >Un client s'enregistre seul (RFC 7591). Redirections limitées à la boucle locale et à https.
                Coupé : seuls les clients déjà connus ou décrits par un document https sont acceptés.</span
              >
            </div>
            <label class="relative inline-flex items-center gap-2 cursor-pointer w-fit">
              <input
                id="cnx-oa-dcr"
                v-model="adm.configForm.mcp.oauth.dcr_enabled"
                type="checkbox"
                data-field="config:mcp.oauth.dcr_enabled"
                class="sr-only peer"
              />
              <span
                class="set-switch-track block peer-checked:bg-blue-600 peer-checked:border-blue-600"
              ></span>
              <span class="text-sm text-slate-700">{{
                adm.configForm.mcp.oauth.dcr_enabled ? "Permis" : "Refusé"
              }}</span>
            </label>
          </div>

          <div class="adm-row">
            <div>
              <label class="adm-row__label" title="Entre 300 et 86 400 secondes." for="cnx-oa-ttl"
                >Durée d'un jeton d'accès</label
              >
              <span class="sr-only">Entre 300 et 86 400 secondes.</span>
            </div>
            <div class="flex items-center gap-2">
              <input
                id="cnx-oa-ttl"
                v-model.number="adm.configForm.mcp.oauth.access_ttl_s"
                data-field="config:mcp.oauth.access_ttl_s"
                type="number"
                min="300"
                max="86400"
                class="set-input adm-num"
              />
              <span class="adm-unit">secondes</span>
            </div>
          </div>

          <div class="adm-row">
            <div>
              <label
                class="adm-row__label"
                title="Borné par la durée maximale des jetons d'outils."
                for="cnx-oa-days"
                >Durée d'une autorisation</label
              >
              <span class="sr-only">Borné par la durée maximale des jetons d'outils.</span>
            </div>
            <div class="flex items-center gap-2">
              <input
                id="cnx-oa-days"
                v-model.number="adm.configForm.mcp.oauth.refresh_days"
                data-field="config:mcp.oauth.refresh_days"
                type="number"
                min="1"
                max="3650"
                class="set-input adm-num"
              />
              <span class="adm-unit">jours</span>
            </div>
          </div>

          <div class="adm-row">
            <div>
              <span class="adm-row__label">Clients enregistrés</span>
            </div>
            <div class="space-y-1.5 min-w-0">
              <p v-if="!adm.oauthClients.length" class="text-xs text-slate-500">Aucun client.</p>
              <div
                v-for="c in adm.oauthClients"
                :key="c.client_id"
                class="flex items-center gap-2 text-xs min-w-0"
              >
                <span class="font-medium text-slate-700 truncate" :title="c.client_id">{{
                  c.name || c.client_id
                }}</span>
                <span class="text-slate-500 shrink-0"
                  >{{ c.kind === "dcr" ? "dynamique" : c.kind === "cimd" ? "document https" : "manuel" }} ·
                  {{ c.grants }} autorisation{{ c.grants > 1 ? "s" : "" }}</span
                >
                <button
                  type="button"
                  title="Supprimer le client"
                  aria-label="Supprimer le client"
                  class="ml-auto w-6 h-6 rounded text-slate-500 hover:bg-red-50 hover:text-red-600 flex items-center justify-center shrink-0"
                  @click="adm.deleteOauthClient(c)"
                >
                  <i class="ph ph-trash" aria-hidden="true"></i>
                </button>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section v-if="adm.adminTab === 'mcp'" id="mcp-manifest" class="adm-card scroll-mt-32">
        <header class="adm-card__head">
          <i class="ph ph-toolbox adm-card__icon" aria-hidden="true"></i>
          <div>
            <h3 class="adm-card__title">Outils par défaut</h3>
            <span class="sr-only"
              >Un serveur par famille dans mcp.json, chacun avec son endpoint. Retirer l'entrée retire ses
              outils.</span
            >
          </div>
          <div class="ml-auto flex items-center gap-1.5">
            <select
              v-model="adm.mcpExportTransport"
              aria-label="Transport de l'export"
              class="text-xs px-2 py-1 rounded-md border border-slate-200 bg-white"
            >
              <option value="http">HTTP</option>
              <option value="sse">SSE</option>
              <option value="stdio">stdio</option>
            </select>
            <label
              class="text-xs text-slate-600 flex items-center gap-1"
              title="Insérer le jeton de service dans l'export"
            >
              <input v-model="adm.mcpExportToken" type="checkbox" class="accent-blue-600" /> jeton
            </label>
            <button
              type="button"
              :disabled="adm.mcpManifestBusy"
              class="adm-btn adm-tool adm-btn--sm"
              title="Copier un bloc mcpServers prêt à coller dans un autre applicatif"
              @click="adm.copyMcpExport"
            >
              <i class="ph ph-copy" aria-hidden="true"></i> Exporter
            </button>
            <button
              type="button"
              :disabled="adm.mcpManifestBusy"
              class="adm-btn adm-tool adm-btn--sm"
              title="Relire mcp.json et réinitialiser le pool d'outils"
              @click="adm.reloadMcpManifest"
            >
              <i class="ph ph-arrow-clockwise" aria-hidden="true"></i> Recharger
            </button>
          </div>
        </header>
        <div v-if="!adm.mcpManifest" class="text-xs text-slate-400 px-4 py-3">Chargement…</div>
        <div v-else class="adm-rows">
          <div class="adm-row">
            <div>
              <span class="adm-row__label">Source</span>
              <p class="adm-row__hint font-mono text-[11px] break-all">
                {{
                  adm.mcpManifest.source === "file" ? adm.mcpManifest.path : "config héritée (aucun fichier)"
                }}
              </p>
            </div>
            <span
              class="text-xs"
              :class="adm.mcpManifest.source === 'file' ? 'text-emerald-700' : 'text-amber-700'"
              >{{ adm.mcpManifest.source === "file" ? "fichier" : "synthèse" }}</span
            >
          </div>
          <div v-if="adm.mcpManifest.errors && adm.mcpManifest.errors.length" class="adm-row">
            <div>
              <span class="adm-row__label text-red-700">Erreurs</span>
              <ul class="adm-row__hint font-mono text-[11px]">
                <li v-for="e in adm.mcpManifest.errors" :key="e">{{ e }}</li>
              </ul>
            </div>
          </div>
          <div v-if="adm.mcpManifest.warnings && adm.mcpManifest.warnings.length" class="adm-row">
            <div>
              <span class="adm-row__label text-amber-700">Avertissements</span>
              <ul class="adm-row__hint font-mono text-[11px]">
                <li v-for="w in adm.mcpManifest.warnings" :key="w">{{ w }}</li>
              </ul>
            </div>
          </div>
          <div class="px-4 pb-3 overflow-x-auto">
            <table class="w-full text-xs">
              <thead>
                <tr class="text-left text-slate-500 border-b border-slate-200">
                  <th class="py-1.5 pr-3 font-semibold">Nom</th>
                  <th class="py-1.5 pr-3 font-semibold">Rôle</th>
                  <th class="py-1.5 pr-3 font-semibold">Endpoints</th>
                  <th class="py-1.5 pr-3 font-semibold">Familles</th>
                  <th class="py-1.5 pr-3 font-semibold">Défaut</th>
                  <th class="py-1.5 pr-3 font-semibold">État</th>
                </tr>
              </thead>
              <tbody>
                <tr
                  v-for="s in adm.mcpManifest.servers"
                  :key="s.name"
                  class="border-b border-slate-100 align-top"
                  :class="s.enabled ? '' : 'opacity-50'"
                >
                  <td class="py-1.5 pr-3 font-mono" :title="s.description">{{ s.name }}</td>
                  <td class="py-1.5 pr-3">{{ adm.mcpManifestRoleLabel(s.role) }}</td>
                  <td class="py-1.5 pr-3 font-mono text-[11px] break-all">
                    <template v-if="s.endpoints && (s.endpoints.http || s.endpoints.sse)">
                      <div v-if="s.endpoints.http">{{ s.endpoints.http }}</div>
                      <div v-if="s.endpoints.sse" class="text-slate-500">{{ s.endpoints.sse }}</div>
                      <div v-if="s.endpoints.stdio" class="text-slate-500">
                        stdio · {{ s.endpoints.stdio.args.join(" ") }}
                      </div>
                    </template>
                    <template v-else>
                      {{ s.type }}<span v-if="s.url"> · {{ s.url }}</span
                      ><span v-else-if="s.command"> · {{ s.command }}</span>
                    </template>
                  </td>
                  <td class="py-1.5 pr-3 text-[11px]">
                    {{ s.families && s.families.length ? s.families.join(", ") : "—" }}
                  </td>
                  <td class="py-1.5 pr-3 text-[11px]">
                    {{
                      s.role === "external"
                        ? s.default_on_self
                          ? "oui"
                          : "non"
                        : s.default_on && s.default_on.length
                          ? s.default_on.join(", ")
                          : "—"
                    }}
                  </td>
                  <td class="py-1.5 pr-3">
                    <span v-if="!s.enabled" class="text-slate-500">désactivé</span>
                    <span v-else-if="s.reachable === true" class="text-emerald-700">joignable</span>
                    <span v-else-if="s.reachable === false" class="text-red-700"
                      >injoignable<span v-if="s.fallback"> · repli stdio</span></span
                    >
                    <span v-else class="text-slate-500">—</span>
                    <span
                      v-if="s.enabled && s.type !== 'stdio' && !s.has_token"
                      class="ml-1 text-amber-700"
                      title="Aucun jeton : loopback seul, rien de publié"
                      >⚠ sans jeton</span
                    >
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </section>

      <section v-if="adm.adminTab === 'vision'" id="desktop-targets" class="adm-card scroll-mt-32">
        <header class="adm-card__head">
          <i class="ph ph-desktop adm-card__icon" aria-hidden="true"></i>
          <div class="min-w-0">
            <h3 class="adm-card__title">Agents de contrôle</h3>
            <span class="sr-only">Machines pilotables à distance (Windows ou Linux).</span>
          </div>
          <div class="adm-card__actions">
            <button type="button" class="adm-btn adm-tool" @click="adm.addDesktopTarget">
              <i class="ph ph-plus" aria-hidden="true"></i> Ajouter
            </button>
          </div>
        </header>
        <div v-if="adm.configForm && adm.configForm.desktop" class="adm-rows">
          <div class="adm-row adm-row--full adm-row--top">
            <div v-if="!adm.configForm.desktop.targets.length" class="adm-empty">
              Aucune machine déclarée. Installez l'agent sur la machine cible (voir plus bas), puis « Ajouter
              » pour saisir son adresse.
            </div>
            <div v-else class="space-y-2">
              <div
                v-for="(t, i) in adm.configForm.desktop.targets"
                :key="i"
                class="grid grid-cols-1 md:grid-cols-12 gap-2 items-center border border-slate-200 rounded-lg p-2.5"
              >
                <input
                  v-model="t.name"
                  placeholder="win-vm-01"
                  aria-label="Nom de la machine"
                  class="md:col-span-2 set-input"
                />
                <select v-model="t.os" aria-label="Système" class="md:col-span-2 set-select w-full">
                  <option value="win">Windows</option>
                  <option value="linux">Linux</option>
                </select>
                <input
                  v-model="t.agent_url"
                  placeholder="http://10.0.0.5:8765"
                  aria-label="Adresse de l'agent"
                  class="md:col-span-2 set-input font-mono text-xs"
                />
                <input
                  v-model="t.agent_token"
                  type="password"
                  autocomplete="new-password"
                  placeholder="Jeton"
                  aria-label="Jeton de l'agent"
                  title="Contenu de agent_token.txt sur la machine (affiché à l'installation de l'agent)"
                  class="md:col-span-2 set-input font-mono text-xs"
                />

                <select
                  :value="t.access || 'all'"
                  aria-label="Accès à la machine"
                  class="md:col-span-2 set-select w-full"
                  :title="
                    (t.access || 'all') === 'list'
                      ? (t.allowed_users || []).length
                        ? 'Comptes : ' + t.allowed_users.join(', ')
                        : 'Administrateurs seulement'
                      : 'Tout compte connecté'
                  "
                  @change="
                    t.access = ($event.target as HTMLInputElement).value;
                    if (!Array.isArray(t.allowed_users)) t.allowed_users = [];
                  "
                >
                  <option value="all">Tous</option>
                  <option value="list">Liste ({{ (t.allowed_users || []).length }})</option>
                </select>
                <div class="md:col-span-2 flex items-center justify-end gap-2">
                  <label
                    class="flex items-center gap-1.5 text-xs text-slate-600 cursor-pointer"
                    title="Machine utilisée par défaut"
                  >
                    <input
                      type="radio"
                      name="desktop_default"
                      :checked="t.default"
                      class="text-blue-600 focus:ring-blue-500"
                      @change="adm.setDefaultTarget(i)"
                    />
                    défaut
                  </label>
                  <button
                    type="button"
                    title="Retirer cette machine"
                    class="adm-btn adm-btn--icon adm-btn--icon-danger"
                    @click="adm.removeDesktopTarget(i)"
                  >
                    <i class="ph ph-trash text-sm" aria-hidden="true"></i>
                  </button>
                </div>
              </div>
            </div>
          </div>

          <div class="adm-row">
            <div>
              <label
                class="adm-row__label"
                title="JPEG allège fortement le transport ; l'OCR reste en PNG."
                for="cnx-shot-format"
                >Format des captures</label
              >
              <span class="sr-only">JPEG allège fortement le transport ; l'OCR reste en PNG.</span>
            </div>
            <div class="flex items-center gap-2 flex-wrap">
              <select
                id="cnx-shot-format"
                v-model="adm.configForm.desktop.screenshot_format"
                data-field="config:desktop.screenshot_format"
                class="set-select w-auto min-w-[9rem]"
              >
                <option value="png">PNG</option>
                <option value="jpeg">JPEG</option>
              </select>
              <template v-if="adm.configForm.desktop.screenshot_format === 'jpeg'">
                <span class="adm-unit">qualité</span>
                <input
                  v-model.number="adm.configForm.desktop.screenshot_quality"
                  type="number"
                  min="40"
                  max="95"
                  data-field="config:desktop.screenshot_quality"
                  aria-label="Qualité JPEG"
                  class="set-input adm-num--sm"
                />
              </template>
            </div>
          </div>

          <details class="adm-details">
            <summary>Installer l'agent sur une machine cible</summary>
            <div class="mt-2 space-y-2">
              <p class="text-xs text-slate-500 max-w-[68ch]">
                À exécuter sur la machine à piloter. Volontairement en clair : elle ne connaît pas encore le
                certificat local.
              </p>
              <div class="flex items-center gap-2">
                <span class="text-xs font-medium text-slate-500 w-16 shrink-0">Linux</span>
                <code class="adm-cmd">{{ adm.installShCmd }}</code>
                <button
                  type="button"
                  title="Copier la commande"
                  class="adm-btn adm-btn--icon"
                  @click="adm.copyInstallCmd(adm.installShCmd)"
                >
                  <i class="ph ph-copy text-sm" aria-hidden="true"></i>
                </button>
              </div>
              <div class="flex items-center gap-2">
                <span class="text-xs font-medium text-slate-500 w-16 shrink-0">Windows</span>
                <code class="adm-cmd">{{ adm.installPs1Cmd }}</code>
                <button
                  type="button"
                  title="Copier la commande"
                  class="adm-btn adm-btn--icon"
                  @click="adm.copyInstallCmd(adm.installPs1Cmd)"
                >
                  <i class="ph ph-copy text-sm" aria-hidden="true"></i>
                </button>
              </div>
              <button
                type="button"
                class="adm-link inline-flex items-center gap-1.5"
                @click="adm.downloadAgentBundle"
              >
                <i class="ph ph-download-simple" aria-hidden="true"></i> Ou télécharger l'archive à installer
                manuellement
              </button>
            </div>
          </details>
        </div>
      </section>
    </div>
  </div>
</template>
