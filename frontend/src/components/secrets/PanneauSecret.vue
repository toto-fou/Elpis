<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/secrets/PanneauSecret.vue — ce qui s'ouvre sous un secret : rotation (nouvelle valeur en écriture seule), vérification (portée à relire), modification, et le refus du serveur. -->
<script setup lang="ts">
import type { Secret } from "@elpis/contracts";
import { computed } from "vue";

import { porteeTexte } from "../../features/secrets/format";
import { domaineSecrets } from "../../features/secrets/gestion";
import ChampValeur from "./ChampValeur.vue";
import FormulaireSecret from "./FormulaireSecret.vue";

const props = defineProps<{ secret: Secret }>();
const g = domaineSecrets();
const s = computed(() => props.secret);
</script>

<template>
  <!-- eslint-disable vue/multiline-html-element-content-newline -->
  <form
    v-if="g.panneau?.id === s.id && g.panneau.mode === 'rotation'"
    class="elpis-secrets__ligne"
    :aria-label="`Rotation de ${s.name}`"
    @submit.prevent="g.tourner(s.id)"
  >
    <label :for="`secret-rot-${s.id}`" class="elpis-secrets__etiq">Nouvelle valeur</label>
    <ChampValeur
      :id="`secret-rot-${s.id}`"
      v-model="g.valeurRotation"
      class="set-input font-mono elpis-secrets__champ"
    />
    <span class="elpis-secrets__aide">version {{ s.version }} → {{ s.version + 1 }}</span>
    <button
      type="submit"
      class="adm-btn adm-btn--primary adm-btn--sm"
      :disabled="!g.valeurRotation || g.occupe"
    >
      Rotation
    </button>
    <button type="button" class="adm-btn adm-btn--quiet adm-btn--sm" @click="g.fermerPanneau()">
      Annuler
    </button>
  </form>

  <div v-else-if="g.panneau?.id === s.id && g.panneau.mode === 'verifier'">
    <dl class="elpis-secrets__dl">
      <dt>Utilisé pour</dt>
      <dd class="font-mono">
        <ul class="elpis-secrets__sites" :aria-label="`Sites de ${s.name}`">
          <li v-for="o in porteeTexte(s)" :key="o" class="elpis-secrets__site">{{ o }}</li>
        </ul>
      </dd>
      <dt>Identifiant</dt>
      <dd class="font-mono">{{ s.username ?? "—" }}</dd>
      <dt>TLS</dt>
      <dd class="font-mono">{{ s.policy.tls }}</dd>
    </dl>
    <div class="elpis-secrets__ligne">
      <button
        type="button"
        class="adm-btn adm-btn--primary adm-btn--sm"
        :disabled="g.occupe"
        @click="g.verifier(s.id)"
      >
        Vérifier
      </button>
      <button
        v-if="g.droits(s).modification"
        type="button"
        class="adm-btn adm-tool adm-btn--sm"
        @click="g.choisir(s.id, 'modifier')"
      >
        Modifier le scope
      </button>
      <button
        v-else-if="g.droits(s).gere"
        type="button"
        class="adm-btn adm-tool adm-btn--sm"
        @click="g.choisir(s.id, 'gerer')"
      >
        {{ g.droits(s).gere?.libelle }}
      </button>
      <button type="button" class="adm-btn adm-btn--quiet adm-btn--sm" @click="g.fermerPanneau()">
        Annuler
      </button>
      <span class="elpis-secrets__aide">unverified → active ; élargir le scope exige la valeur.</span>
    </div>
  </div>

  <FormulaireSecret v-else-if="g.panneau?.id === s.id && g.panneau.mode === 'modifier'" mode="edition" />

  <p
    v-if="g.erreur?.cible === s.id && g.panneau?.mode !== 'modifier'"
    role="alert"
    class="elpis-secrets__refus"
  >
    {{ g.erreur.message }}
  </p>
</template>
