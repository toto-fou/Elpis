<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/racine/ChromeApp.vue — couche commune à toutes les vues (connexion, console, chat) : bandeau de redémarrage, annonceur, toasts, fenêtre de confirmation/saisie/choix, menu contextuel, marque de défilement des barres discrètes. -->
<script setup lang="ts">
import { inject } from "vue";

import { CLE_CHROME, domaineRacine } from "../../app/racine/domaine";
import { suivreDefilement } from "../../features/chat/page/barres-defilement";
import { executerConversation } from "../../features/chat/page/conversation";
import type { ActionConversation } from "../../features/chat/page/conversation";
import { CLE_ENTETE } from "../../features/chat/page/domaines";
import AnnonceurA11y from "../AnnonceurA11y.vue";
import MenuConversation from "../chat/page/MenuConversation.vue";

const c = domaineRacine(CLE_CHROME);
const multi = (item: unknown): number => c.explorerMultiCount?.(item) ?? 0;
suivreDefilement();
// Domaines du chat : absents de la console, qui n'a pas de conversations.
const conv = inject(CLE_ENTETE, null);

/** Menu « Conversation » du clic droit : Renommer, Archiver, Supprimer passent par la racine ; Rechercher, Exporter par le chat. */
function agirConversation(action: ActionConversation): void {
  const item = c.contextMenu.item;
  if (action === "renommer" || action === "archiver" || action === "supprimer") {
    c.handleContextAction({ renommer: "rename", archiver: "archive", supprimer: "delete" }[action]);
    return;
  }
  // Une action inconnue de la racine ferme seulement le menu, garde du focus comprise.
  c.handleContextAction("fermer");
  if (conv && item)
    void executerConversation(action, { id: String(item.id ?? ""), title: String(item.title ?? "") }, conv);
}
</script>

<template>
  <Transition name="modal">
    <div
      v-if="c.systemAlert"
      role="alert"
      aria-live="assertive"
      class="fixed inset-0 z-[9999] flex items-center justify-center bg-slate-900/80 p-4"
    >
      <div class="bg-white rounded-2xl shadow-2xl p-8 max-w-sm text-center">
        <i class="ph ph-arrows-clockwise text-5xl text-blue-500 mb-4 animate-spin"></i>
        <h2 class="text-xl font-bold text-slate-800 mb-2">Redémarrage en cours</h2>
        <p class="text-sm text-slate-500 mb-6">{{ c.systemAlert }}</p>
        <div class="flex items-center justify-center gap-2 text-xs text-slate-400">
          <i class="ph ph-spinner-gap animate-spin text-blue-500"></i>
          <span>Reconnexion automatique...</span>
        </div>
      </div>
    </div>
  </Transition>

  <!-- Annonceur sr-only : événements sans interface dédiée (fin de génération, choix de modèle…). -->
  <AnnonceurA11y :texte="c.announcerText" :assertif="c.announcerAssertive" />

  <!-- Toasts : au-dessus de la carte de connexion (z-9990), sous le bandeau de redémarrage (z-9999). Le carton ne capte
       pas les clics (il recouvre le bouton « Envoyer ») : seuls ses boutons le font. -->
  <div
    role="status"
    aria-live="polite"
    aria-atomic="false"
    class="fixed bottom-6 right-6 z-[9995] flex flex-col gap-3 pointer-events-none"
  >
    <TransitionGroup name="toast">
      <div
        v-for="t in c.toasts"
        :key="t.id"
        :role="['error', 'warning'].includes(t.type) ? 'alert' : 'status'"
        class="pointer-events-none flex items-center gap-3 px-4 py-3 rounded-xl shadow-xl min-w-[300px] max-w-md"
        :class="t.type === 'error' ? 'elpis-toast--error' : 'elpis-toast'"
      >
        <i
          class="ph text-xl"
          :class="{
            'ph-warning-circle': t.type === 'error',
            'ph-warning text-amber-400': t.type === 'warning',
            'ph-info text-blue-400': t.type === 'info',
            'ph-check-circle text-green-400': !['error', 'warning', 'info'].includes(t.type),
          }"
        ></i>
        <div class="flex-1 text-sm font-medium">{{ t.message }}</div>
        <button
          v-if="t.actionLabel"
          class="pointer-events-auto text-xs font-semibold text-blue-300 hover:text-white transition-colors px-2 py-0.5 rounded border border-blue-300/40 hover:border-white/60"
          @click="
            t.onAction && t.onAction();
            c.removeToast(t.id);
          "
        >
          {{ t.actionLabel }}
        </button>
        <button
          title="Fermer"
          aria-label="Fermer"
          class="pointer-events-auto opacity-60 hover:opacity-100 transition-opacity"
          @click="c.removeToast(t.id, true)"
        >
          <i class="ph ph-x"></i>
        </button>
      </div>
    </TransitionGroup>
  </div>

  <!-- Fenêtre générique : piège Tab dans le dialogue, focus rendu au déclencheur à la fermeture. -->
  <Transition name="modal">
    <div
      v-if="c.modalState.isOpen"
      class="fixed inset-0 z-[7000] flex items-center justify-center bg-slate-900/80 p-4"
      @click.self="c.handleModalCancel"
    >
      <div
        :ref="(el) => (c.modalDialogRef = el as HTMLElement | null)"
        role="dialog"
        aria-modal="true"
        aria-labelledby="app-modal-title"
        class="bg-white rounded-2xl shadow-2xl ring-1 ring-slate-900/5 w-full max-w-md overflow-hidden"
        @keydown.tab="c.onModalTabKey"
      >
        <div class="p-6">
          <h3 id="app-modal-title" class="text-lg font-bold text-slate-800 mb-3 flex items-center gap-3">
            <div
              class="w-10 h-10 rounded-xl flex items-center justify-center bg-slate-50"
              :class="c.modalState.isDanger ? 'text-red-500' : 'text-blue-600'"
            >
              <i
                v-if="c.modalState.type === 'confirm' && c.modalState.isDanger"
                class="ph ph-warning-circle text-xl"
              ></i>
              <i v-else-if="c.modalState.type === 'prompt'" class="ph ph-pencil-simple text-xl"></i>
              <i v-else class="ph ph-info text-xl"></i>
            </div>
            {{ c.modalState.title }}
          </h3>
          <p v-if="c.modalState.message" class="text-slate-600 text-sm mb-5">{{ c.modalState.message }}</p>
          <div v-if="c.modalState.type === 'prompt'" class="mb-5">
            <input
              :ref="(el) => (c.modalInputRef = el as HTMLInputElement | null)"
              v-model="c.modalState.inputValue"
              :placeholder="c.modalState.placeholder"
              class="w-full bg-slate-50 border border-slate-200 rounded-xl px-4 py-2.5 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none transition-colors placeholder:text-slate-500 text-slate-700"
              @keydown.enter="c.handleModalSubmit"
            />
          </div>
          <!-- Confirmation saisie : l'irréversible exige de recopier le mot. -->
          <div v-else-if="c.modalState.type === 'confirm' && c.modalState.requireText" class="mb-5">
            <label for="app-modal-typed" class="block text-xs font-medium text-slate-600 mb-1.5"
              >Saisissez
              <strong class="font-semibold text-slate-800">{{ c.modalState.requireText }}</strong> pour
              confirmer</label
            >
            <input
              id="app-modal-typed"
              :ref="(el) => (c.modalInputRef = el as HTMLInputElement | null)"
              v-model="c.modalState.inputValue"
              autocomplete="off"
              spellcheck="false"
              :placeholder="c.modalState.placeholder"
              class="w-full bg-slate-50 border border-slate-200 rounded-xl px-4 py-2.5 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none transition-colors placeholder:text-slate-500 text-slate-700"
              @keydown.enter="c.handleModalSubmit"
            />
          </div>
          <div v-if="c.modalState.type === 'choice'" class="flex flex-wrap justify-end gap-2 mt-2">
            <button
              :ref="(el) => (c.modalCancelRef = el as HTMLButtonElement | null)"
              class="px-4 py-2 text-slate-600 hover:bg-slate-100 rounded-lg text-sm font-medium transition-colors"
              @click="c.handleModalCancel"
            >
              {{ c.modalState.cancelLabel }}
            </button>
            <button
              v-for="ch in c.modalState.choices || []"
              :key="ch.id"
              :data-choice="ch.id"
              :class="
                ch.tone === 'primary'
                  ? 'bg-blue-600 hover:bg-blue-700 text-white shadow-sm'
                  : ch.tone === 'danger'
                    ? 'bg-red-500 hover:bg-red-600 text-white shadow-sm'
                    : 'text-slate-700 bg-slate-100 hover:bg-slate-200'
              "
              class="px-4 py-2 rounded-lg text-sm font-medium transition-colors"
              @click="c.handleModalChoice(ch.id)"
            >
              {{ ch.label }}
            </button>
          </div>
          <div v-else class="flex justify-end gap-2 mt-2">
            <button
              :ref="(el) => (c.modalCancelRef = el as HTMLButtonElement | null)"
              class="px-4 py-2 text-slate-600 hover:bg-slate-100 rounded-lg text-sm font-medium transition-colors"
              @click="c.handleModalCancel"
            >
              {{ c.modalState.cancelLabel }}
            </button>
            <button
              :disabled="c.modalTypedBlocked()"
              :class="c.modalState.isDanger ? 'bg-red-500 hover:bg-red-600' : 'bg-blue-600 hover:bg-blue-700'"
              class="px-4 py-2 text-white rounded-lg text-sm font-medium shadow-sm transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              @click="c.handleModalSubmit"
            >
              {{ c.modalState.confirmLabel }}
            </button>
          </div>
        </div>
      </div>
    </div>
  </Transition>

  <!-- Menu contextuel (chats, fichiers, dossiers, fond de l'explorateur) : role=menu, focus sur la première entrée,
       flèches haut/bas ; Échap passe par la cascade globale. -->
  <Transition name="popover">
    <div
      v-show="c.contextMenu.isOpen"
      id="custom-context-menu"
      role="menu"
      aria-label="Actions"
      class="fixed z-[8000] bg-white border border-slate-200 shadow-xl rounded-xl py-1 min-w-[180px]"
      :style="{ top: c.contextMenu.y + 'px', left: c.contextMenu.x + 'px' }"
      @keydown="c.onContextMenuKeydown"
    >
      <div v-if="c.contextMenu.type === 'chat'" class="px-1 w-56">
        <MenuConversation @action="agirConversation" />
      </div>
      <div v-if="['file', 'folder', 'explorer-bg'].includes(c.contextMenu.type)" class="px-1">
        <!-- Sélection multiple (Ctrl/Maj + clic) : actions de groupe seulement. -->
        <template v-if="c.contextMenu.type !== 'explorer-bg' && multi(c.contextMenu.item) > 1">
          <div class="px-3 pt-1 pb-1.5 text-xs font-semibold text-slate-500">
            {{ multi(c.contextMenu.item) }} éléments
          </div>
          <button
            role="menuitem"
            class="w-full text-left px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-100 focus:bg-slate-100 focus:outline-none rounded-lg flex items-center gap-2 transition-colors"
            @click="c.handleContextAction('attach_chat')"
          >
            <i class="ph ph-paperclip text-slate-400"></i> Joindre au chat
          </button>
          <button
            role="menuitem"
            class="w-full text-left px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-100 focus:bg-slate-100 focus:outline-none rounded-lg flex items-center gap-2 transition-colors"
            @click="c.handleContextAction('download')"
          >
            <i class="ph ph-download-simple text-slate-400"></i> Télécharger (zip)
          </button>
          <div class="h-px bg-slate-100 my-1 mx-2"></div>
          <button
            role="menuitem"
            class="w-full text-left px-3 py-1.5 text-sm font-medium text-red-600 hover:bg-red-50 focus:bg-red-50 focus:outline-none rounded-lg flex items-center gap-2 transition-colors"
            @click="c.handleContextAction('delete')"
          >
            <i class="ph ph-trash text-red-400"></i> Supprimer
          </button>
        </template>
        <template v-else>
          <button
            role="menuitem"
            class="w-full text-left px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-100 focus:bg-slate-100 focus:outline-none rounded-lg flex items-center gap-2 transition-colors"
            @click="c.handleContextAction('new_file')"
          >
            <i class="ph ph-file-plus text-blue-500"></i> Nouveau Fichier
          </button>
          <button
            role="menuitem"
            class="w-full text-left px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-100 focus:bg-slate-100 focus:outline-none rounded-lg flex items-center gap-2 transition-colors"
            @click="c.handleContextAction('new_folder')"
          >
            <i class="ph ph-folder-plus text-blue-500"></i> Nouveau Dossier
          </button>
          <button
            v-if="c.contextMenu.type === 'explorer-bg'"
            role="menuitem"
            class="w-full text-left px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-100 focus:bg-slate-100 focus:outline-none rounded-lg flex items-center gap-2 transition-colors"
            @click="c.handleContextAction('collapse_all')"
          >
            <i class="ph ph-arrows-in-line-vertical text-slate-400"></i> Tout replier
          </button>
          <button
            role="menuitem"
            class="w-full text-left px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-100 focus:bg-slate-100 focus:outline-none rounded-lg flex items-center gap-2 transition-colors"
            @click="c.handleContextAction('terminal_here')"
          >
            <i class="ph ph-terminal-window text-slate-400"></i> Terminal ici
          </button>
          <div v-if="c.contextMenu.type !== 'explorer-bg'" class="h-px bg-slate-100 my-1 mx-2"></div>
          <div v-if="c.contextMenu.type !== 'explorer-bg'">
            <button
              v-if="c.contextMenu.type === 'file'"
              role="menuitem"
              class="w-full text-left px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-100 focus:bg-slate-100 focus:outline-none rounded-lg flex items-center gap-2 transition-colors"
              @click="c.handleContextAction('attach_chat')"
            >
              <i class="ph ph-paperclip text-slate-400"></i> Joindre au chat
            </button>
            <button
              role="menuitem"
              class="w-full text-left px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-100 focus:bg-slate-100 focus:outline-none rounded-lg flex items-center gap-2 transition-colors"
              @click="c.handleContextAction('rename')"
            >
              <i class="ph ph-pencil-simple text-slate-400"></i> Renommer<kbd
                class="ml-auto text-[10px] text-slate-400 font-mono"
                >F2</kbd
              >
            </button>
            <button
              role="menuitem"
              class="w-full text-left px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-100 focus:bg-slate-100 focus:outline-none rounded-lg flex items-center gap-2 transition-colors"
              @click="c.handleContextAction('duplicate')"
            >
              <i class="ph ph-copy-simple text-slate-400"></i> Dupliquer
            </button>
            <button
              role="menuitem"
              class="w-full text-left px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-100 focus:bg-slate-100 focus:outline-none rounded-lg flex items-center gap-2 transition-colors"
              @click="c.handleContextAction('copy_path')"
            >
              <i class="ph ph-copy text-slate-400"></i> Copier le chemin
            </button>
            <button
              role="menuitem"
              class="w-full text-left px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-100 focus:bg-slate-100 focus:outline-none rounded-lg flex items-center gap-2 transition-colors"
              @click="c.handleContextAction('download')"
            >
              <i class="ph ph-download-simple text-slate-400"></i> Télécharger
            </button>
            <div class="h-px bg-slate-100 my-1 mx-2"></div>
            <button
              role="menuitem"
              class="w-full text-left px-3 py-1.5 text-sm font-medium text-red-600 hover:bg-red-50 focus:bg-red-50 focus:outline-none rounded-lg flex items-center gap-2 transition-colors"
              @click="c.handleContextAction('delete')"
            >
              <i class="ph ph-trash text-red-400"></i> Supprimer<kbd
                class="ml-auto text-[10px] text-red-300 font-mono"
                >Suppr</kbd
              >
            </button>
          </div>
        </template>
      </div>
    </div>
  </Transition>
</template>
