<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/secrets/TableSecrets.vue — table des secrets (compte ou instance) : name, type, scope, user, tls, version, dernier usage, usages ; menu ⋯ au clavier (rotation, modification, vérification, renvoi au connecteur, suppression confirmée sur place) et panneau sous la ligne. -->
<script setup lang="ts">
import type { Secret } from "@elpis/contracts";
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";

import { maintenantServeurS } from "../../platform/horloge";
import { dernierUsage, porteeTexte } from "../../features/secrets/format";
import { domaineSecrets } from "../../features/secrets/gestion";
import FormulaireSecret from "./FormulaireSecret.vue";

const g = domaineSecrets();
const racine = ref<HTMLElement | null>(null);
const COLONNES = 9;
const dateCourte = new Intl.DateTimeFormat("fr-FR", { dateStyle: "short", timeStyle: "short" });

const usage = (s: Secret): string => dernierUsage(s.last_used_at, maintenantServeurS());
const infoUsage = (s: Secret): string =>
  s.last_used_at ? dateCourte.format(s.last_used_at * 1000) : "jamais utilisé";
/** Infobulle du nom : les colonnes masquées quand la table est étroite. */
const infoNom = (s: Secret): string =>
  `${s.name}\nuser=${s.username ?? "—"} · tls=${s.policy.tls}\n${s.use_count} usages · dernier : ${infoUsage(s)}`;

// Clic hors du menu ouvert et de son bouton : menu refermé (la confirmation armée avec lui).
function dehors(e: Event): void {
  if (g.menu === null || !(e.target instanceof Node)) return;
  const menu = racine.value?.querySelector(`#secret-menu-${g.menu}`);
  if (!menu?.contains(e.target) && !declencheur(g.menu)?.contains(e.target)) g.fermerMenu();
}
onMounted(() => globalThis.document.addEventListener("pointerdown", dehors, true));
onBeforeUnmount(() => {
  globalThis.document.removeEventListener("pointerdown", dehors, true);
  g.reinitialiserVue();
});

function entrees(id: number): HTMLElement[] {
  const menu = racine.value?.querySelector(`#secret-menu-${id}`);
  return menu ? [...menu.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)')] : [];
}

function declencheur(id: number): HTMLElement | null {
  return racine.value?.querySelector<HTMLElement>(`[data-declencheur="${id}"]`) ?? null;
}

// Menu ouvert : focus sur la première entrée ; refermé sans panneau ouvert (Échap, clic dehors), focus rendu à son bouton ⋯.
watch(
  () => g.menu,
  async (ouvert, avant) => {
    const actif = globalThis.document.activeElement;
    const dedans = !actif || actif === globalThis.document.body || !!racine.value?.contains(actif);
    await nextTick();
    if (ouvert !== null) entrees(ouvert)[0]?.focus();
    else if (avant !== null && dedans && g.panneau?.id !== avant) declencheur(avant)?.focus();
  },
);

function toucheMenu(e: KeyboardEvent, id: number): void {
  const liste = entrees(id);
  const i = liste.indexOf(globalThis.document.activeElement as HTMLElement);
  const aller = (n: number): void => {
    e.preventDefault();
    liste[(n + liste.length) % liste.length]?.focus();
  };
  if (e.key === "ArrowDown") aller(i + 1);
  else if (e.key === "ArrowUp") aller(i < 0 ? -1 : i - 1);
  else if (e.key === "Home") aller(0);
  else if (e.key === "End") aller(-1);
  else if (e.key === "Escape") {
    e.preventDefault();
    e.stopPropagation();
    g.fermerMenu();
  } else if (e.key === "Tab") g.fermerMenu();
}

// Panneau ouvert : focus sur son premier champ ou bouton.
watch(
  () => g.panneau,
  async (p) => {
    if (!p) return;
    await nextTick();
    racine.value
      ?.querySelector<HTMLElement>(
        `[data-panneau="${p.id}"] input, [data-panneau="${p.id}"] button:not(:disabled)`,
      )
      ?.focus();
  },
);
</script>

<template>
  <div ref="racine" class="elpis-secrets" :data-secrets-portee="g.portee">
    <p v-if="g.erreurListe" role="alert" class="elpis-secrets__refus">{{ g.erreurListe }}</p>
    <p v-else-if="g.charge && !g.secrets.length" class="elpis-secrets__vide">Aucun secret.</p>
    <table
      v-if="g.secrets.length"
      class="adm-table elpis-secrets__table"
      :aria-label="g.portee === 'instance' ? 'Secrets de l’instance' : 'Secrets du compte'"
      :aria-busy="g.chargement ? 'true' : undefined"
    >
      <thead>
        <tr>
          <th scope="col" class="elpis-secrets__c-name">name</th>
          <th scope="col" class="elpis-secrets__c-type">type</th>
          <th scope="col">scope</th>
          <th scope="col" class="elpis-secrets__c-user elpis-secrets__opt">user</th>
          <th scope="col" class="elpis-secrets__c-tls elpis-secrets__opt">tls</th>
          <th scope="col" class="elpis-secrets__c-version elpis-secrets__num" title="+1 à chaque rotation">
            version
          </th>
          <th scope="col" class="elpis-secrets__c-usage elpis-secrets__opt">dernier usage</th>
          <th scope="col" class="elpis-secrets__c-usages elpis-secrets__num elpis-secrets__opt">usages</th>
          <th scope="col" class="elpis-secrets__menu"><span class="sr-only">Actions</span></th>
        </tr>
      </thead>
      <tbody>
        <template v-for="s in g.secrets" :key="s.id">
          <tr :data-secret="s.name" :class="{ 'is-sel': g.panneau?.id === s.id }">
            <td :title="infoNom(s)">
              <div class="elpis-secrets__cellnom">
                <span class="elpis-secrets__nom font-mono">{{ s.name }}</span>
                <span
                  v-if="s.state === 'unverified'"
                  class="elpis-secrets__etat font-mono"
                  title="Importé : inutilisable avant Vérifier"
                  >unverified</span
                >
                <span
                  v-if="!s.key_current"
                  class="elpis-secrets__etat elpis-secrets__etat--cle font-mono"
                  title="Chiffré par une autre clé que la clé courante : rotation, ou ./elpis vault rekey"
                  >⚠ kid</span
                >
              </div>
            </td>
            <td class="font-mono">{{ s.kind }}</td>
            <td class="font-mono" :title="porteeTexte(s).join('\n') || undefined">
              <template v-if="porteeTexte(s).length">
                {{ porteeTexte(s)[0]
                }}<span v-if="porteeTexte(s).length > 1" class="adm-muted">
                  +{{ porteeTexte(s).length - 1 }}</span
                >
              </template>
              <span v-else class="adm-muted">—</span>
            </td>
            <td class="font-mono elpis-secrets__opt" :title="s.username ?? undefined">
              {{ s.username ?? "—" }}
            </td>
            <td
              class="font-mono elpis-secrets__opt"
              :class="{ 'elpis-secrets__insecure': s.policy.tls === 'insecure' }"
            >
              {{ s.policy.tls }}
            </td>
            <td class="elpis-secrets__num">{{ s.version }}</td>
            <td class="elpis-secrets__opt" :title="infoUsage(s)">{{ usage(s) }}</td>
            <td class="elpis-secrets__num elpis-secrets__opt">{{ s.use_count }}</td>
            <td class="elpis-secrets__menu">
              <div class="relative">
                <button
                  type="button"
                  class="adm-btn adm-btn--icon elpis-secrets__declencheur"
                  :aria-label="`Actions sur ${s.name}`"
                  title="Actions"
                  aria-haspopup="menu"
                  :aria-expanded="g.menu === s.id ? 'true' : 'false'"
                  :aria-controls="g.menu === s.id ? `secret-menu-${s.id}` : undefined"
                  :data-declencheur="s.id"
                  @click="g.basculerMenu(s.id)"
                >
                  <i class="ph ph-dots-three" aria-hidden="true"></i>
                </button>
                <template v-if="g.menu === s.id">
                  <div
                    :id="`secret-menu-${s.id}`"
                    role="menu"
                    :aria-label="`Actions sur ${s.name}`"
                    class="adm-pop elpis-secrets__pop"
                    @keydown="toucheMenu($event, s.id)"
                  >
                    <div class="adm-pop__body">
                      <button
                        v-if="g.droits(s).rotation"
                        type="button"
                        role="menuitem"
                        class="adm-menu__item"
                        title="Nouvelle valeur, version + 1"
                        @click="g.choisir(s.id, 'rotation')"
                      >
                        <i class="ph ph-arrows-clockwise" aria-hidden="true"></i> Rotation
                      </button>
                      <button
                        v-if="g.droits(s).modification"
                        type="button"
                        role="menuitem"
                        class="adm-menu__item"
                        @click="g.choisir(s.id, 'modifier')"
                      >
                        <i class="ph ph-pencil-simple" aria-hidden="true"></i> Modifier
                      </button>
                      <button
                        v-if="g.droits(s).verification"
                        type="button"
                        role="menuitem"
                        class="adm-menu__item"
                        title="unverified → active, après lecture du scope"
                        @click="g.choisir(s.id, 'verifier')"
                      >
                        <i class="ph ph-seal-check" aria-hidden="true"></i> Vérifier
                      </button>
                      <button
                        v-if="g.droits(s).gere"
                        type="button"
                        role="menuitem"
                        class="adm-menu__item"
                        title="Géré par son connecteur"
                        @click="g.choisir(s.id, 'gerer')"
                      >
                        <i class="ph ph-arrow-square-out" aria-hidden="true"></i>
                        {{ g.droits(s).gere?.libelle }}
                      </button>
                      <template v-if="g.droits(s).suppression">
                        <div class="adm-menu__sep" role="separator"></div>
                        <button
                          type="button"
                          role="menuitem"
                          class="adm-menu__item elpis-secrets__suppr"
                          :class="{ 'is-arme': g.confirmer === s.id }"
                          :disabled="g.occupe"
                          :aria-describedby="g.confirmer === s.id ? `secret-suppr-${s.id}` : undefined"
                          @click="g.clicSupprimer(s.id)"
                        >
                          <i class="ph ph-trash" aria-hidden="true"></i> Supprimer
                        </button>
                        <div v-if="g.confirmer === s.id" class="elpis-secrets__confirmer">
                          <span :id="`secret-suppr-${s.id}`" role="status"
                            >Cliquez de nouveau pour confirmer.</span
                          >
                          <button
                            type="button"
                            role="menuitem"
                            class="adm-btn adm-btn--quiet adm-btn--sm"
                            @click="g.annulerSuppression()"
                          >
                            Annuler
                          </button>
                        </div>
                      </template>
                    </div>
                  </div>
                </template>
              </div>
            </td>
          </tr>
          <tr
            v-if="g.panneau?.id === s.id || g.erreur?.cible === s.id"
            class="elpis-secrets__panneau"
            :data-panneau="s.id"
          >
            <td :colspan="COLONNES">
              <form
                v-if="g.panneau?.id === s.id && g.panneau.mode === 'rotation'"
                class="elpis-secrets__ligne"
                :aria-label="`Rotation de ${s.name}`"
                @submit.prevent="g.tourner(s.id)"
              >
                <label :for="`secret-rot-${s.id}`" class="elpis-secrets__etiq">Nouvelle valeur</label>
                <input
                  :id="`secret-rot-${s.id}`"
                  v-model="g.valeurRotation"
                  type="password"
                  class="set-input font-mono elpis-secrets__champ"
                  autocomplete="new-password"
                  spellcheck="false"
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
                  <dt>scope</dt>
                  <dd class="font-mono">
                    <span v-for="o in porteeTexte(s)" :key="o" class="block">{{ o }}</span>
                  </dd>
                  <dt>user</dt>
                  <dd class="font-mono">{{ s.username ?? "—" }}</dd>
                  <dt>tls</dt>
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
                    type="button"
                    class="adm-btn adm-tool adm-btn--sm"
                    @click="g.choisir(s.id, 'modifier')"
                  >
                    Modifier le scope
                  </button>
                  <button type="button" class="adm-btn adm-btn--quiet adm-btn--sm" @click="g.fermerPanneau()">
                    Annuler
                  </button>
                  <span class="elpis-secrets__aide"
                    >unverified → active ; élargir le scope exige la valeur.</span
                  >
                </div>
              </div>

              <FormulaireSecret
                v-else-if="g.panneau?.id === s.id && g.panneau.mode === 'modifier'"
                mode="edition"
              />

              <p
                v-if="g.erreur?.cible === s.id && g.panneau?.mode !== 'modifier'"
                role="alert"
                class="elpis-secrets__refus"
              >
                {{ g.erreur.message }}
              </p>
            </td>
          </tr>
        </template>
      </tbody>
    </table>
  </div>
</template>
