// SPDX-License-Identifier: MIT
/** frontend/test/secrets/api.test.ts — client du coffre : routes du compte et de la console, corps envoyés, réponses validées par le contrat, refus rendus par leur `detail` et leur code `secret_*`. */
import { describe, expect, it } from "vitest";

import { fauxServeur, json, refus, secret } from "./aides";

describe("client du coffre", () => {
  it("compte et instance : chaque action va à sa racine, avec la méthode et le corps du contrat", async () => {
    const s = secret(3);
    const { api, appels } = fauxServeur((url, methode) =>
      methode === "GET"
        ? json({ secrets: [s] })
        : methode === "DELETE"
          ? json({ ok: true })
          : json({ secret: s }),
    );
    expect(await api.lister("compte")).toEqual({ ok: true, valeur: [s] });
    await api.lister("instance");
    await api.tourner("compte", 3, "v2");
    await api.tourner("instance", 3, "v3");
    await api.supprimer("instance", 3);
    await api.verifier(3);
    await api.modifier(3, { username: "root" });
    await api.creer({ kind: "token", name: "ci", value: "x", username: null });
    expect(appels.map((a) => [a.methode, a.url, a.corps])).toEqual([
      ["GET", "/api/secrets", undefined],
      ["GET", "/api/admin/secrets", undefined],
      ["POST", "/api/secrets/3/rotate", { value: "v2" }],
      ["POST", "/api/admin/secrets/3/rotate", { value: "v3" }],
      ["DELETE", "/api/admin/secrets/3", undefined],
      ["POST", "/api/secrets/3/verify", undefined],
      ["PUT", "/api/secrets/3", { username: "root" }],
      ["POST", "/api/secrets", { kind: "token", name: "ci", value: "x", username: null }],
    ]);
  });

  it("conversation : lecture et remplacement de l'ensemble attaché (ids), chemin encodé", async () => {
    const { api, appels } = fauxServeur(() => json({ secrets: [secret(1)] }));
    expect(await api.attaches("c 1")).toMatchObject({ ok: true, valeur: [{ id: 1 }] });
    await api.attacher("c 1", [1, 2]);
    expect(appels.map((a) => [a.methode, a.url, a.corps])).toEqual([
      ["GET", "/api/chats/c%201/secrets", undefined],
      ["PUT", "/api/chats/c%201/secrets", { ids: [1, 2] }],
    ]);
  });

  it("refus : message français par code (nom cité en tête), même pour une erreur 5xx ; code gardé", async () => {
    const { api } = fauxServeur((url, methode) =>
      url.endsWith("/rotate")
        ? refus(503, "secret_key_unavailable", "The vault key is unavailable on this server.")
        : methode === "DELETE"
          ? refus(409, "secret_managed", "Secret 'llm-shared' is managed by its connector.")
          : refus(422, "secret_unverified", "Secret 'ax' is unverified."),
    );
    expect(await api.attacher("c1", [4])).toEqual({
      ok: false,
      message: "ax : unverified, à vérifier dans Paramètres › Secrets.",
      code: "secret_unverified",
    });
    expect(await api.tourner("compte", 4, "v")).toEqual({
      ok: false,
      message: "Clé du coffre indisponible sur le serveur (./elpis doctor).",
      code: "secret_key_unavailable",
    });
    expect(await api.supprimer("instance", 4)).toEqual({
      ok: false,
      message: "llm-shared : géré par son connecteur : à modifier depuis sa page.",
      code: "secret_managed",
    });
  });

  it("code inconnu : le `detail` anglais du serveur, faute de mieux", async () => {
    const { api } = fauxServeur(() => refus(400, "secret_new_thing", "Something new."));
    expect(await api.verifier(1)).toEqual({ ok: false, message: "Something new.", code: "secret_new_thing" });
  });

  it("réponse hors contrat ou sans détail : message générique, aucun secret inventé", async () => {
    const { api } = fauxServeur((url) =>
      url === "/api/secrets" ? json({ secrets: [{ id: "x" }] }) : new Response("boom", { status: 500 }),
    );
    expect(await api.lister("compte")).toMatchObject({ ok: false, message: "Réponse serveur invalide" });
    expect(await api.verifier(1)).toMatchObject({
      ok: false,
      message: "Erreur serveur (HTTP 500)",
      code: null,
    });
  });
});
