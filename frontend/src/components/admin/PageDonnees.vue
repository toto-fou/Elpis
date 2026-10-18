<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/admin/PageDonnees.vue — page Données (base, sauvegardes). -->
<script setup lang="ts">
import { domaineAdmin } from "../../features/admin/domaine";

const adm = domaineAdmin();
</script>

<template>
  <div v-if="adm.adminTab === 'data'" class="animate-[fadeIn_0.2s]">
    <div class="space-y-6 min-w-0">
      <section v-if="adm.adminTab === 'data'" id="db-state" class="adm-card scroll-mt-32">
        <header class="adm-card__head">
          <i class="ph ph-database adm-card__icon" aria-hidden="true"></i>
          <div><h3 class="adm-card__title">État</h3></div>
          <span
            v-if="adm.dbState && adm.dbState.env && adm.dbState.env.length"
            class="ml-auto text-[11px] font-semibold px-1.5 py-0.5 rounded bg-amber-50 text-amber-700 border border-amber-200"
            :title="'Imposé par l’environnement : ' + adm.dbState.env.join(', ')"
            >Environnement</span
          >
        </header>
        <div v-if="adm.dbState && adm.dbState.active" class="adm-rows">
          <div v-if="adm.dbState.active.error" class="px-5 py-3 text-sm text-red-700">
            ✗ {{ adm.dbState.active.error }}
          </div>
          <template v-else>
            <div class="adm-row">
              <span class="adm-row__label">Moteur</span
              ><span class="font-mono text-xs">{{ adm.dbState.active.backend }}</span>
            </div>
            <div class="adm-row">
              <span class="adm-row__label">Version</span
              ><span class="font-mono text-xs">{{ adm.dbState.active.version || "—" }}</span>
            </div>
            <div class="adm-row">
              <span class="adm-row__label">Emplacement</span
              ><span class="font-mono text-xs break-all">{{ adm.dbState.active.location || "—" }}</span>
            </div>
            <div class="adm-row">
              <span class="adm-row__label">Taille</span
              ><span class="font-mono text-xs">{{ adm.fmtBytes(adm.dbState.active.size_bytes) }}</span>
            </div>
            <div class="adm-row">
              <span class="adm-row__label">Schéma</span>
              <span class="font-mono text-xs" :title="adm.dbState.active.last_migration || ''"
                >{{ adm.dbState.active.migrations }} migrations</span
              >
            </div>
            <div v-if="adm.dbState.active.pool" class="adm-row">
              <span class="adm-row__label">Pool</span>
              <span class="font-mono text-xs"
                >{{ adm.dbState.active.pool.in_use }} / {{ adm.dbState.active.pool.max }}</span
              >
            </div>
          </template>
        </div>
        <div v-else class="px-5 py-6"><div class="adm-skeleton w-48"></div></div>
      </section>

      <section v-if="adm.adminTab === 'data'" id="db-connection" class="adm-card scroll-mt-32">
        <header class="adm-card__head">
          <i class="ph ph-plugs-connected adm-card__icon" aria-hidden="true"></i>
          <div><h3 class="adm-card__title">Connexion</h3></div>
        </header>
        <div class="adm-rows">
          <div class="adm-row">
            <span class="adm-row__label">Moteur</span><span class="text-sm">PostgreSQL</span>
          </div>
          <div class="adm-row">
            <label class="adm-row__label" for="db-host">Hôte</label>
            <div class="flex items-center gap-2">
              <input
                id="db-host"
                v-model="adm.dbForm.host"
                placeholder="127.0.0.1"
                class="set-input font-mono text-xs"
              />
              <input
                v-model.number="adm.dbForm.port"
                type="number"
                min="1"
                max="65535"
                aria-label="Port"
                title="Port"
                class="set-input adm-num"
              />
            </div>
          </div>
          <div class="adm-row">
            <label class="adm-row__label" for="db-name">Base</label>
            <input
              id="db-name"
              v-model="adm.dbForm.name"
              placeholder="elpis"
              class="set-input font-mono text-xs"
            />
          </div>
          <div class="adm-row">
            <label class="adm-row__label" for="db-user">Utilisateur</label>
            <input
              id="db-user"
              v-model="adm.dbForm.user"
              placeholder="elpis"
              autocomplete="off"
              class="set-input font-mono text-xs"
            />
          </div>
          <div class="adm-row">
            <label class="adm-row__label" for="db-password">Mot de passe</label>
            <input
              id="db-password"
              v-model="adm.dbForm.password"
              type="password"
              autocomplete="new-password"
              :placeholder="
                adm.dbState && adm.dbState.saved && adm.dbState.saved.password_present ? 'Inchangé' : ''
              "
              class="set-input font-mono text-xs"
            />
          </div>
          <div class="adm-row">
            <label class="adm-row__label" for="db-tls">TLS</label>
            <select id="db-tls" v-model="adm.dbForm.tls" class="set-select w-auto min-w-[10rem]">
              <option value="off">Aucun</option>
              <option value="require">Chiffré</option>
              <option value="verify">Vérifié</option>
            </select>
          </div>
          <div class="adm-row adm-row--top">
            <span class="adm-row__label">Actions</span>
            <div>
              <div class="flex items-center gap-2 flex-wrap">
                <button
                  type="button"
                  :disabled="adm.dbTest.state === 'busy'"
                  class="adm-btn adm-btn--quiet"
                  title="Tester sans enregistrer"
                  @click="adm.testDatabase"
                >
                  <i
                    class="ph"
                    :class="adm.dbTest.state === 'busy' ? 'ph-circle-notch animate-spin' : 'ph-pulse'"
                    aria-hidden="true"
                  ></i>
                  Tester
                </button>
                <button
                  type="button"
                  :disabled="adm.dbBusy"
                  class="adm-btn adm-btn--quiet"
                  title="Enregistrer sans changer de base active"
                  @click="adm.saveDatabase"
                >
                  <i class="ph ph-floppy-disk" aria-hidden="true"></i>
                  Enregistrer
                </button>
              </div>
              <div
                v-if="adm.dbTest.state === 'ok'"
                class="mt-3 p-3 rounded-lg bg-emerald-50 border border-emerald-200 text-xs text-emerald-900"
              >
                <div class="font-medium">✓ {{ adm.dbTest.detail.version }}</div>
                <dl class="mt-1.5 grid grid-cols-[max-content_1fr] gap-x-3 gap-y-0.5">
                  <dt class="font-medium">Tables</dt>
                  <dd class="font-mono">
                    {{
                      adm.dbTest.detail.partial
                        ? "copie interrompue : vidée puis reprise à la migration"
                        : adm.dbTest.detail.empty
                          ? "vide"
                          : adm.dbTest.detail.tables
                    }}
                  </dd>
                  <dt class="font-medium">Latence</dt>
                  <dd class="font-mono">{{ adm.dbTest.detail.query_ms }} ms</dd>
                  <template v-if="adm.dbTest.detail.unaccent === false">
                    <dt class="font-medium">unaccent</dt>
                    <dd>⚠ absent</dd>
                  </template>
                </dl>
              </div>
              <div
                v-else-if="adm.dbTest.state === 'err'"
                class="mt-3 p-3 rounded-lg bg-red-50 border border-red-200 text-xs text-red-800 break-words"
              >
                ✗ {{ adm.dbTest.detail }}
              </div>
            </div>
          </div>
        </div>
      </section>

      <section v-if="adm.adminTab === 'data'" id="db-transfer" class="adm-card scroll-mt-32">
        <header class="adm-card__head">
          <i class="ph ph-arrows-left-right adm-card__icon" aria-hidden="true"></i>
          <div><h3 class="adm-card__title">Migration</h3></div>
        </header>
        <div class="adm-rows">
          <div class="adm-row adm-row--top">
            <span class="adm-row__label">Vers le serveur</span>
            <div>
              <div class="flex items-center gap-2 flex-wrap">
                <button
                  type="button"
                  :disabled="adm.dbSim.state === 'busy' || adm.dbJob.state === 'running'"
                  class="adm-btn adm-btn--quiet"
                  title="Contrôles et comptes, sans rien écrire"
                  @click="adm.simulateDatabase"
                >
                  <i
                    class="ph"
                    :class="adm.dbSim.state === 'busy' ? 'ph-circle-notch animate-spin' : 'ph-flask'"
                    aria-hidden="true"
                  ></i>
                  Simuler
                </button>
                <button
                  type="button"
                  :disabled="
                    adm.dbJob.state === 'running' ||
                    !!(adm.dbState && adm.dbState.env && adm.dbState.env.includes('APP_DB_BACKEND'))
                  "
                  class="adm-btn adm-btn--primary"
                  title="Copie vers la base vide ci-dessus, vérification, redémarrage"
                  @click="adm.migrateDatabase"
                >
                  <i class="ph ph-arrow-right" aria-hidden="true"></i>
                  Migrer et basculer
                </button>
              </div>
              <div
                v-if="adm.dbSim.state === 'ok'"
                class="mt-3 p-3 rounded-lg bg-slate-50 border border-slate-200 text-xs text-slate-700"
              >
                <div class="font-medium">
                  ✓ {{ Object.keys(adm.dbSim.detail.tables).length }} tables,
                  {{ Object.values(adm.dbSim.detail.tables).reduce((a, t) => a + (t.source || 0), 0) }} lignes
                </div>
                <div
                  v-if="Object.keys(adm.dbSim.detail.ignored || {}).length"
                  class="mt-1"
                  :title="Object.keys(adm.dbSim.detail.ignored || {}).join(', ')"
                >
                  Ignorées : {{ Object.keys(adm.dbSim.detail.ignored || {}).length }}
                </div>
              </div>
              <div
                v-else-if="adm.dbSim.state === 'err'"
                class="mt-3 p-3 rounded-lg bg-red-50 border border-red-200 text-xs text-red-800 break-words"
              >
                ✗ {{ adm.dbSim.detail }}
              </div>
            </div>
          </div>
          <div
            v-if="
              adm.dbState &&
              adm.dbState.active &&
              adm.dbState.active.backend &&
              adm.dbState.active.backend !== 'sqlite'
            "
            class="adm-row"
          >
            <span class="adm-row__label">Retour</span>
            <button
              type="button"
              :disabled="adm.dbJob.state === 'running'"
              class="adm-btn adm-btn--quiet"
              title="Copie vers un fichier SQLite neuf ; l’ancien est gardé en .bak"
              @click="adm.revertDatabaseToSqlite"
            >
              <i class="ph ph-arrow-u-up-left" aria-hidden="true"></i>
              Revenir à SQLite
            </button>
          </div>
          <div v-if="adm.dbJob.state && adm.dbJob.state !== 'idle'" class="adm-row" aria-live="polite">
            <span class="adm-row__label">Tâche</span>
            <span class="text-xs" :class="adm.dbJob.state === 'error' ? 'text-red-700' : 'text-slate-700'">
              <template v-if="adm.dbJob.state === 'running'"
                ><i class="ph ph-circle-notch animate-spin" aria-hidden="true"></i> {{ adm.dbJob.step
                }}<template v-if="adm.dbJob.progress">
                  — {{ adm.dbJob.progress[0] }}/{{ adm.dbJob.progress[1] }}</template
                ></template
              >
              <template v-else-if="adm.dbJob.state === 'done'">✓ Terminé, redémarrage</template>
              <template v-else-if="adm.dbJob.state === 'error'">✗ {{ adm.dbJob.error }}</template>
            </span>
          </div>
        </div>
      </section>

      <section
        v-if="adm.adminTab === 'data'"
        id="restore"
        class="adm-card adm-zone"
        aria-labelledby="restore-zone-h"
      >
        <header class="adm-card__head">
          <i class="ph ph-warning adm-card__icon" aria-hidden="true"></i>
          <div><h3 id="restore-zone-h" class="adm-card__title">Zone sensible</h3></div>
        </header>
        <div class="adm-rows">
          <div class="adm-row">
            <div>
              <label
                class="adm-row__label"
                for="restore-scope"
                title="Remplace les données existantes par celles d'une archive. Sans retour arrière."
                >Restaurer</label
              >
              <span class="sr-only"
                >Remplace les données existantes par celles d'une archive. Sans retour arrière.</span
              >
            </div>
            <div class="flex flex-wrap items-center gap-2">
              <select id="restore-scope" v-model="adm.restoreScope" class="set-select w-48">
                <option value="full">Complète</option>
                <option value="db">Base de données</option>
                <option value="sandboxes">Sandboxes</option>
                <option value="mcp">Serveurs MCP</option>
              </select>
              <button
                type="button"
                class="adm-btn adm-btn--danger"
                @click="adm.triggerRestore(adm.restoreScope)"
              >
                <i class="ph ph-upload-simple" aria-hidden="true"></i> Restaurer…
              </button>
            </div>
          </div>
        </div>

        <input
          id="restore-file-input"
          type="file"
          class="hidden"
          accept=".zip,.gz,.tar,.tar.gz,.db,.sqlite"
        />
      </section>
    </div>
  </div>
</template>
