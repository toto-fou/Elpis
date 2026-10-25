<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/chat/page/BarreLaterale.vue — barre latérale : rail réduit et vue déployée (marque, nouveau chat, pages, recherche et historique groupé, sélection multiple, notifications, compte). -->
<script setup lang="ts">
import { onBeforeUnmount } from "vue";
import type { ComponentPublicInstance } from "vue";

import { LOGO_ELPIS } from "../../../features/communs/logo";
import { CLE_BARRE, domaine } from "../../../features/chat/page/domaines";
import { fonduDefilement } from "../../../features/chat/page/fondu-defilement";
import { interfaceApp } from "../../../features/reglages/interface";
import MenuCompte from "./MenuCompte.vue";
import MenuPagesPlus from "./MenuPagesPlus.vue";
import NotificationsPied from "./NotificationsPied.vue";

const b = domaine(CLE_BARRE);
const ui = interfaceApp();
let detacherFondu: (() => void) | null = null;
// L'historique peut être recréé (rail replié puis déployé) : le fondu suit l'élément monté.
function brancherFondu(el: Element | ComponentPublicInstance | null): void {
  detacherFondu?.();
  detacherFondu = el instanceof HTMLElement ? fonduDefilement(el) : null;
}
onBeforeUnmount(() => brancherFondu(null));
</script>

<template>
  <!-- UX : au lieu de `hidden` (display:none instantané non animable)
               quand fullscreen, on anime `width → 0`. La sidebar se rétracte
               vers la gauche pendant que l'éditeur s'étend.
               `overflow: hidden` empêche le contenu de déborder ; `pointer-
               events-none` en fullscreen évite des clics sur une sidebar à 0. -->
  <!-- Backdrop mobile : sous lg, la sidebar s'ouvre en overlay `fixed`
               (z-50). Ce voile (z-40, donc derrière) assombrit le chat et la
               referme au tap. Masqué en lg+ (sidebar en flux `relative`) et en
               plein écran éditeur (sidebar animée à 0). -->
  <div
    v-if="b.showSidebar && !b.editorFullscreen"
    aria-hidden="true"
    class="lg:hidden fixed inset-0 z-40 bg-slate-900/50 backdrop-blur-sm"
    @click="b.showSidebar = false"
  ></div>
  <!-- Fond/texte/bordure du rail : tokens --rail-* (style.css), plus de
               bg-[#0f172a] en dur — chaque skin re-teinte via ses tokens.
               Coins côté chat arrondis (10 px) ; overflow-hidden y découpe le pied. -->
  <aside
    class="elpis-slide-panel h-full flex flex-col shrink-0 border-r rounded-r-[10px] z-50 overflow-hidden"
    :class="[
      b.editorFullscreen ? 'pointer-events-none border-none' : '',
      !b.editorFullscreen && b.showSidebar ? 'fixed lg:relative shadow-2xl' : '',
      !b.editorFullscreen && !b.showSidebar ? 'hidden lg:flex' : '',
    ]"
    :style="{ width: b.editorFullscreen ? '0px' : b.showSidebar ? '260px' : '48px' }"
  >
    <!-- ============================================================ -->
    <!--  RAIL RÉDUIT (48px) — miroir compact, même ordre vertical.   -->
    <!-- ============================================================ -->
    <div v-show="!b.showSidebar" class="flex flex-col items-center py-3 flex-1 w-12 gap-1">
      <button
        title="Ouvrir le panneau"
        class="w-9 h-9 rounded-lg hover:bg-white/10 flex items-center justify-center text-slate-400 hover:text-white transition-colors"
        @click="b.showSidebar = true"
      >
        <i class="ph ph-caret-double-right text-lg"></i>
      </button>
      <button
        :title="b.nomMarque"
        class="elpis-kiki-hote w-9 h-9 rounded-lg flex items-center justify-center shrink-0 transition-transform hover:scale-105"
        @click="b.showSidebar = true"
      >
        <!-- Skin à mascotte « kiki » (registre des skins, champ ``mascot``) : le trio remplace l'icône, au repos, et se met en marche au survol (kiki.css). -->
        <span
          v-if="b.skinCourant.mascot === 'kiki' && b.logoApp === LOGO_ELPIS"
          class="elpis-kiki-logo elpis-kiki-logo--mini"
          aria-hidden="true"
        >
          <span class="socle-mascotte elpis-kiki-repos" data-perso="kiki" data-etat="repos"></span>
          <span class="socle-mascotte elpis-kiki-marche" data-perso="kiki" data-etat="running"></span>
        </span>
        <img v-else :src="b.logoApp" alt="" class="w-8 h-8 rounded-lg object-cover shadow-sm" />
      </button>

      <div class="w-6 h-px bg-white/10 my-1.5"></div>

      <button
        title="Nouveau chat (Ctrl+Maj+O)"
        class="w-9 h-9 rounded-lg bg-blue-700 hover:bg-blue-600 ring-1 ring-inset ring-white/10 text-white shadow-sm shadow-blue-950/50 flex items-center justify-center transition-colors"
        @click="b.startNewChat"
      >
        <i class="ph ph-plus text-base"></i>
      </button>
      <button
        title="Rechercher"
        class="w-9 h-9 rounded-lg hover:bg-white/10 text-slate-400 hover:text-white flex items-center justify-center transition-colors"
        @click="
          b.showSidebar = true;
          b.openChatSearch();
        "
      >
        <i class="ph ph-magnifying-glass text-base"></i>
      </button>

      <div class="w-6 h-px bg-white/10 my-1.5"></div>

      <button
        v-if="b.settings.enable_mcp"
        :title="b.showMcpPanel ? 'MCP — activés' : 'MCP'"
        :aria-pressed="b.showMcpPanel ? 'true' : 'false'"
        class="relative w-9 h-9 rounded-lg flex items-center justify-center transition-colors"
        :class="
          b.showMcpPanel
            ? 'bg-white/[0.08] text-blue-300'
            : 'text-slate-400 hover:bg-white/10 hover:text-white'
        "
        @click="
          b.currentView = 'chat';
          b.togglePanel('mcp');
        "
      >
        <i class="ph ph-plug text-lg"></i>
        <span
          v-if="b.showMcpPanel"
          class="absolute top-1 right-1 w-1.5 h-1.5 rounded-full bg-blue-400"
        ></span>
      </button>
      <button
        v-if="b.settings.enable_editor"
        :title="b.showEditor ? 'Sandbox — ouvert' : 'Sandbox'"
        :aria-pressed="b.showEditor ? 'true' : 'false'"
        class="relative w-9 h-9 rounded-lg flex items-center justify-center transition-colors"
        :class="
          b.showEditor ? 'bg-white/[0.08] text-blue-300' : 'text-slate-400 hover:bg-white/10 hover:text-white'
        "
        @click="
          b.currentView = 'chat';
          b.toggleEditor();
        "
      >
        <i class="ph ph-code-block text-lg"></i>
        <span v-if="b.showEditor" class="absolute top-1 right-1 w-1.5 h-1.5 rounded-full bg-blue-400"></span>
      </button>
      <button
        title="Routines"
        class="w-9 h-9 rounded-lg flex items-center justify-center transition-colors"
        :class="
          b.currentView === 'routines'
            ? 'bg-blue-600/20 text-blue-300'
            : 'text-slate-400 hover:bg-white/10 hover:text-white'
        "
        @click="b.openRoutinesPage"
      >
        <i class="ph ph-clock-countdown text-lg"></i>
      </button>
      <MenuPagesPlus :compact="true" />
      <div class="mt-auto flex flex-col items-center gap-1">
        <div class="w-6 h-px bg-white/10 my-0.5"></div>
        <MenuCompte v-if="!ui.classique" :compact="true" />
        <button
          v-else
          title="Compte"
          class="w-9 h-9 rounded-lg flex items-center justify-center shrink-0"
          @click="b.showSidebar = true"
        >
          <img
            v-if="b.user.avatar"
            :src="'/avatars/' + b.user.avatar"
            class="w-8 h-8 rounded-full object-cover shadow-sm ring-1 ring-white/10 hover:ring-blue-500/60 transition-all"
          />
          <span
            v-else
            class="w-8 h-8 rounded-full bg-blue-600 flex items-center justify-center text-white text-[10px] font-bold shadow-sm ring-1 ring-white/10 hover:ring-blue-500/60 transition-all"
            >{{ b.user.username.substring(0, 2).toUpperCase() }}</span
          >
        </button>
        <button
          :title="b.notifUnread ? b.notifUnread + ' notification(s) non lue(s)' : 'Notifications'"
          class="relative w-9 h-9 rounded-lg hover:bg-white/10 text-slate-400 hover:text-white flex items-center justify-center transition-colors"
          @click="
            b.showSidebar = true;
            b.openNotifPanel();
          "
        >
          <i class="ph text-lg" :class="b.notifUnread ? 'ph-bell-ringing' : 'ph-bell'"></i>
          <span
            v-if="b.notifUnread"
            role="status"
            :aria-label="b.notifUnread + ' notification(s) non lue(s)'"
            class="absolute top-0.5 right-0.5 min-w-[15px] h-[15px] px-1 bg-red-500 text-white text-[9px] font-bold rounded-full flex items-center justify-center leading-none shadow-sm ring-1 ring-[#0f172a]"
            >{{ b.notifUnread > 99 ? "99+" : b.notifUnread }}</span
          >
        </button>
        <button
          title="Paramètres"
          class="w-9 h-9 rounded-lg hover:bg-white/10 text-slate-400 hover:text-white flex items-center justify-center transition-colors"
          @click="b.openSettings"
        >
          <i class="ph ph-gear text-lg"></i>
        </button>
        <!-- Vert privilège restauré (remontées users) : text-emerald-400 est
                           remappé par le rail sur --rail-ok (olive sur elpis, vert ailleurs). -->
        <button
          v-if="b.user.is_admin || b.user.role === 'moderator'"
          title="Administration"
          class="w-9 h-9 rounded-lg hover:bg-white/10 text-emerald-400 hover:text-emerald-300 flex items-center justify-center transition-colors"
          @click="b.goToAdmin"
        >
          <i class="ph ph-shield-check text-lg"></i>
        </button>
        <button
          v-if="ui.classique"
          title="Déconnexion"
          class="w-9 h-9 rounded-lg hover:bg-red-500/15 text-slate-400 hover:text-red-400 flex items-center justify-center transition-colors"
          @click="b.logout"
        >
          <i class="ph ph-sign-out text-lg"></i>
        </button>
      </div>
    </div>

    <!-- ============================================================ -->
    <!--  VUE DÉPLOYÉE (260px)                                         -->
    <!-- ============================================================ -->
    <div v-show="b.showSidebar" class="w-[260px] flex flex-col flex-1 min-h-0">
      <!-- En-tête : MARQUE (assistant) et repli du volet ; la recherche vit
                   dans la section « Conversations ». Le compte utilisateur est
                   en pied (pattern produit : app en haut, compte en bas). -->
      <div class="pl-3.5 pr-2.5 h-14 flex justify-between items-center shrink-0">
        <div class="elpis-kiki-hote flex items-center gap-2.5 min-w-0">
          <span
            v-if="b.skinCourant.mascot === 'kiki' && b.logoApp === LOGO_ELPIS"
            class="elpis-kiki-logo"
            aria-hidden="true"
          >
            <span class="socle-mascotte elpis-kiki-repos" data-perso="kiki" data-etat="repos"></span>
            <span class="socle-mascotte elpis-kiki-marche" data-perso="kiki" data-etat="running"></span>
          </span>
          <img v-else :src="b.logoApp" alt="" class="w-8 h-8 rounded-lg object-cover shadow-sm shrink-0" />
          <span class="font-semibold text-[15px] text-white tracking-tight truncate">{{ b.nomMarque }}</span>
        </div>
        <button
          title="Réduire le panneau"
          class="w-[30px] h-[30px] rounded-lg hover:bg-white/10 flex items-center justify-center text-slate-400 hover:text-white transition-colors shrink-0"
          @click="b.showSidebar = false"
        >
          <i class="ph ph-caret-double-left"></i>
        </button>
      </div>

      <!-- Action primaire + MENU vertical (items empilés, à la claude.ai).
                   "Nouveau chat" = seul élément plein bleu (action principale).
                   Puis MCP / Sandbox (bascules) et Routines en lignes pleine
                   largeur, même langage visuel, rythme serré ; « Plus » range RAG,
                   Studio et Remote code dans un sous-menu (MenuPagesPlus.vue).
                   MCP/Éditeur basculent currentView -> 'chat' pour ne pas ouvrir
                   le panneau caché derrière une vue pleine page. -->
      <div class="px-2 pt-0.5 shrink-0">
        <!-- Bouton d'origine, inchangé : px-1 lui rend son retrait de 12 px. -->
        <div class="px-1">
          <button
            title="Nouveau chat (Ctrl+Maj+O)"
            class="w-full px-3 py-2 mb-2 rounded-lg bg-blue-700 hover:bg-blue-600 active:scale-[0.99] ring-1 ring-inset ring-white/10 text-white text-sm font-semibold flex items-center justify-center gap-2 shadow-sm shadow-blue-950/50 transition-all"
            @click="b.startNewChat"
          >
            <i class="ph ph-plus text-base"></i>
            <span>Nouveau chat</span>
          </button>
        </div>

        <div class="flex flex-col gap-px">
          <button
            v-if="b.settings.enable_mcp"
            :title="b.showMcpPanel ? 'MCP — activés' : 'MCP'"
            :aria-pressed="b.showMcpPanel ? 'true' : 'false'"
            class="w-full text-left px-3 h-8 rounded-lg flex items-center gap-2.5 text-[13.5px] font-medium transition-colors group"
            :class="
              b.showMcpPanel
                ? 'bg-white/[0.08] text-white'
                : 'text-slate-300 hover:bg-white/[0.06] hover:text-white'
            "
            @click="
              b.currentView = 'chat';
              b.togglePanel('mcp');
            "
          >
            <i
              class="ph ph-plug text-base shrink-0 transition-colors"
              :class="b.showMcpPanel ? 'text-blue-300' : 'text-slate-400 group-hover:text-slate-200'"
            ></i>
            <span class="flex-1 truncate">MCP</span>
            <span v-if="b.showMcpPanel" class="w-1.5 h-1.5 rounded-full shrink-0 bg-blue-400"></span>
          </button>

          <button
            v-if="b.settings.enable_editor"
            :title="b.showEditor ? 'Sandbox — ouvert' : 'Sandbox'"
            :aria-pressed="b.showEditor ? 'true' : 'false'"
            class="w-full text-left px-3 h-8 rounded-lg flex items-center gap-2.5 text-[13.5px] font-medium transition-colors group"
            :class="
              b.showEditor
                ? 'bg-white/[0.08] text-white'
                : 'text-slate-300 hover:bg-white/[0.06] hover:text-white'
            "
            @click="
              b.currentView = 'chat';
              b.toggleEditor();
            "
          >
            <i
              class="ph ph-code-block text-base shrink-0 transition-colors"
              :class="b.showEditor ? 'text-blue-300' : 'text-slate-400 group-hover:text-slate-200'"
            ></i>
            <span class="flex-1 truncate">Sandbox</span>
            <span v-if="b.showEditor" class="w-1.5 h-1.5 rounded-full shrink-0 bg-blue-400"></span>
          </button>

          <button
            title="Routines"
            class="w-full text-left px-3 h-8 rounded-lg flex items-center gap-2.5 text-[13.5px] font-medium transition-colors group"
            :class="
              b.currentView === 'routines'
                ? 'bg-blue-600/20 text-white'
                : 'text-slate-300 hover:bg-white/[0.06] hover:text-white'
            "
            @click="b.openRoutinesPage"
          >
            <i
              class="ph ph-clock-countdown text-base shrink-0 transition-colors"
              :class="
                b.currentView === 'routines' ? 'text-blue-300' : 'text-slate-400 group-hover:text-slate-200'
              "
            ></i>
            <span class="flex-1 truncate">Routines</span>
          </button>
          <MenuPagesPlus :compact="false" />
        </div>
      </div>

      <!-- Section « Conversations » : filet sous le menu, titre (ou nombre de chats
                   cochés en mode sélection), loupe et sélection multiple en icônes. -->
      <div
        class="mx-2 mt-3.5 pt-2.5 pl-3 pr-1 border-t border-white/[0.06] flex items-center gap-0.5 shrink-0"
      >
        <span class="flex-1 truncate text-xs font-semibold text-white">{{
          b.chatSelectMode ? b.chatSelected.length + " sélectionné(s)" : "Conversations"
        }}</span>
        <button
          title="Rechercher un chat"
          :aria-pressed="b.searchOpen ? 'true' : 'false'"
          class="w-[26px] h-[26px] rounded-md flex items-center justify-center transition-colors"
          :class="
            b.searchOpen ? 'bg-white/[0.08] text-white' : 'text-slate-400 hover:bg-white/10 hover:text-white'
          "
          @click="b.searchOpen ? b.closeChatSearch() : b.openChatSearch()"
        >
          <i class="ph ph-magnifying-glass text-sm"></i>
        </button>
        <button
          v-if="!b.chatSearch && b.groupedHistory.length > 0"
          :title="b.chatSelectMode ? 'Terminer la sélection' : 'Sélectionner'"
          :aria-pressed="b.chatSelectMode ? 'true' : 'false'"
          class="w-[26px] h-[26px] rounded-md flex items-center justify-center transition-colors"
          :class="
            b.chatSelectMode
              ? 'bg-white/[0.08] text-white'
              : 'text-slate-400 hover:bg-white/10 hover:text-white'
          "
          @click="b.toggleChatSelectMode()"
        >
          <i class="ph text-sm" :class="b.chatSelectMode ? 'ph-x' : 'ph-check-square'"></i>
        </button>
      </div>

      <!-- Recherche : déclenchée par la loupe de la section (ou par le
                   rail réduit). Pas de barre permanente au-dessus des chats — le
                   champ n'apparaît QUE quand searchOpen. État : src/features/chat/historique/recherche.ts. -->
      <div v-show="b.searchOpen" class="px-2 pt-2 pb-1 shrink-0">
        <div class="relative">
          <i
            class="ph ph-magnifying-glass absolute left-3 top-1/2 -translate-y-1/2 text-blue-400 text-base"
          ></i>
          <input
            :ref="(el) => (b.chatSearchRef = el as HTMLInputElement | null)"
            v-model="b.chatSearch"
            placeholder="Rechercher un chat…"
            class="w-full bg-white/[0.06] border border-white/10 text-white text-sm rounded-lg pl-9 pr-8 py-2 outline-none focus:bg-white/10 focus:border-blue-500/60 transition-colors placeholder:text-slate-400"
            @keydown.escape="b.closeChatSearch"
          />
          <button
            title="Fermer la recherche"
            class="absolute right-2 top-1/2 -translate-y-1/2 w-5 h-5 rounded flex items-center justify-center text-slate-400 hover:text-white hover:bg-white/10 transition-colors"
            @click="b.closeChatSearch"
          >
            <i class="ph ph-x text-xs"></i>
          </button>
        </div>
      </div>

      <!-- Historique : contenu central (flex-1, scroll), texte le + clair.
                   `chat-history-scroll` = masque dégradé haut/bas (fondu de
                   scroll) ; les classes fade-top/fade-bottom sont posées par
                   features/chat/page/fondu-defilement.ts selon la position. -->
      <div :ref="brancherFondu" class="chat-history-scroll flex-1 overflow-y-auto px-2 pt-1 pb-2 min-h-0">
        <div v-if="b.chatSearch" class="mb-2 space-y-px">
          <div class="text-[11px] font-semibold tracking-[0.02em] text-slate-400 px-3 pt-1.5 pb-1.5">
            Résultats
          </div>
          <div v-if="b.isSearchingChats" class="text-center py-3">
            <i class="ph ph-spinner animate-spin text-slate-400 text-lg"></i>
          </div>
          <div
            v-else-if="b.chatSearchResults.length === 0"
            class="text-center py-3 text-xs text-slate-400 font-medium"
          >
            Aucun résultat
          </div>
          <button
            v-for="chat in b.chatSearchResults"
            :key="'s' + chat.id"
            type="button"
            data-chat-row
            :aria-current="b.currentView === 'chat' && b.currentChatId === chat.id ? 'page' : undefined"
            class="w-full text-left px-3 h-[30px] text-slate-300 hover:bg-white/[0.05] hover:text-white rounded-lg cursor-pointer truncate flex items-center transition-colors select-none"
            @click="b.loadChat(String(chat.id))"
          >
            <span class="truncate flex-1 text-[13.5px]">{{ chat.title }}</span>
          </button>
        </div>

        <div v-else class="min-h-full flex flex-col space-y-px">
          <!-- Empty state centré : aucun chat (compte neuf ou tout
                           archivé). On pointe vers le bouton "Nouveau chat". -->
          <div
            v-if="b.groupedHistory.length === 0"
            class="flex-1 flex flex-col items-center justify-center text-center px-5 pb-6"
          >
            <div
              class="w-12 h-12 rounded-xl bg-white/[0.06] ring-1 ring-inset ring-white/10 flex items-center justify-center"
            >
              <i class="ph ph-chat-circle-dots text-2xl text-slate-400"></i>
            </div>
            <p class="text-[13px] text-slate-300 mt-3 leading-relaxed">
              Aucune conversation pour l'instant.<br />
              Lancez-vous avec <span class="font-semibold text-white">Nouveau chat</span>.
            </p>
          </div>

          <!-- Liste groupée par date. groupedHistory (app.js) :
                           [{ key, label, items: [chat,…] }, …] (buckets non-vides).
                           Le label de groupe a clairement plus d'espace au-dessus
                           que l'écart inter-item -> il sert d'épine dorsale ; il
                           est aligné sur les titres (même retrait de 12 px). -->
          <!-- Historique des chats, regroupé par date. -->
          <template v-for="group in b.groupedHistory" :key="group.key">
            <div
              class="text-[11px] font-semibold tracking-[0.02em] text-slate-400 px-3 pt-4 pb-1.5 first:pt-1.5"
            >
              {{ group.label }}
            </div>
            <!-- Ligne d'historique : la barre est un composant à part, rendu seulement quand ce qu'elle lit change (plus de v-memo contre le rendu de la racine à chaque flush). -->
            <div
              v-for="chat in group.items"
              :key="chat.id"
              data-chat-row
              :data-chat-id="chat.id"
              class="relative h-[30px] rounded-lg flex items-center group transition-colors select-none"
              :class="
                b.currentView === 'chat' && b.currentChatId === chat.id && !b.chatSelectMode
                  ? 'bg-blue-600/20 text-white font-medium'
                  : 'text-slate-300 hover:bg-white/[0.05] hover:text-white'
              "
              @contextmenu.prevent="b.openContextMenu($event, 'chat', chat)"
            >
              <!-- Titre (ouvre ou coche en mode sélection) et « Actions » : deux boutons frères, jamais imbriqués. -->
              <button
                type="button"
                data-chat-open
                class="flex-1 min-w-0 h-full pl-3 pr-2 group-hover:pr-9 group-focus-within:pr-9 rounded-lg flex items-center gap-2 text-left cursor-pointer"
                :aria-current="
                  b.currentView === 'chat' && b.currentChatId === chat.id && !b.chatSelectMode
                    ? 'page'
                    : undefined
                "
                :aria-pressed="
                  b.chatSelectMode ? (b.chatSelected.includes(chat.id) ? 'true' : 'false') : undefined
                "
                @click="b.chatSelectMode ? b.toggleChatSelect(chat.id) : b.loadChat(chat.id)"
                @keydown.f2.prevent="b.renameChat(chat.id, chat.title)"
              >
                <span
                  v-if="b.chatSelectMode"
                  aria-hidden="true"
                  class="shrink-0 w-4 h-4 rounded border flex items-center justify-center transition-colors"
                  :class="
                    b.chatSelected.includes(chat.id)
                      ? 'bg-blue-600 border-blue-600'
                      : 'border-white/25 group-hover:border-white/50'
                  "
                >
                  <i v-if="b.chatSelected.includes(chat.id)" class="ph ph-check text-white text-[10px]"></i>
                </span>
                <span
                  class="truncate flex-1 text-[13.5px]"
                  :class="chat._renamed ? 'elpis-title-flash' : ''"
                  >{{ chat.title }}</span
                >
                <!-- Run en cours (tous onglets, tous appareils) : point d'accent qui respire (immobile en mouvement réduit). -->
                <span
                  v-if="b.activeRunIds.includes(String(chat.id))"
                  class="elpis-run-dot shrink-0"
                  role="img"
                  aria-label="Génération en cours"
                  title="Génération en cours…"
                ></span>
              </button>
              <button
                v-if="!b.chatSelectMode"
                type="button"
                title="Actions"
                :aria-label="`Actions sur « ${chat.title} »`"
                aria-haspopup="menu"
                class="absolute right-1.5 top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus:outline-none w-6 h-6 rounded-md flex items-center justify-center text-slate-400 hover:text-white hover:bg-white/10 transition-opacity"
                @click="b.openContextMenu($event, 'chat', chat)"
              >
                <i class="ph ph-dots-three text-sm" aria-hidden="true"></i>
              </button>
            </div>
          </template>
        </div>
      </div>

      <!-- Barre d'action bulk : visible quand au moins un chat est sélectionné. -->
      <div
        v-if="b.chatSelectMode && b.chatSelected.length"
        class="elpis-rail-foot px-3 py-2 border-t border-white/[0.07] shrink-0 flex items-center gap-2"
      >
        <button
          class="flex-1 flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-lg text-xs font-medium bg-white/[0.06] text-slate-200 hover:bg-white/[0.12] transition-colors"
          @click="b.bulkArchiveChats()"
        >
          <i class="ph ph-archive text-sm"></i> Archiver ({{ b.chatSelected.length }})
        </button>
        <button
          class="flex-1 flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-lg text-xs font-medium bg-red-600/15 text-red-300 hover:bg-red-600/25 transition-colors"
          @click="b.bulkDeleteChats()"
        >
          <i class="ph ph-trash text-sm"></i> Supprimer
        </button>
      </div>

      <!-- Pied ancré : compte utilisateur + réglages / admin / déconnexion.
                   Fond un cran plus sombre ; --sb-ring-offset adapte l'anneau de
                   focus à ce fond. -->
      <div class="elpis-rail-foot px-3 py-2.5 border-t border-white/[0.07] flex items-center gap-2 shrink-0">
        <MenuCompte v-if="!ui.classique" />
        <div v-else class="flex items-center gap-2.5 min-w-0 flex-1">
          <img
            v-if="b.user.avatar"
            :src="'/avatars/' + b.user.avatar"
            class="w-8 h-8 rounded-full object-cover shadow-sm ring-1 ring-white/10 shrink-0"
          />
          <div
            v-else
            class="w-8 h-8 rounded-full bg-blue-600 flex items-center justify-center text-white text-[11px] font-bold shadow-sm ring-1 ring-white/10 shrink-0"
          >
            {{ b.user.username.substring(0, 2).toUpperCase() }}
          </div>
          <span class="truncate text-sm font-medium text-slate-200 min-w-0">{{ b.user.username }}</span>
        </div>
        <div class="flex items-center gap-0.5 shrink-0">
          <NotificationsPied />

          <button
            title="Paramètres"
            class="w-8 h-8 rounded-md hover:bg-white/10 text-slate-400 hover:text-white transition-colors flex items-center justify-center"
            @click="b.openSettings"
          >
            <i class="ph ph-gear text-base"></i>
          </button>
          <button
            v-if="b.user.is_admin || b.user.role === 'moderator'"
            title="Administration"
            class="w-8 h-8 rounded-md hover:bg-white/10 text-emerald-400 hover:text-emerald-300 transition-colors flex items-center justify-center"
            @click="b.goToAdmin"
          >
            <i class="ph ph-shield-check text-base"></i>
          </button>
          <button
            v-if="ui.classique"
            title="Déconnexion"
            class="w-8 h-8 rounded-md hover:bg-red-500/15 text-slate-400 hover:text-red-400 transition-colors flex items-center justify-center"
            @click="b.logout"
          >
            <i class="ph ph-sign-out text-base"></i>
          </button>
        </div>
      </div>
    </div>
  </aside>
</template>
