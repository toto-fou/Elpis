<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/editor/ModaleGit.vue — modales Git (clonage, initialisation, dépôt distant, identifiants d'envoi, fusion avec résolution des conflits). -->
<script setup lang="ts">
import { domaineEditeur } from "../../features/editor/domaine";

const ed = domaineEditeur();

/** Entrée dans l'identifiant : le focus passe au champ du jeton. */
function champSuivant(e: KeyboardEvent): void {
  const cible = e.target instanceof HTMLElement ? e.target : null;
  cible?.parentElement?.nextElementSibling?.querySelector("input")?.focus();
}
</script>

<template>
  <Transition name="modal">
    <div
      v-if="ed.showGitCloneModal"
      class="fixed inset-0 z-[5000] flex items-center justify-center bg-slate-900/80 backdrop-blur-sm p-4"
      @click.self="ed.showGitCloneModal = false"
      @keydown.esc="ed.showGitCloneModal = false"
    >
      <div
        class="bg-white rounded-2xl shadow-2xl ring-1 ring-slate-200 w-96 max-w-full overflow-hidden"
        role="dialog"
        aria-modal="true"
        aria-label="Cloner un dépôt Git"
        tabindex="-1"
        data-a11y-modal
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
          <div v-if="ed.gitConnectors && ed.gitConnectors.length">
            <label class="text-xs font-medium text-slate-500 block mb-1">Cloner depuis un connecteur</label>
            <select
              v-model="ed.gitCloneConnectorId"
              class="set-select w-full"
              @change="ed.gitLoadConnectorRepos(ed.gitCloneConnectorId)"
            >
              <option value="">— choisir un connecteur —</option>
              <option v-for="c in ed.gitConnectors" :key="c.id" :value="c.id">
                {{ c.host }}<template v-if="c.label"> · {{ c.label }}</template>
              </option>
            </select>
          </div>
          <div v-if="ed.gitCloneConnectorId">
            <div v-if="ed.gitCloneReposLoading" class="text-center py-3 text-slate-400">
              <i class="ph ph-spinner-gap animate-spin" aria-hidden="true"></i>
            </div>
            <div
              v-else-if="ed.gitCloneReposError"
              class="text-[11px] text-amber-600 bg-amber-500/10 rounded-lg px-3 py-2"
            >
              {{ ed.gitCloneReposError }}
            </div>
            <template v-else-if="ed.gitCloneRepos.length">
              <div class="relative mb-2">
                <i
                  class="ph ph-magnifying-glass absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400 text-xs"
                  aria-hidden="true"
                ></i>
                <input
                  v-model="ed.gitCloneRepoFilter"
                  placeholder="Filtrer les dépôts..."
                  aria-label="Filtrer les dépôts"
                  class="w-full bg-slate-50 text-slate-700 text-sm pl-7 pr-3 py-2 rounded-lg outline-none border border-slate-200 focus:border-blue-500 focus:bg-white transition-colors placeholder:text-slate-400"
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
                  @click="ed.gitPickRepo(r)"
                >
                  <i
                    class="ph text-sm mt-0.5 shrink-0"
                    :class="r.private ? 'ph-lock-simple text-amber-500' : 'ph-git-branch text-slate-400'"
                    aria-hidden="true"
                  ></i>
                  <span class="min-w-0 flex-1">
                    <span class="block text-xs text-slate-700 font-mono truncate">{{ r.full_name }}</span>
                    <span v-if="r.description" class="block text-[10px] text-slate-500 truncate">{{
                      r.description
                    }}</span>
                  </span>
                  <i
                    v-if="ed.gitCloneForm.url === r.clone_url"
                    class="ph ph-check text-blue-600 text-sm shrink-0 mt-0.5"
                    aria-hidden="true"
                  ></i>
                </button>
                <div v-if="!ed.gitFilteredCloneRepos.length" class="px-2.5 py-2 text-[11px] text-slate-500">
                  Aucun dépôt ne correspond.
                </div>
              </div>
              <div class="text-[10px] text-slate-400 mt-1">
                ~100 dépôts les plus récents. Sinon, colle l'URL ci-dessous.
              </div>
            </template>
          </div>
          <div>
            <label class="text-xs font-medium text-slate-500 block mb-1">URL du dépôt</label
            ><input
              v-model="ed.gitCloneForm.url"
              placeholder="https://github.com/user/repo.git"
              autofocus
              class="set-input font-mono"
            />
          </div>

          <div class="text-[11px] leading-snug">
            <template v-if="ed.gitConnectors && ed.gitConnectors.length">
              <span class="text-slate-500"><i class="ph ph-key" aria-hidden="true"></i> Connecteurs : </span
              ><span v-for="(c, i) in ed.gitConnectors" :key="c.id"
                ><span v-if="i > 0" class="text-slate-400">, </span
                ><span class="font-mono text-slate-600">{{ c.host }}</span></span
              ><span class="text-slate-500"> — auth auto par host. </span
              ><a
                class="text-blue-600 hover:underline cursor-pointer font-medium"
                @click="
                  ed.showGitCloneModal = false;
                  ed.openSettings();
                  ed.settingsTab = 'connectors';
                  ed.loadGitConnectors();
                "
                >Gérer</a
              >
            </template>
            <template v-else>
              <span class="text-slate-500">Dépôt privé ? </span
              ><a
                class="text-blue-600 hover:underline cursor-pointer font-medium"
                @click="
                  ed.showGitCloneModal = false;
                  ed.openSettings();
                  ed.settingsTab = 'connectors';
                  ed.loadGitConnectors();
                "
                >Ajoutez un connecteur Git</a
              ><span class="text-slate-500"> pour vous authentifier.</span>
            </template>
          </div>
          <div>
            <label class="text-xs font-medium text-slate-500 block mb-1">Sous-dossier (optionnel)</label
            ><input
              v-model="ed.gitCloneForm.dir"
              placeholder="Nom auto-détecté depuis l'URL"
              class="set-input font-mono"
            />
          </div>
          <div
            v-if="ed.gitError"
            class="text-xs text-rose-600 bg-rose-500/10 rounded-lg px-3 py-2 font-mono break-all"
          >
            {{ ed.gitError }}
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
            @click="ed.gitClone"
          >
            <i v-if="ed.gitLoading" class="ph ph-spinner-gap animate-spin" aria-hidden="true"></i
            ><i v-else class="ph ph-download-simple" aria-hidden="true"></i>
            {{ ed.gitLoading ? "Clonage..." : "Cloner" }}
          </button>
        </div>
      </div>
    </div>
  </Transition>
  <Transition name="modal">
    <div
      v-if="ed.showGitInitModal"
      class="fixed inset-0 z-[5000] flex items-center justify-center bg-slate-900/80 backdrop-blur-sm p-4"
      @click.self="ed.showGitInitModal = false"
      @keydown.esc="ed.showGitInitModal = false"
    >
      <div
        class="bg-white rounded-2xl shadow-2xl ring-1 ring-slate-200 w-96 max-w-full overflow-hidden"
        role="dialog"
        aria-modal="true"
        aria-label="Initialiser un dépôt Git"
        tabindex="-1"
        data-a11y-modal
      >
        <div class="px-5 py-4 border-b border-slate-100 flex items-center justify-between">
          <h2 class="text-sm font-semibold text-slate-800 flex items-center gap-2.5">
            <span
              class="w-7 h-7 rounded-lg bg-slate-100 flex items-center justify-center text-orange-500 shrink-0"
              ><i class="ph ph-git-branch text-base" aria-hidden="true"></i
            ></span>
            Initialiser Git
          </h2>
          <button
            aria-label="Fermer"
            class="w-8 h-8 rounded-lg hover:bg-slate-100 text-slate-500 hover:text-slate-700 transition-colors flex items-center justify-center shrink-0"
            @click="ed.showGitInitModal = false"
          >
            <i class="ph ph-x text-lg" aria-hidden="true"></i>
          </button>
        </div>
        <div class="p-4 space-y-3">
          <div>
            <label class="text-xs font-medium text-slate-500 block mb-1">Sous-dossier</label
            ><input
              v-model="ed.gitInitForm.dir"
              placeholder="mon-projet (vide = racine)"
              autofocus
              class="set-input font-mono"
            />
          </div>
          <div>
            <label class="text-xs font-medium text-slate-500 block mb-1">Nom (optionnel)</label
            ><input v-model="ed.gitInitForm.user_name" placeholder="Votre nom" class="set-input" />
          </div>
          <div>
            <label class="text-xs font-medium text-slate-500 block mb-1">Email (optionnel)</label
            ><input
              v-model="ed.gitInitForm.user_email"
              placeholder="vous@example.com"
              class="set-input font-mono"
            />
          </div>
          <button
            :disabled="ed.gitLoading"
            class="w-full py-2.5 text-sm font-semibold rounded-lg transition flex items-center justify-center gap-2"
            :class="
              ed.gitLoading
                ? 'bg-orange-600/70 text-white cursor-wait'
                : 'bg-orange-600 hover:bg-orange-500 text-white'
            "
            @click="ed.gitInit"
          >
            <i v-if="ed.gitLoading" class="ph ph-spinner-gap animate-spin" aria-hidden="true"></i
            ><i v-else class="ph ph-plus" aria-hidden="true"></i> Initialiser
          </button>
        </div>
      </div>
    </div>
  </Transition>
  <Transition name="modal">
    <div
      v-if="ed.showGitRemoteModal"
      class="fixed inset-0 z-[5000] flex items-center justify-center bg-slate-900/80 backdrop-blur-sm p-4"
      @click.self="ed.showGitRemoteModal = false"
      @keydown.esc="ed.showGitRemoteModal = false"
    >
      <div
        class="bg-white rounded-2xl shadow-2xl ring-1 ring-slate-200 w-96 max-w-full overflow-hidden"
        role="dialog"
        aria-modal="true"
        aria-label="Configurer le remote Git"
        tabindex="-1"
        data-a11y-modal
      >
        <div class="px-5 py-4 border-b border-slate-100 flex items-center justify-between">
          <h2 class="text-sm font-semibold text-slate-800 flex items-center gap-2.5">
            <span
              class="w-7 h-7 rounded-lg bg-slate-100 flex items-center justify-center text-blue-500 shrink-0"
              ><i class="ph ph-globe text-base" aria-hidden="true"></i
            ></span>
            Configurer le remote
          </h2>
          <button
            aria-label="Fermer"
            class="w-8 h-8 rounded-lg hover:bg-slate-100 text-slate-500 hover:text-slate-700 transition-colors flex items-center justify-center shrink-0"
            @click="ed.showGitRemoteModal = false"
          >
            <i class="ph ph-x text-lg" aria-hidden="true"></i>
          </button>
        </div>
        <div class="p-4 space-y-3">
          <div>
            <label class="text-xs font-medium text-slate-500 block mb-1">URL origin</label
            ><input
              v-model="ed.gitRemoteForm.url"
              :placeholder="
                ed.gitStatus && ed.gitStatus.remote_url
                  ? ed.gitStatus.remote_url
                  : 'https://github.com/user/repo.git'
              "
              autofocus
              class="set-input font-mono"
            />
          </div>
          <button
            :disabled="!ed.gitRemoteForm.url || ed.gitLoading"
            class="w-full py-2.5 text-sm font-semibold rounded-lg transition flex items-center justify-center gap-2"
            :class="
              ed.gitLoading
                ? 'bg-blue-600/70 text-white cursor-wait'
                : !ed.gitRemoteForm.url
                  ? 'bg-slate-100 text-slate-400 cursor-not-allowed'
                  : 'bg-blue-600 hover:bg-blue-500 text-white'
            "
            @click="ed.gitSetRemote"
          >
            <i v-if="ed.gitLoading" class="ph ph-spinner-gap animate-spin" aria-hidden="true"></i
            ><i v-else class="ph ph-check" aria-hidden="true"></i> Enregistrer
          </button>
        </div>
      </div>
    </div>
  </Transition>
  <Transition name="modal">
    <div
      v-if="ed.showGitPushAuth"
      class="fixed inset-0 z-[5000] flex items-center justify-center bg-slate-900/80 backdrop-blur-sm p-4"
      @click.self="ed.showGitPushAuth = false"
      @keydown.esc="ed.showGitPushAuth = false"
    >
      <div
        class="bg-white rounded-2xl shadow-2xl ring-1 ring-slate-200 w-96 max-w-full overflow-hidden"
        role="dialog"
        aria-modal="true"
        aria-label="Authentification Git"
        tabindex="-1"
        data-a11y-modal
      >
        <div class="px-5 py-4 border-b border-slate-100 flex items-center justify-between">
          <h2 class="text-sm font-semibold text-slate-800 flex items-center gap-2.5">
            <span
              class="w-7 h-7 rounded-lg bg-slate-100 flex items-center justify-center text-amber-500 shrink-0"
              ><i class="ph ph-key text-base" aria-hidden="true"></i
            ></span>
            Authentification Git
          </h2>
          <button
            aria-label="Fermer"
            class="w-8 h-8 rounded-lg hover:bg-slate-100 text-slate-500 hover:text-slate-700 transition-colors flex items-center justify-center shrink-0"
            @click="ed.showGitPushAuth = false"
          >
            <i class="ph ph-x text-lg" aria-hidden="true"></i>
          </button>
        </div>
        <div class="p-4 space-y-3">
          <p class="text-[11px] text-slate-500">Identifiants requis pour push vers le remote HTTPS.</p>
          <div>
            <label class="text-xs font-medium text-slate-500 block mb-1">Utilisateur</label>

            <input
              v-model="ed.gitCredUser"
              placeholder="Nom d'utilisateur GitHub / GitLab"
              autofocus
              class="set-input font-mono"
              @keydown.enter="champSuivant"
            />
          </div>
          <div>
            <label class="text-xs font-medium text-slate-500 block mb-1">Token / Mot de passe</label>
            <div class="relative">
              <input
                v-model="ed.gitCredToken"
                :type="ed.gitCredShowPwd ? 'text' : 'password'"
                placeholder="Token d'accès ou mot de passe"
                class="set-input font-mono"
                style="padding-right: 2.25rem"
                @keydown.enter="ed.gitPushAfterAuth()"
              />
              <button
                type="button"
                :aria-label="ed.gitCredShowPwd ? 'Masquer le token' : 'Afficher le token'"
                class="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 transition"
                @click="ed.gitCredShowPwd = !ed.gitCredShowPwd"
              >
                <i
                  class="ph text-sm"
                  :class="ed.gitCredShowPwd ? 'ph-eye-slash' : 'ph-eye'"
                  aria-hidden="true"
                ></i>
              </button>
            </div>
          </div>
          <button
            :disabled="!ed.gitCredUser || !ed.gitCredToken || ed.gitLoading"
            class="w-full py-2.5 text-sm font-semibold rounded-lg transition flex items-center justify-center gap-2"
            :class="
              ed.gitCredUser && ed.gitCredToken && !ed.gitLoading
                ? 'bg-blue-600 hover:bg-blue-500 text-white'
                : ed.gitLoading
                  ? 'bg-blue-600/70 text-white cursor-wait'
                  : 'bg-slate-100 text-slate-400 cursor-not-allowed'
            "
            @click="ed.gitPushAfterAuth()"
          >
            <i v-if="ed.gitLoading" class="ph ph-spinner-gap animate-spin" aria-hidden="true"></i
            ><i v-else class="ph ph-arrow-up" aria-hidden="true"></i> Push
          </button>
          <p class="text-[10px] text-slate-400 text-center">
            Les identifiants sont conservés pour cette session uniquement.
          </p>
        </div>
      </div>
    </div>
  </Transition>
  <Transition name="modal">
    <div
      v-if="ed.showGitMergeModal"
      class="fixed inset-0 z-[5000] flex items-center justify-center bg-slate-900/80 backdrop-blur-sm p-4"
      @click.self="ed.showGitMergeModal = false"
      @keydown.esc="ed.showGitMergeModal = false"
    >
      <div
        class="bg-white rounded-2xl shadow-2xl ring-1 ring-slate-200 w-[480px] max-w-full max-h-[80vh] flex flex-col overflow-hidden"
        role="dialog"
        aria-modal="true"
        aria-label="Merger une branche Git"
        tabindex="-1"
        data-a11y-modal
      >
        <div class="px-5 py-4 border-b border-slate-100 flex items-center justify-between shrink-0">
          <h2 class="text-sm font-semibold text-slate-800 flex items-center gap-2.5">
            <span
              class="w-7 h-7 rounded-lg bg-slate-100 flex items-center justify-center text-blue-500 shrink-0"
              ><i class="ph ph-git-merge text-base" aria-hidden="true"></i
            ></span>
            Merger une branche
          </h2>
          <button
            aria-label="Fermer"
            class="w-8 h-8 rounded-lg hover:bg-slate-100 text-slate-500 hover:text-slate-700 transition-colors flex items-center justify-center shrink-0"
            @click="ed.showGitMergeModal = false"
          >
            <i class="ph ph-x text-lg" aria-hidden="true"></i>
          </button>
        </div>
        <div class="p-4 space-y-3 overflow-y-auto custom-scrollbar">
          <div>
            <label class="text-xs font-medium text-slate-500 block mb-1.5"
              >Branche à merger dans {{ ed.gitStatus ? ed.gitStatus.branch : "" }}</label
            >

            <select
              v-model="ed.gitMergeBranch"
              autofocus
              class="set-select w-full font-mono"
              @change="ed.gitLoadMergePreview(ed.gitMergeBranch)"
            >
              <option value="" disabled>Sélectionner une branche...</option>
              <option
                v-for="b in ed.gitBranches.local.filter((b) => b !== (ed.gitStatus && ed.gitStatus.branch))"
                :key="b"
                :value="b"
              >
                {{ b }}
              </option>
            </select>
          </div>

          <template v-if="ed.gitMergePreview">
            <div class="flex items-center gap-3 bg-slate-50 border border-slate-200 rounded-lg px-3 py-2">
              <div class="text-center">
                <div class="text-lg font-bold text-slate-800">{{ ed.gitMergePreview.commits.length }}</div>
                <div class="text-xs font-semibold text-slate-500">Commits</div>
              </div>
              <div class="text-center">
                <div class="text-lg font-bold text-slate-800">{{ ed.gitMergePreview.files.length }}</div>
                <div class="text-xs font-semibold text-slate-500">Fichiers</div>
              </div>
              <div class="text-center">
                <div class="text-lg font-bold text-emerald-600">+{{ ed.gitMergePreview.total_add }}</div>
                <div class="text-xs font-semibold text-slate-500">Ajouts</div>
              </div>
              <div class="text-center">
                <div class="text-lg font-bold text-rose-500">-{{ ed.gitMergePreview.total_del }}</div>
                <div class="text-xs font-semibold text-slate-500">Suppr.</div>
              </div>
            </div>

            <div v-if="ed.gitMergePreview.commits.length">
              <div class="text-xs font-medium text-slate-500 mb-1">Commits à intégrer</div>
              <div
                class="bg-slate-50 border border-slate-200 rounded-lg max-h-32 overflow-y-auto custom-scrollbar"
              >
                <div
                  v-for="c in ed.gitMergePreview.commits"
                  :key="c.short"
                  class="flex items-center gap-2 px-2.5 py-1 text-[11px] border-b border-slate-100 last:border-0"
                >
                  <span class="text-blue-600 font-mono shrink-0">{{ c.short }}</span>
                  <span class="text-slate-700 truncate flex-1">{{ c.message }}</span>
                  <span class="text-[9px] text-slate-400 shrink-0">{{ c.author }}</span>
                </div>
              </div>
            </div>

            <div v-if="ed.gitMergePreview.files.length">
              <div class="text-xs font-medium text-slate-500 mb-1">Fichiers modifiés</div>
              <div
                class="bg-slate-50 border border-slate-200 rounded-lg max-h-40 overflow-y-auto custom-scrollbar"
              >
                <div
                  v-for="f in ed.gitMergePreview.files"
                  :key="f.path"
                  class="flex items-center gap-2 px-2.5 py-1 text-[11px] border-b border-slate-100 last:border-0"
                >
                  <span class="text-slate-700 font-mono truncate flex-1">{{ f.path }}</span>
                  <span class="text-emerald-600 text-[10px] font-mono font-bold shrink-0">+{{ f.add }}</span>
                  <span class="text-rose-500 text-[10px] font-mono font-bold shrink-0">-{{ f.del }}</span>
                </div>
              </div>
            </div>
            <div
              v-if="
                !ed.gitMergePreview.commits.length &&
                !ed.gitMergePreview.files.length &&
                !ed.gitMergePreview.conflicts
              "
              class="text-center py-3 text-xs text-slate-500"
            >
              <i class="ph ph-check-circle text-emerald-600" aria-hidden="true"></i> Déjà à jour -- rien à
              merger
            </div>

            <div v-if="ed.gitMergePreview.conflicts && ed.gitMergePreview.conflicts.length" class="space-y-3">
              <div class="bg-rose-500/10 border border-rose-500/20 rounded-lg p-3">
                <div class="text-sm font-semibold text-rose-600 flex items-center gap-2 mb-2">
                  <i class="ph ph-warning-circle" aria-hidden="true"></i>
                  {{ ed.gitMergePreview.conflicts.length }} conflit(s) détecté(s)
                </div>
                <div class="text-[11px] text-rose-500 mb-3">
                  Choisissez une version par fichier, ou pour tous en bas.
                </div>
                <div class="bg-white/60 rounded max-h-32 overflow-y-auto custom-scrollbar">
                  <div
                    v-for="f in ed.gitMergePreview.conflicts"
                    :key="f"
                    class="flex items-center gap-2 px-2.5 py-1 text-[11px] border-b border-rose-500/10 last:border-0"
                  >
                    <i class="ph ph-warning text-rose-500 text-xs" aria-hidden="true"></i>
                    <span class="text-rose-600 font-mono truncate flex-1">{{ f }}</span>

                    <button
                      :disabled="ed.gitLoading"
                      class="shrink-0 text-[10px] px-1.5 py-0.5 rounded bg-slate-100 hover:bg-slate-200 text-slate-600"
                      :title="'Prendre la version de ' + ed.gitMergeBranch"
                      @click="ed.gitResolveFile('theirs', f)"
                    >
                      {{ ed.gitMergeBranch || "Leur" }}
                    </button>
                    <button
                      :disabled="ed.gitLoading"
                      class="shrink-0 text-[10px] px-1.5 py-0.5 rounded bg-slate-100 hover:bg-slate-200 text-slate-600"
                      :title="'Garder la version de ' + (ed.gitStatus ? ed.gitStatus.branch : '')"
                      @click="ed.gitResolveFile('ours', f)"
                    >
                      {{ ed.gitStatus ? ed.gitStatus.branch : "Mienne" }}
                    </button>
                  </div>
                </div>
              </div>
              <div class="grid grid-cols-2 gap-2">
                <button
                  :disabled="ed.gitLoading"
                  class="py-2 text-xs font-semibold bg-blue-600 hover:bg-blue-500 text-white rounded-lg transition flex items-center justify-center gap-1.5"
                  @click="ed.gitMergeResolve('theirs')"
                >
                  <i class="ph ph-arrow-left text-sm" aria-hidden="true"></i> Garder {{ ed.gitMergeBranch }}
                </button>
                <button
                  :disabled="ed.gitLoading"
                  class="py-2 text-xs font-semibold bg-amber-600 hover:bg-amber-500 text-white rounded-lg transition flex items-center justify-center gap-1.5"
                  @click="ed.gitMergeResolve('ours')"
                >
                  <i class="ph ph-shield text-sm" aria-hidden="true"></i> Garder
                  {{ ed.gitStatus ? ed.gitStatus.branch : "" }}
                </button>
              </div>
              <button
                :disabled="ed.gitLoading"
                class="w-full py-2 text-xs font-semibold bg-slate-100 hover:bg-slate-200 text-slate-600 rounded-lg transition flex items-center justify-center gap-1.5"
                @click="ed.gitMergeAbort"
              >
                <i class="ph ph-x text-sm" aria-hidden="true"></i> Annuler le merge
              </button>
            </div>
          </template>
          <div v-else-if="ed.gitLoading && ed.gitMergeBranch" class="text-center py-4">
            <i class="ph ph-spinner-gap animate-spin text-slate-400 text-xl" aria-hidden="true"></i>
          </div>

          <div
            v-if="
              !ed.gitMergePreview || !ed.gitMergePreview.conflicts || !ed.gitMergePreview.conflicts.length
            "
            class="space-y-2"
          >
            <button
              :disabled="
                !ed.gitMergeBranch ||
                ed.gitLoading ||
                !!(
                  ed.gitMergePreview &&
                  !(ed.gitMergePreview.commits && ed.gitMergePreview.commits.length) &&
                  !(ed.gitMergePreview.conflicts && ed.gitMergePreview.conflicts.length)
                )
              "
              class="w-full py-2.5 text-sm font-semibold rounded-lg transition flex items-center justify-center gap-2"
              :class="
                ed.gitMergeBranch
                  ? 'bg-blue-600 hover:bg-blue-700 text-white'
                  : 'bg-slate-100 text-slate-400 cursor-not-allowed'
              "
              @click="ed.gitExecuteMerge('')"
            >
              <i class="ph ph-git-merge" aria-hidden="true"></i> Merger {{ ed.gitMergeBranch }} →
              {{ ed.gitStatus ? ed.gitStatus.branch : "" }}
            </button>
            <div v-if="ed.gitMergeBranch" class="flex gap-2">
              <button
                :disabled="ed.gitLoading"
                class="flex-1 py-1.5 text-[10px] font-semibold bg-slate-100 hover:bg-slate-200 text-slate-600 rounded transition"
                title="En cas de conflit, prendre la version de la branche mergée"
                @click="ed.gitExecuteMerge('theirs')"
              >
                Priorité {{ ed.gitMergeBranch }}
              </button>
              <button
                :disabled="ed.gitLoading"
                class="flex-1 py-1.5 text-[10px] font-semibold bg-slate-100 hover:bg-slate-200 text-slate-600 rounded transition"
                title="En cas de conflit, garder la version actuelle"
                @click="ed.gitExecuteMerge('ours')"
              >
                Priorité {{ ed.gitStatus ? ed.gitStatus.branch : "" }}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  </Transition>
</template>
