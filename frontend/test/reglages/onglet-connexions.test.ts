// SPDX-License-Identifier: MIT
/** frontend/test/reglages/onglet-connexions.test.ts — Paramètres › Secrets › Jetons MCP : jetons d'outils listés, création, jeton montré une fois avec ses blocs, régénération, révocation, politique de l'administrateur, applications autorisées. */
import { createApp, h, nextTick, proxyRefs } from "vue";
import type { App } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";

import OngletConnexions from "../../src/components/reglages/onglets/OngletConnexions.vue";
import { GestionnaireSession } from "../../src/features/auth/session";
import { setupConnexions } from "../../src/features/reglages/connexions";
import { CLE_REGLAGES } from "../../src/features/reglages/domaine";
import { ClientHttp } from "../../src/platform/http/client";
import { json } from "../aides";

const jeton = (id: number, name: string, plus: Record<string, unknown> = {}) => ({
  id,
  user_id: 1,
  kind: "tools",
  name,
  hint: "ab12",
  families: ["fs", "git"],
  created_at: 1_790_000_000,
  expires_at: 1_797_000_000,
  last_used_at: null,
  ...plus,
});
const JETONS = [jeton(1, "VS Code du bureau"), jeton(3, "agent CI")];
const liste = (tokens: unknown[], outils = true) => ({
  tokens,
  policy: {
    tools_enabled: outils,
    tools_families: ["fs", "git"],
    max_days: 90,
    max_per_user: 20,
    families: [
      { name: "fs", label: "Fichiers" },
      { name: "git", label: "Git" },
    ],
  },
  bridge_url: "http://lan/api/mcp-bridge",
  tools_url: "http://lan/api/tools",
});

let app: App | null = null;
afterEach(() => {
  app?.unmount();
  app = null;
  document.body.innerHTML = "";
});

async function monter(reponse = liste(JETONS)) {
  const vus: Array<[string, string, unknown]> = [];
  const confirmations: string[] = [];
  const fetch = (u: string, o?: RequestInit): Promise<Response> => {
    vus.push([u, o?.method ?? "GET", o?.body]);
    if (u.includes("/oauth/grants")) return Promise.resolve(json({ enabled: true, items: [] }));
    if (o?.method === "POST")
      return Promise.resolve(json({ token: "ept_tout_neuf", item: jeton(9, "neuf") }));
    if (o?.method === "DELETE") return Promise.resolve(json({ ok: true }));
    return Promise.resolve(json(reponse));
  };
  const D = setupConnexions(
    {
      showToast: () => undefined,
      openConfirm: (_t, message) => {
        confirmations.push(message);
        return Promise.resolve(true);
      },
    },
    new ClientHttp(new GestionnaireSession(), fetch),
  );
  await D.loadConnexions();
  const hote = document.createElement("div");
  document.body.appendChild(hote);
  app = createApp({ render: () => h(OngletConnexions) });
  app.config.warnHandler = () => {};
  app.provide(CLE_REGLAGES, proxyRefs(D) as never);
  app.mount(hote);
  await nextTick();
  const q = <T extends Element = HTMLElement>(s: string): T | null => hote.querySelector<T>(s);
  const noms = (): string[] =>
    [...hote.querySelectorAll("[data-jeton] .text-sm")].map((e) =>
      (e.textContent ?? "").replace(/\s+/gu, " ").trim(),
    );
  return { D, vus, confirmations, hote, q, noms };
}

describe("Jetons MCP", () => {
  it("liste les jetons d'outils ; le formulaire crée un jeton d'outils, montré une fois avec ses blocs ; les applications autorisées sont là", async () => {
    const v = await monter();
    expect(v.noms()).toEqual(["VS Code du bureau …ab12", "agent CI …ab12"]);
    expect(v.q("[data-protection]")?.textContent?.replace(/\s+/gu, " ")).toContain(
      "ne garde que l'empreinte d'un jeton et ses 4 derniers caractères",
    );
    expect(v.hote.textContent).toContain("Applications autorisées");
    expect(v.q("[data-tout-revoquer]")).toBeNull();
    v.q<HTMLButtonElement>("[data-nouveau-jeton]")!.click();
    await nextTick();
    expect(v.D.cnxState.value.form?.kind).toBe("tools");
    expect(v.q("select")).toBeNull();
    expect(v.hote.textContent).toContain("Familles d'outils");
    const nom = v.q<HTMLInputElement>("[data-nom-jeton]")!;
    nom.value = "poste du bureau";
    nom.dispatchEvent(new Event("input"));
    await v.D.cnxCreate();
    await nextTick();
    const post = v.vus.find((x) => x[1] === "POST")!;
    expect(JSON.parse(post[2] as string)).toEqual({
      kind: "tools",
      name: "poste du bureau",
      families: ["fs", "git"],
      days: 30,
    });
    const montre = v.q("[data-jeton-montre]")!;
    expect(montre.textContent).toContain("ept_tout_neuf");
    expect([...montre.querySelectorAll('[role="tab"]')].map((b) => b.textContent?.trim())).toEqual([
      "MCP",
      "VS Code",
      "opencode",
      "OpenAPI",
      "curl",
    ]);
    expect(montre.querySelector("pre")?.textContent).toContain("Bearer ept_tout_neuf");
  });

  it("tant que la liste n'est pas arrivée : rien n'est dit désactivé ; régénérer un jeton le montre ici", async () => {
    const hote = document.createElement("div");
    document.body.appendChild(hote);
    const D = setupConnexions(
      { showToast: () => undefined, openConfirm: () => Promise.resolve(true) },
      new ClientHttp(new GestionnaireSession(), (u: string, o?: RequestInit) =>
        Promise.resolve(
          u.includes("/oauth/grants")
            ? json({ enabled: false, items: [] })
            : o?.method === "POST"
              ? json({ token: "ept_regenere", item: JETONS[0] })
              : json(liste(JETONS)),
        ),
      ),
    );
    app = createApp({ render: () => h(OngletConnexions) });
    app.config.warnHandler = () => {};
    app.provide(CLE_REGLAGES, proxyRefs(D) as never);
    app.mount(hote);
    await nextTick();
    expect(hote.querySelector("[data-desactive]")).toBeNull();
    expect(hote.querySelector<HTMLButtonElement>("[data-nouveau-jeton]")?.disabled).toBe(false);
    await D.loadConnexions();
    await nextTick();
    expect(hote.textContent).not.toContain("Applications autorisées");
    hote.querySelector<HTMLButtonElement>('[data-jeton] button[aria-label="Régénérer le jeton"]')!.click();
    await vi.waitFor(() =>
      expect(hote.querySelector("[data-jeton-montre]")?.textContent).toContain("ept_regenere"),
    );
  });

  it("révoquer : une confirmation puis le jeton est retiré ; aucun jeton : dit", async () => {
    const v = await monter();
    v.q<HTMLButtonElement>('[data-jeton] button[aria-label="Révoquer le jeton"]')!.click();
    await vi.waitFor(() =>
      expect(v.vus.some((x) => x[1] === "DELETE" && x[0] === "/api/tokens/1")).toBe(true),
    );
    expect(v.confirmations.at(-1)).toBe(
      "Les clients qui utilisent « VS Code du bureau » perdront l'accès immédiatement.",
    );
    app?.unmount();
    document.body.innerHTML = "";
    const vide = await monter(liste([]));
    expect(vide.hote.textContent).toContain("Aucun jeton.");
  });

  it("jetons d'outils fermés par l'administrateur : création et régénération fermées, révocation possible", async () => {
    const v = await monter(liste(JETONS, false));
    expect(v.q<HTMLButtonElement>("[data-nouveau-jeton]")?.disabled).toBe(true);
    expect(v.q("[data-desactive]")?.textContent).toContain("jetons d'outils sont désactivés");
    expect(v.noms()).toHaveLength(2);
    expect(v.q<HTMLButtonElement>('[data-jeton] button[aria-label="Régénérer le jeton"]')?.disabled).toBe(
      true,
    );
    expect(v.q<HTMLButtonElement>('[data-jeton] button[aria-label="Révoquer le jeton"]')?.disabled).toBe(
      false,
    );
  });
});
