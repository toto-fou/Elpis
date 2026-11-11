// SPDX-License-Identifier: MIT
/** frontend/test/secrets/table.test.ts — Paramètres › Secrets et table partagée avec la console : colonnes, états (unverified, autre clé), détails visibles en largeur étroite, menu ⋯ au clavier selon le genre, rotation, vérification (git compris), suppression confirmée par le même bouton et annoncée hors du menu, focus rendu, valeurs masquées hors des gestionnaires de mots de passe, formulaire de création vérifié à la frappe. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, defineComponent, h, nextTick, reactive } from "vue";
import type { App, Component } from "vue";

import OngletSecrets from "../../src/components/reglages/onglets/OngletSecrets.vue";
import TableSecrets from "../../src/components/secrets/TableSecrets.vue";
import { CLE_REGLAGES } from "../../src/features/reglages/domaine";
import type { DomaineReglages } from "../../src/features/reglages/domaine";
import { creerGestionSecrets, fournirSecrets } from "../../src/features/secrets/gestion";
import type { PorteeCoffre } from "../../src/features/secrets/api";
import { fauxServeur, json, secret } from "./aides";

let app: App | null = null;
beforeEach(() => {
  vi.stubGlobal("CSS", { supports: (p: string) => p === "-webkit-text-security" });
});
afterEach(() => {
  app?.unmount();
  app = null;
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

const LISTE = [
  secret(1, {
    name: "intranet-admin",
    scope: { origins: ["https://intranet.example.lan:8443", "https://idp.example.lan"] },
    use_count: 3,
    last_used_at: Date.now() / 1000 - 120,
    version: 2,
  }),
  secret(2, { name: "ax-old", kind: "http-auth", state: "unverified", key_current: false }),
  secret(3, { name: "gitlab", kind: "git", scope: { host: "gitlab.lan" }, username: null }),
  secret(4, { name: "mcp-srv", kind: "mcp", scope: { server: "srv-1" }, username: null }),
  secret(5, {
    name: "sandbox-git",
    kind: "git",
    state: "unverified",
    scope: { host: "git.lan" },
    username: null,
  }),
];

const attendre = async (): Promise<void> => {
  for (let i = 0; i < 4; i++) await nextTick();
  await new Promise((r) => setTimeout(r, 0));
  await nextTick();
};

function store(portee: PorteeCoffre = "compte", horloge = { t: 0 }) {
  const { api, appels } = fauxServeur((url, methode, corps) => {
    if (methode === "GET") return json({ secrets: LISTE });
    if (methode === "DELETE") return json({ ok: true });
    if (url.endsWith("/verify")) return json({ secret: { ...LISTE[1]!, state: "active" } });
    if (url.endsWith("/rotate")) return json({ secret: { ...LISTE[0]!, version: 3 } });
    return json({ secret: secret(9, { name: (corps as { name: string }).name }) });
  });
  const toasts: string[] = [];
  const g = reactive(
    creerGestionSecrets({ api, portee, toast: (m) => toasts.push(m), maintenant: () => horloge.t }),
  );
  return { g, appels, toasts };
}

/** Monte un composant ; la table reçoit son domaine, l'onglet le domaine des réglages qui le porte. */
function monter(composant: Component, g: ReturnType<typeof store>["g"], reglages = false): HTMLElement {
  const hote = document.createElement("div");
  document.body.appendChild(hote);
  app = createApp(
    defineComponent({
      setup() {
        if (!reglages) fournirSecrets(g);
        return () => h(composant);
      },
    }),
  );
  if (reglages) app.provide(CLE_REGLAGES, { secretsCompte: g } as unknown as DomaineReglages);
  app.mount(hote);
  return hote;
}
const monterTable = (g: ReturnType<typeof store>["g"]): HTMLElement => monter(TableSecrets, g);

const soumettre = (f: HTMLFormElement): boolean =>
  f.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
const ligne = (hote: HTMLElement, nom: string): HTMLElement =>
  hote.querySelector<HTMLElement>(`tr[data-secret="${nom}"]`)!;
const cellules = (tr: HTMLElement): string[] =>
  [...tr.querySelectorAll("td")].map((td) => (td.textContent ?? "").replace(/\s+/g, " ").trim());
const etiquettes = (tr: HTMLElement): string[] =>
  [...tr.querySelectorAll(".elpis-secrets__nom, .elpis-secrets__etat")].map((e) =>
    (e.textContent ?? "").trim(),
  );
const entrees = (hote: HTMLElement): string[] =>
  [...hote.querySelectorAll('[role="menu"] [role="menuitem"]')].map((b) => (b.textContent ?? "").trim());

async function ouvrirMenu(hote: HTMLElement, nom: string): Promise<void> {
  ligne(hote, nom).querySelector<HTMLButtonElement>("[aria-haspopup=menu]")!.click();
  await attendre();
}

describe("table des secrets", () => {
  it("colonnes : name (états), type, scope (tous les sites), user, tls, version, dernier usage, usages", async () => {
    const { g } = store();
    await g.charger();
    const hote = monterTable(g);
    await attendre();
    expect([...hote.querySelectorAll("thead th")].map((th) => (th.textContent ?? "").trim())).toEqual([
      "name",
      "type",
      "scope",
      "user",
      "tls",
      "version",
      "dernier usage",
      "usages",
      "Actions",
    ]);
    expect(etiquettes(ligne(hote, "intranet-admin"))).toEqual(["intranet-admin"]);
    expect(cellules(ligne(hote, "intranet-admin")).slice(1, 8)).toEqual([
      "web-login",
      "https://intranet.example.lan:8443https://idp.example.lan",
      "admin",
      "strict",
      "2",
      "2 min",
      "3",
    ]);
    expect(etiquettes(ligne(hote, "ax-old"))).toEqual(["ax-old", "unverified", "⚠ kid"]);
    expect(ligne(hote, "gitlab")).toBeNull();
    expect(ligne(hote, "mcp-srv")).toBeNull();
    expect(cellules(ligne(hote, "sandbox-git")).slice(2, 4)).toEqual(["git.lan", "—"]);
    expect(ligne(hote, "sandbox-git").querySelector(".elpis-secrets__details")?.textContent).toBe(
      "user=— · tls=strict",
    );
    expect(hote.textContent).not.toMatch(/p4ss|secret_enc/u);
  });

  it("menu ⋯ selon le genre : complet, vérification d'un importé, git importé renvoyé à Comptes Git", async () => {
    const { g } = store();
    await g.charger();
    const hote = monterTable(g);
    await attendre();
    await ouvrirMenu(hote, "intranet-admin");
    expect(entrees(hote)).toEqual(["Rotation", "Modifier", "Supprimer"]);
    expect(document.activeElement?.textContent?.trim()).toBe("Rotation");
    await ouvrirMenu(hote, "ax-old");
    expect(entrees(hote)).toEqual(["Rotation", "Modifier", "Vérifier", "Supprimer"]);
    await ouvrirMenu(hote, "sandbox-git");
    expect(entrees(hote)).toEqual(["Rotation", "Vérifier", "Comptes Git"]);
  });

  it("vérification d'un git importé : scope relu, renvoi à Comptes Git au lieu de modifier le scope", async () => {
    const { g, appels } = store();
    await g.charger();
    const hote = monterTable(g);
    await attendre();
    g.choisir(5, "verifier");
    await attendre();
    const panneau = hote.querySelector<HTMLElement>('[data-panneau="5"]')!;
    const boutons = [...panneau.querySelectorAll("button")].map((b) => b.textContent?.trim());
    expect(boutons).toEqual(["Vérifier", "Comptes Git", "Annuler"]);
    expect(panneau.querySelector("dd")?.textContent).toContain("git.lan");
    panneau.querySelectorAll("button")[0]!.click();
    await attendre();
    expect(appels.at(-1)).toMatchObject({ url: "/api/secrets/5/verify", methode: "POST" });
  });

  it("menu au clavier : flèches, Échap rend le focus au bouton ⋯", async () => {
    const { g } = store();
    await g.charger();
    const hote = monterTable(g);
    await attendre();
    await ouvrirMenu(hote, "intranet-admin");
    const menu = hote.querySelector<HTMLElement>('[role="menu"]')!;
    menu.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    expect(document.activeElement?.textContent?.trim()).toBe("Modifier");
    menu.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await attendre();
    expect(hote.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Actions sur intranet-admin");
  });

  it("suppression : le même bouton, à la même place, arme puis confirme ; un double-clic ne supprime pas", async () => {
    const horloge = { t: 1000 };
    const { g, appels } = store("compte", horloge);
    await g.charger();
    const hote = monterTable(g);
    await attendre();
    await ouvrirMenu(hote, "intranet-admin");
    const bouton = (): HTMLButtonElement =>
      [...hote.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(
        (b) => b.textContent?.trim() === "Supprimer",
      )!;
    const avant = bouton();
    avant.click();
    await attendre();
    expect(bouton()).toBe(avant);
    expect(avant.classList.contains("is-arme")).toBe(true);
    expect(hote.querySelector('[role="menu"] [role="status"]')).toBeNull();
    const statut = hote.querySelector<HTMLElement>('[role="status"]')!;
    expect(statut.textContent).toBe("« intranet-admin » : cliquez de nouveau sur Supprimer pour confirmer.");
    expect(avant.getAttribute("aria-describedby")).toBe(statut.id);
    avant.click();
    await attendre();
    expect(appels.filter((a) => a.methode === "DELETE")).toEqual([]);
    horloge.t += 500;
    avant.click();
    await attendre();
    expect(appels.at(-1)).toMatchObject({ url: "/api/secrets/1", methode: "DELETE" });
    expect(ligne(hote, "intranet-admin")).toBeNull();
    expect(statut.textContent).toBe("");
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Actions sur sandbox-git");
  });

  it("dernier secret supprimé : le focus va à la table", async () => {
    const horloge = { t: 1000 };
    const seul = secret(1, { name: "seul" });
    const { api } = fauxServeur((url, methode) =>
      methode === "GET" ? json({ secrets: [seul] }) : json({ ok: true }),
    );
    const g = reactive(creerGestionSecrets({ api, portee: "compte", maintenant: () => horloge.t }));
    await g.charger();
    const hote = monterTable(g);
    await attendre();
    await ouvrirMenu(hote, "seul");
    const suppr = [...hote.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].at(-1)!;
    suppr.click();
    horloge.t += 500;
    suppr.click();
    await attendre();
    expect(document.activeElement).toBe(hote.querySelector(".elpis-secrets"));
  });

  it("rotation : champ en écriture seule sous la ligne, nouvelle version affichée", async () => {
    const { g, appels, toasts } = store();
    await g.charger();
    const hote = monterTable(g);
    await attendre();
    g.choisir(1, "rotation");
    await attendre();
    const champ = hote.querySelector<HTMLInputElement>('[data-panneau="1"] input')!;
    expect(champ.type).toBe("text");
    expect(champ.classList.contains("elpis-valeur-secrete")).toBe(true);
    expect(champ.getAttribute("autocomplete")).toBe("off");
    for (const a of ["data-1p-ignore", "data-lpignore", "data-bwignore"])
      expect(champ.hasAttribute(a)).toBe(true);
    const copie = new Event("copy", { cancelable: true });
    champ.dispatchEvent(copie);
    expect(copie.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(champ);
    expect(hote.querySelector('[data-panneau="1"]')?.textContent).toContain("version 2 → 3");
    champ.value = "n0uvelle";
    champ.dispatchEvent(new Event("input"));
    soumettre(hote.querySelector<HTMLFormElement>('[data-panneau="1"] form')!);
    await attendre();
    expect(appels.at(-1)).toEqual({
      url: "/api/secrets/1/rotate",
      methode: "POST",
      corps: { value: "n0uvelle" },
    });
    expect(toasts).toEqual(["intranet-admin : version 3"]);
    expect(hote.querySelector('[data-panneau="1"]')).toBeNull();
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Actions sur intranet-admin");
  });

  it("panneau annulé : focus rendu au bouton ⋯ de sa ligne", async () => {
    const { g } = store();
    await g.charger();
    const hote = monterTable(g);
    await attendre();
    g.choisir(2, "verifier");
    await attendre();
    const annuler = [...hote.querySelectorAll<HTMLButtonElement>('[data-panneau="2"] button')].find(
      (b) => b.textContent?.trim() === "Annuler",
    )!;
    annuler.focus();
    annuler.click();
    await attendre();
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Actions sur ax-old");
  });

  it("sans masquage CSS (-webkit-text-security) : type password gardé, toujours hors des gestionnaires", async () => {
    vi.stubGlobal("CSS", { supports: () => false });
    const { g } = store();
    await g.charger();
    const hote = monterTable(g);
    await attendre();
    g.choisir(1, "rotation");
    await attendre();
    const champ = hote.querySelector<HTMLInputElement>('[data-panneau="1"] input')!;
    expect(champ.type).toBe("password");
    expect(champ.getAttribute("autocomplete")).toBe("off");
    expect(champ.hasAttribute("data-1p-ignore")).toBe(true);
  });

  it("vérification : scope à relire, puis unverified → active", async () => {
    const { g, appels } = store();
    await g.charger();
    const hote = monterTable(g);
    await attendre();
    g.choisir(2, "verifier");
    await attendre();
    const panneau = hote.querySelector<HTMLElement>('[data-panneau="2"]')!;
    expect(panneau.querySelector("dd")?.textContent).toContain("https://intranet.example.lan:8443");
    [...panneau.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Vérifier")!.click();
    await attendre();
    expect(appels.at(-1)).toMatchObject({ url: "/api/secrets/2/verify", methode: "POST" });
    expect(etiquettes(ligne(hote, "ax-old"))).toEqual(["ax-old", "⚠ kid"]);
  });

  it("console : rotation et suppression des secrets d'instance, aucun formulaire de modification", async () => {
    const { g } = store("instance");
    await g.charger();
    const hote = monterTable(g);
    await attendre();
    await ouvrirMenu(hote, "intranet-admin");
    expect(entrees(hote)).toEqual(["Rotation", "Supprimer"]);
    await ouvrirMenu(hote, "mcp-srv");
    expect(entrees(hote)).toEqual(["Outils MCP"]);
    await ouvrirMenu(hote, "sandbox-git");
    expect(entrees(hote)).toEqual(["Rotation"]);
  });
});

describe("Paramètres › Secrets : création", () => {
  it("Nouveau : slug vérifié à la frappe, puis corps de création ; le formulaire se referme", async () => {
    const { g, appels } = store();
    await g.charger();
    const hote = monter(OngletSecrets, g, true);
    await attendre();
    hote.querySelector<HTMLButtonElement>("[data-nouveau-secret]")!.click();
    await attendre();
    const champ = (nom: string): HTMLInputElement =>
      hote.querySelector<HTMLInputElement>(`[data-formulaire-secret] [data-champ="${nom}"]`)!;
    const saisir = (nom: string, valeur: string): void => {
      champ(nom).value = valeur;
      champ(nom).dispatchEvent(new Event("input"));
    };
    saisir("name", "Intranet Admin");
    await attendre();
    expect(champ("name").getAttribute("aria-invalid")).toBe("true");
    expect(hote.querySelector("[data-formulaire-secret]")?.textContent).toContain(
      "[a-z0-9][a-z0-9._-]{0,47}",
    );
    saisir("name", "intranet-web");
    saisir("scope", "https://intranet.example.lan");
    saisir("value", "s3cret");
    await attendre();
    expect(champ("name").getAttribute("aria-invalid")).toBeNull();
    const form = hote.querySelector<HTMLFormElement>("[data-formulaire-secret]")!;
    expect(form.querySelector('input[type="password"]')).toBeNull();
    expect(champ("value").type).toBe("text");
    expect(champ("value").getAttribute("autocomplete")).toBe("off");
    expect([...form.querySelectorAll("input[id]")].some((i) => /user|pass|login/u.test(i.id))).toBe(false);
    soumettre(hote.querySelector<HTMLFormElement>("[data-formulaire-secret]")!);
    await attendre();
    expect(appels.at(-1)).toEqual({
      url: "/api/secrets",
      methode: "POST",
      corps: {
        kind: "web-login",
        scope: { origins: ["https://intranet.example.lan"] },
        name: "intranet-web",
        username: null,
        value: "s3cret",
        policy: { tls: "strict", subagents: true, routines: false },
      },
    });
    expect(hote.querySelector("[data-formulaire-secret]")).toBeNull();
    expect(ligne(hote, "intranet-web")).not.toBeNull();
  });

  it("type token : ni scope ni tls ; valeur exigée à l'envoi", async () => {
    const { g, appels } = store();
    await g.charger();
    const hote = monter(OngletSecrets, g, true);
    g.nouveau("token");
    await attendre();
    const form = hote.querySelector<HTMLFormElement>("[data-formulaire-secret]")!;
    expect(form.querySelector('[data-champ="scope"]')).toBeNull();
    expect(form.querySelector('[data-champ="tls"]')).toBeNull();
    g.creation!.name = "ci-token";
    await attendre();
    soumettre(form);
    await attendre();
    expect(form.textContent).toContain("valeur requise");
    expect(appels.filter((a) => a.methode === "POST")).toEqual([]);
  });
});
