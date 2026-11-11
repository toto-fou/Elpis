// SPDX-License-Identifier: MIT
/** frontend/test/reglages/connexions.test.ts — Paramètres › Connexions : blocs à copier, jeton montré une fois, création, régénération, OAuth. */
import { describe, expect, it } from "vitest";

import { buildBlocks, setupConnexions } from "../../src/features/reglages/connexions";
import { GestionnaireSession } from "../../src/features/auth/session";
import { ClientHttp } from "../../src/platform/http/client";
import { json } from "../aides";

const POLITIQUE = {
  tools_enabled: true,
  tools_families: ["fs", "git", "desktop"],
  max_days: 90,
  max_per_user: 20,
  families: [
    { name: "fs", label: "Fichiers" },
    { name: "git", label: "Git" },
    { name: "desktop", label: "Bureau" },
  ],
};
const jeton = (id: number, over: Record<string, unknown> = {}) => ({
  id,
  user_id: 1,
  kind: "tools",
  name: "X",
  hint: "neuf",
  families: ["fs"],
  created_at: 1,
  expires_at: null,
  last_used_at: null,
  ...over,
});
const LISTE = (tokens: unknown[] = []) => ({
  tokens,
  policy: POLITIQUE,
  bridge_url: "b",
  tools_url: "o",
  opencode_enabled: true,
});

type Route = (url: string, init?: RequestInit) => Response;
function monter(route: Route) {
  const vus: Array<[string, string, unknown]> = [];
  const fetch = (u: string, o?: RequestInit): Promise<Response> => {
    vus.push([u, o?.method ?? "GET", o?.body]);
    return Promise.resolve(route(u, o));
  };
  const http = new ClientHttp(new GestionnaireSession(), fetch);
  return { D: setupConnexions({ showToast: () => undefined }, http), vus };
}

describe("blocs de configuration", () => {
  it("jeton d'outils : une entrée par famille, le jeton en Bearer", () => {
    const blocs = buildBlocks(
      "ept_abc",
      ["fs", "git"],
      "http://lan/api/mcp-bridge",
      "http://lan/api/tools",
      "tools",
    );
    const par = Object.fromEntries(blocs.map((b) => [b.id, b.text]));
    const mcp = JSON.parse(par.mcp!).mcpServers;
    expect(Object.keys(mcp)).toEqual(["elpis-fs", "elpis-git"]);
    expect(mcp["elpis-fs"].url).toBe("http://lan/api/mcp-bridge/fs");
    expect(mcp["elpis-fs"].headers.Authorization).toBe("Bearer ept_abc");
    expect(JSON.parse(par.vscode!).servers["elpis-git"].type).toBe("http");
    expect(JSON.parse(par.opencode!).mcp["elpis-fs"].type).toBe("remote");
    expect(par.openapi).toContain("http://lan/api/tools/git");
    expect(par.curl).toContain("http://lan/api/tools/fs/openapi.json");
  });

  it("sans jeton en clair : espace réservé partout ; opencode : /remote", () => {
    expect(buildBlocks("", ["fs"], "u", "v", "tools").every((b) => b.text.includes("<VOTRE_JETON>"))).toBe(
      true,
    );
    expect(buildBlocks("pcr_x", [], "u", "v", "opencode").map((b) => b.text)).toEqual(["/remote pcr_x"]);
  });
});

describe("setupConnexions", () => {
  it("nouveau jeton : desktop proposé mais jamais coché d'office", async () => {
    const { D } = monter(() => json(LISTE()));
    await D.loadConnexions();
    D.cnxNew();
    expect(D.cnxState.value.form?.families).toEqual({ fs: true, git: true, desktop: false });
    expect(D.cnxState.value.form?.days).toBe(30);
  });

  it("création : familles cochées envoyées, jeton montré une fois", async () => {
    const { D, vus } = monter((_u, o) =>
      o?.method === "POST" ? json({ token: "ept_neuf", item: jeton(4) }) : json(LISTE([jeton(4)])),
    );
    await D.loadConnexions();
    D.cnxNew();
    D.cnxState.value.form!.families.git = false;
    await D.cnxCreate();
    const post = vus.find((v) => v[1] === "POST")!;
    expect(JSON.parse(post[2] as string).families).toEqual(["fs"]);
    expect(D.cnxState.value.reveal?.token).toBe("ept_neuf");
    expect(D.cnxState.value.form).toBeNull();
    D.cnxShowConfig(D.cnxState.value.tokens[0]!);
    expect(D.cnxState.value.reveal?.token).toBe("");
    expect(D.cnxBlocks().every((b) => !b.text.includes("ept_neuf"))).toBe(true);
  });

  it("erreur de création : message du serveur affiché", async () => {
    const { D } = monter((_u, o) =>
      o?.method === "POST" ? json({ detail: "Durée maximale : 90 jours." }, 422) : json(LISTE()),
    );
    await D.loadConnexions();
    D.cnxNew();
    await D.cnxCreate();
    expect(D.cnxState.value.error).toBe("Durée maximale : 90 jours.");
    expect(D.cnxState.value.reveal).toBeNull();
    expect(D.cnxState.value.busy).toBe(false);
  });

  it("fermeture des Paramètres : le jeton montré une fois est oublié", async () => {
    const { D } = monter((_u, o) =>
      o?.method === "POST" ? json({ token: "ept_secret", item: jeton(1) }) : json(LISTE()),
    );
    await D.loadConnexions();
    D.cnxNew();
    await D.cnxCreate();
    expect(D.cnxState.value.reveal?.token).toBe("ept_secret");
    D.cnxReset();
    expect(D.cnxState.value.reveal).toBeNull();
    expect(JSON.stringify(D.cnxState.value)).not.toContain("ept_secret");
  });

  it("applications autorisées (OAuth) : listées puis retirées", async () => {
    let grants: unknown[] = [
      {
        grant_id: "g1",
        client_id: "elpis-x",
        client_name: "Éditeur",
        families: ["fs"],
        created_at: 1790000000,
        expires_at: 1790003600,
        last_used_at: null,
      },
    ];
    const { D, vus } = monter((u, o) => {
      if (u === "/api/oauth/grants") return json({ items: grants, enabled: true });
      if (u === "/api/oauth/grants/g1" && o?.method === "DELETE") {
        grants = [];
        return json({ ok: true });
      }
      return json(LISTE());
    });
    await D.loadConnexions();
    expect(D.cnxState.value.grants).toHaveLength(1);
    expect(D.cnxState.value.oauthEnabled).toBe(true);
    await D.cnxRevokeGrant(D.cnxState.value.grants[0]!);
    expect(vus.some((v) => v[0] === "/api/oauth/grants/g1" && v[1] === "DELETE")).toBe(true);
    expect(D.cnxState.value.grants).toHaveLength(0);
  });

  it("réponse hors contrat : état inchangé", async () => {
    const { D } = monter(() => json({ tokens: "x" }));
    await D.loadConnexions();
    expect(D.cnxState.value.tokens).toEqual([]);
  });
});
