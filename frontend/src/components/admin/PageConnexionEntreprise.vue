<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/admin/PageConnexionEntreprise.vue — page Utilisateurs & accès › SSO OpenID Connect : état, puis prérequis, fournisseurs, comptes existants et mots de passe locaux, dans l'ordre du parcours. -->
<script setup lang="ts">
import { computed } from "vue";

import { domaineAdmin } from "../../features/admin/domaine";
import { heureCourte } from "../../features/admin/horodatage";
import { etatFournisseur, raisonInoperant } from "../../features/admin/identite";
import TiroirFournisseurAuth from "./TiroirFournisseurAuth.vue";

const adm = domaineAdmin();

const MODES = [
  { id: "all", label: "Tous les comptes" },
  { id: "admins", label: "Administrateurs seulement" },
] as const;

const comptes = (n: number): string => `${n} compte${n > 1 ? "s" : ""} rattaché${n > 1 ? "s" : ""}`;
const prerequis = computed(() => adm.authEtat?.prerequisites ?? null);
const carteGrisee = computed(() => adm.prelinkRaison !== "");
/** Champs grisés de la carte 3 reliés à la raison écrite sous le choix du fournisseur. */
const raisonCarte = computed(() => (carteGrisee.value ? "ent-prelien-raison" : undefined));
/** Phrase de la carte d'état : les fournisseurs actifs, sinon qui peut encore se connecter. */
const phraseEtat = computed(() => {
  const etat = adm.authEtat;
  if (!etat) return "";
  if (adm.authActifs.length) return `Fournisseurs actifs : ${adm.authActifs.map((p) => p.label).join(", ")}.`;
  if (etat.local.mode === "admins")
    return "⚠ Aucun fournisseur actif et mots de passe locaux réservés aux administrateurs : seuls les administrateurs peuvent se connecter.";
  return [...etat.providers, ...etat.invalid_providers].some((p) => p.enabled)
    ? "⚠ Aucun fournisseur activé n'est opérant (carte 2) : seule la connexion locale fonctionne."
    : "Aucun fournisseur activé : seule la connexion par mot de passe local fonctionne.";
});
</script>

<template>
  <div v-if="adm.adminTab === 'oidc'" class="animate-[fadeIn_0.2s]">
    <div v-if="!adm.authEtat || !prerequis" class="space-y-6 min-w-0" aria-busy="true">
      <section v-for="n in 5" :key="n" class="adm-card">
        <div class="adm-card__head"><div class="adm-skeleton w-40"></div></div>
        <div class="adm-rows">
          <div class="adm-row">
            <div class="adm-skeleton w-32"></div>
            <div class="adm-skeleton w-full"></div>
          </div>
        </div>
      </section>
    </div>

    <div v-else class="space-y-6 min-w-0">
      <section id="ent-etat" class="adm-card scroll-mt-32">
        <header class="adm-card__head">
          <i class="ph ph-plugs-connected adm-card__icon" aria-hidden="true"></i>
          <div>
            <h3 class="adm-card__title">
              {{ adm.authActifs.length ? "SSO OpenID Connect actif" : "Connexion locale seule" }}
            </h3>
            <p class="adm-card__hint" role="status" data-etat-page>{{ phraseEtat }}</p>
          </div>
        </header>
      </section>

      <section id="ent-prerequis" class="adm-card scroll-mt-32" aria-labelledby="ent-prerequis-h">
        <header class="adm-card__head">
          <i class="ph ph-list-checks adm-card__icon" aria-hidden="true"></i>
          <div>
            <h3 id="ent-prerequis-h" class="adm-card__title">1. Prérequis</h3>
            <p class="adm-card__hint">À réunir avant d'activer un fournisseur.</p>
          </div>
        </header>
        <ul class="adm-rows" aria-label="Prérequis">
          <li
            class="adm-row adm-row--top"
            :class="{ 'ent-ko': !prerequis.public_url_https }"
            data-prerequis="public_url"
          >
            <div>
              <span class="adm-row__label">
                <span aria-hidden="true">{{ prerequis.public_url_https ? "✓" : "✗" }}</span> Adresse publique
                en https<span class="sr-only">
                  : condition {{ prerequis.public_url_https ? "remplie" : "manquante" }}</span
                >
              </span>
              <p class="adm-card__hint">
                {{
                  prerequis.public_url_https
                    ? "Renseignée."
                    : "Renseignez l'adresse publique ci-contre, puis enregistrez."
                }}
              </p>
            </div>
            <div>
              <div class="adm-field__row">
                <input
                  id="ent-url"
                  v-model="adm.authUrl"
                  type="url"
                  class="set-input flex-1 font-mono text-xs"
                  placeholder="https://elpis.example.lan"
                  autocomplete="off"
                  aria-label="Adresse publique"
                  aria-describedby="ent-url-aide"
                  :disabled="!!adm.authUrlFigee"
                  :title="adm.authUrlFigee"
                />
                <button
                  id="ent-enregistrer-url"
                  type="button"
                  class="adm-btn adm-btn--primary adm-btn--sm"
                  :disabled="adm.authBusy || !adm.authUrlModifiee || !!adm.authUrlFigee"
                  @click="adm.authEnregistrerReglages('url')"
                >
                  Enregistrer
                </button>
              </div>
              <p id="ent-url-aide" class="adm-card__hint" data-url-aide>
                {{
                  adm.authUrlFigee ||
                  "Adresse https par laquelle vos utilisateurs ouvrent Elpis, sans chemin."
                }}
              </p>
              <p v-if="adm.authUrlErreur" class="adm-field__warn" role="alert">{{ adm.authUrlErreur }}</p>
            </div>
          </li>
          <li class="adm-row" :class="{ 'ent-ko': !prerequis.cookie_secure }" data-prerequis="https">
            <div>
              <span class="adm-row__label">
                <span aria-hidden="true">{{ prerequis.cookie_secure ? "✓" : "✗" }}</span> Accès HTTPS<span
                  class="sr-only"
                >
                  : condition {{ prerequis.cookie_secure ? "remplie" : "manquante" }}</span
                >
              </span>
              <p class="adm-card__hint">
                {{
                  prerequis.cookie_secure
                    ? "En service : le cookie de session est sécurisé."
                    : "Activez l'accès HTTPS, puis redémarrez."
                }}
              </p>
            </div>
            <div>
              <button
                id="ent-ouvrir-https"
                type="button"
                class="adm-btn adm-tool adm-btn--sm"
                @click="adm.goAdminPage('https')"
              >
                <i class="ph ph-lock-key" aria-hidden="true"></i> Ouvrir Accès HTTPS
              </button>
            </div>
          </li>
          <li class="adm-row" :class="{ 'ent-ko': prerequis.local_admins < 1 }" data-prerequis="local_admin">
            <div>
              <span class="adm-row__label">
                <span aria-hidden="true">{{ prerequis.local_admins >= 1 ? "✓" : "✗" }}</span> Administrateur à
                mot de passe local<span class="sr-only">
                  : condition {{ prerequis.local_admins >= 1 ? "remplie" : "manquante" }}</span
                >
              </span>
              <p class="adm-card__hint">
                {{
                  prerequis.local_admins >= 1
                    ? "Présent : il reste l'accès de secours."
                    : "Gardez au moins un administrateur avec un mot de passe local."
                }}
              </p>
            </div>
          </li>
        </ul>
      </section>

      <section id="ent-fournisseurs" class="adm-card scroll-mt-32">
        <header class="adm-card__head">
          <i class="ph ph-identification-card adm-card__icon" aria-hidden="true"></i>
          <div>
            <h3 class="adm-card__title">2. Fournisseurs</h3>
            <p class="adm-card__hint">
              {{
                adm.authEtat.providers.length >= adm.authEtat.bounds.providers_max
                  ? `${adm.authEtat.bounds.providers_max} fournisseurs au plus : supprimez-en un pour en ajouter.`
                  : "Chaque fournisseur est créé éteint, puis activé une fois ses conditions remplies."
              }}
            </p>
          </div>
          <div class="adm-card__actions">
            <button
              id="ent-ajouter"
              type="button"
              class="adm-btn adm-tool adm-btn--sm"
              :disabled="adm.authEtat.providers.length >= adm.authEtat.bounds.providers_max"
              :title="
                adm.authEtat.providers.length >= adm.authEtat.bounds.providers_max
                  ? `${adm.authEtat.bounds.providers_max} fournisseurs au plus.`
                  : ''
              "
              @click="adm.authNouveau()"
            >
              <i class="ph ph-plus" aria-hidden="true"></i> Ajouter
            </button>
          </div>
        </header>
        <ul
          v-if="adm.authEtat.providers.length || adm.authEtat.invalid_providers.length"
          class="adm-rows"
          aria-label="Fournisseurs déclarés"
        >
          <li
            v-for="p in adm.authEtat.providers"
            :key="p.id"
            class="adm-row adm-row--full"
            :data-fournisseur="p.id"
          >
            <div class="flex items-center gap-3 min-w-0">
              <div class="min-w-0 flex-1">
                <div class="font-medium text-sm truncate">{{ p.label }}</div>
                <div class="adm-card__hint">
                  SSO OpenID Connect · {{ comptes(p.identities)
                  }}<span v-if="etatFournisseur(p).alerte" data-raison-inoperant>
                    · {{ raisonInoperant(adm.authEtat, p) }}</span
                  >
                </div>
              </div>
              <span class="adm-pill" :class="{ 'adm-pill--warn': etatFournisseur(p).alerte }">{{
                etatFournisseur(p).libelle
              }}</span>
              <button
                type="button"
                class="adm-btn adm-btn--quiet adm-btn--sm"
                :aria-label="'Modifier ' + p.label"
                @click="adm.authModifier(p.id)"
              >
                <i class="ph ph-pencil-simple" aria-hidden="true"></i> Modifier
              </button>
            </div>
          </li>
          <li
            v-for="(p, i) in adm.authEtat.invalid_providers"
            :key="'x' + i + (p.id ?? '')"
            class="adm-row adm-row--full"
          >
            <div class="flex items-center gap-3 min-w-0">
              <div class="min-w-0 flex-1">
                <div class="font-medium text-sm truncate">
                  {{ p.label ?? p.id ?? "Fournisseur illisible" }}
                </div>
                <div class="adm-card__hint">
                  Réglages illisibles : ce fournisseur n'est jamais actif.{{
                    p.id === null ? " Demandez à votre administrateur de le retirer." : ""
                  }}
                </div>
              </div>
              <span class="adm-pill adm-pill--warn">Illisible</span>
              <button
                v-if="p.id !== null"
                type="button"
                class="adm-btn adm-btn--quiet adm-btn--danger-quiet adm-btn--sm"
                :disabled="adm.authBusy"
                @click="adm.authSupprimer(p.id, false)"
              >
                <i class="ph ph-trash" aria-hidden="true"></i> Supprimer
              </button>
            </div>
          </li>
        </ul>
        <p v-else class="adm-empty px-5 py-4">Aucun fournisseur déclaré.</p>
        <p v-if="adm.authListeErreur" class="adm-field__warn px-5 pb-3" role="alert">
          {{ adm.authListeErreur }}
        </p>
      </section>

      <section id="ent-comptes" class="adm-card scroll-mt-32" aria-labelledby="ent-prelien-h" data-prelinks>
        <header class="adm-card__head">
          <i class="ph ph-link adm-card__icon" aria-hidden="true"></i>
          <div>
            <h3 id="ent-prelien-h" class="adm-card__title">3. Comptes existants</h3>
            <p class="adm-card__hint">
              À sa première connexion par ce fournisseur, la personne saisit une fois son ancien mot de passe
              Elpis, sauf dispense ci-dessous.
            </p>
          </div>
        </header>
        <div class="adm-rows">
          <div class="adm-row adm-row--top">
            <div><label class="adm-row__label" for="ent-prelien-fournisseur">Fournisseur</label></div>
            <div>
              <select
                id="ent-prelien-fournisseur"
                v-model="adm.prelinkFournisseur"
                class="set-select w-full"
                aria-describedby="ent-prelien-raison"
                :disabled="adm.authEtat.providers.length === 0"
              >
                <option value="">—</option>
                <option v-for="p in adm.authEtat.providers" :key="p.id" :value="p.id">{{ p.label }}</option>
              </select>
              <p id="ent-prelien-raison" class="adm-card__hint" data-prelinks-raison>
                {{ adm.prelinkRaison || "Les rattachements ci-dessous valent pour ce fournisseur." }}
              </p>
            </div>
          </div>
          <div class="adm-row adm-row--full">
            <ul v-if="adm.prelinks.length" class="space-y-2" aria-label="Rattachements préparés">
              <li v-for="p in adm.prelinks" :key="p.id" data-prelink>
                <div class="flex items-center gap-2 min-w-0">
                  <div class="min-w-0 flex-1 text-xs">
                    <span class="font-medium">{{ p.username ?? "Compte supprimé" }}</span
                    ><span class="text-slate-500" data-prelink-attendu
                      >{{ " · identifiant attendu : " }}<span class="font-mono">{{ p.expected }}</span></span
                    >
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
          </div>
          <div class="adm-row">
            <div><label class="adm-row__label" for="ent-prelien-compte">Compte local</label></div>
            <select
              id="ent-prelien-compte"
              v-model.number="adm.prelinkForm.user_id"
              class="set-select w-full"
              :aria-describedby="raisonCarte"
              :disabled="carteGrisee"
            >
              <option :value="0">—</option>
              <option v-for="u in adm.prelinkComptes" :key="u.id" :value="u.id">
                {{ u.username
                }}{{ u.is_admin === 1 ? " (administrateur)" : u.is_admin === 2 ? " (modérateur)" : "" }}
              </option>
            </select>
          </div>
          <div class="adm-row">
            <div>
              <label class="adm-row__label" for="ent-prelien-attendu"
                >Identifiant attendu chez le fournisseur</label
              >
              <p class="adm-card__hint">Nom de connexion qu'il transmettra (revendication nom).</p>
            </div>
            <input
              id="ent-prelien-attendu"
              v-model="adm.prelinkForm.expected"
              class="set-input font-mono text-xs"
              maxlength="256"
              autocomplete="off"
              :aria-describedby="raisonCarte"
              :disabled="carteGrisee"
            />
          </div>
          <div class="adm-row adm-row--full">
            <div class="space-y-1">
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
                  :aria-describedby="raisonCarte"
                  :disabled="carteGrisee || adm.prelinkAdmin"
                />
                <span>Identité vérifiée hors ligne : ne pas demander l'ancien mot de passe</span>
              </label>
              <p class="adm-card__hint" data-prelink-dispense-aide>
                À n'utiliser que si votre fournisseur ne laisse pas les personnes changer leur identifiant.
              </p>
              <p class="adm-card__hint" data-prelink-dispense-admin>
                Un administrateur ou un modérateur doit toujours prouver son ancien mot de passe.
              </p>
              <label class="flex items-center gap-2 text-xs" :class="{ 'ent-ko': adm.prelinkAdmin }">
                <input
                  id="ent-prelien-admin"
                  v-model="adm.prelinkForm.confirm_admin"
                  type="checkbox"
                  :aria-describedby="
                    carteGrisee ? 'ent-prelien-raison ent-prelien-admin-aide' : 'ent-prelien-admin-aide'
                  "
                  :disabled="carteGrisee || !adm.prelinkAdmin"
                />
                <span class="adm-row__label"
                  >Je confirme le rattachement de cet administrateur ou modérateur</span
                >
              </label>
              <p id="ent-prelien-admin-aide" class="adm-card__hint" data-prelink-confirmation-aide>
                {{
                  adm.prelinkAdmin
                    ? "Obligatoire pour un administrateur ou un modérateur."
                    : "Sans objet : seulement pour un administrateur ou un modérateur."
                }}
              </p>
            </div>
          </div>
          <div class="adm-row adm-row--full">
            <div class="flex items-center gap-3 flex-wrap">
              <button
                id="ent-prelien-ajouter"
                type="button"
                class="adm-btn adm-tool adm-btn--sm"
                :disabled="adm.prelinksBusy || !adm.prelinkPret"
                @click="adm.prelinkAjouter()"
              >
                <i class="ph ph-plus" aria-hidden="true"></i> Préparer le rattachement
              </button>
              <span v-if="adm.prelinksErreur" class="adm-field__warn" role="alert" data-prelinks-erreur>
                {{ adm.prelinksErreur }}
              </span>
            </div>
          </div>
        </div>
      </section>

      <section id="ent-local" class="adm-card scroll-mt-32" aria-labelledby="ent-local-h">
        <header class="adm-card__head">
          <i class="ph ph-password adm-card__icon" aria-hidden="true"></i>
          <div>
            <h3 id="ent-local-h" class="adm-card__title">4. Mots de passe locaux</h3>
            <p class="adm-card__hint">Qui peut encore se connecter avec un mot de passe local.</p>
          </div>
        </header>
        <div class="adm-rows">
          <div class="adm-row adm-row--top">
            <div><span id="ent-mode-lbl" class="adm-row__label">Connexion locale</span></div>
            <div>
              <div
                class="adm-seg"
                role="group"
                aria-labelledby="ent-mode-lbl"
                aria-describedby="ent-mode-aide"
              >
                <button
                  v-for="m in MODES"
                  :key="m.id"
                  type="button"
                  :data-mode="m.id"
                  class="disabled:opacity-50 disabled:cursor-not-allowed"
                  :class="['adm-seg__btn', adm.authMode === m.id ? 'is-active' : '']"
                  :aria-pressed="adm.authMode === m.id ? 'true' : 'false'"
                  :disabled="m.id === 'admins' && !!adm.authModeAdminsRaison"
                  @click="adm.authMode = m.id"
                >
                  {{ m.label }}
                </button>
              </div>
              <p id="ent-mode-aide" class="adm-card__hint" data-mode-aide>{{ adm.authModeAide }}</p>
            </div>
          </div>
          <div class="adm-row adm-row--full">
            <div class="flex items-center gap-3 flex-wrap">
              <button
                id="ent-enregistrer-mode"
                type="button"
                class="adm-btn adm-btn--primary"
                :disabled="
                  adm.authBusy ||
                  !adm.authModeModifie ||
                  (adm.authMode === 'admins' && !!adm.authModeAdminsRaison)
                "
                @click="adm.authEnregistrerReglages('mode')"
              >
                Enregistrer
              </button>
              <span v-if="adm.authModeErreur" class="adm-field__warn" role="alert">{{
                adm.authModeErreur
              }}</span>
            </div>
          </div>
        </div>
      </section>

      <TiroirFournisseurAuth />
    </div>
  </div>
</template>
