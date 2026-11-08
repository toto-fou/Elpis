<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/admin/ExportJournalModale.vue — Journaux › Sécurité : formulaire d'export (période, format) avant le téléchargement par la modale de transfert. -->
<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";

import { gardeFocus, piegerTab } from "../../utils/focus";

import { domaineAdmin } from "../../features/admin/domaine";
import { actionEffective } from "../../features/admin/journal-securite";

const adm = domaineAdmin();
const garde = gardeFocus();
const dialogue = ref<HTMLElement | null>(null);
/** Focus dans la modale à l'ouverture, rendu au bouton Exporter à la fermeture. */
watch(
  () => adm.secuExportOuvert,
  (ouvert) => {
    if (ouvert) {
      garde.remember();
      void nextTick(() => dialogue.value?.focus());
    } else void nextTick(() => garde.restore());
  },
);
function touche(ev: KeyboardEvent): void {
  piegerTab(ev, dialogue.value);
  if (ev.key === "Escape") adm.fermerExport();
}
const RESUME: [keyof typeof adm.secuFiltres, string][] = [
  ["compte", "compte"],
  ["ip", "IP"],
  ["service", "service"],
  ["resultat", "résultat"],
  ["texte", "texte"],
];
const filtres = computed(() => {
  const lus: string[] = [];
  const action = actionEffective(adm.secuFiltres);
  if (action) lus.push(`action « ${action} »`);
  for (const [cle, nom] of RESUME) if (adm.secuFiltres[cle]) lus.push(`${nom} « ${adm.secuFiltres[cle]} »`);
  return lus;
});
</script>

<template>
  <Transition name="modal">
    <div
      v-if="adm.secuExportOuvert"
      class="fixed inset-0 z-[6000] flex items-center justify-center bg-slate-900/80 p-4"
      @click.self="adm.fermerExport()"
    >
      <div
        ref="dialogue"
        class="sup-secu-modale"
        role="dialog"
        aria-modal="true"
        aria-labelledby="secu-export-titre"
        tabindex="-1"
        data-a11y-modal
        @keydown="touche"
      >
        <h3 id="secu-export-titre" class="sup-secu-modale__titre">
          <i class="ph ph-download-simple" aria-hidden="true"></i> Exporter le journal
        </h3>
        <div class="sup-secu-modale__periode">
          <label for="secu-export-du">Du</label>
          <input id="secu-export-du" v-model="adm.secuExportDu" type="date" class="set-input" />
          <label for="secu-export-au">au</label>
          <input id="secu-export-au" v-model="adm.secuExportAu" type="date" class="set-input" />
        </div>
        <p class="sup-secu-modale__resume">
          Filtres de la liste : {{ filtres.length ? filtres.join(", ") : "aucun" }}. Les marqueurs d'écriture
          sont toujours inclus dans le fichier.
        </p>
        <fieldset class="sup-secu-modale__choix">
          <legend class="sr-only">Format</legend>
          <label>
            <input v-model="adm.secuExportFormat" type="radio" name="secu-format" value="jsonl" />
            <span
              ><b>JSONL</b> · lignes brutes, signatures comprises
              <small
                >Reste vérifiable avec ./elpis audit verify. Pour une enquête ou le collecteur.</small
              ></span
            >
          </label>
          <label>
            <input v-model="adm.secuExportFormat" type="radio" name="secu-format" value="csv" />
            <span
              ><b>CSV</b> · pour un tableur
              <small>Formules neutralisées. Les signatures ne sont plus vérifiables.</small></span
            >
          </label>
        </fieldset>
        <p class="sup-secu-modale__note">
          <i class="ph ph-info" aria-hidden="true"></i> L'export est noté dans le journal
          (admin.audit.export). 366 jours au plus.
        </p>
        <p v-if="adm.secuExportErreur" class="sup-secu-modale__erreur" role="alert">
          {{ adm.secuExportErreur }}
        </p>
        <div class="flex justify-end gap-2">
          <button type="button" class="adm-btn adm-btn--quiet" @click="adm.fermerExport()">Annuler</button>
          <button type="button" class="adm-btn adm-btn--primary" @click="adm.lancerExport()">
            <i class="ph ph-download-simple" aria-hidden="true"></i> Exporter
          </button>
        </div>
      </div>
    </div>
  </Transition>
</template>
