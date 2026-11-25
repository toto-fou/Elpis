<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/admin/PanneauReseauProfil.vue — console › Sandbox › Réseau : ce que voient les sandboxes d'un profil en cours d'édition (graphe, tableau, règles posées) et ses comptes. -->
<script setup lang="ts">
import { computed } from "vue";

import { domaineAdmin } from "../../features/admin/domaine";
import type { ProfilReseauEdite } from "../../features/admin/etat";
import { pluriel } from "../../features/admin/formats";
import {
  destinationsVues,
  ICONES_VERDICT,
  LIBELLES_VERDICT,
  reglesPosees,
  sourceVue,
  texteRegles,
  VERDICTS,
} from "../../features/admin/reseau-vue";
import type { Verdict } from "../../features/admin/reseau-vue";
import { VUES_RESEAU } from "../../features/admin/sandbox";
import type { VueReseau } from "../../features/admin/sandbox";

const props = defineProps<{ profil: ProfilReseauEdite }>();
const adm = domaineAdmin();

const ONGLETS: readonly { cle: VueReseau; icone: string; libelle: string }[] = [
  { cle: "graphe", icone: "ph-graph", libelle: "Graphe" },
  { cle: "tableau", icone: "ph-table", libelle: "Tableau" },
  { cle: "regles", icone: "ph-code", libelle: "Règles posées" },
];
const LEGENDES: Readonly<Record<Verdict, string>> = {
  ok: "autorisé",
  partiel: "partiel (une partie passe)",
  inactif: "inactif (domaine sans adresse)",
  refus: "refusé",
  relais: "par un relais de l'hôte",
};
const ORIGINES: Readonly<Record<string, string>> = {
  forced: "imposé",
  chosen: "choisi",
  default: "par défaut",
};
/** Comptes montrés au plus ; les autres sont comptés. */
const COMPTES_MONTRES = 24;
/** Hauteur d'une carte du graphe et écart entre deux, en rem : la grille (variables CSS) et les flèches en dépendent. */
const LIGNE_REM = 2.125;
const ECART_REM = 0.5;
/** Largeur des flèches en unités du dessin (16 par rem). */
const LARGEUR = 76;
const PAS = (LIGNE_REM + ECART_REM) * 16;
const STYLE_GRILLE = { "--np-ligne": `${LIGNE_REM}rem`, "--np-ecart": `${ECART_REM}rem` };

const onglet = computed<VueReseau>(() =>
  (VUES_RESEAU as readonly string[]).includes(props.profil._onglet)
    ? (props.profil._onglet as VueReseau)
    : "graphe",
);
const id = computed(() => "np-vue-" + props.profil._uid);
const etat = computed(() => adm.contexteReseau.etat);
const lignes = computed(() => destinationsVues(props.profil, adm.contexteReseau));
const regles = computed(() => reglesPosees(props.profil, adm.contexteReseau));
const texte = computed(() => (regles.value.genre === "regles" ? texteRegles(regles.value) : ""));
const source = computed(() => sourceVue(props.profil, adm.contexteReseau));
const comptes = computed(() => (adm.comptesReseau === null ? null : adm.comptesDuProfil(props.profil)));
const hauteur = computed(() => lignes.value.length * PAS - ECART_REM * 16);
const sansComptes = computed(() => (etat.value === "attente" ? "Chargement…" : "Comptes indisponibles"));

const adresse = (nom: string): boolean => /^[0-9./]+$/.test(nom);

/** Flèche de la sandbox (milieu de sa boîte) vers la carte de la ligne `i`. */
function arc(i: number): string {
  const y0 = hauteur.value / 2;
  const y = i * PAS + (LIGNE_REM * 16) / 2;
  return `M0,${y0} C${LARGEUR * 0.55},${y0} ${LARGEUR * 0.45},${y} ${LARGEUR - 2},${y}`;
}

function auClavier(ev: KeyboardEvent): void {
  const pas = ev.key === "ArrowRight" ? 1 : ev.key === "ArrowLeft" ? -1 : 0;
  if (!pas && ev.key !== "Home" && ev.key !== "End") return;
  ev.preventDefault();
  const n = ONGLETS.length;
  const i = ONGLETS.findIndex((o) => o.cle === onglet.value);
  const cible = ev.key === "Home" ? 0 : ev.key === "End" ? n - 1 : (i + pas + n) % n;
  const o = ONGLETS[cible];
  if (!o) return;
  adm.choisirVueReseau(props.profil, o.cle);
  (ev.currentTarget as HTMLElement).querySelectorAll<HTMLElement>("[role=tab]")[cible]?.focus();
}
</script>

<template>
  <div class="np-panneau min-w-0">
    <div class="np-panneau__tete">
      <span class="np-panneau__titre"
        ><i class="ph ph-eye" aria-hidden="true"></i>Ce que voient les sandboxes</span
      >
      <div class="np-seg np-seg--xs ml-auto" role="tablist" aria-label="Vue du profil" @keydown="auClavier">
        <button
          v-for="o in ONGLETS"
          :id="id + '-onglet-' + o.cle"
          :key="o.cle"
          type="button"
          role="tab"
          :class="['np-seg__btn', onglet === o.cle ? 'is-on' : '']"
          :aria-selected="onglet === o.cle ? 'true' : 'false'"
          :aria-controls="id + '-panneau'"
          :tabindex="onglet === o.cle ? 0 : -1"
          @click="adm.choisirVueReseau(profil, o.cle)"
        >
          <i :class="['ph', o.icone]" aria-hidden="true"></i> {{ o.libelle }}
        </button>
      </div>
    </div>

    <p v-if="adm.hotesDistants" class="np-aide np-aide--info">
      <i class="ph ph-info shrink-0" aria-hidden="true"></i>Relevé de la machine de la console ; une sandbox
      placée sur un autre hôte d'outils reçoit les adresses de cet hôte.
    </p>

    <div
      :id="id + '-panneau'"
      :key="onglet"
      role="tabpanel"
      :aria-labelledby="id + '-onglet-' + onglet"
      class="np-fondu"
      :data-vue="onglet"
    >
      <template v-if="onglet === 'graphe'">
        <div class="np-graphe">
          <div class="np-graphe__grille">
            <div class="np-graphe__source">
              <span class="np-graphe__titre"
                ><i class="ph ph-cube" aria-hidden="true"></i>Sandbox du profil</span
              >
              <span>{{
                comptes !== null
                  ? pluriel(comptes.length, "compte")
                  : etat === "attente"
                    ? "comptes : …"
                    : "comptes indisponibles"
              }}</span>
              <span>{{ source.sudo }}</span>
              <span>{{ source.reseau }}</span>
            </div>
            <svg
              class="np-graphe__fleches"
              :viewBox="'0 0 ' + LARGEUR + ' ' + hauteur"
              :style="{ height: hauteur / 16 + 'rem' }"
              aria-hidden="true"
            >
              <defs>
                <marker
                  v-for="v in VERDICTS"
                  :id="id + '-fleche-' + v"
                  :key="v"
                  viewBox="0 0 8 8"
                  refX="7"
                  refY="4"
                  markerWidth="7"
                  markerHeight="7"
                  orient="auto"
                >
                  <path d="M0,0 L8,4 L0,8 z" :class="'np-fl--' + v" />
                </marker>
              </defs>
              <path
                v-for="(l, i) in lignes"
                :key="l.cle"
                :class="['np-arc', 'np-arc--' + l.verdict]"
                :d="arc(i)"
                :marker-end="'url(#' + id + '-fleche-' + l.verdict + ')'"
              />
            </svg>
            <ul class="np-graphe__dest" :style="STYLE_GRILLE">
              <li
                v-for="l in lignes"
                :key="l.cle"
                :class="['np-dest', 'np-dest--' + l.verdict]"
                :title="l.nom + ' — ' + LIBELLES_VERDICT[l.verdict] + ' : ' + l.detail"
              >
                <span class="np-dest__nom"
                  ><i :class="['ph', l.icone]" aria-hidden="true"></i
                  ><span :class="['np-dest__texte', adresse(l.nom) ? 'np-mono' : '']">{{ l.nom }}</span
                  ><i v-if="l.risque" class="ph ph-warning-circle np-risque" aria-hidden="true"></i
                  ><span class="sr-only">{{ ", " + LIBELLES_VERDICT[l.verdict].toLowerCase() }}</span
                  ><span v-if="l.risque" class="sr-only">, ouvert, à protéger</span></span
                >
                <span class="np-dest__detail">{{ l.detail }}</span>
              </li>
            </ul>
          </div>
        </div>
        <div class="np-legende">
          <span v-for="v in VERDICTS" :key="v"
            ><svg viewBox="0 0 26 8" aria-hidden="true">
              <path :class="['np-arc', 'np-arc--' + v]" d="M1,4 L25,4" /></svg
            >{{ LEGENDES[v] }}</span
          >
          <span><i class="ph ph-warning-circle np-risque" aria-hidden="true"></i>ouvert, à protéger</span>
        </div>
      </template>

      <div v-else-if="onglet === 'tableau'" class="overflow-x-auto">
        <table class="np-table">
          <thead>
            <tr>
              <th scope="col">Destination</th>
              <th scope="col">Ports</th>
              <th scope="col">Verdict</th>
              <th scope="col">Détail</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="l in lignes" :key="l.cle">
              <td :class="{ 'np-mono': adresse(l.nom) }">
                {{ l.nom
                }}<i
                  v-if="l.risque"
                  class="ph ph-warning-circle np-risque"
                  title="Ouvert, à protéger"
                  aria-hidden="true"
                ></i
                ><span v-if="l.risque" class="sr-only"> (ouvert, à protéger)</span>
              </td>
              <td class="np-mono">{{ l.ports || "—" }}</td>
              <td>
                <span :class="['np-verdict', 'np-verdict--' + l.verdict]"
                  ><i :class="['ph', ICONES_VERDICT[l.verdict]]" aria-hidden="true"></i
                  >{{ LIBELLES_VERDICT[l.verdict] }}</span
                >
              </td>
              <td class="np-table__d">{{ l.detail }}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <template v-else>
        <p v-if="regles.genre === 'sans-reseau'" class="np-vide">
          <i class="ph ph-prohibit" aria-hidden="true"></i>Le conteneur démarre sans interface réseau
          (--network none) : aucune règle à poser.
        </p>
        <p v-else-if="regles.genre === 'sans-filtre'" class="np-vide">
          <i class="ph ph-warning" aria-hidden="true"></i>Aucune règle dans le conteneur : le réseau du profil
          sort sans filtre. Cochez une protection pour en poser.
        </p>
        <p v-else-if="regles.genre === 'machine-inconnue'" class="np-vide">
          <i class="ph ph-warning" aria-hidden="true"></i
          >{{
            etat === "attente"
              ? "Adresses de la machine en cours de lecture…"
              : adm.contexteReseau.machine === null
                ? "Relevé de la machine indisponible : les règles de la protection « Machine hôte » ne peuvent pas être montrées."
                : "Aucune adresse IPv4 de la machine relevée : une sandbox de ce profil ne démarrerait pas."
          }}
        </p>
        <template v-else>
          <div class="np-regles__tete">
            <span class="np-aide"
              >Posées par le script de démarrage, en une fois, avant la commande du compte.</span
            >
            <button type="button" class="adm-btn adm-btn--sm ml-auto" @click="adm.copierReglesReseau(profil)">
              <i class="ph ph-copy" aria-hidden="true"></i> Copier
            </button>
          </div>
          <p v-if="regles.inconnus.length" class="np-aide np-aide--warn">
            <i class="ph ph-warning shrink-0" aria-hidden="true"></i
            >{{
              etat === "charge"
                ? "Adresses relevées à l'enregistrement du profil, absentes ci-dessous : " +
                  regles.inconnus.join(", ")
                : etat === "attente"
                  ? "Résolution des domaines en cours : leurs adresses manquent ci-dessous."
                  : "Résolution des domaines indisponible : leurs adresses manquent ci-dessous."
            }}
          </p>
          <pre class="np-regles">{{ texte }}</pre>
        </template>
      </template>
    </div>

    <div class="np-comptes">
      <span class="np-sec__t"
        ><i class="ph ph-users" aria-hidden="true"></i
        >{{ comptes === null ? "Comptes" : pluriel(comptes.length, "compte") }}</span
      >
      <span v-if="comptes === null" class="np-chips__empty">{{ sansComptes }}</span>
      <template v-else>
        <span v-for="c in comptes.slice(0, COMPTES_MONTRES)" :key="c.user_id" class="np-compte"
          >{{ c.username }} <small>{{ ORIGINES[c.origin] }}</small></span
        >
        <span v-if="comptes.length > COMPTES_MONTRES" class="np-chips__empty"
          >et {{ pluriel(comptes.length - COMPTES_MONTRES, "autre") }}</span
        >
        <span v-if="!comptes.length" class="np-chips__empty">Aucun compte</span>
      </template>
      <button type="button" class="adm-link np-comptes__lien" @click="adm.goAdminPage('accounts')">
        Imposer un profil : Utilisateurs ›
      </button>
    </div>
  </div>
</template>
