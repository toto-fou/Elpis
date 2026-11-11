// SPDX-License-Identifier: MIT
/** frontend/test/reglages/connecteurs-llm.test.ts — Connecteurs LLM du compte : chargement validé, création, clé requise, suppression confirmée, test. */
import { describe, expect, it } from "vitest";

import { GestionnaireSession } from "../../src/features/auth/session";
import { setupLlmConnecteurs } from "../../src/features/reglages/connecteurs-llm";
import { ClientHttp } from "../../src/platform/http/client";
import { json } from "../aides";

const CONNECTEUR = {
  id: 7,
  owner_user_id: 1,
  scope: "user" as const,
  provider_type: "anthropic",
  wire: "anthropic",
  label: "Perso",
  base_url: "https://api.anthropic.com",
  default_model: "m",
  models_json: "[]",
  enabled: true,
  key_scheme: "v1",
  created_at: 1,
  updated_at: 1,
  last_used: null,
  has_key: true,
  context_window: null,
  max_models: null,
  max_concurrency: null,
  provider_allowed: true,
};
const LISTE = {
  connectors: [CONNECTEUR],
  shared: [],
  presets: {
    anthropic: {
      wire: "anthropic",
      base_url: "u",
      label: "Anthropic",
      admin_only: false,
      user_base_locked: true,
    },
  },
  allowed_provider_types: ["anthropic", "openai"],
  builtin_allowed: true,
  can_manage_models: false,
};

function monter(route: (u: string, o?: RequestInit) => Response, confirme = true) {
  const vus: Array<[string, string, unknown]> = [];
  const toasts: string[] = [];
  const fetch = (u: string, o?: RequestInit): Promise<Response> => {
    vus.push([u, o?.method ?? "GET", o?.body]);
    return Promise.resolve(route(u, o));
  };
  const http = new ClientHttp(new GestionnaireSession(), fetch);
  const D = setupLlmConnecteurs(
    { showToast: (m) => toasts.push(m), openConfirm: () => Promise.resolve(confirme) },
    http,
  );
  return { D, vus, toasts };
}

describe("setupLlmConnecteurs", () => {
  it("charge, nomme le fournisseur par son preset et propose le premier type autorisé", async () => {
    const { D } = monter(() => json(LISTE));
    await D.loadLlmConnectors();
    expect(D.llmConnectors.value).toHaveLength(1);
    expect(D.llmPresetLabel("anthropic")).toBe("Anthropic");
    expect(D.llmPresetLabel("inconnu")).toBe("inconnu");
    D.newLlmConnector();
    expect(D.llmConnForm.value?.provider_type).toBe("anthropic");
  });

  it("réponse hors contrat : listes inchangées", async () => {
    const { D } = monter(() => json({ connectors: [], shared: [] }));
    await D.loadLlmConnectors();
    expect(D.llmConnAllowed.value).toEqual([]);
  });

  it("création sans clé refusée ; avec clé : POST puis rechargement", async () => {
    const { D, vus, toasts } = monter((_u, o) =>
      o?.method === "POST" ? json({ ok: true, id: 8 }) : json(LISTE),
    );
    D.newLlmConnector();
    await D.saveLlmConnector();
    expect(toasts).toEqual(["Clé API requise"]);
    D.llmConnForm.value!.api_key = "  sk-x ";
    await D.saveLlmConnector();
    const post = vus.find((v) => v[1] === "POST")!;
    expect(JSON.parse(post[2] as string)).toEqual({
      label: "",
      default_model: "",
      provider_type: "anthropic",
      api_key: "sk-x",
    });
    expect(D.llmConnForm.value).toBeNull();
    expect(toasts.at(-1)).toBe("Connecteur ajouté");
  });

  it("refus serveur : message du serveur", async () => {
    const { D, toasts } = monter(() => json({ detail: "Fournisseur interdit." }, 403));
    D.newLlmConnector();
    D.llmConnForm.value!.api_key = "k";
    await D.saveLlmConnector();
    expect(toasts.at(-1)).toBe("Fournisseur interdit.");
    expect(D.llmConnBusy.value).toBe(false);
  });

  it("suppression : rien sans confirmation ; test : résultat posé par connecteur", async () => {
    const non = monter(() => json({ ok: true }), false);
    await non.D.deleteLlmConnector(CONNECTEUR);
    expect(non.vus).toEqual([]);
    const { D } = monter(() => json({ ok: true, status: 200, models_count: 3 }));
    await D.testLlmConnector(CONNECTEUR);
    expect(D.llmConnTest.value[7]).toEqual({ ok: true, status: 200, models_count: 3 });
  });
});
