// SPDX-License-Identifier: MIT
/** frontend/test/reglages/modale-mcp.test.ts — rendu du gestionnaire MCP à deux volets : sélection, Enregistrer dans l'en-tête, garde, lecture seule d'un serveur publié, secret inutilisable signalé à qui peut agir, portée Tous, suppression en ligne, pas d'import de dossier. */
import { createApp, h, nextTick } from "vue";
import type { App } from "vue";
import { afterEach, describe, expect, it } from "vitest";

import ModaleMcp from "../../src/components/reglages/ModaleMcp.vue";
import { CLE_REGLAGES } from "../../src/features/reglages/domaine";
import { appels, etat } from "../chat/page/montage";

let app: App | null = null;
afterEach(() => {
  app?.unmount();
  app = null;
  appels.length = 0;
  document.body.innerHTML = "";
});

const GIT = {
  id: "server_1",
  name: "Git",
  type: "http",
  url: "http://git.lan/mcp",
  command: "",
  visible: true,
};
const ANNUAIRE = {
  id: "shared:3",
  name: "Annuaire",
  type: "http",
  url: "http://a.lan/mcp",
  enabled: true,
  has_auth: true,
  shared: true,
};
const form = (o: Record<string, unknown> = {}) => ({
  portee: "perso",
  id: "server_1",
  name: "Git",
  type: "http",
  url: "http://git.lan/mcp",
  command: "",
  auth_mode: "",
  auth_user: "",
  auth_secret: "",
  has_auth: false,
  headers: [],
  env: [],
  enabled: true,
  ...o,
});

function monter(valeurs: Record<string, unknown>): Record<string, unknown> {
  const rg = etat<Record<string, unknown>>({
    showMcpManagerModal: true,
    settings: { mcp_servers: [GIT] },
    user: { username: "bob", role: "admin" },
    sharedMcpServers: [ANNUAIRE],
    mcpListePerso: [GIT],
    mcpListePartages: [ANNUAIRE],
    pinnedServers: [GIT],
    mcpSearch: "",
    mcpSel: "p:server_1",
    mcpForm: form(),
    mcpTests: { server_1: { busy: false, ok: true, msg: "", outils: 14, ms: 62 } },
    mcpSale: false,
    mcpGarde: null,
    mcpConfirmer: false,
    mcpErreurs: {},
    mcpErreur: "",
    mcpOccupe: false,
    mcpFlash: "",
    mcpEstEpingle: () => true,
    isSharedVisible: () => false,
    ...valeurs,
  });
  const hote = document.createElement("div");
  document.body.appendChild(hote);
  app = createApp({ render: () => h(ModaleMcp) });
  app.config.warnHandler = () => {};
  app.provide(CLE_REGLAGES, rg as never);
  app.mount(hote);
  return rg;
}

const boutons = (): HTMLButtonElement[] => [...document.querySelectorAll<HTMLButtonElement>("button")];
const bouton = (texte: string): HTMLButtonElement | undefined =>
  boutons().find((b) => b.textContent?.trim() === texte);

describe("ModaleMcp à deux volets", () => {
  it("la ligne choisie est marquée, l'état du test est lisible et Enregistrer attend une saisie", () => {
    monter({});
    const ligne = document.querySelector<HTMLElement>('[data-mcp-ligne][aria-current="true"]');
    expect(ligne?.textContent).toContain("Git");
    expect(ligne?.textContent).toContain("14 outils");
    expect(document.body.textContent).toContain("14 outils · 62 ms");
    expect(bouton("Enregistrer")?.getAttribute("aria-disabled")).toBe("true");
    expect(bouton("Tester")).toBeTruthy();
    const pan = document.querySelector<HTMLInputElement>('input[aria-label="Afficher dans le panneau MCP"]');
    expect(pan?.checked).toBe(true);
    pan?.dispatchEvent(new Event("change"));
    expect(appels.map((a) => a[0])).toContain("mcpBasculerPanneau");
  });

  it("une ligne appelle mcpChoisir ; la garde propose Abandonner et Enregistrer", async () => {
    const rg = monter({ mcpSale: true });
    expect(bouton("Enregistrer")?.getAttribute("aria-disabled")).toBeNull();
    document.querySelectorAll<HTMLElement>("[data-mcp-ligne]")[1]?.click();
    expect(appels.find((a) => a[0] === "mcpChoisir")?.[1]).toBe("s:shared:3");
    rg["mcpGarde"] = "s:shared:3";
    await nextTick();
    const garde = document.querySelector('[role="alert"]');
    expect(garde?.textContent).toContain("Modifications non enregistrées");
    bouton("Abandonner")?.click();
    expect(appels.map((a) => a[0])).toContain("mcpAbandonner");
  });

  it("serveur publié vu par un compte ordinaire : lecture seule, ni Tester ni Enregistrer, pas d'import", () => {
    monter({
      user: { username: "alice", role: "user" },
      mcpSel: "s:shared:3",
      mcpForm: form({ portee: "partage", id: "shared:3", name: "Annuaire", has_auth: true }),
    });
    expect(bouton("Tester")).toBeUndefined();
    expect(bouton("Enregistrer")).toBeUndefined();
    expect(document.body.textContent).toContain("Géré par l'administrateur");
  });

  it("secret inutilisable : un compte ordinaire est renvoyé vers un administrateur pour un serveur publié ou une clé du coffre absente, invité à ressaisir le sien", () => {
    monter({
      user: { username: "alice", role: "user" },
      mcpSel: "s:shared:3",
      mcpForm: form({
        portee: "partage",
        id: "shared:3",
        name: "Annuaire",
        has_auth: true,
        secret_error: "undecryptable",
      }),
    });
    expect(document.body.textContent).toContain("demandez à un administrateur de le ressaisir");
    app?.unmount();
    monter({ user: { username: "alice", role: "user" }, mcpForm: form({ secret_error: "key_unavailable" }) });
    expect(document.body.textContent).toContain("prévenez un administrateur");
    app?.unmount();
    monter({ user: { username: "alice", role: "user" }, mcpForm: form({ secret_error: "missing" }) });
    expect(document.body.textContent).toContain("Secret retiré du coffre : ressaisissez-le.");
  });

  it("nouveau serveur publié : Local désactivé, modèle local désactivé, bouton Publier", () => {
    monter({ mcpSel: "nouveau", mcpForm: form({ portee: "partage", id: "", name: "" }), mcpTests: {} });
    const local = boutons().find((b) => b.hasAttribute("aria-pressed") && b.textContent?.trim() === "Local");
    expect(local?.disabled).toBe(true);
    expect(bouton("Wiki.js (local)")?.disabled).toBe(true);
    expect(bouton("Publier")).toBeTruthy();
    expect(document.body.textContent).toContain("Non testé");
  });

  it("suppression : le même bouton confirme, à la même place ; un double-clic ne supprime pas", async () => {
    const rg = monter({});
    const avant = bouton("Supprimer");
    const zone = avant?.parentElement;
    avant?.click();
    expect(appels.map((a) => a[0])).toContain("mcpDemanderSuppression");
    rg["mcpConfirmer"] = true;
    await nextTick();
    const apres = bouton("Supprimer");
    expect(apres).toBe(avant);
    expect(zone?.firstElementChild).toBe(apres);
    expect(apres?.getAttribute("aria-describedby")).toBe("mcp-suppr-q");
    expect(document.getElementById("mcp-suppr-q")?.textContent).toContain(
      "cliquez de nouveau pour confirmer",
    );
    apres?.click();
    expect(appels.map((a) => a[0])).not.toContain("mcpSupprimer");
    await new Promise((r) => setTimeout(r, 420));
    apres?.click();
    expect(appels.map((a) => a[0])).toContain("mcpSupprimer");
    bouton("Annuler")?.click();
    expect(appels.map((a) => a[0])).toContain("mcpAnnulerSuppression");
  });

  it("compte ordinaire : ni type « Local » ni modèle local, même grisés", () => {
    monter({
      user: { username: "alice", role: "user" },
      mcpSel: "nouveau",
      mcpForm: form({ id: "", name: "" }),
      mcpTests: {},
    });
    expect(boutons().some((b) => b.textContent?.trim() === "Local")).toBe(false);
    expect(bouton("Wiki.js (local)")).toBeUndefined();
    expect(bouton("HTTP")).toBeTruthy();
    expect(bouton("Wiki.js")).toBeTruthy();
  });

  it("aucun import de dossier, même pour l'admin", () => {
    monter({});
    expect(document.querySelector('button[aria-label="Importer un dossier"]')).toBeNull();
    expect(document.body.textContent).not.toContain("Dossiers");
  });
});
