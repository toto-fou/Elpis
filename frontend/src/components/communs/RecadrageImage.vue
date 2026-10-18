<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/communs/RecadrageImage.vue — fenêtre de recadrage d'une image avant envoi : cadre carré (aperçu rond ou carré), glisser, zoom, ajuster, remplir, quart de tour, sortie redimensionnée. -->
<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, shallowRef, useId, watch } from "vue";

import {
  actionClavier,
  ajuster,
  COTE_SORTIE,
  deplacer,
  echelleDuNiveau,
  echelleRemplir,
  etatInitial,
  niveauZoom,
  PAS_ZOOM,
  remplir,
  tourner,
  zoomer,
  zoomerPar,
} from "../../features/communs/recadrage";
import type { EtatRecadrage, Point } from "../../features/communs/recadrage";
import {
  decoderImage,
  densitePixels,
  dessiner,
  ecouterClavierFenetre,
  elementActif,
  ErreurRecadrage,
  exporterRecadrage,
  planifierDessin,
} from "../../features/communs/recadrage-dom";
import type { ImageDecodee } from "../../features/communs/recadrage-dom";

const props = withDefaults(
  defineProps<{
    fichier: Blob | null;
    titre: string;
    forme?: "rond" | "carre";
    cote?: number;
    nomFichier?: string;
  }>(),
  { forme: "rond", cote: COTE_SORTIE, nomFichier: "image" },
);
const emit = defineEmits<{
  valider: [fichier: File];
  annuler: [];
  erreur: [message: string];
}>();

const SCENE = 288;
const CADRE = 224;
const MARGE = (SCENE - CADRE) / 2;
const NIVEAUX = 1000;
const FOCUSABLES = 'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])';

const ids = { titre: useId(), aide: useId() };
const boite = ref<HTMLElement | null>(null);
const scene = ref<HTMLElement | null>(null);
const canevas = ref<HTMLCanvasElement | null>(null);
const image = shallowRef<ImageDecodee | null>(null);
const etat = shallowRef<EtatRecadrage | null>(null);
const occupe = ref(false);
const message = ref("");
const glisse = ref(false);
const pointeurs = new Map<number, Point>();
let generation = 0;
let annulerDessin: (() => void) | null = null;
let retirerClavier: (() => void) | null = null;
let focusAvant: HTMLElement | null = null;

const ouvert = computed(() => props.fichier !== null);
const niveau = computed(() => (etat.value ? Math.round(niveauZoom(etat.value) * NIVEAUX) : 0));
const pourcent = computed(() =>
  etat.value ? Math.round((etat.value.echelle / echelleRemplir(etat.value)) * 100) : 100,
);

/** Redessine l'aperçu à la prochaine image d'animation (une seule demande en attente). */
function redessiner(): void {
  if (annulerDessin) return;
  annulerDessin = planifierDessin(() => {
    annulerDessin = null;
    const c = canevas.value;
    const img = image.value;
    const e = etat.value;
    if (!c || !img || !e) return;
    const dpr = densitePixels();
    const cote = Math.round(SCENE * dpr);
    if (c.width !== cote) c.width = c.height = cote;
    const ctx = c.getContext("2d");
    if (ctx) dessiner(ctx, img, e, cote, CADRE * dpr);
  });
}

function poser(e: EtatRecadrage): void {
  etat.value = e;
  redessiner();
}

/** Point du pointeur relatif au centre du cadre. */
function relatif(ev: { clientX: number; clientY: number }): Point {
  const r = scene.value?.getBoundingClientRect();
  if (!r) return { x: 0, y: 0 };
  return { x: ev.clientX - r.left - r.width / 2, y: ev.clientY - r.top - r.height / 2 };
}

function surPointeurBas(ev: PointerEvent): void {
  if (!etat.value || (ev.pointerType === "mouse" && ev.button !== 0)) return;
  scene.value?.setPointerCapture?.(ev.pointerId);
  pointeurs.set(ev.pointerId, relatif(ev));
  glisse.value = true;
  scene.value?.focus();
}

/** Un doigt ou la souris déplace ; deux doigts zooment autour de leur milieu et déplacent avec lui. */
function surPointeurMouvement(ev: PointerEvent): void {
  const avant = pointeurs.get(ev.pointerId);
  const e = etat.value;
  if (!avant || !e) return;
  const apres = relatif(ev);
  const autres = [...pointeurs.entries()].filter(([id]) => id !== ev.pointerId).map(([, p]) => p);
  pointeurs.set(ev.pointerId, apres);
  const autre = autres[0];
  if (autre === undefined) {
    poser(deplacer(e, apres.x - avant.x, apres.y - avant.y));
    return;
  }
  const d0 = Math.hypot(avant.x - autre.x, avant.y - autre.y);
  const d1 = Math.hypot(apres.x - autre.x, apres.y - autre.y);
  const m0 = { x: (avant.x + autre.x) / 2, y: (avant.y + autre.y) / 2 };
  const m1 = { x: (apres.x + autre.x) / 2, y: (apres.y + autre.y) / 2 };
  const zoome = d0 > 0 ? zoomerPar(e, d1 / d0, m0) : e;
  poser(deplacer(zoome, m1.x - m0.x, m1.y - m0.y));
}

function surPointeurHaut(ev: PointerEvent): void {
  pointeurs.delete(ev.pointerId);
  glisse.value = pointeurs.size > 0;
}

function surMolette(ev: WheelEvent): void {
  if (!etat.value) return;
  const delta = ev.deltaMode === 1 ? ev.deltaY * 16 : ev.deltaY;
  poser(zoomerPar(etat.value, Math.exp(-delta * 0.002), relatif(ev)));
}

function surCurseur(ev: Event): void {
  if (!etat.value || !(ev.target instanceof HTMLInputElement)) return;
  poser(zoomer(etat.value, echelleDuNiveau(etat.value, Number(ev.target.value) / NIVEAUX)));
}

function zoomBouton(facteur: number): void {
  if (etat.value) poser(zoomerPar(etat.value, facteur));
}

function appliquer(f: (e: EtatRecadrage) => EtatRecadrage): void {
  if (etat.value) poser(f(etat.value));
}

/** Flèches et +/- sur la zone de l'image (le curseur et les boutons gardent leurs touches). */
function surToucheScene(ev: KeyboardEvent): void {
  const a = actionClavier(ev.key, ev.shiftKey);
  if (!a || a.type === "annuler" || !etat.value || ev.ctrlKey || ev.metaKey || ev.altKey) return;
  ev.preventDefault();
  poser(a.type === "deplacer" ? deplacer(etat.value, a.dx, a.dy) : zoomerPar(etat.value, a.facteur));
}

/** En capture sur la fenêtre, avant le clavier global : Échap annule ici seulement, Tab reste dans la fenêtre. */
function surToucheGlobale(ev: KeyboardEvent): void {
  if (!ouvert.value) return;
  if (ev.key === "Escape") {
    ev.preventDefault();
    ev.stopImmediatePropagation();
    annuler();
    return;
  }
  if (ev.key !== "Tab" || !boite.value) return;
  ev.stopImmediatePropagation();
  const liste = [...boite.value.querySelectorAll<HTMLElement>(FOCUSABLES)];
  const premier = liste[0];
  const dernier = liste[liste.length - 1];
  if (!premier || !dernier) return;
  const actif = elementActif();
  if (!boite.value.contains(actif)) {
    ev.preventDefault();
    premier.focus();
  } else if (ev.shiftKey && actif === premier) {
    ev.preventDefault();
    dernier.focus();
  } else if (!ev.shiftKey && actif === dernier) {
    ev.preventDefault();
    premier.focus();
  }
}

function annuler(): void {
  if (!occupe.value) emit("annuler");
}

async function valider(): Promise<void> {
  if (!image.value || !etat.value || occupe.value) return;
  occupe.value = true;
  message.value = "";
  try {
    emit("valider", await exporterRecadrage(image.value, etat.value, props.cote, props.nomFichier));
  } catch (e) {
    message.value = e instanceof ErreurRecadrage ? e.message : "Préparation de l'image impossible.";
  } finally {
    occupe.value = false;
  }
}

/** Décode chaque nouveau fichier ; un résultat arrivé après un autre choix est ignoré. */
async function charger(fichier: Blob): Promise<void> {
  const g = ++generation;
  try {
    const img = await decoderImage(fichier);
    if (g !== generation) return;
    image.value = img;
    poser(etatInitial(img.dimensions, CADRE));
    await nextTick();
    redessiner();
  } catch (e) {
    if (g !== generation) return;
    emit("erreur", e instanceof ErreurRecadrage ? e.message : "Image illisible.");
  }
}

watch(
  () => props.fichier,
  (fichier, avant) => {
    image.value = null;
    etat.value = null;
    message.value = "";
    pointeurs.clear();
    glisse.value = false;
    if (!fichier) {
      generation++;
      retirerClavier?.();
      retirerClavier = null;
      if (avant && focusAvant?.isConnected) focusAvant.focus();
      return;
    }
    if (!retirerClavier) {
      focusAvant = elementActif();
      retirerClavier = ecouterClavierFenetre(surToucheGlobale);
    }
    void nextTick(() => scene.value?.focus());
    void charger(fichier);
  },
  { immediate: true },
);

onBeforeUnmount(() => {
  generation++;
  retirerClavier?.();
  annulerDessin?.();
});
</script>

<template>
  <Teleport to="body">
    <div
      v-if="ouvert"
      class="fixed inset-0 z-[6000] flex items-center justify-center bg-slate-900/80 p-4"
      @click.self="annuler"
    >
      <div
        ref="boite"
        role="dialog"
        aria-modal="true"
        :aria-labelledby="ids.titre"
        :aria-describedby="ids.aide"
        class="bg-white rounded-2xl shadow-2xl ring-1 ring-slate-200 w-full max-w-sm overflow-hidden flex flex-col"
      >
        <div class="px-5 py-4 border-b border-slate-100 flex justify-between items-center">
          <h2 :id="ids.titre" class="text-base font-semibold text-slate-800">{{ props.titre }}</h2>
          <button
            type="button"
            aria-label="Annuler le recadrage"
            class="w-8 h-8 rounded-lg hover:bg-slate-100 text-slate-500 hover:text-slate-700 transition-colors flex items-center justify-center"
            @click="annuler"
          >
            <i class="ph ph-x text-lg" aria-hidden="true"></i>
          </button>
        </div>

        <div class="p-5 space-y-4">
          <div
            ref="scene"
            tabindex="0"
            data-recadrage-scene
            aria-label="Image à recadrer"
            :aria-describedby="ids.aide"
            class="relative mx-auto overflow-hidden rounded-xl bg-slate-800 select-none outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
            :style="{
              width: SCENE + 'px',
              height: SCENE + 'px',
              touchAction: 'none',
              cursor: etat ? (glisse ? 'grabbing' : 'grab') : 'progress',
            }"
            @pointerdown="surPointeurBas"
            @pointermove="surPointeurMouvement"
            @pointerup="surPointeurHaut"
            @pointercancel="surPointeurHaut"
            @wheel.prevent="surMolette"
            @keydown="surToucheScene"
          >
            <canvas ref="canevas" class="absolute inset-0 w-full h-full" aria-hidden="true"></canvas>
            <div
              class="absolute pointer-events-none ring-2 ring-white/80"
              :class="props.forme === 'rond' ? 'rounded-full' : 'rounded-lg'"
              :style="{
                left: MARGE + 'px',
                top: MARGE + 'px',
                width: CADRE + 'px',
                height: CADRE + 'px',
                boxShadow: '0 0 0 9999px rgba(15, 23, 42, 0.6)',
              }"
              aria-hidden="true"
            ></div>
            <div v-if="!etat" class="absolute inset-0 flex items-center justify-center text-white/80">
              <i class="ph ph-spinner-gap animate-spin text-2xl" aria-hidden="true"></i>
              <span class="sr-only">Chargement de l'image…</span>
            </div>
          </div>
          <p :id="ids.aide" class="text-[11px] text-slate-500 text-center leading-snug">
            Glissez pour déplacer, molette pour zoomer. Clavier : flèches, + et -, Échap pour annuler.
          </p>

          <div class="flex items-center gap-2">
            <button
              type="button"
              aria-label="Dézoomer"
              :disabled="!etat"
              class="w-8 h-8 rounded-lg hover:bg-slate-100 text-slate-500 flex items-center justify-center disabled:opacity-50"
              @click="zoomBouton(1 / PAS_ZOOM)"
            >
              <i class="ph ph-minus" aria-hidden="true"></i>
            </button>
            <input
              type="range"
              min="0"
              :max="NIVEAUX"
              step="1"
              :value="niveau"
              :disabled="!etat"
              aria-label="Zoom"
              :aria-valuetext="pourcent + ' %'"
              class="flex-1 accent-blue-600"
              @input="surCurseur"
            />
            <button
              type="button"
              aria-label="Zoomer"
              :disabled="!etat"
              class="w-8 h-8 rounded-lg hover:bg-slate-100 text-slate-500 flex items-center justify-center disabled:opacity-50"
              @click="zoomBouton(PAS_ZOOM)"
            >
              <i class="ph ph-plus" aria-hidden="true"></i>
            </button>
            <span class="w-12 text-right text-[11px] font-mono tabular-nums text-slate-500" aria-hidden="true"
              >{{ pourcent }} %</span
            >
          </div>

          <div class="flex items-center justify-center gap-1.5 flex-wrap">
            <button
              type="button"
              :disabled="!etat"
              title="Image entière dans le cadre"
              class="px-3 py-1.5 bg-white border border-slate-200 hover:bg-slate-50 rounded-md text-xs font-medium text-slate-600 transition-colors disabled:opacity-50"
              @click="appliquer(ajuster)"
            >
              Ajuster
            </button>
            <button
              type="button"
              :disabled="!etat"
              title="Cadre entièrement couvert"
              class="px-3 py-1.5 bg-white border border-slate-200 hover:bg-slate-50 rounded-md text-xs font-medium text-slate-600 transition-colors disabled:opacity-50"
              @click="appliquer(remplir)"
            >
              Remplir
            </button>
            <button
              type="button"
              :disabled="!etat"
              aria-label="Pivoter à gauche"
              title="Pivoter à gauche"
              class="w-8 h-8 bg-white border border-slate-200 hover:bg-slate-50 rounded-md text-slate-600 flex items-center justify-center transition-colors disabled:opacity-50"
              @click="appliquer((e) => tourner(e, -1))"
            >
              <i class="ph ph-arrow-counter-clockwise" aria-hidden="true"></i>
            </button>
            <button
              type="button"
              :disabled="!etat"
              aria-label="Pivoter à droite"
              title="Pivoter à droite"
              class="w-8 h-8 bg-white border border-slate-200 hover:bg-slate-50 rounded-md text-slate-600 flex items-center justify-center transition-colors disabled:opacity-50"
              @click="appliquer((e) => tourner(e, 1))"
            >
              <i class="ph ph-arrow-clockwise" aria-hidden="true"></i>
            </button>
          </div>

          <p v-if="message" role="alert" class="text-xs text-red-600 bg-red-500/10 rounded-lg px-3 py-2">
            {{ message }}
          </p>
        </div>

        <div class="px-5 py-3 border-t border-slate-100 flex justify-end gap-2">
          <button
            type="button"
            :disabled="occupe"
            class="px-3 py-1.5 text-sm font-medium text-slate-600 hover:bg-slate-100 rounded-lg transition-colors disabled:opacity-50"
            @click="annuler"
          >
            Annuler
          </button>
          <button
            type="button"
            :disabled="!etat || occupe"
            class="px-3.5 py-1.5 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm font-medium transition-colors disabled:opacity-50 inline-flex items-center gap-1.5"
            @click="valider"
          >
            <i v-if="occupe" class="ph ph-spinner-gap animate-spin" aria-hidden="true"></i>
            Valider
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>
