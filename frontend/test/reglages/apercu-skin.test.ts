// SPDX-License-Identifier: MIT
/** frontend/test/reglages/apercu-skin.test.ts — modale d'aperçu d'habillage : deux cadres isolés clair/sombre (un seul en darkBase), tableau des contrastes, repli sans artefact, import par clic. */
import { createApp, nextTick } from "vue";
import type { App } from "vue";
import { afterEach, describe, expect, it } from "vitest";

import ApercuSkin from "../../src/components/reglages/ApercuSkin.vue";
import {
  apercuSkin,
  configurerSkinsPerso,
  fermerApercuSkin,
  oublierArtefactApercu,
  ouvrirApercuSkin,
} from "../../src/features/reglages/skins-perso";
import type { CorpsPerso, RapportPerso } from "@elpis/contracts";
import { json } from "../aides";

const MAQUETTE = '<html><style id="elpis-jetons"></style><body class="elpis-skin-perso"></body></html>';
const RAPPORT: RapportPerso = {
  ok: false,
  erreurs: ["Contraste insuffisant"],
  avertissements: ["darkBase : ignoré"],
  contrastes: [
    { paire: "--text-900 / --surface", mode: "light", ratio: 2, seuil: 4.5, ok: false },
    { paire: "--accent / --surface", mode: "dark", ratio: 5, seuil: 3, ok: true },
  ],
  css: "body.elpis-skin-perso{}",
};
const SKIN = {
  id: "a-b",
  label: "Mon style",
  desc: "",
  darkBase: false,
  sw: [],
  builtin: false,
  perso: true,
  css_url: "/x",
};
const CORPS = { id: "a-b", label: "Mon style", tokens: {} } as unknown as CorpsPerso;

let app: App | null = null;
let hote: HTMLElement | null = null;
let urls: string[] = [];

function monter(reponse: () => Response | null): void {
  urls = [];
  configurerSkinsPerso(async (url) => {
    urls.push(url);
    return reponse();
  });
  hote = document.createElement("div");
  document.body.appendChild(hote);
  app = createApp(ApercuSkin);
  app.mount(hote);
}
const attendre = async (): Promise<void> => {
  for (let i = 0; i < 4; i++) {
    await new Promise((r) => setTimeout(r, 0));
    await nextTick();
  }
};

afterEach(() => {
  oublierArtefactApercu();
  fermerApercuSkin();
  app?.unmount();
  hote?.remove();
  app = null;
  document.body.innerHTML = "";
});

describe("ApercuSkin", () => {
  it("fermée par défaut", () => {
    monter(() => null);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it("deux cadres isolés, contrastes et listes rendus par l'application", async () => {
    monter(() => json({ id: "apparence", path: "assets/apercu.html", content: MAQUETTE }));
    ouvrirApercuSkin(CORPS, RAPPORT);
    await attendre();
    const cadres = document.querySelectorAll("iframe");
    expect(cadres.length).toBe(2);
    for (const c of cadres) expect(c.getAttribute("sandbox")).toBe("allow-scripts");
    expect(urls[0]).toContain("/api/skills/file?id=apparence&path=assets/apercu.html&scope=global");
    const texte = document.body.textContent ?? "";
    expect(texte).toContain("Mon style");
    expect(texte).toContain("Contraste insuffisant");
    expect(texte).toContain("2:1 ✗");
    expect(texte).toContain("5:1 ✓");
    const boutons = [...document.querySelectorAll("button")];
    expect(boutons.find((b) => b.textContent?.trim() === "Importer")?.disabled).toBe(true);
  });

  it("darkBase : un seul cadre", async () => {
    monter(() => json({ content: MAQUETTE }));
    ouvrirApercuSkin({ ...CORPS, darkBase: true }, { ...RAPPORT, ok: true, erreurs: [] });
    await attendre();
    expect(document.querySelectorAll("iframe").length).toBe(1);
    const importer = [...document.querySelectorAll("button")].find(
      (b) => b.textContent?.trim() === "Importer",
    );
    expect(importer?.disabled).toBe(false);
  });

  it("artefact introuvable : repli sans cadre, rapport conservé", async () => {
    monter(() => json({ detail: "fichier introuvable" }, 404));
    ouvrirApercuSkin(CORPS, RAPPORT);
    await attendre();
    expect(document.querySelectorAll("iframe").length).toBe(0);
    expect(document.body.textContent).toContain("Maquette d'aperçu introuvable");
    expect(document.body.textContent).toContain("Contraste insuffisant");
  });

  it("habillage enregistré : pas de boutons d'import", async () => {
    monter(() => json({ content: MAQUETTE }));
    apercuSkin.value = { nom: "Déjà là", darkBase: false, pastilles: [], css: "a{}" };
    await attendre();
    expect(document.querySelectorAll("iframe").length).toBe(2);
    expect([...document.querySelectorAll("button")].some((b) => b.textContent?.includes("Importer"))).toBe(
      false,
    );
  });

  it("Remplacer l'existant garde l'option « appliquer »", async () => {
    const corps: string[] = [];
    let n = 0;
    monter(() => json({ content: MAQUETTE }));
    configurerSkinsPerso(async (url, init) => {
      if (url !== "/api/skins/perso") return json({ content: MAQUETTE });
      corps.push(String(init?.body));
      return n++ === 0
        ? json({ detail: "L'habillage « a-b » existe déjà." }, 409)
        : json({ ok: true, remplace: true, skin: SKIN, rapport: RAPPORT });
    });
    ouvrirApercuSkin(CORPS, { ...RAPPORT, erreurs: [] });
    await attendre();
    const clic = (t: string): void =>
      (
        [...document.querySelectorAll("button")].find((b) => b.textContent?.includes(t)) as HTMLElement
      ).click();
    clic("Importer et appliquer");
    await attendre();
    clic("Remplacer l'existant");
    await attendre();
    expect(JSON.parse(corps[1] ?? "{}").overwrite).toBe(true);
    expect(document.body.textContent).toContain("Habillage remplacé, mais non appliqué.");
  });
});
