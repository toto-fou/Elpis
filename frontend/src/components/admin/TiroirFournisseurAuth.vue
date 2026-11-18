<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/admin/TiroirFournisseurAuth.vue — Connexion d'entreprise : tiroir d'un fournisseur d'identité (LDAP ou OIDC), son secret, son activation et sa suppression. -->
<script setup lang="ts">
import { computed } from "vue";

import { domaineAdmin } from "../../features/admin/domaine";
import { PRESETS_LDAP } from "../../features/admin/identite";
import EtapesEssai from "./EtapesEssai.vue";

const adm = domaineAdmin();
const f = computed(() => adm.authTiroir);
const bornes = computed(() => adm.authEtat?.bounds ?? null);
const general = computed(() => adm.authFige(""));
const synthese = computed(() => {
  const r = adm.authEssai;
  if (!r) return "";
  if (!r.ok || r.steps.length === 0 || r.steps.some((x) => x.level === "fail"))
    return "Un contrôle a échoué.";
  return r.steps.every((x) => x.level === "ok")
    ? "Les contrôles réseau et de certificat passent."
    : "Les contrôles passent, avec des avertissements à lire.";
});
const titre = computed(() => {
  const x = f.value;
  if (!x) return "";
  if (x.nouveau) return x.type === "ldap" ? "Nouvel annuaire LDAP" : "Nouveau SSO OpenID Connect";
  return adm.authFournisseur?.label ?? x.label;
});
</script>

<template>
  <teleport to="body">
    <Transition name="adm-tiroir">
      <div
        v-if="f && adm.adminTab === 'enterprise-login' && bornes"
        class="adm-drawer-backdrop"
        @click.self="adm.authFermer()"
      >
        <aside
          :ref="
            (el) => {
              adm.authDrawer = el as typeof adm.authDrawer;
            }
          "
          class="adm-drawer"
          role="dialog"
          aria-modal="true"
          aria-labelledby="ent-tiroir-titre"
          tabindex="-1"
          @keydown.tab="adm.authTouche"
          @keydown.esc.stop="adm.authFermer()"
        >
          <header class="adm-drawer__head">
            <i
              class="ph adm-card__icon"
              :class="f.type === 'ldap' ? 'ph-address-book' : 'ph-key'"
              aria-hidden="true"
            ></i>
            <h2 id="ent-tiroir-titre" class="adm-drawer__title">{{ titre }}</h2>
            <span v-if="adm.authFournisseur" class="adm-pill">{{
              adm.authFournisseur.active ? "Actif" : adm.authFournisseur.enabled ? "À tester" : "Éteint"
            }}</span>
            <button
              type="button"
              class="adm-btn adm-btn--icon ml-auto"
              aria-label="Fermer"
              title="Fermer (Échap)"
              @click="adm.authFermer()"
            >
              <i class="ph ph-x" aria-hidden="true"></i>
            </button>
          </header>

          <div class="adm-drawer__body">
            <p v-if="general" class="adm-card__hint" role="status">{{ general }}</p>

            <label class="adm-field">
              <span class="adm-field__label">Identifiant</span>
              <input
                id="ent-id"
                v-model="f.id"
                class="set-input font-mono text-xs"
                autocomplete="off"
                placeholder="annuaire-siege"
                :disabled="!f.nouveau"
                :title="
                  f.nouveau
                    ? 'Minuscules, chiffres et tirets. Ne se modifie plus ensuite.'
                    : 'Ne se modifie pas.'
                "
              />
            </label>
            <label class="adm-field">
              <span class="adm-field__label">Libellé</span>
              <input
                id="ent-label"
                v-model="f.label"
                class="set-input"
                :maxlength="bornes.label_max"
                :disabled="!!general"
                :title="general"
                placeholder="Annuaire de l'entreprise"
              />
            </label>

            <label v-if="f.type === 'ldap'" class="adm-field">
              <span class="adm-field__label">Préréglage</span>
              <select
                id="ent-preset"
                v-model="f.preset"
                class="set-select w-full"
                :disabled="!!general"
                :title="general || 'Préremplit les champs encore vides.'"
                @change="adm.authAppliquerPreset()"
              >
                <option value="">—</option>
                <option v-for="p in PRESETS_LDAP" :key="p.id" :value="p.id">{{ p.label }}</option>
              </select>
            </label>

            <template v-if="f.type === 'ldap'">
              <label class="adm-field">
                <span class="adm-field__label">Adresses</span>
                <textarea
                  id="ent-urls"
                  v-model="f.urls"
                  rows="2"
                  class="set-textarea font-mono text-xs"
                  placeholder="ldaps://annuaire.example.lan"
                  :disabled="!!general"
                  :title="general || `Une adresse ldaps:// par ligne, ${bornes.ldap_urls_max} au plus.`"
                ></textarea>
              </label>
              <label class="adm-field">
                <span class="adm-field__label">Compte de service</span>
                <input
                  id="ent-bind"
                  v-model="f.bind_dn"
                  class="set-input font-mono text-xs"
                  placeholder="uid=elpis,cn=sysaccounts,cn=etc,dc=example,dc=lan"
                  :disabled="!!general"
                  :title="general"
                />
              </label>
              <label class="adm-field">
                <span class="adm-field__label">Base des comptes</span>
                <input
                  id="ent-base"
                  v-model="f.user_base_dn"
                  class="set-input font-mono text-xs"
                  placeholder="cn=users,cn=accounts,dc=example,dc=lan"
                  :disabled="!!general"
                  :title="general"
                />
              </label>
              <label class="adm-field">
                <span class="adm-field__label">Filtre</span>
                <input
                  id="ent-filtre"
                  v-model="f.user_filter"
                  class="set-input font-mono text-xs"
                  placeholder="(&(objectClass=person)(uid={username}))"
                  :disabled="!!general"
                  :title="general || 'Doit contenir {username} une fois.'"
                />
              </label>
            </template>

            <template v-else>
              <label class="adm-field">
                <span class="adm-field__label">Autorité</span>
                <input
                  id="ent-issuer"
                  v-model="f.issuer"
                  class="set-input font-mono text-xs"
                  placeholder="https://sso.example.lan/realms/entreprise"
                  :disabled="!!adm.authFige('issuer')"
                  :title="adm.authFige('issuer') || 'Adresse https du fournisseur d\'identité.'"
                />
              </label>
              <label class="adm-field">
                <span class="adm-field__label">Identifiant client</span>
                <input
                  id="ent-client"
                  v-model="f.client_id"
                  class="set-input font-mono text-xs"
                  :disabled="!!adm.authFige('client_id')"
                  :title="adm.authFige('client_id')"
                />
              </label>
              <div v-if="adm.authAdresses" class="adm-field">
                <span class="adm-field__label">À déclarer chez le fournisseur</span>
                <div class="adm-field__row">
                  <code id="ent-retour" class="sup-mono text-xs break-all flex-1">{{
                    adm.authAdresses.retour
                  }}</code>
                  <button
                    type="button"
                    class="adm-btn adm-btn--quiet adm-btn--sm"
                    title="Adresse de retour"
                    @click="adm.authCopier(adm.authAdresses.retour)"
                  >
                    <i class="ph ph-copy" aria-hidden="true"></i> Copier
                  </button>
                </div>
                <div class="adm-field__row">
                  <code id="ent-deconnexion" class="sup-mono text-xs break-all flex-1">{{
                    adm.authAdresses.deconnexion
                  }}</code>
                  <button
                    type="button"
                    class="adm-btn adm-btn--quiet adm-btn--sm"
                    title="Adresse de déconnexion par canal arrière"
                    @click="adm.authCopier(adm.authAdresses.deconnexion)"
                  >
                    <i class="ph ph-copy" aria-hidden="true"></i> Copier
                  </button>
                </div>
              </div>
            </template>

            <div class="adm-field">
              <label class="adm-field__label" for="ent-groupe">Groupes requis</label>
              <ul v-if="f.required_groups.length" class="flex flex-wrap gap-1.5" aria-label="Groupes requis">
                <li v-for="(g, i) in f.required_groups" :key="g" class="adm-pill">
                  <span class="font-mono">{{ g }}</span>
                  <button
                    type="button"
                    class="adm-link"
                    :aria-label="'Retirer ' + g"
                    :disabled="!!general"
                    @click="adm.authRetirerGroupe(i)"
                  >
                    <i class="ph ph-x" aria-hidden="true"></i>
                  </button>
                </li>
              </ul>
              <div class="adm-field__row">
                <input
                  id="ent-groupe"
                  v-model="f.groupe_saisi"
                  class="set-input flex-1"
                  placeholder="elpis-utilisateurs"
                  :disabled="!!general"
                  :title="
                    general || 'Seules les personnes membres d\'un de ces groupes peuvent se connecter.'
                  "
                  @keydown.enter.prevent="adm.authAjouterGroupe()"
                />
                <button
                  type="button"
                  class="adm-btn adm-btn--quiet adm-btn--sm"
                  :disabled="!!general || f.groupe_saisi.trim() === ''"
                  @click="adm.authAjouterGroupe()"
                >
                  Ajouter
                </button>
              </div>
            </div>

            <div class="adm-field">
              <label class="adm-field__label" for="ent-secret">{{
                f.type === "ldap" ? "Mot de passe du compte de service" : "Secret client"
              }}</label>
              <div class="adm-field__row">
                <input
                  id="ent-secret"
                  v-model="f.secret"
                  type="password"
                  autocomplete="new-password"
                  class="set-input flex-1"
                  :maxlength="bornes.secret_max"
                  :placeholder="adm.authFournisseur?.has_secret ? 'Inchangé' : 'Secret'"
                  title="Stocké à part sur le serveur, jamais réaffiché."
                />
                <span
                  v-if="!f.nouveau"
                  id="ent-secret-etat"
                  class="text-xs"
                  :class="adm.authFournisseur?.has_secret ? 'text-emerald-700' : 'text-slate-500'"
                >
                  <i
                    class="ph"
                    :class="adm.authFournisseur?.has_secret ? 'ph-check-circle' : 'ph-warning-circle'"
                    aria-hidden="true"
                  ></i>
                  {{ adm.authFournisseur?.has_secret ? "Enregistré" : "Aucun" }}
                </span>
                <button
                  v-if="adm.authFournisseur?.has_secret"
                  type="button"
                  class="adm-link"
                  :disabled="adm.authBusy"
                  @click="adm.authSupprimerSecret()"
                >
                  Supprimer
                </button>
              </div>
            </div>

            <label class="adm-field">
              <span class="adm-field__label">Autorité de certification</span>
              <textarea
                id="ent-ca"
                v-model="f.ca_pem"
                rows="3"
                class="set-textarea font-mono text-xs"
                placeholder="-----BEGIN CERTIFICATE-----"
                spellcheck="false"
                :disabled="!!general"
                :title="general"
              ></textarea>
              <span class="adm-card__hint"
                >Collez ici l'autorité de votre organisation si son certificat n'est pas reconnu.</span
              >
            </label>

            <details class="adm-details adm-details--rows">
              <summary>Avancé</summary>
              <div class="space-y-3 mt-2">
                <template v-if="f.type === 'ldap'">
                  <div class="grid grid-cols-2 gap-3">
                    <label class="adm-field">
                      <span class="adm-field__label">Attribut identifiant</span>
                      <input
                        v-model="f.attr_id"
                        class="set-input font-mono text-xs"
                        placeholder="entryUUID"
                        :disabled="!!adm.authFige('attrs.id')"
                        :title="adm.authFige('attrs.id') || 'Valeur stable propre à chaque compte.'"
                      />
                    </label>
                    <label class="adm-field">
                      <span class="adm-field__label">Attribut nom</span>
                      <input
                        v-model="f.attr_username"
                        class="set-input font-mono text-xs"
                        placeholder="uid"
                        :disabled="!!general"
                        :title="general"
                      />
                    </label>
                    <label class="adm-field">
                      <span class="adm-field__label">Attribut e-mail</span>
                      <input
                        v-model="f.attr_email"
                        class="set-input font-mono text-xs"
                        placeholder="mail"
                        :disabled="!!general"
                        :title="general"
                      />
                    </label>
                    <label class="adm-field">
                      <span class="adm-field__label">Attribut affiché</span>
                      <input
                        v-model="f.attr_name"
                        class="set-input font-mono text-xs"
                        placeholder="cn"
                        :disabled="!!general"
                        :title="general"
                      />
                    </label>
                  </div>
                  <label class="adm-field">
                    <span class="adm-field__label">Appartenance</span>
                    <select
                      v-model="f.groups_mode"
                      class="set-select w-full"
                      :disabled="!!general"
                      :title="general"
                    >
                      <option value="">Par défaut</option>
                      <option value="memberof">memberOf</option>
                      <option value="chain">Chaîne (Active Directory)</option>
                      <option value="member">member</option>
                    </select>
                  </label>
                  <div class="grid grid-cols-3 gap-3">
                    <label class="adm-field">
                      <span class="adm-field__label">Essais</span>
                      <input
                        v-model="f.max_failures"
                        type="number"
                        :min="bornes.max_failures.min"
                        :max="bornes.max_failures.max"
                        :placeholder="String(bornes.max_failures.default)"
                        class="set-input"
                        :disabled="!!general"
                        :title="general || 'Échecs successifs avant blocage temporaire d\'un compte.'"
                      />
                    </label>
                    <label class="adm-field">
                      <span class="adm-field__label">Fenêtre (s)</span>
                      <input
                        v-model="f.failure_window_sec"
                        type="number"
                        :min="bornes.failure_window_sec.min"
                        :max="bornes.failure_window_sec.max"
                        :placeholder="String(bornes.failure_window_sec.default)"
                        class="set-input"
                        :disabled="!!general"
                        :title="general"
                      />
                    </label>
                    <label class="adm-field">
                      <span class="adm-field__label">Délai (s)</span>
                      <input
                        v-model="f.timeout_sec"
                        type="number"
                        :min="bornes.timeout_sec.min"
                        :max="bornes.timeout_sec.max"
                        :placeholder="String(bornes.timeout_sec.default)"
                        class="set-input"
                        :disabled="!!general"
                        :title="general"
                      />
                    </label>
                  </div>
                </template>
                <template v-else>
                  <label class="adm-field">
                    <span class="adm-field__label">Authentification client</span>
                    <select
                      v-model="f.client_auth"
                      class="set-select w-full"
                      :disabled="!!general"
                      :title="general"
                    >
                      <option value="">Par défaut</option>
                      <option value="basic">En-tête (basic)</option>
                      <option value="post">Corps de requête (post)</option>
                    </select>
                  </label>
                  <label class="adm-field">
                    <span class="adm-field__label">Portées</span>
                    <input
                      v-model="f.scopes"
                      class="set-input font-mono text-xs"
                      placeholder="openid profile email"
                      :disabled="!!general"
                      :title="general || 'Séparées par des espaces. openid est obligatoire.'"
                    />
                  </label>
                  <div class="grid grid-cols-2 gap-3">
                    <label class="adm-field">
                      <span class="adm-field__label">Revendication sujet</span>
                      <input
                        v-model="f.subject_claim"
                        class="set-input font-mono text-xs"
                        placeholder="sub"
                        :disabled="!!adm.authFige('subject_claim')"
                        :title="adm.authFige('subject_claim') || 'Valeur stable propre à chaque compte.'"
                      />
                    </label>
                    <label class="adm-field">
                      <span class="adm-field__label">Revendication nom</span>
                      <input
                        v-model="f.username_claim"
                        class="set-input font-mono text-xs"
                        placeholder="preferred_username"
                        :disabled="!!general"
                        :title="general"
                      />
                    </label>
                    <label class="adm-field">
                      <span class="adm-field__label">Revendication e-mail</span>
                      <input
                        v-model="f.email_claim"
                        class="set-input font-mono text-xs"
                        placeholder="email"
                        :disabled="!!general"
                        :title="general"
                      />
                    </label>
                    <label class="adm-field">
                      <span class="adm-field__label">Revendication affichée</span>
                      <input
                        v-model="f.name_claim"
                        class="set-input font-mono text-xs"
                        placeholder="name"
                        :disabled="!!general"
                        :title="general"
                      />
                    </label>
                    <label class="adm-field">
                      <span class="adm-field__label">Revendication groupes</span>
                      <input
                        v-model="f.groups_claim"
                        class="set-input font-mono text-xs"
                        placeholder="groups"
                        :disabled="!!general"
                        :title="general"
                      />
                    </label>
                  </div>
                  <label class="adm-field">
                    <span class="adm-field__label">Niveaux d'authentification (acr)</span>
                    <input
                      v-model="f.required_acr"
                      class="set-input font-mono text-xs"
                      :disabled="!!general"
                      :title="general || 'Séparés par des espaces ; vide : aucune exigence.'"
                    />
                  </label>
                  <label class="adm-field">
                    <span class="adm-field__label">Méthodes d'authentification (amr)</span>
                    <input
                      v-model="f.required_amr"
                      class="set-input font-mono text-xs"
                      :disabled="!!general"
                      :title="general || 'Séparées par des espaces ; vide : aucune exigence.'"
                    />
                  </label>
                  <div class="grid grid-cols-3 gap-3">
                    <label class="adm-field">
                      <span class="adm-field__label">Âge max. (s)</span>
                      <input
                        v-model="f.max_age_sec"
                        type="number"
                        min="0"
                        placeholder="0"
                        class="set-input"
                        :disabled="!!general"
                        :title="general || '0 : aucune exigence.'"
                      />
                    </label>
                    <label class="adm-field">
                      <span class="adm-field__label">Écart (s)</span>
                      <input
                        v-model="f.clock_skew_sec"
                        type="number"
                        :min="bornes.clock_skew_sec.min"
                        :max="bornes.clock_skew_sec.max"
                        :placeholder="String(bornes.clock_skew_sec.default)"
                        class="set-input"
                        :disabled="!!general"
                        :title="general || 'Écart d\'horloge toléré.'"
                      />
                    </label>
                    <label class="adm-field">
                      <span class="adm-field__label">Session (s)</span>
                      <input
                        v-model="f.session_max_age_sec"
                        type="number"
                        min="0"
                        placeholder="0"
                        class="set-input"
                        :disabled="!!general"
                        :title="general || '0 : durée globale des sessions.'"
                      />
                    </label>
                  </div>
                  <label class="adm-checks__item">
                    <input v-model="f.rp_initiated" type="checkbox" :disabled="!!general" :title="general" />
                    Déconnecter aussi chez le fournisseur
                  </label>
                  <label class="adm-checks__item">
                    <input v-model="f.backchannel" type="checkbox" :disabled="!!general" :title="general" />
                    Accepter la déconnexion par canal arrière
                  </label>
                </template>
                <label class="adm-field">
                  <span class="adm-field__label">Fraîcheur (jours)</span>
                  <input
                    v-model="f.freshness_days"
                    type="number"
                    :min="bornes.freshness_days.min"
                    :max="bornes.freshness_days.max"
                    :placeholder="String(bornes.freshness_days.default)"
                    class="set-input"
                    :disabled="!!general"
                    :title="general || 'Délai au-delà duquel un compte est revérifié.'"
                  />
                </label>
              </div>
            </details>

            <p v-if="adm.authTiroirErreur" class="adm-field__warn" role="alert">{{ adm.authTiroirErreur }}</p>

            <section class="space-y-2" aria-labelledby="ent-essai-h" data-essai-fournisseur>
              <div class="flex items-center gap-2 flex-wrap">
                <h3 id="ent-essai-h" class="adm-field__label">Test de connexion</h3>
                <button
                  id="ent-tester"
                  type="button"
                  class="adm-btn adm-tool adm-btn--sm ml-auto"
                  :disabled="adm.authEssaiEnCours"
                  title="Vérifie les réglages affichés, enregistrés ou non."
                  @click="adm.authTester()"
                >
                  <i
                    class="ph"
                    :class="adm.authEssaiEnCours ? 'ph-spinner-gap animate-spin' : 'ph-pulse'"
                    aria-hidden="true"
                  ></i>
                  {{ adm.authEssaiEnCours ? "Test en cours…" : "Tester" }}
                </button>
              </div>
              <div aria-live="polite" class="space-y-2">
                <p v-if="adm.authEssaiErreur" id="ent-essai-erreur" class="adm-field__warn">
                  {{ adm.authEssaiErreur }}
                </p>
                <template v-if="adm.authEssai">
                  <p id="ent-essai-synthese" class="text-xs font-medium text-slate-800">{{ synthese }}</p>
                  <EtapesEssai :steps="adm.authEssai.steps" :annoncer="false" />
                  <p v-if="!adm.authEssai.complete" id="ent-essai-incomplet" class="adm-card__hint">
                    Ce test ne couvre pas encore la connexion elle-même : l'activation reste indisponible.
                  </p>
                </template>
              </div>
            </section>

            <section v-if="!f.nouveau" class="adm-card adm-zone" aria-labelledby="ent-zone-h">
              <header class="adm-card__head">
                <i class="ph ph-warning adm-card__icon" aria-hidden="true"></i>
                <div><h3 id="ent-zone-h" class="adm-card__title">Zone sensible</h3></div>
              </header>
              <div class="adm-rows">
                <div class="adm-row adm-row--full">
                  <div class="flex items-center gap-3 flex-wrap">
                    <button
                      id="ent-supprimer"
                      type="button"
                      class="adm-btn adm-btn--danger"
                      :disabled="adm.authBusy || !!adm.authFournisseur?.enabled"
                      :title="
                        adm.authFournisseur?.enabled
                          ? 'Désactivez d\'abord ce fournisseur.'
                          : 'Supprime le fournisseur et son secret.'
                      "
                      @click="adm.authSupprimer(f.id)"
                    >
                      <i class="ph ph-trash" aria-hidden="true"></i> Supprimer
                    </button>
                  </div>
                </div>
              </div>
            </section>
          </div>

          <footer class="adm-drawer__foot">
            <button
              v-if="adm.authFournisseur && !adm.authFournisseur.enabled"
              id="ent-activer"
              type="button"
              class="adm-btn adm-tool mr-auto"
              :disabled="adm.authBusy || !!adm.authRaisonActiver"
              :title="adm.authRaisonActiver || 'Active ce fournisseur pour la connexion.'"
              @click="adm.authBasculer(true)"
            >
              Activer
            </button>
            <button
              v-if="adm.authFournisseur?.enabled"
              id="ent-desactiver"
              type="button"
              class="adm-btn adm-tool mr-auto"
              :disabled="adm.authBusy"
              @click="adm.authBasculer(false)"
            >
              Désactiver
            </button>
            <button type="button" class="adm-btn adm-btn--quiet" @click="adm.authFermer()">Annuler</button>
            <button
              id="ent-enregistrer-fournisseur"
              type="button"
              class="adm-btn adm-btn--primary"
              :disabled="adm.authBusy"
              @click="adm.authEnregistrer()"
            >
              {{ f.nouveau ? "Ajouter" : "Enregistrer" }}
            </button>
          </footer>
        </aside>
      </div>
    </Transition>
  </teleport>
</template>
