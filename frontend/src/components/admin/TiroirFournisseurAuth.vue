<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/admin/TiroirFournisseurAuth.vue — Connexion d'entreprise : tiroir d'un fournisseur d'identité OpenID Connect, son secret, son activation et sa suppression. -->
<script setup lang="ts">
import { computed } from "vue";

import { domaineAdmin } from "../../features/admin/domaine";
import { heureCourte } from "../../features/admin/horodatage";
import {
  ALGOS_JETON,
  lignesDroits,
  lignesRevendications,
  phraseDecision,
} from "../../features/admin/identite";
import EtapesEssai from "./EtapesEssai.vue";
import SectionDroitsFournisseur from "./SectionDroitsFournisseur.vue";

const adm = domaineAdmin();
const f = computed(() => adm.authTiroir);
const bornes = computed(() => adm.authEtat?.bounds ?? null);
const general = computed(() => adm.authFige(""));
const synthese = computed(() => {
  const r = adm.authEssai;
  if (!r) return "";
  if (!r.ok || r.steps.length === 0 || r.steps.some((x) => x.level === "fail"))
    return "Un contrôle a échoué.";
  return adm.authFournisseur?.tested
    ? "Les contrôles passent. Ce fournisseur peut être activé."
    : "Lancez un essai de connexion pour pouvoir activer ce fournisseur.";
});
const titre = computed(() => {
  const x = f.value;
  if (!x) return "";
  if (x.nouveau) return "Nouveau SSO OpenID Connect";
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
            <i class="ph ph-key adm-card__icon" aria-hidden="true"></i>
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
                placeholder="sso-siege"
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
                placeholder="SSO de l'entreprise"
              />
            </label>

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
              <label class="adm-field__label" for="ent-secret">Secret client</label>
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

            <SectionDroitsFournisseur />

            <details class="adm-details adm-details--rows">
              <summary>Avancé</summary>
              <div class="space-y-3 mt-2">
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
                  <span class="adm-field__label">Algorithme de signature du jeton</span>
                  <select
                    v-model="f.id_token_alg"
                    class="set-select w-full"
                    data-id-token-alg
                    :disabled="!!general"
                    :title="general"
                  >
                    <option v-for="alg in ALGOS_JETON" :key="alg" :value="alg">{{ alg }}</option>
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
                    :title="
                      general ||
                      'Séparées par des espaces ; l\'une d\'elles suffit pour se connecter ; vide : aucune exigence.'
                    "
                  />
                </label>
                <p
                  v-if="f.required_acr.trim() === '' && f.required_amr.trim() === ''"
                  class="adm-card__hint"
                  data-aide-second-facteur
                >
                  Sans ce réglage, aucune vérification en deux étapes n'est garantie par Elpis.
                </p>
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
                </template>
              </div>
            </section>

            <section v-if="!f.nouveau" class="space-y-2" aria-labelledby="ent-trial-h" data-essai-connexion>
              <div class="flex items-center gap-2 flex-wrap">
                <h3 id="ent-trial-h" class="adm-field__label">Essai de connexion</h3>
                <button
                  id="ent-trial"
                  type="button"
                  class="adm-btn adm-tool adm-btn--sm ml-auto"
                  :disabled="adm.authTrialEnCours || adm.authTrialAttente"
                  title="Ouvre le service de votre organisation dans un nouvel onglet : rien n'est enregistré."
                  @click="adm.authEssayerConnexion()"
                >
                  <i
                    class="ph"
                    :class="
                      adm.authTrialEnCours || adm.authTrialAttente
                        ? 'ph-spinner-gap animate-spin'
                        : 'ph-sign-in'
                    "
                    aria-hidden="true"
                  ></i>
                  {{
                    adm.authTrialEnCours
                      ? "Lancement…"
                      : adm.authTrialAttente
                        ? "En attente de la connexion…"
                        : "Essayer la connexion"
                  }}
                </button>
              </div>
              <div aria-live="polite" class="space-y-2">
                <p v-if="adm.authTrialErreur" id="ent-trial-erreur" class="adm-field__warn">
                  {{ adm.authTrialErreur }}
                </p>
                <EtapesEssai
                  v-if="adm.authTrialEtapes.some((x) => x.level !== 'ok')"
                  :steps="adm.authTrialEtapes"
                  :annoncer="false"
                />
                <template v-if="adm.authTrial">
                  <p id="ent-trial-decision" class="text-xs font-medium text-slate-800">
                    {{ phraseDecision(adm.authTrial.decision) }}
                  </p>
                  <dl v-if="adm.authTrial.claims" class="text-xs space-y-0.5" data-revendications>
                    <div
                      v-for="[nom, valeur] in lignesRevendications(adm.authTrial.claims)"
                      :key="nom"
                      class="flex gap-2"
                    >
                      <dt class="shrink-0 text-slate-500">{{ nom }}</dt>
                      <dd class="min-w-0 break-words font-mono">{{ valeur }}</dd>
                    </div>
                  </dl>
                  <ul
                    v-if="lignesDroits(adm.authTrial.rights).length"
                    class="text-xs space-y-0.5"
                    data-droits-essai
                  >
                    <li v-for="l in lignesDroits(adm.authTrial.rights)" :key="l">{{ l }}</li>
                  </ul>
                  <ul v-if="adm.authTrial.warnings.length" class="text-xs text-amber-700 space-y-0.5">
                    <li v-for="(w, i) in adm.authTrial.warnings" :key="i" data-avertissement-essai>
                      {{ w }}
                    </li>
                  </ul>
                </template>
              </div>
            </section>

            <section v-if="!f.nouveau" class="space-y-2" aria-labelledby="ent-prelien-h" data-prelinks>
              <h3 id="ent-prelien-h" class="adm-field__label">Comptes existants</h3>
              <p class="adm-card__hint">
                À sa première connexion par ce fournisseur, la personne devra saisir une fois son ancien mot
                de passe Elpis.
              </p>
              <ul v-if="adm.prelinks.length" class="adm-rows" aria-label="Rattachements préparés">
                <li v-for="p in adm.prelinks" :key="p.id" class="adm-row adm-row--full" data-prelink>
                  <div class="flex items-center gap-2 min-w-0">
                    <div class="min-w-0 flex-1 text-xs">
                      <span class="font-medium">{{ p.username ?? "Compte supprimé" }}</span>
                      <span class="font-mono text-slate-500"> {{ p.expected }}</span>
                      <div class="adm-card__hint">
                        {{ p.waiver ? "Sans ancien mot de passe · " : "" }}Échéance :
                        {{ heureCourte(p.expires_at) }}
                      </div>
                    </div>
                    <button
                      type="button"
                      class="adm-btn adm-btn--icon adm-btn--danger-hover"
                      data-prelink-supprimer
                      :aria-label="'Supprimer le rattachement préparé de ' + (p.username ?? 'ce compte')"
                      :disabled="adm.prelinksBusy"
                      @click="adm.prelinkSupprimer(p)"
                    >
                      <i class="ph ph-trash" aria-hidden="true"></i>
                    </button>
                  </div>
                </li>
              </ul>
              <p v-else class="adm-card__hint">Aucun rattachement préparé.</p>

              <label class="adm-field">
                <span class="adm-field__label">Compte local</span>
                <select
                  id="ent-prelien-compte"
                  v-model.number="adm.prelinkForm.user_id"
                  class="set-select w-full"
                >
                  <option :value="0">—</option>
                  <option v-for="u in adm.prelinkComptes" :key="u.id" :value="u.id">
                    {{ u.username
                    }}{{ u.is_admin === 1 ? " (administrateur)" : u.is_admin === 2 ? " (modérateur)" : "" }}
                  </option>
                </select>
              </label>
              <label class="adm-field">
                <span class="adm-field__label">Identifiant attendu chez le fournisseur</span>
                <input
                  id="ent-prelien-attendu"
                  v-model="adm.prelinkForm.expected"
                  class="set-input font-mono text-xs"
                  maxlength="256"
                  autocomplete="off"
                />
              </label>
              <label
                class="flex items-center gap-2 text-xs"
                :title="
                  adm.prelinkAdmin
                    ? 'Un administrateur ou un modérateur doit toujours prouver son ancien mot de passe.'
                    : ''
                "
              >
                <input
                  id="ent-prelien-dispense"
                  v-model="adm.prelinkForm.waiver"
                  type="checkbox"
                  :disabled="adm.prelinkAdmin"
                />
                <span>Identité vérifiée hors ligne : ne pas demander l'ancien mot de passe</span>
              </label>
              <p class="adm-card__hint" data-prelink-dispense-aide>
                À n'utiliser que si votre fournisseur ne laisse pas les personnes changer leur identifiant.
              </p>
              <p v-if="adm.prelinkAdmin" class="adm-card__hint" data-prelink-dispense-admin>
                Un administrateur ou un modérateur doit toujours prouver son ancien mot de passe.
              </p>
              <label v-if="adm.prelinkAdmin" class="flex items-center gap-2 text-xs ent-ko">
                <input id="ent-prelien-admin" v-model="adm.prelinkForm.confirm_admin" type="checkbox" />
                <span class="adm-row__label"
                  >Je confirme le rattachement de cet administrateur ou modérateur</span
                >
              </label>
              <p v-if="adm.prelinksErreur" class="adm-field__warn" role="alert" data-prelinks-erreur>
                {{ adm.prelinksErreur }}
              </p>
              <button
                id="ent-prelien-ajouter"
                type="button"
                class="adm-btn adm-tool adm-btn--sm"
                :disabled="adm.prelinksBusy || !adm.prelinkPret"
                @click="adm.prelinkAjouter()"
              >
                <i class="ph ph-plus" aria-hidden="true"></i> Préparer le rattachement
              </button>
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
              :disabled="adm.authBusy || adm.authRolesBloque"
              :title="
                adm.authRolesBloque
                  ? 'Exigez d\'abord une vérification en deux étapes pour ce fournisseur.'
                  : undefined
              "
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
