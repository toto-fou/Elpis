// SPDX-License-Identifier: MIT
/** frontend/test/editor/faux-modele.ts — modèle texte Monaco minimal pour les tests (plages, opérations comptées). */
import type { ModeleEditable } from "../../src/features/editor/ecriture-modele";
import type { PlageEdition } from "../../src/utils/minimal-edit";

/** Modèle texte minimal : applique les plages Monaco (lignes et colonnes à partir de 1) et compte les `setValue`. */
export class FauxModele implements ModeleEditable {
  texte: string;
  setValues = 0;
  operations = 0;
  libere = false;
  constructor(texte: string) {
    this.texte = texte;
  }
  getValue(): string {
    return this.texte;
  }
  setValue(t: string): void {
    this.setValues++;
    this.texte = t;
  }
  isDisposed(): boolean {
    return this.libere;
  }
  getFullModelRange(): PlageEdition {
    const lignes = this.texte.split("\n");
    return {
      startLineNumber: 1,
      startColumn: 1,
      endLineNumber: lignes.length,
      endColumn: (lignes[lignes.length - 1] ?? "").length + 1,
    };
  }
  private decalage(ligne: number, col: number): number {
    const lignes = this.texte.split("\n");
    let n = 0;
    for (let i = 0; i < ligne - 1; i++) n += (lignes[i] ?? "").length + 1;
    return n + col - 1;
  }
  pushEditOperations(_s: [], ops: Array<{ range: PlageEdition; text: string }>): null {
    for (const { range, text } of ops) {
      this.operations++;
      const a = this.decalage(range.startLineNumber, range.startColumn);
      const b = this.decalage(range.endLineNumber, range.endColumn);
      this.texte = this.texte.slice(0, a) + text + this.texte.slice(b);
    }
    return null;
  }
}
