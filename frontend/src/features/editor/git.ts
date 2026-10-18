// SPDX-License-Identifier: MIT
/** frontend/src/features/editor/git.ts — Git du bac personnel pour l'éditeur : dépôts, statut, index, commit, push/pull, branches, fusion, journal, diff et restauration (porté de `editor/_git.js`). */
import { computed, ref } from "vue";
import type { Ref } from "vue";
import type { z } from "zod";

import { remplacerContenu } from "./ecriture-modele";
import type { ModeleEditable } from "./ecriture-modele";
import type { Onglet } from "./fichiers";
import {
  lireJson,
  schemaCompletion,
  schemaErreur,
  schemaGitApercuFusion,
  schemaGitArbre,
  schemaGitBranches,
  schemaGitDepotCree,
  schemaGitDepots,
  schemaGitDepotsConnecteur,
  schemaGitDiff,
  schemaGitDiffCommit,
  schemaGitFichier,
  schemaGitFusion,
  schemaGitJournal,
  schemaGitResolution,
  schemaGitStatut,
} from "./schemas-bac";
import type { CommitGit, NoeudArbre } from "./schemas-bac";

type FetchAuth = (url: string, init?: RequestInit, soft?: boolean) => Promise<Response | null>;

export interface CtxGit {
  showToast(message: string, type?: string): void;
  fetchAuth: FetchAuth;
  openPrompt(titre: string, valeur: string, indice?: string): Promise<string | null | undefined>;
  openConfirm(titre: string, texte: string, danger?: boolean, ok?: string): Promise<boolean>;
  readonly availableModels?: Ref<string[]> | null | undefined;
  readonly activeModelIds?: Ref<string[]> | null | undefined;
}

export interface RefsGit {
  openTabs: Ref<Onglet[]>;
  models: Record<string, ModeleEditable | undefined>;
  originalFileContent?: Record<string, string | undefined>;
  readOnlyTabs?: Ref<Set<string>>;
}

export interface RappelsGit {
  openFile?: (path: string, force?: boolean) => Promise<unknown> | unknown;
  reloadTab?: (path: string) => Promise<unknown> | unknown;
  checkDisk?: () => void;
  loadSandboxFiles?: () => Promise<unknown> | unknown;
  _modelOk?: (path: string) => boolean;
  _tabIsDirty?: (path: string) => boolean;
  showDiffForMessage?: (path: string, avant: string) => void;
  applyActiveReadOnly?: () => void;
  isViewerPath?: (path: string) => boolean;
}

type Statut = z.infer<typeof schemaGitStatut>;
type Branches = z.infer<typeof schemaGitBranches>;
type ApercuFusion = z.infer<typeof schemaGitApercuFusion> & { conflicts?: string[] | null };
interface DiffCommit {
  hash: string;
  files: Array<{ path: string; status?: string | undefined }>;
  diff: string | null | undefined;
  message: string | null | undefined;
  author: string | null | undefined;
  timestamp: number | null | undefined;
}
interface DepotConnecteur {
  full_name?: string;
  description?: string;
  clone_url?: string;
  [cle: string]: unknown;
}

const JSON_POST = { method: "POST", headers: { "Content-Type": "application/json" } } as const;
const BRANCHES_VIDES: Branches = { current: "", local: [], remote: [] };

/** Git de l'éditeur : statut, branches, commits, distant, fusion, pastilles de l'arbre. */
export function setupEditorGit(refs: RefsGit, ctx: CtxGit, rappels: RappelsGit = {}) {
  const { openTabs, models, originalFileContent, readOnlyTabs } = refs;
  const { showToast, fetchAuth, openPrompt, openConfirm } = ctx;
  const openFile = rappels.openFile ?? (() => undefined);
  const reloadTab = rappels.reloadTab ?? (() => Promise.resolve(false));
  const checkDisk = rappels.checkDisk ?? (() => undefined);
  const loadSandboxFiles = (): void => {
    const r = rappels.loadSandboxFiles?.();
    if (r instanceof Promise) r.catch(() => undefined);
  };
  const modelOk = rappels._modelOk ?? (() => false);
  const tabIsDirty = rappels._tabIsDirty ?? (() => false);
  const showDiffForMessage = rappels.showDiffForMessage ?? (() => undefined);
  const applyActiveReadOnly = rappels.applyActiveReadOnly ?? (() => undefined);
  const isViewerPath = rappels.isViewerPath ?? (() => false);

  const explorerTab = ref("files");
  const gitRepos: Ref<Array<{ path: string; [cle: string]: unknown }>> = ref([]);
  const gitCurrentRepo = ref("");
  const gitStatus: Ref<Statut | null> = ref(null);
  const gitBranches: Ref<Branches> = ref({ ...BRANCHES_VIDES });
  const gitCommitMsg = ref("");
  const gitLoading = ref(false);
  const showGitCloneModal = ref(false);
  const gitCloneForm = ref({ url: "", dir: "" });
  const gitCloneConnectorId = ref("");
  const gitCloneRepos: Ref<DepotConnecteur[]> = ref([]);
  const gitCloneReposLoading = ref(false);
  const gitCloneReposError = ref("");
  const gitCloneRepoFilter = ref("");
  const showGitBranchMenu = ref(false);
  const showGitRemoteModal = ref(false);
  const gitRemoteForm = ref({ url: "" });
  const showGitInitModal = ref(false);
  const gitInitForm = ref({ user_name: "", user_email: "", dir: "" });
  const showGitMoreMenu = ref(false);
  const gitError = ref("");
  const showGitRepoMenu = ref(false);
  const showExplorerMenu = ref(false);
  const showGitMergeModal = ref(false);
  const gitMergePreview: Ref<ApercuFusion | null> = ref(null);
  const gitMergeBranch = ref("");
  const showGitPushAuth = ref(false);
  const gitCredShowPwd = ref(false);
  let pushForceEnAttente = false;
  const gitTree: Ref<NoeudArbre[]> = ref([]);
  const gitLog: Ref<CommitGit[]> = ref([]);
  const gitDiffData: Ref<DiffCommit | null> = ref(null);
  const gitCredUser = ref("");
  const gitCredToken = ref("");
  const gitSectionOpen = ref({ changes: true, tree: false, log: false, creds: false });

  /** Fin de session (poste partagé) : état git purgé, identifiants surtout. */
  function resetOnLogout(): void {
    gitCredUser.value = "";
    gitCredToken.value = "";
    gitCredShowPwd.value = false;
    showGitPushAuth.value = false;
    showGitMergeModal.value = false;
    gitStatus.value = null;
    gitBranches.value = { ...BRANCHES_VIDES };
    gitRepos.value = [];
    gitCurrentRepo.value = "";
    gitTree.value = [];
    gitLog.value = [];
    gitDiffData.value = null;
    gitCommitMsg.value = "";
    gitError.value = "";
    explorerTab.value = "files";
    clearTimeout(minuterieRafraichir);
  }

  const gq = (): string => (gitCurrentRepo.value ? "?repo=" + encodeURIComponent(gitCurrentRepo.value) : "");
  const gqEt = (suite: string): string => {
    const qp = gq();
    return qp + (qp ? "&" : "?") + suite;
  };
  function gb(o: Record<string, unknown> = {}): Record<string, unknown> {
    if (gitCurrentRepo.value) o["repo"] = gitCurrentRepo.value;
    return o;
  }
  function gcreds(o: Record<string, unknown>): Record<string, unknown> {
    if (gitCredUser.value && gitCredToken.value) {
      o["cred_user"] = gitCredUser.value;
      o["cred_token"] = gitCredToken.value;
    }
    return o;
  }
  const prefixeDepot = (): string =>
    gitCurrentRepo.value && gitCurrentRepo.value !== "." ? gitCurrentRepo.value + "/" : "";
  const poster = (url: string, corps: Record<string, unknown>): Promise<Response | null> =>
    fetchAuth(url, { ...JSON_POST, body: JSON.stringify(corps) });

  async function detail(r: Response, repli: string): Promise<string> {
    const e = await lireJson(r, schemaErreur);
    return typeof e?.detail === "string" && e.detail ? e.detail : repli;
  }

  /** Échec d'une opération : `null` (401, réseau) a son propre message, sinon le `detail` du serveur. */
  async function montrerErreur(r: Response | null, repli: string): Promise<void> {
    if (!r) {
      showToast("Session expirée / erreur réseau", "error");
      return;
    }
    showToast(await detail(r, repli || "Erreur"), "error");
  }

  /** Opération qui occupe `gitLoading` : erreurs réseau rendues par un toast. */
  async function occuper(fn: () => Promise<void>, messageExc = "Erreur réseau"): Promise<void> {
    gitLoading.value = true;
    try {
      await fn();
    } catch {
      showToast(messageExc, "error");
    } finally {
      gitLoading.value = false;
    }
  }

  async function gitLoadRepos(): Promise<void> {
    try {
      const r = await fetchAuth("/api/sandbox/git/repos", {}, true);
      if (r && r.ok) {
        const d = await lireJson(r, schemaGitDepots);
        if (!d) return;
        gitRepos.value = d.repos ?? [];
        const premier = gitRepos.value[0];
        if (premier && !gitRepos.value.find((x) => x.path === gitCurrentRepo.value))
          gitCurrentRepo.value = premier.path;
        else if (gitRepos.value.length === 0) gitCurrentRepo.value = "";
      }
    } catch {
      /* liste gardée */
    }
  }

  // Jeton de fraîcheur : chaque lecture capture son dépôt et jette la réponse si la sélection a changé.
  async function gitRefresh(): Promise<void> {
    const repo = gitCurrentRepo.value;
    if (!repo) {
      gitStatus.value = null;
      return;
    }
    try {
      const r = await fetchAuth("/api/sandbox/git/status" + gq(), {}, true);
      if (repo !== gitCurrentRepo.value) return;
      const statut = r && r.ok ? await lireJson(r, schemaGitStatut) : null;
      if (repo !== gitCurrentRepo.value) return;
      gitStatus.value = statut;
    } catch {
      if (repo === gitCurrentRepo.value) gitStatus.value = null;
    }
  }

  async function gitLoadBranches(): Promise<void> {
    const repo = gitCurrentRepo.value;
    if (!repo) return;
    try {
      const r = await fetchAuth("/api/sandbox/git/branches" + gq(), {}, true);
      if (repo !== gitCurrentRepo.value || !r || !r.ok) return;
      const b = await lireJson(r, schemaGitBranches);
      if (b && repo === gitCurrentRepo.value) gitBranches.value = b;
    } catch {
      /* branches gardées */
    }
  }

  async function gitOpenTab(): Promise<void> {
    explorerTab.value = "git";
    await gitLoadRepos();
    if (gitCurrentRepo.value) {
      await gitRefresh();
      await gitLoadBranches();
      await gitLoadTree();
    }
  }

  function gitSelectRepo(p: string): void {
    gitCurrentRepo.value = p;
    showGitRepoMenu.value = false;
    gitDiffData.value = null;
    void gitRefresh();
    void gitLoadBranches();
    if (gitSectionOpen.value.tree) void gitLoadTree();
    if (gitSectionOpen.value.log) void gitLoadLog();
  }

  async function apresCreation(r: Response): Promise<void> {
    const d = await lireJson(r, schemaGitDepotCree);
    await gitLoadRepos();
    if (d?.repo) gitCurrentRepo.value = d.repo;
    await gitRefresh();
    loadSandboxFiles();
  }

  async function gitInit(): Promise<void> {
    gitError.value = "";
    await occuper(async () => {
      const r = await poster("/api/sandbox/git/init", gitInitForm.value);
      if (r && r.ok) {
        showToast("Dépôt Git initialisé");
        showGitInitModal.value = false;
        await apresCreation(r);
      } else await montrerErreur(r, "Erreur");
    });
  }

  async function gitClone(): Promise<void> {
    if (!gitCloneForm.value.url) return;
    gitError.value = "";
    await occuper(async () => {
      const r = await poster("/api/sandbox/git/clone", gitCloneForm.value);
      if (r && r.ok) {
        showGitCloneModal.value = false;
        const d = await lireJson(r, schemaGitDepotCree);
        showToast(d?.message || "Clone terminé !");
        gitCloneForm.value = { url: "", dir: "" };
        await gitLoadRepos();
        if (d?.repo) gitCurrentRepo.value = d.repo;
        await gitRefresh();
        loadSandboxFiles();
      } else {
        const message = r ? await detail(r, "Erreur") : "Session expirée / erreur réseau";
        gitError.value = message;
        showToast(message, "error");
      }
    });
  }

  const gitFilteredCloneRepos = computed(() => {
    const q = (gitCloneRepoFilter.value || "").trim().toLowerCase();
    if (!q) return gitCloneRepos.value;
    return gitCloneRepos.value.filter((r) =>
      ((r.full_name || "") + " " + (r.description || "")).toLowerCase().includes(q),
    );
  });

  function gitOpenCloneModal(): void {
    gitCloneConnectorId.value = "";
    gitCloneRepos.value = [];
    gitCloneReposError.value = "";
    gitCloneRepoFilter.value = "";
    gitError.value = "";
    gitCloneForm.value = { url: "", dir: "" };
    showGitCloneModal.value = true;
  }

  async function gitLoadConnectorRepos(cid: string): Promise<void> {
    gitCloneRepoFilter.value = "";
    gitCloneReposError.value = "";
    gitCloneRepos.value = [];
    if (!cid) return;
    gitCloneReposLoading.value = true;
    try {
      const r = await fetchAuth("/api/git/connectors/" + encodeURIComponent(cid) + "/repos", {}, true);
      if (!r) {
        gitCloneReposError.value = "Session expirée / erreur réseau";
        return;
      }
      const d = await lireJson(r, schemaGitDepotsConnecteur);
      if (r.ok && d && d.ok) {
        gitCloneRepos.value = (d.repos ?? []) as DepotConnecteur[];
        if (!gitCloneRepos.value.length) gitCloneReposError.value = "Aucun dépôt accessible";
      } else {
        const err = d?.error || (typeof d?.detail === "string" ? d.detail : "") || "Erreur";
        gitCloneReposError.value =
          err === "no_api"
            ? "Ce connecteur ne supporte pas le listing des dépôts"
            : "Listing impossible : " + err;
      }
    } catch {
      gitCloneReposError.value = "Erreur réseau";
    } finally {
      gitCloneReposLoading.value = false;
    }
  }

  function gitPickRepo(repo: DepotConnecteur | null | undefined): void {
    if (!repo || !repo.clone_url) return;
    gitCloneForm.value.url = repo.clone_url;
    gitError.value = "";
  }

  function apresModificationDisque(): void {
    void gitLoadTree();
    loadSandboxFiles();
    _gitReloadOpenTabs();
  }

  async function operation(
    url: string,
    corps: Record<string, unknown>,
    repli: string,
    succes: () => Promise<void> | void,
    messageExc?: string,
  ): Promise<void> {
    await occuper(async () => {
      const r = await poster(url, corps);
      if (r && r.ok) await succes();
      else await montrerErreur(r, repli);
    }, messageExc);
  }

  const gitStage = (paths?: string[]): Promise<void> =>
    operation("/api/sandbox/git/stage", gb({ paths: paths || [] }), "Erreur stage", gitRefresh);
  const gitUnstage = (paths?: string[]): Promise<void> =>
    operation("/api/sandbox/git/unstage", gb({ paths: paths || [] }), "Erreur unstage", gitRefresh);

  async function gitDiscard(paths?: string[]): Promise<void> {
    const msg =
      paths && paths.length
        ? `Annuler les modifications de ${paths.join(", ")} ?`
        : "Annuler TOUTES les modifications ?";
    if (
      !(await openConfirm(
        "Annuler les modifications",
        msg + "\n\nCette opération est irréversible.",
        true,
        "Annuler les modifs",
      ))
    )
      return;
    await operation("/api/sandbox/git/discard", gb({ paths: paths || [] }), "Erreur", async () => {
      await gitRefresh();
      apresModificationDisque();
      showToast("Modifications annulées");
    });
  }

  async function gitCommit(): Promise<void> {
    if (!gitCommitMsg.value.trim()) return;
    await operation("/api/sandbox/git/commit", gb({ message: gitCommitMsg.value }), "Erreur", async () => {
      showToast("Commit effectué");
      gitCommitMsg.value = "";
      await gitRefresh();
      void gitLoadTree();
    });
  }

  /** Tente d'abord (identifiants des connecteurs côté serveur) ; la fenêtre d'authentification ne vient qu'après un refus d'authentification. */
  async function gitPush(force?: boolean): Promise<void> {
    await occuper(async () => {
      const r = await poster("/api/sandbox/git/push", gcreds(gb({ force: !!force })));
      if (r && r.ok) {
        showToast("Push réussi");
        await gitRefresh();
      } else if (!r) showToast("Session expirée / erreur réseau", "error");
      else {
        const msg = await detail(r, "Erreur push");
        const bas = msg.toLowerCase();
        // 409 : refus du relais Git (pas une question d'identifiants, les redemander bouclerait).
        if (
          r.status !== 409 &&
          (bas.includes("auth") || bas.includes("credential") || msg.includes("403") || msg.includes("401"))
        ) {
          pushForceEnAttente = !!force;
          showGitPushAuth.value = true;
          showToast("Authentification requise", "error");
        } else showToast(msg, "error");
      }
    });
  }

  async function gitPushAfterAuth(): Promise<void> {
    showGitPushAuth.value = false;
    if (!gitCredUser.value || !gitCredToken.value) {
      showToast("Identifiants requis", "error");
      return;
    }
    await gitPush(pushForceEnAttente);
  }

  const gitPull = (rebase?: boolean): Promise<void> =>
    operation("/api/sandbox/git/pull", gcreds(gb({ rebase: !!rebase })), "Erreur pull", async () => {
      showToast("Pull réussi");
      await gitRefresh();
      apresModificationDisque();
    });

  const gitFetch = (): Promise<void> =>
    operation("/api/sandbox/git/fetch", gb({}), "Erreur fetch", async () => {
      showToast("Fetch terminé");
      await gitLoadBranches();
    });

  async function gitCheckout(branch: string, create?: boolean): Promise<void> {
    showGitBranchMenu.value = false;
    await operation("/api/sandbox/git/checkout", gb({ branch, create: !!create }), "Erreur", async () => {
      showToast("Branche : " + branch);
      await gitRefresh();
      await gitLoadBranches();
      apresModificationDisque();
    });
  }

  async function gitCreateBranch(): Promise<void> {
    showGitBranchMenu.value = false;
    const name = await openPrompt("Nouvelle branche", "", "nom-de-la-branche");
    if (name && name.trim()) void gitCheckout(name.trim(), true);
  }

  async function gitRebase(branch: string): Promise<void> {
    if (!branch) return;
    await operation("/api/sandbox/git/rebase", gb({ branch }), "Erreur rebase", async () => {
      showToast("Rebase terminé");
      await gitRefresh();
      apresModificationDisque();
    });
  }

  async function gitPromptMerge(): Promise<void> {
    showGitMoreMenu.value = false;
    await gitOpenMergeModal();
  }

  async function gitPromptRebase(): Promise<void> {
    showGitMoreMenu.value = false;
    const b = await openPrompt("Rebase sur quelle branche", "", "nom-de-la-branche");
    if (b && b.trim()) void gitRebase(b.trim());
  }

  const gitStash = (action?: string, message?: string): Promise<void> =>
    operation(
      "/api/sandbox/git/stash",
      gb({ action: action || "push", message: message || "" }),
      "Erreur stash",
      async () => {
        showToast(action === "pop" ? "Stash appliqué" : "Stash créé");
        await gitRefresh();
        void gitLoadTree();
        if (action !== "list") {
          loadSandboxFiles();
          _gitReloadOpenTabs();
        }
      },
    );

  async function gitSetRemote(): Promise<void> {
    if (!gitRemoteForm.value.url) return;
    await operation("/api/sandbox/git/remote", gb({ url: gitRemoteForm.value.url }), "Erreur", async () => {
      showToast("Remote configuré");
      showGitRemoteModal.value = false;
      await gitRefresh();
    });
  }

  async function gitOpenMergeModal(): Promise<void> {
    await gitLoadBranches();
    gitMergeBranch.value = "";
    gitMergePreview.value = null;
    showGitMergeModal.value = true;
  }

  async function gitLoadMergePreview(branch: string): Promise<void> {
    if (!branch) {
      gitMergePreview.value = null;
      return;
    }
    gitMergeBranch.value = branch;
    gitLoading.value = true;
    try {
      const r = await fetchAuth(
        "/api/sandbox/git/merge-preview" + gqEt("branch=" + encodeURIComponent(branch)),
        {},
        true,
      );
      if (r && r.ok) gitMergePreview.value = await lireJson(r, schemaGitApercuFusion);
      else {
        await montrerErreur(r, "Erreur");
        gitMergePreview.value = null;
      }
    } catch {
      showToast("Erreur réseau", "error");
      gitMergePreview.value = null;
    } finally {
      gitLoading.value = false;
    }
  }

  async function gitExecuteMerge(strategy?: string): Promise<void> {
    if (!gitMergeBranch.value) return;
    await occuper(async () => {
      const r = await poster(
        "/api/sandbox/git/merge",
        gb({ branch: gitMergeBranch.value, strategy: strategy || "" }),
      );
      if (!r || !r.ok) {
        await montrerErreur(r, "Erreur merge");
        return;
      }
      const d = await lireJson(r, schemaGitFusion);
      if (!d) throw new Error("réponse illisible");
      if (d.conflicts) {
        // Marqueurs de conflit écrits sur le disque : onglets propres rechargés pour les montrer.
        loadSandboxFiles();
        _gitReloadOpenTabs();
        gitMergePreview.value = {
          branch: gitMergeBranch.value,
          commits: [],
          files: [],
          total_add: 0,
          total_del: 0,
          ...gitMergePreview.value,
          conflicts: d.conflicted_files,
        };
        showToast(d.message || "Conflits détectés", "error");
      } else {
        showToast("Merge terminé");
        showGitMergeModal.value = false;
        await gitRefresh();
        apresModificationDisque();
      }
    }, "Erreur");
  }

  async function gitMergeAbort(): Promise<void> {
    await operation("/api/sandbox/git/merge-abort", gb({}), "Erreur annulation merge", async () => {
      showToast("Merge annulé");
      if (gitMergePreview.value) gitMergePreview.value.conflicts = null;
      await gitRefresh();
      apresModificationDisque();
    });
  }

  async function gitMergeResolve(strategy: string, files?: string[]): Promise<void> {
    const corps: Record<string, unknown> = { strategy };
    if (Array.isArray(files) && files.length) corps["files"] = files;
    await occuper(async () => {
      const r = await poster("/api/sandbox/git/merge-resolve", gb(corps));
      if (!r || !r.ok) {
        await montrerErreur(r, "Erreur");
        return;
      }
      const d = await lireJson(r, schemaGitResolution);
      if (!d) throw new Error("réponse illisible");
      if (d.all_resolved) {
        showToast("Conflits résolus -- merge commité");
        showGitMergeModal.value = false;
        if (gitMergePreview.value) gitMergePreview.value.conflicts = null;
        await gitRefresh();
        apresModificationDisque();
      } else {
        showToast(String(d.resolved) + " fichier(s) résolu(s)");
        await gitRefresh();
        // La fenêtre ne garde que les fichiers encore en conflit.
        const enConflit = gitStatus.value?.conflicted;
        if (gitMergePreview.value && Array.isArray(enConflit))
          gitMergePreview.value = { ...gitMergePreview.value, conflicts: enConflit.map((c) => c.path) };
        loadSandboxFiles();
        _gitReloadOpenTabs();
      }
    }, "Erreur");
  }

  async function gitLoadTree(): Promise<void> {
    const repo = gitCurrentRepo.value;
    if (!repo) {
      gitTree.value = [];
      return;
    }
    try {
      const r = await fetchAuth("/api/sandbox/git/tree" + gq(), {}, true);
      if (repo !== gitCurrentRepo.value) return;
      if (r && r.ok) {
        const items = (await lireJson(r, schemaGitArbre))?.items ?? [];
        const pre = repo && repo !== "." ? repo + "/" : "";
        if (pre) {
          const prefixer = (noeuds: NoeudArbre[]): void => {
            for (const n of noeuds) {
              n.path = pre + n.path;
              if (n.children) prefixer(n.children);
            }
          };
          prefixer(items);
        }
        if (repo !== gitCurrentRepo.value) return;
        gitTree.value = items;
      }
    } catch {
      if (repo === gitCurrentRepo.value) gitTree.value = [];
    }
  }

  async function gitLoadLog(): Promise<void> {
    const repo = gitCurrentRepo.value;
    if (!repo) {
      gitLog.value = [];
      return;
    }
    try {
      const r = await fetchAuth("/api/sandbox/git/log" + gqEt("n=40"), {}, true);
      if (repo !== gitCurrentRepo.value) return;
      if (r && r.ok) {
        const d = await lireJson(r, schemaGitJournal);
        if (repo === gitCurrentRepo.value) gitLog.value = d?.commits ?? [];
      }
    } catch {
      if (repo === gitCurrentRepo.value) gitLog.value = [];
    }
  }

  function gitOpenRepoFile(relPath: string): void {
    const r = openFile(prefixeDepot() + relPath);
    if (r instanceof Promise) r.catch(() => undefined);
  }

  async function gitViewCommitDiff(hash: string): Promise<void> {
    gitLoading.value = true;
    try {
      const r = await fetchAuth(
        "/api/sandbox/git/commit-diff" + gqEt("hash=" + encodeURIComponent(hash)),
        {},
        true,
      );
      if (r && r.ok) {
        const d = await lireJson(r, schemaGitDiffCommit);
        if (d)
          gitDiffData.value = {
            hash,
            files: d.files ?? [],
            diff: d.diff,
            message: d.message,
            author: d.author,
            timestamp: d.timestamp,
          };
      }
    } catch {
      /* diff non affiché */
    } finally {
      gitLoading.value = false;
    }
  }

  async function lireVersion(hash: string, filePath: string): Promise<string> {
    const r = await fetchAuth(
      "/api/sandbox/git/show-file" +
        gqEt("hash=" + encodeURIComponent(hash) + "&path=" + encodeURIComponent(filePath)),
      {},
      true,
    );
    if (!r || !r.ok) return "";
    return (await lireJson(r, schemaGitFichier))?.content || "";
  }

  /** Diff côte à côte d'un fichier entre `hash~1` et `hash` ; l'onglet passe en lecture seule (consultation). */
  async function gitShowFileDiff(hash: string, filePath: string): Promise<void> {
    const tabPath = prefixeDepot() + filePath;
    if (isViewerPath(tabPath)) {
      showToast("Diff indisponible pour ce type de fichier", "info");
      return;
    }
    const refuser = (): void =>
      showToast(
        "Enregistrez d’abord " +
          (tabPath.split("/").pop() ?? tabPath) +
          " : la version du commit remplacerait vos modifications.",
        "warning",
      );
    // Le contenu du modèle vivant est remplacé : un onglet modifié perdrait son travail.
    if (tabIsDirty(tabPath)) {
      refuser();
      return;
    }
    try {
      const avant = await lireVersion(hash + "~1", filePath);
      const apres = await lireVersion(hash, filePath);
      await openFile(tabPath, false);
      if (tabIsDirty(tabPath)) {
        refuser();
        return;
      }
      const modele = models[tabPath];
      if (modelOk(tabPath) && modele) {
        // Lecture seule (Ctrl+S et enregistrement automatique refusés) et contenu de référence = contenu affiché.
        readOnlyTabs?.value.add(tabPath);
        remplacerContenu(modele, apres);
        if (originalFileContent) originalFileContent[tabPath] = apres;
        applyActiveReadOnly();
      }
      showDiffForMessage(tabPath, avant);
    } catch {
      showToast("Erreur chargement diff", "error");
    }
  }

  async function gitRestoreCommit(hash: string): Promise<void> {
    const ok = await openConfirm(
      "Restaurer un commit",
      `Restaurer vers ${hash.substring(0, 8)} ?\n\nUn nouveau commit sera créé pour enregistrer la restauration.`,
      false,
      "Restaurer",
    );
    if (!ok) return;
    await operation(
      "/api/sandbox/git/restore-commit",
      gb({ hash }),
      "Erreur",
      async () => {
        showToast("Restauré");
        await gitRefresh();
        await gitLoadLog();
        apresModificationDisque();
      },
      "Erreur",
    );
  }

  async function gitRevertLast(): Promise<void> {
    const ok = await openConfirm(
      "Annuler le dernier commit",
      "Un commit de revert sera ajouté par-dessus. L'historique reste intact.",
      false,
      "Annuler le commit",
    );
    if (!ok) return;
    await operation(
      "/api/sandbox/git/revert-last",
      gb({}),
      "Erreur",
      async () => {
        showToast("Commit annulé");
        await gitRefresh();
        await gitLoadLog();
        apresModificationDisque();
      },
      "Erreur",
    );
  }

  function gitResolveFile(strategy: string, file: string): Promise<void> | undefined {
    if (!file) return undefined;
    return gitMergeResolve(strategy, [file]);
  }

  // Message de commit proposé par l'IA à partir du diff indexé (même moteur que les actions IA de l'éditeur).
  const gitCommitSuggesting = ref(false);
  async function gitSuggestCommitMessage(): Promise<void> {
    if (gitCommitSuggesting.value) return;
    if (!gitStatus.value?.staged?.length) {
      showToast("Indexez d'abord les fichiers à commiter", "info");
      return;
    }
    const tous = ctx.availableModels?.value ?? [];
    const charges = ctx.activeModelIds?.value ?? [];
    const modelId = charges.find((id) => tous.includes(id)) || tous[0] || null;
    if (!modelId) {
      showToast("Aucun modèle disponible", "warning");
      return;
    }
    gitCommitSuggesting.value = true;
    try {
      const rd = await fetchAuth("/api/sandbox/git/diff" + gqEt("staged=1"), {}, true);
      if (!rd || !rd.ok) {
        await montrerErreur(rd, "Diff indisponible");
        return;
      }
      const diff = ((await lireJson(rd, schemaGitDiff))?.diff || "").slice(0, 8000);
      if (!diff.trim()) {
        showToast("Rien d'indexé", "info");
        return;
      }
      const prefix =
        "Diff des changements indexés :\n\n" +
        diff +
        "\n\nMessage de commit Git correspondant, une seule ligne, à l'impératif, " +
        "72 caractères maximum, sans guillemets :\n";
      const r = await poster("/api/llm/infill", { input_prefix: prefix, input_suffix: "\n", model: modelId });
      if (!r || !r.ok) {
        await montrerErreur(r, "Suggestion impossible");
        return;
      }
      const d = await lireJson(r, schemaCompletion);
      const contenu = d?.content;
      let ligne =
        String(contenu ?? "")
          .split("\n")
          .map((l) => l.trim())
          .find((l) => l && !/^```/.test(l)) || "";
      ligne = ligne.replace(/^["'`«\s]+|["'`»\s]+$/g, "").slice(0, 100);
      if (!ligne) {
        showToast("Pas de suggestion", "warning");
        return;
      }
      gitCommitMsg.value = ligne;
    } catch {
      showToast("Erreur réseau", "error");
    } finally {
      gitCommitSuggesting.value = false;
    }
  }

  /** Statut en arrière-plan : pastilles de l'arbre, branche de la barre d'état, marge du code. */
  async function gitBackgroundInit(): Promise<void> {
    await gitLoadRepos();
    if (gitCurrentRepo.value) await gitRefresh();
  }

  // Après enregistrement, renommage ou suppression : statut (fondu sur 600 ms), arbre du dépôt si la vue Git est ouverte.
  let minuterieRafraichir: ReturnType<typeof setTimeout> | undefined;
  function _gitAutoRefresh(): void {
    clearTimeout(minuterieRafraichir);
    minuterieRafraichir = setTimeout(() => {
      if (!gitRepos.value.length) {
        void gitLoadRepos().then(() => {
          if (gitCurrentRepo.value) void gitRefresh();
        });
        return;
      }
      if (!gitCurrentRepo.value) return;
      void gitRefresh();
      if (explorerTab.value === "git") void gitLoadTree();
    }, 600);
  }

  /** Après changement de branche, pull, fusion ou restauration : onglets propres du dépôt relus, onglets modifiés gardés. */
  function _gitReloadOpenTabs(): void {
    const pre = prefixeDepot();
    let gardes = 0;
    for (const tab of openTabs.value) {
      if (pre && !tab.path.startsWith(pre)) continue;
      if (tabIsDirty(tab.path)) {
        gardes++;
        continue;
      }
      Promise.resolve(reloadTab(tab.path)).catch(() => undefined);
    }
    // Onglets modifiés : seule la comparaison par empreinte signale ceux dont le fichier a vraiment changé.
    if (gardes) checkDisk();
  }

  return {
    explorerTab,
    gitRepos,
    gitCurrentRepo,
    gitStatus,
    gitBranches,
    gitCommitMsg,
    gitLoading,
    gitError,
    showGitCloneModal,
    gitCloneForm,
    showGitBranchMenu,
    gitCloneConnectorId,
    gitCloneRepos,
    gitCloneReposLoading,
    gitCloneReposError,
    gitCloneRepoFilter,
    gitFilteredCloneRepos,
    showGitRemoteModal,
    gitRemoteForm,
    showGitInitModal,
    gitInitForm,
    showGitMoreMenu,
    showGitRepoMenu,
    showExplorerMenu,
    showGitMergeModal,
    gitMergePreview,
    gitMergeBranch,
    showGitPushAuth,
    gitCredShowPwd,
    gitTree,
    gitLog,
    gitDiffData,
    gitCredUser,
    gitCredToken,
    gitSectionOpen,
    gitOpenTab,
    gitSelectRepo,
    gitLoadRepos,
    gitRefresh,
    gitLoadBranches,
    gitInit,
    gitClone,
    gitOpenCloneModal,
    gitLoadConnectorRepos,
    gitPickRepo,
    gitStage,
    gitUnstage,
    gitDiscard,
    gitCommit,
    gitPush,
    gitPushAfterAuth,
    gitPull,
    gitFetch,
    gitCheckout,
    gitCreateBranch,
    gitRebase,
    gitPromptMerge,
    gitPromptRebase,
    gitStash,
    gitSetRemote,
    gitOpenMergeModal,
    gitLoadMergePreview,
    gitExecuteMerge,
    gitMergeAbort,
    gitMergeResolve,
    gitLoadTree,
    gitLoadLog,
    gitOpenRepoFile,
    gitViewCommitDiff,
    gitShowFileDiff,
    gitRestoreCommit,
    gitRevertLast,
    gitBackgroundInit,
    gitResolveFile,
    gitSuggestCommitMessage,
    gitCommitSuggesting,
    _gitAutoRefresh,
    _gitReloadOpenTabs,
    resetOnLogout,
  };
}
