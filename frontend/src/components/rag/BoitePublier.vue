<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/rag/BoitePublier.vue — boîte « Publier » : Privée, Groupes (pastilles avec effectifs), Tous les comptes (administrateur), ouverture des documents sources, comptes concernés. -->
<script setup lang="ts">
import { domaineRag } from "../../features/rag/domaine";

const rg = domaineRag();
</script>

<template>
  <Teleport to="body">
    <div
      v-if="rg.publier.ouvert && rg.courante"
      class="rag-veil bg-slate-900/80"
      data-a11y-modal
      data-rag-dialog="publier"
      @click.self="rg.publier.fermer()"
    >
      <div
        class="rag-dialog shadow-2xl"
        role="dialog"
        aria-modal="true"
        aria-labelledby="rag-pub-titre"
        aria-describedby="rag-pub-sous"
      >
        <div class="rag-dialog__head">
          <div class="rag-dialog__chip"><i class="ph ph-share-network" aria-hidden="true"></i></div>
          <div>
            <h3 id="rag-pub-titre">Publier « {{ rg.courante.name }} »</h3>
            <div id="rag-pub-sous" class="rag-dialog__sub">
              Les comptes choisis pourront l’interroger, sans la modifier.
            </div>
          </div>
        </div>
        <div class="rag-dialog__body">
          <div class="rag-opt" :class="{ 'is-on': rg.publier.choix.visibility === 'private' }">
            <input
              id="rag-vis-private"
              type="radio"
              name="rag-visibilite"
              class="rag-sr"
              :checked="rg.publier.choix.visibility === 'private'"
              @change="rg.publier.choisir('private')"
            />
            <label for="rag-vis-private" class="rag-radio" aria-hidden="true"></label>
            <div>
              <label for="rag-vis-private"><b>Privée</b><small>Vous seul</small></label>
            </div>
          </div>

          <div class="rag-opt" :class="{ 'is-on': rg.publier.choix.visibility === 'groups' }">
            <input
              id="rag-vis-groups"
              type="radio"
              name="rag-visibilite"
              class="rag-sr"
              :checked="rg.publier.choix.visibility === 'groups'"
              @change="rg.publier.choisir('groups')"
            />
            <label for="rag-vis-groups" class="rag-radio" aria-hidden="true"></label>
            <div>
              <label for="rag-vis-groups"><b>Groupes</b><small>Les membres des groupes choisis</small></label>
              <div
                v-if="rg.publier.groupes.groups.length > 0"
                class="rag-chips"
                role="group"
                aria-label="Groupes"
              >
                <button
                  v-for="g in rg.publier.groupes.groups"
                  :key="g.id"
                  type="button"
                  class="rag-chip"
                  :class="{ 'is-on': rg.publier.choix.groupIds.includes(g.id) }"
                  :aria-pressed="rg.publier.choix.groupIds.includes(g.id) ? 'true' : 'false'"
                  :aria-label="g.name + ', ' + g.members + ' membre' + (g.members > 1 ? 's' : '')"
                  @click="
                    rg.publier.choisir('groups');
                    rg.publier.basculer(g.id);
                  "
                >
                  <i
                    v-if="rg.publier.choix.groupIds.includes(g.id)"
                    class="ph ph-check"
                    aria-hidden="true"
                  ></i
                  >{{ g.name }} <em>{{ g.members }}</em>
                </button>
              </div>
              <small v-else-if="!rg.publier.chargement" class="rag-hint"
                >Vous n’êtes membre d’aucun groupe.</small
              >
            </div>
          </div>

          <div
            v-if="rg.publier.peutPublierTous"
            class="rag-opt"
            :class="{ 'is-on': rg.publier.choix.visibility === 'all' }"
          >
            <input
              id="rag-vis-all"
              type="radio"
              name="rag-visibilite"
              class="rag-sr"
              :checked="rg.publier.choix.visibility === 'all'"
              @change="rg.publier.choisir('all')"
            />
            <label for="rag-vis-all" class="rag-radio" aria-hidden="true"></label>
            <div>
              <label for="rag-vis-all"
                ><b>Tous les comptes</b><small>Chaque compte de cette instance</small></label
              >
            </div>
          </div>

          <div class="rag-line">
            <div id="rag-pub-sources">
              Ouvrir les documents sources<small>Sinon, seuls les passages trouvés sont visibles</small>
            </div>
            <button
              type="button"
              role="switch"
              class="rag-switch"
              :class="{
                'is-off': !rg.publier.choix.allowSourceOpen || rg.publier.choix.visibility === 'private',
              }"
              aria-labelledby="rag-pub-sources"
              :aria-checked="
                rg.publier.choix.allowSourceOpen && rg.publier.choix.visibility !== 'private'
                  ? 'true'
                  : 'false'
              "
              :disabled="rg.publier.choix.visibility === 'private'"
              @click="rg.publier.ouvrirSources(!rg.publier.choix.allowSourceOpen)"
            >
              <s aria-hidden="true"></s>
            </button>
          </div>
          <div class="rag-note">
            <i class="ph ph-users-three" aria-hidden="true"></i
            ><span data-rag-comptes aria-live="polite">{{ rg.publier.invalide ?? rg.publier.phrase }}</span>
          </div>
          <p v-if="rg.publier.erreur" class="rag-error" role="alert">
            <i class="ph ph-warning-circle" aria-hidden="true"></i><span>{{ rg.publier.erreur }}</span>
          </p>
        </div>
        <div class="rag-dialog__foot">
          <button type="button" class="rag-btn" @click="rg.publier.fermer()">Annuler</button>
          <button
            type="button"
            class="rag-btn rag-btn--primary"
            :disabled="!rg.publier.peutConfirmer"
            @click="rg.publier.confirmer()"
          >
            {{ rg.publier.bouton }}
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>
