<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/editor/ModaleClonage.vue — fenêtre « Cloner un dépôt » : dépôts d'un compte git, adresse, compte qui servira ou identifiants saisis sur place, dossier. -->
<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";

import {
  accesClone,
  comptePropose,
  comptesUtilisables,
  dossierDuClone,
  nomCompte,
  porteesIdentifiants,
} from "../../features/editor/clonage";
import { domaineEditeur } from "../../features/editor/domaine";

const ed = domaineEditeur();
const champIdentifiant = ref<HTMLInputElement | null>(null);
const champJeton = ref<HTMLInputElement | null>(null);
const comptes = computed(() => comptesUtilisables(ed.gitConnectors));
const acces = computed(() => accesClone(ed.gitCloneForm.url, ed.gitConnectors));
const portees = computed(() => porteesIdentifiants(acces.value, ed.gitConnectors));
const dossier = computed(() => dossierDuClone(ed.gitCloneForm.url));
/** Schéma et hôte de l'adresse : ce vers quoi des identifiants saisis partiraient. */
const origine = computed(() => ("origine" in acces.value ? acces.value.origine : ""));
const connu = computed(() => acces.value.etat !== "vide" && acces.value.etat !== "invalide");
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

// Des identifiants saisis pour un hôte ne partent jamais vers un autre, ni en clair s'ils l'ont été pour https : changer d'hôte ou de schéma les efface, fermer aussi.
watch(origine, oublierIdentifiants);
watch(
  () => ed.showGitCloneModal,
  (ouverte) => {
    if (!ouverte) oublierIdentifiants();
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
  if (await ed.gitClone(portee.value ?? undefined)) void ed.loadGitConnectors();
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
  <Transition name="modal">
    <div
      v-if="ed.showGitCloneModal"
      class="fixed inset-0 z-[5000] flex items-center justify-center bg-slate-900/80 backdrop-blur-sm p-4"
      @click.self="ed.showGitCloneModal = false"
      @keydown.esc="ed.showGitCloneModal = false"
    >
      <div
        class="bg-white rounded-2xl shadow-2xl ring-1 ring-slate-200 w-full max-w-lg overflow-hidden"
        role="dialog"
        aria-modal="true"
        aria-label="Cloner un dépôt Git"
        tabindex="-1"
        data-a11y-modal
        data-modale-clonage
      >
        <div class="px-5 py-4 border-b border-slate-100 flex items-center justify-between">
          <h2 class="text-sm font-semibold text-slate-800 flex items-center gap-2.5">
            <span
              class="w-7 h-7 rounded-lg bg-slate-100 flex items-center justify-center text-blue-500 shrink-0"
              ><i class="ph ph-download-simple text-base" aria-hidden="true"></i
            ></span>
            Cloner un dépôt
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
          <div v-if="comptes.length" data-mes-depots>
            <div class="flex items-center justify-between gap-2 mb-1">
              <component
                :is="comptes.length > 1 ? 'label' : 'span'"
                :for="comptes.length > 1 ? 'clone-compte' : undefined"
                class="text-xs font-medium text-slate-500 shrink-0"
                >Mes dépôts</component
              >
              <select
                v-if="comptes.length > 1"
                id="clone-compte"
                v-model="ed.gitCloneConnectorId"
                class="set-select min-w-0 font-mono"
                title="Compte Git dont les dépôts sont listés"
                @change="ed.gitLoadConnectorRepos(ed.gitCloneConnectorId)"
              >
                <option v-for="c in comptes" :key="c.id" :value="String(c.id)">{{ nomCompte(c) }}</option>
              </select>
              <span v-else class="text-xs font-mono text-slate-600 truncate" data-compte-seul>{{
                comptes[0] ? nomCompte(comptes[0]) : ""
              }}</span>
            </div>
            <div v-if="ed.gitCloneReposLoading" class="text-center py-3 text-slate-400" role="status">
              <i class="ph ph-spinner-gap animate-spin" aria-hidden="true"></i>
              <span class="sr-only">Chargement des dépôts</span>
            </div>
            <div
              v-else-if="ed.gitCloneReposError"
              class="text-xs text-amber-600 bg-amber-500/10 rounded-lg px-3 py-2"
              role="status"
            >
              {{ ed.gitCloneReposError }}
            </div>
            <template v-else-if="ed.gitCloneRepos.length">
              <div class="relative mb-1.5">
                <i
                  class="ph ph-magnifying-glass absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400 text-xs"
                  aria-hidden="true"
                ></i>
                <input
                  v-model="ed.gitCloneRepoFilter"
                  placeholder="Filtrer"
                  aria-label="Filtrer les dépôts"
                  class="w-full bg-slate-50 text-slate-700 text-sm pl-7 pr-3 py-1.5 rounded-lg outline-none border border-slate-200 focus:border-blue-500 focus:bg-white transition-colors placeholder:text-slate-400"
                />
              </div>
              <div
                class="bg-slate-50 rounded-lg max-h-48 overflow-y-auto custom-scrollbar border border-slate-200"
              >
                <button
                  v-for="r in ed.gitFilteredCloneRepos"
                  :key="r.full_name"
                  type="button"
                  class="w-full text-left px-2.5 py-1.5 border-b border-slate-100 last:border-0 hover:bg-slate-100 transition flex items-start gap-2"
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
                <div v-if="!ed.gitFilteredCloneRepos.length" class="px-2.5 py-2 text-xs text-slate-500">
                  Aucun dépôt ne correspond : collez son adresse.
                </div>
              </div>
            </template>
          </div>

          <div>
            <label for="clone-url" class="text-xs font-medium text-slate-500 block mb-1">Adresse</label>
            <input
              id="clone-url"
              v-model="ed.gitCloneForm.url"
              placeholder="https://github.com/organisation/depot.git"
              autofocus
              aria-describedby="clone-acces"
              class="set-input font-mono"
              @keydown.enter="cloner"
            />
            <p
              id="clone-acces"
              class="text-xs text-slate-500 mt-1 leading-snug"
              aria-live="polite"
              data-acces
              :data-etat="acces.etat"
            >
              <template v-if="saisis && 'hote' in acces">
                <i class="ph ph-key" aria-hidden="true"></i> Identifiants saisis pour
                <span class="font-mono text-slate-700">{{ acces.hote }}</span>
              </template>
              <template v-else-if="acces.etat === 'compte'">
                <i class="ph ph-key" aria-hidden="true"></i> Compte
                <span class="font-mono text-slate-700">{{ nomCompte(acces.compte) }}</span>
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
                    identifiants
                  </button>
                </template>
              </template>
              <template v-else-if="acces.etat === 'aucun'">
                Aucun compte ne s'applique à cette adresse<template v-if="!ed.gitCloneCreds.ouvert">
                  : dépôt public, ou
                  <button
                    type="button"
                    class="text-blue-600 hover:underline font-medium"
                    data-saisir
                    @click="ed.gitCloneCreds.ouvert = true"
                  >
                    identifiants
                  </button>
                </template>
              </template>
              <span v-else-if="acces.etat === 'invalide'" class="text-amber-600"
                >Adresse http(s) attendue</span
              >
              <span
                v-if="connu && 'clair' in acces && acces.clair && (saisis || acces.etat === 'compte')"
                class="text-amber-600"
                data-clair
              >
                · http : envoi en clair</span
              >
            </p>
          </div>

          <div v-if="ed.gitCloneCreds.ouvert && portees.choix.length" class="space-y-1.5" data-identifiants>
            <div class="grid grid-cols-2 gap-2.5">
              <div>
                <label for="clone-identifiant" class="text-xs font-medium text-slate-500">Identifiant</label>
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

          <div>
            <label for="clone-dossier" class="text-xs font-medium text-slate-500 block mb-1">Dossier</label>
            <input
              id="clone-dossier"
              v-model="ed.gitCloneForm.dir"
              :placeholder="dossier || 'nom du dépôt'"
              title="Créé dans votre espace de travail ; vide : le nom du dépôt"
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
            <p v-if="ed.gitCloneCreds.refus" class="font-medium">
              Accès refusé : saisissez des identifiants.
            </p>
            <p class="font-mono break-all">{{ ed.gitError }}</p>
          </div>

          <button
            :disabled="!ed.gitCloneForm.url || ed.gitLoading"
            class="w-full py-2.5 text-sm font-semibold rounded-lg transition flex items-center justify-center gap-2"
            :class="
              ed.gitLoading
                ? 'bg-blue-600/70 text-white cursor-wait'
                : !ed.gitCloneForm.url
                  ? 'bg-slate-100 text-slate-400 cursor-not-allowed'
                  : 'bg-blue-600 hover:bg-blue-500 text-white'
            "
            data-cloner
            @click="cloner"
          >
            <i v-if="ed.gitLoading" class="ph ph-spinner-gap animate-spin" aria-hidden="true"></i
            ><i v-else class="ph ph-download-simple" aria-hidden="true"></i>
            {{ ed.gitLoading ? "Clonage…" : "Cloner" }}
          </button>

          <button
            type="button"
            class="w-full text-xs text-slate-500 hover:text-blue-600 transition flex items-center justify-center gap-1.5"
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
