// SPDX-License-Identifier: MIT
/** frontend/test/admin/journal-securite-vue.test.ts — onglet Journaux › Sécurité monté : lignes, mention de résultats partiels, lignes illisibles, tiroir de détail en JSON indenté. */
import { createApp, defineComponent, h, nextTick, proxyRefs } from "vue";
import type { App } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";

import OngletJournalSecurite from "../../src/components/admin/OngletJournalSecurite.vue";
import { CLE_ADMIN } from "../../src/features/admin/domaine";
import type { DomaineAdmin } from "../../src/features/admin/domaine";
import { json } from "../aides";
import { etatJournal, evenement, monter, page, verification } from "./journal-securite-aide";

let app: App | null = null;
const bouton = (parent: ParentNode, texte: string): HTMLButtonElement | undefined =>
  [...parent.querySelectorAll("button")].find((b) => b.textContent?.includes(texte));
afterEach(() => {
  app?.unmount();
  app = null;
  document.body.innerHTML = "";
});

async function monterOnglet(budget: boolean) {
  const { A } = monter((url) => {
    if (url === "/api/admin/audit/status")
      return json(
        etatJournal({ alerts: [{ id: "a", level: "warn", title: "Disque", detail: "bientôt plein" }] }),
      );
    const lignes = Array.from({ length: budget ? 1 : 3 }, (_, i) =>
      evenement(i + 1, i === 0 ? { details: { cle: "valeur", n: { a: 1 } } } : {}),
    );
    return json(page(lignes, budget ? { cursor: "c1", budget_reached: true, unreadable: 2 } : {}));
  });
  const racine = document.createElement("div");
  document.body.appendChild(racine);
  const adm = proxyRefs({ ...A, goAdminPage: () => Promise.resolve(true) }) as unknown as DomaineAdmin;
  app = createApp(defineComponent({ setup: () => () => h(OngletJournalSecurite) }));
  app.provide(CLE_ADMIN, adm);
  app.mount(racine);
  await A.loadJournalSecurite();
  await vi.waitFor(() => {
    expect(racine.textContent).toContain("Conservation");
    expect(racine.querySelectorAll("tbody tr.sup-ligne").length).toBeGreaterThan(0);
  });
  return { A, racine };
}

describe("onglet Sécurité monté", () => {
  it("bandeau, lignes, mention partielle et lignes illisibles", async () => {
    const { racine } = await monterOnglet(true);
    expect(racine.querySelectorAll("tbody tr.sup-ligne")).toHaveLength(8);
    expect(racine.textContent).toContain("résultats partiels");
    expect(racine.textContent).toContain("16 lignes illisibles sautées");
    expect(racine.textContent).toContain("bientôt plein");
    expect(racine.textContent).toContain("Conservation");
    expect(bouton(racine, "Plus ancien")?.disabled).toBe(false);
  });

  it("sans budget atteint : pas de mention partielle, « Plus ancien » désactivé", async () => {
    const { racine } = await monterOnglet(false);
    expect(racine.textContent).not.toContain("résultats partiels");
    expect(bouton(racine, "Plus ancien")?.disabled).toBe(true);
  });

  it("clic sur une ligne : tiroir avec details en JSON indenté", async () => {
    const { racine } = await monterOnglet(false);
    (racine.querySelector("tbody tr.sup-ligne") as HTMLElement).click();
    await nextTick();
    const pre = document.body.querySelector("aside.sup-secu-tiroir pre");
    expect(pre?.textContent).toBe(JSON.stringify({ cle: "valeur", n: { a: 1 } }, null, 2));
    expect(document.body.querySelector("aside.sup-secu-tiroir")?.textContent).toContain("UTC");
  });

  it("tiroir : focus dedans à l'ouverture, Échap ferme sans clic préalable, focus rendu à la ligne", async () => {
    const { racine } = await monterOnglet(false);
    const ligne = racine.querySelector("tbody tr.sup-ligne") as HTMLElement;
    ligne.focus();
    ligne.click();
    await vi.waitFor(() => expect(document.activeElement?.matches("aside.sup-secu-tiroir")).toBe(true));
    document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await vi.waitFor(() => expect(document.body.querySelector("aside.sup-secu-tiroir")).toBeNull());
    await vi.waitFor(() => expect(document.activeElement).toBe(ligne));
  });

  it("modale d'export : focus dedans, Échap ferme, focus rendu à « Exporter »", async () => {
    const { racine } = await monterOnglet(false);
    const exporter = racine.querySelector("#secu-exporter") as HTMLElement;
    exporter.focus();
    exporter.click();
    await vi.waitFor(() => expect(document.activeElement?.getAttribute("role")).toBe("dialog"));
    document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await vi.waitFor(() => expect(document.body.querySelector("[role=dialog]")).toBeNull());
    await vi.waitFor(() => expect(document.activeElement).toBe(exporter));
  });

  it("« Ce compte » filtre par user_id ; le kid de la ligne est affiché", async () => {
    const { A, racine } = await monterOnglet(false);
    (racine.querySelector("tbody tr.sup-ligne") as HTMLElement).click();
    await vi.waitFor(() => expect(document.body.querySelector("aside.sup-secu-tiroir")).not.toBeNull());
    expect(document.body.querySelector("aside.sup-secu-tiroir")?.textContent).toContain("abcd1234");
    bouton(document.body, "Ce compte")?.click();
    await vi.waitFor(() => expect(A.secuFiltres.value.compte).toBe("1"));
  });

  it("vérification fermée : le focus revient sur « Vérifier l'intégrité »", async () => {
    const { A, racine } = await monterOnglet(false);
    A.secuVerification.value = { statut: "erreur", message: "x" };
    await nextTick();
    (racine.querySelector("button[aria-label='Fermer le résultat']") as HTMLElement).click();
    await vi.waitFor(() => expect(document.activeElement?.id).toBe("secu-verifier"));
  });

  it("anomalies : au plus 20 lignes par catégorie dans le DOM, alerte sur l'en-tête seulement", async () => {
    const { A, racine } = await monterOnglet(false);
    A.secuVerification.value = {
      statut: "resultat",
      du: "2026-11-01",
      au: "2026-11-07",
      resultat: verification({
        status: "anomalies",
        invalid_signatures: Array.from({ length: 100 }, (_, i) => ({ file: "f.jsonl", line: i + 1 })),
        totals: { ...verification().totals, invalid_signatures: 100 },
      }),
    };
    await nextTick();
    expect(racine.querySelectorAll(".sup-secu-verif__liste li")).toHaveLength(21);
    expect(racine.textContent).toContain("et 80 autres lignes");
    expect(racine.querySelectorAll("[role=alert]").length).toBe(1);
    expect(racine.querySelector("section.sup-secu-verif")?.getAttribute("role")).toBeNull();
  });
});
