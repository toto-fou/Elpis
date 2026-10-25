<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/reglages/onglets/OngletChat.vue — onglet « chat » des Paramètres. -->
<script setup lang="ts">
import AideOnglet from "../AideOnglet.vue";
import { domaineReglages } from "../../../features/reglages/domaine";

const rg = domaineReglages();
</script>

<template>
  <!-- eslint-disable vue/multiline-html-element-content-newline -->
  <div class="space-y-5 max-w-xl">
    <AideOnglet titre="Chat">Comportement et présentation des conversations.</AideOnglet>

    <div>
      <label class="block text-xs font-medium text-slate-600 mb-1.5">Prompt système</label>
      <textarea
        v-model="rg.settings.system_prompt"
        rows="4"
        placeholder="Instructions personnalisées pour l'assistant…"
        class="set-textarea"
      ></textarea>
    </div>

    <div class="bg-slate-50 rounded-lg p-3.5" :class="rg.settings.skin === 'llamacpp' ? 'opacity-50' : ''">
      <div class="flex justify-between items-center mb-2">
        <span class="text-sm text-slate-700">Largeur</span>
        <span class="text-xs font-mono text-blue-600 bg-white px-2 py-0.5 rounded border border-slate-200"
          >{{ rg.settings.chat_width }}%</span
        >
      </div>
      <input
        v-model.number="rg.settings.chat_width"
        type="range"
        min="30"
        max="100"
        step="5"
        :disabled="rg.settings.skin === 'llamacpp'"
        class="set-range w-full"
      />
      <p v-if="rg.settings.skin === 'llamacpp'" class="text-xs text-slate-500 mt-1.5">
        Largeur fixe (colonne centrée) imposée par l'habillage llama.cpp.
      </p>
    </div>

    <div class="bg-slate-50 rounded-xl">
      <label class="set-row cursor-pointer hover:bg-white/60 transition-colors rounded-xl">
        <i class="ph ph-brain text-slate-400 text-lg w-5"></i>
        <div class="flex-1 min-w-0">
          <div class="text-sm text-slate-800">Masquer le raisonnement</div>
          <div class="text-xs text-slate-500">
            Cache les blocs « thinking » des réponses. Le raisonnement reste produit, il n'est simplement plus
            affiché.
          </div>
        </div>
        <div class="relative inline-flex items-center shrink-0">
          <input v-model="rg.settings.hide_thinking" type="checkbox" class="sr-only peer" />
          <div class="set-switch-track peer-checked:bg-blue-600 peer-checked:border-blue-600"></div>
        </div>
      </label>
    </div>

    <div class="bg-slate-50 rounded-xl">
      <label class="set-row cursor-pointer hover:bg-white/60 transition-colors rounded-xl">
        <i class="ph ph-browser text-slate-400 text-lg w-5"></i>
        <div class="flex-1 min-w-0">
          <div class="text-sm text-slate-800">Masquer les captures web</div>
          <div class="text-xs text-slate-500">
            Cache les captures d'écran du navigateur dans les réponses. L'outil continue de les prendre.
          </div>
        </div>
        <div class="relative inline-flex items-center shrink-0">
          <input v-model="rg.settings.hide_web_screenshots" type="checkbox" class="sr-only peer" />
          <div class="set-switch-track peer-checked:bg-blue-600 peer-checked:border-blue-600"></div>
        </div>
      </label>
    </div>

    <div class="bg-slate-50 rounded-xl">
      <label class="set-row cursor-pointer hover:bg-white/60 transition-colors rounded-xl">
        <i class="ph ph-terminal-window text-slate-400 text-lg w-5"></i>
        <div class="flex-1 min-w-0">
          <div class="text-sm text-slate-800">Terminal en direct</div>
          <div class="text-xs text-slate-500">
            Affiche la sortie des commandes shell exécutées par l'assistant en temps réel, dans la
            conversation. Désactivé, la sortie reste visible dans le détail de l'outil.
          </div>
        </div>
        <div class="relative inline-flex items-center shrink-0">
          <input
            v-model="rg.settings.live_shell_enabled"
            type="checkbox"
            class="sr-only peer"
            @change="rg.persistLiveShell"
          />
          <div class="set-switch-track peer-checked:bg-blue-600 peer-checked:border-blue-600"></div>
        </div>
      </label>
    </div>

    <div class="bg-slate-50 rounded-xl">
      <label class="set-row cursor-pointer hover:bg-white/60 transition-colors rounded-xl">
        <i class="ph ph-timer text-slate-400 text-lg w-5"></i>
        <div class="flex-1 min-w-0">
          <div class="text-sm text-slate-800">Me réveiller quand une tâche de fond se termine</div>
          <div class="text-xs text-slate-500">
            Une tâche lancée par l'assistant peut relancer la conversation toute seule à sa fin ou sur un
            événement. Désactivé, le résultat est joint à votre prochain message. Réglable aussi conversation
            par conversation.
          </div>
        </div>
        <div class="relative inline-flex items-center shrink-0">
          <input
            v-model="rg.settings.jobs_wake"
            type="checkbox"
            data-jobs-wake
            class="sr-only peer"
            @change="rg.persistJobsWake"
          />
          <div class="set-switch-track peer-checked:bg-blue-600 peer-checked:border-blue-600"></div>
        </div>
      </label>
    </div>

    <div
      v-if="rg.features.voice_stt || rg.features.voice_tts"
      class="bg-slate-50 rounded-xl overflow-hidden divide-y divide-slate-200/70"
    >
      <label v-if="rg.features.voice_stt" class="set-row cursor-pointer hover:bg-white/60 transition-colors">
        <i class="ph ph-microphone text-slate-400 text-lg w-5"></i>
        <div class="flex-1 min-w-0">
          <div class="text-sm text-slate-800">Dictée</div>
          <div class="text-xs text-slate-500">
            Un bouton micro dans la zone de saisie. Le texte s'écrit phrase après phrase ; l'envoi reste
            manuel.
          </div>
        </div>
        <div class="relative inline-flex items-center shrink-0">
          <input
            v-model="rg.settings.voice_input_enabled"
            type="checkbox"
            :disabled="!rg.voiceMicSupported"
            class="sr-only peer"
            @change="rg.persistVoiceInput"
          />
          <div class="set-switch-track peer-checked:bg-blue-600 peer-checked:border-blue-600"></div>
        </div>
      </label>
      <label v-if="rg.features.voice_tts" class="set-row cursor-pointer hover:bg-white/60 transition-colors">
        <i class="ph ph-speaker-high text-slate-400 text-lg w-5"></i>
        <div class="flex-1 min-w-0">
          <div class="text-sm text-slate-800">Réponse vocale</div>
          <div class="text-xs text-slate-500">
            Lit les réponses à voix haute pendant qu'elles s'écrivent. Le bouton « lire » de chaque message
            reste disponible sans cela.
          </div>
        </div>
        <div class="relative inline-flex items-center shrink-0">
          <input
            v-model="rg.settings.voice_reply_enabled"
            type="checkbox"
            :disabled="!rg.voiceReadSupported"
            class="sr-only peer"
            @change="rg.persistVoiceReply"
          />
          <div class="set-switch-track peer-checked:bg-blue-600 peer-checked:border-blue-600"></div>
        </div>
      </label>

      <label
        v-if="rg.features.voice_tts && rg.settings.voice_reply_enabled"
        class="set-row set-row--sub cursor-pointer hover:bg-white/60 transition-colors"
      >
        <i class="ph ph-wrench text-slate-400 text-lg w-5"></i>
        <div class="flex-1 min-w-0">
          <div class="text-sm text-slate-800">Lire entre les outils</div>
          <div class="text-xs text-slate-500">
            Lit aussi ce que l'assistant annonce avant chaque appel d'outil, pas seulement la réponse finale.
          </div>
        </div>
        <div class="relative inline-flex items-center shrink-0">
          <input
            v-model="rg.settings.voice_reply_tools_enabled"
            type="checkbox"
            class="sr-only peer"
            @change="rg.persistVoiceReplyTools"
          />
          <div class="set-switch-track peer-checked:bg-blue-600 peer-checked:border-blue-600"></div>
        </div>
      </label>

      <p
        v-if="rg.features.voice_stt && !rg.voiceMicSupported"
        class="text-xs text-amber-700 bg-amber-50 border-t border-amber-200 px-3 py-2"
      >
        Micro indisponible : {{ rg.voiceCompatInfo.dictee.raison }}
      </p>
      <p
        v-if="rg.features.voice_tts && !rg.voiceReadSupported"
        class="text-xs text-amber-700 bg-amber-50 border-t border-amber-200 px-3 py-2"
      >
        {{ rg.voiceCompatInfo.lecture.raison }}
      </p>
      <p
        v-if="rg.voiceCompatInfo.avertissement && (rg.voiceMicSupported || rg.voiceReadSupported)"
        class="text-xs text-slate-500 border-t border-slate-200 px-3 py-2"
      >
        {{ rg.voiceCompatInfo.avertissement }}
      </p>
    </div>

    <div class="bg-slate-50 rounded-xl">
      <label
        class="set-row transition-colors rounded-xl"
        :class="
          rg.notifyOSSupported && rg.notifyOSSecure
            ? 'cursor-pointer hover:bg-white/60'
            : 'opacity-50 cursor-not-allowed'
        "
      >
        <i class="ph ph-bell-ringing text-slate-400 text-lg w-5"></i>
        <div class="flex-1 min-w-0">
          <div class="text-sm text-slate-800">Notifications système</div>
          <div class="text-xs text-slate-500">
            Affiche une notification du système d'exploitation (routines, scénarios, rapports…) quand cette
            fenêtre n'est pas au premier plan.
            <span v-if="!rg.notifyOSSupported" class="text-amber-600">Non supporté par ce navigateur.</span>
            <span v-else-if="!rg.notifyOSSecure" class="text-amber-600"
              >Indisponible : nécessite HTTPS ou http://localhost (page non sécurisée).</span
            >
          </div>
        </div>
        <div class="relative inline-flex items-center shrink-0">
          <input
            type="checkbox"
            class="sr-only peer"
            :checked="rg.notifyOSEnabled"
            :disabled="!rg.notifyOSSupported || !rg.notifyOSSecure"
            @change="rg.toggleNotifyOS"
          />
          <div class="set-switch-track peer-checked:bg-blue-600 peer-checked:border-blue-600"></div>
        </div>
      </label>
    </div>

    <div class="bg-slate-50 rounded-xl px-3.5 py-3">
      <div class="flex items-center justify-between gap-3">
        <div class="text-xs min-w-0">
          <div class="font-medium text-slate-700">Effacer les conversations</div>
          <div class="text-xs text-slate-500">
            Supprime tous les chats actifs — irréversible. Les archives ne sont pas affectées.
          </div>
        </div>
        <button
          class="shrink-0 px-3 py-1.5 bg-white text-red-600 border border-red-200 hover:bg-red-50 rounded-md text-xs font-medium transition-colors flex items-center gap-1"
          @click="rg.clearAllChats"
        >
          <i class="ph ph-trash"></i> Effacer
        </button>
      </div>
    </div>
  </div>
</template>
