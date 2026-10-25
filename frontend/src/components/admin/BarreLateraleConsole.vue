<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/admin/BarreLateraleConsole.vue — barre latérale sombre de navigation de la console. -->
<script setup lang="ts">
import { domaineAdmin } from "../../features/admin/domaine";
import NavigationConsoleDepliee from "./NavigationConsoleDepliee.vue";

const adm = domaineAdmin();
</script>

<template>
  <aside
    class="adm-rail h-full flex flex-col shrink-0 border-r z-50 overflow-hidden elpis-slide-panel"
    :class="adm.showSidebar ? 'adm-rail--open' : 'adm-rail--mini'"
    aria-label="Console d'administration"
  >
    <div v-show="!adm.showSidebar" class="adm-rail__mini">
      <button
        type="button"
        class="adm-rail__icon"
        title="Déplier le panneau"
        aria-label="Déplier le panneau"
        @click="adm.showSidebar = true"
      >
        <i class="ph ph-caret-double-right" aria-hidden="true"></i>
      </button>
      <button
        type="button"
        class="adm-rail__icon"
        title="Rechercher (Ctrl K)"
        aria-label="Rechercher"
        aria-keyshortcuts="Control+K"
        @click="adm.openPalette"
      >
        <i class="ph ph-magnifying-glass" aria-hidden="true"></i>
      </button>
      <nav class="adm-rail__mini-nav" aria-label="Console (réduite)">
        <button
          v-for="e in adm.adminNav"
          :key="'m-' + e.id"
          type="button"
          class="adm-rail__icon"
          :class="{ 'is-active': adm.adminPage.entry === e.id }"
          :title="e.label"
          :aria-label="e.label"
          :aria-current="adm.adminPage.entry === e.id ? 'page' : undefined"
          @click="adm.goAdminEntry(e)"
        >
          <i class="ph" :class="e.icon" aria-hidden="true"></i>
          <span
            v-if="e.id === 'overview' && adm.overviewAttention"
            class="adm-rail__dot"
            aria-hidden="true"
          ></span>
        </button>
      </nav>
      <div class="adm-rail__mini-foot">
        <button
          type="button"
          class="adm-rail__icon"
          :title="adm.appDark ? 'Passer en mode clair' : 'Passer en mode sombre'"
          :aria-label="adm.appDark ? 'Passer en mode clair' : 'Passer en mode sombre'"
          @click="adm.toggleThemeMode"
        >
          <i class="ph" :class="adm.appDark ? 'ph-sun' : 'ph-moon'" aria-hidden="true"></i>
        </button>
        <a
          :href="adm.mainAppUrl || '/'"
          class="adm-rail__icon"
          title="Retour au chat"
          aria-label="Retour au chat"
          @click.prevent="adm.goToMainApp"
        >
          <i class="ph ph-arrow-u-up-left" aria-hidden="true"></i>
        </a>
      </div>
    </div>

    <div v-show="adm.showSidebar" class="adm-rail__full">
      <div class="adm-rail__brand">
        <div class="adm-rail__logo" aria-hidden="true"><i class="ph ph-shield-check"></i></div>
        <div class="min-w-0 flex-1">
          <div class="adm-rail__name truncate">
            {{ (adm.settings && adm.settings.assistant_name) || "Elpis" }}
          </div>
          <div class="adm-rail__sub">Console admin</div>
        </div>
        <button
          type="button"
          class="adm-rail__icon"
          title="Replier le panneau"
          aria-label="Replier le panneau"
          @click="adm.showSidebar = false"
        >
          <i class="ph ph-caret-double-left" aria-hidden="true"></i>
        </button>
      </div>

      <NavigationConsoleDepliee />

      <div class="adm-rail__foot" data-adm-me>
        <a :href="adm.mainAppUrl || '/'" class="adm-rail__link" @click.prevent="adm.goToMainApp">
          <i class="ph ph-arrow-u-up-left" aria-hidden="true"></i> Retour au chat
        </a>
        <div class="adm-me">
          <img
            v-if="adm.user && adm.user.avatar"
            :src="'/avatars/' + adm.user.avatar"
            class="adm-me__avatar object-cover"
            alt=""
          />
          <div v-else class="adm-me__avatar" aria-hidden="true">
            {{ ((adm.user && adm.user.username) || "??").substring(0, 2).toUpperCase() }}
          </div>
          <div class="min-w-0 flex-1">
            <div class="adm-me__name truncate">{{ adm.user && adm.user.username }}</div>
            <div class="adm-me__role">
              {{
                adm.user && adm.user.role === "admin"
                  ? "Administrateur"
                  : adm.user && adm.user.role === "moderator"
                    ? "Modérateur"
                    : "Utilisateur"
              }}
            </div>
          </div>
          <button
            type="button"
            class="adm-rail__icon"
            :title="adm.appDark ? 'Passer en mode clair' : 'Passer en mode sombre'"
            :aria-label="adm.appDark ? 'Passer en mode clair' : 'Passer en mode sombre'"
            @click="adm.toggleThemeMode"
          >
            <i class="ph" :class="adm.appDark ? 'ph-sun' : 'ph-moon'" aria-hidden="true"></i>
          </button>
          <button
            type="button"
            class="adm-rail__icon"
            aria-label="Compte et apparence"
            title="Compte et apparence"
            aria-haspopup="dialog"
            :aria-expanded="adm.adminMeOpen ? 'true' : 'false'"
            @click="adm.adminMeOpen = !adm.adminMeOpen"
          >
            <i class="ph ph-dots-three" aria-hidden="true"></i>
          </button>
        </div>

        <div v-if="adm.adminMeOpen" class="adm-menu" role="dialog" aria-label="Compte et apparence">
          <div class="adm-menu__sec">Apparence</div>
          <div class="adm-menu__row">
            <div class="adm-seg adm-seg--sm" role="radiogroup" aria-label="Mode">
              <button
                v-for="m in [
                  { v: 'system', l: 'Système' },
                  { v: 'light', l: 'Clair' },
                  { v: 'dark', l: 'Sombre' },
                ]"
                :key="m.v"
                type="button"
                role="radio"
                :aria-checked="adm.themeMode === m.v ? 'true' : 'false'"
                class="adm-seg__btn"
                :class="adm.themeMode === m.v ? 'is-active' : ''"
                @click="adm.setThemeMode(m.v)"
              >
                {{ m.l }}
              </button>
            </div>
          </div>
          <button
            v-for="sk in adm.APP_SKINS"
            :key="'skin-' + sk.id"
            type="button"
            class="adm-menu__item"
            :aria-pressed="((adm.settings && adm.settings.skin) || '') === sk.id ? 'true' : 'false'"
            :title="sk.desc"
            @click="adm.setAppSkin(sk.id)"
          >
            <span
              class="adm-swatch"
              aria-hidden="true"
              :style="{ '--sw-rail': sk.sw[0], '--sw-bg': sk.sw[1], '--sw-acc': sk.sw[2] }"
            ></span>
            <span class="flex-1">{{ sk.label }}</span>
            <i
              v-if="((adm.settings && adm.settings.skin) || '') === sk.id"
              class="ph ph-check adm-menu__check"
              aria-hidden="true"
            ></i>
          </button>
          <div class="adm-menu__sep" role="separator"></div>
          <button
            type="button"
            class="adm-menu__item"
            role="switch"
            :aria-checked="adm.adminAutoOpen ? 'true' : 'false'"
            @click="adm.toggleAdminAutoOpen"
          >
            <i class="ph ph-squares-four" aria-hidden="true"></i>
            <span class="flex-1">Ouvrir la console à la connexion</span>
            <i v-if="adm.adminAutoOpen" class="ph ph-check adm-menu__check" aria-hidden="true"></i>
          </button>
          <button
            type="button"
            class="adm-menu__item"
            @click="
              adm.adminMeOpen = false;
              adm.adminConfirmLeave().then((ok) => ok && adm.logout());
            "
          >
            <i class="ph ph-sign-out" aria-hidden="true"></i><span class="flex-1">Déconnexion</span>
          </button>
        </div>
      </div>
    </div>
  </aside>
</template>
