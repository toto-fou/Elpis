<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/admin/PageConnexionEntreprise.vue — page Utilisateurs & accès › Connexion d'entreprise : état, prérequis, réglages généraux et fournisseurs d'identité OpenID Connect, admins. -->
<script setup lang="ts">
import { domaineAdmin } from "../../features/admin/domaine";
import { etatFournisseur } from "../../features/admin/identite";
import TiroirFournisseurAuth from "./TiroirFournisseurAuth.vue";

const adm = domaineAdmin();

const MODES = [
  { id: "all", label: "Tous les comptes" },
  { id: "admins", label: "Administrateurs seulement" },
] as const;

const comptes = (n: number): string => `${n} compte${n > 1 ? "s" : ""} rattaché${n > 1 ? "s" : ""}`;
</script>

<template>
  <div v-if="adm.adminTab === 'enterprise-login'" class="animate-[fadeIn_0.2s]">
    <div v-if="!adm.authEtat" class="space-y-6 min-w-0" aria-busy="true">
      <section v-for="n in 3" :key="n" class="adm-card">
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
              {{ adm.authActifs.length ? "Connexion d'entreprise active" : "Connexion locale seule" }}
            </h3>
            <p class="adm-card__hint" role="status">
              <template v-if="adm.authActifs.length">
                Fournisseurs actifs : {{ adm.authActifs.map((p) => p.label).join(", ") }}.
              </template>
              <template v-else>
                Rien ne change tant qu'aucun fournisseur n'est activé : chacun se connecte comme aujourd'hui.
              </template>
            </p>
          </div>
        </header>
        <ul class="adm-rows" aria-label="Prérequis">
          <li class="adm-row" :class="{ 'ent-ko': !adm.authEtat.prerequisites.public_url_https }">
            <div>
              <span class="adm-row__label">
                {{ adm.authEtat.prerequisites.public_url_https ? "✓" : "✗" }} Adresse publique en https
              </span>
              <p v-if="!adm.authEtat.prerequisites.public_url_https" class="adm-card__hint">
                Renseignez l'adresse publique ci-dessous.
              </p>
            </div>
          </li>
          <li class="adm-row" :class="{ 'ent-ko': !adm.authEtat.prerequisites.cookie_secure }">
            <div>
              <span class="adm-row__label">
                {{ adm.authEtat.prerequisites.cookie_secure ? "✓" : "✗" }} Cookie de session sécurisé
              </span>
              <p v-if="!adm.authEtat.prerequisites.cookie_secure" class="adm-card__hint">
                Activez l'accès HTTPS, puis redémarrez.
              </p>
            </div>
          </li>
          <li class="adm-row" :class="{ 'ent-ko': adm.authEtat.prerequisites.local_admins < 1 }">
            <div>
              <span class="adm-row__label">
                {{ adm.authEtat.prerequisites.local_admins >= 1 ? "✓" : "✗" }} Administrateur local présent
              </span>
              <p v-if="adm.authEtat.prerequisites.local_admins < 1" class="adm-card__hint">
                Gardez au moins un administrateur avec un mot de passe local.
              </p>
            </div>
          </li>
        </ul>
      </section>

      <section id="ent-reglages" class="adm-card scroll-mt-32">
        <header class="adm-card__head">
          <i class="ph ph-gear-six adm-card__icon" aria-hidden="true"></i>
          <div>
            <h3 class="adm-card__title">Réglages généraux</h3>
          </div>
        </header>
        <div class="adm-rows">
          <div class="adm-row">
            <div>
              <label
                class="adm-row__label"
                for="ent-url"
                title="Adresse https par laquelle vos utilisateurs ouvrent Elpis, sans chemin."
                >Adresse publique</label
              >
            </div>
            <div>
              <input
                id="ent-url"
                v-model="adm.authUrl"
                type="url"
                class="set-input w-full font-mono text-xs"
                placeholder="https://elpis.example.lan"
                autocomplete="off"
                :disabled="adm.authEtat.providers.some((p) => p.enabled)"
                :title="
                  adm.authEtat.providers.some((p) => p.enabled)
                    ? 'Désactivez d\'abord les fournisseurs pour changer l\'adresse publique.'
                    : ''
                "
              />
            </div>
          </div>
          <div class="adm-row">
            <div>
              <span
                id="ent-mode-lbl"
                class="adm-row__label"
                title="Qui peut encore se connecter avec un mot de passe local."
                >Connexion locale</span
              >
            </div>
            <div class="adm-seg" role="group" aria-labelledby="ent-mode-lbl">
              <button
                v-for="m in MODES"
                :key="m.id"
                type="button"
                :class="['adm-seg__btn', adm.authMode === m.id ? 'is-active' : '']"
                :aria-pressed="adm.authMode === m.id ? 'true' : 'false'"
                @click="adm.authMode = m.id"
              >
                {{ m.label }}
              </button>
            </div>
          </div>
          <div class="adm-row adm-row--full">
            <div class="flex items-center gap-3 flex-wrap">
              <button
                id="ent-enregistrer"
                type="button"
                class="adm-btn adm-btn--primary"
                :disabled="adm.authBusy || !adm.authReglagesModifies"
                @click="adm.authEnregistrerReglages()"
              >
                Enregistrer
              </button>
              <span v-if="adm.authReglagesErreur" class="adm-field__warn" role="alert">{{
                adm.authReglagesErreur
              }}</span>
            </div>
          </div>
        </div>
      </section>

      <section id="ent-fournisseurs" class="adm-card scroll-mt-32">
        <header class="adm-card__head">
          <i class="ph ph-identification-card adm-card__icon" aria-hidden="true"></i>
          <div>
            <h3 class="adm-card__title">Fournisseurs</h3>
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
          <li v-for="p in adm.authEtat.providers" :key="p.id" class="adm-row adm-row--full">
            <div class="flex items-center gap-3 min-w-0">
              <div class="min-w-0 flex-1">
                <div class="font-medium text-sm truncate">{{ p.label }}</div>
                <div class="adm-card__hint">SSO OpenID Connect · {{ comptes(p.identities) }}</div>
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
      </section>

      <TiroirFournisseurAuth />
    </div>
  </div>
</template>
