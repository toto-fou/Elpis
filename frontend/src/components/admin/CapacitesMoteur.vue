<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/admin/CapacitesMoteur.vue — rapport de sonde d'un moteur (type déclaré, adresses, capacités détectées, conseils avec le drapeau exact). -->
<script setup lang="ts">
import type { RapportMoteur } from "@elpis/contracts";
import { computed } from "vue";

import { resumeCharge } from "../../features/chat/modeles/charge";

const props = defineProps<{ rapport: RapportMoteur | null; enCours?: boolean; testable?: boolean }>();
defineEmits<{ tester: [] }>();

const oui = (v: boolean | null): string => (v === null ? "—" : v ? "oui" : "non");
const entier = (n: number | null): string => (n === null ? "—" : n.toLocaleString("fr-FR"));

// Capacités affichées : une étiquette, une valeur, un état (bon, absent, sans objet).
const lignes = computed(() => {
  const r = props.rapport;
  if (!r || !r.joignable) return [];
  const sorties: { cle: string; libelle: string; valeur: string; etat: "ok" | "manque" | "neutre" }[] = [
    {
      cle: "modele",
      libelle: "Modèle servi",
      valeur: r.modele_servi ?? "aucun",
      etat: r.modele_servi ? "ok" : "manque",
    },
    {
      cle: "contexte",
      libelle: "Contexte",
      valeur: r.contexte ? `${entier(r.contexte)} jetons` : "inconnu",
      etat: r.contexte ? "ok" : "manque",
    },
    {
      cle: "metriques",
      libelle: "Métriques",
      valeur: oui(r.metriques),
      etat: r.metriques === null ? "neutre" : r.metriques ? "ok" : "manque",
    },
    {
      cle: "tokenisation",
      libelle: "Jetons exacts",
      valeur: oui(r.tokenisation),
      etat: r.tokenisation === null ? "neutre" : r.tokenisation ? "ok" : "manque",
    },
    {
      cle: "cache",
      libelle: "Jetons en cache",
      valeur: r.jetons_en_cache === null ? "non vérifié" : oui(r.jetons_en_cache),
      etat: r.jetons_en_cache === null ? "neutre" : r.jetons_en_cache ? "ok" : "manque",
    },
    {
      cle: "concurrence",
      libelle: "Concurrence",
      valeur:
        r.concurrence.mode === "moteur"
          ? `par le moteur${r.concurrence.max ? ` (${r.concurrence.max})` : ""}`
          : `file d'Elpis${r.concurrence.max ? ` (${r.concurrence.max} créneaux)` : ""}`,
      etat: "neutre",
    },
    {
      cle: "chargement",
      libelle: "Chargement",
      valeur: r.chargement ? "à la demande" : "au lancement",
      etat: "neutre",
    },
    { cle: "cle", libelle: "Clé d'API", valeur: r.cle_api ? "envoyée" : "aucune", etat: "neutre" },
  ];
  if (r.parseurs_connus) {
    sorties.push(
      {
        cle: "reflexion",
        libelle: "Réflexion",
        valeur: r.parseur_reflexion ?? "sans parseur",
        etat: r.parseur_reflexion ? "ok" : "manque",
      },
      {
        cle: "outils",
        libelle: "Outils",
        valeur: r.parseur_outils ?? "sans parseur",
        etat: r.parseur_outils ? "ok" : "manque",
      },
    );
  }
  return sorties;
});

const titre = computed(() =>
  props.rapport ? [props.rapport.libelle, props.rapport.version ?? ""].filter((t) => t).join(" ") : "",
);

const charge = computed(() => {
  const c = props.rapport?.charge;
  if (!c) return "";
  const kv = c.kv ? `cache KV ${c.kv.pct.toLocaleString("fr-FR")} %` : "";
  return [kv, resumeCharge(c)].filter((t) => t).join(" · ");
});
</script>

<template>
  <div class="space-y-2 min-w-0" data-capacites-moteur>
    <div class="flex items-center gap-2 flex-wrap">
      <span
        v-if="rapport"
        class="adm-pill"
        :class="rapport.joignable ? 'text-emerald-700' : 'adm-pill--warn'"
        data-etat-moteur
      >
        <i
          class="ph"
          :class="rapport.joignable ? 'ph-check-circle' : 'ph-warning-circle'"
          aria-hidden="true"
        ></i>
        {{ rapport.joignable ? "Joignable" : "Injoignable" }}
      </span>
      <span v-if="rapport" class="text-sm font-medium text-slate-800">{{ titre }}</span>
      <span v-if="rapport" class="text-[11px] text-slate-500 font-mono truncate min-w-0">{{
        rapport.base_url
      }}</span>
      <span v-if="!rapport && !enCours" class="text-xs text-slate-500">Pas encore sondé.</span>
      <button
        v-if="testable"
        type="button"
        class="adm-btn adm-tool adm-btn--sm ml-auto"
        :disabled="enCours"
        title="Interroge chaque adresse du moteur déclaré, dont une réponse d'un jeton"
        data-tester-moteur
        @click="$emit('tester')"
      >
        <i class="ph ph-pulse" :class="enCours ? 'animate-pulse' : ''" aria-hidden="true"></i>
        {{ enCours ? "Test en cours…" : "Tester" }}
      </button>
    </div>

    <dl v-if="lignes.length" class="grid grid-cols-2 sm:grid-cols-4 gap-2">
      <div
        v-for="l in lignes"
        :key="l.cle"
        class="rounded-lg border border-slate-200 px-2.5 py-1.5 min-w-0"
        :data-capacite="l.cle"
      >
        <dt class="text-[10px] text-slate-500">{{ l.libelle }}</dt>
        <dd
          class="text-xs font-medium truncate"
          :class="
            l.etat === 'manque' ? 'text-amber-700' : l.etat === 'ok' ? 'text-slate-800' : 'text-slate-600'
          "
          :title="l.valeur"
        >
          {{ l.valeur }}
        </dd>
      </div>
    </dl>

    <p v-if="charge" class="text-[11px] text-slate-500 font-mono" data-charge-sonde>{{ charge }}</p>

    <ul v-if="rapport && rapport.conseils.length" class="space-y-1" data-conseils-moteur>
      <li
        v-for="(c, i) in rapport.conseils"
        :key="c.code + i"
        class="flex items-start gap-1.5 text-xs"
        :class="
          c.niveau === 'erreur'
            ? 'text-red-600'
            : c.niveau === 'avertissement'
              ? 'text-amber-700'
              : 'text-slate-600'
        "
        :data-conseil="c.code"
      >
        <i
          class="ph mt-0.5 shrink-0"
          :class="
            c.niveau === 'erreur' ? 'ph-x-circle' : c.niveau === 'avertissement' ? 'ph-warning' : 'ph-info'
          "
          aria-hidden="true"
        ></i>
        <span class="min-w-0 break-words">{{ c.message }}</span>
      </li>
    </ul>

    <details v-if="rapport && rapport.adresses.length" class="adm-details">
      <summary>Adresses sondées</summary>
      <ul class="mt-1 space-y-0.5 text-[11px] font-mono">
        <li v-for="a in rapport.adresses" :key="a.role + a.chemin" class="flex items-center gap-2">
          <span :class="a.ok ? 'text-emerald-700' : 'text-red-600'">{{ a.ok ? "✓" : "✗" }}</span>
          <span class="text-slate-700">{{ a.chemin }}</span>
          <span class="text-slate-500">{{ a.role }}</span>
          <span class="text-slate-500 ml-auto">{{ a.statut ? "HTTP " + a.statut : "sans réponse" }}</span>
        </li>
      </ul>
    </details>
  </div>
</template>
