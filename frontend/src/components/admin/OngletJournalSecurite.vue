<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/admin/OngletJournalSecurite.vue — Journaux › Sécurité (admins) : état du journal signé, filtres, liste paginée par curseur, détail, export et vérification d'intégrité. -->
<script setup lang="ts">
import { computed } from "vue";

import { domaineAdmin } from "../../features/admin/domaine";
import { heureLocale, isoUtc } from "../../features/admin/horodatage";
import { CATEGORIES_JOURNAL, SERVICES_JOURNAL, actionEffective } from "../../features/admin/journal-securite";
import {
  LIBELLES_ACTIONS,
  classeAction,
  resumeDetails,
} from "../../features/admin/journal-securite-affichage";
import { octets } from "../../features/admin/formats";
import BandeauJournalSecurite from "./BandeauJournalSecurite.vue";
import ChoixPeriode from "./ChoixPeriode.vue";
import EtatActualisation from "./EtatActualisation.vue";
import ExportJournalModale from "./ExportJournalModale.vue";
import ResultatVerificationJournal from "./ResultatVerificationJournal.vue";
import TiroirEvenementJournal from "./TiroirEvenementJournal.vue";

const adm = domaineAdmin();
const filtresActifs = computed(
  () =>
    (adm.secuFiltres.cat || adm.secuFiltres.action.trim() ? 1 : 0) +
    (["compte", "resultat", "ip", "service", "texte"] as const).filter((k) => adm.secuFiltres[k].trim())
      .length,
);
const premiere = computed(() => (adm.secuRangsPages[adm.secuNumeroPage] ?? 0) + 1);
const filtreDeMarqueur = computed(() => actionEffective(adm.secuFiltres).startsWith("audit.writer"));
const valeur = (ev: Event): string => (ev.target as HTMLInputElement).value;
const coche = (ev: Event): boolean => (ev.target as HTMLInputElement).checked;
</script>

<template>
  <div class="space-y-3" :aria-busy="adm.secuChargement ? 'true' : 'false'">
    <BandeauJournalSecurite />

    <div class="sup-secu-barre">
      <ChoixPeriode
        :periode="adm.secuPlage === 'periode' ? adm.secuHeures : -1"
        @choisir="adm.secuChoisirPeriode($event)"
      >
        <button
          type="button"
          class="adm-seg__btn"
          :class="{ 'is-active': adm.secuPlage === 'dates' }"
          :aria-pressed="adm.secuPlage === 'dates' ? 'true' : 'false'"
          @click="adm.secuChoisirDates()"
        >
          Dates
        </button>
      </ChoixPeriode>
      <span v-if="adm.secuPlage === 'dates'" class="sup-secu-dates">
        <label for="secu-du">Du</label>
        <input
          id="secu-du"
          v-model="adm.secuDu"
          type="date"
          class="set-input"
          @change="adm.secuChoisirDates()"
        />
        <label for="secu-au">au</label>
        <input
          id="secu-au"
          v-model="adm.secuAu"
          type="date"
          class="set-input"
          @change="adm.secuChoisirDates()"
        />
      </span>
      <span v-if="adm.secuErreurDates" class="sup-secu-danger text-xs" role="alert">{{
        adm.secuErreurDates
      }}</span>
      <div class="sup-secu-barre__fin">
        <EtatActualisation
          :chargement="adm.secuChargement"
          :derniere-maj="adm.secuDerniereMaj"
          :echec="adm.secuEchec"
          @actualiser="adm.secuActualiser()"
        />
        <button
          id="secu-verifier"
          type="button"
          class="adm-btn adm-tool"
          :disabled="adm.secuVerification?.statut === 'en_cours'"
          @click="adm.verifierIntegrite()"
        >
          <i class="ph ph-seal-check" aria-hidden="true"></i> Vérifier l'intégrité
        </button>
        <button id="secu-exporter" type="button" class="adm-btn adm-tool" @click="adm.ouvrirExport()">
          <i class="ph ph-download-simple" aria-hidden="true"></i> Exporter
        </button>
      </div>
      <div class="adm-progression" :class="{ 'is-on': adm.secuChargement }" aria-hidden="true"></div>
    </div>

    <ResultatVerificationJournal />

    <section class="adm-card" aria-labelledby="secu-titre">
      <div class="adm-card__head">
        <i class="ph ph-shield-check adm-card__icon" aria-hidden="true"></i>
        <div>
          <h3 id="secu-titre" class="adm-card__title">Journal de sécurité</h3>
          <p class="adm-card__hint sup-hint-large">
            Lignes signées, en ajout seul. Lecture et export réservés aux administrateurs, chaque recherche
            est notée.
          </p>
        </div>
        <div class="adm-card__actions">
          <span
            v-if="adm.secuPartiel"
            class="adm-pill sup-secu-pill-warn"
            title="Le serveur a borné la lecture avant la fin de la période"
            >résultats partiels</span
          >
        </div>
      </div>

      <div class="sup-secu-filtres" role="search" aria-label="Filtres du journal de sécurité">
        <div class="sup-secu-filtres__ligne">
          <select
            class="set-select"
            aria-label="Catégorie"
            :value="adm.secuFiltres.cat"
            @change="adm.secuChoisirCategorie(valeur($event))"
          >
            <option v-for="c in CATEGORIES_JOURNAL" :key="c.prefixe" :value="c.prefixe">
              {{ c.libelle }}
            </option>
          </select>
          <input
            v-model.lazy="adm.secuFiltres.action"
            class="set-input sup-secu-f-action sup-mono"
            list="secu-actions"
            placeholder="Action : auth.login…"
            aria-label="Action (préfixe ou exacte)"
            @change="adm.secuSaisirAction(valeur($event))"
          />
          <datalist id="secu-actions">
            <option v-for="(l, k) in LIBELLES_ACTIONS" :key="k" :value="k">{{ l }}</option>
          </datalist>
          <div class="adm-seg adm-seg--sm" role="group" aria-label="Résultat">
            <button
              v-for="r in [
                { v: '', l: 'Tous' },
                { v: 'success', l: 'Réussite' },
                { v: 'failure', l: 'Échec' },
              ]"
              :key="r.v"
              type="button"
              class="adm-seg__btn"
              :class="{ 'is-active': adm.secuFiltres.resultat === r.v }"
              :aria-pressed="adm.secuFiltres.resultat === r.v ? 'true' : 'false'"
              @click="adm.secuChoisirResultat(r.v)"
            >
              {{ r.l }}
            </button>
          </div>
        </div>
        <div class="sup-secu-filtres__ligne">
          <input
            v-model.lazy="adm.secuFiltres.compte"
            class="set-input sup-secu-f-compte"
            placeholder="Compte"
            aria-label="Compte (nom ou numéro)"
            @change="adm.secuFiltrer()"
          />
          <input
            v-model.lazy="adm.secuFiltres.ip"
            class="set-input sup-secu-f-ip"
            placeholder="Adresse IP"
            aria-label="Adresse IP (début)"
            @change="adm.secuFiltrer()"
          />
          <select
            v-model="adm.secuFiltres.service"
            class="set-select"
            aria-label="Service"
            @change="adm.secuFiltrer()"
          >
            <option value="">Tous les services</option>
            <option v-for="s in SERVICES_JOURNAL" :key="s" :value="s">{{ s }}</option>
          </select>
          <div class="sup-recherche">
            <i class="ph ph-magnifying-glass" aria-hidden="true"></i>
            <input
              v-model.lazy="adm.secuFiltres.texte"
              type="search"
              class="set-input sup-secu-f-texte"
              placeholder="Texte dans la ligne"
              aria-label="Texte dans la ligne"
              @change="adm.secuFiltrer()"
            />
          </div>
          <label
            class="sup-secu-case"
            title="Début, fin et battement horaire de chaque processus : ils prouvent la continuité du journal"
          >
            <input
              type="checkbox"
              :checked="adm.secuMarqueurs"
              @change="adm.secuBasculerMarqueurs(coche($event))"
            />
            Marqueurs d'écriture
          </label>
          <button
            v-if="filtresActifs"
            type="button"
            class="adm-btn adm-btn--quiet adm-btn--sm sup-effacer"
            @click="adm.secuEffacer()"
          >
            <i class="ph ph-x" aria-hidden="true"></i>
            Effacer {{ filtresActifs > 1 ? `les ${filtresActifs} filtres` : "le filtre" }}
          </button>
        </div>
        <p v-if="filtreDeMarqueur && !adm.secuMarqueurs" class="text-xs adm-muted">
          Les marqueurs d'écriture sont affichés : l'action cherchée en est un.
        </p>
      </div>

      <div v-if="adm.secuEchec" class="sup-secu-partiel is-erreur" role="alert">
        <i class="ph ph-warning-circle" aria-hidden="true"></i>
        <span
          >Le journal n'a pas pu être lu (réponse en échec ou recherches déjà en cours).
          <button type="button" class="adm-link" @click="adm.secuReessayer()">Réessayer</button></span
        >
      </div>
      <div v-if="adm.secuPartiel" class="sup-secu-partiel" role="status">
        <i class="ph ph-hourglass-medium" aria-hidden="true"></i>
        <span
          ><b>Résultats partiels.</b> Le serveur a borné la lecture<template v-if="adm.secuArretTs">
            à la ligne du {{ heureLocale(adm.secuArretTs) }}</template
          >, avant la fin de la période. Continuez avec « Plus ancien » ou resserrez la période.</span
        >
      </div>

      <div class="sup-liste custom-scrollbar">
        <table class="adm-table w-full">
          <thead class="adm-thead--sticky">
            <tr>
              <th class="text-left">Quand</th>
              <th class="text-left sup-secu-col-service">Service</th>
              <th class="text-left">Compte</th>
              <th class="text-left sup-secu-col-ip">IP</th>
              <th class="text-left">Action</th>
              <th class="text-left">Résultat</th>
              <th class="text-left">Détails</th>
              <th class="text-right" title="Ligne signée (HMAC)">Sig.</th>
            </tr>
          </thead>
          <tbody>
            <tr v-if="adm.secuLignes.length === 0">
              <td colspan="8" class="text-center adm-empty">
                <template v-if="adm.secuChargement">Chargement…</template>
                <template v-else-if="adm.secuPartiel">
                  Aucune ligne dans la partie lue du journal. Continuez avec « Plus ancien ».
                </template>
                <template v-else>Aucune ligne pour ces filtres sur la période.</template>
              </td>
            </tr>
            <tr
              v-for="l in adm.secuLignes"
              :key="l.ref"
              class="sup-ligne sup-ligne--neutre"
              :class="{ 'is-sel': adm.secuSelection?.ref === l.ref }"
              tabindex="0"
              :title="(LIBELLES_ACTIONS[l.action] || l.action) + ' · ouvrir le détail'"
              @click="adm.ouvrirEvenement(l)"
              @keydown.enter.prevent="adm.ouvrirEvenement(l)"
              @keydown.space.prevent="adm.ouvrirEvenement(l)"
            >
              <td class="sup-quand">
                <time :title="isoUtc(l.ts) || (l.time ?? undefined)">{{ heureLocale(l.ts) || l.time }}</time>
              </td>
              <td class="sup-secu-col-service">
                <span class="sup-etat">{{ l.service ?? "—" }}</span>
              </td>
              <td class="text-xs">
                <template v-if="l.username">{{ l.username }}</template>
                <span v-else class="adm-muted">—</span
                ><span v-if="l.ip" class="sup-secu-ip-sous">{{ l.ip }}</span>
              </td>
              <td class="text-xs tabular-nums sup-secu-col-ip">
                {{ l.ip ?? "" }}<span v-if="!l.ip" class="adm-muted">—</span>
              </td>
              <td>
                <span class="sup-secu-action" :class="classeAction(l.action)">{{ l.action }}</span>
              </td>
              <td>
                <span v-if="l.outcome === 'success'" class="adm-status" data-state="ok" title="Réussite"
                  ><i class="ph ph-check-circle" aria-hidden="true"></i
                  ><span class="sr-only">Réussite</span></span
                >
                <span v-else-if="l.outcome === 'failure'" class="adm-status" data-state="down"
                  ><i class="ph ph-x-circle" aria-hidden="true"></i> Échec</span
                >
                <span v-else class="adm-status" data-state="unknown"
                  ><i class="ph ph-question" aria-hidden="true"></i> Inconnu</span
                >
              </td>
              <td>
                <div class="sup-secu-details">{{ resumeDetails(l) }}</div>
              </td>
              <td class="text-right">
                <template v-if="l.signed">
                  <i class="ph ph-seal-check sup-secu-sig sup-secu-sig--ok" aria-hidden="true"></i
                  ><span class="sr-only">signée</span>
                </template>
                <template v-else>
                  <span title="Ligne non signée"
                    ><i class="ph ph-seal sup-secu-sig sup-secu-sig--non" aria-hidden="true"></i></span
                  ><span class="sr-only">non signée</span>
                </template>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <div class="sup-pied">
        <span>
          <template v-if="adm.secuLignes.length === 0">Aucune ligne</template>
          <template v-else
            >Lignes <b>{{ premiere }}–{{ premiere + adm.secuLignes.length - 1 }}</b></template
          >
          <template v-if="adm.secuLus"> · {{ octets(adm.secuLus) }} lus</template>
          <template v-if="adm.secuIllisibles">
            ·
            <span
              class="sup-secu-avert"
              title="JSON illisible ou ligne de plus de 64 Kio : sautées par la lecture"
              >{{ adm.secuIllisibles }} ligne{{ adm.secuIllisibles > 1 ? "s" : "" }} illisible{{
                adm.secuIllisibles > 1 ? "s" : ""
              }}
              sautée{{ adm.secuIllisibles > 1 ? "s" : "" }}</span
            >
          </template>
        </span>
        <div class="sup-pied__fin">
          <button
            type="button"
            class="adm-btn adm-btn--quiet adm-btn--sm"
            :disabled="adm.secuNumeroPage === 0 || adm.secuChargement"
            @click="adm.secuPlusRecent()"
          >
            <i class="ph ph-caret-left" aria-hidden="true"></i> Plus récent
          </button>
          <button
            type="button"
            class="adm-btn adm-tool adm-btn--sm"
            :disabled="adm.secuSuivant === null || adm.secuChargement"
            @click="adm.secuPlusAncien()"
          >
            Plus ancien <i class="ph ph-caret-right" aria-hidden="true"></i>
          </button>
        </div>
      </div>
    </section>

    <TiroirEvenementJournal />
    <ExportJournalModale />
  </div>
</template>
