// SPDX-License-Identifier: MIT
/** frontend/test/admin/restauration.test.ts — restauration console : la confirmation et le résultat disent que la sécurité faite depuis la sauvegarde est à refaire quand la base est remplacée. */
import * as Vue from "vue";
import { ref } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";

import { setupAdmin } from "../../src/features/admin/console";
import type { CtxAdmin, RefsAdmin } from "../../src/features/admin/types";
import { GestionnaireSession } from "../../src/features/auth/session";
import { ClientHttp } from "../../src/platform/http/client";
import { json } from "../aides";

/** Requête d'envoi factice : rend `reponse` au premier `send`. */
function xhrFactice(reponse: Record<string, unknown>): void {
  class Xhr {
    status = 0;
    response: unknown = null;
    responseType = "";
    upload: { onprogress?: unknown; onload?: () => void } = {};
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    onabort: (() => void) | null = null;
    open(): void {}
    abort(): void {}
    send(): void {
      queueMicrotask(() => {
        this.upload.onload?.();
        this.status = 200;
        this.response = reponse;
        this.onload?.();
      });
    }
  }
  vi.stubGlobal("XMLHttpRequest", Xhr);
}

function monter() {
  const textes: string[] = [];
  const toasts: string[] = [];
  const fetchFaux = () => Promise.resolve(json({ ok: true }));
  const refs: RefsAdmin = {
    user: ref({ id: 1, username: "root", role: "admin", is_admin: 1 }),
    isAdminView: ref(true),
  };
  const ctx: CtxAdmin = {
    showToast: (message: string) => {
      toasts.push(message);
    },
    fetchAuth: () => fetchFaux(),
    openConfirm: () => Promise.resolve(true),
    openChoice: () => Promise.resolve("save"),
    openTypedConfirm: (_t: string, texte: string) => {
      textes.push(texte);
      return Promise.resolve(true);
    },
    nextTick: () => Vue.nextTick(),
    loadPublicConfig: () => undefined,
    systemAlert: ref(""),
  };
  const A = setupAdmin(Vue, refs, ctx, new ClientHttp(new GestionnaireSession(), fetchFaux));
  const entree = document.createElement("input");
  entree.type = "file";
  entree.id = "restore-file-input";
  document.body.appendChild(entree);
  return { A, entree, textes, toasts };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  document.body.innerHTML = "";
});

describe("restauration depuis la console", () => {
  it("la confirmation dit que la sécurité faite depuis la sauvegarde est à refaire, pour la base seulement", async () => {
    const { A, textes } = monter();
    await A.triggerRestore("db");
    await A.triggerRestore("full");
    await A.triggerRestore("sandboxes");
    expect(textes[0]).toContain("suspensions, révocations de jetons et changements de mot de passe");
    expect(textes[0]).toContain("refaites-les ensuite");
    expect(textes[1]).toContain("refaites-les ensuite");
    expect(textes[2]).not.toContain("suspensions");
  });

  it("base remplacée : le résultat demande de refaire suspensions et révocations", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    xhrFactice({
      ok: true,
      scope: "db",
      restored: 3,
      errors: [],
      restart_required: true,
      sessions_closed: true,
    });
    const { A, entree, toasts } = monter();
    await A.triggerRestore("db");
    Object.defineProperty(entree, "files", { value: [new File(["x"], "sauvegarde.zip")] });
    entree.dispatchEvent(new Event("change"));
    await vi.waitFor(() => expect(toasts.length).toBe(1));
    expect(toasts[0]).toContain("Sessions fermées : reconnectez-vous");
    expect(toasts[0]).toContain("refaites les suspensions et révocations faites depuis la sauvegarde");
  });
});
