<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/chat/message/MessageChat.vue — une ligne du fil : avatar, en-tête et actions, notice, édition, corps ; les réveils qui continuent une réponse de l'agent s'ajoutent à sa bulle. -->
<script setup lang="ts">
import { computed } from "vue";

import { CLE_FIL, domaine } from "../../../features/chat/page/domaines";
import { resumeReveil } from "../../../features/chat/jobs/format";
import { estReveil } from "../../../features/chat/liste/regroupement";

import CorpsMessage from "./CorpsMessage.vue";
import LigneReveil from "./LigneReveil.vue";

import type { EntreeMessage } from "../../../features/chat/message/types";

const props = defineProps<{ entry: EntreeMessage }>();
const fil = domaine(CLE_FIL);
const emit = defineEmits<{ "zoom-image": [url: string]; edition: [texte: string] }>();

const membres = computed(() => [props.entry, ...(props.entry.suite ?? [])]);
// Le pied (métriques, copier, régénérer, détails, lecture) vise la dernière réponse de la bulle.
const cible = computed(() => membres.value.filter((m) => !estReveil(m.msg)).at(-1) ?? props.entry);
const texteBulle = computed(() =>
  props.entry.suite?.length
    ? membres.value
        .map((m) => (estReveil(m.msg) ? resumeReveil(m.msg.wake) : m.msg.content || ""))
        .filter((t) => t.trim())
        .join("\n\n")
    : undefined,
);
const attenuee = computed(() => {
  const q = fil.messageSearchQ && fil.messageSearchActive ? fil.messageSearchQ.toLowerCase() : "";
  const textes = q ? membres.value.map((m) => m.msg.content || "").filter(Boolean) : [];
  return textes.length > 0 && !textes.some((t) => t.toLowerCase().includes(q));
});
const flash = computed(() => fil.vsFlashIdx != null && membres.value.some((m) => m.idx === fil.vsFlashIdx));
const texteEdition = computed({
  get: () => fil.editMessageText,
  set: (v: string) => emit("edition", v),
});

function ouvert(e: Event): boolean {
  return (e.target as HTMLDetailsElement).open;
}
</script>

<template>
  <div v-if="entry.msg.origin === 'job_wake'" :data-vs-idx="entry.idx" class="elpis-msg-wake">
    <LigneReveil :wake="entry.msg.wake" :content="entry.msg.content || ''" />
  </div>
  <div
    v-else
    :data-vs-idx="entry.idx"
    class="flex gap-4 group"
    :class="[
      entry.msg.role === 'user' ? 'elpis-msg-user' : 'elpis-msg-assistant',
      attenuee ? 'opacity-25' : '',
      flash ? 'vs-jump-flash' : '',
    ]"
  >
    <div class="shrink-0 mt-0.5">
      <div v-if="entry.msg.role === 'user'">
        <img
          v-if="fil.user.avatar"
          :src="'/avatars/' + fil.user.avatar"
          class="w-9 h-9 rounded-full object-cover border border-slate-200 shadow-sm"
        />
        <div
          v-else
          class="w-9 h-9 rounded-full bg-slate-100 flex items-center justify-center text-slate-600 font-bold border border-slate-200"
        >
          <i class="ph ph-user text-lg"></i>
        </div>
      </div>
      <div v-else>
        <div
          v-if="entry.msg.isError"
          class="elpis-error-avatar w-9 h-9 rounded-full flex items-center justify-center shadow-sm"
        >
          <i class="ph ph-warning text-lg"></i>
        </div>
        <img
          v-else
          :src="fil.logoApp"
          alt=""
          data-avatar-assistant
          class="w-9 h-9 rounded-full object-cover shadow-sm border border-slate-200"
        />
      </div>
    </div>

    <div class="flex-1 min-w-0">
      <div class="flex items-baseline justify-between mb-1.5">
        <span class="font-bold text-[15px] text-slate-800">{{
          entry.msg.role === "user"
            ? fil.user.username
            : fil.skinCourant.brand
              ? fil.nomMarque
              : fil.settings.assistant_name || "Assistant"
        }}</span>
        <div
          class="flex gap-2 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity"
        >
          <button
            v-if="entry.msg.role === 'user' && !fil.isStreaming"
            title="Éditer et renvoyer"
            class="text-slate-400 hover:text-blue-600 p-1 transition-colors"
            @click="fil.startEditMessage(entry.idx)"
          >
            <i class="ph ph-pencil-simple text-base"></i>
          </button>
          <button
            v-if="entry.msg.role === 'user'"
            title="Sauvegarder"
            class="text-slate-400 hover:text-blue-600 p-1"
            @click="fil.saveThisPrompt(entry.msg.content)"
          >
            <i class="ph ph-bookmark-simple text-base"></i>
          </button>
        </div>
      </div>

      <div v-if="entry.msg.role === 'notice'" class="text-[13.5px] leading-6 text-slate-500 py-0.5">
        <i class="ph ph-arrows-in-simple mr-1 align-[-2px] text-slate-400"></i>
        <span
          class="font-medium text-slate-600"
          title="L'historique ancien a été résumé pour le modèle — le fil affiché reste intact."
          >Conversation compactée</span
        >
        <span v-if="entry.msg.tokens_after" class="font-mono text-slate-600">
          · ≈ {{ entry.msg.tokens_after.toLocaleString("fr-FR") }} tokens</span
        >
        <span v-if="entry.msg.ts" class="text-slate-400"> · {{ fil.fmtNoticeTs(entry.msg.ts) }}</span>
        <details
          v-if="entry.msg.summary"
          class="mt-0.5 group/compact"
          :open="!!entry.msg._compactOpen"
          @toggle="(e: Event) => fil.setMsgUi(entry, { _compactOpen: ouvert(e) })"
        >
          <summary
            class="list-none flex items-center gap-1.5 cursor-pointer select-none w-fit py-0.5 text-slate-400 hover:text-slate-600 transition-colors"
          >
            <span class="text-[12px] font-medium">Vérifier le compact</span>
            <i
              class="ph ph-caret-right text-slate-300 transition-transform group-open/compact:rotate-90 shrink-0"
              style="font-size: 9px"
            ></i>
          </summary>
          <pre
            class="mt-1 ml-0.5 pl-3 border-l-2 border-slate-200 text-[11.5px] leading-relaxed text-slate-500 whitespace-pre-wrap break-words max-h-64 overflow-y-auto custom-scrollbar"
            >{{ entry.msg.summary }}</pre>
        </details>
      </div>
      <div v-else-if="fil.editingMessageIndex === entry.idx" class="mt-1 mb-2">
        <textarea
          v-model="texteEdition"
          data-edit-message-input
          class="w-full bg-white border border-blue-400 shadow-sm rounded-xl px-3 py-2.5 text-sm focus:ring-2 focus:ring-blue-500 outline-none transition-colors text-slate-800 resize-y min-h-[80px] custom-scrollbar"
          @keydown.esc="fil.cancelEditMessage"
          @keydown.enter.ctrl.prevent="fil.submitEditMessage(entry.idx)"
          @keydown.enter.meta.prevent="fil.submitEditMessage(entry.idx)"
        ></textarea>
        <div class="text-[11px] text-slate-400 mt-1 select-none">
          Échap pour annuler · Ctrl+Entrée pour envoyer
        </div>
        <div class="flex justify-end gap-2 mt-2">
          <button
            class="px-3 py-1.5 text-slate-600 hover:bg-slate-100 rounded-lg text-xs font-semibold transition-colors"
            @click="fil.cancelEditMessage"
          >
            Annuler
          </button>
          <button
            :disabled="fil.isStreaming"
            class="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-xs font-semibold shadow-sm transition-colors flex items-center gap-1.5 disabled:bg-slate-300 disabled:text-slate-500 disabled:cursor-not-allowed"
            @click="fil.submitEditMessage(entry.idx)"
          >
            <i class="ph ph-paper-plane-right"></i> Envoyer
          </button>
        </div>
      </div>

      <template v-else>
        <CorpsMessage
          :entry="entry"
          :pied="cible === entry"
          :texte="texteBulle"
          @zoom-image="(u: string) => emit('zoom-image', u)"
        />
        <template v-for="s in entry.suite" :key="s.idx">
          <div v-if="estReveil(s.msg)" :data-vs-part="s.idx" class="mt-3 mb-2">
            <LigneReveil integree :wake="s.msg.wake" :content="s.msg.content || ''" />
          </div>
          <div v-else :data-vs-part="s.idx">
            <CorpsMessage
              :entry="s"
              :pied="cible === s"
              :texte="texteBulle"
              @zoom-image="(u: string) => emit('zoom-image', u)"
            />
          </div>
        </template>
      </template>
    </div>
  </div>
</template>
