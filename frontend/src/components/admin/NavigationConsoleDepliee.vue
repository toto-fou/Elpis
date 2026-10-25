<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/admin/NavigationConsoleDepliee.vue — navigation de la console : groupes toujours dépliés et champ qui filtre les pages. -->
<script setup lang="ts">
import { computed, ref } from "vue";

import { filtrerArbre } from "../../features/admin/arbre";
import { domaineAdmin } from "../../features/admin/domaine";
import { NAV_ADMIN } from "../../features/admin/registre";

const adm = domaineAdmin();
const requete = ref("");
const groupes = computed(() => filtrerArbre(NAV_ADMIN.pages, adm.adminIsAdmin, requete.value));

function ouvrirPremiere(): void {
  const premiere = groupes.value[0]?.pagesVisibles[0];
  if (premiere) void adm.goAdminPage(premiere.id).then((ok) => ok && (requete.value = ""));
}
</script>

<template>
  <div class="adm-nav-arbre">
    <div class="adm-nav-arbre__recherche">
      <i class="ph ph-magnifying-glass" aria-hidden="true"></i>
      <input
        v-model="requete"
        type="search"
        data-recherche-pages
        placeholder="Rechercher une page"
        aria-label="Filtrer les pages de la console"
        autocomplete="off"
        @keydown.enter.prevent="ouvrirPremiere"
        @keydown.esc="requete = ''"
      />
      <button
        type="button"
        class="adm-rail__icon"
        title="Rechercher un réglage (Ctrl K)"
        aria-label="Rechercher un réglage"
        aria-keyshortcuts="Control+K"
        @click="adm.openPalette"
      >
        <kbd>Ctrl K</kbd>
      </button>
    </div>
    <nav class="adm-nav" aria-label="Console">
      <p v-if="!groupes.length" class="adm-nav-arbre__vide" role="status">Aucune page.</p>
      <ul>
        <li v-for="g in groupes" :key="g.id" :data-groupe="g.id">
          <button
            v-if="g.pages.length === 1"
            type="button"
            class="adm-nav__entry"
            :aria-current="adm.adminTab === g.pages[0] ? 'page' : undefined"
            @click="adm.goAdminPage(g.pages[0] ?? '')"
          >
            <i class="ph adm-nav__icon" :class="g.icon" aria-hidden="true"></i>
            <span class="adm-nav__label">{{ g.label }}</span>
            <span
              v-if="g.id === 'overview' && adm.overviewAttention"
              class="adm-nav__count"
              :title="adm.overviewAttention + ' à traiter'"
              >{{ adm.overviewAttention }}<span class="sr-only"> à traiter</span></span
            >
          </button>
          <template v-else>
            <div :id="'adm-groupe-' + g.id" class="adm-nav__entry adm-nav__groupe">
              <i class="ph adm-nav__icon" :class="g.icon" aria-hidden="true"></i>
              <span class="adm-nav__label">{{ g.label }}</span>
            </div>
            <ul class="adm-nav__subs" :aria-labelledby="'adm-groupe-' + g.id">
              <li v-for="p in g.pagesVisibles" :key="p.id">
                <button
                  type="button"
                  class="adm-nav__sub"
                  :aria-current="adm.adminTab === p.id ? 'page' : undefined"
                  @click="adm.goAdminPage(p.id)"
                >
                  <span class="adm-nav__label">{{ p.label }}</span>
                </button>
              </li>
            </ul>
          </template>
        </li>
      </ul>
    </nav>
  </div>
</template>
