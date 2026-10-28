<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/admin/PageEntretien.vue — pages Entretien et Accès HTTPS. -->
<script setup lang="ts">
import { domaineAdmin } from "../../features/admin/domaine";

const adm = domaineAdmin();
</script>

<template>
  <div v-if="['upkeep', 'data', 'vision'].includes(adm.adminTab)" class="animate-[fadeIn_0.2s]">
    <div class="space-y-6 min-w-0">
      <section v-if="adm.adminTab === 'upkeep' && adm.configForm" id="upkeep" class="adm-card">
        <header class="adm-card__head">
          <i class="ph ph-broom adm-card__icon" aria-hidden="true"></i>
          <div>
            <h3
              class="adm-card__title"
              title="Chaque jour, le serveur purge les données anciennes, compacte la base et envoie le rapport d'usage."
            >
              Passe quotidienne
            </h3>
          </div>
        </header>
        <div class="adm-rows">
          <div class="adm-row">
            <div>
              <label
                class="adm-row__label"
                for="upk-hour"
                title="Heure locale de la passe quotidienne : purges, compactage de la base, rapport. Au redémarrage."
                >Heure</label
              >
              <span class="sr-only"
                >Heure locale de la passe quotidienne : purges, compactage de la base, rapport. Au
                redémarrage.</span
              >
            </div>
            <div class="flex items-center gap-2">
              <input
                id="upk-hour"
                v-model.number="adm.configForm.maintenance.hour"
                type="number"
                min="0"
                max="23"
                data-field="config:maintenance.hour"
                class="set-input w-24 tabular-nums"
              />
              <span class="adm-row__hint">h</span>
            </div>
          </div>
          <div class="adm-row">
            <div>
              <label
                class="adm-row__label"
                for="upk-metrics_retention_days"
                title="Événements de métriques. 0 = sans limite. Au redémarrage."
                >Compteurs</label
              >
              <span class="sr-only">Événements de métriques. 0 = sans limite. Au redémarrage.</span>
            </div>
            <div class="flex items-center gap-2">
              <input
                id="upk-metrics_retention_days"
                v-model.number="adm.configForm.maintenance.metrics_retention_days"
                type="number"
                min="0"
                data-field="config:maintenance.metrics_retention_days"
                class="set-input w-24 tabular-nums"
              />
              <span class="adm-row__hint">j</span>
            </div>
          </div>
          <div class="adm-row">
            <div>
              <label
                class="adm-row__label"
                for="upk-usage_events_retention_days"
                title="Registre de consommation LLM (un tour par ligne). 0 = sans limite. Au redémarrage."
                >Consommation</label
              >
              <span class="sr-only"
                >Registre de consommation LLM (un tour par ligne). 0 = sans limite. Au redémarrage.</span
              >
            </div>
            <div class="flex items-center gap-2">
              <input
                id="upk-usage_events_retention_days"
                v-model.number="adm.configForm.maintenance.usage_events_retention_days"
                type="number"
                min="0"
                data-field="config:maintenance.usage_events_retention_days"
                class="set-input w-24 tabular-nums"
              />
              <span class="adm-row__hint">j</span>
            </div>
          </div>
          <div class="adm-row">
            <div>
              <label
                class="adm-row__label"
                for="upk-session_messages_retention_days"
                title="Historique indexé pour la recherche dans les conversations. 0 = sans limite. Au redémarrage."
                >Messages</label
              >
              <span class="sr-only"
                >Historique indexé pour la recherche dans les conversations. 0 = sans limite. Au
                redémarrage.</span
              >
            </div>
            <div class="flex items-center gap-2">
              <input
                id="upk-session_messages_retention_days"
                v-model.number="adm.configForm.maintenance.session_messages_retention_days"
                type="number"
                min="0"
                data-field="config:maintenance.session_messages_retention_days"
                class="set-input w-24 tabular-nums"
              />
              <span class="adm-row__hint">j</span>
            </div>
          </div>
          <div class="adm-row">
            <div>
              <label
                class="adm-row__label"
                for="upk-tool_metrics_retention_days"
                title="Journal des appels d’outils. 0 = sans limite. Au redémarrage."
                >Appels d'outils</label
              >
              <span class="sr-only">Journal des appels d’outils. 0 = sans limite. Au redémarrage.</span>
            </div>
            <div class="flex items-center gap-2">
              <input
                id="upk-tool_metrics_retention_days"
                v-model.number="adm.configForm.maintenance.tool_metrics_retention_days"
                type="number"
                min="0"
                data-field="config:maintenance.tool_metrics_retention_days"
                class="set-input w-24 tabular-nums"
              />
              <span class="adm-row__hint">j</span>
            </div>
          </div>
          <div class="adm-row">
            <div>
              <label
                class="adm-row__label"
                for="upk-routine_runs_retention_days"
                title="Journal des exécutions de routines. 0 = sans limite. Au redémarrage."
                >Runs de routines</label
              >
              <span class="sr-only"
                >Journal des exécutions de routines. 0 = sans limite. Au redémarrage.</span
              >
            </div>
            <div class="flex items-center gap-2">
              <input
                id="upk-routine_runs_retention_days"
                v-model.number="adm.configForm.maintenance.routine_runs_retention_days"
                type="number"
                min="0"
                data-field="config:maintenance.routine_runs_retention_days"
                class="set-input w-24 tabular-nums"
              />
              <span class="adm-row__hint">j</span>
            </div>
          </div>
          <div class="adm-row">
            <div>
              <label
                class="adm-row__label"
                for="upk-daily_report_retention_days"
                title="Rapports quotidiens archivés. 0 = sans limite. Au redémarrage."
                >Rapports</label
              >
              <span class="sr-only">Rapports quotidiens archivés. 0 = sans limite. Au redémarrage.</span>
            </div>
            <div class="flex items-center gap-2">
              <input
                id="upk-daily_report_retention_days"
                v-model.number="adm.configForm.maintenance.daily_report_retention_days"
                type="number"
                min="0"
                data-field="config:maintenance.daily_report_retention_days"
                class="set-input w-24 tabular-nums"
              />
              <span class="adm-row__hint">j</span>
            </div>
          </div>
        </div>
      </section>

      <section
        v-if="adm.adminTab === 'upkeep'"
        id="upkeep-danger"
        class="adm-card adm-zone"
        aria-labelledby="upkeep-zone-h"
      >
        <header class="adm-card__head">
          <i class="ph ph-warning adm-card__icon" aria-hidden="true"></i>
          <div><h3 id="upkeep-zone-h" class="adm-card__title">Zone sensible</h3></div>
        </header>
        <div class="adm-rows">
          <div class="adm-row">
            <div>
              <span
                class="adm-row__label"
                title="Applique les réglages lus au démarrage. Les sessions actives se reconnectent seules."
                >Serveur</span
              >
              <span class="sr-only"
                >Applique les réglages lus au démarrage. Les sessions actives se reconnectent seules.</span
              >
            </div>
            <div>
              <button type="button" class="adm-btn adm-btn--danger" @click="adm.restartServer()">
                <i class="ph ph-power" aria-hidden="true"></i> Redémarrer
              </button>
            </div>
          </div>
          <div class="adm-row">
            <div>
              <span
                class="adm-row__label"
                title="Consommation, compteurs et appels d'outils. Le volume exact est annoncé avant confirmation ; runs de routines et rapports conservés."
                >Métriques</span
              >
              <span class="sr-only"
                >Consommation, compteurs et appels d'outils. Le volume exact est annoncé avant confirmation ;
                runs de routines et rapports conservés.</span
              >
            </div>
            <div>
              <button type="button" class="adm-btn adm-btn--danger" @click="adm.resetAllMetrics()">
                <i class="ph ph-eraser" aria-hidden="true"></i> Remettre à zéro
              </button>
            </div>
          </div>
        </div>
      </section>

      <section v-if="adm.adminTab === 'data'" id="backup" class="adm-card scroll-mt-32">
        <header class="adm-card__head">
          <i class="ph ph-download-simple adm-card__icon" aria-hidden="true"></i>
          <div>
            <h3 class="adm-card__title">Sauvegarde</h3>
            <span class="sr-only">Télécharge une archive de l'instance sur ce poste.</span>
          </div>
        </header>
        <div class="adm-rows">
          <div class="adm-row adm-row--top">
            <div>
              <span class="adm-row__label" title="« Complète » contient tout le reste.">Périmètre</span>
              <span class="sr-only">« Complète » contient tout le reste.</span>
            </div>
            <div class="flex flex-wrap gap-2">
              <button class="adm-btn adm-tool" @click="adm.downloadBackup('full')">
                <i class="ph ph-archive" aria-hidden="true"></i> Complète
              </button>
              <button class="adm-btn adm-tool" @click="adm.downloadBackup('db')">
                <i class="ph ph-database" aria-hidden="true"></i> Base de données
              </button>
              <button class="adm-btn adm-tool" @click="adm.downloadBackup('sandboxes')">
                <i class="ph ph-folder" aria-hidden="true"></i> Sandboxes
              </button>
              <button class="adm-btn adm-tool" @click="adm.downloadBackup('mcp')">
                <i class="ph ph-plug" aria-hidden="true"></i> Serveurs MCP
              </button>
            </div>
          </div>
        </div>
      </section>

      <section v-if="adm.adminTab === 'data'" id="backup-remote" class="adm-card scroll-mt-32">
        <header class="adm-card__head">
          <i class="ph ph-cloud-arrow-up adm-card__icon" aria-hidden="true"></i>
          <div class="min-w-0">
            <h3 class="adm-card__title">Sauvegarde distante</h3>
            <span class="sr-only"
              >Dépose l'archive sur un serveur ou un partage réseau, sans passer par ce poste.</span
            >
          </div>
          <div class="adm-card__actions">
            <label class="relative inline-flex items-center gap-2 cursor-pointer">
              <input v-model="adm.remoteBackup.enabled" type="checkbox" class="sr-only peer" />
              <span
                class="set-switch-track block peer-checked:bg-blue-600 peer-checked:border-blue-600"
              ></span>
              <span class="text-sm text-slate-700">{{
                adm.remoteBackup.enabled ? "Activée" : "Désactivée"
              }}</span>
            </label>
          </div>
        </header>
        <div class="adm-rows">
          <div class="adm-row">
            <div>
              <label class="adm-row__label" title="Et périmètre de l'archive envoyée." for="mnt-remote-conn"
                >Destination</label
              >
              <span class="sr-only">Et périmètre de l'archive envoyée.</span>
            </div>
            <div class="flex items-center gap-2 flex-wrap">
              <select
                id="mnt-remote-conn"
                v-model="adm.remoteBackup.connector"
                class="set-select w-auto min-w-[14rem]"
              >
                <option value="sftp">SFTP / SSH (par clé)</option>
                <option value="rsync">rsync</option>
                <option value="mounted">Partage réseau / dossier monté</option>
              </select>
              <select
                v-model="adm.remoteBackup.scope"
                aria-label="Périmètre"
                class="set-select w-auto min-w-[10rem]"
              >
                <option value="full">Complète</option>
                <option value="db">Base de données</option>
                <option value="sandboxes">Sandboxes</option>
              </select>
            </div>
          </div>

          <template v-if="adm.remoteBackup.connector === 'sftp' || adm.remoteBackup.connector === 'rsync'">
            <div class="adm-row" data-remote-server>
              <div>
                <label
                  class="adm-row__label"
                  title="Adresse IP, port SSH et utilisateur."
                  for="mnt-remote-host"
                  >Serveur</label
                >
                <span class="sr-only">Adresse IP, port SSH et utilisateur.</span>
              </div>
              <div class="flex items-center gap-2 flex-wrap">
                <input
                  id="mnt-remote-host"
                  v-model="adm.remoteBackup.host"
                  placeholder="10.0.0.20"
                  aria-label="Adresse IP"
                  class="set-input font-mono text-xs flex-1 min-w-[9rem]"
                />
                <input
                  v-model.number="adm.remoteBackup.port"
                  type="number"
                  placeholder="22"
                  aria-label="Port"
                  class="set-input adm-num--sm"
                />
                <input
                  v-model="adm.remoteBackup.user"
                  placeholder="backup"
                  aria-label="Utilisateur"
                  class="set-input w-32"
                />
              </div>
            </div>
            <div class="adm-row">
              <div>
                <label
                  class="adm-row__label"
                  title="Doit exister et être accessible en écriture."
                  for="mnt-remote-path"
                  >{{ adm.remoteBackup.connector === "rsync" ? "Chemin cible" : "Dossier distant" }}</label
                >
                <span class="sr-only">Doit exister et être accessible en écriture.</span>
              </div>
              <input
                id="mnt-remote-path"
                v-model="adm.remoteBackup.remote_path"
                placeholder="/srv/backups/elpis"
                class="set-input font-mono text-xs"
              />
            </div>
            <div v-if="adm.remoteBackup.connector === 'rsync'" class="adm-row" data-remote-rsync-password>
              <div>
                <label
                  class="adm-row__label"
                  title="Stocké à part sur le serveur, jamais réaffiché."
                  for="mnt-remote-rsync-pwd"
                  >Mot de passe</label
                >
                <span class="sr-only">Stocké à part sur le serveur, jamais réaffiché.</span>
              </div>
              <div class="flex items-center gap-3 flex-wrap">
                <input
                  id="mnt-remote-rsync-pwd"
                  v-model="adm.remoteRsyncPassword"
                  type="password"
                  autocomplete="new-password"
                  :placeholder="adm.remoteBackup.password_present ? 'Inchangé' : 'Mot de passe'"
                  class="set-input w-48"
                />
                <span
                  class="text-xs"
                  :class="adm.remoteBackup.password_present ? 'text-emerald-700' : 'text-slate-500'"
                >
                  <i
                    class="ph"
                    :class="adm.remoteBackup.password_present ? 'ph-check-circle' : 'ph-warning-circle'"
                    aria-hidden="true"
                  ></i>
                  {{ adm.remoteBackup.password_present ? "Enregistré" : "Aucun" }}
                </span>
                <button
                  v-if="adm.remoteBackup.password_present"
                  type="button"
                  :disabled="adm.remoteBackupBusy"
                  class="adm-link"
                  @click="adm.clearRsyncPassword()"
                >
                  Retirer
                </button>
              </div>
            </div>
            <div v-if="adm.remoteBackup.connector === 'sftp'" class="adm-row">
              <div>
                <span class="adm-row__label" title="Seule méthode d'authentification acceptée."
                  >Clé privée SSH</span
                >
                <span class="sr-only">Seule méthode d'authentification acceptée.</span>
              </div>
              <div class="flex items-center gap-3 flex-wrap">
                <label
                  class="inline-flex items-center gap-2 text-sm text-slate-700 border border-slate-200 rounded-lg px-3 py-1.5 cursor-pointer hover:bg-slate-50 transition-colors"
                >
                  <i class="ph ph-key text-slate-500" aria-hidden="true"></i> Téléverser une clé
                  <input type="file" class="hidden" @change="adm.uploadBackupKey($event)" />
                </label>
                <span
                  class="text-xs"
                  :class="
                    adm.remoteBackup.key_present || adm.remoteKeyFp ? 'text-emerald-700' : 'text-slate-500'
                  "
                >
                  <i
                    class="ph"
                    :class="
                      adm.remoteBackup.key_present || adm.remoteKeyFp
                        ? 'ph-check-circle'
                        : 'ph-warning-circle'
                    "
                    aria-hidden="true"
                  ></i>
                  {{
                    adm.remoteKeyFp ||
                    (adm.remoteBackup.key_present ? "Clé installée" : "Aucune clé installée")
                  }}
                </span>
              </div>
            </div>
          </template>

          <div v-if="adm.remoteBackup.connector === 'mounted'" class="adm-row">
            <div>
              <label class="adm-row__label" title="Chemin déjà monté sur le serveur." for="mnt-remote-dest"
                >Dossier de destination</label
              >
              <span class="sr-only">Chemin déjà monté sur le serveur.</span>
            </div>
            <input
              id="mnt-remote-dest"
              v-model="adm.remoteBackup.dest_path"
              placeholder="/mnt/nas/backups/elpis"
              class="set-input font-mono text-xs"
            />
          </div>

          <div class="adm-row" data-remote-schedule>
            <div>
              <label class="adm-row__label" for="mnt-remote-every">Planification</label>
              <p class="adm-row__hint">{{ adm.remoteNextRunLabel }}</p>
            </div>
            <div class="flex items-center gap-2 flex-wrap">
              <label class="relative inline-flex items-center gap-2 cursor-pointer">
                <input
                  v-model="adm.remoteBackup.schedule_enabled"
                  type="checkbox"
                  class="sr-only peer"
                  data-remote-schedule-toggle
                />
                <span
                  class="set-switch-track block peer-checked:bg-blue-600 peer-checked:border-blue-600"
                ></span>
                <span class="text-sm text-slate-700">Automatique</span>
              </label>
              <span class="text-sm text-slate-500">toutes les</span>
              <input
                id="mnt-remote-every"
                v-model.number="adm.remoteBackup.schedule_every"
                type="number"
                min="1"
                max="999"
                :disabled="!adm.remoteBackup.schedule_enabled"
                aria-label="Intervalle"
                class="set-input adm-num--sm disabled:opacity-50"
              />
              <select
                v-model="adm.remoteBackup.schedule_unit"
                :disabled="!adm.remoteBackup.schedule_enabled"
                aria-label="Unité"
                class="set-select w-auto disabled:opacity-50"
              >
                <option value="hours">heures</option>
                <option value="days">jours</option>
              </select>
            </div>
          </div>

          <div class="adm-row adm-row--top">
            <div>
              <span class="adm-row__label" title="« Enregistrer » ne concerne que ce bloc.">Actions</span>
              <span class="sr-only">« Enregistrer » ne concerne que ce bloc.</span>
            </div>
            <div>
              <div class="flex items-center gap-2 flex-wrap">
                <button
                  :disabled="adm.remoteBackupBusy"
                  type="button"
                  class="adm-btn adm-tool"
                  @click="adm.sendRemoteBackup()"
                >
                  <i
                    class="ph"
                    :class="adm.remoteBackupBusy ? 'ph-spinner animate-spin' : 'ph-cloud-arrow-up'"
                    aria-hidden="true"
                  ></i>
                  Envoyer maintenant
                </button>
                <button
                  :disabled="adm.remoteBackupBusy"
                  class="adm-btn adm-tool"
                  @click="adm.testRemoteBackup()"
                >
                  <i class="ph ph-plugs" aria-hidden="true"></i> Tester
                </button>
                <button
                  :disabled="adm.remoteBackupBusy"
                  class="adm-btn adm-tool"
                  @click="adm.saveRemoteBackup()"
                >
                  <i class="ph ph-floppy-disk" aria-hidden="true"></i> Enregistrer
                </button>
              </div>
              <p
                v-if="adm.remoteBackup.last_send && adm.remoteBackup.last_send.at"
                class="text-xs mt-2"
                :class="adm.remoteBackup.last_send.ok ? 'text-emerald-700' : 'text-rose-700'"
              >
                Dernier envoi{{ adm.remoteBackup.last_send.trigger === "schedule" ? " (automatique)" : "" }} :
                {{
                  adm.remoteBackup.last_send.ok
                    ? "réussi"
                    : "échec — " + (adm.remoteBackup.last_send.error || "")
                }}
                · {{ adm.remoteDateLabel(adm.remoteBackup.last_send.at) }}
              </p>
            </div>
          </div>
        </div>
      </section>

      <section v-if="adm.adminTab === 'vision'" id="ax-memory" class="adm-card scroll-mt-32">
        <header class="adm-card__head">
          <i class="ph ph-tree-structure adm-card__icon" aria-hidden="true"></i>
          <div class="min-w-0">
            <h3 class="adm-card__title">
              Mémoire AX
              <span v-if="adm.axSites.length" class="font-normal text-slate-500"
                >· {{ adm.axSites.length }} site{{ adm.axSites.length > 1 ? "s" : "" }}</span
              >
            </h3>
            <span class="sr-only"
              >Arbres de pages appris pendant les sessions de navigation. Plus les compteurs sont élevés, plus
              la connaissance est fiable.</span
            >
          </div>
          <div class="adm-card__actions">
            <button
              type="button"
              :disabled="adm.axLoading"
              title="Recharger depuis la base"
              aria-label="Recharger"
              class="adm-btn adm-btn--icon"
              @click="adm.loadAxSites()"
            >
              <i
                class="ph ph-arrow-clockwise"
                :class="adm.axLoading ? 'animate-spin' : ''"
                aria-hidden="true"
              ></i>
            </button>
          </div>
        </header>

        <div class="p-5 space-y-3">
          <p v-if="adm.axLoading" class="adm-empty py-2">Chargement…</p>
          <p v-else-if="!adm.axSites.length" class="adm-empty py-2">
            Aucun site en mémoire. Lancez une session de navigation sur un site pour l'indexer.
          </p>

          <template v-else>
            <div
              v-if="adm.user.role === 'admin' || adm.user.role === 'moderator'"
              class="flex items-center gap-2 text-xs border-b border-slate-100 pb-3 flex-wrap"
            >
              <label class="flex items-center gap-1.5 text-slate-600 cursor-pointer">
                <input
                  type="checkbox"
                  :checked="adm.axSelected.length === adm.axSites.length && adm.axSites.length > 0"
                  class="rounded border-slate-300 text-blue-600"
                  @change="adm.toggleSelectAllAx($event)"
                />
                <span>Tout sélectionner</span>
              </label>
              <span class="text-slate-500"
                >{{ adm.axSelected.length }} sur {{ adm.axSites.length }} sélectionné(s)</span
              >
              <div v-if="adm.axSelected.length > 0" class="ml-auto flex items-center gap-2 flex-wrap">
                <button type="button" class="adm-btn adm-btn--warn adm-btn--sm" @click="adm.bulkMarkStale()">
                  <i class="ph ph-arrows-clockwise" aria-hidden="true"></i> Marquer périmé ({{
                    adm.axSelected.length
                  }})
                </button>
                <button type="button" class="adm-btn adm-btn--danger adm-btn--sm" @click="adm.bulkDelete()">
                  <i class="ph ph-trash" aria-hidden="true"></i> Supprimer ({{ adm.axSelected.length }})
                </button>
              </div>
            </div>

            <div class="space-y-2">
              <div
                v-for="site in adm.axSites"
                :key="site.site"
                class="border border-slate-200 rounded-lg overflow-hidden hover:border-slate-300 transition-colors"
              >
                <div class="flex items-center gap-3 p-2.5 bg-slate-50">
                  <input
                    v-if="adm.user.role === 'admin' || adm.user.role === 'moderator'"
                    v-model="adm.axSelected"
                    type="checkbox"
                    :value="site.site"
                    :aria-label="'Sélectionner ' + site.site"
                    class="rounded border-slate-300 text-blue-600 shrink-0"
                  />
                  <button
                    class="flex-1 text-left flex items-center gap-2 min-w-0"
                    :aria-expanded="adm.axExpanded[site.site] ? 'true' : 'false'"
                    @click="adm.toggleAxSite(site.site)"
                  >
                    <i
                      :class="[
                        'ph',
                        adm.axExpanded[site.site] ? 'ph-caret-down' : 'ph-caret-right',
                        'text-slate-400 text-sm shrink-0',
                      ]"
                      aria-hidden="true"
                    ></i>
                    <span class="font-mono text-sm font-medium text-slate-800 truncate">{{ site.site }}</span>
                    <span class="text-xs text-slate-500 ml-1 shrink-0"
                      >{{ site.elements }} éléments · {{ site.paths }} pages ·
                      {{ site.transitions }} transitions</span
                    >
                  </button>
                  <div
                    v-if="adm.user.role === 'admin' || adm.user.role === 'moderator'"
                    class="flex gap-1 shrink-0"
                  >
                    <button
                      type="button"
                      title="Forcer un ré-apprentissage au prochain usage"
                      aria-label="Marquer périmé"
                      class="adm-btn adm-btn--icon"
                      @click="adm.markStale(site.site)"
                    >
                      <i class="ph ph-arrows-clockwise text-sm" aria-hidden="true"></i>
                    </button>
                    <button
                      type="button"
                      title="Supprimer le site"
                      aria-label="Supprimer le site"
                      class="adm-btn adm-btn--icon adm-btn--icon-danger"
                      @click="adm.deleteSite(site.site)"
                    >
                      <i class="ph ph-trash text-sm" aria-hidden="true"></i>
                    </button>
                  </div>
                </div>
                <div v-if="adm.axExpanded[site.site]" class="bg-slate-950 text-slate-200 text-xs font-mono">
                  <div v-if="adm.axTreeLoading[site.site]" class="p-4 text-slate-400">Chargement…</div>
                  <pre
                    v-else-if="adm.axTrees[site.site]"
                    class="p-4 overflow-x-auto whitespace-pre leading-relaxed"
                    >{{ adm.axTrees[site.site] }}</pre>
                  <div v-else class="p-4 text-slate-500">(vide)</div>
                </div>
              </div>
            </div>
          </template>

          <div
            v-if="adm.user.role === 'admin'"
            class="pt-3 border-t border-slate-100 flex items-center justify-between gap-3 flex-wrap"
          >
            <span class="adm-row__label" title="Tous les sites appris. Confirmation saisie."
              >Tout effacer</span
            >
            <button type="button" class="adm-btn adm-btn--danger" @click="adm.confirmWipeAll()">
              <i class="ph ph-warning-octagon" aria-hidden="true"></i> Effacer la mémoire AX
            </button>
          </div>
        </div>
      </section>
    </div>
  </div>
</template>
