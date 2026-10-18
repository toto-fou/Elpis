<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/admin/PageSecurite.vue — pages Mots de passe, sessions et droits par défaut. -->
<script setup lang="ts">
import { domaineAdmin } from "../../features/admin/domaine";

const adm = domaineAdmin();
</script>

<template>
  <div v-if="['sessions', 'https'].includes(adm.adminTab)" class="animate-[fadeIn_0.2s]">
    <div class="space-y-6 min-w-0">
      <section v-if="adm.adminTab === 'sessions'" id="password-policy" class="adm-card scroll-mt-32">
        <header class="adm-card__head">
          <i class="ph ph-password adm-card__icon" aria-hidden="true"></i>
          <div>
            <h3 class="adm-card__title">Mots de passe</h3>
            <span class="sr-only">Contraintes vérifiées à la création et au changement de mot de passe.</span>
          </div>
        </header>
        <div
          v-if="adm.configForm && adm.configForm.security && adm.configForm.security.password_policy"
          class="adm-rows"
        >
          <div class="adm-row">
            <div>
              <label class="adm-row__label" title="0 = aucun minimum." for="sec-pwd-len"
                >Longueur minimale</label
              >
              <span class="sr-only">0 = aucun minimum.</span>
            </div>
            <input
              id="sec-pwd-len"
              v-model.number="adm.configForm.security.password_policy.min_length"
              data-field="config:security.password_policy.min_length"
              type="number"
              min="0"
              max="128"
              class="set-input adm-num"
            />
          </div>

          <div class="adm-row adm-row--top">
            <div>
              <span class="adm-row__label" title="Chaque case ajoute une contrainte."
                >Caractères obligatoires</span
              >
              <span class="sr-only">Chaque case ajoute une contrainte.</span>
            </div>
            <div class="space-y-2">
              <label class="flex items-center gap-2 cursor-pointer">
                <input
                  v-model="adm.configForm.security.password_policy.require_uppercase"
                  type="checkbox"
                  data-field="config:security.password_policy.require_uppercase"
                  class="w-4 h-4 text-blue-600 border-slate-300 rounded focus:ring-blue-500"
                />
                <span class="text-sm text-slate-700">Une majuscule</span>
              </label>
              <label class="flex items-center gap-2 cursor-pointer">
                <input
                  v-model="adm.configForm.security.password_policy.require_lowercase"
                  type="checkbox"
                  data-field="config:security.password_policy.require_lowercase"
                  class="w-4 h-4 text-blue-600 border-slate-300 rounded focus:ring-blue-500"
                />
                <span class="text-sm text-slate-700">Une minuscule</span>
              </label>
              <label class="flex items-center gap-2 cursor-pointer">
                <input
                  v-model="adm.configForm.security.password_policy.require_numbers"
                  type="checkbox"
                  data-field="config:security.password_policy.require_numbers"
                  class="w-4 h-4 text-blue-600 border-slate-300 rounded focus:ring-blue-500"
                />
                <span class="text-sm text-slate-700">Un chiffre</span>
              </label>
              <label class="flex items-center gap-2 cursor-pointer">
                <input
                  v-model="adm.configForm.security.password_policy.require_special"
                  type="checkbox"
                  data-field="config:security.password_policy.require_special"
                  class="w-4 h-4 text-blue-600 border-slate-300 rounded focus:ring-blue-500"
                />
                <span class="text-sm text-slate-700">Un caractère spécial</span>
              </label>
            </div>
          </div>
        </div>
      </section>

      <section v-if="adm.adminTab === 'sessions'" id="sessions" class="adm-card scroll-mt-32">
        <header class="adm-card__head">
          <i class="ph ph-cookie adm-card__icon" aria-hidden="true"></i>
          <div>
            <h3 class="adm-card__title">Sessions &amp; cookie</h3>
            <span class="sr-only">Durée de connexion, attributs du cookie, révocation.</span>
          </div>
        </header>
        <div
          v-if="adm.configForm && adm.configForm.security && adm.configForm.security.session"
          class="adm-rows"
        >
          <div class="adm-row">
            <div>
              <label
                class="adm-row__label"
                title="Au-delà, reconnexion obligatoire. Effet immédiat après enregistrement."
                for="sec-max-age"
                >Durée de connexion</label
              >
              <span class="sr-only"
                >Au-delà, reconnexion obligatoire. Effet immédiat après enregistrement.</span
              >
            </div>
            <div class="flex items-center gap-2">
              <input
                id="sec-max-age"
                v-model.number="adm.configForm.security.session.max_age_sec"
                data-field="config:security.session.max_age_sec"
                type="number"
                min="60"
                max="2592000"
                class="set-input adm-num"
              />
              <span class="adm-unit"
                >s
                <template v-if="adm.configForm.security.session.max_age_sec >= 60"
                  >≈ {{ (adm.configForm.security.session.max_age_sec / 3600).toFixed(1) }} h</template
                >
              </span>
            </div>
          </div>

          <div class="adm-row">
            <div>
              <label
                class="adm-row__label"
                title="0 = jamais. Effet immédiat après enregistrement."
                for="sec-idle"
                >Déconnexion sur inactivité</label
              >
              <span class="sr-only">0 = jamais. Effet immédiat après enregistrement.</span>
            </div>
            <div class="flex items-center gap-2">
              <input
                id="sec-idle"
                v-model.number="adm.configForm.security.session.idle_timeout_sec"
                data-field="config:security.session.idle_timeout_sec"
                type="number"
                min="0"
                max="86400"
                class="set-input adm-num"
              />
              <span class="adm-unit"
                >s
                <template v-if="adm.configForm.security.session.idle_timeout_sec >= 60"
                  >≈ {{ (adm.configForm.security.session.idle_timeout_sec / 60).toFixed(0) }} min</template
                >
              </span>
            </div>
          </div>

          <div class="adm-row">
            <div>
              <span
                class="adm-row__label"
                title="Le navigateur n'envoie plus le cookie en HTTP. Suit l'accès HTTPS."
                >Cookie chiffré</span
              >
            </div>
            <div class="flex items-center gap-3 flex-wrap">
              <span
                id="sec-https-only"
                class="adm-pill"
                :data-state="adm.configForm.security.session.https_only ? 'on' : 'off'"
              >
                <i
                  class="ph"
                  :class="
                    adm.configForm.security.session.https_only ? 'ph-lock-simple' : 'ph-lock-simple-open'
                  "
                  aria-hidden="true"
                ></i>
                {{ adm.configForm.security.session.https_only ? "Actif" : "Inactif" }}
              </span>
              <button type="button" class="adm-link" @click="adm.goAdminPage('https')">
                Suit l’accès HTTPS
              </button>
            </div>
          </div>

          <details class="adm-details adm-details--rows">
            <summary title="Portée et nom du cookie de session">Avancé</summary>
            <div class="adm-row">
              <div>
                <label
                  class="adm-row__label"
                  title="Portée du cookie. « strict » coupe les liens entrants ; « none » impose HTTPS. Nécessite un redémarrage."
                  for="sec-samesite"
                  >Portée</label
                >
                <span class="sr-only"
                  >« strict » coupe les liens entrants ; « none » impose HTTPS. Nécessite un
                  redémarrage.</span
                >
              </div>
              <select
                id="sec-samesite"
                v-model="adm.configForm.security.session.same_site"
                data-field="config:security.session.same_site"
                class="set-select w-full max-w-[16rem]"
              >
                <option value="lax">lax — recommandé</option>
                <option value="strict">strict</option>
                <option value="none">none — requiert HTTPS</option>
              </select>
            </div>

            <div class="adm-row">
              <div>
                <label class="adm-row__label" title="Nécessite un redémarrage." for="sec-cookie-name"
                  >Nom du cookie</label
                >
                <span class="sr-only">Nécessite un redémarrage.</span>
              </div>
              <input
                id="sec-cookie-name"
                v-model="adm.configForm.security.session.cookie_name"
                data-field="config:security.session.cookie_name"
                placeholder="mcpwebui_session"
                class="set-input font-mono text-xs max-w-sm"
              />
            </div>
          </details>

          <div class="adm-row adm-row--top">
            <div>
              <span class="adm-row__label" title="Déconnecte tout le monde sauf vous, immédiatement."
                >Révoquer les sessions</span
              >
              <span class="sr-only">Déconnecte tout le monde sauf vous, immédiatement.</span>
              <p
                v-if="adm.securityOverview && adm.securityOverview.session_cfg.global_min_ts > 0"
                class="text-xs text-slate-500 mt-1.5"
              >
                Dernière révocation le
                {{ new Date(adm.securityOverview.session_cfg.global_min_ts * 1000).toLocaleString("fr-FR") }}.
              </p>
            </div>
            <div>
              <button
                type="button"
                :disabled="adm.securityBusy"
                class="adm-btn adm-btn--danger"
                @click="adm.revokeAllSessions()"
              >
                <i class="ph ph-sign-out" aria-hidden="true"></i> Révoquer toutes les sessions
              </button>
            </div>
          </div>

          <div
            v-if="
              adm.securityOverview &&
              adm.securityOverview.revoked_users &&
              adm.securityOverview.revoked_users.length
            "
            class="adm-row adm-row--top"
          >
            <div>
              <span class="adm-row__label">Révocations individuelles</span>
              <p class="adm-row__hint">
                {{ adm.securityOverview.revoked_users.length }} compte(s) concerné(s).
              </p>
            </div>
            <div class="space-y-2">
              <div
                v-for="ru in adm.securityOverview.revoked_users"
                :key="'ru_' + ru.user_id"
                class="flex items-center justify-between gap-3 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2"
              >
                <div class="min-w-0 text-sm">
                  <span class="font-mono text-amber-900">{{ ru.username }}</span>
                  <span class="text-xs text-amber-800 ml-2"
                    >depuis le {{ new Date(ru.session_min_ts * 1000).toLocaleString("fr-FR") }}</span
                  >
                </div>
                <button
                  :disabled="adm.securityBusy"
                  type="button"
                  class="adm-link shrink-0"
                  @click="adm.clearUserRevocation(ru.user_id, ru.username)"
                >
                  Lever
                </button>
              </div>
            </div>
          </div>
        </div>
        <div v-else class="px-5 py-6"><div class="adm-skeleton w-48"></div></div>
      </section>

      <section v-if="adm.adminTab === 'https'" id="https" class="adm-card scroll-mt-32">
        <header class="adm-card__head">
          <i class="ph ph-lock-key adm-card__icon" aria-hidden="true"></i>
          <div>
            <h3 class="adm-card__title">Accès HTTPS</h3>
            <span class="sr-only"
              >Chiffrement via le frontal Caddy. Débloque aussi les notifications du navigateur.</span
            >
          </div>
        </header>
        <div v-if="adm.httpsStatus" class="adm-rows">
          <div class="adm-row">
            <div>
              <span class="adm-row__label" title="Mode d'accès servi aux navigateurs.">État</span>
              <span class="sr-only">Mode d'accès servi aux navigateurs.</span>
            </div>
            <div>
              <span
                v-if="adm.httpsStatus.enabled"
                class="inline-flex items-center gap-1.5 text-xs font-medium text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-full px-2.5 py-1"
              >
                <i class="ph ph-lock-simple" aria-hidden="true"></i> HTTPS — l'application n'écoute qu'en
                local
              </span>
              <span
                v-else
                class="inline-flex items-center gap-1.5 text-xs font-medium text-slate-700 bg-slate-100 border border-slate-200 rounded-full px-2.5 py-1"
              >
                <i class="ph ph-lock-simple-open" aria-hidden="true"></i> HTTP direct —
                {{
                  adm.httpsStatus.listen === "local"
                    ? "écoute sur ce serveur seulement"
                    : "ports ouverts sur le réseau local"
                }}
              </span>
            </div>
          </div>

          <div v-if="!adm.httpsStatus.enabled && adm.httpsStatus.listen" class="adm-row">
            <div>
              <label
                class="adm-row__label"
                for="sec-listen"
                title="Adresse d'écoute des ports 8001/8002 en HTTP direct. Redémarre l'application."
                >Écoute</label
              >
              <span class="sr-only"
                >Adresse d'écoute des ports 8001/8002 en HTTP direct. Redémarre l'application.</span
              >
            </div>
            <div>
              <select
                id="sec-listen"
                class="set-select w-full max-w-[16rem]"
                :value="adm.httpsStatus.listen"
                :disabled="adm.httpsBusy"
                @change="adm.setListen(($event.target as HTMLInputElement).value, $event)"
              >
                <option
                  value="local"
                  :disabled="!adm.httpsStatus.client_local && adm.httpsStatus.listen !== 'local'"
                >
                  Ce serveur (127.0.0.1)
                </option>
                <option value="lan">Réseau local (0.0.0.0)</option>
              </select>
              <p
                v-if="!adm.httpsStatus.client_local && adm.httpsStatus.listen === 'lan'"
                class="text-xs text-slate-500 mt-1"
              >
                « Ce serveur » : depuis la machine elle-même.
              </p>
            </div>
          </div>

          <div class="adm-row">
            <div>
              <span class="adm-row__label" title="Sondes locales sur les ports du frontal."
                >Frontal Caddy</span
              >
              <span class="sr-only">Sondes locales sur les ports du frontal.</span>
            </div>
            <div class="flex flex-wrap items-center gap-1.5">
              <span
                v-for="(up, svc) in adm.httpsStatus.caddy"
                :key="'caddy_' + svc"
                :class="
                  up
                    ? 'text-emerald-800 bg-emerald-50 border-emerald-200'
                    : 'text-rose-800 bg-rose-50 border-rose-200'
                "
                class="inline-flex items-center gap-1.5 text-xs font-medium border rounded-full px-2.5 py-1"
              >
                <i class="ph" :class="up ? 'ph-check-circle' : 'ph-x-circle'" aria-hidden="true"></i>
                {{ svc }} :{{ adm.httpsStatus.ports[svc] }} — {{ up ? "détecté" : "absent" }}
              </span>
            </div>
          </div>

          <div class="adm-row adm-row--top">
            <div>
              <span
                class="adm-row__label"
                :title="
                  'Redémarre l’application, puis vous redirige vers la nouvelle adresse.' +
                  (adm.httpsStatus.enabled ? ' Le cookie redevient non chiffré : reconnexion requise.' : '')
                "
                >{{ adm.httpsStatus.enabled ? "Repasser en HTTP" : "Activer le HTTPS" }}</span
              >
            </div>
            <div>
              <button
                :disabled="
                  adm.httpsBusy ||
                  (!adm.httpsStatus.enabled && !(adm.httpsStatus.caddy.main && adm.httpsStatus.caddy.admin))
                "
                type="button"
                :class="adm.httpsStatus.enabled ? 'adm-tool' : 'adm-btn--primary'"
                class="adm-btn"
                @click="adm.toggleHttps()"
              >
                <i
                  class="ph"
                  :class="adm.httpsStatus.enabled ? 'ph-lock-simple-open' : 'ph-lock-simple'"
                  aria-hidden="true"
                ></i>
                {{ adm.httpsStatus.enabled ? "Repasser en HTTP direct" : "Activer le HTTPS" }}
              </button>
              <p
                v-if="
                  !adm.httpsStatus.enabled && !(adm.httpsStatus.caddy.main && adm.httpsStatus.caddy.admin)
                "
                class="text-xs text-rose-800 bg-rose-50 border border-rose-200 rounded-md px-2.5 py-1.5 mt-2 max-w-[46ch]"
              >
                Caddy n'est pas détecté. Lancez
                <code class="font-mono bg-rose-100 px-1 rounded">sudo deploy/caddy/install_caddy.sh</code>
                sur le serveur, puis rafraîchissez cette page.
              </p>
              <p
                v-if="adm.httpsRedirectUrl"
                class="text-xs text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-md px-2.5 py-1.5 mt-2"
              >
                Bascule lancée — redirection vers
                <span class="font-mono">{{ adm.httpsRedirectUrl }}</span> dans quelques secondes.
              </p>
            </div>
          </div>
        </div>
        <div v-else class="px-5 py-6"><div class="adm-skeleton w-48"></div></div>
      </section>
    </div>
  </div>
</template>
