<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/chat/page/NotificationsPied.vue — cloche du pied du volet et son panneau : notifications groupées par date, lu et non lu, suppression, pagination. -->
<script setup lang="ts">
import { CLE_BARRE, domaine } from "../../../features/chat/page/domaines";

const b = domaine(CLE_BARRE);
</script>

<template>
  <!-- Cloche notifications : badge non-lus + panneau déroulant
                   ancré au-dessus (bottom-full). Le ref enveloppe bouton +
                   panneau pour la fermeture au clic externe (app.js). -->
  <div :ref="(el) => (b.notifDropdownRef = el)" class="relative">
    <button
      :title="b.notifUnread ? b.notifUnread + ' notification(s) non lue(s)' : 'Notifications'"
      :aria-pressed="b.showNotifPanel ? 'true' : 'false'"
      class="relative w-8 h-8 rounded-md hover:bg-white/10 transition-colors flex items-center justify-center"
      :class="b.showNotifPanel ? 'bg-white/[0.08] text-white' : 'text-slate-400 hover:text-white'"
      @click="b.toggleNotifPanel"
    >
      <i class="ph text-base" :class="b.notifUnread ? 'ph-bell-ringing' : 'ph-bell'"></i>
      <span
        v-if="b.notifUnread"
        role="status"
        :aria-label="b.notifUnread + ' notification(s) non lue(s)'"
        class="absolute -top-0.5 -right-0.5 min-w-[15px] h-[15px] px-1 bg-red-500 text-white text-[9px] font-bold rounded-full flex items-center justify-center leading-none shadow-sm ring-1 ring-[#0b1120]"
      >
        {{ b.notifUnread > 99 ? "99+" : b.notifUnread }}
      </span>
    </button>

    <!-- Panneau (light, cohérent avec les dropdowns memory/+/RAG).
                       Positionné en FIXED ancré au coin bas-gauche du viewport :
                       la cloche vit dans le pied de sidebar (bas-gauche) et un
                       ancrage absolute right-0 faisait déborder les 320px du
                       panneau hors de l'écran à gauche. Le panneau reste un
                       enfant DOM du wrapper → la fermeture au clic externe
                       (notifDropdownRef.contains) continue de fonctionner. -->
    <Transition name="popover">
      <!-- elpis-notif-pop : marqueur « surface claire de l'app » —
                       les remaps rail de style.css ne doivent pas déteindre ici. -->
      <div
        v-if="b.showNotifPanel"
        class="elpis-notif-pop fixed bottom-16 left-3 w-80 max-w-[calc(100vw-1.5rem)] bg-white border border-slate-200 rounded-xl shadow-2xl z-[100] overflow-hidden"
      >
        <div class="flex items-center justify-between px-4 py-3 border-b border-slate-100">
          <span class="text-sm font-semibold text-slate-800">Notifications</span>
          <div v-if="b.notifications.length" class="flex items-center gap-3">
            <button
              type="button"
              title="Tout marquer comme lu"
              class="h-7 px-2 rounded-md flex items-center gap-1 text-xs font-medium text-slate-600 hover:text-slate-800 hover:bg-slate-100 transition-colors"
              @click="b.markAllNotifsRead"
            >
              <i class="ph ph-checks text-sm" aria-hidden="true"></i> Tout lu
            </button>
            <button
              type="button"
              title="Effacer toutes les notifications (Annuler possible)"
              class="h-7 px-2 rounded-md flex items-center gap-1 text-xs font-medium text-slate-600 hover:text-red-600 hover:bg-slate-100 transition-colors"
              data-notif-effacer
              @click="b.clearNotifs"
            >
              <i class="ph ph-trash text-sm" aria-hidden="true"></i> Effacer
            </button>
          </div>
        </div>
        <div class="max-h-[360px] overflow-y-auto custom-scrollbar py-1">
          <!-- Chargement initial -->
          <div
            v-if="b.notifLoading && !b.notifications.length"
            class="py-8 flex items-center justify-center text-slate-400"
          >
            <i class="ph ph-spinner-gap text-lg animate-spin"></i>
          </div>
          <!-- Erreur réseau -->
          <div
            v-else-if="b.notifError && !b.notifications.length"
            class="py-8 px-4 text-center text-xs text-slate-500"
          >
            <i class="ph ph-wifi-slash text-2xl text-slate-300"></i>
            <p class="mt-2">Chargement impossible.</p>
            <button class="mt-1.5 text-blue-600 hover:underline font-medium" @click="b.loadNotifications">
              Réessayer
            </button>
          </div>
          <!-- Vide (état utile) -->
          <div v-else-if="!b.notifications.length" class="py-8 px-5 text-center">
            <i class="ph ph-bell-slash text-2xl text-slate-300"></i>
            <p class="mt-2 text-xs text-slate-400 leading-relaxed">
              Vos routines, scénarios du Studio et rapports d'usage apparaîtront ici.
            </p>
          </div>
          <!-- Liste groupée par date -->
          <template v-for="g in b.groupedNotifications" :key="g.label">
            <div class="px-4 pt-2.5 pb-1 text-xs font-semibold text-slate-500 select-none">
              {{ g.label }}
            </div>
            <div
              v-for="n in g.items"
              :key="n.id"
              role="button"
              tabindex="0"
              class="flex items-start gap-2.5 px-4 py-2.5 hover:bg-slate-50 cursor-pointer group transition-colors"
              :class="b.isNotifNew(n) ? 'bg-blue-50/40' : ''"
              @click="b.openNotifItem(n)"
              @keydown.enter="b.openNotifItem(n)"
            >
              <span
                class="w-1.5 h-1.5 rounded-full mt-2 shrink-0"
                :class="b.isNotifNew(n) ? 'bg-blue-500' : 'bg-transparent'"
                aria-hidden="true"
              ></span>
              <span v-if="b.isNotifNew(n)" class="sr-only">Non lue :</span>
              <i
                class="ph text-base mt-0.5 shrink-0"
                :class="b.notifIcon(n.kind) + ' ' + b.notifColor(n.kind)"
              ></i>
              <div class="min-w-0 flex-1">
                <div
                  class="text-[13px] text-slate-800 truncate"
                  :class="b.isNotifNew(n) ? 'font-semibold' : 'font-normal'"
                >
                  {{ n.title }}
                </div>
                <div v-if="n.body" class="text-xs text-slate-500 line-clamp-2 mt-0.5">
                  {{ n.body }}
                </div>
                <div class="text-[11px] text-slate-400 mt-0.5">
                  {{ b.notifTimeAgo(n.created_at, b.notifNowTick) }}
                </div>
              </div>
              <div class="flex items-center gap-0.5 shrink-0">
                <button
                  :title="n.read_at ? 'Marquer comme non lu' : 'Marquer comme lu'"
                  class="opacity-0 group-hover:opacity-100 focus:opacity-100 w-5 h-5 rounded flex items-center justify-center text-slate-300 hover:text-blue-600 hover:bg-slate-100 transition-all"
                  @click.stop="b.toggleNotifReadState(n)"
                >
                  <i class="ph text-xs" :class="n.read_at ? 'ph-circle' : 'ph-check'"></i>
                </button>
                <button
                  title="Supprimer"
                  class="opacity-0 group-hover:opacity-100 focus:opacity-100 w-5 h-5 rounded flex items-center justify-center text-slate-300 hover:text-red-500 hover:bg-slate-100 transition-all"
                  @click.stop="b.deleteNotif(n.id)"
                >
                  <i class="ph ph-x text-xs"></i>
                </button>
              </div>
            </div>
          </template>
          <!-- Pagination -->
          <button
            v-if="b.notifHasMore"
            :disabled="b.notifLoading"
            class="w-full py-2 mt-1 text-[11px] font-medium text-blue-600 hover:bg-slate-50 transition-colors disabled:opacity-50"
            @click="b.loadMoreNotifs"
          >
            {{ b.notifLoading ? "Chargement…" : "Voir plus" }}
          </button>
        </div>
      </div>
    </Transition>
  </div>
</template>
