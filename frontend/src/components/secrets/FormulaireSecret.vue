<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/secrets/FormulaireSecret.vue — formulaire d'un secret (création ou modification) : name en slug vérifié à la frappe, type, scope (une origine par ligne), user, valeur en écriture seule, tls, politique. -->
<script setup lang="ts">
import { computed, ref, useId } from "vue";

import { GENRES_CREABLES, parOrigines, verdictFormulaire } from "../../features/secrets/format";
import { domaineSecrets } from "../../features/secrets/gestion";

const props = defineProps<{ mode: "creation" | "edition" }>();
const g = domaineSecrets();
const id = useId();
const f = computed(() => (props.mode === "creation" ? g.creation : g.edition));
const verdict = computed(() => (f.value ? verdictFormulaire(f.value) : null));
const tente = ref(false);
const cible = computed(() => (props.mode === "creation" ? "nouveau" : (f.value?.id ?? null)));
const refus = computed(() => (g.erreur && g.erreur.cible === cible.value ? g.erreur.message : ""));

// Slug, origines et valeur exigée par un élargissement se signalent à la frappe ; un champ vide, à l'envoi.
function erreur(champ: "name" | "origins" | "username" | "value"): string {
  const e = verdict.value?.erreurs[champ];
  if (!e || !f.value) return "";
  const vif: Record<typeof champ, boolean> = {
    name: f.value.name !== "",
    origins: f.value.origins.trim() !== "",
    username: true,
    value: f.value.value !== "" || !!verdict.value?.valeurExigee,
  };
  return tente.value || vif[champ] ? e : "";
}

async function envoyer(): Promise<void> {
  tente.value = true;
  if (await g.enregistrer(f.value)) tente.value = false;
}

function annuler(): void {
  if (props.mode === "creation") g.annulerCreation();
  else g.fermerPanneau();
}
</script>

<template>
  <form
    v-if="f"
    class="elpis-secret-form"
    :aria-label="mode === 'creation' ? 'Nouveau secret' : `Modifier ${f.avant?.name ?? ''}`"
    novalidate
    data-formulaire-secret
    @submit.prevent="envoyer"
  >
    <div class="elpis-secret-form__grille">
      <label :for="`${id}-name`">name</label>
      <div>
        <input
          :id="`${id}-name`"
          v-model.trim="f.name"
          class="set-input font-mono"
          maxlength="48"
          autocomplete="off"
          spellcheck="false"
          placeholder="intranet-admin"
          :aria-invalid="erreur('name') ? 'true' : undefined"
          :aria-describedby="erreur('name') ? `${id}-name-e` : undefined"
          data-champ="name"
        />
        <p v-if="erreur('name')" :id="`${id}-name-e`" class="elpis-secret-form__err font-mono">
          {{ erreur("name") }}
        </p>
      </div>

      <label :for="`${id}-kind`">type</label>
      <select
        :id="`${id}-kind`"
        v-model="f.kind"
        class="set-select font-mono"
        :disabled="mode === 'edition'"
        data-champ="kind"
      >
        <option v-for="k in GENRES_CREABLES" :key="k" :value="k">{{ k }}</option>
      </select>

      <template v-if="parOrigines(f.kind)">
        <label :for="`${id}-scope`" title="Origines exactes : scheme://hôte[:port], une par ligne"
          >scope</label
        >
        <div>
          <textarea
            :id="`${id}-scope`"
            v-model="f.origins"
            class="set-textarea font-mono"
            rows="2"
            spellcheck="false"
            placeholder="https://intranet.example.lan:8443"
            title="Origines exactes : scheme://hôte[:port], une par ligne"
            :aria-invalid="erreur('origins') ? 'true' : undefined"
            :aria-describedby="erreur('origins') ? `${id}-scope-e` : undefined"
            data-champ="scope"
          ></textarea>
          <p v-if="erreur('origins')" :id="`${id}-scope-e`" class="elpis-secret-form__err">
            {{ erreur("origins") }}
          </p>
        </div>
      </template>

      <label :for="`${id}-user`">user</label>
      <div>
        <input
          :id="`${id}-user`"
          v-model="f.username"
          class="set-input font-mono"
          autocomplete="off"
          spellcheck="false"
          :aria-invalid="erreur('username') ? 'true' : undefined"
          data-champ="user"
        />
        <p v-if="erreur('username')" class="elpis-secret-form__err">{{ erreur("username") }}</p>
      </div>

      <label :for="`${id}-value`">valeur</label>
      <div>
        <input
          :id="`${id}-value`"
          v-model="f.value"
          type="password"
          class="set-input font-mono"
          autocomplete="new-password"
          spellcheck="false"
          :placeholder="mode === 'edition' ? 'inchangée' : ''"
          :title="mode === 'edition' ? 'Vide : valeur inchangée' : 'Écriture seule'"
          :aria-invalid="erreur('value') ? 'true' : undefined"
          :aria-describedby="erreur('value') ? `${id}-value-e` : undefined"
          data-champ="value"
        />
        <p v-if="erreur('value')" :id="`${id}-value-e`" class="elpis-secret-form__err">
          {{ erreur("value") }}
        </p>
      </div>

      <template v-if="parOrigines(f.kind)">
        <label :for="`${id}-tls`">tls</label>
        <select :id="`${id}-tls`" v-model="f.tls" class="set-select font-mono" data-champ="tls">
          <option value="strict">strict</option>
          <option value="insecure">insecure</option>
        </select>
      </template>

      <span :id="`${id}-pol`">politique</span>
      <div class="elpis-secret-form__politique" role="group" :aria-labelledby="`${id}-pol`">
        <label title="Les sous-agents de la conversation peuvent l'utiliser">
          <input v-model="f.subagents" type="checkbox" data-champ="subagents" /> sous-agents
        </label>
        <label title="Les routines peuvent l'utiliser">
          <input v-model="f.routines" type="checkbox" data-champ="routines" /> routines
        </label>
      </div>
    </div>

    <p v-if="refus" role="alert" class="elpis-secret-form__refus">{{ refus }}</p>
    <div class="elpis-secret-form__actions">
      <button type="submit" class="adm-btn adm-btn--primary adm-btn--sm" :disabled="g.occupe">
        {{ mode === "creation" ? "Créer" : "Enregistrer" }}
      </button>
      <button type="button" class="adm-btn adm-btn--quiet adm-btn--sm" @click="annuler">Annuler</button>
    </div>
  </form>
</template>
