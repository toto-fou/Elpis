<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/admin/TiroirFournisseurAuth.vue — SSO OpenID Connect : tiroir d'un fournisseur en huit sections stables (fournisseur, adresses à déclarer, client, accès, rôles, avancé, vérification, activation), puis sa suppression. -->
<script setup lang="ts">
import { computed } from "vue";

import { domaineAdmin } from "../../features/admin/domaine";
import {
  ALGOS_JETON,
  etatFournisseur,
  lignesDroits,
  lignesRevendications,
  phraseDecision,
  phraseSecondFacteur,
} from "../../features/admin/identite";
import EtapesEssai from "./EtapesEssai.vue";
import ListeGroupesFournisseur from "./ListeGroupesFournisseur.vue";
import SectionDroitsFournisseur from "./SectionDroitsFournisseur.vue";

const adm = domaineAdmin();
const f = computed(() => adm.authTiroir);
const bornes = computed(() => adm.authEtat?.bounds ?? null);
const general = computed(() => adm.authFige(""));
const actif = computed(() => !!adm.authFournisseur?.enabled);
const synthese = computed(() => {
  const r = adm.authEssai;
  if (!r) return "";
  if (!r.ok || r.steps.length === 0 || r.steps.some((x) => x.level === "fail"))
    return "Un contrôle a échoué.";
  return adm.authFournisseur?.tested
    ? "Les contrôles passent. Ce fournisseur peut être activé."
    : "Les contrôles passent. Faites ensuite « Se connecter pour essayer » pour pouvoir activer ce fournisseur.";
});
const titre = computed(() => {
  const x = f.value;
  if (!x) return "";
  if (x.nouveau) return "Nouveau SSO OpenID Connect";
  return adm.authFournisseur?.label ?? x.label;
});
/** Raison écrite sous un champ figé par des comptes rattachés, ou son aide. */
const aideFige = (champ: string, aide: string): string => adm.authFige(champ) || aide;
const raisonSupprimer = computed(() => {
  if (!f.value || f.value.nouveau || !adm.authFournisseur)
    return "Ce fournisseur n'est pas encore enregistré.";
  if (adm.authFournisseur.enabled) return "Désactivez d'abord ce fournisseur.";
  return adm.authFournisseur.identities > 0
    ? "Des comptes sont rattachés : détachez-les d'abord depuis la page Comptes."
    : "";
});
</script>

<template>
  <teleport to="body">
    <Transition name="adm-tiroir">
      <div
        v-if="f && adm.adminTab === 'oidc' && bornes"
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
          aria-describedby="ent-tiroir-etat"
          tabindex="-1"
          @keydown.tab="adm.authTouche"
          @keydown.esc.stop="adm.authFermer()"
        >
          <header class="adm-drawer__head">
            <i class="ph ph-key adm-card__icon" aria-hidden="true"></i>
            <h2 id="ent-tiroir-titre" class="adm-drawer__title">{{ titre }}</h2>
            <span
              class="adm-pill"
              :class="{
                'adm-pill--warn': !!adm.authFournisseur && etatFournisseur(adm.authFournisseur).alerte,
              }"
              data-etat-pastille
              >{{ adm.authFournisseur ? etatFournisseur(adm.authFournisseur).libelle : "Nouveau" }}</span
            >
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
            <p id="ent-tiroir-etat" class="adm-card__hint" role="status" data-etat-tiroir>
              {{ adm.authEtatTiroir }}
            </p>

            <section class="space-y-3" aria-labelledby="ent-s1-h" data-section-tiroir="fournisseur">
              <h3 id="ent-s1-h" class="adm-user-edit__legend">1. Fournisseur</h3>
              <label class="adm-field">
                <span class="adm-field__label">Libellé</span>
                <input
                  id="ent-label"
                  v-model="f.label"
                  class="set-input"
                  :maxlength="bornes.label_max"
                  :disabled="!!adm.authFige('label')"
                  :title="adm.authFige('label')"
                  placeholder="SSO de l'entreprise"
                />
              </label>
              <div class="adm-field">
                <label class="adm-field__label" for="ent-id">Identifiant dans Elpis</label>
                <input
                  id="ent-id"
                  v-model="f.id"
                  class="set-input font-mono text-xs"
                  autocomplete="off"
                  aria-describedby="ent-id-aide"
                  placeholder="sso-siege"
                  :disabled="!f.nouveau"
                  @input="f.id_touche = true"
                />
                <span id="ent-id-aide" class="adm-card__hint" data-aide-identifiant>
                  {{
                    f.nouveau
                      ? "Déduit du libellé tant que vous ne le modifiez pas : minuscules, chiffres et tirets. Il ne se modifie plus une fois le fournisseur ajouté."
                      : "Ne se modifie plus : il figure dans les adresses déclarées chez le fournisseur."
                  }}
                </span>
              </div>
              <div class="adm-field">
                <label class="adm-field__label" for="ent-issuer">Adresse de l'émetteur (issuer)</label>
                <input
                  id="ent-issuer"
                  v-model="f.issuer"
                  class="set-input font-mono text-xs"
                  placeholder="https://sso.example.lan/realms/entreprise"
                  aria-describedby="ent-issuer-aide"
                  :disabled="!!adm.authFige('issuer')"
                  :title="adm.authFige('issuer')"
                />
                <span id="ent-issuer-aide" class="adm-card__hint" data-aide-issuer>
                  {{ aideFige("issuer", "Adresse https du fournisseur, exactement comme il l'annonce.") }}
                </span>
              </div>
            </section>

            <section class="space-y-3" aria-labelledby="ent-s2-h" data-section-tiroir="declarer">
              <h3 id="ent-s2-h" class="adm-user-edit__legend">2. À déclarer chez le fournisseur</h3>
              <div class="adm-field">
                <span class="adm-field__label">Adresse de retour (redirect_uri)</span>
                <div class="adm-field__row">
                  <code v-if="adm.authAdresses" id="ent-retour" class="sup-mono text-xs break-all flex-1">{{
                    adm.authAdresses.retour
                  }}</code>
                  <span v-else id="ent-retour-manque" class="adm-card__hint flex-1" data-adresse-manque>{{
                    adm.authAdressesManque
                  }}</span>
                  <button
                    type="button"
                    class="adm-btn adm-btn--quiet adm-btn--sm"
                    aria-label="Copier l'adresse de retour"
                    :aria-describedby="adm.authAdresses ? 'ent-retour' : 'ent-retour-manque'"
                    data-copier-retour
                    :disabled="!adm.authAdresses"
                    @click="adm.authAdresses && adm.authCopier(adm.authAdresses.retour)"
                  >
                    <i class="ph ph-copy" aria-hidden="true"></i> Copier
                  </button>
                </div>
              </div>
              <div class="adm-field">
                <span class="adm-field__label">Déconnexion par canal arrière (backchannel_logout_uri)</span>
                <div class="adm-field__row">
                  <code
                    v-if="adm.authAdresses"
                    id="ent-deconnexion"
                    class="sup-mono text-xs break-all flex-1"
                    >{{ adm.authAdresses.deconnexion }}</code
                  >
                  <span
                    v-else
                    id="ent-deconnexion-manque"
                    class="adm-card__hint flex-1"
                    data-adresse-manque
                    >{{ adm.authAdressesManque }}</span
                  >
                  <button
                    type="button"
                    class="adm-btn adm-btn--quiet adm-btn--sm"
                    aria-label="Copier l'adresse de déconnexion par canal arrière"
                    :aria-describedby="adm.authAdresses ? 'ent-deconnexion' : 'ent-deconnexion-manque'"
                    data-copier-deconnexion
                    :disabled="!adm.authAdresses"
                    @click="adm.authAdresses && adm.authCopier(adm.authAdresses.deconnexion)"
                  >
                    <i class="ph ph-copy" aria-hidden="true"></i> Copier
                  </button>
                </div>
              </div>
            </section>

            <section class="space-y-3" aria-labelledby="ent-s3-h" data-section-tiroir="client">
              <h3 id="ent-s3-h" class="adm-user-edit__legend">3. Client</h3>
              <div class="grid grid-cols-2 gap-3">
                <div class="adm-field">
                  <label class="adm-field__label" for="ent-client">Identifiant client (client_id)</label>
                  <input
                    id="ent-client"
                    v-model="f.client_id"
                    aria-describedby="ent-client-aide"
                    class="set-input font-mono text-xs"
                    :disabled="!!adm.authFige('client_id')"
                    :title="adm.authFige('client_id')"
                  />
                  <span id="ent-client-aide" class="adm-card__hint" data-aide-client>
                    {{ aideFige("client_id", "Donné par le fournisseur à la création du client.") }}
                  </span>
                </div>
                <div class="adm-field">
                  <label class="adm-field__label" for="ent-secret">Secret client (client_secret)</label>
                  <input
                    id="ent-secret"
                    v-model="f.secret"
                    type="password"
                    autocomplete="new-password"
                    class="set-input"
                    :maxlength="bornes.secret_max"
                    :placeholder="adm.authFournisseur?.has_secret ? 'Inchangé' : 'Secret'"
                    :disabled="!!adm.authFige('secret')"
                    :title="adm.authFige('secret') || 'Stocké à part sur le serveur, jamais réaffiché.'"
                  />
                  <div class="adm-field__row text-xs">
                    <span
                      id="ent-secret-etat"
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
                      id="ent-secret-supprimer"
                      type="button"
                      class="adm-link"
                      :disabled="adm.authBusy || !adm.authFournisseur?.has_secret || !!adm.authFige('secret')"
                      @click="adm.authSupprimerSecret()"
                    >
                      Supprimer
                    </button>
                  </div>
                  <span class="adm-card__hint">Rangé à part sur le serveur, jamais réaffiché.</span>
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
                  >Si le certificat du fournisseur n'est pas reconnu : collez ici l'autorité de votre
                  organisation.</span
                >
              </label>
            </section>

            <section class="space-y-3" aria-labelledby="ent-s4-h" data-section-tiroir="acces">
              <h3 id="ent-s4-h" class="adm-user-edit__legend">4. Accès</h3>
              <ListeGroupesFournisseur
                liste="required_groups"
                champ="ent-groupe"
                label="Groupes requis"
                exemple="elpis-utilisateurs"
                indice="Seules les personnes membres d'un de ces groupes peuvent se connecter."
              />
              <div class="grid grid-cols-2 gap-3">
                <label class="adm-field">
                  <span class="adm-field__label">Niveaux exigés (acr)</span>
                  <input
                    id="ent-acr"
                    v-model="f.required_acr"
                    class="set-input font-mono text-xs"
                    aria-describedby="ent-second-facteur"
                    :disabled="!!general"
                    :title="general || 'Séparés par des espaces ; vide : aucune exigence.'"
                  />
                </label>
                <label class="adm-field">
                  <span class="adm-field__label">Méthodes exigées (amr)</span>
                  <input
                    id="ent-amr"
                    v-model="f.required_amr"
                    class="set-input font-mono text-xs"
                    aria-describedby="ent-second-facteur"
                    :disabled="!!general"
                    :title="
                      general ||
                      'Séparées par des espaces ; l\'une d\'elles suffit pour se connecter ; vide : aucune exigence.'
                    "
                  />
                </label>
              </div>
              <p id="ent-second-facteur" class="adm-card__hint" data-aide-second-facteur>
                {{
                  phraseSecondFacteur(
                    f.required_acr,
                    f.required_amr,
                    f.roles_enabled && f.admin_groups.length > 0,
                  )
                }}
              </p>
            </section>

            <SectionDroitsFournisseur />

            <details class="adm-details adm-details--rows" data-section-tiroir="avance">
              <summary>6. Avancé</summary>
              <div class="space-y-3 mt-2">
                <label class="adm-field">
                  <span class="adm-field__label">Authentification client (token_endpoint_auth_method)</span>
                  <select
                    v-model="f.client_auth"
                    class="set-select w-full"
                    :disabled="!!general"
                    :title="general"
                  >
                    <option value="">Par défaut</option>
                    <option value="basic">En-tête (client_secret_basic)</option>
                    <option value="post">Corps de requête (client_secret_post)</option>
                  </select>
                </label>
                <label class="adm-field">
                  <span class="adm-field__label">Signature du jeton (id_token_signed_response_alg)</span>
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
                  <span class="adm-field__label">Portées (scope)</span>
                  <input
                    v-model="f.scopes"
                    class="set-input font-mono text-xs"
                    placeholder="openid profile email"
                    :disabled="!!general"
                    :title="general || 'Séparées par des espaces. openid est obligatoire.'"
                  />
                </label>
                <div class="grid grid-cols-2 gap-3">
                  <div class="adm-field">
                    <label class="adm-field__label" for="ent-sujet">Revendication sujet (sub)</label>
                    <input
                      id="ent-sujet"
                      v-model="f.subject_claim"
                      aria-describedby="ent-sujet-aide"
                      class="set-input font-mono text-xs"
                      placeholder="sub"
                      :disabled="!!adm.authFige('subject_claim')"
                      :title="adm.authFige('subject_claim') || 'Valeur stable propre à chaque compte.'"
                    />
                    <span id="ent-sujet-aide" class="adm-card__hint" data-aide-sujet>
                      {{ aideFige("subject_claim", "Valeur stable propre à chaque compte.") }}
                    </span>
                  </div>
                  <label class="adm-field">
                    <span class="adm-field__label">Revendication nom (preferred_username)</span>
                    <input
                      v-model="f.username_claim"
                      class="set-input font-mono text-xs"
                      placeholder="preferred_username"
                      :disabled="!!general"
                      :title="general"
                    />
                  </label>
                  <label class="adm-field">
                    <span class="adm-field__label">Revendication e-mail (email)</span>
                    <input
                      v-model="f.email_claim"
                      class="set-input font-mono text-xs"
                      placeholder="email"
                      :disabled="!!general"
                      :title="general"
                    />
                  </label>
                  <label class="adm-field">
                    <span class="adm-field__label">Revendication affichée (name)</span>
                    <input
                      v-model="f.name_claim"
                      class="set-input font-mono text-xs"
                      placeholder="name"
                      :disabled="!!general"
                      :title="general"
                    />
                  </label>
                  <label class="adm-field">
                    <span class="adm-field__label">Revendication groupes (groups)</span>
                    <input
                      v-model="f.groups_claim"
                      class="set-input font-mono text-xs"
                      placeholder="groups"
                      :disabled="!!general"
                      :title="general"
                    />
                  </label>
                </div>
                <div class="grid grid-cols-3 gap-3">
                  <label class="adm-field">
                    <span class="adm-field__label">Âge max., s (max_age)</span>
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
                    <span class="adm-field__label">Écart d'horloge, s</span>
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
                    <span class="adm-field__label">Session, s</span>
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
                  Déconnecter aussi chez le fournisseur (end_session_endpoint)
                </label>
                <label class="adm-checks__item">
                  <input v-model="f.backchannel" type="checkbox" :disabled="!!general" :title="general" />
                  Accepter la déconnexion par canal arrière (backchannel_logout_uri)
                </label>
                <label class="adm-field">
                  <span class="adm-field__label">Fraîcheur (jours)</span>
                  <input
                    id="ent-fraicheur"
                    v-model="f.freshness_days"
                    type="number"
                    :min="bornes.freshness_days.min"
                    :max="bornes.freshness_days.max"
                    :placeholder="String(bornes.freshness_days.default)"
                    class="set-input"
                    :disabled="!!adm.authFige('freshness_days')"
                    :title="adm.authFige('freshness_days') || 'Délai au-delà duquel un compte est revérifié.'"
                  />
                </label>
              </div>
            </details>

            <section class="space-y-3" aria-labelledby="ent-s7-h" data-section-tiroir="verification">
              <h3 id="ent-s7-h" class="adm-user-edit__legend">7. Vérification</h3>
              <div class="space-y-2" data-essai-fournisseur>
                <div class="flex items-center gap-2 flex-wrap">
                  <span class="adm-field__label" aria-hidden="true">a.</span>
                  <button
                    id="ent-tester"
                    type="button"
                    class="adm-btn adm-tool adm-btn--sm"
                    aria-describedby="ent-essai-aide"
                    :disabled="adm.authEssaiEnCours"
                    @click="adm.authTester()"
                  >
                    <i
                      class="ph"
                      :class="adm.authEssaiEnCours ? 'ph-spinner-gap animate-spin' : 'ph-pulse'"
                      aria-hidden="true"
                    ></i>
                    {{ adm.authEssaiEnCours ? "Contrôle en cours…" : "Contrôler les réglages" }}
                  </button>
                </div>
                <p id="ent-essai-aide" class="adm-card__hint">
                  Découverte, certificat et clés de signature, avec les réglages affichés, enregistrés ou non.
                  Rien n'est écrit.
                </p>
                <div aria-live="polite" class="space-y-2">
                  <p v-if="adm.authEssaiErreur" id="ent-essai-erreur" class="adm-field__warn">
                    {{ adm.authEssaiErreur }}
                  </p>
                  <template v-if="adm.authEssai">
                    <p id="ent-essai-synthese" class="text-xs font-medium text-slate-800">{{ synthese }}</p>
                    <EtapesEssai :steps="adm.authEssai.steps" />
                  </template>
                </div>
              </div>

              <div class="space-y-2" data-essai-connexion>
                <div class="flex items-center gap-2 flex-wrap">
                  <span class="adm-field__label" aria-hidden="true">b.</span>
                  <button
                    id="ent-trial"
                    type="button"
                    class="adm-btn adm-tool adm-btn--sm"
                    aria-describedby="ent-trial-aide"
                    :disabled="adm.authTrialEnCours || adm.authTrialAttente || !!adm.authRaisonTrial"
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
                          : "Se connecter pour essayer"
                    }}
                  </button>
                </div>
                <p id="ent-trial-aide" class="adm-card__hint" data-raison-essai>
                  {{
                    adm.authRaisonTrial ||
                    "Ouvre le service de votre organisation dans un nouvel onglet, avec les réglages enregistrés : aucun compte n'est créé."
                  }}
                </p>
                <div aria-live="polite" class="space-y-2">
                  <p v-if="adm.authTrialErreur" id="ent-trial-erreur" class="adm-field__warn">
                    {{ adm.authTrialErreur }}
                  </p>
                  <EtapesEssai
                    v-if="adm.authTrialEtapes.some((x) => x.level !== 'ok')"
                    :steps="adm.authTrialEtapes"
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
              </div>
            </section>

            <section class="space-y-3" aria-labelledby="ent-s8-h" data-section-tiroir="activation">
              <h3 id="ent-s8-h" class="adm-user-edit__legend">8. Activation</h3>
              <p class="adm-card__hint">Conditions, d'après les réglages enregistrés :</p>
              <ul class="space-y-1" aria-label="Conditions d'activation" data-conditions-activation>
                <li
                  v-for="c in adm.authConditions"
                  :key="c.id"
                  class="flex items-start gap-1.5 text-xs"
                  :class="c.ok ? 'text-slate-700' : 'text-red-600'"
                  :data-condition="c.id"
                  :data-ok="c.ok ? 'oui' : 'non'"
                >
                  <span class="shrink-0 font-mono" aria-hidden="true">{{ c.ok ? "✓" : "✗" }}</span>
                  <span class="sr-only">{{ c.ok ? "Remplie" : "Manquante" }} :</span>
                  <span>{{ c.libelle }}</span>
                </li>
              </ul>
              <div class="flex items-center gap-3 flex-wrap" data-bascule>
                <button
                  :id="actif ? 'ent-desactiver' : 'ent-activer'"
                  type="button"
                  class="adm-btn adm-tool"
                  aria-describedby="ent-bascule-aide"
                  :disabled="adm.authBusy || (!actif && !!adm.authRaisonActiver)"
                  :title="
                    actif
                      ? 'Désactive ce fournisseur.'
                      : adm.authRaisonActiver || 'Active ce fournisseur pour la connexion.'
                  "
                  @click="adm.authBasculer(!actif)"
                >
                  {{ actif ? "Désactiver" : "Activer" }}
                </button>
                <span id="ent-bascule-aide" class="adm-card__hint" data-raison-activer>
                  {{
                    actif
                      ? "Désactiver ferme les sessions des comptes rattachés à ce fournisseur."
                      : adm.authRaisonActiver || "Toutes les conditions sont remplies."
                  }}
                </span>
              </div>
            </section>

            <section class="adm-card adm-zone" aria-labelledby="ent-zone-h" data-section-tiroir="zone">
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
                      aria-describedby="ent-supprimer-aide"
                      :disabled="adm.authBusy || !!raisonSupprimer"
                      :title="raisonSupprimer || 'Supprime le fournisseur et son secret.'"
                      @click="adm.authSupprimer(f.id)"
                    >
                      <i class="ph ph-trash" aria-hidden="true"></i> Supprimer
                    </button>
                    <span id="ent-supprimer-aide" class="adm-card__hint" data-raison-supprimer>
                      {{ raisonSupprimer || "Supprime le fournisseur et son secret." }}
                    </span>
                  </div>
                </div>
              </div>
            </section>
          </div>

          <p v-if="adm.authTiroirErreur" class="adm-field__warn px-5 pt-2" role="alert" data-tiroir-erreur>
            {{ adm.authTiroirErreur }}
          </p>
          <footer class="adm-drawer__foot">
            <span v-if="adm.authRolesBloque" class="adm-field__warn mr-auto" data-raison-enregistrer>
              Exigez d'abord un second facteur (section 4).
            </span>
            <button type="button" class="adm-btn adm-btn--quiet" @click="adm.authFermer()">Annuler</button>
            <button
              id="ent-enregistrer-fournisseur"
              type="button"
              class="adm-btn adm-btn--primary"
              :disabled="adm.authBusy || adm.authRolesBloque"
              :title="adm.authRolesBloque ? 'Exigez d\'abord un second facteur (section 4).' : undefined"
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
