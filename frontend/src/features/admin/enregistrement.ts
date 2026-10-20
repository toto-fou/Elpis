// SPDX-License-Identifier: MIT
/** frontend/src/features/admin/enregistrement.ts — enregistrement unifié par page : instantanés « propres » des blocs, diff champ par champ, barre d'enregistrement, garde de sortie et raccourci Ctrl+S. */
import { CHEMINS_SECRETS_CONFIG } from "@elpis/contracts";

import { IDS_BLOCS, diffFeuilles, poserChemin } from "./etat";
import type { BaseAdmin, IdBloc } from "./etat";
import type { FeuilleModifiee } from "./etat";

export type IdStore = IdBloc | "prompt";

export interface ModificationPage {
  store: IdStore;
  path: string;
  before: unknown;
  after: unknown;
  removed?: boolean;
}

interface Bloc {
  label: string;
  snapshot(): string | null;
  save(): Promise<boolean>;
  reload(): Promise<void>;
}

const ETIQUETTES_BLOCS: Readonly<Record<string, string>> = {
  scheduling: "Mode de planification",
  allowed: "Fournisseurs autorisés",
};

const estBlocReversible = (c: ModificationPage): boolean =>
  c.store === "config" ||
  c.store === "compression" ||
  c.store === "scheduling" ||
  c.store === "allowed" ||
  c.store === "agents" ||
  (c.store === "exec" && !/^network_profiles/.test(c.path));

const RE_CLE_SECRETE = /(^|[_-])(api_?key(_enc)?|encryption_key|token|secret|password|passwd|jeton)$/iu;

/** Secret de la liste commune au serveur, ou dernier segment qui en nomme un (`voice.stt.token`) : sa valeur n'est jamais affichée ; `max_tokens` n'en est pas un. */
const estCleSecrete = (chemin: string): boolean =>
  (CHEMINS_SECRETS_CONFIG as readonly string[]).includes(chemin) ||
  RE_CLE_SECRETE.test(chemin.split(".").pop() ?? "");

export function creerEnregistrement(b: BaseAdmin) {
  const { vue, ctx, e, nav, lien } = b;
  const { computed, ref } = vue;

  /** Blocs enregistrés par la barre d'une page, avec leur lecture, écriture et rechargement. */
  const BLOCS: Record<IdBloc, Bloc> = {
    config: {
      label: "réglages",
      snapshot: () => (e.configForm.value ? JSON.stringify(e.configForm.value) : null),
      save: () => lien.saveConfigStore(),
      reload: () => {
        e.adminPristine.value.config = null;
        return lien.loadAdminConfig("main");
      },
    },
    compression: {
      label: "compression",
      snapshot: () => (e.compressionCfg.value ? JSON.stringify(e.compressionCfg.value) : null),
      save: () => lien.saveCompressionCfg(),
      reload: () => lien.loadCompressionCfg(),
    },
    scheduling: {
      label: "planification",
      snapshot: () => (e.llmScheduling.value ? String(e.llmScheduling.value.configured_mode || "") : null),
      save: () => lien.saveLlmSchedulingMode(),
      reload: () => lien.loadLlmScheduling(),
    },
    allowed: {
      label: "fournisseurs autorisés",
      snapshot: () => JSON.stringify(e.admLlmAllowed.value || []),
      save: () => lien.saveAdmAllowed(),
      reload: () => lien.loadAdminLlmConnectors(),
    },
    exec: {
      label: "sandbox",
      snapshot: () => (e.execConfig.value ? JSON.stringify(lien.execConfigPayload()) : null),
      save: () => lien.saveExecConfig(),
      reload: () => lien.loadExecConfig(),
    },
    agents: {
      label: "sous-agents",
      snapshot: () => JSON.stringify(e.agentsConfig.value),
      save: () => lien.saveAgentsConfig(),
      reload: () => lien.loadAgentsConfig(),
    },
  };

  const BLOCS_PAR_PAGE: Readonly<Record<string, readonly string[]>> = Object.freeze(
    Object.fromEntries(
      Object.values(nav.pages)
        .filter((p) => p.stores.length)
        .map((p) => [p.id, p.stores]),
    ),
  );
  const blocsDe = (page: string): IdBloc[] =>
    (BLOCS_PAR_PAGE[page] ?? []).filter((id): id is IdBloc => (IDS_BLOCS as readonly string[]).includes(id));

  function storeSnapshot(id: IdBloc): string | null {
    try {
      return BLOCS[id].snapshot();
    } catch {
      return null;
    }
  }
  function markAdminStoreClean(id: IdBloc): void {
    e.adminPristine.value[id] = storeSnapshot(id);
  }

  /** Lignes modifiées de la page ouverte ; l'instantané est lu avant le test de référence pour garder la dépendance. */
  const adminPageChanges = computed<ModificationPage[]>(() => {
    const sortie: ModificationPage[] = [];
    for (const id of blocsDe(e.adminTab.value)) {
      const snap = storeSnapshot(id);
      const base = e.adminPristine.value[id];
      if (base === null || base === undefined || snap === base) continue;
      let lignes: (FeuilleModifiee | { path: string; before: unknown; after: unknown })[];
      try {
        if (id === "scheduling") lignes = [{ path: "configured_mode", before: base, after: snap }];
        else if (id === "allowed")
          lignes = [
            {
              path: "allowed_provider_types",
              before: JSON.parse(base) as unknown,
              after: JSON.parse(snap ?? "[]") as unknown,
            },
          ];
        else lignes = diffFeuilles(JSON.parse(base), JSON.parse(snap ?? "null"));
      } catch {
        lignes = [{ path: id, before: null, after: null }];
      }
      for (const r of lignes) sortie.push({ store: id, ...r });
    }
    if (e.adminTab.value === "prompts" && e.promptsEditorDirty.value) {
      sortie.push({ store: "prompt", path: e.promptsSelected.value || "prompt", before: null, after: null });
    }
    return sortie;
  });
  const adminDirtyCount = computed(() => adminPageChanges.value.length);
  const adminDirtyStores = computed<IdStore[]>(() => [
    ...new Set(adminPageChanges.value.map((c) => c.store)),
  ]);
  const adminPageSavable = computed(
    () => blocsDe(e.adminTab.value).length > 0 || e.adminTab.value === "prompts",
  );
  const isSavingAdminPage = ref(false);

  /** Libellé d'une modification : celui de la ligne qui porte le champ (`data-field`), précisé par l'aria-label. */
  function adminChangeLabel(c: Pick<ModificationPage, "store" | "path">): string {
    if (c.store === "prompt") return "Prompt « " + c.path + " »";
    const fixe = ETIQUETTES_BLOCS[c.store];
    if (fixe) return fixe;
    if (c.store === "exec" && /^network_profiles/.test(c.path)) return "Profils réseau";
    try {
      const el = document.querySelector('[data-field="' + c.store + ":" + c.path + '"]');
      if (el) {
        const ligne = el.closest(".adm-row");
        const lbl = ligne?.querySelector(".adm-row__label");
        const principal = lbl?.textContent?.trim() ?? "";
        const aria = (el.getAttribute("aria-label") || "").trim();
        if (principal && aria && aria !== principal) return principal + " › " + aria;
        if (principal || aria) return principal || aria;
      }
    } catch {
      /* DOM indisponible */
    }
    const dernier = String(c.path).split(".").pop() || c.path;
    return dernier.charAt(0).toUpperCase() + dernier.slice(1).replace(/_/g, " ");
  }

  /** Modification d'un secret : la barre dit « clé modifiée » sans montrer ni l'ancienne ni la nouvelle valeur. */
  const adminChangeSecret = (c: Pick<ModificationPage, "path">): boolean => estCleSecrete(c.path);

  function adminChangeValue(v: unknown): string {
    if (v === undefined || v === null || v === "") return "(vide)";
    if (v === true) return "Activé";
    if (v === false) return "Désactivé";
    if (Array.isArray(v)) return v.length ? v.length + " élément" + (v.length > 1 ? "s" : "") : "(aucun)";
    if (typeof v === "object") return "modifié";
    const t = String(v);
    return t.length > 42 ? t.slice(0, 41) + "…" : t;
  }

  /** Retour arrière d'un champ ; profils réseau et prompt se rétablissent en bloc par « Annuler ». */
  function revertAdminChange(c: ModificationPage): void {
    if (!estBlocReversible(c)) return;
    if (c.store === "config" && e.configForm.value) poserChemin(e.configForm.value, c.path, c.before);
    else if (c.store === "compression" && e.compressionCfg.value)
      poserChemin(e.compressionCfg.value, c.path, c.before);
    else if (c.store === "scheduling" && e.llmScheduling.value)
      e.llmScheduling.value.configured_mode = String(c.before ?? "");
    else if (c.store === "allowed")
      e.admLlmAllowed.value = Array.isArray(c.before) ? [...(c.before as string[])] : [];
    else if (c.store === "exec" && e.execConfig.value) poserChemin(e.execConfig.value, c.path, c.before);
    else if (c.store === "agents") poserChemin(e.agentsConfig.value, c.path, c.before);
    void ctx.nextTick().then(() => {
      if (!adminDirtyCount.value) e.adminChangesOpen.value = false;
    });
  }

  /** Enregistre les blocs modifiés de la page, un par un (config.json d'abord) ; vrai si tout est parti. */
  async function saveAdminPage(): Promise<boolean> {
    if (isSavingAdminPage.value) return false;
    const sales = adminDirtyStores.value.slice();
    if (!sales.length) return true;
    isSavingAdminPage.value = true;
    const echecs: string[] = [];
    try {
      for (const id of sales) {
        let ok = false;
        try {
          ok = id === "prompt" ? !!(await lien.savePrompt()) : await BLOCS[id].save();
        } catch {
          ok = false;
        }
        if (ok && id !== "prompt") markAdminStoreClean(id);
        if (!ok) echecs.push(id === "prompt" ? "prompt" : BLOCS[id].label);
      }
    } finally {
      isSavingAdminPage.value = false;
    }
    if (!echecs.length) {
      ctx.showToast("Modifications enregistrées", "success");
      e.adminChangesOpen.value = false;
    } else if (echecs.length === sales.length) {
      ctx.showToast("Enregistrement échoué : " + echecs.join(", "), "error");
    } else {
      ctx.showToast("Enregistré en partie — échec : " + echecs.join(", "), "warning");
    }
    return !echecs.length;
  }

  /** Abandonne les modifications : les blocs sont relus depuis le serveur, sans confirmation. */
  async function discardAdminPage(silencieux?: unknown): Promise<void> {
    const sales = adminDirtyStores.value.slice();
    e.adminChangesOpen.value = false;
    if (!sales.length) return;
    for (const id of sales) {
      if (id === "prompt") {
        try {
          await lien.reloadPrompt();
        } catch {
          /* relecture au mieux */
        }
        continue;
      }
      try {
        await BLOCS[id].reload();
      } catch {
        /* relecture au mieux */
      }
      markAdminStoreClean(id);
    }
    if (silencieux !== true) ctx.showToast("Modifications annulées");
  }

  /** Garde de sortie : vrai si l'on peut quitter la page. */
  async function adminConfirmLeave(): Promise<boolean> {
    const n = adminDirtyCount.value;
    if (!n) return true;
    const page = nav.pages[e.adminTab.value];
    const choix = await ctx.openChoice(
      "Modifications non enregistrées",
      n + " modification" + (n > 1 ? "s" : "") + " sur « " + (page?.label ?? "") + " ».",
      [
        { id: "discard", label: "Ignorer", tone: "neutral" },
        { id: "save", label: "Enregistrer", tone: "primary" },
      ],
      "Rester",
    );
    if (choix === "save") return saveAdminPage();
    if (choix === "discard") {
      await discardAdminPage(true);
      return true;
    }
    return false;
  }

  const vueAdminActive = (): boolean => !b.refs.isAdminView || b.refs.isAdminView.value;

  function garderAvantFermeture(ev: BeforeUnloadEvent): string | undefined {
    if (!vueAdminActive() || !adminDirtyCount.value) return undefined;
    ev.preventDefault();
    ev.returnValue = "";
    return "";
  }
  /** Ctrl+S (⌘S) enregistre la page de la console si elle est modifiée. */
  function raccourciEnregistrer(ev: KeyboardEvent): void {
    if (!(ev.ctrlKey || ev.metaKey) || ev.altKey || String(ev.key).toLowerCase() !== "s") return;
    if (!vueAdminActive() || !adminDirtyCount.value) return;
    ev.preventDefault();
    void saveAdminPage();
  }
  window.addEventListener("beforeunload", garderAvantFermeture);
  document.addEventListener("keydown", raccourciEnregistrer);
  const liberer = (): void => {
    window.removeEventListener("beforeunload", garderAvantFermeture);
    document.removeEventListener("keydown", raccourciEnregistrer);
  };

  return {
    adminDirtyStores,
    adminDirtyCount,
    adminPageSavable,
    isSavingAdminPage,
    adminPageChanges,
    adminChangeLabel,
    adminChangeValue,
    adminChangeSecret,
    adminChangeRevertable: estBlocReversible,
    revertAdminChange,
    adminConfirmLeave,
    saveAdminPage,
    discardAdminPage,
    storeSnapshot,
    markAdminStoreClean,
    liberer,
  };
}

export type SurfaceEnregistrement = ReturnType<typeof creerEnregistrement>;
