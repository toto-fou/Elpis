<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/rag/ApercuDecoupage.vue — onglet « Aperçu du découpage » : nombre de passages, bande, avertissements, passages calculés et redécoupes empilées. -->
<script setup lang="ts">
import { computed, nextTick } from "vue";

import { debutDeRedecoupe, jetonsMax, largeurRelative } from "../../features/rag/decoupage";
import { focaliserId, montrerId } from "../../features/rag/dom";
import { domaineRag } from "../../features/rag/domaine";
import { formaterNombre } from "../../features/rag/format";
import BandePassages from "./BandePassages.vue";
import ChampsDecoupage from "./ChampsDecoupage.vue";
import LignePassage from "./LignePassage.vue";

const rg = domaineRag();
const plusLong = computed(() => jetonsMax(rg.decoupage.apercu.passages));

async function redecouper(position: number): Promise<void> {
  rg.decoupage.ouvrirRedecoupe(position);
  await nextTick();
  focaliserId("rag-redec-methode");
  montrerId("rag-redec");
}

async function valider(position: number): Promise<void> {
  if (!rg.decoupage.validerRedecoupe()) return;
  await nextTick();
  focaliserId(`rag-ap-${position}-redecouper`);
}

async function annuler(position: number): Promise<void> {
  rg.decoupage.fermerRedecoupe();
  await nextTick();
  focaliserId(`rag-ap-${position}-redecouper`);
}
</script>

<template>
  <div class="rag-apercu" data-rag-apercu>
    <div class="rag-apercu__head">
      <div class="rag-apercu__count" role="status">
        <b class="rag-num">{{ formaterNombre(rg.decoupage.apercu.total) }}</b>
        {{ rg.decoupage.apercu.total > 1 ? "passages" : "passage" }}
        <span v-if="rg.decoupage.apercuEnCours" class="rag-hint">
          <i class="ph ph-circle-notch animate-spin" aria-hidden="true"></i> Calcul…
        </span>
      </div>
      <span v-if="rg.decoupage.redecoupe" class="rag-badge" data-rag-modifie>Découpage modifié</span>
      <span class="rag-tools__grow"></span>
      <button
        v-if="rg.decoupage.redecoupe"
        type="button"
        class="rag-btn"
        @click="rg.decoupage.annulerRedecoupes()"
      >
        Annuler les redécoupes
      </button>
    </div>
    <BandePassages
      v-if="rg.decoupage.apercuCharge && rg.decoupage.apercu.total > 0"
      :passages="rg.decoupage.apercu.total"
      mode="prete"
    />
    <ul v-if="rg.decoupage.apercu.avertissements.length > 0" class="rag-warns" data-rag-avertissements>
      <li v-for="(a, i) in rg.decoupage.apercu.avertissements" :key="i">
        <i class="ph ph-warning" aria-hidden="true"></i><span>{{ a }}</span>
      </li>
    </ul>
    <p v-if="rg.decoupage.apercu.tronque" class="rag-note" data-rag-tronque>
      <i class="ph ph-info" aria-hidden="true"></i>Aperçu tronqué : les
      {{ formaterNombre(rg.decoupage.apercu.passages.length) }} premiers passages sur
      {{ formaterNombre(rg.decoupage.apercu.total) }}.
    </p>
    <p v-if="rg.decoupage.apercuErreur" class="rag-error" role="alert">
      <i class="ph ph-warning-circle" aria-hidden="true"></i><span>{{ rg.decoupage.apercuErreur }}</span>
    </p>
    <p v-else-if="!rg.decoupage.valide" class="rag-note">
      <i class="ph ph-info" aria-hidden="true"></i>Corrigez les valeurs à gauche pour recalculer l’aperçu.
    </p>
    <div class="rag-scroll">
      <ul
        class="rag-pas-list"
        aria-label="Passages calculés"
        :aria-busy="rg.decoupage.apercuEnCours ? 'true' : 'false'"
      >
        <LignePassage
          v-for="(p, i) in rg.decoupage.apercu.passages"
          :key="i"
          :passage="p"
          :numero="i + 1"
          :id-base="'rag-ap-' + i"
          :largeur="largeurRelative(p.jetons, plusLong)"
          :ouvert="rg.decoupage.depliesApercu.includes(i)"
          :redecoupable="p.redecoupe_de === null"
          :defaisable="debutDeRedecoupe(rg.decoupage.apercu.passages, i)"
          @basculer="rg.decoupage.basculerApercu(i)"
          @redecouper="redecouper(i)"
          @defaire="rg.decoupage.defaireRedecoupe(i)"
        >
          <div
            v-if="rg.decoupage.panneau && rg.decoupage.panneau.position === i"
            id="rag-redec"
            class="rag-redec"
            role="group"
            :aria-label="'Redécouper le passage ' + (i + 1)"
            data-rag-redecoupe
          >
            <ChampsDecoupage v-model="rg.decoupage.panneau.params" id-base="rag-redec" />
            <div class="rag-redec__acts">
              <button type="button" class="rag-btn" @click="annuler(i)">Annuler</button>
              <button
                type="button"
                class="rag-btn rag-btn--primary"
                :disabled="Object.keys(rg.decoupage.erreursPanneau).length > 0"
                @click="valider(i)"
              >
                Redécouper ce passage
              </button>
            </div>
          </div>
        </LignePassage>
      </ul>
      <p
        v-if="
          rg.decoupage.apercuCharge && !rg.decoupage.apercuErreur && rg.decoupage.apercu.passages.length === 0
        "
        class="rag-empty-docs"
      >
        Ce découpage ne donne aucun passage.
      </p>
      <p
        v-else-if="!rg.decoupage.apercuCharge && rg.decoupage.apercuEnCours"
        class="rag-empty-docs"
        role="status"
      >
        <i class="ph ph-circle-notch animate-spin" aria-hidden="true"></i> Calcul de l’aperçu…
      </p>
    </div>
  </div>
</template>
