<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/chat/page/MenuModele.vue — menu du modèle (interface nouvelle) : recherche, modèles groupés par serveur avec capacités et état, actions « ⋯ » par ligne, effort de réflexion, paramètres de génération, cache du moteur. -->
<script setup lang="ts">
import { computed, nextTick, ref, useId, useTemplateRef, watch } from "vue";

import { resumeCharge } from "../../../features/chat/modeles/charge";
import { CLE_ENTETE, CLE_MODELES, domaine } from "../../../features/chat/page/domaines";
import { contientFocus, focusPremiere, naviguerMenu } from "../../../features/chat/page/menu-clavier";
import {
  construireGroupes,
  filtrerGroupes,
  LIBELLES_ETAT,
  nomLisible,
  SEUIL_RECHERCHE,
} from "../../../features/chat/page/menu-modele";
import type { ActionModele, LigneModele } from "../../../features/chat/page/menu-modele";
import { libelleEffort } from "../../../features/chat/page/puces";
import { clesModifiees } from "../../../features/reglages/echantillonnage";
import { fmtTokenCount } from "../../../utils/utils-purs";

// `etroit` : rangée du composeur sous 420 px, nom plus court.
const props = defineProps<{ etroit?: boolean }>();
const mod = domaine(CLE_MODELES);
const ent = domaine(CLE_ENTETE);
const idListe = useId();
const bouton = useTemplateRef<HTMLButtonElement>("bouton");
const pop = useTemplateRef<HTMLDivElement>("pop");
const champ = useTemplateRef<HTMLInputElement>("champ");
const menuActions = useTemplateRef<HTMLDivElement>("menuActions");
const menuEffort = useTemplateRef<HTMLDivElement>("menuEffort");
const boutonEffort = useTemplateRef<HTMLButtonElement>("boutonEffort");

const filtre = ref("");
const actif = ref("");
const actions = ref<{ ligne: LigneModele; haut: number } | null>(null);
let ancreActions: HTMLElement | null = null;
const effortOuvert = ref(false);

const groupes = computed(() => construireGroupes(mod));
const recherche = computed(() => groupes.value.reduce((n, g) => n + g.lignes.length, 0) > SEUIL_RECHERCHE);
const visibles = computed(() =>
  recherche.value ? filtrerGroupes(groupes.value, filtre.value) : groupes.value,
);
const lignes = computed(() => visibles.value.flatMap((g) => g.lignes));
const cleActive = computed(() => {
  const l = lignes.value;
  return l.some((x) => x.cle === actif.value)
    ? actif.value
    : (l.find((x) => x.choisi)?.cle ?? l[0]?.cle ?? "");
});

const libelle = computed(() => (mod.selectedModel ? nomLisible(mod.selectedModel) : mod.selectedModelLabel));
const titre = computed(() =>
  mod.selectedConnector && mod.selectedEngineMeta?.label
    ? `${mod.selectedModelLabel} · ${mod.selectedEngineMeta.label}`
    : mod.selectedModelLabel,
);
const effortCourant = computed(() =>
  mod.samplingOverride.reasoning_effort ? libelleEffort(mod.samplingOverride.reasoning_effort) : "Auto",
);
const modifies = computed(() => clesModifiees(mod.samplingOverride).length);

// Cache du moteur visé : l'intégré, ou le connecteur choisi s'il expose ses métriques.
const jauge = computed(() => {
  const kv = mod.selectedConnector
    ? mod.pickerConnState[mod.selectedConnector]?.kv
    : mod.builtinAllowed
      ? mod.llmHealth?.kv_cache
      : null;
  return kv && kv.total > 0 ? kv : null;
});
const titreCache = computed(() => {
  const charge = resumeCharge(
    mod.selectedConnector ? mod.pickerConnState[mod.selectedConnector]?.charge : mod.llmHealth?.charge,
  );
  return "Mémoire du moteur occupée par les conversations en cours" + (charge ? ` · ${charge}` : "");
});

function basculer(): void {
  mod.toggleModelMenu();
  if (!mod.showModelManager) return;
  filtre.value = "";
  actif.value = "";
  void nextTick(() => champ.value?.focus());
}

// Fermé (choix, Échap, clic dehors) alors que le focus y était : il revient au bouton.
watch(
  () => mod.showModelManager,
  (ouvert) => {
    if (ouvert) return;
    const avait = contientFocus(pop.value);
    actions.value = null;
    effortOuvert.value = false;
    filtre.value = "";
    if (avait) void nextTick(() => bouton.value?.focus());
  },
);

function choisir(l: LigneModele): void {
  if (l.connecteur) mod.pickConnectorModel(l.connecteur, l.id);
  else mod.pickLocalModel(l.id);
}

const options = (): HTMLElement[] =>
  pop.value ? [...pop.value.querySelectorAll<HTMLElement>('[role="option"]')] : [];

function surToucheChamp(e: KeyboardEvent): void {
  if (e.key === "ArrowDown") {
    e.preventDefault();
    options()[0]?.focus();
  } else if (e.key === "Enter") {
    e.preventDefault();
    const premiere = lignes.value[0];
    if (premiere) choisir(premiere);
  }
}

function surToucheOption(e: KeyboardEvent, l: LigneModele): void {
  const opts = options();
  const i = opts.indexOf(e.currentTarget as HTMLElement);
  const aller = (j: number): void => {
    e.preventDefault();
    opts[j]?.focus();
  };
  if (e.key === "ArrowDown") aller((i + 1) % opts.length);
  else if (e.key === "ArrowUp" && i === 0 && champ.value) {
    e.preventDefault();
    champ.value.focus();
  } else if (e.key === "ArrowUp") aller((i - 1 + opts.length) % opts.length);
  else if (e.key === "Home") aller(0);
  else if (e.key === "End") aller(opts.length - 1);
  else if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    choisir(l);
  } else if (e.key === "ArrowRight" || e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey)) {
    e.preventDefault();
    const ancre = (e.currentTarget as HTMLElement).parentElement?.querySelector<HTMLElement>(
      "[data-actions]",
    );
    if (ancre && l.actions.length) ouvrirActions(l, ancre, true);
  }
}

function ouvrirActions(l: LigneModele, ancre: HTMLElement, clavier: boolean): void {
  if (actions.value?.ligne.cle === l.cle && !clavier) {
    actions.value = null;
    return;
  }
  effortOuvert.value = false;
  ancreActions = ancre;
  const cadre = pop.value?.getBoundingClientRect();
  actions.value = { ligne: l, haut: cadre ? ancre.getBoundingClientRect().bottom - cadre.top + 2 : 0 };
  void nextTick(() => focusPremiere(menuActions.value));
}

function fermerActions(rendreFocus: boolean): void {
  actions.value = null;
  const ancre = ancreActions;
  if (rendreFocus && ancre) void nextTick(() => ancre.focus());
}

function surToucheActions(e: KeyboardEvent): void {
  if (menuActions.value && naviguerMenu(e, menuActions.value)) return;
  if (e.key === "Escape" || e.key === "ArrowLeft") {
    e.preventDefault();
    e.stopPropagation();
    fermerActions(true);
  } else if (e.key === "Tab") fermerActions(false);
}

// Le focus revient à la ligne avant l'action : une fenêtre ouverte ensuite le rendra là.
function agir(l: LigneModele, a: ActionModele): void {
  if (a.id !== "fiche" && mod.isLoadingModel) return;
  fermerActions(true);
  void nextTick(() => {
    const moteur = l.connecteur ? "conn:" + l.connecteur.id : undefined;
    if (a.id === "fiche") void mod.fetchModelProps(l.id, moteur);
    else if (l.connecteur) void mod.toggleConnModel(l.connecteur, l.id);
    else void mod.toggleLlmModel(l.id);
  });
}

function basculerEffort(clavier: boolean): void {
  effortOuvert.value = !effortOuvert.value;
  actions.value = null;
  if (effortOuvert.value && clavier)
    void nextTick(() => {
      const coche = menuEffort.value?.querySelector<HTMLElement>('[aria-checked="true"]');
      if (coche) coche.focus();
      else focusPremiere(menuEffort.value);
    });
}

function ouvrirEffort(): void {
  if (!effortOuvert.value) basculerEffort(true);
}

function fermerEffort(): void {
  effortOuvert.value = false;
  void nextTick(() => boutonEffort.value?.focus());
}

function choisirEffort(v: string | null): void {
  mod.pickReasoningEffort(v);
  fermerEffort();
}

function surToucheEffort(e: KeyboardEvent): void {
  if (menuEffort.value && naviguerMenu(e, menuEffort.value)) return;
  if (e.key === "Escape" || e.key === "ArrowLeft") {
    e.preventDefault();
    e.stopPropagation();
    fermerEffort();
  } else if (e.key === "Tab") effortOuvert.value = false;
}

// Échap avec un sous-menu ouvert à la souris : il se ferme, le menu du modèle reste.
function surTouchePop(e: KeyboardEvent): void {
  if (e.key !== "Escape" || (!actions.value && !effortOuvert.value)) return;
  e.preventDefault();
  actions.value = null;
  effortOuvert.value = false;
}

function surClic(e: MouseEvent): void {
  const cible = e.target instanceof Element ? e.target : null;
  if (actions.value && !cible?.closest("[data-menu-actions],[data-actions]")) actions.value = null;
  if (effortOuvert.value && !cible?.closest("[data-effort-menu]")) effortOuvert.value = false;
}

function ouvrirReglages(): void {
  mod.showModelManager = false;
  if (!ent.showSamplingPanel) ent.togglePanel("sampling");
}

function rafraichir(): void {
  void mod.loadAvailableModels();
  for (const c of mod.pickerConnectors) mod.retryConnModels(c.id);
}

const LIGNE =
  "w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-xs text-slate-700 hover:bg-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500";
const ITEM =
  "w-full text-left px-2.5 py-1.5 text-xs text-slate-700 hover:bg-slate-100 focus:bg-slate-100 focus:outline-none rounded-lg flex items-center gap-2 aria-disabled:opacity-50";
</script>

<template>
  <div v-show="!mod.imageMode" class="relative shrink-0 min-w-0" data-model-manager data-menu-modele>
    <button
      ref="bouton"
      type="button"
      aria-haspopup="dialog"
      :aria-expanded="mod.showModelManager ? 'true' : 'false'"
      :title="titre"
      class="flex items-center gap-1 px-1.5 py-1 rounded-lg text-xs font-medium transition-colors text-slate-500 hover:text-slate-700 hover:bg-slate-100"
      :class="mod.showModelManager ? 'bg-slate-100 text-slate-700' : ''"
      @click="basculer"
    >
      <span class="truncate" :class="props.etroit ? 'max-w-[96px]' : 'max-w-[170px]'">{{ libelle }}</span>
      <i
        class="ph ph-caret-down text-[10px] transition-transform"
        :class="mod.showModelManager && 'rotate-180'"
        aria-hidden="true"
      ></i>
    </button>

    <Transition name="popover-up">
      <div
        v-if="mod.showModelManager"
        ref="pop"
        role="dialog"
        aria-label="Modèle"
        class="absolute bottom-full right-0 mb-2 w-[330px] max-w-[calc(100vw-2rem)] bg-white rounded-xl shadow-2xl border border-slate-200 z-[200] flex flex-col"
        @click.stop="surClic"
        @keydown="surTouchePop"
      >
        <div v-if="recherche" class="px-2 pt-2 pb-1">
          <div class="relative">
            <i
              class="ph ph-magnifying-glass absolute left-2 top-1/2 -translate-y-1/2 text-sm text-slate-400"
              aria-hidden="true"
            ></i>
            <input
              ref="champ"
              v-model="filtre"
              type="search"
              autocomplete="off"
              placeholder="Chercher un modèle"
              aria-label="Chercher un modèle"
              :aria-controls="idListe"
              class="w-full h-8 pl-7 pr-2 rounded-lg border border-slate-200 bg-white text-xs text-slate-800 placeholder:text-slate-400 focus:outline-none focus:border-blue-500"
              data-recherche-modele
              @keydown="surToucheChamp"
            />
          </div>
        </div>

        <div
          :id="idListe"
          role="listbox"
          aria-label="Modèles"
          class="max-h-64 overflow-y-auto px-1 pb-1"
          @scroll="actions = null"
        >
          <div
            v-if="mod.noEngineAllowed"
            class="px-2.5 py-3 text-xs text-slate-500 flex items-center gap-2"
            title="Demandez l'accès à un serveur à votre administrateur"
          >
            <i class="ph ph-lock-simple" aria-hidden="true"></i> Aucun serveur autorisé
          </div>
          <div v-else-if="recherche && filtre && !lignes.length" class="px-2.5 py-3 text-xs text-slate-500">
            Aucun modèle trouvé
          </div>
          <div
            v-for="(g, gi) in visibles"
            :key="g.cle"
            role="group"
            :aria-labelledby="`${idListe}-g${gi}`"
            :data-groupe-modeles="g.cle"
          >
            <div
              :id="`${idListe}-g${gi}`"
              class="flex items-center gap-1.5 px-2 pt-2 pb-1 text-xs font-semibold text-slate-600"
            >
              <span class="truncate" :title="g.detail || undefined">{{ g.nom }}</span>
              <span
                v-if="g.etat.libelle"
                class="ml-auto shrink-0 inline-flex items-center gap-1 font-normal text-slate-500"
                data-etat-serveur
              >
                <span
                  class="w-1.5 h-1.5 rounded-full"
                  :class="g.etat.ton === 'ok' ? 'bg-emerald-500' : 'bg-slate-300'"
                  aria-hidden="true"
                ></span>
                {{ g.etat.libelle }}
                <template v-if="g.etat.reessayer">
                  ·
                  <button
                    type="button"
                    class="text-blue-600 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 rounded"
                    @click="g.connecteur ? mod.retryConnModels(g.connecteur.id) : mod.loadAvailableModels()"
                  >
                    Réessayer
                  </button>
                </template>
              </span>
            </div>
            <div v-if="g.message" class="px-2.5 py-1.5 text-xs text-slate-500">{{ g.message }}</div>
            <div
              v-for="l in g.lignes"
              :key="l.cle"
              class="flex items-center gap-0.5 rounded-lg"
              :class="[l.choisi ? 'bg-blue-50' : 'hover:bg-slate-50', l.attenue ? 'opacity-60' : '']"
            >
              <div
                role="option"
                :aria-selected="l.choisi ? 'true' : 'false'"
                :tabindex="l.cle === cleActive ? 0 : -1"
                :title="l.attenue ? `${l.id} · serveur injoignable` : l.id"
                :data-modele="l.id"
                class="flex-1 min-w-0 flex items-center gap-2 px-2 py-1.5 rounded-lg cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
                @click="choisir(l)"
                @focus="actif = l.cle"
                @keydown="surToucheOption($event, l)"
              >
                <i
                  class="ph ph-check text-sm shrink-0"
                  :class="l.choisi ? 'text-blue-600' : 'invisible'"
                  aria-hidden="true"
                ></i>
                <span class="flex-1 min-w-0">
                  <span class="block truncate text-xs font-medium text-slate-800">{{ l.nom }}</span>
                  <span v-if="l.capacites.length" class="flex flex-wrap gap-1 mt-0.5">
                    <span
                      v-for="c in l.capacites"
                      :key="c.libelle"
                      class="px-1.5 rounded-full border border-slate-200 bg-slate-50 text-[11px] leading-4 text-slate-600"
                      :title="c.titre"
                      data-capacite
                      >{{ c.libelle }}</span
                    >
                  </span>
                </span>
                <span
                  class="shrink-0 inline-flex items-center gap-1 text-xs text-slate-500 whitespace-nowrap"
                  :title="
                    l.etat === 'echec'
                      ? 'Échec du dernier chargement : voir les journaux du serveur d\'inférence'
                      : undefined
                  "
                  :data-etat-modele="l.etat"
                >
                  <i v-if="l.etat === 'echec'" class="ph ph-x-circle text-red-600" aria-hidden="true"></i>
                  <i
                    v-else-if="l.etat === 'chargement' || l.etat === 'dechargement'"
                    class="ph ph-spinner-gap animate-spin motion-reduce:animate-none"
                    aria-hidden="true"
                  ></i>
                  {{ LIBELLES_ETAT[l.etat] }}
                </span>
              </div>
              <button
                v-if="l.actions.length"
                type="button"
                :tabindex="l.cle === cleActive ? 0 : -1"
                :aria-label="`Actions : ${l.nom}`"
                title="Actions du modèle"
                aria-haspopup="menu"
                :aria-expanded="actions?.ligne.cle === l.cle ? 'true' : 'false'"
                class="shrink-0 w-6 h-6 mr-1 flex items-center justify-center rounded-md text-slate-500 hover:text-slate-800 hover:bg-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
                data-actions
                @click="ouvrirActions(l, $event.currentTarget as HTMLElement, $event.detail === 0)"
              >
                <i class="ph ph-dots-three text-base" aria-hidden="true"></i>
              </button>
            </div>
          </div>
        </div>

        <div
          v-if="actions"
          ref="menuActions"
          role="menu"
          :aria-label="`Actions : ${actions.ligne.nom}`"
          class="absolute right-2 w-48 bg-white border border-slate-200 rounded-xl shadow-xl p-1 z-10"
          :style="{ top: actions.haut + 'px' }"
          data-menu-actions
          data-sous-menu-modele
          @keydown="surToucheActions"
        >
          <button
            v-for="a in actions.ligne.actions"
            :key="a.id"
            type="button"
            role="menuitem"
            :aria-disabled="a.id !== 'fiche' && mod.isLoadingModel ? 'true' : undefined"
            :class="ITEM"
            :data-action-modele="a.id"
            @click="agir(actions.ligne, a)"
          >
            <i class="ph text-sm text-slate-500" :class="a.icone" aria-hidden="true"></i>
            {{ a.libelle }}
          </button>
        </div>

        <div class="border-t border-slate-100 p-1">
          <div v-if="mod.reasoningEffortValues.length" class="relative" data-effort-menu>
            <button
              ref="boutonEffort"
              type="button"
              aria-haspopup="menu"
              :aria-expanded="effortOuvert ? 'true' : 'false'"
              :class="LIGNE"
              @click="basculerEffort($event.detail === 0)"
              @keydown.right.prevent="ouvrirEffort"
            >
              <i class="ph ph-brain text-sm text-slate-500" aria-hidden="true"></i>
              <span class="flex-1 text-left">Réflexion</span>
              <span class="text-slate-500" data-effort-courant>{{ effortCourant }}</span>
              <i class="ph ph-caret-right text-[11px] text-slate-400" aria-hidden="true"></i>
            </button>
            <div
              v-if="effortOuvert"
              ref="menuEffort"
              role="menu"
              aria-label="Effort de réflexion"
              class="absolute right-1 bottom-full mb-1 sm:right-full sm:bottom-0 sm:mb-0 sm:mr-2 w-44 bg-white border border-slate-200 rounded-xl shadow-xl p-1 z-10"
              data-sous-menu-modele
              @keydown="surToucheEffort"
            >
              <div class="px-2.5 pt-1 pb-1 text-xs font-semibold text-slate-500" aria-hidden="true">
                Effort de réflexion
              </div>
              <button
                type="button"
                role="menuitemradio"
                :aria-checked="!mod.samplingOverride.reasoning_effort ? 'true' : 'false'"
                :class="ITEM"
                @click="choisirEffort(null)"
              >
                <i
                  class="ph ph-check text-sm"
                  :class="!mod.samplingOverride.reasoning_effort ? 'text-blue-600' : 'invisible'"
                  aria-hidden="true"
                ></i>
                Auto
              </button>
              <button
                v-for="v in mod.reasoningEffortValues"
                :key="v"
                type="button"
                role="menuitemradio"
                :title="v"
                :aria-checked="mod.samplingOverride.reasoning_effort === v ? 'true' : 'false'"
                :class="ITEM"
                @click="choisirEffort(v)"
              >
                <i
                  class="ph ph-check text-sm"
                  :class="mod.samplingOverride.reasoning_effort === v ? 'text-blue-600' : 'invisible'"
                  aria-hidden="true"
                ></i>
                {{ libelleEffort(v) }}
              </button>
            </div>
          </div>
          <button type="button" :class="LIGNE" data-reglages-generation @click="ouvrirReglages">
            <i class="ph ph-sliders-horizontal text-sm text-slate-500" aria-hidden="true"></i>
            <span class="flex-1 text-left">Paramètres de génération…</span>
            <span v-if="modifies" class="text-slate-500" data-compteur-modifies
              >{{ modifies }} {{ modifies > 1 ? "modifiés" : "modifié" }}</span
            >
          </button>
        </div>

        <div
          class="flex items-center gap-2 px-3 py-1.5 border-t border-slate-100 bg-slate-50 rounded-b-xl text-xs text-slate-500"
          :title="jauge ? titreCache : undefined"
          data-cache-moteur
        >
          <template v-if="jauge">
            <span>Cache</span>
            <span class="flex-1 h-1.5 rounded-full bg-slate-200 overflow-hidden" aria-hidden="true">
              <span
                class="block h-full w-full rounded-full transition-transform duration-500 motion-reduce:transition-none"
                :class="mod.kvBarClass(jauge.pct)"
                :style="{ transformOrigin: 'left', transform: `scaleX(${Math.min(jauge.pct, 100) / 100})` }"
              ></span>
            </span>
            <span class="font-mono tabular-nums" data-jauge-kv
              >{{ fmtTokenCount(jauge.used) }} / {{ fmtTokenCount(jauge.total) }}</span
            >
          </template>
          <span v-else class="flex-1"></span>
          <button
            type="button"
            aria-label="Rafraîchir la liste"
            title="Rafraîchir la liste"
            class="w-6 h-6 flex items-center justify-center rounded-md text-slate-500 hover:text-slate-800 hover:bg-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
            @click="rafraichir"
          >
            <i class="ph ph-arrows-clockwise text-sm" aria-hidden="true"></i>
          </button>
        </div>
      </div>
    </Transition>
  </div>
</template>
