<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/admin/PageJournalisation.vue — page Système › Journalisation : conservation, gel de la purge, centralisation, stockage et écrivains du journal de sécurité (admins). -->
<script setup lang="ts">
import { domaineAdmin } from "../../features/admin/domaine";
import { formateurDate, heureLocale, isoUtc, jourFr } from "../../features/admin/horodatage";
import { octets, pluriel } from "../../features/admin/formats";
import { enMois, etatCertificat } from "../../features/admin/journalisation";

const adm = domaineAdmin();

const DUREES = [
  { n: 180, l: "6 mois" },
  { n: 365, l: "1 an" },
  { n: 1095, l: "3 ans" },
];

const jourLocal = formateurDate({ year: "numeric", month: "numeric", day: "numeric" });
const jour = (iso: string | null): string => {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isNaN(t) ? "" : jourLocal(t);
};
const iconeEtat = (e: string): string =>
  e === "ok" ? "ph-check-circle" : e === "unknown" ? "ph-question" : "ph-warning";
</script>

<template>
  <div v-if="adm.adminTab === 'audit-logging'" class="animate-[fadeIn_0.2s]">
    <div v-if="!adm.auditEtat || !adm.auditForm" class="space-y-6 min-w-0" aria-busy="true">
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
      <section id="audit-logging" class="adm-card scroll-mt-32">
        <header class="adm-card__head">
          <i class="ph ph-clock-counter-clockwise adm-card__icon" aria-hidden="true"></i>
          <div>
            <h3 class="adm-card__title">Conservation</h3>
            <p class="adm-card__hint">
              Pris en compte sans redémarrage. Les fichiers au-delà de la durée sont supprimés chaque nuit,
              après une ligne <span class="sup-mono">audit.purge</span>.
            </p>
          </div>
        </header>
        <div class="adm-rows">
          <div class="adm-row">
            <div>
              <label
                class="adm-row__label"
                for="jnl-duree"
                title="Entre 180 et 1 095 jours (6 mois à 3 ans). 365 par défaut."
                >Durée de conservation</label
              >
            </div>
            <div>
              <div class="flex items-center gap-2 flex-wrap">
                <input
                  id="jnl-duree"
                  v-model.number="adm.auditForm.retention_days"
                  type="number"
                  min="180"
                  max="1095"
                  step="1"
                  class="set-input adm-num"
                  data-field="audit:retention_days"
                  aria-describedby="jnl-duree-aide"
                  :aria-invalid="adm.auditDureeValide ? undefined : 'true'"
                />
                <span id="jnl-duree-aide" class="adm-unit"
                  >jours{{ adm.auditDureeValide ? " · " + enMois(adm.auditForm.retention_days) : "" }}</span
                >
                <span class="sup-puces" role="group" aria-label="Durées courantes">
                  <button
                    v-for="d in DUREES"
                    :key="d.n"
                    type="button"
                    class="adm-chip"
                    :aria-pressed="adm.auditForm.retention_days === d.n ? 'true' : 'false'"
                    @click="adm.auditForm.retention_days = d.n"
                  >
                    {{ d.l }}
                  </button>
                </span>
              </div>
              <div v-if="!adm.auditDureeValide" class="jnl-champ-err" role="alert">
                Entre 180 et 1 095 jours.
              </div>
              <div v-else-if="adm.auditSupprimes" class="jnl-avertir">
                <i class="ph ph-warning" aria-hidden="true"></i>
                {{ adm.auditReglages?.hold ? "À la levée du gel, la purge" : "La prochaine purge" }}
                supprimera {{ pluriel(adm.auditSupprimes, "fichier") }}.
              </div>
              <div v-if="adm.auditSaveErreur" class="jnl-champ-err" role="alert">
                {{ adm.auditSaveErreur }}
              </div>
            </div>
          </div>
          <div
            v-if="
              adm.auditEtat.retention.invalid ||
              adm.auditEtat.retention.from_witness ||
              adm.auditEtat.retention.out_of_bounds
            "
            class="adm-row adm-row--full"
          >
            <div class="jnl-avertir" role="status">
              <i class="ph ph-warning" aria-hidden="true"></i>
              <template v-if="adm.auditEtat.retention.invalid">
                Durée illisible dans config.json : purge suspendue.
              </template>
              <template v-else-if="adm.auditEtat.retention.from_witness">
                Réglages absents de config.json : valeurs reprises du témoin du dossier du journal.
              </template>
              <template v-else>
                Durée écrite à la main hors des bornes de 180 à 1 095 jours : jamais de purge plus courte que
                180 jours.
              </template>
              <button
                id="jnl-reecrire"
                type="button"
                class="adm-btn adm-tool adm-btn--sm"
                :disabled="!adm.auditDureeValide"
                @click="adm.reecrireAudit()"
              >
                Réécrire dans config.json
              </button>
            </div>
          </div>
          <div class="adm-row">
            <div><span class="adm-row__label">Journal actuel</span></div>
            <div class="text-sm adm-muted">
              {{ pluriel(adm.auditEtat.files, "fichier") }} · {{ octets(adm.auditEtat.bytes) }}
              <template v-if="adm.auditEtat.oldest">
                · du {{ jourFr(adm.auditEtat.oldest) }} au {{ jourFr(adm.auditEtat.newest ?? "") }}
              </template>
            </div>
          </div>
          <div class="adm-row">
            <div><span class="adm-row__label">Prochaine purge</span></div>
            <div>
              <span v-if="adm.auditEtat.retention.hold" class="adm-status" data-state="unknown">
                <i class="ph ph-snowflake" aria-hidden="true"></i> Suspendue : gel actif
              </span>
              <span
                v-else-if="
                  adm.auditEtat.retention.invalid ||
                  (adm.auditEtat.forwarding.expected &&
                    (!adm.auditEtat.forwarding.agent ||
                      !adm.auditEtat.forwarding.rule ||
                      adm.auditEtat.forwarding.active !== true))
                "
                class="adm-status"
                data-state="down"
              >
                <i class="ph ph-warning-octagon" aria-hidden="true"></i> Suspendue :
                {{ adm.auditEtat.retention.invalid ? "durée illisible" : "centralisation absente" }}
              </span>
              <span v-else class="adm-status" data-state="ok">
                <i class="ph ph-check-circle" aria-hidden="true"></i> Cette nuit
              </span>
            </div>
          </div>
        </div>
      </section>

      <section class="adm-card">
        <header class="adm-card__head">
          <i class="ph ph-snowflake adm-card__icon" aria-hidden="true"></i>
          <div>
            <h3 class="adm-card__title">Gel de la purge</h3>
            <p class="adm-card__hint">
              Pour une enquête ou une demande légale : rien n'est supprimé tant que le gel dure. Le gel ne
              prolonge pas les journaux techniques.
            </p>
          </div>
        </header>
        <div class="adm-rows">
          <template v-if="adm.auditEtat.retention.hold">
            <div class="adm-row adm-row--full">
              <div class="jnl-gel-actif" role="status">
                <i class="ph ph-snowflake" aria-hidden="true"></i>
                <div>
                  <b>Gel actif</b><br />
                  Motif : {{ adm.auditEtat.retention.hold_reason }}
                  <template v-if="adm.auditEtat.retention.eligible_files">
                    <br /><span class="adm-muted"
                      >{{ pluriel(adm.auditEtat.retention.eligible_files, "fichier") }}
                      {{ adm.auditEtat.retention.eligible_files > 1 ? "gardés" : "gardé" }} au-delà de la
                      durée.</span
                    >
                  </template>
                </div>
              </div>
            </div>
            <div class="adm-row">
              <div></div>
              <div>
                <button
                  id="jnl-lever"
                  type="button"
                  class="adm-btn adm-btn--danger"
                  :disabled="adm.auditGelEnCours"
                  @click="adm.leverGel()"
                >
                  <i class="ph ph-sun" aria-hidden="true"></i> Lever le gel
                </button>
                <div v-if="adm.auditGelErreur" class="jnl-champ-err" role="alert">
                  {{ adm.auditGelErreur }}
                </div>
              </div>
            </div>
          </template>
          <div v-else class="adm-row">
            <div>
              <label
                class="adm-row__label"
                for="jnl-motif"
                title="Noté dans le journal avec le gel. Obligatoire."
                >Motif</label
              >
            </div>
            <div>
              <div class="flex items-center gap-2 flex-wrap">
                <input
                  id="jnl-motif"
                  v-model="adm.auditMotif"
                  class="set-input"
                  style="flex: 1; min-width: 14rem"
                  maxlength="500"
                  placeholder="Ex. : enquête interne n° 2026-15, demande du RSSI"
                  @keydown.enter.prevent="adm.geler()"
                />
                <button
                  id="jnl-geler"
                  type="button"
                  class="adm-btn adm-btn--warn"
                  :disabled="adm.auditMotif.trim().length < 5 || adm.auditGelEnCours"
                  :title="
                    adm.auditMotif.trim().length < 5
                      ? 'Saisissez un motif (5 caractères au moins)'
                      : undefined
                  "
                  @click="adm.geler()"
                >
                  <i class="ph ph-snowflake" aria-hidden="true"></i> Geler la purge
                </button>
              </div>
              <div v-if="adm.auditGelErreur" class="jnl-champ-err" role="alert">
                {{ adm.auditGelErreur }}
              </div>
            </div>
          </div>
        </div>
      </section>

      <section class="adm-card">
        <header class="adm-card__head">
          <i class="ph ph-share-network adm-card__icon" aria-hidden="true"></i>
          <div>
            <h3 class="adm-card__title">Centralisation</h3>
            <p class="adm-card__hint">
              L'envoi vers le collecteur est fait par l'agent syslog de l'hôte. Elpis lit son état, sans rien
              modifier.
            </p>
          </div>
        </header>
        <div class="adm-rows">
          <div class="adm-row">
            <div>
              <span
                class="adm-row__label"
                title="Si l'agent syslog, la règle Elpis ou le service manque, la purge est suspendue et une alerte s'affiche dans Vue d'ensemble."
                >Centralisation attendue</span
              >
            </div>
            <div>
              <label class="relative inline-flex items-center gap-2 cursor-pointer">
                <input
                  v-model="adm.auditForm.forwarding_expected"
                  type="checkbox"
                  class="sr-only peer"
                  data-field="audit:forwarding_expected"
                  aria-label="Centralisation attendue"
                />
                <span
                  class="set-switch-track block peer-checked:bg-blue-600 peer-checked:border-blue-600"
                ></span>
                <span class="text-sm">{{
                  adm.auditForm.forwarding_expected ? "Oui : la purge attend un envoi actif" : "Non"
                }}</span>
              </label>
            </div>
          </div>
          <div class="adm-row adm-row--top">
            <div>
              <span class="adm-row__label">État sur l'hôte</span>
              <span class="adm-row__hint" :title="isoUtc(adm.auditEtat.generated_at)"
                >Lu à {{ heureLocale(adm.auditEtat.generated_at) }}</span
              >
            </div>
            <dl class="sup-champs sup-champs--page">
              <dt>Agent</dt>
              <dd>
                <template v-if="adm.auditEtat.forwarding.agent">
                  {{ adm.auditEtat.forwarding.agent }}
                </template>
                <span v-else class="adm-status" data-state="down"
                  ><i class="ph ph-x-circle" aria-hidden="true"></i> Aucun agent syslog</span
                >
              </dd>
              <dt>Service</dt>
              <dd>
                <span v-if="adm.auditEtat.forwarding.active === true" class="adm-status" data-state="ok"
                  ><i class="ph ph-check-circle" aria-hidden="true"></i> Actif</span
                >
                <span
                  v-else-if="adm.auditEtat.forwarding.active === false"
                  class="adm-status"
                  data-state="down"
                  ><i class="ph ph-x-circle" aria-hidden="true"></i> Arrêté</span
                >
                <span v-else class="adm-status" data-state="unknown"
                  ><i class="ph ph-question" aria-hidden="true"></i> Inconnu</span
                >
              </dd>
              <dt>Règle Elpis</dt>
              <dd class="sup-mono">{{ adm.auditEtat.forwarding.rule || "absente" }}</dd>
              <dt>Collecteur</dt>
              <dd>
                <template v-if="adm.auditEtat.forwarding.collector">
                  <span class="sup-mono">{{ adm.auditEtat.forwarding.collector }}</span
                  ><span v-if="adm.auditEtat.forwarding.transport" class="adm-muted">
                    · {{ adm.auditEtat.forwarding.transport }}</span
                  >
                </template>
                <template v-else>—</template>
              </dd>
              <dt>File disque</dt>
              <dd>
                <template v-if="adm.auditEtat.forwarding.queue">
                  {{ adm.auditEtat.forwarding.queue.type }}
                  <template v-if="adm.auditEtat.forwarding.queue.file">
                    · <span class="sup-mono">{{ adm.auditEtat.forwarding.queue.file }}</span>
                  </template>
                  <template v-if="adm.auditEtat.forwarding.queue.max_disk">
                    · {{ adm.auditEtat.forwarding.queue.max_disk }} au plus
                  </template>
                </template>
                <template v-else>—</template>
              </dd>
              <template v-for="c in adm.auditEtat.forwarding.certificates" :key="c.path">
                <dt>{{ c.role === "ca" ? "Autorité (CA)" : "Certificat client" }}</dt>
                <dd>
                  <span class="sup-mono">{{ c.path }}</span
                  ><br />
                  <span class="adm-status" :data-state="etatCertificat(c.days_left)">
                    <i class="ph" :class="iconeEtat(etatCertificat(c.days_left))" aria-hidden="true"></i>
                    <template v-if="c.readable && c.days_left !== null">
                      <span :title="c.expires_at ?? undefined"
                        >{{ c.days_left < 0 ? "Expiré le " : "Expire le " }}{{ jour(c.expires_at) }}</span
                      >
                      ·
                      {{
                        c.days_left === 0
                          ? "aujourd'hui"
                          : (c.days_left < 0 ? "depuis " : "dans ") + pluriel(Math.abs(c.days_left), "jour")
                      }}
                    </template>
                    <template v-else>Illisible par Elpis</template>
                  </span>
                </dd>
              </template>
            </dl>
          </div>
          <details v-if="!adm.auditEtat.forwarding.rule" class="adm-details adm-details--rows">
            <summary>Mettre en place l'envoi</summary>
            <div class="adm-row adm-row--full">
              <div class="space-y-2 text-sm adm-muted">
                <p>
                  Aucune règle Elpis n'est installée sur l'hôte. Un exemple (TCP + TLS, file disque) est
                  fourni dans le dépôt : <span class="sup-mono">deploy/rsyslog/60-elpis.conf.example</span>.
                </p>
                <p>
                  Copiez-le dans <span class="sup-mono">/etc/rsyslog.d/60-elpis.conf</span>, adaptez le
                  collecteur et les certificats, lancez
                  <span class="sup-mono">sudo ./elpis audit setup</span>, puis redémarrez rsyslog. Guide :
                  <span class="sup-mono">docs/operations.md</span>, section « Security journal and log
                  forwarding ».
                </p>
              </div>
            </div>
          </details>
          <div class="adm-row adm-row--top">
            <div>
              <span
                class="adm-row__label"
                title="Écrit une ligne audit.test avec un code unique. Cherchez ce code dans le collecteur pour prouver que la chaîne fonctionne."
                >Événement de test</span
              >
            </div>
            <div>
              <button
                id="jnl-test"
                type="button"
                class="adm-btn adm-tool"
                :disabled="adm.auditTestEnCours || adm.auditTestAttente"
                @click="adm.ecrireTestAudit()"
              >
                <i class="ph ph-paper-plane-tilt" aria-hidden="true"></i> Écrire un événement de test
              </button>
              <span v-if="adm.auditTestAttente" class="adm-unit"> Possible dans quelques secondes</span>
              <div v-if="adm.auditTestErreur" class="jnl-champ-err" role="alert">
                {{ adm.auditTestErreur }}
              </div>
              <div v-if="adm.auditTest" class="jnl-nonce" role="status">
                <i class="ph ph-check-circle" aria-hidden="true"></i>
                <span
                  ><span class="sup-mono">audit.test</span> écrit à
                  <span :title="isoUtc(adm.auditTest.ts)">{{ heureLocale(adm.auditTest.ts) }}</span
                  >. Cherchez ce code dans le collecteur :</span
                >
                <code>{{ adm.auditTest.nonce }}</code>
                <button
                  type="button"
                  class="adm-btn adm-btn--icon"
                  title="Copier le code"
                  aria-label="Copier le code"
                  @click="adm.copierNonce()"
                >
                  <i class="ph ph-copy" aria-hidden="true"></i>
                </button>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section class="adm-card">
        <header class="adm-card__head">
          <i class="ph ph-folder-lock adm-card__icon" aria-hidden="true"></i>
          <div>
            <h3 class="adm-card__title">Emplacement et signature</h3>
          </div>
          <div class="adm-card__actions">
            <button
              type="button"
              class="adm-btn adm-btn--quiet adm-btn--sm"
              @click="adm.goAdminPage('logs', 'security')"
            >
              Ouvrir le journal <i class="ph ph-arrow-right" aria-hidden="true"></i>
            </button>
          </div>
        </header>
        <div class="adm-rows">
          <div class="adm-row adm-row--full">
            <dl class="sup-champs sup-champs--page">
              <dt>Dossier</dt>
              <dd>
                <span class="sup-mono">{{ adm.auditEtat.directory }}</span>
                <span v-if="adm.auditEtat.mode" class="adm-muted"> · droits {{ adm.auditEtat.mode }}</span>
                <span v-if="adm.auditEtat.world_readable" class="adm-status" data-state="down">
                  <i class="ph ph-warning-octagon" aria-hidden="true"></i> Lisible par tous
                </span>
                <template v-if="adm.auditEtat.fallback_directory">
                  <br /><span class="adm-status" data-state="warn"
                    ><i class="ph ph-warning" aria-hidden="true"></i> Dossier de repli : lancez « sudo ./elpis
                    audit setup »</span
                  >
                </template>
              </dd>
              <dt>Signature</dt>
              <dd>
                <template v-if="adm.auditEtat.signed">
                  <span class="adm-status" data-state="ok"
                    ><i class="ph ph-seal-check" aria-hidden="true"></i> Active</span
                  >
                  <span v-if="adm.auditEtat.kid" class="adm-muted">
                    · HMAC-SHA256, clé {{ adm.auditEtat.kid }}</span
                  >
                </template>
                <template v-else>
                  <span class="adm-status" data-state="warn"
                    ><i class="ph ph-seal-warning" aria-hidden="true"></i> Absente</span
                  >
                  <span class="adm-muted"> · /etc/elpis/audit.key manquante</span>
                </template>
              </dd>
              <dt>Fichiers</dt>
              <dd>
                {{ pluriel(adm.auditEtat.files, "fichier") }} · {{ octets(adm.auditEtat.bytes) }}
                <span v-if="adm.auditEtat.oldest" class="adm-muted"
                  >· plus ancien : {{ jourFr(adm.auditEtat.oldest) }}</span
                >
              </dd>
              <dt>Disque</dt>
              <dd>
                <template v-if="adm.auditEtat.disk">
                  {{ octets(adm.auditEtat.disk.free_bytes) }} libres sur
                  {{ octets(adm.auditEtat.disk.total_bytes) }}
                  <span v-if="adm.auditEtat.disk.days_left !== null" class="adm-muted"
                    >· plein
                    {{
                      adm.auditEtat.disk.days_left === 0
                        ? "aujourd'hui"
                        : "dans " + pluriel(adm.auditEtat.disk.days_left, "jour")
                    }}
                    au rythme actuel</span
                  >
                </template>
                <span v-else class="adm-muted">Inconnu</span>
              </dd>
              <dt>Écritures</dt>
              <dd>
                <template v-if="adm.auditEtat.write_failures.count">
                  <span class="adm-status" data-state="down"
                    ><i class="ph ph-warning-octagon" aria-hidden="true"></i>
                    {{ adm.auditEtat.write_failures.count }} en échec</span
                  >
                  <br /><span class="sup-mono adm-muted">{{ adm.auditEtat.write_failures.last_error }}</span>
                </template>
                <span v-else class="adm-status" data-state="ok"
                  ><i class="ph ph-check-circle" aria-hidden="true"></i> Aucun échec</span
                >
              </dd>
              <dt>Horloge</dt>
              <dd>
                <span v-if="adm.auditEtat.clock_synchronized === true" class="adm-status" data-state="ok"
                  ><i class="ph ph-check-circle" aria-hidden="true"></i> Synchronisée</span
                >
                <template v-else-if="adm.auditEtat.clock_synchronized === false">
                  <span class="adm-status" data-state="warn"
                    ><i class="ph ph-warning" aria-hidden="true"></i> Non synchronisée</span
                  >
                  <span class="adm-muted"> · configurez chrony</span>
                </template>
                <span v-else class="adm-status" data-state="unknown"
                  ><i class="ph ph-question" aria-hidden="true"></i> Inconnue</span
                >
              </dd>
            </dl>
          </div>
          <div class="adm-row adm-row--full">
            <table class="adm-table w-full jnl-ecrivains">
              <thead>
                <tr>
                  <th class="text-left">Écrivain</th>
                  <th class="text-left">Dernière ligne</th>
                  <th class="text-left">Dernière action</th>
                  <th class="text-left">État</th>
                </tr>
              </thead>
              <tbody>
                <tr v-if="!adm.auditEtat.writers.length">
                  <td colspan="4" class="text-center adm-empty">
                    Aucun écrivain vu ces deux derniers jours.
                  </td>
                </tr>
                <tr v-for="w in adm.auditEtat.writers" :key="w.host + w.service + w.boot">
                  <td>
                    {{ w.service }}
                    <span class="adm-muted sup-mono" :title="w.host + ' · ' + w.boot"
                      >{{ w.boot.slice(0, 8) }}…</span
                    >
                  </td>
                  <td class="sup-quand" :title="isoUtc(w.last_ts)">{{ heureLocale(w.last_ts) }}</td>
                  <td>
                    <span class="sup-mono">{{ w.last_action }}</span>
                  </td>
                  <td>
                    <span v-if="w.stopped" class="adm-status" data-state="off"
                      ><i class="ph ph-stop-circle" aria-hidden="true"></i> Arrêté proprement</span
                    >
                    <span v-else-if="(w.failures ?? 0) > 0" class="adm-status" data-state="down"
                      ><i class="ph ph-warning-octagon" aria-hidden="true"></i>
                      {{ pluriel(w.failures ?? 0, "échec") }}</span
                    >
                    <span v-else class="adm-status" data-state="ok"
                      ><i class="ph ph-check-circle" aria-hidden="true"></i> En cours</span
                    >
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </section>
    </div>
  </div>
</template>
