// SPDX-License-Identifier: MIT
/** frontend/test/secrets/sites.test.ts — éditeur de sites d'un secret : ajout, retrait, URL ramenée à son origine, ligne invalide, http accepté, corps envoyé ; la table montre tous les sites. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp, defineComponent, h, nextTick, reactive } from "vue";
import type { App } from "vue";

import FormulaireSecret from "../../src/components/secrets/FormulaireSecret.vue";
import TableSecrets from "../../src/components/secrets/TableSecrets.vue";
import { creerGestionSecrets, fournirSecrets } from "../../src/features/secrets/gestion";
import { fauxServeur, json, secret } from "./aides";

let app: App | null = null;
afterEach(() => {
  app?.unmount();
  app = null;
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

const attendre = async (): Promise<void> => {
  for (let i = 0; i < 4; i++) await nextTick();
  await new Promise((r) => setTimeout(r, 0));
  await nextTick();
};

const SITES = ["https://a.example.lan", "http://app.lan:8080", "https://c.example.lan:8443"];

function monter(composant: unknown, liste = [secret(1, { name: "multi", scope: { origins: SITES } })]) {
  vi.stubGlobal("CSS", { supports: () => true });
  const { api, appels } = fauxServeur((_u, m, corps) =>
    m === "GET" ? json({ secrets: liste }) : json({ secret: { ...liste[0]!, ...(corps as object) } }),
  );
  const g = reactive(creerGestionSecrets({ api, portee: "compte", toast: () => {}, maintenant: () => 0 }));
  const hote = document.createElement("div");
  document.body.appendChild(hote);
  app = createApp(
    defineComponent({
      setup() {
        fournirSecrets(g);
        return () => h(composant as never);
      },
    }),
  );
  app.mount(hote);
  return { g, hote, appels };
}

const champs = (hote: HTMLElement): HTMLInputElement[] => [
  ...hote.querySelectorAll<HTMLInputElement>("[data-sites] input[data-site-cle]"),
];
async function saisir(champ: HTMLInputElement, v: string, evt = "input"): Promise<void> {
  champ.value = v;
  champ.dispatchEvent(new Event("input"));
  if (evt === "change") champ.dispatchEvent(new Event("change"));
  await attendre();
}

describe("éditeur de sites", () => {
  async function creation() {
    const m = monter(defineComponent({ render: () => h(FormulaireSecret, { mode: "creation" }) }), []);
    await m.g.charger();
    m.g.nouveau();
    await attendre();
    return m;
  }

  it("une ligne vide au départ ; ajouter et retirer des sites, étiquettes accessibles", async () => {
    const { hote } = await creation();
    expect(champs(hote)).toHaveLength(1);
    expect(hote.querySelector<HTMLButtonElement>("[data-retirer-site]")!.disabled).toBe(true);
    hote.querySelector<HTMLButtonElement>("[data-ajouter-site]")!.click();
    await attendre();
    expect(champs(hote)).toHaveLength(2);
    expect(champs(hote).map((c) => c.getAttribute("aria-label"))).toEqual(["Site 1", "Site 2"]);
    await saisir(champs(hote)[0]!, "http://app.lan:8080");
    expect(hote.querySelector("[data-retirer-site]")!.getAttribute("aria-label")).toBe(
      "Retirer le site http://app.lan:8080",
    );
    hote.querySelector<HTMLButtonElement>("[data-retirer-site]")!.click();
    await attendre();
    expect(champs(hote)).toHaveLength(1);
  });

  it("une URL complète est ramenée à son origine, avec une note visible", async () => {
    const { hote } = await creation();
    await saisir(champs(hote)[0]!, "http://app.lan:8080/login?x=1#a", "change");
    expect(champs(hote)[0]!.value).toBe("http://app.lan:8080");
    expect(hote.querySelector("[data-sites] [role=status]")?.textContent).toContain(
      "Adresse réduite à son origine : http://app.lan:8080",
    );
    expect(champs(hote)[0]!.getAttribute("aria-invalid")).toBeNull();
  });

  it("une ligne invalide porte son erreur ; http et https sont valides", async () => {
    const { hote } = await creation();
    await saisir(champs(hote)[0]!, "app.lan:8080");
    expect(champs(hote)[0]!.getAttribute("aria-invalid")).toBe("true");
    expect(hote.querySelector("[data-sites]")?.textContent).toContain("Commencez par http:// ou https://");
    await saisir(champs(hote)[0]!, "ftp://x.lan");
    expect(champs(hote)[0]!.getAttribute("aria-invalid")).toBe("true");
    await saisir(champs(hote)[0]!, "http://app.lan");
    expect(champs(hote)[0]!.getAttribute("aria-invalid")).toBeNull();
    await saisir(champs(hote)[0]!, "https://app.lan");
    expect(champs(hote)[0]!.getAttribute("aria-invalid")).toBeNull();
  });

  it("plusieurs sites envoyés tels quels à la création, vides ignorés", async () => {
    const { hote, appels } = await creation();
    hote.querySelector<HTMLButtonElement>("[data-ajouter-site]")!.click();
    hote.querySelector<HTMLButtonElement>("[data-ajouter-site]")!.click();
    await attendre();
    await saisir(champs(hote)[0]!, "http://app.lan:8080");
    await saisir(champs(hote)[1]!, "https://b.example.lan/x", "change");
    const f = hote.querySelector<HTMLFormElement>("[data-formulaire-secret]")!;
    const val = (n: string, v: string): void => {
      const e = f.querySelector<HTMLInputElement>(`[data-champ="${n}"]`)!;
      e.value = v;
      e.dispatchEvent(new Event("input"));
    };
    val("name", "multi-web");
    val("value", "s3");
    await attendre();
    f.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await attendre();
    const corps = appels.at(-1)!.corps as { scope: { origins: string[] } };
    expect(corps.scope.origins).toEqual(["http://app.lan:8080", "https://b.example.lan"]);
  });

  it("édition : les sites existants sont repris, en ajouter un exige la valeur", async () => {
    const { hote, g } = monter(TableSecrets);
    await g.charger();
    await attendre();
    g.choisir(1, "modifier");
    await attendre();
    expect(champs(hote).map((c) => c.value)).toEqual(SITES);
    hote.querySelector<HTMLButtonElement>("[data-ajouter-site]")!.click();
    await attendre();
    await saisir(champs(hote)[3]!, "http://nouveau.lan");
    expect(hote.querySelector("[data-panneau]")?.textContent).toContain("valeur requise");
  });
});

describe("table", () => {
  it("montre tous les sites en pastilles, dans la ligne et dans le panneau de vérification", async () => {
    const { hote, g } = monter(TableSecrets, [
      secret(1, { name: "multi", state: "unverified", scope: { origins: SITES } }),
    ]);
    await g.charger();
    await attendre();
    const ligne = hote.querySelector<HTMLElement>('tr[data-secret="multi"]')!;
    expect([...ligne.querySelectorAll(".elpis-secrets__site")].map((e) => e.textContent?.trim())).toEqual(
      SITES,
    );
    expect(ligne.textContent).not.toMatch(/\+\d/u);
    g.choisir(1, "verifier");
    await attendre();
    const panneau = hote.querySelector<HTMLElement>("[data-panneau]")!;
    expect([...panneau.querySelectorAll(".elpis-secrets__site")].map((e) => e.textContent?.trim())).toEqual(
      SITES,
    );
  });
});
