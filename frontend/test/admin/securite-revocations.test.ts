// SPDX-License-Identifier: MIT
/** frontend/test/admin/securite-revocations.test.ts — console › Sessions : une révocation de compte se lit (échéance, aide) mais ne se lève pas. */
import * as Vue from "vue";
import { createApp, h, proxyRefs, ref } from "vue";
import type { App } from "vue";
import { afterEach, describe, expect, it } from "vitest";

import PageSecurite from "../../src/components/admin/PageSecurite.vue";
import { setupAdmin } from "../../src/features/admin/console";
import { CLE_ADMIN } from "../../src/features/admin/domaine";
import type { DomaineAdmin } from "../../src/features/admin/domaine";
import type { CtxAdmin, RefsAdmin } from "../../src/features/admin/types";
import { GestionnaireSession } from "../../src/features/auth/session";
import { ClientHttp } from "../../src/platform/http/client";
import { json, vider } from "../aides";

let app: App | null = null;
afterEach(() => {
  app?.unmount();
  app = null;
  document.body.innerHTML = "";
});

async function monterPage(): Promise<HTMLElement> {
  const fetchFaux = (): Promise<Response> => Promise.resolve(json({ ok: true }));
  const refs: RefsAdmin = {
    user: ref({ id: 1, username: "root", role: "admin", is_admin: 1 }),
    isAdminView: ref(true),
  };
  const ctx: CtxAdmin = {
    showToast: () => undefined,
    fetchAuth: () => fetchFaux(),
    openConfirm: () => Promise.resolve(false),
    openChoice: () => Promise.resolve("save"),
    nextTick: () => Vue.nextTick(),
    loadPublicConfig: () => undefined,
    systemAlert: ref(""),
  };
  const A = setupAdmin(Vue, refs, ctx, new ClientHttp(new GestionnaireSession(), fetchFaux));
  A.adminTab.value = "sessions";
  A.configForm.value = {
    security: {
      password_policy: {},
      session: {
        max_age_sec: 3600,
        idle_timeout_sec: 0,
        cookie_name: "c",
        same_site: "lax",
        https_only: false,
      },
    },
  } as unknown as typeof A.configForm.value;
  A.securityOverview.value = {
    session_cfg: { max_age_sec: 3600, global_min_ts: 0 },
    revoked_users: [{ user_id: 7, username: "bob", session_min_ts: 1_800_000_000 }],
  } as unknown as typeof A.securityOverview.value;
  const domaine = proxyRefs({ ...A, user: { id: 1, username: "root" } }) as unknown as DomaineAdmin;
  const hote = document.createElement("div");
  document.body.appendChild(hote);
  app = createApp({ render: () => h(PageSecurite) });
  app.provide(CLE_ADMIN, domaine);
  app.mount(hote);
  await vider();
  return hote;
}

describe("révocations individuelles", () => {
  it("pas de bouton « Lever » : l'échéance et l'aide sont affichées", async () => {
    const hote = await monterPage();
    const texte = hote.textContent ?? "";
    expect(texte).not.toContain("Lever");
    expect(texte).toContain("Révocation en vigueur jusqu'au");
    expect(texte).toContain("Une révocation ne se lève pas");
    expect(texte).toContain("La personne peut se reconnecter tout de suite.");
  });
});
