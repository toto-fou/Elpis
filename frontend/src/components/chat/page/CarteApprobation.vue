<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/chat/page/CarteApprobation.vue — carte « Confirmer » au-dessus du composeur : le geste sensible d'une procédure attend l'accord du compte (Approuver / Refuser), jamais celui du modèle. -->
<script setup lang="ts">
import { computed, inject } from "vue";

import { CLE_APPROBATIONS } from "../../../app/racine/domaine";

// Fournie par la racine du chat ; absente, la carte reste muette.
const a = inject(CLE_APPROBATIONS, null);
const visibles = computed(() => (a ? a.accords.filter((d) => d.expires_at * 1000 > Date.now()) : []));
// Caractères invisibles (bidi, largeur nulle…) rendus visibles : le texte affiché est celui qui sera joué.
const visible = (t: string): string =>
  t.replace(/\p{Cf}/gu, (c) => `⟦U+${c.codePointAt(0)?.toString(16).toUpperCase().padStart(4, "0")}⟧`);
const lisible = (d: { gesture: { act: string } }): boolean => d.gesture.act !== "";
const annonce = computed(() => (visibles.value.length ? "Un geste attend votre accord." : ""));
</script>

<template>
  <div class="sr-only" role="status" aria-live="assertive">{{ annonce }}</div>
  <section
    v-for="d in visibles"
    :key="d.id"
    class="elpis-accord"
    role="group"
    :aria-label="`Confirmer : ${d.gesture.act}`"
    data-accord
  >
    <header class="elpis-accord-tete">
      <span class="elpis-accord-icone"><i class="ph ph-shield-check" aria-hidden="true"></i></span>
      <div class="elpis-accord-titre">
        <strong>Confirmer</strong>
        <span title="Procédure et version">{{ d.procedure_id }} v{{ d.version }}</span>
      </div>
      <span class="elpis-accord-delai" title="Délai avant expiration">{{ a?.accordRestant(d) }}</span>
    </header>
    <p v-if="d.once" class="elpis-accord-once">
      <i class="ph ph-wrench" aria-hidden="true"></i>
      {{ d.repaired ? "Première exécution d'un geste réparé" : "Première exécution de ce geste" }}
    </p>
    <p v-if="!lisible(d)" class="elpis-accord-once">
      <i class="ph ph-warning" aria-hidden="true"></i>
      Geste illisible : approbation impossible.
    </p>
    <p v-if="!lisible(d)" class="elpis-accord-code">{{ visible(d.description) }}</p>
    <dl v-else class="elpis-accord-lignes">
      <div>
        <dt>Geste</dt>
        <dd>{{ d.gesture.act }}</dd>
      </div>
      <div v-if="d.gesture.targets.length">
        <dt>Cible</dt>
        <dd>
          <span v-for="(t, i) in d.gesture.targets" :key="i" class="elpis-accord-code">{{ visible(t) }}</span>
        </dd>
      </div>
      <div v-if="d.gesture.url">
        <dt>Adresse</dt>
        <dd class="elpis-accord-code">{{ visible(d.gesture.url) }}</dd>
      </div>
      <div v-if="d.gesture.value">
        <dt>Valeur</dt>
        <dd class="elpis-accord-code">{{ visible(d.gesture.value) }}</dd>
      </div>
      <div v-if="d.page">
        <dt>Page</dt>
        <dd class="elpis-accord-code">{{ visible(d.page) }}</dd>
      </div>
    </dl>
    <footer class="elpis-accord-pied">
      <button
        type="button"
        class="elpis-ask-btn elpis-ask-btn-g"
        :disabled="a?.accordsOccupe !== null"
        title="Le geste ne sera pas joué"
        @click="a?.decider(d, 'refuse')"
      >
        <i class="ph ph-x" aria-hidden="true"></i>
        Refuser
      </button>
      <button
        type="button"
        class="elpis-ask-btn elpis-ask-btn-p"
        :disabled="a?.accordsOccupe !== null || !lisible(d)"
        title="Le geste sera joué une fois, tel qu'affiché"
        @click="a?.decider(d, 'approve')"
      >
        <i class="ph ph-check" aria-hidden="true"></i>
        Approuver
      </button>
    </footer>
  </section>
</template>
