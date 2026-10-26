<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/reglages/onglets/OngletAgents.vue — onglet « agents » des Paramètres. -->
<script setup lang="ts">
import AideLigne from "../AideLigne.vue";
import AideOnglet from "../AideOnglet.vue";
import { LIBELLES_REFLEXION } from "../../../features/reglages/agents";
import { domaineReglages } from "../../../features/reglages/domaine";
import CaseLectureSeuleAgent from "../CaseLectureSeuleAgent.vue";

const rg = domaineReglages();
</script>

<template>
  <!-- eslint-disable vue/multiline-html-element-content-newline -->
  <div class="space-y-5 max-w-2xl">
    <AideOnglet titre="Agents"
      >Sous-missions déléguées à des agents éphémères via l'outil <span class="font-mono">task</span>, et
      agents personnalisés façon OpenCode.</AideOnglet
    >

    <p
      v-if="!rg.features.agents"
      class="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2"
    >
      Sous-agents désactivés sur cette instance (réglage administrateur).
    </p>
    <div class="bg-slate-50 rounded-xl">
      <label class="set-row cursor-pointer hover:bg-white/60 transition-colors rounded-xl">
        <i class="ph ph-users-three text-slate-400 text-lg w-5"></i>
        <div class="flex-1 min-w-0">
          <div class="text-sm text-slate-800">Activer les sous-agents</div>
          <div class="text-xs text-slate-500">
            Désactivés par défaut. Une fois activés, l'assistant peut déléguer une sous-mission (explorer,
            implémenter, vérifier, chercher sur le web, ouvrir une PR) à un agent isolé via l'outil task.
          </div>
        </div>
        <div class="relative inline-flex items-center shrink-0">
          <input
            v-model="rg.settings.agents_enabled"
            type="checkbox"
            class="sr-only peer"
            @change="rg.persistAgentsEnabled()"
          />
          <div class="set-switch-track peer-checked:bg-blue-600 peer-checked:border-blue-600"></div>
        </div>
      </label>
    </div>

    <p
      v-if="rg.settings.agents_enabled && rg.agentBank.length && !rg.agentBank.some((a) => a.enabled)"
      class="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2"
      data-agents-none-active
    >
      Aucun agent actif : outil task indisponible.
    </p>

    <div>
      <div class="flex items-center justify-between mb-1.5">
        <div class="text-sm font-medium text-slate-700 flex items-center gap-2">
          <i class="ph ph-users-three text-slate-400" aria-hidden="true"></i> Banque d'agents
        </div>
        <span
          class="text-xs text-slate-400 font-mono"
          title="Agents personnalisés (les modèles ne comptent pas)"
          >{{ rg.agentCustomCount }} / {{ rg.CUSTOM_AGENTS_MAX }}</span
        >
      </div>
      <p id="agents-lecture-seule-aide" class="text-xs text-slate-500 mb-2">
        Lecture seule : l'agent n'écrit aucun fichier, ne fait aucun commit et ne lance ni tâche de fond ni
        shell ; il garde la lecture.
      </p>
      <div class="space-y-2" data-agent-bank>
        <div
          v-for="a in rg.agentBank"
          :key="a.name"
          class="border border-slate-200 rounded-xl p-3.5"
          :class="{ 'opacity-60': !a.enabled }"
          :data-agent-row="a.name"
        >
          <div class="flex items-center gap-3">
            <img
              v-if="a.icon === 'ph-robot'"
              :src="rg.logoApp"
              alt=""
              data-logo-sous-agent
              class="w-5 h-5 rounded-full object-cover shrink-0"
            />
            <i v-else class="ph text-lg text-slate-400 shrink-0" :class="a.icon" aria-hidden="true"></i>
            <div class="flex-1 min-w-0">
              <div class="flex items-center gap-2 min-w-0">
                <span class="text-sm font-mono font-medium text-slate-800 truncate">{{ a.name }}</span>
                <span
                  v-if="a.template"
                  class="text-xs font-medium px-1.5 py-0.5 rounded shrink-0"
                  :class="a.modified ? 'bg-blue-50 text-blue-700' : 'bg-slate-100 text-slate-500'"
                  :title="a.modified ? 'Modèle livré, personnalisé' : 'Modèle livré'"
                  data-agent-badge
                  >{{ a.modified ? "modifié" : "modèle" }}</span
                >
              </div>
              <div class="text-xs text-slate-500 truncate">{{ a.description }}</div>
            </div>
            <div class="flex items-center gap-1 shrink-0 max-w-[38%] overflow-hidden">
              <span
                v-for="cat in a.tool_categories"
                :key="cat"
                class="text-xs px-1.5 py-0.5 rounded bg-slate-100 text-slate-600 whitespace-nowrap"
                >{{ ((rg.mcpUserCategories || []).find((c) => c.name === cat) || {}).label || cat }}</span
              >
              <span
                v-for="sid in a.mcp_server_ids"
                :key="sid"
                class="text-xs px-1.5 py-0.5 rounded bg-slate-100 text-slate-600 whitespace-nowrap inline-flex items-center gap-1"
                ><i class="ph ph-plug text-xs" aria-hidden="true"></i
                >{{ ((rg.agentMcpChoices || []).find((s) => s.id === sid) || {}).name || sid }}</span
              >
            </div>

            <label
              class="relative inline-flex items-center shrink-0 cursor-pointer"
              :title="a.enabled ? 'Actif' : 'Désactivé — absent du roster'"
            >
              <input
                type="checkbox"
                :checked="a.enabled"
                class="sr-only peer"
                :aria-label="'Activer ' + a.name"
                :data-agent-enabled="a.name"
                @change="rg.toggleAgentEnabled(a)"
              />
              <span
                class="set-switch-track block peer-checked:bg-blue-600 peer-checked:border-blue-600"
              ></span>
            </label>
            <button
              title="Modifier"
              :aria-label="'Modifier ' + a.name"
              :data-agent-edit="a.name"
              class="w-7 h-7 rounded-md text-slate-500 hover:bg-slate-100 hover:text-slate-700 flex items-center justify-center shrink-0"
              @click="rg.startEditAgent(a)"
            >
              <i class="ph ph-pencil-simple" aria-hidden="true"></i>
            </button>
            <button
              title="Dupliquer"
              :aria-label="'Dupliquer ' + a.name"
              :data-agent-dup="a.name"
              class="w-7 h-7 rounded-md text-slate-500 hover:bg-slate-100 hover:text-slate-700 flex items-center justify-center shrink-0"
              @click="rg.duplicateAgent(a)"
            >
              <i class="ph ph-copy" aria-hidden="true"></i>
            </button>
            <button
              v-if="a.template && a.modified"
              title="Réinitialiser"
              :aria-label="'Réinitialiser ' + a.name"
              :data-agent-reset="a.name"
              class="w-7 h-7 rounded-md text-slate-500 hover:bg-slate-100 hover:text-slate-700 flex items-center justify-center shrink-0"
              @click="rg.resetAgentToTemplate(a)"
            >
              <i class="ph ph-arrow-counter-clockwise" aria-hidden="true"></i>
            </button>
            <button
              v-if="!a.template"
              title="Supprimer"
              aria-label="Supprimer l'agent"
              class="w-7 h-7 rounded-md text-slate-500 hover:bg-red-50 hover:text-red-600 flex items-center justify-center shrink-0"
              @click="rg.deleteCustomAgent(a)"
            >
              <i class="ph ph-trash" aria-hidden="true"></i>
            </button>
          </div>
          <CaseLectureSeuleAgent
            :agent="a"
            aide="agents-lecture-seule-aide"
            @basculer="rg.toggleAgentReadOnly(a)"
          />
          <p class="mt-1 pl-8 text-xs text-slate-400" :data-agent-thinking="a.name">
            Réflexion : {{ LIBELLES_REFLEXION[a.thinking] }},
            {{ a.thinking_source === "compte" ? "votre réglage" : "défaut de l'administrateur" }}
          </p>
        </div>
      </div>
      <p v-if="!rg.agentBank.length && !rg.agentForm" class="text-sm text-slate-500 py-3 text-center">
        Aucun agent.
      </p>
    </div>

    <div v-if="rg.agentForm" class="border border-blue-200 bg-blue-50/40 rounded-xl p-4 space-y-2.5">
      <div class="text-sm font-medium text-slate-700">
        {{
          rg.agentForm._template
            ? "Modifier le modèle"
            : rg.agentForm._idx >= 0
              ? "Modifier l'agent"
              : "Nouvel agent"
        }}
      </div>
      <div>
        <label class="text-xs font-medium text-slate-500">Nom</label>

        <div
          v-if="rg.agentForm._template"
          class="set-input font-mono mt-0.5 bg-slate-50 text-slate-600 select-all"
          data-agent-name-locked
        >
          {{ rg.agentForm.name }}
        </div>
        <input
          v-else
          v-model="rg.agentForm.name"
          placeholder="docs-writer"
          class="set-input font-mono mt-0.5"
        />
        <AideLigne>{{
          rg.agentForm._template
            ? "Modèle livré — dupliquez-le pour une variante sous un autre nom."
            : "1-32 caractères : a-z, 0-9, tirets. C'est la valeur que le modèle passe à l'outil task."
        }}</AideLigne>
      </div>
      <div>
        <label class="text-xs font-medium text-slate-500">Description</label>
        <input
          v-model="rg.agentForm.description"
          maxlength="200"
          :placeholder="
            rg.agentForm._template
              ? rg.agentForm._tplSummary || 'description du modèle'
              : 'rédige la documentation du dépôt'
          "
          class="set-input mt-0.5"
        />
        <AideLigne>Une ligne — sert au modèle pour choisir cet agent.</AideLigne>
      </div>
      <div>
        <div class="flex items-center justify-between gap-2">
          <label class="text-xs font-medium text-slate-500">Prompt système</label>
          <button
            v-if="rg.agentFormPromptDiffers"
            data-agent-prompt-restore
            title="Rendre la persona livrée avec ce modèle"
            class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg border border-slate-200 bg-white text-slate-600 hover:bg-slate-50 text-xs font-semibold transition-colors"
            @click="rg.restoreTemplatePrompt()"
          >
            <i class="ph ph-arrow-counter-clockwise text-[13px]" aria-hidden="true"></i> Prompt livré
          </button>
          <button
            v-else-if="!(rg.agentForm.prompt || '').trim()"
            title="Insère la structure des agents intégrés : rôle, objectif, guidage outil, méthode, effort, contraintes, rapport, exemples"
            class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg border border-blue-200 bg-blue-50 text-blue-700 hover:bg-blue-100 hover:border-blue-300 text-xs font-semibold transition-colors"
            @click="rg.insertAgentTemplate()"
          >
            <i class="ph ph-file-text text-[13px]" aria-hidden="true"></i> Gabarit
          </button>
        </div>
        <textarea
          v-model="rg.agentForm.prompt"
          rows="10"
          placeholder="Tu es un spécialiste de… — bouton Gabarit pour la structure recommandée"
          class="set-textarea font-mono mt-0.5 w-full"
        ></textarea>
        <AideLigne>{{
          rg.agentForm._template
            ? "Identique au livré = l'agent suit les mises à jour du modèle."
            : "Remplace le prompt de base pour cet agent."
        }}</AideLigne>
      </div>

      <div>
        <label class="text-xs font-medium text-slate-500">Outils locaux</label>
        <div v-if="(rg.mcpUserCategories || []).length === 0" class="text-xs text-slate-400 italic mt-1">
          Aucune catégorie d'outils disponible.
        </div>
        <div v-else class="grid grid-cols-2 gap-x-2 gap-y-0.5 mt-1">
          <label
            v-for="cat in rg.mcpUserCategories"
            :key="cat.name"
            class="flex items-center justify-between gap-2 cursor-pointer p-1.5 hover:bg-slate-50 rounded-lg transition-colors"
          >
            <span class="text-xs font-semibold text-slate-700 flex items-center gap-2.5 min-w-0">
              <span
                class="w-6 h-6 rounded flex items-center justify-center shrink-0"
                :class="rg.mcpCategoryBgClass(cat)"
              >
                <i class="ph text-sm" :class="cat.icon || 'ph-package'" aria-hidden="true"></i>
              </span>
              <span class="truncate">{{ cat.label || cat.name }}</span>
            </span>
            <span class="relative inline-flex items-center shrink-0">
              <input
                type="checkbox"
                :checked="rg.agentForm.tool_categories.includes(cat.name)"
                class="sr-only peer"
                @change="rg.toggleAgentCat(cat.name)"
              />
              <span
                class="set-switch-track block peer-checked:bg-blue-600 peer-checked:border-blue-600"
              ></span>
            </span>
          </label>
        </div>
        <AideLigne>{{
          rg.agentForm._template
            ? "Catégories entières. Aucune sélection = celles du modèle."
            : "Catégories entières. Aucune sélection = socle par défaut : Fichiers, Terminal, Git."
        }}</AideLigne>
      </div>
      <div v-if="(rg.agentMcpChoices || []).length">
        <label class="text-xs font-medium text-slate-500">Serveurs MCP</label>
        <div class="grid grid-cols-2 gap-x-2 gap-y-0.5 mt-1">
          <label
            v-for="srv in rg.agentMcpChoices"
            :key="srv.id"
            class="flex items-center justify-between gap-2 cursor-pointer p-1.5 hover:bg-slate-50 rounded-lg transition-colors"
          >
            <span class="text-xs font-semibold text-slate-700 flex items-center gap-2.5 min-w-0">
              <span
                class="w-6 h-6 rounded bg-slate-100 text-slate-500 flex items-center justify-center shrink-0"
              >
                <i class="ph ph-plug text-sm" aria-hidden="true"></i>
              </span>
              <span class="truncate">{{ srv.name || srv.id }}</span>
            </span>
            <span class="relative inline-flex items-center shrink-0">
              <input
                type="checkbox"
                :checked="rg.agentForm.mcp_server_ids.includes(srv.id)"
                class="sr-only peer"
                @change="rg.toggleAgentMcp(srv.id)"
              />
              <span
                class="set-switch-track block peer-checked:bg-blue-600 peer-checked:border-blue-600"
              ></span>
            </span>
          </label>
        </div>
        <AideLigne
          >L'agent se connecte à ces serveurs en plus des outils locaux cochés — même s'ils ne sont pas actifs
          dans le chat.</AideLigne
        >
      </div>
      <div>
        <label class="text-xs font-medium text-slate-500">Budget d'itérations</label>
        <input
          v-model="rg.agentForm.max_iters"
          type="number"
          min="1"
          :max="rg.CUSTOM_ITERS_MAX"
          :placeholder="
            rg.agentForm._template && rg.agentForm._tplIters ? String(rg.agentForm._tplIters) : 'défaut'
          "
          class="set-input font-mono mt-0.5"
        />
        <AideLigne>Nombre d'appels d'outils avant arrêt. Vide = valeur par défaut.</AideLigne>
      </div>
      <div>
        <label class="text-xs font-medium text-slate-500" for="agent-reflexion">Réflexion</label>
        <select
          id="agent-reflexion"
          v-model="rg.agentForm.thinking"
          class="set-select mt-0.5"
          data-agent-thinking-select
        >
          <option value="">Défaut : {{ LIBELLES_REFLEXION[rg.agentReflexionDefaut] }}</option>
          <option value="off">Désactivée</option>
          <option value="on">Activée</option>
          <option value="inherit">Celle du chat</option>
        </select>
        <AideLigne
          >L'agent réfléchit dans son contexte isolé : seul son rapport remonte. « Celle du chat » suit le
          mode de la conversation. Sans effet si le modèle ne réfléchit pas.</AideLigne
        >
      </div>
      <div v-if="rg.agentFormError" class="text-xs text-red-600 bg-red-500/10 rounded-lg px-3 py-2">
        {{ rg.agentFormError }}
      </div>
      <div class="flex items-center gap-2 pt-1">
        <button
          class="px-3.5 py-1.5 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm font-medium transition-colors"
          @click="rg.saveAgentForm()"
        >
          {{ rg.agentForm._template || rg.agentForm._idx >= 0 ? "Enregistrer" : "Ajouter" }}
        </button>
        <button
          class="px-3 py-1.5 text-sm font-medium text-slate-600 hover:bg-slate-100 rounded-lg transition-colors"
          @click="rg.cancelAgentForm()"
        >
          Annuler
        </button>
      </div>
    </div>
    <button
      v-if="!rg.agentForm"
      class="w-full px-3 py-2 border border-dashed border-slate-300 rounded-lg text-sm text-slate-500 hover:border-blue-300 hover:text-blue-600 transition-colors flex items-center justify-center gap-1.5"
      @click="rg.startCreateAgent()"
    >
      <i class="ph ph-plus"></i> Créer un agent
    </button>
  </div>
</template>
