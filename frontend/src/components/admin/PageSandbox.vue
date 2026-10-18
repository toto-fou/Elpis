<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/admin/PageSandbox.vue — pages Sandbox. -->
<script setup lang="ts">
import { domaineAdmin } from "../../features/admin/domaine";

const adm = domaineAdmin();
</script>

<template>
  <div
    v-if="
      ['sandbox-limits', 'sandbox-network', 'sandbox-toolhosts', 'sandbox-containers'].includes(adm.adminTab)
    "
    class="animate-[fadeIn_0.2s]"
  >
    <div class="space-y-6 min-w-0">
      <div
        v-if="adm.execHealthcheck"
        :class="[
          'rounded-lg px-4 py-2.5 text-xs flex items-center gap-3 flex-wrap border',
          adm.execHealthcheck.daemon_ok && adm.execHealthcheck.image_loaded
            ? 'bg-emerald-50 text-emerald-800 border-emerald-200'
            : adm.execHealthcheck.daemon_ok
              ? 'bg-amber-50 text-amber-800 border-amber-200'
              : 'bg-red-50 text-red-800 border-red-200',
        ]"
      >
        <i
          :class="[
            'ph text-base',
            adm.execHealthcheck.daemon_ok && adm.execHealthcheck.image_loaded
              ? 'ph-check-circle'
              : adm.execHealthcheck.daemon_ok
                ? 'ph-warning'
                : 'ph-x-circle',
          ]"
          aria-hidden="true"
        ></i>
        <span
          >Docker <span class="font-mono">{{ adm.execHealthcheck.server_version || "?" }}</span></span
        >
        <span class="opacity-30" aria-hidden="true">•</span>
        <span class="flex items-center gap-1.5 min-w-0">
          <span class="truncate"
            >Image <code class="font-mono">{{ adm.execHealthcheck.image }}</code></span
          >
          <i
            :class="
              adm.execHealthcheck.image_loaded ? 'ph ph-check text-emerald-700' : 'ph ph-x text-red-600'
            "
            :title="adm.execHealthcheck.image_loaded ? 'Image chargée' : 'Image absente'"
          ></i>
        </span>
        <button
          title="Rafraîchir l'état"
          class="ml-auto opacity-70 hover:opacity-100 transition-opacity"
          @click="adm.loadExecConfig"
        >
          <i class="ph ph-arrow-clockwise" aria-hidden="true"></i>
        </button>
      </div>

      <div
        v-if="adm.execHealthcheck && adm.execHealthcheck.daemon_ok && !adm.execHealthcheck.image_loaded"
        class="text-xs text-amber-800 bg-amber-50/60 border border-amber-200 rounded-lg px-3 py-2 font-mono whitespace-pre-line"
      >
        {{ adm.execHealthcheck.image_hint }}
      </div>

      <section v-if="adm.adminTab === 'sandbox-limits'" id="sandbox-limits" class="adm-card scroll-mt-32">
        <header class="adm-card__head">
          <i class="ph ph-gauge adm-card__icon" aria-hidden="true"></i>
          <div>
            <h3 class="adm-card__title">Limites par container</h3>
            <span class="sr-only"
              >Mémoire, CPU et processus s'appliquent au prochain démarrage ; le délai vaut dès la commande
              suivante.</span
            >
          </div>
        </header>
        <div class="adm-rows">
          <div class="adm-row">
            <div>
              <label class="adm-row__label" title="Plafond par container." for="sb-mem">Mémoire</label>
              <span class="sr-only">Plafond par container.</span>
            </div>
            <div class="flex items-center gap-2">
              <input
                id="sb-mem"
                v-model.number="adm.execConfig.limits.memory_mb"
                data-field="exec:limits.memory_mb"
                type="number"
                min="256"
                max="65536"
                class="set-input adm-num font-mono"
              />
              <span class="adm-unit">Mo</span>
            </div>
          </div>
          <div class="adm-row">
            <div>
              <label class="adm-row__label" title="100 = un cœur complet." for="sb-cpu">Processeur</label>
              <span class="sr-only">100 = un cœur complet.</span>
            </div>
            <div class="flex items-center gap-2">
              <input
                id="sb-cpu"
                v-model.number="adm.execConfig.limits.cpu_quota_pct"
                data-field="exec:limits.cpu_quota_pct"
                type="number"
                min="10"
                max="1600"
                class="set-input adm-num font-mono"
              />
              <span class="adm-unit">%</span>
            </div>
          </div>
          <div class="adm-row">
            <div>
              <label class="adm-row__label" title="Garde-fou contre les fork bombs." for="sb-pids"
                >Processus</label
              >
              <span class="sr-only">Garde-fou contre les fork bombs.</span>
            </div>
            <div class="flex items-center gap-2">
              <input
                id="sb-pids"
                v-model.number="adm.execConfig.limits.pids_max"
                data-field="exec:limits.pids_max"
                type="number"
                min="16"
                max="8192"
                class="set-input adm-num font-mono"
              />
              <span class="adm-unit">PIDs max</span>
            </div>
          </div>
          <div class="adm-row">
            <div>
              <label class="adm-row__label" title="Au-delà, la commande est interrompue." for="sb-timeout"
                >Durée d'une commande</label
              >
              <span class="sr-only">Au-delà, la commande est interrompue.</span>
            </div>
            <div class="flex items-center gap-2">
              <input
                id="sb-timeout"
                v-model.number="adm.execConfig.limits.timeout_s"
                data-field="exec:limits.timeout_s"
                type="number"
                min="5"
                max="7200"
                class="set-input adm-num font-mono"
              />
              <span class="adm-unit">s</span>
            </div>
          </div>
        </div>
      </section>

      <section v-if="adm.adminTab === 'sandbox-limits'" id="sandbox-disk" class="adm-card scroll-mt-32">
        <header class="adm-card__head">
          <i class="ph ph-hard-drives adm-card__icon" aria-hidden="true"></i>
          <div>
            <h3 class="adm-card__title">Espace disque</h3>
            <span class="sr-only"
              >Remplissage du quota du compte et du disque qui porte /work, en pourcentage. Effet
              immédiat.</span
            >
          </div>
        </header>
        <div class="adm-rows">
          <div class="adm-row">
            <div>
              <label
                class="adm-row__label"
                title="Au-delà, les outils qui écrivent préviennent le modèle (quota du compte ou disque de /work)."
                for="sb-disk-warn"
                >Seuil d'alerte</label
              >
              <span class="sr-only"
                >Au-delà, les outils qui écrivent préviennent le modèle (quota du compte ou disque de
                /work).</span
              >
            </div>
            <div class="flex items-center gap-2">
              <input
                id="sb-disk-warn"
                v-model.number="adm.execConfig.disk.warn_pct"
                data-field="exec:disk.warn_pct"
                type="number"
                min="10"
                max="99"
                class="set-input adm-num font-mono"
              />
              <span class="adm-unit">%</span>
            </div>
          </div>
          <div class="adm-row">
            <div>
              <label
                class="adm-row__label"
                title="Au-delà, écritures, copies et nouvelles tâches de fond sont refusées ; les suppressions restent permises."
                for="sb-disk-refuse"
                >Seuil de refus</label
              >
              <span class="sr-only"
                >Au-delà, écritures, copies et nouvelles tâches de fond sont refusées ; les suppressions
                restent permises.</span
              >
            </div>
            <div class="flex items-center gap-2">
              <input
                id="sb-disk-refuse"
                v-model.number="adm.execConfig.disk.refuse_pct"
                data-field="exec:disk.refuse_pct"
                type="number"
                min="11"
                max="100"
                class="set-input adm-num font-mono"
              />
              <span class="adm-unit">%</span>
            </div>
          </div>
          <p
            v-if="adm.execConfig.disk.warn_pct >= adm.execConfig.disk.refuse_pct"
            role="alert"
            class="py-2 text-[11px] text-red-600 flex items-center gap-1.5"
          >
            <i class="ph ph-warning-circle shrink-0" aria-hidden="true"></i>
            Le seuil d'alerte doit rester sous le seuil de refus.
          </p>
        </div>
      </section>

      <section v-if="adm.adminTab === 'sandbox-limits'" id="sandbox-policy" class="adm-card scroll-mt-32">
        <header class="adm-card__head">
          <i class="ph ph-shield adm-card__icon" aria-hidden="true"></i>
          <div>
            <h3 class="adm-card__title">Politique</h3>
            <span class="sr-only"
              >Ce que les utilisateurs peuvent choisir, et quand les containers sont recyclés.</span
            >
          </div>
        </header>
        <div class="adm-rows">
          <div class="adm-row">
            <div>
              <label
                class="adm-row__label"
                title="Le mode dossier n'est plus proposé aux utilisateurs."
                for="sb-force-docker"
                >Forcer Docker pour tous</label
              >
              <span class="sr-only">Le mode dossier n'est plus proposé aux utilisateurs.</span>
            </div>
            <label class="relative inline-flex items-center gap-2 cursor-pointer w-fit">
              <input
                id="sb-force-docker"
                v-model="adm.execConfig.force_user_docker"
                type="checkbox"
                data-field="exec:force_user_docker"
                class="sr-only peer"
              />
              <span
                class="set-switch-track block peer-checked:bg-blue-600 peer-checked:border-blue-600"
              ></span>
              <span class="text-sm text-slate-700">{{
                adm.execConfig.force_user_docker ? "Imposé" : "Au choix"
              }}</span>
            </label>
          </div>

          <div class="adm-row">
            <div>
              <label
                class="adm-row__label"
                title="Seuil utilisé par « Recycler les inactifs ». 0 = jamais."
                for="sb-idle"
                >Arrêt d'inactivité</label
              >
              <span class="sr-only">Seuil utilisé par « Recycler les inactifs ». 0 = jamais.</span>
            </div>
            <div class="flex items-center gap-2">
              <input
                id="sb-idle"
                v-model.number="adm.execConfig.idle_kill_hours"
                data-field="exec:idle_kill_hours"
                type="number"
                min="0"
                max="168"
                class="set-input adm-num font-mono"
              />
              <span class="adm-unit">heures</span>
            </div>
          </div>

          <details class="adm-details adm-details--rows">
            <summary title="Identité d'exécution, runtime, flags Docker, agent">Avancé</summary>
            <div class="adm-row">
              <div>
                <label
                  class="adm-row__label"
                  title="UID:GID des exécutions. 0:0 = root dans le container. Effet immédiat."
                  for="sb-exec-user"
                  >Identité</label
                >
                <span class="sr-only"
                  >UID:GID des exécutions. 0:0 = root dans le container. Effet immédiat.</span
                >
              </div>
              <input
                id="sb-exec-user"
                v-model="adm.execConfig.exec_user"
                data-field="exec:exec_user"
                placeholder="10001:10001"
                class="set-input font-mono text-xs max-w-[14rem]"
              />
            </div>
            <div class="adm-row">
              <div>
                <label
                  class="adm-row__label"
                  title="gVisor (runsc), Kata… Vide = runtime Docker. Au redémarrage."
                  for="sb-runtime"
                  >Runtime OCI</label
                >
                <span class="sr-only">gVisor (runsc), Kata… Vide = runtime Docker. Au redémarrage.</span>
              </div>
              <input
                id="sb-runtime"
                v-model="adm.execConfig.runtime"
                data-field="exec:runtime"
                placeholder="runsc"
                class="set-input font-mono text-xs max-w-[14rem]"
              />
            </div>
            <div class="adm-row adm-row--top">
              <div>
                <label
                  class="adm-row__label"
                  title="Un par ligne, passés tels quels. Au redémarrage."
                  for="sb-extra-args"
                  >Flags <code class="font-mono">docker run</code></label
                >
                <span class="sr-only">Un par ligne, passés tels quels. Au redémarrage.</span>
              </div>
              <textarea
                id="sb-extra-args"
                v-model="adm.execExtraArgsText"
                rows="3"
                placeholder="--cap-add=NET_ADMIN&#10;--shm-size=2g"
                class="set-textarea font-mono text-xs"
              ></textarea>
            </div>
          </details>
        </div>
      </section>

      <section v-if="adm.adminTab === 'sandbox-limits'" id="sandbox-jobs" class="adm-card scroll-mt-32">
        <header class="adm-card__head">
          <i class="ph ph-timer adm-card__icon" aria-hidden="true"></i>
          <div>
            <h3 class="adm-card__title">Tâches de fond</h3>
            <span class="sr-only"
              >Tâches lancées par le modèle qui réveillent la conversation à leur fin. Les limites valent dès
              la prochaine tâche.</span
            >
          </div>
        </header>
        <div class="adm-rows">
          <div class="adm-row">
            <div>
              <label
                class="adm-row__label"
                title="Nombre de tâches de fond actives en même temps dans une conversation."
                for="sb-job-max-per-chat"
                >Tâches par conversation</label
              >
              <span class="sr-only"
                >Nombre de tâches de fond actives en même temps dans une conversation.</span
              >
            </div>
            <div class="flex items-center gap-2">
              <input
                id="sb-job-max-per-chat"
                v-model.number="adm.execConfig.jobs.max_per_chat"
                data-field="exec:jobs.max_per_chat"
                type="number"
                min="1"
                max="50"
                class="set-input adm-num font-mono"
              />
            </div>
          </div>
          <div class="adm-row">
            <div>
              <label
                class="adm-row__label"
                title="Nombre de tâches de fond actives en même temps pour un compte."
                for="sb-job-max-per-user"
                >Tâches par compte</label
              >
              <span class="sr-only">Nombre de tâches de fond actives en même temps pour un compte.</span>
            </div>
            <div class="flex items-center gap-2">
              <input
                id="sb-job-max-per-user"
                v-model.number="adm.execConfig.jobs.max_per_user"
                data-field="exec:jobs.max_per_user"
                type="number"
                min="1"
                max="200"
                class="set-input adm-num font-mono"
              />
            </div>
          </div>
          <div class="adm-row">
            <div>
              <label
                class="adm-row__label"
                title="Réveils enchaînés au plus : une tâche lancée par un réveil compte un cran de plus."
                for="sb-job-max-depth"
                >Profondeur de la chaîne</label
              >
              <span class="sr-only"
                >Réveils enchaînés au plus : une tâche lancée par un réveil compte un cran de plus.</span
              >
            </div>
            <div class="flex items-center gap-2">
              <input
                id="sb-job-max-depth"
                v-model.number="adm.execConfig.jobs.max_depth"
                data-field="exec:jobs.max_depth"
                type="number"
                min="1"
                max="50"
                class="set-input adm-num font-mono"
              />
            </div>
          </div>
          <div class="adm-row">
            <div>
              <label
                class="adm-row__label"
                title="Réveils automatiques d'une même conversation par heure."
                for="sb-job-wakes-per-hour"
                >Réveils par heure</label
              >
              <span class="sr-only">Réveils automatiques d'une même conversation par heure.</span>
            </div>
            <div class="flex items-center gap-2">
              <input
                id="sb-job-wakes-per-hour"
                v-model.number="adm.execConfig.jobs.wakes_per_hour"
                data-field="exec:jobs.wakes_per_hour"
                type="number"
                min="1"
                max="600"
                class="set-input adm-num font-mono"
              />
              <span class="adm-unit">réveils</span>
            </div>
          </div>
          <div class="adm-row">
            <div>
              <label
                class="adm-row__label"
                title="Au-delà, la tâche est arrêtée et réveille la conversation."
                for="sb-job-max-runtime-h"
                >Durée maximale d'une tâche</label
              >
              <span class="sr-only">Au-delà, la tâche est arrêtée et réveille la conversation.</span>
            </div>
            <div class="flex items-center gap-2">
              <input
                id="sb-job-max-runtime-h"
                v-model.number="adm.execConfig.jobs.max_runtime_h"
                data-field="exec:jobs.max_runtime_h"
                type="number"
                min="1"
                max="720"
                class="set-input adm-num font-mono"
              />
              <span class="adm-unit">heures</span>
            </div>
          </div>
          <div class="adm-row">
            <div>
              <label
                class="adm-row__label"
                title="Texte remis au modèle pour un événement, tronqué au-delà."
                for="sb-job-event-max-bytes"
                >Taille d'un événement</label
              >
              <span class="sr-only">Texte remis au modèle pour un événement, tronqué au-delà.</span>
            </div>
            <div class="flex items-center gap-2">
              <input
                id="sb-job-event-max-bytes"
                v-model.number="adm.execConfig.jobs.event_max_bytes"
                data-field="exec:jobs.event_max_bytes"
                type="number"
                min="256"
                max="65536"
                class="set-input adm-num font-mono"
              />
              <span class="adm-unit">octets</span>
            </div>
          </div>
          <div class="adm-row">
            <div>
              <label
                class="adm-row__label"
                title="Texte total remis au modèle pour un réveil (plusieurs événements)."
                for="sb-job-wake-max-bytes"
                >Taille d'un réveil</label
              >
              <span class="sr-only">Texte total remis au modèle pour un réveil (plusieurs événements).</span>
            </div>
            <div class="flex items-center gap-2">
              <input
                id="sb-job-wake-max-bytes"
                v-model.number="adm.execConfig.jobs.wake_max_bytes"
                data-field="exec:jobs.wake_max_bytes"
                type="number"
                min="1024"
                max="262144"
                class="set-input adm-num font-mono"
              />
              <span class="adm-unit">octets</span>
            </div>
          </div>
          <div class="adm-row">
            <div>
              <label
                class="adm-row__label"
                title="Tours de réveil menés en même temps par compte ; les autres attendent leur tour."
                for="sb-job-wake-concurrency"
                >Réveils simultanés</label
              >
              <span class="sr-only"
                >Tours de réveil menés en même temps par compte ; les autres attendent leur tour.</span
              >
            </div>
            <div class="flex items-center gap-2">
              <input
                id="sb-job-wake-concurrency"
                v-model.number="adm.execConfig.jobs.wake_concurrency"
                data-field="exec:jobs.wake_concurrency"
                type="number"
                min="1"
                max="8"
                class="set-input adm-num font-mono"
              />
              <span class="adm-unit">tours</span>
            </div>
          </div>
          <div class="adm-row">
            <div>
              <label
                class="adm-row__label"
                title="Les tâches terminées et leurs événements sont purgés après ce délai."
                for="sb-job-retention-days"
                >Conservation des tâches</label
              >
              <span class="sr-only"
                >Les tâches terminées et leurs événements sont purgés après ce délai.</span
              >
            </div>
            <div class="flex items-center gap-2">
              <input
                id="sb-job-retention-days"
                v-model.number="adm.execConfig.jobs.retention_days"
                data-field="exec:jobs.retention_days"
                type="number"
                min="1"
                max="365"
                class="set-input adm-num font-mono"
              />
              <span class="adm-unit">jours</span>
            </div>
          </div>
        </div>
      </section>

      <section v-if="adm.adminTab === 'sandbox-network'" id="sandbox-network" class="adm-card scroll-mt-32">
        <header class="adm-card__head">
          <i class="ph ph-network adm-card__icon" aria-hidden="true"></i>
          <div class="min-w-0">
            <h3 class="adm-card__title">
              Profils réseau
              <span class="font-normal text-slate-500">· {{ adm.execConfig.network_profiles.length }}</span>
            </h3>
            <span class="sr-only"
              >Chaque utilisateur choisit son profil — sauf si vous lui en imposez un depuis Utilisateurs. Le
              profil isolé ne peut pas être supprimé.</span
            >
          </div>
          <div class="adm-card__actions">
            <button class="adm-btn adm-btn--primary" @click="adm.addNetworkProfile">
              <i class="ph ph-plus" aria-hidden="true"></i> Nouveau profil
            </button>
          </div>
        </header>

        <div class="px-5 py-3 space-y-2">
          <div
            v-for="(prof, idx) in adm.execConfig.network_profiles"
            :key="prof._uid || idx"
            :class="['np-card', prof._open ? 'np-card--open' : '']"
          >
            <div class="np-card__head">
              <button
                type="button"
                class="np-card__toggle"
                :aria-expanded="prof._open ? 'true' : 'false'"
                :aria-controls="'np-body-' + idx"
                :title="prof._open ? 'Replier' : 'Modifier ce profil'"
                @click="adm.toggleProfile(prof)"
              >
                <i class="ph ph-caret-right np-card__chev" aria-hidden="true"></i>
                <span :class="['np-badge', 'np-badge--' + adm.netModeKey(prof)]">
                  <i :class="['ph', adm.netModeIcon(prof)]" aria-hidden="true"></i
                  >{{ adm.netModeLabel(prof) }}
                </span>
                <span class="np-card__name">{{ prof.name || "Sans nom" }}</span>
                <span class="np-card__id">{{ prof.id }}</span>
                <span class="np-card__sum ml-auto pl-3">{{ adm.netProfileSummary(prof) }}</span>
                <i
                  v-if="adm.netProfileIssue(prof)"
                  class="ph ph-warning-circle text-red-600 shrink-0"
                  :title="adm.netProfileIssue(prof)"
                  aria-hidden="true"
                ></i>
              </button>
              <button
                v-if="prof.id !== 'isolated'"
                class="adm-btn adm-btn--icon adm-btn--icon-danger"
                :title="'Supprimer ' + (prof.name || prof.id)"
                @click="adm.removeNetworkProfile(idx)"
              >
                <i class="ph ph-x" aria-hidden="true"></i>
              </button>
            </div>

            <div v-show="prof._open" :id="'np-body-' + idx" class="np-card__body">
              <div class="flex items-center gap-2 flex-wrap mt-2.5">
                <input
                  v-model="prof.name"
                  placeholder="Nom affiché"
                  aria-label="Nom du profil"
                  class="set-input set-control--sm w-48"
                />
                <input
                  v-model="prof.id"
                  :disabled="prof.id === 'isolated'"
                  aria-label="Identifiant technique"
                  title="Identifiant technique (minuscules, chiffres, _ ou -)"
                  class="set-input set-control--sm font-mono w-32 disabled:opacity-60 disabled:cursor-not-allowed"
                />
                <input
                  v-model="prof.description"
                  placeholder="Description vue par l'utilisateur"
                  aria-label="Description du profil"
                  class="set-input set-control--sm flex-1 min-w-40"
                />
              </div>

              <div
                class="np-seg mt-2.5"
                role="group"
                :aria-label="'Mode réseau de ' + (prof.name || prof.id)"
              >
                <button
                  type="button"
                  :disabled="prof.id === 'isolated'"
                  :class="['np-seg__btn', prof.mode === 'none' ? 'is-on np-seg__btn--block' : '']"
                  :aria-pressed="prof.mode === 'none' ? 'true' : 'false'"
                  :title="
                    prof.id === 'isolated'
                      ? 'Profil de repli : toujours sans réseau'
                      : 'Aucun réseau du tout : le conteneur démarre sans interface (--network=none)'
                  "
                  @click="adm.setProfileMode(prof, 'none')"
                >
                  <i class="ph ph-prohibit" aria-hidden="true"></i> Tout bloquer
                </button>
                <button
                  type="button"
                  :disabled="prof.id === 'isolated'"
                  :class="['np-seg__btn', prof.mode === 'allowlist_ip' ? 'is-on np-seg__btn--filter' : '']"
                  :aria-pressed="prof.mode === 'allowlist_ip' ? 'true' : 'false'"
                  title="Seules les destinations listées ci-dessous sortent"
                  @click="adm.setProfileMode(prof, 'allowlist_ip')"
                >
                  <i class="ph ph-funnel" aria-hidden="true"></i> Liste autorisée
                </button>
                <button
                  type="button"
                  :disabled="prof.id === 'isolated'"
                  :class="['np-seg__btn', prof.mode === 'bridge' ? 'is-on np-seg__btn--open' : '']"
                  :aria-pressed="prof.mode === 'bridge' ? 'true' : 'false'"
                  title="Aucun filtrage : internet, LAN et métadonnées cloud"
                  @click="adm.setProfileMode(prof, 'bridge')"
                >
                  <i class="ph ph-globe-hemisphere-west" aria-hidden="true"></i> Tout autoriser
                </button>
              </div>

              <p
                v-if="prof.mode === 'bridge'"
                class="mt-2 text-[11px] text-amber-700 flex items-center gap-1.5"
              >
                <i class="ph ph-warning shrink-0" aria-hidden="true"></i>
                Accès total : internet, LAN et métadonnées cloud.
              </p>
              <p v-else-if="prof.mode === 'none'" class="mt-2 text-[11px] text-slate-500">
                Aucune sortie réseau.
              </p>

              <div v-if="prof.mode === 'allowlist_ip'" class="mt-3 grid gap-x-5 gap-y-3 xl:grid-cols-2">
                <div v-for="f in adm.netFields" :key="f.key">
                  <div class="flex items-center gap-2 mb-1">
                    <label
                      :for="'np-' + f.key + '-' + idx"
                      class="text-[11px] font-semibold text-slate-500"
                      >{{ f.label }}</label
                    >
                    <div
                      v-if="f.key === 'ports'"
                      class="np-seg np-seg--xs"
                      role="group"
                      aria-label="Politique de ports"
                    >
                      <button
                        type="button"
                        :class="['np-seg__btn', adm.netPortsMode(prof) === 'all' ? 'is-on' : '']"
                        :aria-pressed="adm.netPortsMode(prof) === 'all' ? 'true' : 'false'"
                        title="Aucun filtrage par port"
                        @click="adm.setPortsMode(prof, 'all')"
                      >
                        Tous
                      </button>
                      <button
                        type="button"
                        :class="['np-seg__btn', adm.netPortsMode(prof) === 'list' ? 'is-on' : '']"
                        :aria-pressed="adm.netPortsMode(prof) === 'list' ? 'true' : 'false'"
                        title="Seuls les ports TCP listés passent (image ≥ 1.6.0)"
                        @click="adm.setPortsMode(prof, 'list')"
                      >
                        Liste
                      </button>
                    </div>
                    <span class="text-[11px] text-slate-400 ml-auto" :title="f.title">{{ f.hint }}</span>
                  </div>

                  <div v-if="f.key !== 'ports' || adm.netPortsMode(prof) === 'list'">
                    <div class="np-chips">
                      <span v-for="(val, vi) in prof[f.key] || []" :key="f.key + ':' + val" class="np-chip">
                        <span class="np-chip__txt">{{ val }}</span>
                        <button
                          type="button"
                          class="np-chip__x"
                          :aria-label="'Retirer ' + val"
                          @click="adm.removeNetValue(prof, f.key, vi)"
                        >
                          <i class="ph ph-x" aria-hidden="true"></i>
                        </button>
                      </span>
                      <span v-if="!(prof[f.key] || []).length" class="np-chips__empty">Aucune entrée</span>
                    </div>
                    <div class="flex items-center gap-1.5 mt-1.5">
                      <input
                        :id="'np-' + f.key + '-' + idx"
                        v-model="prof._draft[f.key]"
                        :placeholder="f.ph"
                        :aria-label="'Ajouter — ' + f.label"
                        :title="f.title"
                        class="set-input set-control--sm font-mono flex-1 min-w-0"
                        @keydown.enter.prevent="adm.commitNetValue(prof, f.key)"
                        @blur="adm.commitNetValue(prof, f.key)"
                      />
                      <button
                        type="button"
                        :aria-label="'Ajouter à ' + f.label"
                        class="adm-btn adm-btn--icon adm-tool"
                        @click="adm.commitNetValue(prof, f.key)"
                      >
                        <i class="ph ph-plus" aria-hidden="true"></i>
                      </button>
                      <button
                        v-for="q in f.quick || []"
                        :key="q.label"
                        type="button"
                        :title="'Ajouter ' + q.values.join(', ')"
                        class="adm-btn adm-tool adm-btn--sm"
                        @click="adm.addNetPreset(prof, f.key, q.values)"
                      >
                        {{ q.label }}
                      </button>
                    </div>
                    <p
                      v-if="prof._err[f.key]"
                      role="alert"
                      class="mt-1 text-[11px] text-red-600 flex items-center gap-1"
                    >
                      <i class="ph ph-warning-circle shrink-0" aria-hidden="true"></i>{{ prof._err[f.key] }}
                    </p>
                  </div>
                </div>
              </div>

              <p
                v-if="adm.netProfileIssue(prof)"
                role="alert"
                class="mt-2 text-[11px] text-red-600 flex items-center gap-1.5"
              >
                <i class="ph ph-warning-circle shrink-0" aria-hidden="true"></i>
                {{ adm.netProfileIssue(prof) }}
              </p>
            </div>
          </div>
        </div>

        <div
          v-if="adm.staleNetContainers.length"
          class="mx-5 mb-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2.5"
        >
          <p class="text-xs text-amber-800 font-medium flex items-center gap-1.5">
            <i class="ph ph-warning" aria-hidden="true"></i>
            {{ adm.staleNetContainers.length }} conteneur(s) en marche utilisent encore les anciennes règles
            réseau.
          </p>
          <p class="text-[11px] text-amber-700 mt-0.5">
            Recréation automatique au prochain accès de leur utilisateur — ou tout de suite :
          </p>
          <div class="mt-1.5 flex items-center gap-2 flex-wrap">
            <span
              v-for="c in adm.staleNetContainers"
              :key="c.container"
              class="text-[11px] font-mono px-1.5 py-0.5 rounded bg-white border border-amber-200 text-amber-800"
              >{{ c.username || c.user_id }}</span
            >
            <button
              :disabled="adm.staleNetBusy"
              class="adm-btn adm-btn--warn adm-btn--sm"
              @click="adm.recreateStaleNetContainers"
            >
              <i
                class="ph"
                :class="adm.staleNetBusy ? 'ph-spinner animate-spin' : 'ph-arrows-clockwise'"
                aria-hidden="true"
              ></i>
              Recréer maintenant
            </button>
          </div>
        </div>

        <p class="px-5 py-2.5 border-t border-slate-100 text-xs text-slate-500">
          Appliqué dans le conteneur à sa (re)création — rien n'est modifié sur l'hôte.
        </p>
      </section>

      <section
        v-if="adm.adminTab === 'sandbox-toolhosts'"
        id="sandbox-toolhosts"
        class="adm-card scroll-mt-32"
      >
        <header class="adm-card__head">
          <i class="ph ph-hard-drives adm-card__icon" aria-hidden="true"></i>
          <div>
            <h3 class="adm-card__title">
              Hôtes d'outils
              <span v-if="adm.toolhosts" class="font-normal text-slate-500"
                >· {{ adm.toolhosts.hosts.length }}</span
              >
            </h3>
            <span class="sr-only"
              >Déclarés dans mcp.json (sandboxHosts, placement). Zone d'exploitation : actions
              immédiates.</span
            >
          </div>
          <button
            type="button"
            class="ml-auto opacity-70 hover:opacity-100 transition-opacity"
            title="Rafraîchir"
            @click="adm.loadToolhosts"
          >
            <i class="ph ph-arrow-clockwise" aria-hidden="true"></i>
          </button>
        </header>
        <div v-if="!adm.toolhosts" class="text-xs text-slate-400 px-4 py-3">Chargement…</div>
        <div v-else class="px-4 pb-3 space-y-3">
          <div class="text-xs text-slate-500">
            Placement : <span class="font-mono">{{ adm.toolhosts.placement.strategy || "single" }}</span
            ><span v-if="adm.toolhosts.placement.host">
              · défaut <span class="font-mono">{{ adm.toolhosts.placement.host }}</span></span
            >
          </div>
          <table class="w-full text-xs">
            <thead>
              <tr class="text-left text-slate-500 border-b border-slate-200">
                <th class="py-1.5 pr-3 font-semibold">Hôte</th>
                <th class="py-1.5 pr-3 font-semibold">URL</th>
                <th class="py-1.5 pr-3 font-semibold">État</th>
                <th class="py-1.5 pr-3 font-semibold">Familles</th>
                <th class="py-1.5 pr-3 font-semibold">Comptes</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="h in adm.toolhosts.hosts" :key="h.id" class="border-b border-slate-100 align-top">
                <td class="py-1.5 pr-3 font-mono">{{ h.id }}</td>
                <td class="py-1.5 pr-3 font-mono text-[11px] break-all">
                  {{ h.url }}<span v-if="!h.has_token" class="ml-1 text-amber-700">⚠ sans jeton</span>
                </td>
                <td class="py-1.5 pr-3">
                  <span v-if="h.reachable === true" class="text-emerald-700"
                    >joignable<span v-if="h.health && h.health.tools">
                      · {{ h.health.tools }} outils</span
                    ></span
                  >
                  <span v-else-if="h.reachable === false" class="text-red-700" :title="h.error || ''"
                    >injoignable</span
                  >
                  <span v-else class="text-slate-500">—</span>
                </td>
                <td class="py-1.5 pr-3 text-[11px]">
                  {{ h.health && h.health.families ? h.health.families.join(", ") : "—" }}
                </td>
                <td class="py-1.5 pr-3">{{ h.accounts }}</td>
              </tr>
            </tbody>
          </table>
          <div v-if="adm.toolhosts.placement.strategy === 'by_user'">
            <div class="text-xs font-semibold text-slate-600 mb-1">
              Affectations
              <span class="font-normal text-slate-500">· {{ adm.toolhosts.placements.length }}</span>
            </div>
            <div v-if="adm.toolhosts.placements.length === 0" class="text-xs text-slate-400">
              Aucune (affectation automatique à la première utilisation).
            </div>
            <table v-else class="w-full text-xs">
              <tbody>
                <tr v-for="p in adm.toolhosts.placements" :key="p.user_id" class="border-b border-slate-100">
                  <td class="py-1 pr-3">{{ p.username || "#" + p.user_id }}</td>
                  <td class="py-1 pr-3 font-mono">{{ p.host_id }}</td>
                  <td class="py-1 pr-3">
                    <select v-model="adm.toolhostMoveTarget[p.user_id]" class="set-input text-[11px] py-0.5">
                      <option value="">Vers…</option>
                      <option
                        v-for="h in adm.toolhosts.hosts"
                        :key="h.id"
                        :value="h.id"
                        :disabled="h.id === p.host_id"
                      >
                        {{ h.id }}
                      </option>
                    </select>
                  </td>
                  <td class="py-1 pr-3 whitespace-nowrap">
                    <button
                      type="button"
                      :disabled="!adm.toolhostMoveTarget[p.user_id] || adm.toolhostBusy"
                      class="adm-btn adm-tool adm-btn--sm"
                      @click="adm.migrateToolhostPlacement(p.user_id)"
                    >
                      Migrer
                    </button>
                    <button
                      type="button"
                      :disabled="!adm.toolhostMoveTarget[p.user_id] || adm.toolhostBusy"
                      class="adm-btn adm-tool adm-btn--sm"
                      title="Réaffecter sans déplacer les fichiers"
                      @click="adm.assignToolhostPlacement(p.user_id)"
                    >
                      Affecter
                    </button>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </section>

      <section
        v-if="adm.adminTab === 'sandbox-containers'"
        id="sandbox-containers"
        class="adm-card scroll-mt-32"
      >
        <header class="adm-card__head">
          <i class="ph ph-cube adm-card__icon" aria-hidden="true"></i>
          <div class="min-w-0">
            <h3 class="adm-card__title">
              Containers actifs
              <span class="font-normal text-slate-500">· {{ adm.sandboxContainers.length }}</span>
            </h3>
            <span class="sr-only"
              >État en direct. Ces actions s'appliquent tout de suite, sans passer par « Sauvegarder ».</span
            >
          </div>
          <div class="adm-card__actions">
            <button
              title="Stopper les containers inactifs au-delà du seuil"
              class="adm-btn adm-tool"
              @click="adm.triggerSandboxGc"
            >
              <i class="ph ph-broom" aria-hidden="true"></i> Recycler les inactifs
            </button>
            <button
              title="Rafraîchir la liste"
              class="adm-btn adm-btn--icon"
              @click="adm.loadSandboxContainers"
            >
              <i class="ph ph-arrow-clockwise" aria-hidden="true"></i>
            </button>
          </div>
        </header>
        <div v-if="!adm.sandboxContainers.length" class="px-5">
          <p class="adm-empty">Aucun container actif.</p>
        </div>
        <div v-else class="overflow-x-auto">
          <table class="w-full text-xs">
            <thead class="text-slate-500 border-b border-slate-100">
              <tr>
                <th scope="col" class="text-left px-5 py-2 font-medium">Utilisateur</th>
                <th scope="col" class="text-left px-2 py-2 font-medium">Container</th>
                <th scope="col" class="text-left px-2 py-2 font-medium w-20">État</th>
                <th scope="col" class="text-left px-2 py-2 font-medium">Statut</th>
                <th class="w-20"><span class="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="c in adm.sandboxContainers" :key="c.id" class="border-t border-slate-100">
                <td class="px-5 py-2 font-medium text-slate-800">{{ c.username || `#${c.user_id}` }}</td>
                <td class="px-2 py-2 font-mono text-slate-600">{{ c.name }}</td>
                <td class="px-2 py-2">
                  <span
                    :class="[
                      'text-[11px] px-1.5 py-0.5 rounded-full border',
                      c.state === 'running'
                        ? 'bg-emerald-50 text-emerald-800 border-emerald-200'
                        : c.state === 'exited'
                          ? 'bg-slate-50 text-slate-600 border-slate-200'
                          : 'bg-amber-50 text-amber-800 border-amber-200',
                    ]"
                    >{{
                      {
                        running: "En cours",
                        exited: "Arrêté",
                        created: "Créé",
                        paused: "En pause",
                        restarting: "Redémarrage",
                      }[c.state] || c.state
                    }}</span
                  >
                </td>
                <td class="px-2 py-2 text-slate-500">{{ c.status }}</td>
                <td class="px-2 py-2 text-right">
                  <div class="flex items-center justify-end gap-1">
                    <button
                      v-if="c.state === 'running'"
                      class="adm-btn adm-btn--icon"
                      title="Stopper"
                      @click="adm.adminStopUserSandbox(c.user_id)"
                    >
                      <i class="ph ph-stop-circle" aria-hidden="true"></i>
                    </button>
                    <button
                      class="adm-btn adm-btn--icon adm-btn--icon-danger"
                      title="Détruire"
                      @click="adm.adminDestroyUserSandbox(c.user_id)"
                    >
                      <i class="ph ph-trash" aria-hidden="true"></i>
                    </button>
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
    </div>
  </div>
</template>
