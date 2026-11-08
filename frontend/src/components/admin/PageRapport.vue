<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/admin/PageRapport.vue — page Supervision › Rapport quotidien : états chargement, erreur et vide, graphiques, aperçu et feuille A4. -->
<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";

import { domaineAdmin } from "../../features/admin/domaine";
import { heureCourte, isoUtc, jourFr } from "../../features/admin/horodatage";
import { ecouterEchap, elementsGraphiques } from "../../features/admin/rapport";
import { gardeFocus, piegerTab } from "../../utils/focus";
import GraphiqueRapport from "./GraphiqueRapport.vue";

const adm = domaineAdmin();
const graphiques = computed(() => elementsGraphiques(adm.dailyReport));
const aDesGraphiques = computed(() => graphiques.value.series.length + graphiques.value.tableaux.length > 0);
const jour = computed(() => jourFr(adm.dailyReport?.date ?? adm.reportDay));
const jourDemande = computed(() => (adm.reportDay ? "du " + jourFr(adm.reportDay) : "du jour"));
const vide = computed(
  () => !!adm.dailyReport && !adm.dailyReportError && adm.reportValueSections.length === 0,
);
const bouton = ref<HTMLButtonElement | null>(null);
const couche = ref<HTMLElement | null>(null);
const garde = gardeFocus();

let retirerEchap: (() => void) | null = null;
const arreterEchap = (): void => {
  retirerEchap?.();
  retirerEchap = null;
};

watch(
  () => adm.reportPreview,
  async (ouvert) => {
    if (ouvert) {
      garde.remember();
      arreterEchap();
      retirerEchap = ecouterEchap(() => adm.closeReportPreview());
      await nextTick();
      bouton.value?.focus();
    } else {
      arreterEchap();
      garde.restore();
    }
  },
);
watch(
  () => adm.adminTab,
  (t) => {
    if (t !== "report") adm.closeReportPreview();
  },
);
onBeforeUnmount(() => {
  arreterEchap();
  adm.closeReportPreview();
});

const CHOIX_PAGE: [boolean, string][] = [
  [true, "Affichés"],
  [false, "Retirés"],
];
const CHOIX_APERCU: [boolean, string][] = [
  [true, "Avec graphiques"],
  [false, "Sans"],
];
</script>

<template>
  <div v-if="adm.adminTab === 'report'" class="animate-[fadeIn_0.2s] space-y-4">
    <section class="adm-card">
      <header class="adm-card__head">
        <i class="ph ph-file-text adm-card__icon" aria-hidden="true"></i>
        <div>
          <h3 class="adm-card__title">Rapport du jour</h3>
          <p class="adm-card__hint">
            Usage de l'IA sur les dernières 24 h<span v-if="adm.dailyReport && adm.dailyReport.date">
              · {{ jour }}</span
            ><span v-if="adm.dailyReport && adm.dailyReport.generated_at">
              · généré le
              <time
                :datetime="isoUtc(adm.dailyReport.generated_at)"
                :title="isoUtc(adm.dailyReport.generated_at)"
                >{{ heureCourte(adm.dailyReport.generated_at) }}</time
              ></span
            >
          </p>
        </div>
        <div class="adm-card__actions">
          <select
            v-if="adm.reportHistory && adm.reportHistory.length"
            class="set-select text-sm"
            aria-label="Jour du rapport"
            :value="adm.reportDay"
            @change="adm.loadDailyReport(($event.target as HTMLSelectElement).value || undefined)"
          >
            <option value="">Aujourd'hui</option>
            <option
              v-for="r in adm.reportHistory"
              :key="r.date"
              :value="r.date"
              :title="isoUtc(r.created_at)"
            >
              {{ jourFr(r.date) }}
            </option>
          </select>
          <button
            id="rap-imprimer"
            type="button"
            class="adm-btn adm-btn--quiet adm-tool"
            :disabled="!adm.dailyReport"
            @click="adm.openReportPreview()"
          >
            <i class="ph ph-printer" aria-hidden="true"></i> Imprimer
          </button>
          <button
            v-if="adm.user?.role === 'admin'"
            type="button"
            :disabled="adm.dailyReportGenerating"
            class="adm-btn adm-btn--primary"
            @click="adm.generateDailyReport()"
          >
            <i
              class="ph"
              :class="adm.dailyReportGenerating ? 'ph-spinner animate-spin' : 'ph-paper-plane-tilt'"
              aria-hidden="true"
            ></i>
            Générer
          </button>
        </div>
      </header>
      <div class="adm-rows">
        <div v-if="adm.user?.role === 'admin'" class="adm-row">
          <div>
            <span class="adm-row__label" title="Chaque jour, aux administrateurs.">Envoi automatique</span>
            <span class="sr-only">Chaque jour, aux administrateurs.</span>
          </div>
          <div>
            <label class="flex items-center gap-2 text-sm cursor-pointer w-fit">
              <span class="relative inline-flex items-center shrink-0">
                <input
                  type="checkbox"
                  class="sr-only peer"
                  :checked="adm.dailyDigestAuto"
                  @change="adm.setDailyDigestAuto(($event.target as HTMLInputElement).checked)"
                />
                <span class="set-switch-track"></span>
              </span>
              <span class="adm-row__label">{{ adm.dailyDigestAuto ? "Activé" : "Désactivé" }}</span>
            </label>
          </div>
        </div>
        <div class="adm-row">
          <div>
            <span
              class="adm-row__label"
              title="Courbes du jour sur la page et sur la feuille imprimée. Préférence de ce navigateur."
              >Graphiques</span
            >
          </div>
          <div class="adm-seg adm-seg--sm" role="group" aria-label="Graphiques du rapport">
            <button
              v-for="[actif, texte] in CHOIX_PAGE"
              :key="texte"
              type="button"
              class="adm-seg__btn"
              :class="{ 'is-active': adm.reportCharts === actif }"
              :aria-pressed="adm.reportCharts === actif"
              @click="adm.setReportCharts(actif)"
            >
              {{ texte }}
            </button>
          </div>
        </div>
      </div>
    </section>

    <div v-if="adm.dailyReportLoading && !adm.dailyReport" class="adm-card p-12 text-center" aria-busy="true">
      <div class="flex flex-col gap-3 rap-squelettes">
        <span class="adm-skeleton" style="width: 60%"></span>
        <span class="adm-skeleton"></span>
        <span class="adm-skeleton" style="width: 80%"></span>
      </div>
      <span class="sr-only">Chargement du rapport…</span>
    </div>

    <div v-else-if="adm.dailyReportError" class="adm-card" role="alert">
      <div class="rap-erreur">
        <i class="ph ph-warning-circle" aria-hidden="true"></i>
        <b>Rapport indisponible</b>
        <span>Le serveur n'a pas pu fournir le rapport {{ jourDemande }} : {{ adm.dailyReportError }}.</span>
        <button type="button" class="adm-btn adm-tool adm-btn--sm" @click="adm.retryDailyReport()">
          <i class="ph ph-arrows-clockwise" aria-hidden="true"></i> Réessayer
        </button>
      </div>
    </div>

    <div v-else-if="vide" class="adm-card p-12 text-center">
      <i class="ph ph-file-dashed text-3xl mb-2 block adm-empty__icon" aria-hidden="true"></i>
      <span class="adm-empty">Ce rapport ne contient aucune donnée.</span>
    </div>

    <div
      v-else-if="adm.dailyReport"
      class="space-y-4"
      :class="{ 'rap-attenue': adm.dailyReportLoading }"
      :aria-busy="adm.dailyReportLoading"
    >
      <section v-for="sec in adm.reportValueSections" :key="sec.id" class="adm-card">
        <header class="adm-card__head">
          <div>
            <h3 class="adm-card__title">{{ sec.label }}</h3>
          </div>
        </header>
        <div class="p-4 grid grid-cols-2 md:grid-cols-4 gap-3">
          <div v-for="wid in sec.widgets" :key="wid" class="adm-stat">
            <div class="adm-stat__label">{{ adm.reportTitle(wid) }}</div>
            <div class="adm-stat__value tabular-nums">{{ adm.reportVal(wid) }}</div>
          </div>
        </div>
      </section>

      <section v-if="adm.reportCharts" class="adm-card">
        <header class="adm-card__head">
          <i class="ph ph-chart-line adm-card__icon" aria-hidden="true"></i>
          <div>
            <h3 class="adm-card__title">Graphiques</h3>
          </div>
          <div class="adm-card__actions">
            <button
              type="button"
              class="adm-btn adm-btn--quiet adm-btn--sm"
              @click="adm.setReportCharts(false)"
            >
              Retirer
            </button>
          </div>
        </header>
        <p v-if="!aDesGraphiques" class="adm-empty p-4">
          Ce rapport ne contient pas de données de série : aucun graphique à tracer.
        </p>
        <div v-else class="p-4 rap-grille">
          <div v-for="s in graphiques.series" :key="s.id">
            <div class="adm-stat__label rap-graphe-titre">{{ s.titre }}</div>
            <GraphiqueRapport :serie="s" />
          </div>
          <div v-for="t in graphiques.tableaux" :key="t.id" class="overflow-x-auto">
            <div class="adm-stat__label rap-graphe-titre">{{ t.titre }}</div>
            <table class="adm-table">
              <thead>
                <tr>
                  <th v-for="c in t.colonnes" :key="c.key" :class="c.align === 'right' ? 'text-right' : ''">
                    {{ c.label }}
                  </th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="(l, i) in t.lignes" :key="i">
                  <td
                    v-for="c in t.colonnes"
                    :key="c.key"
                    :class="c.align === 'right' ? 'text-right tabular-nums' : ''"
                  >
                    {{ l[c.key] }}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </section>
      <p v-else class="adm-row__hint sup-hint-large">
        <i class="ph ph-chart-line" aria-hidden="true"></i> Graphiques retirés de la page et de la feuille
        imprimée ·
        <button type="button" class="adm-link" @click="adm.setReportCharts(true)">Les afficher</button>
      </p>
    </div>

    <Teleport to="body">
      <div
        v-if="adm.reportPreview && adm.dailyReport"
        ref="couche"
        class="rap-couche"
        role="dialog"
        aria-modal="true"
        aria-label="Aperçu avant impression"
        tabindex="-1"
        @keydown="piegerTab($event, couche)"
      >
        <div class="rap-barre">
          <i class="ph ph-printer" aria-hidden="true"></i><b>Aperçu avant impression</b>
          <span class="adm-muted">A4 portrait · lisible en noir et blanc</span>
          <span class="flex-1"></span>
          <div class="adm-seg adm-seg--sm" role="group" aria-label="Graphiques">
            <button
              v-for="[actif, texte] in CHOIX_APERCU"
              :key="texte"
              type="button"
              class="adm-seg__btn"
              :class="{ 'is-active': adm.reportCharts === actif }"
              :aria-pressed="adm.reportCharts === actif"
              @click="adm.setReportCharts(actif)"
            >
              {{ texte }}
            </button>
          </div>
          <button type="button" class="adm-btn adm-btn--quiet" @click="adm.closeReportPreview()">
            Fermer
          </button>
          <button ref="bouton" type="button" class="adm-btn adm-btn--primary" @click="adm.printDailyReport()">
            <i class="ph ph-printer" aria-hidden="true"></i> Imprimer
          </button>
        </div>
        <div class="rap-defil">
          <article class="rap-feuille">
            <div class="rap-feuille__entete">
              <div>
                <div class="rap-feuille__marque">Elpis</div>
                <h1>Rapport d'usage du {{ jour }}</h1>
              </div>
              <div class="rap-feuille__meta">
                Période : {{ adm.dailyReport.scope_hours }} h<br />
                Généré le {{ heureCourte(adm.dailyReport.generated_at) }} · heure locale
              </div>
            </div>
            <template v-for="sec in adm.reportValueSections" :key="sec.id">
              <h2>{{ sec.label }}</h2>
              <table>
                <tbody>
                  <tr v-for="wid in sec.widgets" :key="wid">
                    <td>{{ adm.reportTitle(wid) }}</td>
                    <td>{{ adm.reportVal(wid) }}</td>
                  </tr>
                </tbody>
              </table>
            </template>
            <p v-if="adm.reportCharts && !aDesGraphiques" class="rap-feuille__note">
              Pas de données de série dans ce rapport : aucun graphique.
            </p>
            <template v-if="adm.reportCharts && aDesGraphiques">
              <h2>Graphiques</h2>
              <div class="rap-feuille__graphes">
                <div v-for="s in graphiques.series" :key="s.id" class="rap-feuille__graphe">
                  <p>{{ s.titre }}</p>
                  <GraphiqueRapport :serie="s" :hauteur="90" />
                </div>
                <div v-for="t in graphiques.tableaux" :key="t.id" class="rap-feuille__graphe">
                  <p>{{ t.titre }}</p>
                  <table>
                    <tbody>
                      <tr v-for="(l, i) in t.lignes" :key="i">
                        <td v-for="c in t.colonnes" :key="c.key">{{ l[c.key] }}</td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </div>
            </template>
            <div class="rap-feuille__pied"><span>Document interne · diffusion restreinte</span></div>
          </article>
        </div>
      </div>
    </Teleport>
  </div>
</template>
