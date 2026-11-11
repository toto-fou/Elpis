// SPDX-License-Identifier: MIT
/** frontend/test/editor/modeles.test.ts — registre des modèles Monaco : URI stable, modèle partagé jamais réécrit, libération détachée des éditeurs, 50 cycles sans modèle restant. */
import { describe, expect, it } from "vitest";

import { RegistreModeles, cheminUri } from "../../src/features/editor/modeles";
import type { EditeursAttaches, MonacoModeles } from "../../src/features/editor/modeles";

class Modele {
  libere = false;
  texte: string;
  uri: string | null;
  readonly monde: FauxMonaco;
  constructor(texte: string, uri: string | null, monde: FauxMonaco) {
    this.texte = texte;
    this.uri = uri;
    this.monde = monde;
  }
  isDisposed(): boolean {
    return this.libere;
  }
  dispose(): void {
    this.libere = true;
    if (this.uri) this.monde.parUri.delete(this.uri);
  }
  getValue(): string {
    return this.texte;
  }
}

class FauxMonaco implements MonacoModeles<Modele> {
  readonly parUri = new Map<string, Modele>();
  crees = 0;
  Uri = {
    parse: (v: string): string => {
      if (v.includes("\u0000")) throw new Error("UriError");
      return v;
    },
  };
  editor = {
    getModel: (uri: unknown): Modele | null => this.parUri.get(String(uri)) ?? null,
    createModel: (texte: string, _langue: string, uri?: unknown): Modele => {
      this.crees++;
      const m = new Modele(texte, uri === undefined ? null : String(uri), this);
      if (uri !== undefined) this.parUri.set(String(uri), m);
      return m;
    },
  };
}

class Editeur {
  modele: unknown = null;
  getModel(): unknown {
    return this.modele;
  }
  setModel(m: null): void {
    this.modele = m;
  }
}

function registre() {
  const monaco = new FauxMonaco();
  const ecritures: string[] = [];
  const editeurs: EditeursAttaches = { instance: new Editeur(), instance2: new Editeur(), diff: null };
  const r = new RegistreModeles<Modele>({
    monaco: () => monaco,
    langue: () => "plaintext",
    ecrire: (m, t) => {
      ecritures.push(t);
      m.texte = t;
    },
    editeurs: () => editeurs,
  });
  return { monaco, ecritures, editeurs, r };
}

describe("RegistreModeles", () => {
  it("normalise l'URI (barres en tête et doubles) et rend le même modèle pour la même clé", () => {
    expect(cheminUri("//a//b.py")).toBe("/a/b.py");
    const { r, monaco } = registre();
    const m = r.assurer("/a//b.py", "x");
    expect(m).not.toBeNull();
    expect(monaco.parUri.has("personal:///a/b.py")).toBe(true);
    expect(r.assurer("/a//b.py", "autre")).toBe(m);
    expect(m?.texte).toBe("x");
  });

  it("un modèle tenu par une autre graphie est partagé sans être réécrit ; un orphelin est réaligné", () => {
    const { r, ecritures, monaco } = registre();
    const m = r.assurer("a/b.py", "tampon modifié");
    expect(r.assurer("/a/b.py", "disque")).toBe(m);
    expect(ecritures).toEqual([]);
    const orphelin = monaco.editor.createModel("ancien", "plaintext", "personal:///c.py");
    expect(r.assurer("c.py", "nouveau")).toBe(orphelin);
    expect(ecritures).toEqual(["nouveau"]);
  });

  it("URI refusée : repli sur une URI en mémoire", () => {
    const { r } = registre();
    const m = r.assurer("a\u0000.py", "x");
    expect(m?.uri?.startsWith("inmemory://model/")).toBe(true);
  });

  it("libérer détache le modèle des éditeurs avant de le libérer", () => {
    const { r, editeurs } = registre();
    const m = r.assurer("a.py", "x");
    (editeurs.instance as Editeur).modele = m;
    (editeurs.instance2 as Editeur).modele = m;
    r.liberer("a.py");
    expect(m?.isDisposed()).toBe(true);
    expect(editeurs.instance?.getModel()).toBeNull();
    expect(editeurs.instance2?.getModel()).toBeNull();
    expect(r.ok("a.py")).toBe(false);
    expect(r.taille).toBe(0);
  });

  it("50 cycles d'ouverture et de fermeture de 5 onglets : aucun modèle restant, ni dans le registre ni dans Monaco", () => {
    const { r, monaco } = registre();
    for (let i = 0; i < 50; i++) {
      for (let k = 0; k < 5; k++) r.assurer(`f${k}.py`, `v${i}`);
      expect(r.taille).toBe(5);
      if (i % 2) r.libererTout();
      else for (let k = 0; k < 5; k++) r.liberer(`f${k}.py`);
      expect(r.taille).toBe(0);
      expect(monaco.parUri.size).toBe(0);
    }
    expect(monaco.crees).toBe(250);
  });
});
