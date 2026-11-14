<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/editor/ModaleClonage.vue — fenêtre « Ajouter un dépôt » : dépôt cloné depuis la liste d'un compte git ou depuis son URL (dépôt lu, compte qui servira ou identifiants saisis sur place, dossier), ou dépôt neuf initialisé dans un dossier (ses commits sont attribués d'office). -->
<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";

import {
  accesClone,
  comptePropose,
  comptesListables,
  dossierDuClone,
  exempleAdresse,
  lectureAdresse,
  nomCompte,
  porteesIdentifiants,
} from "../../features/editor/clonage";
import { domaineEditeur } from "../../features/editor/domaine";

type Source = "depots" | "url" | "nouveau";
const LIBELLES: Record<Source, string> = {
  depots: "Mes dépôts",
  url: "Depuis une URL",
  nouveau: "Nouveau dépôt",
};

const ed = domaineEditeur();
const onglets = ref<HTMLElement | null>(null);
const champFiltre = ref<HTMLInputElement | null>(null);
const champAdresse = ref<HTMLInputElement | null>(null);
const champNouveau = ref<HTMLInputElement | null>(null);
const champIdentifiant = ref<HTMLInputElement | null>(null);
const champJeton = ref<HTMLInputElement | null>(null);
/** Comptes dont les dépôts peuvent être listés. */
const comptes = computed(() => comptesListables(ed.gitConnectors));
const choisie = ref<Source | null>(null);
/** Fenêtre entrée : la liste des dépôts ne se dessine pas pendant l'animation d'ouverture. */
const entree = ref(ed.showGitCloneModal);
/** Façons d'ajouter un dépôt : la liste d'un compte s'il y en a un, une URL, un dépôt neuf. */
const sources = computed<Source[]>(() =>
  comptes.value.length ? ["depots", "url", "nouveau"] : ["url", "nouveau"],
);
/** Façon affichée : celle choisie, sinon la première offerte. */
const source = computed<Source>(() => {
  const s = choisie.value ?? sources.value[0] ?? "url";
  return sources.value.includes(s) ? s : "url";
});
const lecture = computed(() => lectureAdresse(ed.gitCloneForm.url));
/** URL que le serveur n'accepterait pas : dite, avec la raison sous le champ. */
const refusee = computed(() => ["ssh", "identifiants", "invalide"].includes(lecture.value.etat));
const exemple = computed(() => exempleAdresse(ed.gitConnectors));
const acces = computed(() => accesClone(ed.gitCloneForm.url, ed.gitConnectors));
const portees = computed(() => porteesIdentifiants(acces.value, ed.gitConnectors));
const dossier = computed(() => dossierDuClone(ed.gitCloneForm.url));
/** Schéma et hôte de l'adresse : ce vers quoi des identifiants saisis partiraient. */
const origine = computed(() => ("origine" in acces.value ? acces.value.origine : ""));
/** Plusieurs comptes sur le serveur du dépôt : la fenêtre dit pourquoi celui-ci est pris. */
const plusieurs = computed(() => {
  const a = acces.value;
  return (
    "hote" in a && (ed.gitConnectors ?? []).filter((c) => c.path !== null && c.host === a.hote).length > 1
  );
});
/** Des identifiants saisis serviront à la place d'un compte. */
const saisis = computed(() => ed.gitCloneCreds.ouvert && ed.gitCloneCreds.token.trim() !== "");
/** Portée où les identifiants seront enregistrés ; `null` : nulle part, ils ne servent qu'à ce clone. */
const portee = computed({
  get: () => (portees.value.defaut === null ? null : (ed.gitCloneCreds.portee ?? portees.value.defaut)),
  set: (v: string | null) => {
    ed.gitCloneCreds.portee = v;
  },
});

function oublierIdentifiants(): void {
  Object.assign(ed.gitCloneCreds, { ouvert: false, user: "", token: "", portee: null, refus: false });
}

/** Le focus va au champ de la façon affichée. */
function viser(): void {
  const champs = { depots: champFiltre, url: champAdresse, nouveau: champNouveau };
  void nextTick(() => champs[source.value].value?.focus());
}

/** Changement de façon : l'erreur d'un clonage ne suit pas sous le dépôt neuf, ni l'inverse. */
function prendre(s: Source): void {
  if ((s === "nouveau") !== (source.value === "nouveau")) {
    ed.gitError = "";
    ed.gitCloneCreds.refus = false;
  }
  choisie.value = s;
}

function choisirSource(s: Source): void {
  prendre(s);
  viser();
}

/** Flèches sur les onglets : la façon voisine, le focus reste sur l'onglet. */
function sourceVoisine(pas: number): void {
  const l = sources.value;
  prendre(l[(l.indexOf(source.value) + pas + l.length) % l.length] ?? "url");
  void nextTick(() => onglets.value?.querySelector<HTMLElement>('[aria-selected="true"]')?.focus());
}

// Des identifiants saisis pour un hôte ne partent jamais vers un autre, ni en clair s'ils l'ont été pour https : changer d'hôte ou de schéma les efface, fermer aussi.
watch(origine, oublierIdentifiants);
watch(
  () => ed.showGitCloneModal,
  (ouverte, avant) => {
    if (ouverte) {
      choisie.value = null;
      return viser();
    }
    entree.value = false;
    if (avant) oublierIdentifiants();
  },
  { immediate: true },
);

// Comptes arrivés après l'ouverture : leur liste prend la place, sauf si une URL est déjà en cours de saisie.
watch(
  () => comptes.value.length > 0,
  (arrives) => {
    if (!arrives || !ed.showGitCloneModal || choisie.value !== null) return;
    if (ed.gitCloneForm.url.trim()) choisie.value = "url";
    else viser();
  },
);

// Une portée choisie ne vaut que pour le dépôt où elle l'a été.
watch(
  () => portees.value.choix.map((c) => c.valeur).join("\n"),
  () => {
    ed.gitCloneCreds.portee = null;
  },
);

// Accès refusé : la saisie s'ouvre, le focus y va.
watch(
  () => ed.gitCloneCreds.refus,
  (refus) => {
    if (refus) void nextTick(() => champIdentifiant.value?.focus());
  },
);

// À l'ouverture, ou quand les comptes arrivent : les dépôts du compte proposé sont listés.
watch(
  [() => ed.showGitCloneModal, comptes],
  ([ouverte]) => {
    if (!ouverte || ed.gitCloneConnectorId) return;
    const c = comptePropose(comptes.value);
    if (c === null) return;
    ed.gitCloneConnectorId = String(c.id);
    void ed.gitLoadConnectorRepos(String(c.id));
  },
  { immediate: true },
);

async function cloner(): Promise<void> {
  if (lecture.value.etat !== "lue") return;
  if (await ed.gitClone(portee.value ?? undefined)) void ed.loadGitConnectors();
}

/** Opération lancée par le bouton du bas : son libellé la suit, pas l'onglet affiché. */
const initialisation = ref(false);
const neuf = computed(() => (ed.gitLoading ? initialisation.value : source.value === "nouveau"));

/** Bouton du bas : initialise le dépôt neuf, ou clone le dépôt lu. */
function valider(): void {
  if (ed.gitLoading) return;
  initialisation.value = source.value === "nouveau";
  if (initialisation.value) void ed.gitInit();
  else void cloner();
}

function ouvrirComptes(): void {
  ed.showGitCloneModal = false;
  void ed.openSettingsTab("secrets:git");
}

/** Entrée dans l'identifiant : le focus passe au jeton. */
function versJeton(): void {
  champJeton.value?.focus();
}
</script>

<template>
  <!-- eslint-disable vue/multiline-html-element-content-newline -->
  <Transition name="modal" @after-enter="entree = true">
    <div
      v-if="ed.showGitCloneModal"
      class="elpis-clone-fond fixed inset-0 z-[5000] flex justify-center bg-slate-900/80"
      @click.self="ed.showGitCloneModal = false"
      @keydown.esc="ed.showGitCloneModal = false"
    >
      <div
        class="bg-white rounded-2xl shadow-2xl ring-1 ring-slate-200 w-full max-w-lg overflow-hidden"
        role="dialog"
        aria-modal="true"
        aria-label="Ajouter un dépôt Git"
        tabindex="-1"
        data-a11y-modal
        data-modale-clonage
      >
        <div class="px-5 py-4 border-b border-slate-100 flex items-center justify-between">
          <h2 class="text-sm font-semibold text-slate-800 flex items-center gap-2.5">
            <span
              class="w-7 h-7 rounded-lg bg-slate-100 flex items-center justify-center text-blue-500 shrink-0"
              ><i class="ph ph-git-branch text-base" aria-hidden="true"></i
            ></span>
            Ajouter un dépôt
          </h2>
          <button
            aria-label="Fermer"
            class="w-8 h-8 rounded-lg hover:bg-slate-100 text-slate-500 hover:text-slate-700 transition-colors flex items-center justify-center shrink-0"
            @click="ed.showGitCloneModal = false"
          >
            <i class="ph ph-x text-lg" aria-hidden="true"></i>
          </button>
        </div>
        <div class="p-4 space-y-3">
          <div
            ref="onglets"
            class="adm-seg adm-seg--sm"
            role="tablist"
            aria-label="Façon d'ajouter le dépôt"
            @keydown.left.prevent="sourceVoisine(-1)"
            @keydown.right.prevent="sourceVoisine(1)"
          >
            <button
              v-for="s in sources"
              :id="'clone-onglet-' + s"
              :key="s"
              type="button"
              role="tab"
              :aria-selected="source === s ? 'true' : 'false'"
              :aria-controls="'clone-volet-' + s"
              :tabindex="source === s ? 0 : -1"
              class="adm-seg__btn"
              :class="source === s ? 'is-active' : ''"
              :data-source="s"
              @click="choisirSource(s)"
            >
              {{ LIBELLES[s] }}
            </button>
          </div>

          <div
            v-if="source === 'depots'"
            id="clone-volet-depots"
            role="tabpanel"
            aria-labelledby="clone-onglet-depots"
            data-mes-depots
          >
            <div class="elpis-clone-compte flex items-center gap-2 mb-1.5 text-xs">
              <component
                :is="comptes.length > 1 ? 'label' : 'span'"
                :for="comptes.length > 1 ? 'clone-compte' : undefined"
                class="font-medium text-slate-500 shrink-0"
                >Compte</component
              >
              <select
                v-if="comptes.length > 1"
                id="clone-compte"
                v-model="ed.gitCloneConnectorId"
                class="set-select flex-1 min-w-0 font-mono"
                title="Compte Git dont les dépôts sont listés"
                @change="ed.gitLoadConnectorRepos(ed.gitCloneConnectorId)"
              >
                <option v-for="c in comptes" :key="c.id" :value="String(c.id)">{{ nomCompte(c) }}</option>
              </select>
              <span v-else class="font-mono text-slate-700 truncate" data-compte-seul>{{
                comptes[0] ? nomCompte(comptes[0]) : ""
              }}</span>
            </div>
            <div class="relative mb-1.5">
              <i
                class="ph ph-magnifying-glass absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400 text-xs"
                aria-hidden="true"
              ></i>
              <input
                ref="champFiltre"
                v-model="ed.gitCloneRepoFilter"
                placeholder="Filtrer mes dépôts"
                aria-label="Filtrer mes dépôts"
                autocomplete="off"
                class="w-full bg-slate-50 text-slate-700 text-sm pl-7 pr-3 py-1.5 rounded-lg outline-none border border-slate-200 focus:border-blue-500 focus:bg-white transition-colors placeholder:text-slate-400"
              />
            </div>
            <div
              class="elpis-clone-liste bg-slate-50 rounded-lg overflow-y-auto custom-scrollbar border border-slate-200"
              data-liste-depots
            >
              <div
                v-if="ed.gitCloneReposLoading || !entree"
                class="h-full flex items-center justify-center text-slate-400"
                role="status"
              >
                <i class="ph ph-spinner-gap animate-spin" aria-hidden="true"></i>
                <span class="sr-only">Chargement des dépôts</span>
              </div>
              <div
                v-else-if="ed.gitCloneReposError || !ed.gitFilteredCloneRepos.length"
                class="h-full flex flex-col items-center justify-center gap-1 px-4 text-center text-xs"
                role="status"
                data-liste-vide
              >
                <span :class="ed.gitCloneReposError ? 'text-amber-600' : 'text-slate-500'">{{
                  ed.gitCloneReposError || (ed.gitCloneRepos.length ? "Aucun dépôt ne correspond" : "")
                }}</span>
                <button
                  v-if="ed.gitCloneReposError || ed.gitCloneRepos.length"
                  type="button"
                  class="text-blue-600 hover:underline font-medium"
                  data-vers-url
                  @click="choisirSource('url')"
                >
                  Coller son URL
                </button>
              </div>
              <template v-else>
                <button
                  v-for="r in ed.gitFilteredCloneRepos"
                  :key="r.full_name"
                  type="button"
                  class="w-full text-left px-2.5 py-1.5 border-b border-slate-100 last:border-0 hover:bg-slate-100 transition-colors flex items-start gap-2"
                  :class="ed.gitCloneForm.url === r.clone_url ? 'bg-blue-500/10' : ''"
                  :aria-pressed="ed.gitCloneForm.url === r.clone_url ? 'true' : 'false'"
                  data-depot
                  @click="ed.gitPickRepo(r)"
                >
                  <i
                    class="ph text-sm mt-0.5 shrink-0"
                    :class="r.private ? 'ph-lock-simple text-amber-500' : 'ph-git-branch text-slate-400'"
                    :title="r.private ? 'Privé' : undefined"
                    aria-hidden="true"
                  ></i>
                  <span class="min-w-0 flex-1">
                    <span class="block text-xs text-slate-700 font-mono truncate">{{ r.full_name }}</span>
                    <span v-if="r.description" class="block text-xs text-slate-500 truncate">{{
                      r.description
                    }}</span>
                  </span>
                  <i
                    v-if="ed.gitCloneForm.url === r.clone_url"
                    class="ph ph-check text-blue-600 text-sm shrink-0 mt-0.5"
                    aria-hidden="true"
                  ></i>
                </button>
              </template>
            </div>
          </div>

          <div
            v-else-if="source === 'url'"
            id="clone-volet-url"
            role="tabpanel"
            aria-labelledby="clone-onglet-url"
            data-par-url
          >
            <label for="clone-url" class="text-xs font-medium text-slate-500 block mb-1">URL du dépôt</label>
            <input
              id="clone-url"
              ref="champAdresse"
              v-model="ed.gitCloneForm.url"
              :placeholder="exemple"
              autocomplete="off"
              spellcheck="false"
              aria-describedby="clone-aide clone-acces"
              class="set-input font-mono"
              @keydown.enter="cloner"
            />
            <p
              id="clone-aide"
              class="text-xs mt-1 leading-snug"
              :class="refusee ? 'text-amber-600' : 'text-slate-500'"
              aria-live="polite"
              data-aide
            >
              <template v-if="lecture.etat === 'ssh'"
                >URL SSH non prise en charge : collez l'URL HTTPS du dépôt.</template
              >
              <template v-else-if="lecture.etat === 'identifiants'"
                >Identifiants dans l'URL refusés : retirez-les, ils se saisissent plus bas.</template
              >
              <template v-else-if="lecture.etat === 'invalide'"
                >URL non reconnue. Exemple : <span class="font-mono">{{ exemple }}</span></template
              >
              <template v-else>URL de clonage en http(s), telle que l'affiche votre serveur Git.</template>
            </p>
          </div>

          <div
            v-else
            id="clone-volet-nouveau"
            class="elpis-clone-recap text-xs"
            role="tabpanel"
            aria-labelledby="clone-onglet-nouveau"
            data-nouveau
          >
            <label for="init-dossier" class="font-medium text-slate-500">Dossier</label>
            <div class="min-w-0">
              <input
                id="init-dossier"
                ref="champNouveau"
                v-model="ed.gitInitForm.dir"
                placeholder="mon-projet"
                autocomplete="off"
                aria-describedby="init-aide"
                class="set-input font-mono"
                @keydown.enter="valider"
              />
              <p id="init-aide" class="text-slate-500 mt-1 leading-snug">
                Dépôt vide créé dans ce dossier de votre espace de travail ; sans nom : à sa racine.
              </p>
            </div>
            <span class="font-medium text-slate-500">Auteur</span>
            <p class="min-w-0 text-slate-500 leading-snug" data-attribution>
              Automatique : vos commits à votre compte, ceux de l'assistant à « votre compte (Elpis agent) ».
            </p>
          </div>

          <div
            v-if="source !== 'nouveau'"
            class="elpis-clone-recap border-t border-slate-100 pt-3 text-xs"
            data-recap
          >
            <span class="font-medium text-slate-500">Dépôt</span>
            <p class="min-w-0 text-slate-500" data-depot-lu :data-etat="lecture.etat">
              <template v-if="lecture.etat === 'lue'">
                <span class="font-mono font-medium text-slate-800">{{ lecture.depot }}</span> sur
                <span class="font-mono text-slate-700">{{ lecture.hote }}</span>
              </template>
              <span v-else-if="refusee" class="text-amber-600">URL non acceptée</span>
              <template v-else-if="lecture.etat === 'incomplete'">URL incomplète</template>
              <template v-else>{{
                source === "depots" ? "Choisissez un dépôt dans la liste" : "Collez son URL"
              }}</template>
            </p>

            <span class="font-medium text-slate-500">Accès</span>
            <p
              id="clone-acces"
              class="min-w-0 text-slate-500 leading-snug"
              aria-live="polite"
              data-acces
              :data-etat="acces.etat"
            >
              <template v-if="lecture.etat !== 'lue' || !('hote' in acces)">—</template>
              <template v-else-if="saisis && 'hote' in acces">
                <i class="ph ph-key" aria-hidden="true"></i> Identifiants saisis pour
                <span class="font-mono text-slate-700">{{ acces.hote }}</span>
              </template>
              <template v-else-if="acces.etat === 'compte'">
                <i class="ph ph-key" aria-hidden="true"></i> Compte
                <span class="font-mono text-slate-700">{{ nomCompte(acces.compte) }}</span>
                <span v-if="plusieurs" data-plus-precis> (le plus précis pour cette URL)</span>
                <template v-if="!ed.gitCloneCreds.ouvert">
                  ·
                  <button
                    type="button"
                    class="text-blue-600 hover:underline font-medium"
                    data-saisir
                    @click="ed.gitCloneCreds.ouvert = true"
                  >
                    autres identifiants
                  </button>
                </template>
              </template>
              <template v-else-if="acces.etat === 'sans-jeton' || acces.etat === 'a-verifier'">
                <span class="text-amber-600"
                  >Compte <span class="font-mono">{{ nomCompte(acces.compte) }}</span>
                  {{ acces.etat === "a-verifier" ? "à vérifier" : "sans jeton" }}</span
                >
                <template v-if="acces.etat === 'a-verifier'">
                  ·
                  <button
                    type="button"
                    class="text-blue-600 hover:underline font-medium"
                    data-verifier
                    @click="ouvrirComptes"
                  >
                    Comptes Git
                  </button>
                </template>
                <template v-if="!ed.gitCloneCreds.ouvert">
                  ·
                  <button
                    type="button"
                    class="text-blue-600 hover:underline font-medium"
                    data-saisir
                    @click="ed.gitCloneCreds.ouvert = true"
                  >
                    saisir des identifiants
                  </button>
                </template>
              </template>
              <template v-else>
                Aucun compte<template v-if="!ed.gitCloneCreds.ouvert && portees.choix.length">
                  : dépôt public, ou
                  <button
                    type="button"
                    class="text-blue-600 hover:underline font-medium"
                    data-saisir
                    @click="ed.gitCloneCreds.ouvert = true"
                  >
                    saisir des identifiants
                  </button>
                </template>
              </template>
              <span
                v-if="
                  lecture.etat === 'lue' &&
                  'clair' in acces &&
                  acces.clair &&
                  (saisis || acces.etat === 'compte')
                "
                class="text-amber-600"
                data-clair
              >
                · http : envoi en clair</span
              >
            </p>

            <div v-if="ed.gitCloneCreds.ouvert && portees.choix.length" class="space-y-1.5" data-identifiants>
              <div class="grid grid-cols-2 gap-2.5">
                <div>
                  <label for="clone-identifiant" class="text-xs font-medium text-slate-500"
                    >Identifiant</label
                  >
                  <input
                    id="clone-identifiant"
                    ref="champIdentifiant"
                    v-model="ed.gitCloneCreds.user"
                    autocomplete="off"
                    class="set-input mt-0.5"
                    @keydown.enter="versJeton"
                  />
                </div>
                <div>
                  <label for="clone-jeton" class="text-xs font-medium text-slate-500">Jeton</label>
                  <input
                    id="clone-jeton"
                    ref="champJeton"
                    v-model="ed.gitCloneCreds.token"
                    type="password"
                    autocomplete="off"
                    placeholder="jeton ou mot de passe"
                    class="set-input mt-0.5"
                    @keydown.enter="cloner"
                  />
                </div>
              </div>
              <div v-if="portee !== null" class="flex items-center gap-2">
                <label
                  for="clone-portee"
                  class="text-xs font-medium text-slate-500 shrink-0"
                  title="Compte Git créé ou mis à jour avec ces identifiants, si le dépôt les demande et que le clone réussit"
                  >Enregistrer pour</label
                >
                <select id="clone-portee" v-model="portee" class="set-select flex-1 min-w-0 font-mono">
                  <option v-for="p in portees.choix" :key="p.valeur" :value="p.valeur" :disabled="p.fermee">
                    {{ p.libelle
                    }}{{ p.fermee ? " — compte à vérifier" : p.remplace ? " — met à jour ce compte" : "" }}
                  </option>
                </select>
              </div>
              <p v-else class="text-xs text-slate-500" data-non-enregistres>
                Non enregistrés : ils ne servent qu'à ce clone.
              </p>
            </div>

            <label
              for="clone-dossier"
              class="font-medium text-slate-500"
              title="Créé dans votre espace de travail ; vide : le nom du dépôt"
              >Dossier</label
            >
            <input
              id="clone-dossier"
              v-model="ed.gitCloneForm.dir"
              :placeholder="dossier || 'nom du dépôt'"
              title="Créé dans votre espace de travail ; vide : le nom du dépôt"
              autocomplete="off"
              class="set-input font-mono"
              @keydown.enter="cloner"
            />
          </div>

          <div
            v-if="ed.gitError"
            class="text-xs text-rose-600 bg-rose-500/10 rounded-lg px-3 py-2"
            role="alert"
            data-erreur
          >
            <p v-if="ed.gitCloneCreds.refus && portees.choix.length" class="font-medium">
              Accès refusé : saisissez des identifiants.
            </p>
            <p class="font-mono break-all">{{ ed.gitError }}</p>
          </div>

          <button
            :disabled="ed.gitLoading || (source !== 'nouveau' && lecture.etat !== 'lue')"
            class="w-full py-2.5 text-sm font-semibold rounded-lg transition-colors flex items-center justify-center gap-2"
            :class="
              ed.gitLoading
                ? 'bg-blue-600/70 text-white cursor-wait'
                : source !== 'nouveau' && lecture.etat !== 'lue'
                  ? 'bg-slate-100 text-slate-400 cursor-not-allowed'
                  : 'bg-blue-600 hover:bg-blue-500 text-white'
            "
            data-cloner
            @click="valider"
          >
            <i v-if="ed.gitLoading" class="ph ph-spinner-gap animate-spin" aria-hidden="true"></i
            ><i v-else class="ph" :class="neuf ? 'ph-plus' : 'ph-download-simple'" aria-hidden="true"></i>
            {{
              neuf
                ? ed.gitLoading
                  ? "Initialisation…"
                  : "Initialiser"
                : ed.gitLoading
                  ? "Clonage…"
                  : "Cloner"
            }}
          </button>

          <button
            type="button"
            class="w-full text-xs text-slate-500 hover:text-blue-600 transition-colors flex items-center justify-center gap-1.5"
            data-comptes
            @click="ouvrirComptes"
          >
            <i class="ph ph-key" aria-hidden="true"></i> Comptes Git
          </button>
        </div>
      </div>
    </div>
  </Transition>
</template>
