<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/admin/PageConnexionEntreprise.vue — page Utilisateurs & accès › Connexion d'entreprise : état, prérequis, réglages généraux et fournisseurs d'identité (LDAP, OIDC), admins. -->
<script setup lang="ts">
import type { EtatBalayageConsole } from "@elpis/contracts";

import { domaineAdmin } from "../../features/admin/domaine";
import { dateRelative, phraseAbandon } from "../../features/admin/rattachement";
import { heureLocale } from "../../features/admin/horodatage";
import TiroirFournisseurAuth from "./TiroirFournisseurAuth.vue";
import TiroirRattachement from "./TiroirRattachement.vue";

const adm = domaineAdmin();

const MODES = [
  { id: "all", label: "Tous les comptes" },
  { id: "admins", label: "Administrateurs seulement" },
] as const;

const TYPES = { ldap: "Annuaire LDAP", oidc: "SSO OpenID Connect" } as const;

const comptes = (n: number): string => `${n} compte${n > 1 ? "s" : ""} rattaché${n > 1 ? "s" : ""}`;

const pluriel = (n: number, mot: string, accord = ""): string => `${n} ${mot}${n > 1 ? "s" : ""}${accord}`;

function resumeBalayage(s: EtatBalayageConsole): string {
  const vus = `${pluriel(s.seen, "compte")} vu${s.seen > 1 ? "s" : ""}`;
  if (s.aborted) return vus;
  return [
    vus,
    pluriel(s.suspended, "suspendu"),
    pluriel(s.reactivated, "réactivé"),
    pluriel(s.unknown, "non lisible"),
  ].join(" · ");
}

function etat(p: { enabled: boolean; active: boolean }): { libelle: string; alerte: boolean } {
  if (p.active) return { libelle: "Actif", alerte: false };
  return p.enabled ? { libelle: "À tester", alerte: true } : { libelle: "Éteint", alerte: false };
}
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
              aria-haspopup="true"
              :aria-expanded="adm.authAjoutOuvert ? 'true' : 'false'"
              :disabled="adm.authEtat.providers.length >= adm.authEtat.bounds.providers_max"
              :title="
                adm.authEtat.providers.length >= adm.authEtat.bounds.providers_max
                  ? `${adm.authEtat.bounds.providers_max} fournisseurs au plus.`
                  : ''
              "
              @click="adm.authAjoutOuvert = !adm.authAjoutOuvert"
            >
              <i class="ph ph-plus" aria-hidden="true"></i> Ajouter
            </button>
          </div>
        </header>
        <div v-if="adm.authAjoutOuvert" class="adm-rows" role="group" aria-label="Type de fournisseur">
          <div class="adm-row adm-row--full">
            <div class="flex gap-2 flex-wrap">
              <button
                id="ent-ajouter-ldap"
                type="button"
                class="adm-btn adm-tool adm-btn--sm"
                @click="adm.authNouveau('ldap')"
              >
                <i class="ph ph-address-book" aria-hidden="true"></i> {{ TYPES.ldap }}
              </button>
              <button
                id="ent-ajouter-oidc"
                type="button"
                class="adm-btn adm-tool adm-btn--sm"
                @click="adm.authNouveau('oidc')"
              >
                <i class="ph ph-key" aria-hidden="true"></i> {{ TYPES.oidc }}
              </button>
            </div>
          </div>
        </div>
        <ul
          v-if="adm.authEtat.providers.length || adm.authEtat.invalid_providers.length"
          class="adm-rows"
          aria-label="Fournisseurs déclarés"
        >
          <li v-for="p in adm.authEtat.providers" :key="p.id" class="adm-row adm-row--full">
            <div class="flex items-center gap-3 min-w-0">
              <div class="min-w-0 flex-1">
                <div class="font-medium text-sm truncate">{{ p.label }}</div>
                <div class="adm-card__hint">{{ TYPES[p.type] }} · {{ comptes(p.identities) }}</div>
              </div>
              <span class="adm-pill" :class="{ 'adm-pill--warn': etat(p).alerte }">{{
                etat(p).libelle
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
            <div v-if="p.type === 'ldap' && p.active" class="space-y-2 min-w-0" data-balayage>
              <div class="flex items-center gap-2 flex-wrap">
                <p class="adm-card__hint min-w-0 flex-1" data-balayage-etat>
                  Dernière vérification de l'annuaire :
                  <template v-if="!p.sweep">Jamais</template>
                  <template v-else>
                    <span :title="heureLocale(p.sweep.at)">{{ dateRelative(p.sweep.at) }}</span>
                    · {{ resumeBalayage(p.sweep) }}
                  </template>
                </p>
                <button
                  type="button"
                  class="adm-btn adm-tool adm-btn--sm"
                  data-balayage-lancer
                  :disabled="adm.balayageEnCours !== null"
                  @click="adm.balayageLancer(p.id)"
                >
                  <i
                    class="ph"
                    :class="
                      adm.balayageEnCours === p.id ? 'ph-spinner-gap animate-spin' : 'ph-arrows-clockwise'
                    "
                    aria-hidden="true"
                  ></i>
                  Vérifier maintenant
                </button>
                <button
                  type="button"
                  class="adm-btn adm-tool adm-btn--sm"
                  data-rattacher
                  @click="adm.assistantOuvrir(p.id)"
                >
                  <i class="ph ph-link" aria-hidden="true"></i> Rattacher les comptes existants
                </button>
              </div>
              <p v-if="p.sweep?.aborted" class="ent-alerte" role="alert" data-balayage-abandon>
                <span class="adm-pill adm-pill--warn mr-1">Abandonnée</span
                >{{ phraseAbandon(p.sweep.aborted) }}
              </p>
              <div
                v-if="p.sweep && p.sweep.pending > 0"
                class="ent-alerte space-y-2"
                role="alert"
                data-balayage-retenues
              >
                <p>
                  {{ pluriel(p.sweep.pending, "compte") }}
                  {{ p.sweep.pending > 1 ? "ne sont plus" : "n'est plus" }} dans l'annuaire ou dans un groupe
                  requis. Par précaution, aucun n'a été désactivé.
                </p>
                <button
                  type="button"
                  class="adm-btn adm-btn--danger adm-btn--sm"
                  data-balayage-confirmer
                  :disabled="adm.balayageEnCours !== null"
                  @click="adm.balayageConfirmer(p.id, p.sweep.pending)"
                >
                  Désactiver {{ p.sweep.pending > 1 ? "ces " + p.sweep.pending + " comptes" : "ce compte" }}
                </button>
              </div>
              <p v-if="adm.balayageMessage[p.id]" class="adm-field__warn" role="alert" data-balayage-message>
                {{ adm.balayageMessage[p.id] }}
              </p>
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
      <TiroirRattachement />
    </div>
  </div>
</template>
