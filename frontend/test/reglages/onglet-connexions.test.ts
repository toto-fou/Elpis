// SPDX-License-Identifier: MIT
/** frontend/test/reglages/onglet-connexions.test.ts — Paramètres › Secrets : « Jetons MCP » ne montre que les jetons d'outils, « Remote » que ceux des postes reliés ; création, jeton montré et applications autorisées restent dans leur partie. */
import { createApp, h, nextTick, proxyRefs } from "vue";
import type { App } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";

import OngletConnexions from "../../src/components/reglages/onglets/OngletConnexions.vue";
import { GestionnaireSession } from "../../src/features/auth/session";
import { setupConnexions } from "../../src/features/reglages/connexions";
import type { GenreJeton } from "../../src/features/reglages/connexions";
import { CLE_REGLAGES } from "../../src/features/reglages/domaine";
import { ClientHttp } from "../../src/platform/http/client";
import { json } from "../aides";

const jeton = (id: number, kind: string, name: string, plus: Record<string, unknown> = {}) => ({
  id,
  user_id: 1,
  kind,
  name,
  hint: "ab12",
  families: kind === "tools" ? ["fs", "git"] : [],
  created_at: 1_790_000_000,
  expires_at: kind === "tools" ? 1_797_000_000 : null,
  last_used_at: null,
  ...plus,
});
const JETONS = [
  jeton(1, "tools", "VS Code du bureau"),
  jeton(2, "opencode", "OpenCode · poste-dev (installation)"),
  jeton(3, "tools", "agent CI"),
];
const liste = (tokens: unknown[], opencode = true, outils = true) => ({
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
  opencode_enabled: opencode,
});

let app: App | null = null;
afterEach(() => {
  app?.unmount();
  app = null;
  document.body.innerHTML = "";
});

async function monter(genre: GenreJeton, reponse = liste(JETONS)) {
  const vus: Array<[string, string, unknown]> = [];
  const confirmations: string[] = [];
  const fetch = (u: string, o?: RequestInit): Promise<Response> => {
    vus.push([u, o?.method ?? "GET", o?.body]);
    if (u.includes("/oauth/grants")) return Promise.resolve(json({ enabled: true, items: [] }));
    if (o?.method === "POST")
      return Promise.resolve(
        json({ token: "pcr_tout_neuf", item: jeton(9, JSON.parse(o.body as string).kind, "neuf") }),
      );
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
  app = createApp({ render: () => h(OngletConnexions, { genre }) });
  app.config.warnHandler = () => {};
  app.provide(CLE_REGLAGES, proxyRefs(D) as never);
  app.mount(hote);
  await nextTick();
  const q = <T extends Element = HTMLElement>(s: string): T | null => hote.querySelector<T>(s);
  const noms = (): string[] =>
    [...hote.querySelectorAll("[data-jeton] .text-sm")].map((e) =>
      (e.textContent ?? "").replace(/\s+/gu, " ").trim(),
    );
  return { D, vus, confirmations, hote, q, noms, cliquer: vi.fn() };
}

describe("Jetons MCP", () => {
  it("ne liste que les jetons d'outils ; le formulaire n'a plus de choix de type et crée un jeton d'outils ; les applications autorisées restent ici", async () => {
    const v = await monter("tools");
    expect(v.noms()).toEqual(["VS Code du bureau …ab12", "agent CI …ab12"]);
    expect(v.hote.textContent).not.toContain("poste-dev");
    expect(v.q("[data-protection]")?.textContent?.replace(/\s+/gu, " ")).toContain(
      "ne garde que l'empreinte d'un jeton et ses 4 derniers caractères",
    );
    expect(v.q("[data-protection]")?.textContent).not.toContain("poste relié");
    expect(v.hote.textContent).toContain("Applications autorisées");
    v.q<HTMLButtonElement>("[data-nouveau-jeton]")!.click();
    await nextTick();
    expect(v.D.cnxState.value.parties.tools.form?.kind).toBe("tools");
    expect(v.q("select")).toBeNull();
    expect(v.hote.textContent).toContain("Familles d'outils");
  });

  it("un jeton Remote montré ou en cours de création n'apparaît pas dans cette partie, et ne lui retire ni son jeton montré ni son brouillon", async () => {
    const v = await monter("tools");
    v.D.cnxShowConfig(JETONS[0] as never);
    await nextTick();
    expect(v.q("[data-jeton-montre]")?.textContent).toContain("VS Code du bureau");
    v.D.cnxShowConfig(JETONS[1] as never);
    v.D.cnxNew("opencode");
    await nextTick();
    expect(v.q("[data-jeton-montre]")?.textContent).toContain("VS Code du bureau");
    expect(v.q("[data-jeton-montre]")?.textContent).not.toContain("poste-dev");
    expect(v.q("[data-nom-jeton]")).toBeNull();
    expect(v.q("[data-nouveau-jeton]")).not.toBeNull();
  });

  it("jetons d'outils fermés par l'administrateur alors que Remote est permis : création fermée ici seulement", async () => {
    const v = await monter("tools", liste(JETONS, true, false));
    expect(v.q<HTMLButtonElement>("[data-nouveau-jeton]")?.disabled).toBe(true);
    expect(v.q("[data-desactive]")?.textContent).toContain("jetons d'outils sont désactivés");
    app?.unmount();
    document.body.innerHTML = "";
    const remote = await monter("opencode", liste(JETONS, true, false));
    expect(remote.q<HTMLButtonElement>("[data-nouveau-jeton]")?.disabled).toBe(false);
    expect(remote.q("[data-desactive]")).toBeNull();
  });
});

describe("Remote", () => {
  it("tant que la liste n'est pas arrivée : rien n'est dit désactivé ; régénérer un jeton le montre ici, avec sa commande", async () => {
    const hote = document.createElement("div");
    document.body.appendChild(hote);
    const D = setupConnexions(
      { showToast: () => undefined, openConfirm: () => Promise.resolve(true) },
      new ClientHttp(new GestionnaireSession(), (u: string, o?: RequestInit) =>
        Promise.resolve(
          u.includes("/oauth/grants")
            ? json({ enabled: false, items: [] })
            : o?.method === "POST"
              ? json({ token: "pcr_regenere", item: JETONS[1] })
              : json(liste(JETONS)),
        ),
      ),
    );
    app = createApp({ render: () => h(OngletConnexions, { genre: "opencode" }) });
    app.config.warnHandler = () => {};
    app.provide(CLE_REGLAGES, proxyRefs(D) as never);
    app.mount(hote);
    await nextTick();
    expect(hote.querySelector("[data-desactive]")).toBeNull();
    expect(hote.querySelector<HTMLButtonElement>("[data-nouveau-jeton]")?.disabled).toBe(false);
    await D.loadConnexions();
    await nextTick();
    hote.querySelector<HTMLButtonElement>('[data-jeton] button[aria-label="Régénérer le jeton"]')!.click();
    await vi.waitFor(() =>
      expect(hote.querySelector("[data-jeton-montre]")?.textContent).toContain("/remote pcr_regenere"),
    );
  });

  it("ne liste que les jetons des postes reliés, sans familles ni applications autorisées ; un jeton créé ici est un jeton Remote, montré une fois avec sa commande", async () => {
    const v = await monter("opencode");
    expect(v.noms()).toEqual(["OpenCode · poste-dev (installation) …ab12"]);
    expect(v.hote.textContent).not.toContain("VS Code du bureau");
    expect(v.hote.textContent).not.toContain("Applications autorisées");
    expect(v.q("[data-protection]")?.textContent?.replace(/\s+/gu, " ")).toContain(
      "Un jeton par poste relié en Remote : le révoquer déconnecte ce poste. Elpis ne garde que l'empreinte",
    );
    v.q<HTMLButtonElement>("[data-nouveau-jeton]")!.click();
    await nextTick();
    expect(v.D.cnxState.value.parties.opencode.form).toEqual({
      kind: "opencode",
      name: "",
      families: {},
      days: null,
    });
    expect(v.hote.textContent).not.toContain("Familles d'outils");
    const nom = v.q<HTMLInputElement>("[data-nom-jeton]")!;
    nom.value = "poste du bureau";
    nom.dispatchEvent(new Event("input"));
    await v.D.cnxCreate("opencode");
    await nextTick();
    const post = v.vus.find((x) => x[1] === "POST")!;
    expect(JSON.parse(post[2] as string)).toMatchObject({ kind: "opencode", name: "poste du bureau" });
    expect(v.q("[data-jeton-montre]")?.textContent).toContain("pcr_tout_neuf");
    expect(v.q("[data-jeton-montre]")?.textContent).toContain("/remote pcr_tout_neuf");
  });

  it("« Tout révoquer » : offert à partir de deux postes, une confirmation, chaque jeton Remote révoqué, aucun jeton d'outils touché", async () => {
    const seul = await monter("opencode");
    expect(seul.q("[data-tout-revoquer]")).toBeNull();
    app?.unmount();
    document.body.innerHTML = "";
    const v = await monter(
      "opencode",
      liste([...JETONS, jeton(7, "opencode", "OpenCode · portable (installation)")]),
    );
    v.q<HTMLButtonElement>("[data-tout-revoquer]")!.click();
    await vi.waitFor(() => expect(v.vus.filter((x) => x[1] === "DELETE")).toHaveLength(2));
    expect(v.confirmations.at(-1)).toBe("Les 2 postes reliés seront déconnectés immédiatement.");
    expect(v.vus.filter((x) => x[1] === "DELETE").map((x) => x[0])).toEqual([
      "/api/tokens/2",
      "/api/tokens/7",
    ]);
    app?.unmount();
    document.body.innerHTML = "";
    const outils = await monter("tools");
    expect(outils.q("[data-tout-revoquer]")).toBeNull();
  });

  it("révoquer un jeton : la confirmation dit que le poste sera déconnecté ; aucun poste : dit ; Remote désactivé : création fermée, les jetons restants restent révocables", async () => {
    const v = await monter("opencode");
    v.q<HTMLButtonElement>('[data-jeton] button[aria-label="Révoquer le jeton"]')!.click();
    await nextTick();
    expect(v.confirmations.at(-1)).toContain("poste-dev (installation) » sera déconnecté immédiatement");
    expect(v.vus.some((x) => x[1] === "DELETE" && x[0] === "/api/tokens/2")).toBe(true);
    app?.unmount();
    document.body.innerHTML = "";
    const vide = await monter("opencode", liste([JETONS[0]]));
    expect(vide.hote.textContent).toContain("Aucun poste relié.");
    app?.unmount();
    document.body.innerHTML = "";
    const coupe = await monter("opencode", liste(JETONS, false));
    expect(coupe.q<HTMLButtonElement>("[data-nouveau-jeton]")?.disabled).toBe(true);
    expect(coupe.q("[data-desactive]")?.textContent).toContain("Remote est désactivé par l'administrateur.");
    expect(coupe.noms()).toHaveLength(1);
    // Régénérer créerait un jeton que le serveur refuse : fermé aussi ; révoquer reste possible.
    expect(coupe.q<HTMLButtonElement>('[data-jeton] button[aria-label="Régénérer le jeton"]')?.disabled).toBe(
      true,
    );
    expect(coupe.q<HTMLButtonElement>('[data-jeton] button[aria-label="Révoquer le jeton"]')?.disabled).toBe(
      false,
    );
    // Côté outils, c'est la politique des jetons d'outils qui ferme la création, pas Remote.
    app?.unmount();
    document.body.innerHTML = "";
    const outils = await monter("tools", liste(JETONS, false, true));
    expect(outils.q<HTMLButtonElement>("[data-nouveau-jeton]")?.disabled).toBe(false);
  });
});
