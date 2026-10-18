// SPDX-License-Identifier: MIT
/** frontend/src/features/editor/modeles.ts — registre des modèles Monaco de l'éditeur : création (URI stable par chemin), partage d'un modèle existant, libération (détaché des éditeurs puis `dispose`). */
import { markRaw } from "vue";

export interface ModeleRegistre {
  isDisposed(): boolean;
  dispose(): void;
  getValue(): string;
}

interface Editeur {
  getModel(): unknown;
  setModel(m: null): void;
}

interface EditeurDiff {
  getModel(): { original: unknown; modified: unknown } | null;
  setModel(m: null): void;
}

export interface EditeursAttaches {
  instance: Editeur | null;
  instance2: Editeur | null;
  diff: EditeurDiff | null;
}

export interface MonacoModeles<M extends ModeleRegistre> {
  Uri: { parse(valeur: string): unknown };
  editor: {
    getModel(uri: unknown): M | null;
    createModel(texte: string, langue: string, uri?: unknown): M;
  };
}

export interface DepsRegistre<M extends ModeleRegistre> {
  monaco(): MonacoModeles<M>;
  langue(chemin: string): string;
  ecrire(modele: M, texte: string): void;
  editeurs(): EditeursAttaches;
}

/** Schéma historique (`personal://`) gardé : les URI des modèles déjà créés restent les mêmes. */
const SCHEMA = "personal://";

/** `/` en tête et barres obliques uniques : `Uri.parse` refuse un chemin commençant par `//`. */
export function cheminUri(chemin: string): string {
  return (
    "/" +
    String(chemin)
      .replace(/^\/+/, "")
      .replace(/\/{2,}/g, "/")
  );
}

export class RegistreModeles<M extends ModeleRegistre> {
  /** Chemin (tel que reçu, non normalisé) → modèle ; lu directement par les scripts historiques. */
  readonly table: Record<string, M> = {};
  readonly #deps: DepsRegistre<M>;

  constructor(deps: DepsRegistre<M>) {
    this.#deps = deps;
  }

  get taille(): number {
    return Object.keys(this.table).length;
  }

  ok(chemin: string): boolean {
    const m = this.table[chemin];
    return !!m && !m.isDisposed();
  }

  /** Détache le modèle des éditeurs qui l'affichent puis le libère. */
  liberer(chemin: string): void {
    const m = this.table[chemin];
    if (!m) return;
    try {
      const { instance, instance2, diff } = this.#deps.editeurs();
      if (instance && instance.getModel() === m) instance.setModel(null);
      const dm = diff ? diff.getModel() : null;
      if (diff && dm && (dm.original === m || dm.modified === m)) diff.setModel(null);
      if (instance2 && instance2.getModel() === m) instance2.setModel(null);
      if (!m.isDisposed()) m.dispose();
    } catch {
      /* éditeur déjà libéré */
    }
    delete this.table[chemin];
  }

  libererTout(): void {
    for (const chemin of Object.keys(this.table)) this.liberer(chemin);
  }

  /** Modèle du chemin, créé au besoin ; un modèle déjà présent à cette URI est partagé (jamais réécrit s'il appartient à une autre clé). */
  assurer(chemin: string, contenu?: unknown, langue?: string): M | null {
    const present = this.table[chemin];
    if (present && present.isDisposed()) delete this.table[chemin];
    else if (present) return present;
    const monaco = this.#deps.monaco();
    const texte = typeof contenu === "string" ? contenu : "";
    let uri: unknown;
    try {
      uri = monaco.Uri.parse(SCHEMA + cheminUri(chemin));
    } catch {
      try {
        uri = monaco.Uri.parse(`inmemory://model/${Date.now()}-${Math.random().toString(36).slice(2, 10)}`);
      } catch {
        return null;
      }
    }
    let existant: M | null = null;
    try {
      existant = monaco.editor.getModel(uri);
    } catch {
      existant = null;
    }
    if (existant && !existant.isDisposed()) {
      const possede = Object.keys(this.table).some((k) => k !== chemin && this.table[k] === existant);
      if (!possede && typeof contenu === "string" && existant.getValue() !== contenu) {
        this.#deps.ecrire(existant, contenu);
      }
      this.table[chemin] = existant;
      return existant;
    }
    const lang = langue || this.#deps.langue(chemin);
    let modele: M;
    try {
      modele = monaco.editor.createModel(texte, lang, uri);
    } catch {
      try {
        modele = monaco.editor.createModel(texte, lang);
      } catch {
        return null;
      }
    }
    this.table[chemin] = markRaw(modele);
    return modele;
  }
}
