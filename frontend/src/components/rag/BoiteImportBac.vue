<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/rag/BoiteImportBac.vue — « Importer depuis la sandbox » : fichiers du bac acceptés par le RAG, dossiers dépliables, sélection par dossier. -->
<script setup lang="ts">
import { domaineRag } from "../../features/rag/domaine";
import { iconeFichier } from "../../features/rag/format";
import { extensionDe } from "../../features/rag/depot";

const rg = domaineRag();
</script>

<template>
  <Teleport to="body">
    <div
      v-if="rg.bac.ouvert"
      class="rag-veil bg-slate-900/80"
      data-a11y-modal
      data-rag-dialog="bac"
      @click.self="rg.bac.fermer()"
    >
      <div
        class="rag-dialog rag-dialog--wide shadow-2xl"
        role="dialog"
        aria-modal="true"
        aria-labelledby="rag-bac-titre"
      >
        <div class="rag-dialog__head">
          <div class="rag-dialog__chip"><i class="ph ph-folder-open" aria-hidden="true"></i></div>
          <div>
            <h3 id="rag-bac-titre">Importer depuis la sandbox</h3>
            <div class="rag-dialog__sub">
              Choisissez des fichiers ou des dossiers : ils sont copiés dans la collection.
            </div>
          </div>
        </div>
        <div class="rag-dialog__body">
          <div class="rag-search rag-search--flat">
            <i class="ph ph-magnifying-glass" aria-hidden="true"></i>
            <input
              v-model="rg.bac.filtre"
              class="rag-input"
              type="search"
              placeholder="Filtrer les fichiers"
              aria-label="Filtrer les fichiers de la sandbox"
            />
          </div>
          <p v-if="rg.bac.chargement" class="rag-note" role="status">
            <i class="ph ph-circle-notch animate-spin" aria-hidden="true"></i>Chargement de la sandbox…
          </p>
          <p v-else-if="rg.bac.erreur" class="rag-error" role="alert">
            <i class="ph ph-warning-circle" aria-hidden="true"></i><span>{{ rg.bac.erreur }}</span>
          </p>
          <p v-else-if="rg.bac.lignes.length === 0" class="rag-note">
            <i class="ph ph-info" aria-hidden="true"></i>Aucun fichier compatible dans la sandbox (PDF, Word,
            Excel, PowerPoint, Markdown, HTML, texte).
          </p>
          <ul v-else class="rag-tree" aria-label="Fichiers de la sandbox">
            <li
              v-for="l in rg.bac.lignes"
              :key="l.chemin"
              :style="{ paddingLeft: 10 + l.profondeur * 18 + 'px' }"
            >
              <button
                v-if="l.dossier"
                type="button"
                class="rag-tree__fold"
                :aria-expanded="l.ouvert ? 'true' : 'false'"
                :aria-label="(l.ouvert ? 'Replier ' : 'Déplier ') + l.nom"
                @click="rg.bac.deplier(l.chemin)"
              >
                <i class="ph" :class="l.ouvert ? 'ph-caret-down' : 'ph-caret-right'" aria-hidden="true"></i>
              </button>
              <span v-else class="rag-tree__fold" aria-hidden="true"></span>
              <label>
                <input
                  type="checkbox"
                  :checked="l.etat === 'tous'"
                  :indeterminate.prop="l.etat === 'partiel'"
                  @change="rg.bac.basculer(l.chemin)"
                />
                <i
                  class="ph"
                  :class="l.dossier ? 'ph-folder' : iconeFichier(extensionDe(l.nom))"
                  aria-hidden="true"
                ></i>
                <span :title="l.chemin">{{ l.nom }}</span>
              </label>
              <small v-if="l.dossier">{{ l.fichiers }} fichier{{ l.fichiers > 1 ? "s" : "" }}</small>
              <small v-else-if="l.taille">{{ l.taille }}</small>
            </li>
          </ul>
          <p v-if="rg.bac.tronque" class="rag-hint">
            L’arbre de la sandbox est tronqué : filtrez pour retrouver un fichier précis.
          </p>
        </div>
        <div class="rag-dialog__foot">
          <span class="rag-tools__grow">{{ rg.bac.phrase }}</span>
          <button type="button" class="rag-btn" @click="rg.bac.fermer()">Annuler</button>
          <button
            type="button"
            class="rag-btn rag-btn--primary"
            :disabled="!rg.bac.peutImporter"
            @click="rg.bac.importer()"
          >
            Importer
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>
