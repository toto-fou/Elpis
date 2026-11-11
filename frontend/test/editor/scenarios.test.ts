// SPDX-License-Identifier: MIT
/** frontend/test/editor/scenarios.test.ts — scénarios de l'éditeur : multi-onglets, modification externe rechargée, sauvegarde retardée face à une version plus récente, cycles ouverture/fermeture. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { remplacerContenu } from "../../src/features/editor/ecriture-modele";
import { ServiceSauvegarde } from "../../src/features/editor/sauvegarde";
import { FauxModele } from "./faux-modele";

function editeur() {
  const modeles = new Map<string, FauxModele>();
  const disque = new Map<string, string>();
  const ecritures: string[] = [];
  const service = new ServiceSauvegarde({
    lire: (c) => {
      const m = modeles.get(c);
      return m && !m.libere ? { texte: m.getValue(), version: m.operations } : null;
    },
    ecrire: (c, t) => {
      ecritures.push(`${c}=${t}`);
      disque.set(c, t);
      return Promise.resolve(true);
    },
    enregistre: () => undefined,
  });
  const ouvrir = (c: string, t: string): FauxModele => {
    const m = new FauxModele(t);
    modeles.set(c, m);
    return m;
  };
  const fermer = (c: string): void => {
    const m = modeles.get(c);
    if (m) m.libere = true;
    modeles.delete(c);
    service.oublier(c);
  };
  return { modeles, disque, ecritures, service, ouvrir, fermer };
}

describe("scénarios de l'éditeur", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("multi-onglets : chaque frappe retardée écrit son propre fichier, même après changement d'onglet", async () => {
    const e = editeur();
    const a = e.ouvrir("a.py", "a");
    const b = e.ouvrir("b.py", "b");
    remplacerContenu(a, "a1");
    e.service.planifier("left", "a.py", 30_000);
    remplacerContenu(b, "b1");
    await e.service.vider("left");
    e.service.planifier("left", "b.py", 30_000);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(e.ecritures).toEqual(["a.py=a1", "b.py=b1"]);
  });

  it("modification externe rechargée par opérations d'édition : la sauvegarde retardée n'écrit jamais l'ancien tampon", async () => {
    const e = editeur();
    const a = e.ouvrir("a.py", "v1");
    remplacerContenu(a, "v2");
    await e.service.sauvegarder("a.py");
    e.service.planifier("left", "a.py", 30_000);
    remplacerContenu(a, "disque externe");
    expect(a.setValues).toBe(0);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(e.disque.get("a.py")).toBe("disque externe");
    await expect(e.service.sauvegarder("a.py")).resolves.toBe("a-jour");
  });

  it("cycles ouverture/fermeture : un fichier fermé n'a plus de retard ni d'état, sa réouverture écrit à nouveau", async () => {
    const e = editeur();
    for (let n = 0; n < 5; n++) {
      const m = e.ouvrir("a.py", "x");
      remplacerContenu(m, "x" + n);
      e.service.planifier("left", "a.py", 30_000);
      e.fermer("a.py");
      expect(e.service.cheminRetarde("left")).toBeNull();
    }
    expect(vi.getTimerCount()).toBe(0);
    const m = e.ouvrir("a.py", "y");
    remplacerContenu(m, "y1");
    await expect(e.service.sauvegarder("a.py")).resolves.toBe("enregistre");
    expect(e.ecritures).toEqual(["a.py=y1"]);
  });
});
