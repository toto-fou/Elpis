// SPDX-License-Identifier: MIT
/** frontend/test/admin/skins.test.ts — console › Apparence : liste validée, activation, suppression confirmée, aperçu des rayons, valeurs de jeton refusées. */
import { describe, expect, it } from "vitest";

import { setupAdminSkins, valeurJetonOk } from "../../src/features/admin/skins";
import { GestionnaireSession } from "../../src/features/auth/session";
import { ClientHttp } from "../../src/platform/http/client";
import { json } from "../aides";

const skin = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  label: id || "Ardoise",
  desc: "",
  darkBase: false,
  sw: ["#000", "#fff", "#00f"],
  builtin: id !== "plugin",
  enabled: true,
  source: id === "plugin" ? "plugin" : "builtin",
  is_default: id === "elpis",
  locked: id === "elpis",
  enabled_by_default: true,
  version: "",
  author: "",
  license: "",
  ...over,
});
const LISTE = { default: "elpis", skins: [skin("elpis"), skin("plugin")] };

function monter(route: (u: string, o?: RequestInit) => Response, confirme = true) {
  const vus: Array<[string, string, unknown]> = [];
  const toasts: string[] = [];
  const fetch = (u: string, o?: RequestInit): Promise<Response> => {
    vus.push([u, o?.method ?? "GET", o?.body]);
    return Promise.resolve(route(u, o));
  };
  const S = setupAdminSkins(
    {
      showToast: (m) => toasts.push(m),
      openConfirm: () => Promise.resolve(confirme),
      reloadAppSkins: () => undefined,
    },
    new ClientHttp(new GestionnaireSession(), fetch),
  );
  return { S, vus, toasts };
}

describe("setupAdminSkins", () => {
  it("charge la liste ; réponse hors contrat ou refus : message d'erreur", async () => {
    const bon = monter(() => json(LISTE));
    await bon.S.loadAdminSkins();
    expect(bon.S.skinAdm.value.list).toHaveLength(2);
    expect(bon.S.skinAdm.value.loaded).toBe(true);
    expect(bon.S.skinAdmPlugins.value).toBe(1);
    const refus = monter(() => json({ detail: "Réservé." }, 403));
    await refus.S.loadAdminSkins();
    expect(refus.S.skinAdm.value.error).toBe("Réservé.");
    const vide = monter(() => json({}));
    await vide.S.loadAdminSkins();
    expect(vide.S.skinAdm.value.loaded).toBe(false);
  });

  it("activation : PUT ciblé, verrouillé sans appel", async () => {
    const { S, vus } = monter((_u, o) => (o?.method === "PUT" ? json(LISTE) : json(LISTE)));
    await S.loadAdminSkins();
    expect(S.skinToggle(S.skinAdm.value.list[0]!)).toBeUndefined();
    await S.skinToggle(S.skinAdm.value.list[1]!);
    const put = vus.find((v) => v[1] === "PUT")!;
    expect(JSON.parse(put[2] as string)).toEqual({ enabled: { plugin: false } });
    expect(S.skinAdmBusy.value).toBe("");
  });

  it("suppression : rien sans confirmation, ni pour un intégré", async () => {
    const non = monter(() => json({ ok: true, ...LISTE }), false);
    await non.S.skinDelete(skin("plugin") as never);
    expect(non.vus).toEqual([]);
    const oui = monter(() => json({ ok: true, ...LISTE }));
    await oui.S.skinDelete(skin("elpis") as never);
    expect(oui.vus).toEqual([]);
    await oui.S.skinDelete(skin("plugin") as never);
    expect(oui.vus[0]).toEqual(["/api/admin/skins/plugin", "DELETE", undefined]);
    expect(oui.toasts).toEqual(["Skin supprimé."]);
  });

  it("jetons : interdits du serveur refusés", () => {
    expect(valeurJetonOk("#a21caf")).toBe(true);
    expect(valeurJetonOk("url(http://x)")).toBe(false);
    expect(valeurJetonOk("red; color: blue")).toBe(false);
    expect(valeurJetonOk("")).toBe(false);
  });
});
