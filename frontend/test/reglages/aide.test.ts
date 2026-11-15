// SPDX-License-Identifier: MIT
/** frontend/test/reglages/aide.test.ts — chargement du guide de la fenêtre d'aide (une fois, repris après un échec, jamais doublé) et section ouverte selon l'écran en cours. */
import { ref } from "vue";
import { describe, expect, it } from "vitest";

import { BLOCS_AIDE, cleAide, creerAide } from "../../src/features/reglages/aide";
import type { CtxReglages, VueReglages } from "../../src/features/reglages/types";

function aide(reponses: (() => Response | Promise<Response>)[], contexteAide?: () => string) {
  let appels = 0;
  const fetchAuth = (): Promise<Response> => {
    const suivante = reponses[Math.min(appels++, reponses.length - 1)]!;
    return Promise.resolve(suivante());
  };
  const a = creerAide(
    { ref } as unknown as VueReglages,
    { fetchAuth, contexteAide } as unknown as CtxReglages,
  );
  return { a, appels: () => appels };
}

const guide = (texte: string) => (): Response =>
  new Response(JSON.stringify({ content: texte }), { headers: { "content-type": "application/json" } });
const panne = (): Response => new Response(JSON.stringify({ detail: "Aide indisponible" }), { status: 503 });

describe("chargement du guide", () => {
  it("chargé à la première ouverture, plus jamais ensuite ; la section demandée suit chaque ouverture", async () => {
    const { a, appels } = aide([guide("## Titre\n\nTexte.")]);
    await a.openHelp("routines");
    expect([
      a.showHelpModal.value,
      a.readmeContent.value,
      a.helpSection.value,
      a.isLoadingReadme.value,
    ]).toEqual([true, "## Titre\n\nTexte.", "routines", false]);
    a.showHelpModal.value = false;
    await a.openHelp();
    expect([appels(), a.helpSection.value, a.showHelpModal.value]).toEqual([1, "", true]);
  });

  it("un échec affiche un message sans détail et n'est pas gardé : l'ouverture suivante recharge", async () => {
    const { a, appels } = aide([panne, guide("## Titre")]);
    await a.openHelp();
    expect(a.readmeContent.value).toContain("Aide indisponible");
    expect(a.readmeContent.value).toContain("demandez à votre administrateur");
    expect(a.readmeContent.value).not.toMatch(/docs\/|\.md|503/);
    await a.openHelp();
    expect([appels(), a.readmeContent.value]).toEqual([2, "## Titre"]);
  });

  it("deux ouvertures pendant le chargement partagent la même requête ; une panne réseau vaut un échec", async () => {
    let liberer: (r: Response) => void = () => {};
    const { a, appels } = aide([() => new Promise<Response>((r) => (liberer = r))]);
    const un = a.openHelp("chat");
    const deux = a.openHelp("rag");
    expect([appels(), a.isLoadingReadme.value, a.helpSection.value]).toEqual([1, true, "rag"]);
    liberer(guide("## Titre")());
    await Promise.all([un, deux]);
    expect([appels(), a.readmeContent.value, a.isLoadingReadme.value]).toEqual([1, "## Titre", false]);
    const coupe = aide([() => Promise.reject(new Error("réseau"))]);
    await coupe.a.openHelp();
    expect(coupe.a.readmeContent.value).toContain("Aide indisponible");
  });
});

describe("section ouverte selon l'écran", () => {
  it("sans section demandée, l'aide s'ouvre sur celle de l'écran en cours, relue à chaque ouverture ; une section demandée l'emporte", async () => {
    let ecran = "routines";
    const { a } = aide([guide("## Titre")], () => ecran);
    await a.openHelp();
    expect(a.helpSection.value).toBe("routines");
    ecran = "rag";
    await a.openHelp(new MouseEvent("click"));
    expect(a.helpSection.value).toBe("rag");
    await a.openHelp("faq");
    expect(a.helpSection.value).toBe("faq");
  });

  it("chaque page a sa section ; le chat ouvre l'éditeur s'il est déployé, le chat en conversation, rien sur l'accueil", () => {
    expect(Object.keys(BLOCS_AIDE).sort()).toEqual(["agents", "code", "rag", "routines", "studio"]);
    expect(cleAide("routines", true, true)).toBe("routines");
    expect(cleAide("code", false, false)).toBe("remote");
    expect(cleAide("inconnue", false, true)).toBe("");
    expect(cleAide("chat", true, true)).toBe("editeur");
    expect(cleAide("chat", false, true)).toBe("chat");
    expect(cleAide("chat", false, false)).toBe("");
  });
});
