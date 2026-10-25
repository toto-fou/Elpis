<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/reglages/ApercuSkin.vue — modale d'aperçu d'un habillage (chat et Paramètres) : maquette du skill apparence dans des iframes isolées clair/sombre, contrastes et listes rendus par l'application, import par clic. -->
<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";

import { ouvrirApercu } from "../../features/chat/rendu/apercu";
import {
  apercuSkin,
  composerApercu,
  fermerApercuSkin,
  importerSkin,
  libelleImport,
  lireArtefactApercu,
} from "../../features/reglages/skins-perso";

const etat = apercuSkin;
const maquette = ref<string | null>(null);
const retour = ref("");
const existe = ref(false);
const appliquerDemande = ref(false);
const cadres: (HTMLIFrameElement | null)[] = [];
let annulations: (() => void)[] = [];

const vues = computed(() =>
  etat.value?.darkBase
    ? [{ titre: "Aperçu", sombre: false }]
    : [
        { titre: "Clair", sombre: false },
        { titre: "Sombre", sombre: true },
      ],
);
const problemes = computed(() => etat.value?.rapport?.erreurs.length ?? 0);

function arreter(): void {
  for (const a of annulations) a();
  annulations = [];
}

watch(
  etat,
  async (e) => {
    arreter();
    retour.value = "";
    existe.value = false;
    maquette.value = null;
    if (!e || !e.css) return;
    const modele = await lireArtefactApercu();
    if (etat.value !== e) return;
    maquette.value = modele;
    await nextTick();
    if (etat.value !== e || !modele) return;
    vues.value.forEach((v, i) => {
      const cadre = cadres[i];
      if (cadre) annulations.push(ouvrirApercu(cadre, composerApercu(modele, e.css, v.sombre)));
    });
  },
  { immediate: true },
);
onBeforeUnmount(arreter);

async function importer(overwrite: boolean, appliquer: boolean): Promise<void> {
  const e = etat.value;
  if (!e?.corps) return;
  retour.value = "Import en cours…";
  appliquerDemande.value = appliquer;
  const r = await importerSkin(e.corps, { overwrite, appliquer });
  retour.value = libelleImport(r);
  existe.value = r.type === "existe";
}
</script>

<template>
  <!-- z-[6000] : au-dessus de la modale Paramètres (z-[5000]) ; fermée par Échap (cascade du clavier global). -->
  <div
    v-if="etat"
    role="dialog"
    aria-modal="true"
    data-apercu-skin
    :aria-label="'Aperçu de l\'habillage ' + etat.nom"
    class="fixed inset-0 z-[6000] flex items-center justify-center bg-slate-900/80 p-4"
    @click.self="fermerApercuSkin()"
  >
    <div class="bg-white rounded-xl shadow-xl w-full max-w-4xl max-h-[92vh] overflow-y-auto p-5 space-y-3">
      <div class="flex items-center gap-2">
        <span class="inline-flex gap-0.5">
          <span
            v-for="(c, i) in etat.pastilles"
            :key="i"
            class="w-4 h-4 rounded-full border border-slate-300 inline-block"
            :style="{ backgroundColor: c }"
          ></span>
        </span>
        <h3 class="font-semibold text-slate-900 text-sm flex-1">Aperçu : {{ etat.nom }}</h3>
        <button type="button" class="skl-btn skl-btn--ghost" @click="fermerApercuSkin()">Fermer</button>
      </div>

      <div v-if="maquette && etat.css" class="grid gap-3" :class="vues.length > 1 ? 'md:grid-cols-2' : ''">
        <div v-for="(v, i) in vues" :key="v.titre">
          <div class="text-xs font-medium text-slate-500 mb-1">{{ v.titre }}</div>
          <iframe
            :ref="(el) => (cadres[i] = el as HTMLIFrameElement | null)"
            class="w-full h-80 rounded-lg border border-slate-200 bg-white"
            :title="'Aperçu ' + v.titre.toLowerCase()"
          ></iframe>
        </div>
      </div>
      <p v-else class="text-xs text-slate-500">
        {{
          etat.css
            ? "Maquette d'aperçu introuvable : pastilles et rapport seulement."
            : "Aucune feuille générée tant que des erreurs de structure subsistent."
        }}
      </p>

      <template v-if="etat.rapport">
        <ul v-if="etat.rapport.erreurs.length" class="list-disc pl-5 text-xs space-y-0.5 text-red-600">
          <li v-for="(t, i) in etat.rapport.erreurs" :key="'e' + i">{{ t }}</li>
        </ul>
        <ul
          v-if="etat.rapport.avertissements.length"
          class="list-disc pl-5 text-xs space-y-0.5 text-amber-600"
        >
          <li v-for="(t, i) in etat.rapport.avertissements" :key="'a' + i">{{ t }}</li>
        </ul>
        <table v-if="etat.rapport.contrastes.length" class="w-full text-xs border-collapse">
          <thead>
            <tr class="text-left text-slate-500">
              <th class="py-1 pr-2 font-medium">Paire</th>
              <th class="py-1 pr-2 font-medium">Mode</th>
              <th class="py-1 pr-2 font-medium">Rapport</th>
              <th class="py-1 font-medium">Seuil</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="(c, i) in etat.rapport.contrastes"
              :key="i"
              class="border-t border-slate-100"
              :class="c.ok ? 'text-slate-700' : 'text-red-600 font-medium'"
            >
              <td class="py-0.5 pr-2">{{ c.paire }}</td>
              <td class="py-0.5 pr-2">{{ c.mode === "light" ? "clair" : "sombre" }}</td>
              <td class="py-0.5 pr-2">{{ c.ratio }}:1 {{ c.ok ? "✓" : "✗" }}</td>
              <td class="py-0.5">{{ c.seuil }}:1</td>
            </tr>
          </tbody>
        </table>
      </template>

      <div v-if="etat.corps" class="flex items-center justify-end gap-2 flex-wrap pt-1">
        <span v-if="retour" class="text-xs text-slate-600 mr-auto" role="status">{{ retour }}</span>
        <button
          v-if="existe"
          type="button"
          class="skl-btn skl-btn--secondary"
          @click="importer(true, appliquerDemande)"
        >
          Remplacer l'existant
        </button>
        <button
          type="button"
          class="skl-btn skl-btn--secondary"
          :disabled="problemes > 0"
          @click="importer(false, false)"
        >
          Importer
        </button>
        <button
          type="button"
          class="skl-btn bg-blue-600 text-white hover:bg-blue-700"
          :disabled="problemes > 0"
          @click="importer(false, true)"
        >
          Importer et appliquer
        </button>
      </div>
    </div>
  </div>
</template>
