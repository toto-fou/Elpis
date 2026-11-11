// SPDX-License-Identifier: MIT
/** frontend/test/studio/suppression.test.ts — suppression d'un script du Studio : annulable quand une copie existe, confirmée sinon ou quand des modifications sont ouvertes. */
import { describe, expect, it } from "vitest";

import { creerAutomatisationStudio } from "../../src/features/studio/automatisation";

interface Toast {
  message: string;
  actionLabel?: string;
  onAction?: () => void;
}

function monter(opts: { copie: boolean; confirmer?: boolean }) {
  const appels: string[] = [];
  const toasts: Toast[] = [];
  const confirmations: string[] = [];
  const surface = creerAutomatisationStudio(
    {
      fetchAuth: (url, init) => {
        appels.push(`${init?.method ?? "GET"} ${url}`);
        if (url.startsWith("/api/sandbox/serve/")) {
          return Promise.resolve(opts.copie ? new Response("print(1)") : new Response("", { status: 404 }));
        }
        if (url === "/api/sandbox/tree") return Promise.resolve(new Response(JSON.stringify({ items: [] })));
        return Promise.resolve(new Response("{}"));
      },
      showToast: (message, _type, o) => void toasts.push({ message, ...o }),
      openConfirm: (titre) => (confirmations.push(titre), Promise.resolve(opts.confirmer ?? true)),
    },
    null,
    null,
  );
  return { surface, appels, toasts, confirmations };
}

const SCRIPT = { slug: "export-balance", name: "export balance", path: "automations/export-balance.py" };

describe("suppression d'un script du Studio", () => {
  it("supprime sans question quand une copie existe, puis propose Annuler qui restaure", async () => {
    const { surface, appels, toasts, confirmations } = monter({ copie: true });
    await surface.autoDelete(SCRIPT);
    expect(confirmations).toEqual([]);
    expect(appels.some((a) => a.startsWith("DELETE /api/sandbox/delete"))).toBe(true);
    const t = toasts.find((x) => x.actionLabel === "Annuler");
    expect(t?.message).toContain("export balance");
    t?.onAction?.();
    await new Promise((r) => setTimeout(r, 0));
    expect(appels).toContain("POST /api/sandbox/save");
  });

  it("demande confirmation quand la copie est introuvable et ne supprime pas si on refuse", async () => {
    const { surface, appels, confirmations } = monter({ copie: false, confirmer: false });
    await surface.autoDelete(SCRIPT);
    expect(confirmations).toEqual(["Supprimer ce script ?"]);
    expect(appels.some((a) => a.startsWith("DELETE"))).toBe(false);
  });

  it("confirme aussi quand le script ouvert a des modifications non enregistrées", async () => {
    const { surface, confirmations, appels } = monter({ copie: true, confirmer: false });
    surface.autoCurrent.value = SCRIPT.slug;
    surface.autoDirty.value = true;
    await surface.autoDelete(SCRIPT);
    expect(confirmations).toHaveLength(1);
    expect(appels.some((a) => a.startsWith("DELETE"))).toBe(false);
  });
});
