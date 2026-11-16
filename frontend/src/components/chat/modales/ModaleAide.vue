<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/chat/modales/ModaleAide.vue — fenêtre d'aide : sommaire du guide à gauche (recherche, groupes), section choisie à droite avec ses clips, ouverte sur le bloc de l'écran en cours. -->
<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef, watch } from "vue";

import { domaineModales } from "../../../features/chat/modales/domaine";
import {
  apresPeinture,
  lireGuide,
  monterSection,
  plier,
  tacheSuivante,
  titreVise,
  trouverSection,
} from "../../../features/reglages/aide-rendu";
import type { SectionAide, SectionMontee } from "../../../features/reglages/aide-rendu";

const m = domaineModales();
const defilement = ref<HTMLElement | null>(null);
const corps = ref<HTMLElement | null>(null);
const sommaire = ref<HTMLElement | null>(null);
const requete = ref("");
const courante = ref("");
let montee: SectionMontee | null = null;
let ancre = "";
let parGeste = false;
/** Durée d'une tranche de lecture du guide ; au-delà, la suite attend la tâche suivante. */
const TRANCHE_MS = 8;
let decoupe = "";
let tour = 0;
let pose = 0;

const sections = shallowRef<SectionAide[]>([]);
const posee = ref(false);
const enPreparation = computed(() => m.isLoadingReadme || (!!m.readmeContent && !sections.value.length));

// La fenêtre se peint d'abord ; le guide est lu ensuite par tranches courtes, puis le sommaire s'affiche et la section suit dans sa propre tâche.
watch(
  [() => m.showHelpModal, () => m.readmeContent],
  ([ouverte, texte]) => {
    if (!ouverte || texte === decoupe) return;
    const moi = ++tour;
    const lecture = lireGuide(texte);
    const pas = (): void => {
      if (moi !== tour) return;
      if (!lecture.avancer(TRANCHE_MS)) return tacheSuivante(pas);
      decoupe = texte;
      sections.value = lecture.sections();
    };
    apresPeinture(pas);
  },
  { immediate: true },
);
const trouvees = computed(() => {
  const q = plier(requete.value.trim());
  return q ? sections.value.filter((s) => s.recherche.includes(q)) : sections.value;
});
const groupes = computed(() => {
  const g: { titre: string; entrees: SectionAide[] }[] = [];
  for (const s of trouvees.value) {
    const dernier = g[g.length - 1];
    if (dernier && dernier.titre === s.groupe) dernier.entrees.push(s);
    else g.push({ titre: s.groupe, entrees: [s] });
  }
  return g;
});
const section = computed(() => sections.value.find((s) => s.id === courante.value) ?? sections.value[0]);
const rang = computed(() => (section.value ? sections.value.indexOf(section.value) : -1));
const precedente = computed(() => sections.value[rang.value - 1]);
const suivante = computed(() => sections.value[rang.value + 1]);

// À l'ouverture : la section demandée, sinon la dernière lue, sinon la première.
watch(
  [() => m.showHelpModal, () => m.helpSection, sections],
  ([ouverte]) => {
    if (!ouverte) return;
    const voulue = trouverSection(sections.value, m.helpSection);
    if (voulue) courante.value = voulue.id;
    else if (!sections.value.some((s) => s.id === courante.value))
      courante.value = sections.value[0]?.id ?? "";
    requete.value = "";
  },
  { immediate: true },
);

// Section posée hors du gabarit, dans sa propre tâche, à chaque changement ; après un geste, son titre (ou le sous-titre du lien suivi) prend le focus, que le remplacement du texte a retiré.
watch(
  [corps, section],
  () => {
    const moi = ++pose;
    tacheSuivante(() => {
      if (moi !== pose) return;
      const [el, s] = [corps.value, section.value];
      montee?.detacher();
      montee = el && defilement.value && s ? monterSection(el, defilement.value, s.md) : null;
      posee.value = montee !== null;
      const cible = el && s ? titreVise(el, s, ancre) : null;
      if (ancre && cible) cible.scrollIntoView({ block: "start" });
      else if (defilement.value) defilement.value.scrollTop = 0;
      if (parGeste && cible instanceof HTMLElement) {
        cible.tabIndex = -1;
        cible.focus({ preventScroll: true });
      }
      ancre = "";
      parGeste = false;
      sommaire.value?.querySelector('[aria-current="page"]')?.scrollIntoView({ block: "nearest" });
    });
  },
  { flush: "post" },
);
onBeforeUnmount(() => {
  tour++;
  pose++;
  montee?.detacher();
});

function choisir(id: string): void {
  parGeste = id !== courante.value;
  courante.value = id;
}

// Lien du guide : une ancre mène à sa section puis à son titre ; tout autre lien relatif est sans effet (il ferait quitter l'application).
function clic(ev: MouseEvent): void {
  const lien = ev.target instanceof Element ? ev.target.closest("a") : null;
  const href = lien?.getAttribute("href") ?? "";
  if (!lien || !href) return;
  if (!href.startsWith("#")) {
    if (/^(?:https?:|mailto:)/i.test(href)) m.handleMarkdownClick(ev);
    else ev.preventDefault();
    return;
  }
  ev.preventDefault();
  let visee = href.slice(1);
  try {
    visee = decodeURIComponent(visee);
  } catch {
    /* ancre mal encodée : gardée telle quelle */
  }
  const cible = trouverSection(sections.value, visee);
  if (!cible) return;
  if (cible.id !== section.value?.id) {
    ancre = cible.id === visee ? "" : visee;
    choisir(cible.id);
    return;
  }
  const titre = corps.value ? titreVise(corps.value, cible, visee) : null;
  titre?.scrollIntoView({ block: "start" });
}
</script>

<template>
  <Transition name="modal">
    <div
      v-if="m.showHelpModal"
      data-a11y-modal
      role="dialog"
      aria-modal="true"
      aria-label="Aide"
      class="fixed inset-0 z-[6000] flex items-center justify-center bg-slate-900/80 p-4"
      @click.self="m.showHelpModal = false"
    >
      <div
        class="bg-white rounded-2xl shadow-2xl ring-1 ring-slate-200 w-full max-w-5xl overflow-hidden flex flex-col h-[90vh] max-h-[860px]"
      >
        <div class="px-5 py-4 border-b border-slate-100 flex justify-between items-center shrink-0">
          <div class="flex items-center gap-2.5">
            <span
              class="w-7 h-7 rounded-lg bg-slate-100 flex items-center justify-center text-slate-600"
              aria-hidden="true"
            >
              <i class="ph ph-question text-base" aria-hidden="true"></i>
            </span>
            <h2 class="text-base font-semibold text-slate-800">Aide</h2>
          </div>
          <button
            type="button"
            aria-label="Fermer l'aide"
            title="Fermer"
            class="w-8 h-8 shrink-0 rounded-lg hover:bg-slate-100 text-slate-500 hover:text-slate-700 transition-colors flex items-center justify-center"
            @click="m.showHelpModal = false"
          >
            <i class="ph ph-x text-lg" aria-hidden="true"></i>
          </button>
        </div>
        <div class="flex-1 min-h-0 flex flex-col md:flex-row">
          <aside
            ref="sommaire"
            class="w-full md:w-60 shrink-0 bg-slate-50 border-b md:border-b-0 md:border-r border-slate-200 md:overflow-y-auto custom-scrollbar px-3 pb-3 pt-3 md:pt-0"
            data-aide-sommaire
          >
            <div class="relative mb-2 bg-slate-50 md:sticky md:top-0 md:z-10 md:pt-3">
              <i
                class="ph ph-magnifying-glass absolute left-2 bottom-2 text-slate-400 text-sm"
                aria-hidden="true"
              ></i>
              <input
                v-model="requete"
                type="search"
                placeholder="Rechercher dans l'aide"
                aria-label="Rechercher dans l'aide"
                class="w-full h-8 pl-7 pr-2 text-sm rounded-md border border-slate-200 bg-white text-slate-800 placeholder:text-slate-400"
                data-aide-recherche
                @keydown.enter="trouvees[0] && choisir(trouvees[0].id)"
              />
            </div>
            <select
              class="md:hidden w-full h-8 text-sm rounded-md border border-slate-200 bg-white text-slate-800"
              aria-label="Section de l'aide"
              :value="section?.id"
              @change="choisir(($event.target as HTMLSelectElement).value)"
            >
              <template v-for="g in groupes" :key="g.titre">
                <optgroup v-if="g.titre" :label="g.titre">
                  <option v-for="s in g.entrees" :key="s.id" :value="s.id">{{ s.titre }}</option>
                </optgroup>
                <template v-else>
                  <option v-for="s in g.entrees" :key="s.id" :value="s.id">{{ s.titre }}</option>
                </template>
              </template>
            </select>
            <p
              v-if="!groupes.length && !enPreparation"
              class="text-xs text-slate-500 px-2.5 py-1.5"
              role="status"
            >
              Aucune section trouvée.
            </p>
            <nav class="hidden md:block" aria-label="Sommaire de l'aide">
              <div v-for="g in groupes" :key="g.titre" class="mb-2">
                <div v-if="g.titre" class="text-xs font-semibold text-slate-500 px-2.5 mb-1.5 mt-1">
                  {{ g.titre }}
                </div>
                <button
                  v-for="s in g.entrees"
                  :key="s.id"
                  type="button"
                  :aria-current="section?.id === s.id ? 'page' : undefined"
                  :class="
                    section?.id === s.id
                      ? 'bg-white text-blue-600 shadow-sm font-medium'
                      : 'text-slate-600 hover:bg-white/60 hover:text-slate-800'
                  "
                  class="w-full text-left px-2.5 py-1.5 rounded-md text-sm transition-colors mb-0.5"
                  data-aide-entree
                  @click="choisir(s.id)"
                >
                  {{ s.titre }}
                </button>
              </div>
            </nav>
          </aside>
          <div
            ref="defilement"
            class="flex-1 min-w-0 overflow-y-auto custom-scrollbar relative p-6 md:px-10 md:py-8"
          >
            <div
              v-if="enPreparation"
              class="absolute inset-0 flex flex-col items-center justify-center bg-white z-10 text-slate-400"
            >
              <i class="ph ph-spinner-gap animate-spin text-4xl mb-3" aria-hidden="true"></i>
              <p class="font-medium text-sm">Chargement...</p>
            </div>
            <div ref="corps" class="markdown-body aide-guide max-w-3xl mx-auto" @click="clic"></div>
            <div
              v-if="posee && (precedente || suivante)"
              class="max-w-3xl mx-auto mt-10 pt-4 border-t border-slate-100 flex justify-between gap-4 text-sm"
            >
              <button
                v-if="precedente"
                type="button"
                class="min-w-0 flex items-center gap-1.5 text-slate-500 hover:text-slate-800 transition-colors"
                @click="choisir(precedente.id)"
              >
                <i class="ph ph-arrow-left shrink-0" aria-hidden="true"></i>
                <span class="truncate">{{ precedente.titre }}</span>
              </button>
              <span v-else></span>
              <button
                v-if="suivante"
                type="button"
                class="min-w-0 flex items-center gap-1.5 text-slate-500 hover:text-slate-800 transition-colors"
                @click="choisir(suivante.id)"
              >
                <span class="truncate">{{ suivante.titre }}</span>
                <i class="ph ph-arrow-right shrink-0" aria-hidden="true"></i>
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  </Transition>
</template>
