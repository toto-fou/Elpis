<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/editor/PanneauGit.vue — vue Git de l'explorateur : dépôt, branche, modifications indexées ou non, commit, arbre, journal, diff d'un commit. -->
<script setup lang="ts">
import ElementArbre from "./ElementArbre.vue";
import { domaineEditeur } from "../../features/editor/domaine";

const ed = domaineEditeur();
</script>

<template>
  <div v-if="ed.explorerTab === 'git'" class="flex-1 flex flex-col min-h-0">
    <div
      v-if="ed.gitRepos.length === 0"
      class="flex-1 flex flex-col items-center justify-center px-4 space-y-3"
    >
      <i class="ph ph-git-branch text-3xl text-slate-600"></i>
      <p class="text-xs text-slate-500">Aucun dépôt Git</p>
      <button
        class="w-full py-1.5 text-xs font-bold bg-white/5 hover:bg-white/10 text-slate-300 rounded-lg transition flex items-center justify-center gap-1.5"
        @click="ed.showGitInitModal = true"
      >
        <i class="ph ph-plus text-xs"></i> Initialiser
      </button>
      <button
        class="w-full py-1.5 text-xs font-bold bg-blue-600 hover:bg-blue-500 text-white rounded-lg transition flex items-center justify-center gap-1.5"
        @click="
          ed.gitOpenCloneModal();
          ed.loadGitConnectors();
        "
      >
        <i class="ph ph-download-simple text-xs"></i> Cloner
      </button>

      <button
        title="Tokens d'accès GitHub / GitLab / Gitea / Bitbucket — appliqués automatiquement au clone/push"
        class="w-full py-1.5 text-[11px] text-slate-400 hover:text-blue-400 transition flex items-center justify-center gap-1.5"
        @click="
          ed.openSettings();
          ed.settingsTab = 'connectors';
          ed.loadGitConnectors();
        "
      >
        <i class="ph ph-key text-xs"></i> Connecteurs Git<span
          v-if="ed.gitConnectors && ed.gitConnectors.length"
          class="text-slate-500"
        >
          · {{ ed.gitConnectors.length }}</span
        >
      </button>
    </div>
    <template v-if="ed.gitRepos.length > 0">
      <div class="px-2 py-1 border-b border-white/5 shrink-0">
        <div class="relative">
          <button
            class="w-full flex items-center gap-1.5 px-2 py-1 rounded hover:bg-white/5 transition text-left"
            @click.stop="ed.showGitRepoMenu = !ed.showGitRepoMenu"
          >
            <i class="ph ph-folder-notch text-blue-400 text-xs shrink-0"></i>
            <span class="text-[11px] text-slate-300 font-mono truncate flex-1">{{
              ed.gitCurrentRepo || "."
            }}</span>
            <i class="ph ph-caret-down text-[8px] text-slate-500 shrink-0"></i>
          </button>
          <template v-if="ed.showGitRepoMenu">
            <div class="fixed inset-0 z-40" @click="ed.showGitRepoMenu = false"></div>
            <div
              class="absolute left-0 right-0 top-full mt-1 bg-[#1e1e1e] border border-white/10 rounded-lg shadow-xl z-50 py-1 max-h-48 overflow-y-auto custom-scrollbar"
            >
              <button
                v-for="rr in ed.gitRepos"
                :key="rr.path"
                class="w-full text-left px-3 py-1.5 text-xs flex items-center gap-2"
                :class="
                  rr.path === ed.gitCurrentRepo
                    ? 'text-blue-400 bg-blue-500/10'
                    : 'text-slate-300 hover:bg-white/5'
                "
                @click="ed.gitSelectRepo(rr.path)"
              >
                <i
                  class="ph ph-folder-notch text-[10px]"
                  :class="rr.path === ed.gitCurrentRepo ? 'text-blue-400' : 'text-slate-500'"
                ></i>
                <span class="font-mono truncate flex-1">{{ rr.name }}</span>
                <span class="text-[9px] text-slate-600 font-mono">{{ rr.branch }}</span>
              </button>
              <div class="h-px bg-white/5 my-1"></div>
              <button
                class="w-full text-left px-3 py-1.5 text-xs text-blue-400 hover:bg-white/5 flex items-center gap-2"
                @click="
                  ed.showGitRepoMenu = false;
                  ed.gitOpenCloneModal();
                  ed.loadGitConnectors();
                "
              >
                <i class="ph ph-download-simple text-xs"></i> Cloner...
              </button>
              <button
                class="w-full text-left px-3 py-1.5 text-xs text-orange-400 hover:bg-white/5 flex items-center gap-2"
                @click="
                  ed.showGitRepoMenu = false;
                  ed.showGitInitModal = true;
                "
              >
                <i class="ph ph-plus text-xs"></i> Initialiser...
              </button>
            </div>
          </template>
        </div>
      </div>

      <template v-if="ed.gitStatus && ed.gitStatus.is_repo">
        <div class="flex items-center gap-0.5 px-2 py-1.5 border-b border-white/5 shrink-0">
          <div class="relative flex-1 min-w-0">
            <button
              class="flex items-center gap-1.5 px-1.5 py-1 rounded hover:bg-white/5 transition text-left max-w-full w-full"
              @click.stop="
                ed.showGitBranchMenu = !ed.showGitBranchMenu;
                if (ed.showGitBranchMenu) ed.gitLoadBranches();
              "
            >
              <i class="ph ph-git-branch text-orange-400 text-sm shrink-0"></i>
              <span class="text-xs text-white font-mono truncate">{{ ed.gitStatus.branch }}</span>
              <span v-if="ed.gitStatus.ahead > 0" class="text-[10px] text-green-400 font-mono shrink-0"
                >↑{{ ed.gitStatus.ahead }}</span
              >
              <span v-if="ed.gitStatus.behind > 0" class="text-[10px] text-yellow-400 font-mono shrink-0"
                >↓{{ ed.gitStatus.behind }}</span
              >
              <i class="ph ph-caret-down text-[8px] text-slate-500 shrink-0 ml-auto"></i>
            </button>
            <template v-if="ed.showGitBranchMenu">
              <div class="fixed inset-0 z-40" @click="ed.showGitBranchMenu = false"></div>
              <div
                class="absolute left-0 top-full mt-1 w-56 bg-[#1e1e1e] border border-white/10 rounded-lg shadow-xl z-50 py-1 max-h-60 overflow-y-auto custom-scrollbar"
              >
                <div class="px-2.5 py-1 text-xs font-semibold text-slate-500">Locales</div>
                <button
                  v-for="b in ed.gitBranches.local"
                  :key="'l:' + b"
                  class="w-full text-left px-3 py-1.5 text-xs flex items-center gap-2"
                  :class="
                    b === ed.gitBranches.current
                      ? 'text-orange-400 bg-orange-500/10'
                      : 'text-slate-300 hover:bg-white/5'
                  "
                  @click="ed.gitCheckout(b)"
                >
                  <i
                    class="ph text-xs"
                    :class="
                      b === ed.gitBranches.current
                        ? 'ph-check-circle text-orange-400'
                        : 'ph-git-branch text-slate-500'
                    "
                  ></i
                  ><span class="truncate font-mono">{{ b }}</span>
                </button>
                <template v-if="ed.gitBranches.remote.length">
                  <div class="h-px bg-white/5 my-1"></div>
                  <div class="px-2.5 py-1 text-xs font-semibold text-slate-500">Distantes</div>
                  <button
                    v-for="b in ed.gitBranches.remote"
                    :key="'r:' + b"
                    class="w-full text-left px-3 py-1.5 text-xs text-slate-400 hover:bg-white/5 flex items-center gap-2"
                    @click="ed.gitCheckout(b.replace('origin/', ''), false)"
                  >
                    <i class="ph ph-cloud text-xs text-slate-600"></i
                    ><span class="truncate font-mono">{{ b }}</span>
                  </button>
                </template>
                <div class="h-px bg-white/5 my-1"></div>
                <button
                  class="w-full text-left px-3 py-1.5 text-xs text-blue-400 hover:bg-white/5 flex items-center gap-2"
                  @click="ed.gitCreateBranch()"
                >
                  <i class="ph ph-plus text-xs"></i> Nouvelle branche
                </button>
              </div>
            </template>
          </div>
          <button
            class="p-1.5 text-slate-400 hover:text-white hover:bg-white/5 rounded transition shrink-0"
            title="Actualiser"
            @click="
              ed.gitRefresh();
              ed.gitLoadTree();
            "
          >
            <i class="ph ph-arrow-clockwise text-sm" :class="ed.gitLoading ? 'animate-spin' : ''"></i>
          </button>
          <button
            class="p-1.5 text-slate-400 hover:text-white hover:bg-white/5 rounded transition shrink-0"
            title="Pull"
            @click="ed.gitPull(false)"
          >
            <i class="ph ph-arrow-down text-sm"></i>
          </button>
          <button
            class="p-1.5 text-slate-400 hover:text-white hover:bg-white/5 rounded transition shrink-0"
            title="Push"
            @click="ed.gitPush(false)"
          >
            <i class="ph ph-arrow-up text-sm"></i>
          </button>
          <div class="relative shrink-0">
            <button
              class="p-1.5 text-slate-400 hover:text-white hover:bg-white/5 rounded transition"
              title="Plus d'actions"
              @click.stop="ed.showGitMoreMenu = !ed.showGitMoreMenu"
            >
              <i class="ph ph-dots-three text-base"></i>
            </button>
            <template v-if="ed.showGitMoreMenu">
              <div class="fixed inset-0 z-40" @click="ed.showGitMoreMenu = false"></div>
              <div
                class="absolute right-0 top-full mt-1 w-48 bg-[#1e1e1e] border border-white/10 rounded-lg shadow-xl z-50 py-1"
              >
                <button
                  class="w-full text-left px-3 py-2 text-xs text-slate-300 hover:bg-white/5 flex items-center gap-2.5"
                  @click="
                    ed.showGitMoreMenu = false;
                    ed.gitFetch();
                  "
                >
                  <i class="ph ph-cloud-arrow-down text-slate-500 text-sm"></i> Fetch
                </button>
                <button
                  class="w-full text-left px-3 py-2 text-xs text-slate-300 hover:bg-white/5 flex items-center gap-2.5"
                  @click="
                    ed.showGitMoreMenu = false;
                    ed.gitPull(true);
                  "
                >
                  <i class="ph ph-arrow-down text-slate-500 text-sm"></i> Pull (rebase)
                </button>
                <button
                  class="w-full text-left px-3 py-2 text-xs text-slate-300 hover:bg-white/5 flex items-center gap-2.5"
                  @click="
                    ed.showGitMoreMenu = false;
                    ed.gitPush(true);
                  "
                >
                  <i class="ph ph-arrow-fat-up text-yellow-500 text-sm"></i> Push (force)
                </button>
                <div class="h-px bg-white/5 my-1"></div>
                <button
                  class="w-full text-left px-3 py-2 text-xs text-slate-300 hover:bg-white/5 flex items-center gap-2.5"
                  @click="ed.gitPromptMerge()"
                >
                  <i class="ph ph-git-merge text-slate-500 text-sm"></i> Merge
                </button>
                <button
                  class="w-full text-left px-3 py-2 text-xs text-slate-300 hover:bg-white/5 flex items-center gap-2.5"
                  @click="ed.gitPromptRebase()"
                >
                  <i class="ph ph-git-pull-request text-slate-500 text-sm"></i> Rebase
                </button>
                <div class="h-px bg-white/5 my-1"></div>
                <button
                  class="w-full text-left px-3 py-2 text-xs text-slate-300 hover:bg-white/5 flex items-center gap-2.5"
                  @click="
                    ed.showGitMoreMenu = false;
                    ed.gitStash('push');
                  "
                >
                  <i class="ph ph-archive text-amber-400 text-sm"></i> Stash
                </button>
                <button
                  class="w-full text-left px-3 py-2 text-xs text-slate-300 hover:bg-white/5 flex items-center gap-2.5"
                  @click="
                    ed.showGitMoreMenu = false;
                    ed.gitStash('pop');
                  "
                >
                  <i class="ph ph-archive text-green-400 text-sm"></i> Stash Pop
                </button>
                <div class="h-px bg-white/5 my-1"></div>
                <button
                  class="w-full text-left px-3 py-2 text-xs text-slate-300 hover:bg-white/5 flex items-center gap-2.5"
                  @click="
                    ed.showGitMoreMenu = false;
                    ed.showGitRemoteModal = true;
                  "
                >
                  <i class="ph ph-globe text-blue-400 text-sm"></i> Remote...
                </button>
                <button
                  class="w-full text-left px-3 py-2 text-xs text-slate-300 hover:bg-white/5 flex items-center gap-2.5"
                  @click="
                    ed.showGitMoreMenu = false;
                    ed.gitSectionOpen.log = !ed.gitSectionOpen.log;
                    if (ed.gitSectionOpen.log && !ed.gitLog.length) ed.gitLoadLog();
                  "
                >
                  <i class="ph ph-clock-counter-clockwise text-blue-400 text-sm"></i> Historique
                </button>
                <button
                  class="w-full text-left px-3 py-2 text-xs text-slate-300 hover:bg-white/5 flex items-center gap-2.5"
                  @click="
                    ed.showGitMoreMenu = false;
                    ed.gitRevertLast();
                  "
                >
                  <i class="ph ph-arrow-counter-clockwise text-red-400 text-sm"></i> Annuler dernier commit
                </button>
              </div>
            </template>
          </div>
        </div>

        <div class="flex-1 overflow-y-auto custom-scrollbar min-h-0">
          <div class="p-2.5 border-b border-white/5">
            <div class="relative">
              <textarea
                v-model="ed.gitCommitMsg"
                placeholder="Message de commit..."
                rows="2"
                class="w-full bg-[#3c3c3c] text-white text-xs rounded-md pl-2.5 pr-8 py-2 outline-none border border-transparent focus:border-orange-500 resize-none font-mono leading-relaxed"
                @keydown.ctrl.enter="ed.gitCommit"
                @keydown.meta.enter="ed.gitCommit"
              ></textarea>
              <button
                :disabled="ed.gitCommitSuggesting || !ed.gitStatus.staged.length"
                title="Proposer un message (IA, d'après les changements indexés)"
                aria-label="Proposer un message de commit"
                class="absolute top-1.5 right-1.5 w-6 h-6 flex items-center justify-center rounded text-slate-400 hover:text-white hover:bg-white/10 disabled:opacity-30"
                @click="ed.gitSuggestCommitMessage()"
              >
                <i
                  class="ph text-sm"
                  :class="ed.gitCommitSuggesting ? 'ph-spinner-gap animate-spin' : 'ph-sparkle'"
                ></i>
              </button>
            </div>
            <div class="flex gap-1.5 mt-1.5">
              <button
                class="px-3 py-1.5 text-[11px] font-bold bg-white/5 hover:bg-white/10 text-slate-300 rounded-md transition shrink-0"
                @click="ed.gitStage([])"
              >
                Tout indexer
              </button>
              <button
                :disabled="!ed.gitCommitMsg.trim() || ed.gitStatus.staged.length === 0"
                class="flex-1 py-1.5 text-[11px] font-bold rounded-md transition flex items-center justify-center gap-1.5"
                :class="
                  ed.gitCommitMsg.trim() && ed.gitStatus.staged.length > 0
                    ? 'bg-orange-600 hover:bg-orange-500 text-white'
                    : 'bg-white/5 text-slate-600 cursor-not-allowed'
                "
                @click="ed.gitCommit"
              >
                <i class="ph ph-check text-xs"></i> Commit ({{ ed.gitStatus.staged.length }})
              </button>
            </div>
          </div>

          <div class="py-1">
            <template v-if="ed.gitStatus.conflicted && ed.gitStatus.conflicted.length">
              <div class="flex items-center gap-1.5 px-2.5 py-1.5">
                <span class="text-xs font-semibold text-rose-400 flex items-center gap-1"
                  ><i class="ph ph-warning-circle text-[11px]"></i> En conflit</span
                >
                <span class="text-[10px] text-slate-500 font-mono">{{ ed.gitStatus.conflicted.length }}</span>
                <button
                  class="ml-auto text-[10px] text-slate-500 hover:text-white px-1 rounded hover:bg-white/5"
                  title="Annuler la fusion"
                  @click="ed.gitMergeAbort()"
                >
                  Annuler
                </button>
              </div>
              <div
                v-for="f in ed.gitStatus.conflicted"
                :key="'c:' + f.path"
                class="group flex items-center gap-2 pl-3 pr-2 py-1 hover:bg-white/5 cursor-pointer border-l-2 border-rose-500 transition-colors"
                :title="f.path"
                @click="ed.gitOpenRepoFile(f.path)"
              >
                <i class="ph ph-file text-[12px] text-rose-400 shrink-0"></i>
                <span class="text-[12px] text-slate-200 truncate flex-1">{{ f.path.split("/").pop() }}</span>
                <button
                  class="text-[10px] px-1 rounded text-slate-400 hover:text-white hover:bg-white/10"
                  title="Garder la version de la branche courante"
                  @click.stop="ed.gitResolveFile('ours', f.path)"
                >
                  Mienne
                </button>
                <button
                  class="text-[10px] px-1 rounded text-slate-400 hover:text-white hover:bg-white/10"
                  title="Prendre la version de la branche fusionnée"
                  @click.stop="ed.gitResolveFile('theirs', f.path)"
                >
                  Leur
                </button>
              </div>
            </template>

            <template v-if="ed.gitStatus.staged.length">
              <div class="flex items-center gap-1.5 px-2.5 py-1.5">
                <span class="text-xs font-semibold text-green-400 flex items-center gap-1"
                  ><i class="ph ph-check-circle text-[11px]"></i> Indexés</span
                >
                <span class="text-[10px] text-slate-500 font-mono">{{ ed.gitStatus.staged.length }}</span>
                <button
                  class="ml-auto text-slate-500 hover:text-white p-0.5 rounded hover:bg-white/5 transition"
                  title="Tout désindexer"
                  @click="ed.gitUnstage([])"
                >
                  <i class="ph ph-minus text-[11px]"></i>
                </button>
              </div>
              <div
                v-for="f in ed.gitStatus.staged"
                :key="'s:' + f.path"
                class="group flex items-center gap-2 pl-3 pr-2 py-1 hover:bg-white/5 cursor-pointer border-l-2 border-green-500 transition-colors"
                :title="f.path + ' — voir le diff'"
                @click="ed.gitOpenChange(f.path, f.status === 'A' ? 'U' : (f.status ?? ''))"
              >
                <i class="ph ph-file text-[12px] text-green-400 shrink-0"></i>
                <span class="text-[12px] text-slate-200 truncate flex-1">{{ f.path.split("/").pop() }}</span>
                <span v-if="f.add || f.del" class="text-[9px] font-mono shrink-0 flex gap-1"
                  ><span class="text-green-400">+{{ f.add }}</span
                  ><span class="text-red-400">-{{ f.del }}</span></span
                >
                <button
                  class="opacity-0 group-hover:opacity-100 focus-visible:opacity-100 text-slate-500 hover:text-white shrink-0 transition"
                  title="Désindexer"
                  @click.stop="ed.gitUnstage([f.path])"
                >
                  <i class="ph ph-minus text-[11px]"></i>
                </button>
              </div>
            </template>

            <template v-if="ed.gitStatus.modified.length">
              <div
                class="flex items-center gap-1.5 px-2.5 py-1.5"
                :class="ed.gitStatus.staged.length ? 'mt-1' : ''"
              >
                <span class="text-xs font-semibold text-yellow-400 flex items-center gap-1"
                  ><i class="ph ph-pencil-simple text-[11px]"></i> Modifiés</span
                >
                <span class="text-[10px] text-slate-500 font-mono">{{ ed.gitStatus.modified.length }}</span>
                <div class="ml-auto flex gap-0.5">
                  <button
                    class="text-slate-500 hover:text-green-400 p-0.5 rounded hover:bg-white/5 transition"
                    title="Tout indexer"
                    @click="ed.gitStage(ed.gitStatus.modified.map((f) => f.path))"
                  >
                    <i class="ph ph-plus text-[11px]"></i>
                  </button>
                  <button
                    class="text-slate-500 hover:text-red-400 p-0.5 rounded hover:bg-white/5 transition"
                    title="Tout annuler"
                    @click="ed.gitDiscard(ed.gitStatus.modified.map((f) => f.path))"
                  >
                    <i class="ph ph-arrow-counter-clockwise text-[11px]"></i>
                  </button>
                </div>
              </div>
              <div
                v-for="f in ed.gitStatus.modified"
                :key="'m:' + f.path"
                class="group flex items-center gap-2 pl-3 pr-2 py-1 hover:bg-white/5 cursor-pointer border-l-2 border-yellow-500 transition-colors"
                :title="f.path + ' — voir le diff'"
                @click="ed.gitOpenChange(f.path, f.status ?? '')"
              >
                <i class="ph ph-file text-[12px] text-yellow-400 shrink-0"></i>
                <span class="text-[12px] text-slate-200 truncate flex-1">{{ f.path.split("/").pop() }}</span>
                <span v-if="f.add || f.del" class="text-[9px] font-mono shrink-0 flex gap-1"
                  ><span class="text-green-400">+{{ f.add }}</span
                  ><span class="text-red-400">-{{ f.del }}</span></span
                >
                <div
                  class="flex opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 shrink-0 transition gap-0.5"
                >
                  <button
                    class="text-slate-500 hover:text-green-400"
                    title="Indexer"
                    @click.stop="ed.gitStage([f.path])"
                  >
                    <i class="ph ph-plus text-[11px]"></i>
                  </button>
                  <button
                    class="text-slate-500 hover:text-red-400"
                    title="Annuler"
                    @click.stop="ed.gitDiscard([f.path])"
                  >
                    <i class="ph ph-arrow-counter-clockwise text-[11px]"></i>
                  </button>
                </div>
              </div>
            </template>

            <template v-if="ed.gitStatus.untracked.length">
              <div
                class="flex items-center gap-1.5 px-2.5 py-1.5"
                :class="ed.gitStatus.staged.length || ed.gitStatus.modified.length ? 'mt-1' : ''"
              >
                <span class="text-xs font-semibold text-slate-400 flex items-center gap-1"
                  ><i class="ph ph-question text-[11px]"></i> Non suivis</span
                >
                <span class="text-[10px] text-slate-500 font-mono">{{ ed.gitStatus.untracked.length }}</span>
                <button
                  class="ml-auto text-slate-500 hover:text-green-400 p-0.5 rounded hover:bg-white/5 transition"
                  title="Tout indexer"
                  @click="ed.gitStage(ed.gitStatus.untracked.map((f) => f.path))"
                >
                  <i class="ph ph-plus text-[11px]"></i>
                </button>
              </div>
              <div
                v-for="f in ed.gitStatus.untracked"
                :key="'u:' + f.path"
                class="group flex items-center gap-2 pl-3 pr-2 py-1 hover:bg-white/5 cursor-pointer border-l-2 border-slate-600 transition-colors"
                :title="f.path"
                @click="ed.gitOpenRepoFile(f.path)"
              >
                <i class="ph ph-file text-[12px] text-slate-500 shrink-0"></i>
                <span class="text-[12px] text-slate-400 truncate flex-1">{{ f.path.split("/").pop() }}</span>
                <button
                  class="opacity-0 group-hover:opacity-100 focus-visible:opacity-100 text-slate-500 hover:text-green-400 shrink-0 transition"
                  title="Indexer"
                  @click.stop="ed.gitStage([f.path])"
                >
                  <i class="ph ph-plus text-[11px]"></i>
                </button>
              </div>
            </template>

            <div
              v-if="
                ed.gitStatus.staged.length === 0 &&
                ed.gitStatus.modified.length === 0 &&
                ed.gitStatus.untracked.length === 0 &&
                !(ed.gitStatus.conflicted && ed.gitStatus.conflicted.length)
              "
              class="px-3 py-4 text-center text-[11px] text-slate-600 flex flex-col items-center gap-1.5"
            >
              <i class="ph ph-check-circle text-2xl text-green-500/40"></i>
              Aucune modification
            </div>
          </div>

          <div v-if="ed.gitDiffData" class="border-t border-white/5 bg-blue-500/5">
            <div class="flex items-center justify-between px-2.5 py-1.5">
              <span
                class="text-[10px] font-mono text-blue-400 font-bold truncate flex-1"
                :title="ed.gitDiffData.message ?? undefined"
                >{{ ed.gitDiffData.hash.substring(0, 8) }} — {{ ed.gitDiffData.message }}</span
              >
              <div class="flex gap-1 shrink-0">
                <button
                  class="text-[10px] text-amber-400 hover:text-amber-300 px-1.5 py-0.5 rounded bg-amber-500/10 hover:bg-amber-500/20 transition font-bold"
                  title="Restaurer"
                  @click="ed.gitRestoreCommit(ed.gitDiffData.hash)"
                >
                  <i class="ph ph-clock-counter-clockwise"></i>
                </button>
                <button class="text-slate-500 hover:text-white" @click="ed.gitDiffData = null">
                  <i class="ph ph-x text-xs"></i>
                </button>
              </div>
            </div>
            <div>
              <div
                v-for="cf in ed.gitDiffData.files"
                :key="cf.path"
                class="flex items-center gap-1.5 px-3 py-1 hover:bg-blue-500/10 cursor-pointer group text-[11px] transition"
                @click="ed.gitShowFileDiff(ed.gitDiffData.hash, cf.path)"
              >
                <span
                  class="w-3 text-center text-[9px] font-bold shrink-0"
                  :class="
                    cf.status === 'A'
                      ? 'text-green-400'
                      : cf.status === 'D'
                        ? 'text-red-400'
                        : 'text-yellow-400'
                  "
                  >{{ cf.status }}</span
                >
                <span class="text-blue-300/80 font-mono truncate flex-1 group-hover:text-white">{{
                  cf.path
                }}</span>
                <i
                  class="ph ph-arrows-left-right text-[9px] text-slate-600 group-hover:text-blue-400 shrink-0"
                ></i>
              </div>
            </div>
          </div>

          <div class="border-t border-white/5">
            <button
              class="w-full flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-semibold text-slate-400 hover:text-white transition"
              @click="
                ed.gitSectionOpen.tree = !ed.gitSectionOpen.tree;
                if (ed.gitSectionOpen.tree && !ed.gitTree.length) ed.gitLoadTree();
              "
            >
              <i
                class="ph text-[9px]"
                :class="ed.gitSectionOpen.tree ? 'ph-caret-down' : 'ph-caret-right'"
              ></i>
              <i class="ph ph-tree-structure text-[11px]"></i> Arborescence du dépôt
            </button>
            <div v-show="ed.gitSectionOpen.tree" class="pb-1">
              <div
                v-if="!ed.gitTree.length && !ed.gitLoading"
                class="px-3 py-2 text-center text-[10px] text-slate-600"
              >
                <button class="text-blue-400 hover:text-blue-300" @click="ed.gitLoadTree()">
                  <i class="ph ph-arrow-clockwise"></i> Charger
                </button>
              </div>
              <div v-else-if="ed.gitLoading && !ed.gitTree.length" class="px-3 py-2 text-center">
                <i class="ph ph-spinner-gap animate-spin text-slate-500"></i>
              </div>
              <ul v-else role="tree" aria-label="Arborescence Git" class="space-y-0.5 px-1">
                <ElementArbre
                  v-for="item in ed.gitTree"
                  :key="item.path"
                  :item="item"
                  @open-file="ed.openFile"
                  @context-menu="
                    (e) => ed.openContextMenu(e.event, e.item.type === 'folder' ? 'folder' : 'file', e.item)
                  "
                  @download="ed.downloadFile"
                  @delete="ed.deleteFile"
                  @rename="ed.renameItem"
                  @move-item="(e) => ed.moveItem(e.oldPath, e.newParent)"
                ></ElementArbre>
              </ul>
            </div>
          </div>

          <div v-if="ed.gitSectionOpen.log" class="border-t border-white/5">
            <div class="flex items-center justify-between px-2.5 py-1.5">
              <span class="text-xs font-semibold text-slate-400 flex items-center gap-1"
                ><i class="ph ph-clock-counter-clockwise text-[11px]"></i> Historique</span
              >
              <div class="flex gap-1">
                <button
                  class="text-slate-600 hover:text-white p-0.5 rounded hover:bg-white/5 transition"
                  title="Actualiser"
                  @click="ed.gitLoadLog()"
                >
                  <i class="ph ph-arrow-clockwise text-[10px]"></i>
                </button>
                <button
                  class="text-slate-600 hover:text-white p-0.5 rounded hover:bg-white/5 transition"
                  title="Fermer"
                  @click="ed.gitSectionOpen.log = false"
                >
                  <i class="ph ph-x text-xs"></i>
                </button>
              </div>
            </div>
            <div>
              <div
                v-for="c in ed.gitLog"
                :key="c.hash"
                class="flex items-center gap-1.5 px-2.5 py-1 hover:bg-white/5 cursor-pointer group text-[11px] transition"
                :class="ed.gitDiffData && ed.gitDiffData.hash === c.hash ? 'bg-blue-500/10' : ''"
                @click="ed.gitViewCommitDiff(c.hash)"
              >
                <span
                  class="font-mono shrink-0"
                  :class="
                    ed.gitDiffData && ed.gitDiffData.hash === c.hash
                      ? 'text-blue-400'
                      : 'text-blue-400/70 group-hover:text-blue-400'
                  "
                  >{{ c.short }}</span
                >
                <span
                  class="truncate flex-1"
                  :class="
                    ed.gitDiffData && ed.gitDiffData.hash === c.hash
                      ? 'text-white'
                      : 'text-slate-400 group-hover:text-slate-200'
                  "
                  >{{ c.message }}</span
                >
              </div>
              <div v-if="!ed.gitLog.length" class="px-3 py-2 text-[10px] text-slate-600 text-center">
                Aucun commit
              </div>
            </div>
          </div>

          <div class="border-t border-white/5">
            <button
              class="w-full flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-semibold text-slate-400 hover:text-white transition"
              @click="ed.gitSectionOpen.creds = !ed.gitSectionOpen.creds"
            >
              <i
                class="ph text-[9px]"
                :class="ed.gitSectionOpen.creds ? 'ph-caret-down' : 'ph-caret-right'"
              ></i>
              <i class="ph ph-key text-[11px]"></i> Authentification
              <i
                v-if="ed.gitCredUser && ed.gitCredToken"
                class="ph ph-check-circle text-green-400 text-[11px] ml-auto"
              ></i>
            </button>
            <div v-show="ed.gitSectionOpen.creds" class="px-2.5 pb-2 space-y-1.5">
              <input
                v-model="ed.gitCredUser"
                placeholder="Utilisateur"
                class="w-full bg-[#3c3c3c] text-white text-xs px-2.5 py-1.5 rounded outline-none border border-transparent focus:border-blue-500 font-mono"
              />
              <input
                v-model="ed.gitCredToken"
                type="password"
                placeholder="Token / mot de passe"
                class="w-full bg-[#3c3c3c] text-white text-xs px-2.5 py-1.5 rounded outline-none border border-transparent focus:border-blue-500 font-mono"
              />
            </div>
          </div>

          <div v-if="ed.gitStatus.remote_url" class="px-2.5 py-1.5 border-t border-white/5">
            <div
              class="text-[10px] text-slate-600 font-mono truncate flex items-center gap-1"
              :title="ed.gitStatus.remote_url"
            >
              <i class="ph ph-globe text-[11px] shrink-0"></i> {{ ed.gitStatus.remote_url }}
            </div>
          </div>
        </div>
      </template>
      <div v-else-if="ed.gitLoading" class="flex-1 flex items-center justify-center">
        <i class="ph ph-spinner-gap animate-spin text-slate-500"></i>
      </div>
    </template>
  </div>
</template>
