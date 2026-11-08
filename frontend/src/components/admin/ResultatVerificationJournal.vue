<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/admin/ResultatVerificationJournal.vue — Journaux › Sécurité : résultat de « Vérifier l'intégrité » (en cours, intact, anomalies, non vérifié, vide, ou refus). -->
<script setup lang="ts">
import { computed, nextTick } from "vue";

import { domaineAdmin } from "../../features/admin/domaine";
import { pluriel } from "../../features/admin/formats";
import {
  anomaliesBornees,
  motifsNonVerifie,
  textePeriode,
} from "../../features/admin/journal-securite-affichage";

const adm = domaineAdmin();
const v = computed(() => adm.secuVerification);
const res = computed(() => (v.value?.statut === "resultat" ? v.value : null));
const periode = computed(() => (res.value ? textePeriode(res.value.du, res.value.au) : ""));
const bornees = computed(() =>
  res.value ? anomaliesBornees(res.value.resultat) : { lignes: [], autres: 0 },
);
const anomalies = computed(() => bornees.value.lignes);
const nonListees = computed(() => bornees.value.autres);
/** « Vérifier » reprend le focus quand le résultat est fermé. */
function fermer(): void {
  adm.fermerVerification();
  void nextTick(() => globalThis.document.getElementById("secu-verifier")?.focus());
}
const motifs = computed(() => (res.value ? motifsNonVerifie(res.value.resultat) : []));

/** Tuiles de chiffres du résultat ; celles à zéro n'apparaissent pas, sauf les trois premières. */
const tuiles = computed(() => {
  const r = res.value?.resultat;
  if (!r) return [];
  const t = r.totals;
  const liste: { libelle: string; valeur: number; teinte?: "warn" | "danger"; visible?: boolean }[] = [
    { libelle: "Fichiers", valeur: r.files },
    { libelle: "Lignes", valeur: r.lines },
    { libelle: "Signées et valides", valeur: r.valid },
    {
      libelle: "Non signées",
      valeur: r.unsigned,
      teinte: "warn",
      visible: r.status === "non_verifie" || r.unsigned > 0,
    },
    { libelle: "Clé inconnue", valeur: r.unknown_key, teinte: "warn", visible: r.unknown_key > 0 },
    {
      libelle: "Signatures invalides",
      valeur: t.invalid_signatures,
      teinte: "danger",
      visible: t.invalid_signatures > 0,
    },
    { libelle: "Trous", valeur: t.gaps, teinte: "danger", visible: t.gaps > 0 },
    { libelle: "Illisibles", valeur: t.unreadable, teinte: "danger", visible: t.unreadable > 0 },
    { libelle: "Lignes v0 tardives", valeur: t.late_v0, teinte: "danger", visible: t.late_v0 > 0 },
    {
      libelle: "Fins incertaines",
      valeur: r.uncertain_ends.length,
      teinte: "warn",
      visible: r.uncertain_ends.length > 0,
    },
  ];
  return liste.filter((x) => x.visible ?? true);
});

const ICONES: Record<string, string> = {
  intact: "ph-seal-check",
  anomalies: "ph-seal-warning",
  non_verifie: "ph-seal-question",
  vide: "ph-tray",
};
const TITRES: Record<string, string> = {
  intact: "Intact",
  anomalies: "Anomalies",
  non_verifie: "Non vérifié",
  vide: "Vide",
};
</script>

<template>
  <section
    v-if="v"
    class="adm-card sup-secu-verif"
    :data-statut="v.statut === 'resultat' ? v.resultat.status : v.statut"
    :aria-busy="v.statut === 'en_cours' ? 'true' : 'false'"
  >
    <header
      class="adm-card__head"
      :role="v.statut === 'resultat' && v.resultat.status === 'anomalies' ? 'alert' : 'status'"
    >
      <i
        class="ph sup-secu-verif__icone"
        :class="
          v.statut === 'en_cours'
            ? 'ph-spinner-gap animate-spin'
            : v.statut === 'erreur'
              ? 'ph-warning-circle'
              : ICONES[v.resultat.status]
        "
        aria-hidden="true"
      ></i>
      <div>
        <h3 class="adm-card__title">
          <template v-if="v.statut === 'en_cours'">Vérification en cours…</template>
          <template v-else-if="v.statut === 'erreur'">Vérification impossible</template>
          <template v-else>{{ TITRES[v.resultat.status] }}</template>
        </h3>
        <p class="adm-card__hint sup-hint-large">
          <template v-if="v.statut === 'en_cours'">
            Lecture et contrôle des signatures de la période, fichier par fichier.
          </template>
          <template v-else-if="v.statut === 'erreur'">{{ v.message }}</template>
          <template v-else-if="v.resultat.status === 'intact'">
            Toutes les lignes {{ periode }} sont signées avec une clé connue et valides. Aucun trou dans la
            numérotation.
          </template>
          <template v-else-if="v.resultat.status === 'vide'">
            Aucune ligne {{ periode }}. Rien à vérifier.
          </template>
          <template v-else-if="v.resultat.status === 'non_verifie'">
            Aucune anomalie, mais l'intégrité des lignes {{ periode }} n'est pas établie.
          </template>
          <template v-else>
            Des lignes {{ periode }} ont été modifiées, supprimées ou sont illisibles. Gardez l'export JSONL
            et comparez avec la copie du collecteur.
          </template>
        </p>
      </div>
      <div v-if="v.statut !== 'en_cours'" class="adm-card__actions">
        <button type="button" class="adm-btn adm-btn--quiet adm-btn--sm" @click="adm.verifierIntegrite()">
          <i class="ph ph-arrows-clockwise" aria-hidden="true"></i> Relancer
        </button>
        <button
          type="button"
          class="adm-btn adm-btn--icon"
          aria-label="Fermer le résultat"
          title="Fermer"
          @click="fermer()"
        >
          <i class="ph ph-x" aria-hidden="true"></i>
        </button>
      </div>
    </header>

    <template v-if="res && res.resultat.status !== 'vide'">
      <div class="sup-secu-verif__chiffres">
        <div
          v-for="t in tuiles"
          :key="t.libelle"
          class="adm-stat"
          :class="t.teinte ? 'adm-stat--' + t.teinte : ''"
        >
          <div class="adm-stat__label">{{ t.libelle }}</div>
          <div class="adm-stat__value tabular-nums">{{ t.valeur }}</div>
        </div>
        <div class="adm-stat">
          <div class="adm-stat__label">Écrivains</div>
          <div class="adm-stat__value tabular-nums">
            {{ res.resultat.writers
            }}<span v-if="res.resultat.writers_without_stop" class="text-xs font-normal adm-muted">
              , dont {{ pluriel(res.resultat.writers_without_stop, "arrêt") }} brutal{{
                res.resultat.writers_without_stop > 1 ? "s" : ""
              }}</span
            >
          </div>
        </div>
      </div>
      <ul v-if="res.resultat.status === 'non_verifie' && motifs.length" class="sup-secu-verif__liste">
        <li v-for="(m, i) in motifs" :key="'m' + i">
          <span class="sup-secu-verif__type">Non établi</span><span>{{ m }}</span>
        </li>
      </ul>
      <ul v-if="anomalies.length || nonListees > 0" class="sup-secu-verif__liste">
        <li v-for="(a, i) in anomalies" :key="'a' + i">
          <span class="sup-secu-verif__type">{{ a.type }}</span
          ><span>{{ a.texte }}</span>
        </li>
        <li v-if="nonListees > 0">
          <span class="sup-secu-verif__type">Et d'autres</span>
          <span
            >et {{ nonListees }} autres lignes en cause, non affichées (20 par catégorie, 200 au plus).</span
          >
        </li>
      </ul>
      <p
        v-if="res.resultat.status === 'anomalies' || res.resultat.status === 'intact'"
        class="sup-secu-verif__note"
      >
        La vérification locale ne protège pas contre qui contrôle le compte de service. La preuve reste la
        copie du collecteur, à vérifier avec <code class="sup-mono">./elpis audit verify</code>.
      </p>
    </template>
  </section>
</template>
