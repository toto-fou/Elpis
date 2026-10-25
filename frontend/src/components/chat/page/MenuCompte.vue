<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/chat/page/MenuCompte.vue — bouton du compte du volet (interface nouvelle) et son menu ouvert vers le haut : nom et rôle, Aide, Informations, Installer opencode, Se déconnecter ; avatar seul sur le rail réduit. -->
<script setup lang="ts">
import { computed, nextTick, ref, useTemplateRef } from "vue";

import { libelleRole, positionCompte } from "../../../features/chat/page/compte";
import { CLE_BARRE, domaine } from "../../../features/chat/page/domaines";
import { focusPremiere, naviguerMenu } from "../../../features/chat/page/menu-clavier";

const props = defineProps<{ compact?: boolean }>();
const b = domaine(CLE_BARRE);
const ouvert = ref(false);
const position = ref<Record<string, string>>({});
const bouton = useTemplateRef<HTMLButtonElement>("bouton");
const menu = useTemplateRef<HTMLDivElement>("menu");
const initiales = computed(() => b.user.username.substring(0, 2).toUpperCase());
const role = computed(() => libelleRole(b.user));

function ouvrir(): void {
  const el = bouton.value;
  if (el) position.value = positionCompte(el.getBoundingClientRect(), !!props.compact);
  ouvert.value = true;
  void nextTick(() => focusPremiere(menu.value));
}

function fermer(rendreFocus: boolean): void {
  ouvert.value = false;
  if (rendreFocus) void nextTick(() => bouton.value?.focus());
}

function choisir(action: "aide" | "infos" | "opencode" | "sortie"): void {
  fermer(action !== "sortie");
  if (action === "aide") b.openHelp();
  else if (action === "infos") b.showInfoModal = true;
  else if (action === "opencode") b.showOpenCodeModal = true;
  else b.logout();
}

function surTouche(e: KeyboardEvent): void {
  if (e.key === "Escape" || e.key === "Tab") {
    if (e.key === "Escape") e.stopPropagation();
    fermer(e.key === "Escape");
  } else if (menu.value) naviguerMenu(e, menu.value);
}

const ITEM =
  "w-full text-left px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-100 focus:bg-slate-100 focus:outline-none rounded-lg flex items-center gap-2.5 transition-colors";
</script>

<template>
  <div class="min-w-0" :class="props.compact ? '' : 'flex-1'">
    <button
      ref="bouton"
      type="button"
      aria-haspopup="menu"
      :aria-expanded="ouvert ? 'true' : 'false'"
      :aria-label="`Compte : ${b.user.username}`"
      :title="props.compact ? b.user.username : undefined"
      class="flex items-center gap-2.5 min-w-0 rounded-lg transition-colors hover:bg-white/10"
      :class="props.compact ? 'w-9 h-9 justify-center shrink-0' : 'w-full px-1.5 py-1 -ml-1.5'"
      data-menu-compte
      @click="ouvert ? fermer(false) : ouvrir()"
    >
      <img
        v-if="b.user.avatar"
        :src="'/avatars/' + b.user.avatar"
        alt=""
        class="w-8 h-8 rounded-full object-cover shadow-sm ring-1 ring-white/10 shrink-0"
      />
      <span
        v-else
        class="w-8 h-8 rounded-full bg-blue-600 flex items-center justify-center text-white text-[11px] font-bold shadow-sm ring-1 ring-white/10 shrink-0"
        aria-hidden="true"
        >{{ initiales }}</span
      >
      <template v-if="!props.compact">
        <span class="truncate text-sm font-medium text-slate-200 min-w-0 flex-1 text-left">{{
          b.user.username
        }}</span>
        <i class="ph ph-caret-up text-[11px] text-slate-400 shrink-0" aria-hidden="true"></i>
      </template>
    </button>

    <div v-if="ouvert" class="fixed inset-0 z-[90]" @click="fermer(false)"></div>
    <Transition name="popover">
      <div
        v-if="ouvert"
        ref="menu"
        role="menu"
        aria-label="Compte"
        class="elpis-notif-pop fixed w-56 bg-white border border-slate-200 rounded-xl shadow-2xl z-[100] p-1.5 space-y-0.5"
        :style="position"
        @keydown="surTouche"
      >
        <div class="px-3 pt-1 pb-1.5 flex flex-col min-w-0" data-compte-identite>
          <span class="text-sm font-semibold text-slate-800 truncate">{{ b.user.username }}</span>
          <span class="text-xs text-slate-500">{{ role }}</span>
        </div>
        <div class="h-px bg-slate-100 my-1" role="separator"></div>
        <button type="button" role="menuitem" :class="ITEM" @click="choisir('aide')">
          <i class="ph ph-question text-slate-500" aria-hidden="true"></i> Aide
        </button>
        <button type="button" role="menuitem" :class="ITEM" @click="choisir('infos')">
          <i class="ph ph-info text-slate-500" aria-hidden="true"></i> Informations
        </button>
        <button
          v-if="b.features.opencode"
          type="button"
          role="menuitem"
          :class="ITEM"
          @click="choisir('opencode')"
        >
          <i class="ph ph-terminal text-slate-500" aria-hidden="true"></i> Installer opencode
        </button>
        <div class="h-px bg-slate-100 my-1" role="separator"></div>
        <button type="button" role="menuitem" :class="ITEM" data-compte-sortie @click="choisir('sortie')">
          <i class="ph ph-sign-out text-slate-500" aria-hidden="true"></i> Se déconnecter
        </button>
      </div>
    </Transition>
  </div>
</template>
