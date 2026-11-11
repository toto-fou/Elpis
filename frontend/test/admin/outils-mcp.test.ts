// SPDX-License-Identifier: MIT
/** frontend/test/admin/outils-mcp.test.ts — console › Outils MCP : clients OAuth, manifeste, rechargement et export. */
import { describe, expect, it } from "vitest";

import { setupAdminMcp } from "../../src/features/admin/outils-mcp";
import { GestionnaireSession } from "../../src/features/auth/session";
import { ClientHttp } from "../../src/platform/http/client";
import { json } from "../aides";

const CLIENT = {
  client_id: "elpis-abc",
  kind: "dcr",
  name: "Éditeur",
  has_secret: false,
  auth_method: "none",
  redirect_uris: [],
  metadata: {},
  created_at: 1,
  fetched_at: null,
  last_used_at: null,
  grants: 1,
  age_days: 0,
};

function monter(route: (u: string, o?: RequestInit) => Response, confirme = true) {
  const vus: Array<[string, string]> = [];
  const toasts: string[] = [];
  const fetch = (u: string, o?: RequestInit): Promise<Response> => {
    vus.push([u, o?.method ?? "GET"]);
    return Promise.resolve(route(u, o));
  };
  const M = setupAdminMcp(
    { showToast: (m) => toasts.push(m), openConfirm: () => Promise.resolve(confirme) },
    new ClientHttp(new GestionnaireSession(), fetch),
  );
  return { M, vus, toasts };
}

describe("setupAdminMcp", () => {
  it("clients OAuth : liste, suppression confirmée puis rechargement ; hors contrat : liste vide", async () => {
    let items = [CLIENT];
    const { M, vus } = monter((u, o) => {
      if (o?.method === "DELETE") {
        items = [];
        return json({ ok: true });
      }
      return u.includes("oauth") ? json({ items }) : json({});
    });
    await M.loadOauthClients();
    expect(M.oauthClients.value).toHaveLength(1);
    await M.deleteOauthClient(M.oauthClients.value[0]!);
    expect(vus).toContainEqual(["/api/admin/oauth/clients?client_id=elpis-abc", "DELETE"]);
    expect(M.oauthClients.value).toEqual([]);
    const casse = monter(() => json({ items: "x" }));
    await casse.M.loadOauthClients();
    expect(casse.M.oauthClients.value).toEqual([]);
  });

  it("suppression refusée sans confirmation", async () => {
    const { M, vus } = monter(() => json({ ok: true }), false);
    await M.deleteOauthClient(CLIENT);
    expect(vus).toEqual([]);
  });

  it("rechargement : toast selon les erreurs, puis relecture du manifeste", async () => {
    const { M, toasts, vus } = monter((u) =>
      u.endsWith("/reload")
        ? json({ ok: true, source: "s", errors: ["e"], warnings: [], servers: [] })
        : json({}),
    );
    await M.reloadMcpManifest();
    expect(toasts).toEqual(["Manifeste rechargé avec erreurs"]);
    expect(vus.at(-1)).toEqual(["/api/admin/mcp/manifest", "GET"]);
    expect(M.mcpManifestBusy.value).toBe(false);
  });

  it("libellés de rôle", () => {
    const { M } = monter(() => json({}));
    expect([
      M.mcpManifestRoleLabel("toolhost"),
      M.mcpManifestRoleLabel("app"),
      M.mcpManifestRoleLabel("x"),
    ]).toEqual(["intégré", "app", "externe"]);
  });
});
