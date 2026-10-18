// SPDX-License-Identifier: MIT
/** frontend/src/features/editor/secours.ts — tampons non enregistrés mis de côté par compte à la fin de session (ou à la désactivation de l'éditeur) et proposés à la prochaine ouverture ; l'enregistrement repasse par la précondition disque habituelle. */
import { watch } from "vue";
import type { Ref } from "vue";

const PREFIXE = "elpis.editor.rescue.";
const MAX_CARACTERES = 3 * 1024 * 1024;

export interface TamponSecours {
  path: string;
  content: string;
  sha: string | null;
  mtime: number | null;
  bom: boolean;
  ts: number;
}

export interface ModeleTexte {
  getValue(): string;
}

export interface RefsSecours<Mo extends ModeleTexte = ModeleTexte> {
  user: Ref<{ username?: string; [cle: string]: unknown } | null>;
  openTabs: Ref<Array<{ path: string }>>;
  activeTabPath: Ref<string | null>;
  isEditorDirty: Ref<boolean>;
  readonly modeles: { ok(chemin: string): boolean; table: Record<string, Mo> };
  readonly fileShas: Record<string, string>;
  readonly fileMtimes: Ref<Record<string, number>>;
  readonly fileFormats: Record<string, { bom: boolean }>;
}

export interface RappelsSecours<Mo extends ModeleTexte = ModeleTexte> {
  estModifie(chemin: string): boolean;
  lectureSeule(chemin: string): boolean;
  ouvrirFichier(chemin: string): Promise<unknown>;
  editionMinimale(modele: Mo, ancien: string, nouveau: string): unknown;
  poserBase(chemin: string, mtime: number | null, sha: string | null): void;
  confirmer(titre: string, texte: string): Promise<boolean>;
  rafraichirModifies(): void;
  toast(message: string): void;
}

function lireListe(cle: string): unknown[] {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(cle) || "[]");
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function estTampon(x: unknown): x is TamponSecours {
  const t = x as Partial<TamponSecours> | null;
  return !!t && typeof t.path === "string" && typeof t.content === "string";
}

export function setupEditorRescue<Mo extends ModeleTexte>(refs: RefsSecours<Mo>, r: RappelsSecours<Mo>) {
  let proprietaire: string | null = null;
  let verifie = false;
  watch(
    () => refs.user.value && refs.user.value.username,
    (u) => {
      if (u) {
        proprietaire = u;
        verifie = false;
      }
    },
    { immediate: true },
  );

  /** Copie les onglets modifiés (3 Mo au plus) sous la clé du compte, avec la base disque sur laquelle ils reposent. */
  function rescueDirtyBuffers(): number {
    const compte = proprietaire;
    if (!compte) return 0;
    const tampons: TamponSecours[] = [];
    let total = 0;
    for (const t of refs.openTabs.value) {
      const p = t.path;
      const m = refs.modeles.table[p];
      if (!m || !refs.modeles.ok(p) || r.lectureSeule(p) || !r.estModifie(p)) continue;
      const content = m.getValue();
      if (total + content.length > MAX_CARACTERES) continue;
      total += content.length;
      const mt = refs.fileMtimes.value[p];
      tampons.push({
        path: p,
        content,
        sha: refs.fileShas[p] || null,
        mtime: typeof mt === "number" ? mt : null,
        bom: !!refs.fileFormats[p]?.bom,
        ts: Date.now(),
      });
    }
    if (!tampons.length) return 0;
    try {
      const cle = PREFIXE + compte;
      const gardes = lireListe(cle).filter((x) => !tampons.some((i) => estTampon(x) && i.path === x.path));
      localStorage.setItem(cle, JSON.stringify(gardes.concat(tampons)));
      verifie = false;
      return tampons.length;
    } catch {
      return 0;
    }
  }

  /** À l'ouverture par le même compte : proposition unique de restauration (la clé est vidée dans tous les cas). */
  async function _maybeRestoreRescued(): Promise<void> {
    if (verifie || !proprietaire || !refs.user.value) return;
    verifie = true;
    const cle = PREFIXE + proprietaire;
    const tampons = lireListe(cle);
    if (!tampons.length) return;
    const noms = tampons.map((i) => (estTampon(i) ? (i.path.split("/").pop() ?? i.path) : "?")).join(", ");
    const ok = await r.confirmer(
      "Modifications non enregistrées",
      tampons.length +
        " fichier(s) n'étaient pas enregistrés quand la session s'est fermée : " +
        noms +
        ". Les restaurer ?",
    );
    try {
      localStorage.removeItem(cle);
    } catch {
      /* stockage bloqué */
    }
    if (!ok) return;
    let n = 0;
    for (const it of tampons) {
      if (!estTampon(it)) continue;
      try {
        await r.ouvrirFichier(it.path);
      } catch {
        continue;
      }
      const m = refs.modeles.table[it.path];
      if (!m || !refs.modeles.ok(it.path)) continue;
      if (m.getValue() !== it.content) r.editionMinimale(m, m.getValue(), it.content);
      // Base = la version disque sur laquelle ces modifications reposent : un disque changé depuis donne un conflit.
      r.poserBase(it.path, it.mtime, it.sha);
      const f = refs.fileFormats[it.path];
      if (f) f.bom = !!it.bom;
      n++;
    }
    r.rafraichirModifies();
    if (refs.activeTabPath.value) refs.isEditorDirty.value = r.estModifie(refs.activeTabPath.value);
    if (n) r.toast(n + " fichier(s) restauré(s) — non enregistrés");
  }

  return { rescueDirtyBuffers, _maybeRestoreRescued };
}
