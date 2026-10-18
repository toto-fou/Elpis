<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/admin/CoqueConsole.vue — coque de la console : barre latérale, en-tête, pages, barre d'enregistrement et recherche Ctrl+K. -->
<script setup lang="ts">
import { domaineAdmin } from "../../features/admin/domaine";
import BarreLateraleConsole from "./BarreLateraleConsole.vue";
import EnteteConsole from "./EnteteConsole.vue";
import PageApercu from "./PageApercu.vue";
import PageMetriques from "./PageMetriques.vue";
import PageRapport from "./PageRapport.vue";
import PageObservabilite from "./PageObservabilite.vue";
import PageExecutions from "./PageExecutions.vue";
import PageGeneral from "./PageGeneral.vue";
import PageApparence from "./PageApparence.vue";
import PageConnexions from "./PageConnexions.vue";
import PageModeles from "./PageModeles.vue";
import PageSecurite from "./PageSecurite.vue";
import PageComptes from "./PageComptes.vue";
import PagePrompts from "./PagePrompts.vue";
import PageSandbox from "./PageSandbox.vue";
import PageSousAgents from "./PageSousAgents.vue";
import PageEntretien from "./PageEntretien.vue";
import PageDonnees from "./PageDonnees.vue";
import ModalesConsole from "./ModalesConsole.vue";

const adm = domaineAdmin();
</script>

<template>
  <BarreLateraleConsole />

  <div class="adm-main flex-1 flex flex-col min-w-0">
    <EnteteConsole />

    <div
      v-if="adm.adminIsAdmin && adm.restartPending.length && adm.adminTab !== 'overview'"
      class="adm-restartbar"
      role="status"
    >
      <div class="adm-col adm-restartbar__in" :class="{ 'adm-col--wide': adm.adminPage.wide }">
        <i class="ph ph-arrow-clockwise" aria-hidden="true"></i>
        <span
          ><b>Redémarrage nécessaire</b> · {{ adm.restartPending.length }} réglage{{
            adm.restartPending.length > 1 ? "s" : ""
          }}
          en attente</span
        >
        <span class="flex-1"></span>
        <button type="button" class="adm-link" @click="adm.goAdminPage('overview')">Détail</button>
        <button type="button" class="adm-btn adm-btn--warn adm-btn--sm" @click="adm.restartServer()">
          Redémarrer
        </button>
      </div>
    </div>

    <main
      id="adm-main"
      :ref="
        (el) => {
          adm.adminScroller = el as typeof adm.adminScroller;
        }
      "
      class="adm-scroller custom-scrollbar"
      tabindex="-1"
    >
      <div class="adm-col adm-page" :class="{ 'adm-col--wide': adm.adminPage.wide }">
        <PageApercu />

        <PageMetriques />
        <PageRapport />
        <PageObservabilite />
        <PageExecutions />

        <PageGeneral />
        <PageApparence />
        <PageConnexions />
        <PageModeles />
        <PageSecurite />
        <PageComptes />
        <PagePrompts />
        <PageSandbox />
        <PageSousAgents />
        <PageEntretien />
        <PageDonnees />
      </div>
    </main>

    <transition name="adm-bar">
      <div
        v-if="adm.adminDirtyCount"
        class="adm-savebar"
        role="region"
        aria-label="Modifications non enregistrées"
      >
        <div class="adm-col adm-savebar__in" :class="{ 'adm-col--wide': adm.adminPage.wide }">
          <span class="adm-savebar__count" aria-live="polite">
            <span class="adm-savebar__dot" aria-hidden="true"></span>{{ adm.adminDirtyCount }} modification{{
              adm.adminDirtyCount > 1 ? "s" : ""
            }}
          </span>
          <button
            type="button"
            class="adm-btn adm-btn--quiet adm-btn--sm"
            aria-controls="adm-changes"
            :aria-expanded="adm.adminChangesOpen ? 'true' : 'false'"
            @click="adm.adminChangesOpen = !adm.adminChangesOpen"
          >
            Voir
          </button>
          <span class="flex-1"></span>
          <kbd class="adm-kbd" title="Enregistrer au clavier">Ctrl S</kbd>
          <button
            type="button"
            class="adm-btn adm-btn--quiet"
            :disabled="adm.isSavingAdminPage"
            @click="adm.discardAdminPage()"
          >
            Annuler
          </button>
          <button
            type="button"
            class="adm-btn adm-btn--primary"
            :disabled="adm.isSavingAdminPage"
            @click="adm.saveAdminPage()"
          >
            <i
              class="ph text-base"
              :class="adm.isSavingAdminPage ? 'ph-spinner-gap animate-spin' : 'ph-floppy-disk'"
              aria-hidden="true"
            ></i>
            {{ adm.isSavingAdminPage ? "Enregistrement…" : "Enregistrer" }}
          </button>
          <div
            v-if="adm.adminChangesOpen"
            id="adm-changes"
            class="adm-changes"
            role="dialog"
            aria-label="Détail des modifications"
          >
            <ul>
              <li v-for="c in adm.adminPageChanges" :key="c.store + ':' + c.path" class="adm-changes__row">
                <span class="adm-changes__lbl"
                  >{{ adm.adminChangeLabel(c)
                  }}<i
                    v-if="adm.adminChangeNeedsRestart(c)"
                    class="ph ph-arrow-clockwise adm-changes__restart"
                    title="Pris en compte au redémarrage"
                    aria-label="Pris en compte au redémarrage"
                  ></i
                ></span>
                <span v-if="c.store !== 'prompt'" class="adm-changes__vals">
                  <s>{{ adm.adminChangeValue(c.before) }}</s> → <b>{{ adm.adminChangeValue(c.after) }}</b>
                </span>
                <span v-else class="adm-changes__vals">texte modifié</span>
                <button
                  v-if="adm.adminChangeRevertable(c)"
                  type="button"
                  class="adm-btn adm-btn--icon"
                  :title="'Rétablir ' + adm.adminChangeLabel(c)"
                  :aria-label="'Rétablir ' + adm.adminChangeLabel(c)"
                  @click="adm.revertAdminChange(c)"
                >
                  <i class="ph ph-arrow-counter-clockwise" aria-hidden="true"></i>
                </button>
              </li>
            </ul>
          </div>
        </div>
      </div>
    </transition>
  </div>

  <div
    v-if="adm.showSidebar"
    class="fixed inset-0 bg-black/40 z-40 lg:hidden"
    @click="adm.showSidebar = false"
  ></div>

  <ModalesConsole />

  <div v-if="adm.paletteOpen" class="adm-palette-backdrop" @click.self="adm.closePalette()">
    <div
      class="adm-palette"
      role="dialog"
      aria-modal="true"
      aria-label="Rechercher dans la console"
      @keydown="adm.onPaletteKey"
    >
      <div class="adm-palette__search">
        <i class="ph ph-magnifying-glass" aria-hidden="true"></i>
        <input
          :ref="
            (el) => {
              adm.paletteInput = el as typeof adm.paletteInput;
            }
          "
          v-model="adm.paletteQuery"
          type="text"
          role="combobox"
          aria-expanded="true"
          aria-controls="adm-palette-list"
          aria-autocomplete="list"
          :aria-activedescendant="adm.paletteResults.length ? 'adm-pal-' + adm.paletteIndex : undefined"
          placeholder="Page, réglage ou action"
          autocomplete="off"
          spellcheck="false"
          aria-label="Rechercher une page, un réglage ou une action"
        />
        <kbd class="adm-kbd">Échap</kbd>
      </div>
      <ul id="adm-palette-list" class="adm-palette__list" role="listbox" aria-label="Résultats">
        <li
          v-for="(r, i) in adm.paletteResults"
          :id="'adm-pal-' + i"
          :key="r.key"
          role="option"
          :aria-selected="i === adm.paletteIndex ? 'true' : 'false'"
          class="adm-palette__item"
          :class="{ 'is-active': i === adm.paletteIndex }"
          @mousemove="adm.paletteIndex = i"
          @click="adm.runPaletteItem(r)"
        >
          <i class="ph adm-palette__icon" :class="r.icon" aria-hidden="true"></i>
          <span class="adm-palette__label"
            ><template v-for="(g, k) in r.segs" :key="k"
              ><mark v-if="g.hit">{{ g.t }}</mark
              ><template v-else>{{ g.t }}</template></template
            ></span
          >
          <span v-if="r.meta" class="adm-palette__meta">{{ r.meta }}</span>
          <span class="adm-palette__kind">{{ r.kindLabel }}</span>
        </li>
        <li v-if="!adm.paletteResults.length" class="adm-palette__empty" role="presentation">
          Aucun résultat
        </li>
      </ul>
    </div>
  </div>
</template>
