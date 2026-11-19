<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/admin/TiroirRattachement.vue — Connexion d'entreprise : tiroir de l'assistant de rattachement des comptes locaux existants à une entrée d'annuaire. -->
<script setup lang="ts">
import { computed } from "vue";

import { heureCourte } from "../../features/admin/horodatage";
import { entreeRattachable, etatEntree } from "../../features/admin/rattachement";
import { domaineAdmin } from "../../features/admin/domaine";

const adm = domaineAdmin();
const a = computed(() => adm.assistant);
const nombre = computed(() => adm.assistantSelection.length);
const ROLES = { admin: "Administrateur", moderator: "Modérateur", user: "Utilisateur" } as const;
const groupe = (v: boolean | null): string => (v === null ? "inconnu" : v ? "oui" : "non");
const raison = (etat: string, dansGroupe: boolean | null): string => {
  if (etat !== "active") return "Cette entrée n'est pas active.";
  if (dansGroupe === null) return "Les groupes de cette entrée sont illisibles.";
  return dansGroupe ? "" : "Cette entrée n'est dans aucun groupe requis.";
};
</script>

<template>
  <teleport to="body">
    <Transition name="adm-tiroir">
      <div
        v-if="a && adm.adminTab === 'enterprise-login'"
        class="adm-drawer-backdrop"
        @click.self="adm.assistantFermer()"
      >
        <aside
          :ref="
            (el) => {
              adm.assistantDrawer = el as typeof adm.assistantDrawer;
            }
          "
          class="adm-drawer adm-drawer--large"
          role="dialog"
          aria-modal="true"
          aria-labelledby="ratt-titre"
          tabindex="-1"
          data-assistant-rattachement
          @keydown.tab="adm.assistantTouche"
          @keydown.esc.stop="adm.assistantFermer()"
        >
          <header class="adm-drawer__head">
            <i class="ph ph-link adm-card__icon" aria-hidden="true"></i>
            <h2 id="ratt-titre" class="adm-drawer__title">Rattacher les comptes existants · {{ a.label }}</h2>
            <button
              type="button"
              class="adm-btn adm-btn--icon ml-auto"
              aria-label="Fermer"
              title="Fermer (Échap)"
              @click="adm.assistantFermer()"
            >
              <i class="ph ph-x" aria-hidden="true"></i>
            </button>
          </header>

          <div class="adm-drawer__body">
            <p class="adm-card__hint">
              Cochez, ligne par ligne, les comptes à rattacher à l'entrée de l'annuaire proposée.
            </p>
            <p v-if="a.erreur" class="adm-field__warn" role="alert" data-ratt-erreur>{{ a.erreur }}</p>
            <p v-if="a.resume" class="text-xs font-medium text-slate-800" role="status" data-ratt-resume>
              {{ a.resume }}
            </p>
            <p v-if="a.chargement" class="adm-card__hint" aria-busy="true">Chargement…</p>
            <p v-else-if="!a.lignes.length && !a.erreur" class="adm-empty">Aucun compte local à rattacher.</p>

            <ul v-if="a.lignes.length" class="adm-rows" aria-label="Comptes à rattacher">
              <li v-for="l in a.lignes" :key="l.compte.user_id" class="adm-row adm-row--full" data-ratt-ligne>
                <div class="flex items-start gap-3 min-w-0">
                  <input
                    type="checkbox"
                    class="mt-1"
                    data-ratt-case
                    :aria-label="'Rattacher ' + l.compte.username"
                    :checked="l.coche"
                    :disabled="!entreeRattachable(l.proposition) || a.envoi"
                    :title="
                      l.proposition
                        ? raison(l.proposition.state, l.proposition.in_required_group)
                        : 'Aucune entrée proposée.'
                    "
                    @change="adm.assistantCocher(l)"
                  />
                  <div class="min-w-0 flex-1 space-y-1">
                    <div class="flex items-center gap-2 flex-wrap">
                      <span class="font-medium text-sm truncate">{{ l.compte.username }}</span>
                      <span class="adm-pill" :class="{ 'adm-pill--warn': l.compte.role !== 'user' }">{{
                        ROLES[l.compte.role]
                      }}</span>
                      <span v-if="l.compte.suspended" class="adm-pill adm-pill--warn">Désactivé</span>
                      <span class="adm-card__hint">
                        {{
                          l.compte.last_login_at
                            ? "Dernière connexion : " + heureCourte(l.compte.last_login_at)
                            : "Jamais connecté"
                        }}
                      </span>
                    </div>
                    <div v-if="l.proposition" class="text-xs space-y-0.5" data-ratt-proposition>
                      <div class="flex items-center gap-2 flex-wrap">
                        <span class="font-medium">{{
                          l.proposition.ext_name || l.proposition.ext_username
                        }}</span>
                        <span class="font-mono text-slate-500">{{ l.proposition.ext_username }}</span>
                        <span
                          class="adm-pill"
                          :class="{ 'adm-pill--warn': l.proposition.state !== 'active' }"
                          >{{ etatEntree(l.proposition.state) }}</span
                        >
                      </div>
                      <div class="adm-card__hint">
                        {{ l.proposition.ext_email || "Sans e-mail" }} · Dans un groupe requis :
                        {{ groupe(l.proposition.in_required_group) }}
                      </div>
                    </div>
                    <p v-else class="adm-card__hint" data-ratt-aucune>Aucune entrée de ce nom.</p>

                    <label
                      v-if="l.coche && l.compte.role !== 'user'"
                      class="flex items-center gap-2 text-xs ent-ko"
                    >
                      <input v-model="l.confirmeAdmin" type="checkbox" data-ratt-admin />
                      <span class="adm-row__label"
                        >Je confirme le rattachement de
                        {{ l.compte.role === "admin" ? "cet administrateur" : "ce modérateur" }}</span
                      >
                    </label>

                    <div>
                      <button
                        type="button"
                        class="adm-btn adm-btn--quiet adm-btn--sm"
                        data-ratt-chercher
                        :aria-expanded="l.recherche.ouvert ? 'true' : 'false'"
                        @click="adm.assistantChercherOuvrir(l)"
                      >
                        <i class="ph ph-magnifying-glass" aria-hidden="true"></i>
                        {{ l.proposition ? "Choisir une autre entrée" : "Chercher dans l'annuaire" }}
                      </button>
                    </div>
                    <form
                      v-if="l.recherche.ouvert"
                      class="space-y-1"
                      data-ratt-recherche
                      @submit.prevent="adm.assistantRechercher(l)"
                    >
                      <div class="flex items-center gap-2">
                        <input
                          v-model="l.recherche.texte"
                          class="set-input flex-1"
                          maxlength="64"
                          autocomplete="off"
                          data-ratt-recherche-champ
                          :aria-label="'Chercher une entrée pour ' + l.compte.username"
                          placeholder="Nom ou identifiant, 3 caractères au moins"
                        />
                        <button
                          type="submit"
                          class="adm-btn adm-tool adm-btn--sm"
                          data-ratt-recherche-lancer
                          :disabled="l.recherche.busy"
                        >
                          Chercher
                        </button>
                      </div>
                      <p v-if="l.recherche.erreur" class="adm-field__warn" role="alert">
                        {{ l.recherche.erreur }}
                      </p>
                      <p v-if="l.recherche.resultats && !l.recherche.resultats.length" class="adm-card__hint">
                        Aucune entrée trouvée.
                      </p>
                      <ul v-if="l.recherche.resultats?.length" class="adm-rows">
                        <li
                          v-for="p in l.recherche.resultats"
                          :key="p.subject"
                          class="adm-row adm-row--full"
                          data-ratt-resultat
                        >
                          <div class="flex items-center gap-2 min-w-0 text-xs">
                            <div class="min-w-0 flex-1">
                              <span class="font-medium">{{ p.ext_name || p.ext_username }}</span>
                              <span class="font-mono text-slate-500"> {{ p.ext_username }}</span>
                              <span class="adm-card__hint">
                                · {{ etatEntree(p.state) }} · groupe requis :
                                {{ groupe(p.in_required_group) }}</span
                              >
                            </div>
                            <button
                              type="button"
                              class="adm-btn adm-tool adm-btn--sm"
                              data-ratt-choisir
                              @click="adm.assistantChoisir(l, p)"
                            >
                              Choisir
                            </button>
                          </div>
                        </li>
                      </ul>
                    </form>

                    <p
                      v-if="l.resultat"
                      class="text-xs"
                      :class="l.resultat === 'Rattaché' ? 'text-slate-700' : 'adm-field__warn'"
                      role="status"
                      data-ratt-resultat-ligne
                    >
                      {{ l.resultat }}
                    </p>
                  </div>
                </div>
              </li>
            </ul>

            <div v-if="a.total > a.lignes.length || a.offset > 0" class="flex items-center gap-2">
              <button
                type="button"
                class="adm-btn adm-btn--quiet adm-btn--sm"
                data-ratt-precedent
                :disabled="a.offset === 0 || a.chargement || a.envoi"
                @click="adm.assistantPage(-1)"
              >
                Précédents
              </button>
              <span class="adm-card__hint"
                >{{ a.offset + 1 }}–{{ a.offset + a.lignes.length }} sur {{ a.total }}</span
              >
              <button
                type="button"
                class="adm-btn adm-btn--quiet adm-btn--sm"
                data-ratt-suivant
                :disabled="a.offset + a.lignes.length >= a.total || a.chargement || a.envoi"
                @click="adm.assistantPage(1)"
              >
                Suivants
              </button>
            </div>
          </div>

          <footer class="adm-drawer__foot flex-wrap">
            <p class="adm-card__hint basis-full" data-ratt-phrase>
              Le mot de passe local de ces comptes sera retiré et leurs sessions fermées. Ils se connecteront
              avec leur identifiant d'annuaire.
            </p>
            <label class="flex items-center gap-2 text-xs basis-full">
              <input
                v-model="a.garderJetons"
                type="checkbox"
                data-ratt-garder-jetons
                :disabled="a.envoi"
                @change="a.arme = false"
              />
              <span>Conserver les jetons d'API et les accès des applications de ces comptes</span>
            </label>
            <button
              type="button"
              data-ratt-valider
              class="adm-btn"
              :class="a.arme ? 'adm-btn--danger' : 'adm-btn--primary'"
              :disabled="nombre === 0 || a.envoi"
              @click="adm.assistantLier()"
            >
              Rattacher {{ nombre }} compte{{ nombre > 1 ? "s" : "" }}
            </button>
            <template v-if="a.arme">
              <span class="adm-field__warn" role="status">Confirmer ?</span>
              <button type="button" class="adm-btn adm-btn--quiet" data-ratt-annuler @click="a.arme = false">
                Annuler
              </button>
            </template>
            <button type="button" class="adm-btn adm-btn--quiet ml-auto" @click="adm.assistantFermer()">
              Fermer
            </button>
          </footer>
        </aside>
      </div>
    </Transition>
  </teleport>
</template>
