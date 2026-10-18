// SPDX-License-Identifier: MIT
/** frontend/src/features/editor/memoire-onglets.ts — onglets mémorisés par compte (chemins, actif, épinglés, positions) : écriture regroupée, restauration à la première ouverture, réouverture différée après un échec passager, pile des onglets fermés (Ctrl+Maj+T). */
import { nextTick, watch } from "vue";
import type { Ref } from "vue";

interface Onglet {
  path: string;
  name: string;
  pinned?: boolean;
  [cle: string]: unknown;
}

export interface PositionOnglet {
  line: number;
  col: number;
  top: number;
}

interface EtatVue {
  cursorState?: Array<{
    position?: { lineNumber: number; column: number };
    selectionStart?: { lineNumber: number; column: number };
  }>;
  viewState?: { scrollTop?: number };
}

interface DonneesOnglets {
  paths: string[];
  active: string | null;
  pinned?: string[];
  positions?: Record<string, PositionOnglet>;
}

export interface RefsMemoire {
  openTabs: Ref<Onglet[]>;
  activeTabPath: Ref<string | null>;
  settings: Ref<{ editor_persist_tabs?: boolean; enable_editor?: boolean; [cle: string]: unknown } | null>;
  user: Ref<{ id?: unknown; [cle: string]: unknown } | null>;
  showEditor: Ref<boolean>;
  readonly monacoRef: { instance: { getModel(): unknown; saveViewState(): unknown } | null };
  readonly models: Record<string, unknown>;
  readonly tabViewStates: Record<string, unknown>;
  readonly openTransientFail: Set<string>;
}

export interface RappelsMemoire {
  ouvrirFichier(chemin: string, force: boolean, opts?: { quiet: boolean }): Promise<unknown>;
  basculer(chemin: string): Promise<unknown>;
  modeVue(chemin: string): string;
  toast(message: string, type?: string): void;
}

const MAX_FERMES = 20;
const nom = (p: string): string => p.split("/").pop() ?? p;

export function setupEditorTabMemory(refs: RefsMemoire, r: RappelsMemoire) {
  const { openTabs, activeTabPath, settings, user } = refs;

  /** Clé par compte (suffixe `personal` historique, gardé pour ne pas perdre les onglets déjà mémorisés). */
  function _tabsStorageKey(): string {
    const uid = (user.value && user.value.id) || "anon";
    return `elpis.tabs.v2.${String(uid)}.personal`;
  }
  /** Activée par défaut ; réglages pas encore chargés = activée (une purge sur une valeur transitoire effaçait la session). */
  function _tabsPersistEnabled(): boolean {
    return !!(settings.value && settings.value.editor_persist_tabs !== false);
  }

  /** Curseur et défilement : lus dans l'éditeur pour l'onglet actif, dans le cache d'état de vue sinon. */
  function _tabPosition(chemin: string): PositionOnglet | null {
    try {
      const ed = refs.monacoRef.instance;
      let vs: EtatVue | null | undefined = null;
      if (chemin === activeTabPath.value && ed && ed.getModel() === refs.models[chemin]) {
        vs = ed.saveViewState() as EtatVue | null;
      } else {
        vs = refs.tabViewStates[chemin] as EtatVue | undefined;
      }
      const c = vs?.cursorState?.[0];
      const pos = c ? c.position || c.selectionStart : null;
      if (!vs || !pos) return null;
      return { line: pos.lineNumber, col: pos.column, top: vs.viewState?.scrollTop || 0 };
    } catch {
      return null;
    }
  }
  /** Positions restaurées au démarrage, appliquées au premier affichage. */
  const _pendingPositions: Record<string, PositionOnglet> = Object.create(null) as Record<
    string,
    PositionOnglet
  >;
  // Onglets dont la réouverture a échoué pour une cause passagère : gardés dans la session mémorisée.
  let differes: string[] = [];
  let minuterieEcriture: ReturnType<typeof setTimeout> | null = null;
  let minuterieReprise: ReturnType<typeof setTimeout> | null = null;
  let derniereRestauration: unknown = null;

  function _buildTabsData(): DonneesOnglets {
    const positions: Record<string, PositionOnglet> = {};
    for (const t of openTabs.value) {
      const pos = _tabPosition(t.path) || _pendingPositions[t.path];
      if (pos) positions[t.path] = pos;
    }
    const ouverts = openTabs.value.map((t) => t.path);
    return {
      paths: ouverts.concat(differes.filter((p) => !ouverts.includes(p))),
      active: activeTabPath.value || null,
      pinned: openTabs.value.filter((t) => t.pinned).map((t) => t.path),
      positions,
    };
  }
  function ecrire(cle: string, donnees: DonneesOnglets): void {
    try {
      localStorage.setItem(cle, JSON.stringify(donnees));
    } catch {
      /* stockage plein ou bloqué */
    }
  }
  /** Écriture regroupée (150 ms) : données et clé capturées à la planification (la clé suivait le compte courant au tir). */
  function _schedulePersistTabs(): void {
    if (!_tabsPersistEnabled()) {
      try {
        localStorage.removeItem(_tabsStorageKey());
      } catch {
        /* stockage bloqué */
      }
      return;
    }
    const donnees = _buildTabsData();
    const cle = _tabsStorageKey();
    if (minuterieEcriture) clearTimeout(minuterieEcriture);
    minuterieEcriture = setTimeout(() => {
      minuterieEcriture = null;
      ecrire(cle, donnees);
    }, 150);
  }
  watch(openTabs, _schedulePersistTabs, { deep: true });
  watch(activeTabPath, _schedulePersistTabs);

  function annulerReprise(): void {
    if (minuterieReprise) clearTimeout(minuterieReprise);
    minuterieReprise = null;
  }
  function planifierReprise(tentative: number, ms: number): void {
    annulerReprise();
    const uid = user.value?.id;
    minuterieReprise = setTimeout(() => {
      minuterieReprise = null;
      // Un autre compte entre-temps : ses onglets ne sont pas ceux du précédent.
      if (user.value?.id !== uid) return;
      void _retryDeferredTabs(tentative);
    }, ms);
  }

  async function _retryDeferredTabs(tentative: number): Promise<void> {
    if (!differes.length) return;
    const garde = activeTabPath.value;
    for (const p of differes.slice()) {
      if (openTabs.value.some((t) => t.path === p)) continue;
      try {
        await r.ouvrirFichier(p, false, { quiet: true });
      } catch {
        /* nouvel essai plus tard */
      }
    }
    differes = differes.filter(
      (p) => !openTabs.value.some((t) => t.path === p) && refs.openTransientFail.has(p),
    );
    // La réouverture ne vole pas l'onglet sur lequel on travaille.
    if (garde && garde !== activeTabPath.value && openTabs.value.some((t) => t.path === garde)) {
      try {
        await r.basculer(garde);
      } catch {
        /* onglet fermé entre-temps */
      }
    }
    _schedulePersistTabs();
    if (differes.length && tentative < 4) {
      planifierReprise(tentative + 1, 5000 * tentative);
    } else if (differes.length) {
      r.toast(
        "Réouverture impossible : " +
          differes.map(nom).join(", ") +
          ". Rouvrez-les depuis l’arbre quand l’environnement répond.",
        "warning",
      );
      differes = [];
      _schedulePersistTabs();
    }
  }

  /** Rouvre les onglets mémorisés du compte, en série ; les doublons déjà ouverts (par l'assistant) sont sautés. */
  async function restoreTabsFromStorage(): Promise<void> {
    if (!user.value || !user.value.id) return;
    if (!_tabsPersistEnabled()) {
      try {
        localStorage.removeItem(_tabsStorageKey());
      } catch {
        /* stockage bloqué */
      }
      return;
    }
    let saved: Partial<DonneesOnglets> | null;
    try {
      const brut = localStorage.getItem(_tabsStorageKey());
      if (!brut) return;
      saved = JSON.parse(brut) as Partial<DonneesOnglets> | null;
    } catch {
      return;
    }
    if (!saved || !Array.isArray(saved.paths) || saved.paths.length === 0) return;
    const chemins = saved.paths.filter((p): p is string => typeof p === "string");
    if (saved.positions && typeof saved.positions === "object") {
      for (const [p, pos] of Object.entries(saved.positions)) {
        if (pos && pos.line > 0) _pendingPositions[p] = pos;
      }
    }
    // Chaque ouverture rend son onglet actif : l'actif mémorisé est rendu s'il n'y en avait aucun avant la restauration.
    const actifAvant = activeTabPath.value;
    for (const p of chemins) {
      if (openTabs.value.some((t) => t.path === p)) continue;
      // Aperçu Office : onglet seulement, la conversion attendra son activation.
      if (r.modeVue(p) === "office") {
        openTabs.value.push({ path: p, name: nom(p) });
        continue;
      }
      try {
        await r.ouvrirFichier(p, false, { quiet: true });
      } catch {
        /* fichier disparu */
      }
    }
    differes = chemins.filter(
      (p) => !openTabs.value.some((t) => t.path === p) && refs.openTransientFail.has(p),
    );
    if (differes.length) {
      r.toast(
        differes.length +
          " onglet" +
          (differes.length > 1 ? "s" : "") +
          " en attente : réouverture dès que l’environnement répond.",
        "info",
      );
      planifierReprise(1, 4000);
    }
    // Purge immédiate des chemins morts (404) : plus jamais redemandés aux ouvertures suivantes.
    const vivants = new Set(openTabs.value.map((t) => t.path));
    const survivants = chemins.filter((p) => vivants.has(p) || differes.includes(p));
    if (Array.isArray(saved.pinned) && saved.pinned.length) {
      const epingles = new Set(saved.pinned);
      const tabs = openTabs.value.map((t) => (epingles.has(t.path) ? { ...t, pinned: true } : t));
      openTabs.value = tabs.filter((t) => t.pinned).concat(tabs.filter((t) => !t.pinned));
    }
    if (survivants.length !== chemins.length) {
      ecrire(_tabsStorageKey(), {
        paths: survivants,
        active: saved.active && vivants.has(saved.active) ? saved.active : null,
      });
    }
    if (saved.active && vivants.has(saved.active) && !actifAvant && activeTabPath.value !== saved.active) {
      try {
        await r.basculer(saved.active);
      } catch {
        /* onglet fermé entre-temps */
      }
    }
  }

  // Première ouverture de l'éditeur par un compte : ses onglets sont restaurés ; un changement de compte annule les reprises.
  watch(
    () => [refs.showEditor.value, user.value && user.value.id] as const,
    async ([visible, uid], avant) => {
      if (avant && avant[1] !== uid) {
        annulerReprise();
        differes = [];
      }
      if (visible && uid && uid !== derniereRestauration) {
        derniereRestauration = uid;
        await nextTick();
        await restoreTabsFromStorage();
      }
    },
  );

  /** Écriture finale à la fermeture de la page, seulement après la restauration de ce compte (sinon une liste vide l'écraserait). */
  function ecrireAvantFermeture(): void {
    if (minuterieEcriture) clearTimeout(minuterieEcriture);
    minuterieEcriture = null;
    const uid = user.value?.id;
    if (_tabsPersistEnabled() && uid && (openTabs.value.length || derniereRestauration === uid)) {
      ecrire(_tabsStorageKey(), _buildTabsData());
    }
  }

  // Pile des onglets fermés (LIFO, 20 au plus), alimentée par les disparitions de `openTabs`.
  const fermes: Array<{ path: string; name: string }> = [];
  let precedents: string[] = [];
  watch(
    openTabs,
    (cur) => {
      const actuels = cur.map((t) => t.path);
      for (const p of precedents) {
        if (actuels.includes(p)) continue;
        fermes.push({ path: p, name: nom(p) });
        if (fermes.length > MAX_FERMES) fermes.shift();
      }
      precedents = actuels.slice();
    },
    { deep: true },
  );
  async function reopenLastClosed(): Promise<void> {
    while (fermes.length > 0) {
      const dernier = fermes.pop() as { path: string };
      if (openTabs.value.some((t) => t.path === dernier.path)) continue;
      try {
        await r.ouvrirFichier(dernier.path, false);
        return;
      } catch {
        /* fichier disparu : le suivant */
      }
    }
    r.toast("Aucun onglet à ré-ouvrir");
  }

  /** Minuteries d'écriture et de reprise annulées (déconnexion, libération). */
  function libererMemoire(): void {
    if (minuterieEcriture) clearTimeout(minuterieEcriture);
    minuterieEcriture = null;
    annulerReprise();
    differes = [];
  }

  return {
    _tabsStorageKey,
    _tabsPersistEnabled,
    _pendingPositions,
    _buildTabsData,
    _schedulePersistTabs,
    restoreTabsFromStorage,
    ecrireAvantFermeture,
    reopenLastClosed,
    libererMemoire,
  };
}
