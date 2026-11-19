<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/admin/SectionDroitsFournisseur.vue — tiroir d'un fournisseur d'identité : rôles et groupes Elpis d'après les groupes de l'annuaire ou du SSO (repliée, éteinte par défaut). -->
<script setup lang="ts">
import { computed } from "vue";

import { domaineAdmin } from "../../features/admin/domaine";

const adm = domaineAdmin();
const f = computed(() => adm.authTiroir);
const general = computed(() => adm.authFige(""));
const groupesElpis = computed(() => adm.groupsList);
const nomGroupe = (id: number): string =>
  groupesElpis.value.find((g) => g.id === id)?.name ?? `Groupe n°${id}`;
const absent = (id: number): boolean => !groupesElpis.value.some((g) => g.id === id);
</script>

<template>
  <div v-if="f" class="space-y-2" data-droits-fournisseur>
    <details class="adm-details adm-details--rows" data-droits-section>
      <summary>Rôles et groupes</summary>
      <div class="space-y-3 mt-2">
        <label class="adm-checks__item">
          <input
            id="ent-roles-actif"
            v-model="f.roles_enabled"
            type="checkbox"
            :disabled="!!general"
            :title="general"
          />
          Donner les rôles d'après les groupes de l'annuaire
        </label>
        <p class="adm-card__hint">
          Le rôle d'une personne est recalculé à chacune de ses connexions. Dans la page Comptes, il ne peut
          alors plus qu'être rétrogradé.
        </p>

        <div class="adm-field">
          <label class="adm-field__label" for="ent-admin-groupe">Groupes administrateurs</label>
          <ul
            v-if="f.admin_groups.length"
            class="flex flex-wrap gap-1.5"
            aria-label="Groupes administrateurs"
          >
            <li v-for="(g, i) in f.admin_groups" :key="g" class="adm-pill">
              <span class="font-mono">{{ g }}</span>
              <button
                type="button"
                class="adm-link"
                :aria-label="'Retirer ' + g"
                :disabled="!!general"
                @click="adm.authRetirerGroupeRole('admin', i)"
              >
                <i class="ph ph-x" aria-hidden="true"></i>
              </button>
            </li>
          </ul>
          <div class="adm-field__row">
            <input
              id="ent-admin-groupe"
              v-model="f.admin_saisi"
              class="set-input flex-1"
              :disabled="!!general"
              :title="general || 'Identifiant exact du groupe (DN complet pour un annuaire).'"
              @keydown.enter.prevent="adm.authAjouterGroupeRole('admin')"
            />
            <button
              type="button"
              class="adm-btn adm-btn--quiet adm-btn--sm"
              data-admin-ajouter
              :disabled="!!general || f.admin_saisi.trim() === ''"
              @click="adm.authAjouterGroupeRole('admin')"
            >
              Ajouter
            </button>
          </div>
        </div>

        <div class="adm-field">
          <label class="adm-field__label" for="ent-mod-groupe">Groupes modérateurs</label>
          <ul
            v-if="f.moderator_groups.length"
            class="flex flex-wrap gap-1.5"
            aria-label="Groupes modérateurs"
          >
            <li v-for="(g, i) in f.moderator_groups" :key="g" class="adm-pill">
              <span class="font-mono">{{ g }}</span>
              <button
                type="button"
                class="adm-link"
                :aria-label="'Retirer ' + g"
                :disabled="!!general"
                @click="adm.authRetirerGroupeRole('moderator', i)"
              >
                <i class="ph ph-x" aria-hidden="true"></i>
              </button>
            </li>
          </ul>
          <div class="adm-field__row">
            <input
              id="ent-mod-groupe"
              v-model="f.moderator_saisi"
              class="set-input flex-1"
              :disabled="!!general"
              :title="general || 'Identifiant exact du groupe (DN complet pour un annuaire).'"
              @keydown.enter.prevent="adm.authAjouterGroupeRole('moderator')"
            />
            <button
              type="button"
              class="adm-btn adm-btn--quiet adm-btn--sm"
              data-mod-ajouter
              :disabled="!!general || f.moderator_saisi.trim() === ''"
              @click="adm.authAjouterGroupeRole('moderator')"
            >
              Ajouter
            </button>
          </div>
        </div>

        <label class="adm-checks__item">
          <input
            id="ent-groupes-actif"
            v-model="f.map_enabled"
            type="checkbox"
            :disabled="!!general"
            :title="general"
          />
          Affecter aux groupes Elpis d'après les groupes de l'annuaire
        </label>
        <p class="adm-card__hint">
          Seuls les groupes Elpis cités ici sont gérés ; les autres appartenances d'un compte ne sont jamais
          touchées.
        </p>
        <ul v-if="f.map.length" class="adm-rows" aria-label="Correspondances de groupes">
          <li
            v-for="(c, i) in f.map"
            :key="c.external + '#' + c.group_id"
            class="adm-row adm-row--full"
            data-correspondance
          >
            <div class="flex items-center gap-2 min-w-0 text-xs">
              <span class="font-mono min-w-0 flex-1 break-all">{{ c.external }}</span>
              <span aria-hidden="true">→</span>
              <span :class="absent(c.group_id) ? 'text-amber-700' : ''">{{ nomGroupe(c.group_id) }}</span>
              <button
                type="button"
                class="adm-btn adm-btn--icon adm-btn--danger-hover"
                :aria-label="'Retirer la correspondance ' + c.external"
                :disabled="!!general"
                @click="adm.authRetirerCorrespondance(i)"
              >
                <i class="ph ph-trash" aria-hidden="true"></i>
              </button>
            </div>
          </li>
        </ul>
        <div class="adm-field__row">
          <input
            id="ent-map-externe"
            v-model="f.map_externe"
            class="set-input flex-1 font-mono text-xs"
            aria-label="Groupe de l'annuaire"
            placeholder="Groupe de l'annuaire"
            :disabled="!!general"
            :title="general || 'Identifiant exact du groupe (DN complet pour un annuaire).'"
            @keydown.enter.prevent="adm.authAjouterCorrespondance()"
          />
          <select
            id="ent-map-groupe"
            v-model.number="f.map_groupe"
            class="set-select"
            aria-label="Groupe Elpis"
            :disabled="!!general"
          >
            <option :value="0">Groupe Elpis…</option>
            <option v-for="g in groupesElpis" :key="g.id" :value="g.id">{{ g.name }}</option>
          </select>
          <button
            type="button"
            class="adm-btn adm-btn--quiet adm-btn--sm"
            data-map-ajouter
            :disabled="!!general || f.map_externe.trim() === '' || f.map_groupe < 1"
            @click="adm.authAjouterCorrespondance()"
          >
            Ajouter
          </button>
        </div>
      </div>
    </details>

    <template v-if="f.admin_groups.length">
      <p class="adm-field__warn" role="alert" data-avertissement-admin>
        Un administrateur d'Elpis peut faire exécuter des commandes sur le serveur. Ne donnez ce rôle qu'à un
        groupe que vous maîtrisez.
      </p>
      <p
        v-if="adm.authAdminSansSecondFacteur"
        class="adm-field__warn"
        role="alert"
        data-exiger-second-facteur
      >
        Exigez d'abord une vérification en deux étapes pour ce fournisseur.
      </p>
    </template>
  </div>
</template>
