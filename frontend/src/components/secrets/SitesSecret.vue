<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/secrets/SitesSecret.vue — éditeur des sites (origines) d'un secret : une ligne par site, URL collée ramenée à son origine, erreur par ligne, ajout et retrait au clavier. -->
<script setup lang="ts">
import { ORIGINES_SECRET_MAX } from "@elpis/contracts";
import { nextTick, ref, watch } from "vue";

import { erreurOrigine, origineDeSaisie } from "../../features/secrets/format";

const props = defineProps<{ modelValue: string; idBase: string; erreur?: string }>();
const emit = defineEmits<{ "update:modelValue": [valeur: string] }>();

interface Ligne {
  cle: number;
  valeur: string;
  note: string;
}
let compteur = 0;
const nouvelle = (valeur = ""): Ligne => ({ cle: ++compteur, valeur, note: "" });
const depuis = (texte: string): Ligne[] => {
  const l = texte.split(/\r?\n/u).filter((x) => x.trim() !== "");
  return (l.length ? l : [""]).map((v) => nouvelle(v));
};
const jointes = (l: Ligne[]): string => l.map((x) => x.valeur.trim()).join("\n");

const lignes = ref<Ligne[]>(depuis(props.modelValue));
const racine = ref<HTMLElement | null>(null);

// Valeur remplacée de l'extérieur (formulaire rouvert) : les lignes la suivent.
watch(
  () => props.modelValue,
  (v) => {
    if (v !== jointes(lignes.value)) lignes.value = depuis(v);
  },
);

const publier = (): void => emit("update:modelValue", jointes(lignes.value));
const champ = (cle: number): HTMLInputElement | null =>
  racine.value?.querySelector<HTMLInputElement>(`[data-site-cle="${cle}"]`) ?? null;

/** Erreur d'une ligne non vide ; un doublon d'une ligne précédente est signalé aussi. */
function erreurLigne(i: number): string {
  const l = lignes.value[i];
  if (!l || l.valeur.trim() === "") return "";
  const o = origineDeSaisie(l.valeur);
  if (o === null) return erreurOrigine(l.valeur);
  const avant = lignes.value.slice(0, i).some((x) => origineDeSaisie(x.valeur) === o);
  return avant ? "Site déjà dans la liste." : "";
}
const aUneErreur = (): boolean => lignes.value.some((_, i) => erreurLigne(i) !== "");

function saisie(l: Ligne): void {
  l.note = "";
  publier();
}

/** URL complète : ramenée à son origine, avec une note si un chemin, une requête ou un fragment a été retiré. */
function normaliser(l: Ligne, brut = l.valeur): void {
  const t = brut.trim();
  const o = origineDeSaisie(t);
  if (o !== null && o !== t) {
    l.note = `Adresse réduite à son origine : ${o}`;
    l.valeur = o;
  } else l.valeur = t;
  publier();
}

function coller(e: ClipboardEvent, l: Ligne): void {
  const texte = e.clipboardData?.getData("text") ?? "";
  const el = e.target as HTMLInputElement;
  const toutRemplace = el.selectionStart === 0 && el.selectionEnd === el.value.length;
  if (!texte || origineDeSaisie(texte) === null || !(l.valeur === "" || toutRemplace)) return;
  e.preventDefault();
  normaliser(l, texte);
}

async function ajouter(): Promise<void> {
  if (lignes.value.length >= ORIGINES_SECRET_MAX) return;
  const l = nouvelle();
  lignes.value.push(l);
  await nextTick();
  champ(l.cle)?.focus();
}

async function retirer(i: number): Promise<void> {
  const l = lignes.value[i];
  if (!l) return;
  lignes.value.splice(i, 1);
  if (!lignes.value.length) lignes.value.push(nouvelle());
  publier();
  await nextTick();
  const voisine = lignes.value[Math.min(i, lignes.value.length - 1)];
  (voisine ? champ(voisine.cle) : null)?.focus();
}
</script>

<template>
  <div ref="racine" class="elpis-sites" role="group" :aria-labelledby="`${idBase}-titre`" data-sites>
    <span :id="`${idBase}-titre`" class="sr-only">Sites autorisés</span>
    <div v-for="(l, i) in lignes" :key="l.cle" class="elpis-sites__ligne">
      <div class="elpis-sites__rang">
        <input
          :id="`${idBase}-site-${l.cle}`"
          v-model="l.valeur"
          class="set-input font-mono"
          type="text"
          inputmode="url"
          autocomplete="off"
          spellcheck="false"
          placeholder="http://app.lan:8080"
          :aria-label="`Site ${i + 1}`"
          :aria-invalid="erreurLigne(i) ? 'true' : undefined"
          :aria-describedby="
            erreurLigne(i) ? `${idBase}-site-${l.cle}-e` : l.note ? `${idBase}-site-${l.cle}-n` : undefined
          "
          :data-site-cle="l.cle"
          data-champ="scope"
          @input="saisie(l)"
          @change="normaliser(l)"
          @paste="coller($event, l)"
        />
        <button
          type="button"
          class="adm-btn adm-btn--icon"
          :aria-label="`Retirer le site ${l.valeur.trim() || i + 1}`"
          title="Retirer ce site"
          :disabled="lignes.length === 1 && l.valeur === ''"
          data-retirer-site
          @click="retirer(i)"
        >
          <i class="ph ph-x" aria-hidden="true"></i>
        </button>
      </div>
      <p v-if="erreurLigne(i)" :id="`${idBase}-site-${l.cle}-e`" class="elpis-secret-form__err">
        {{ erreurLigne(i) }}
      </p>
      <p v-else-if="l.note" :id="`${idBase}-site-${l.cle}-n`" role="status" class="elpis-sites__note">
        {{ l.note }}
      </p>
    </div>
    <p v-if="erreur && !aUneErreur()" class="elpis-secret-form__err">{{ erreur }}</p>
    <div class="elpis-sites__pied">
      <button
        type="button"
        class="adm-btn adm-btn--quiet adm-btn--sm"
        :disabled="lignes.length >= ORIGINES_SECRET_MAX"
        data-ajouter-site
        @click="ajouter"
      >
        <i class="ph ph-plus" aria-hidden="true"></i> Ajouter un site
      </button>
      <span class="elpis-secrets__aide">
        {{
          lignes.length >= ORIGINES_SECRET_MAX
            ? `${ORIGINES_SECRET_MAX} sites au plus.`
            : "http et https acceptés ; une adresse complète est ramenée à son origine."
        }}
      </span>
    </div>
  </div>
</template>
