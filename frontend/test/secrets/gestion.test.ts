// SPDX-License-Identifier: MIT
/** frontend/test/secrets/gestion.test.ts — table des secrets : liste triée (vidée sur refus, déconnexion ou autre compte, dernière lecture seule retenue), menu, rotation, vérification, création et modification (corps minimal), suppression confirmée sur place (garde du double-clic), refus en français sous la ligne, Échap par couches avec accord avant de jeter une saisie. */
import { describe, expect, it, vi } from "vitest";

import { creerGestionSecrets, GARDE_CONFIRMATION_MS } from "../../src/features/secrets/gestion";
import type { PorteeCoffre } from "../../src/features/secrets/api";
import { fauxServeur, json, refus, secret } from "./aides";

function monter(
  route: Parameters<typeof fauxServeur>[0],
  o: { portee?: PorteeCoffre; maintenant?: () => number; accord?: boolean } = {},
) {
  const { api, appels } = fauxServeur(route);
  const toasts: string[] = [];
  const ouvrir = vi.fn();
  const notifier = vi.fn();
  const demanderAbandon = vi.fn(() => Promise.resolve(o.accord ?? true));
  const g = creerGestionSecrets({
    api,
    portee: o.portee ?? "compte",
    toast: (m) => toasts.push(m),
    ouvrir,
    notifier,
    demanderAbandon,
    ...(o.maintenant ? { maintenant: o.maintenant } : {}),
  });
  return { g, appels, toasts, ouvrir, notifier, demanderAbandon };
}

const LISTE = [secret(2, { name: "proxy" }), secret(1, { name: "intranet" })];

describe("liste et menu", () => {
  it("charge la liste triée par nom ; un refus vide la liste (aucune liste périmée à côté de l'erreur)", async () => {
    let echec = false;
    const { g } = monter(() =>
      echec ? refus(503, "secret_key_unavailable", "Vault key unavailable.") : json({ secrets: LISTE }),
    );
    await g.charger();
    expect(g.secrets.value.map((s) => s.name)).toEqual(["intranet", "proxy"]);
    expect(g.charge.value).toBe(true);
    echec = true;
    await g.charger();
    expect(g.erreurListe.value).toBe("Clé du coffre indisponible sur le serveur (./elpis doctor).");
    expect(g.secrets.value).toEqual([]);
    expect(g.charge.value).toBe(false);
  });

  it("compte : les secrets de connecteur (llm, mcp, git) restent dans leur menu ; la console les liste tous", async () => {
    const tous = [
      secret(1, { name: "intranet" }),
      secret(2, { name: "llm-moonshot-2", kind: "llm", scope: { connector_id: 2 } }),
      secret(3, { name: "git-gitea", kind: "git", scope: { host: "gitea.lan" } }),
      secret(4, { name: "mcp-docs", kind: "mcp", scope: { server: "docs" } }),
    ];
    const compte = monter(() => json({ secrets: tous }));
    await compte.g.charger();
    expect(compte.g.secrets.value.map((s) => s.name)).toEqual(["intranet"]);
    const instance = monter(() => json({ secrets: tous }), { portee: "instance" });
    await instance.g.charger();
    expect(instance.g.secrets.value).toHaveLength(4);
  });

  it("déconnexion ou autre compte : liste, saisies et lecture en vol oubliées", async () => {
    const { g } = monter(() => json({ secrets: LISTE }));
    await g.charger();
    g.nouveau();
    g.vider();
    expect([g.secrets.value, g.charge.value, g.creation.value, g.erreurListe.value]).toEqual([
      [],
      false,
      null,
      "",
    ]);
    let liberer: (() => void) | null = null;
    const { api } = fauxServeur(() => json({}));
    const lent = creerGestionSecrets({
      api: { ...api, lister: () => new Promise((r) => (liberer = () => r({ ok: true, valeur: LISTE }))) },
      portee: "compte",
    });
    const lecture = lent.charger();
    lent.vider();
    liberer!();
    await lecture;
    expect(lent.secrets.value).toEqual([]);
    expect(lent.chargement.value).toBe(false);
  });

  it("deux lectures croisées : seule la dernière demandée est retenue", async () => {
    const reponses: Array<() => void> = [];
    const listes = [[secret(1, { name: "ancien" })], LISTE];
    let n = 0;
    const { api } = fauxServeur(() => json({}));
    const g = creerGestionSecrets({
      api: {
        ...api,
        lister: () => {
          const valeur = listes[n++] ?? [];
          return new Promise((r) => reponses.push(() => r({ ok: true, valeur })));
        },
      },
      portee: "compte",
    });
    const p1 = g.charger();
    const p2 = g.charger();
    reponses[1]?.();
    await p2;
    reponses[0]?.();
    await p1;
    expect(g.secrets.value.map((s) => s.name)).toEqual(["intranet", "proxy"]);
    expect(g.chargement.value).toBe(false);
  });

  it("une action non permise par le genre n'ouvre rien ; « gérer » renvoie au connecteur", async () => {
    const { g, ouvrir } = monter(
      () => json({ secrets: [secret(7, { kind: "mcp", scope: { server: "srv" }, name: "mcp-srv" })] }),
      { portee: "instance" },
    );
    await g.charger();
    g.basculerMenu(7);
    expect(g.menu.value).toBe(7);
    g.choisir(7, "rotation");
    expect(g.panneau.value).toBeNull();
    expect(g.menu.value).toBeNull();
    g.choisir(7, "gerer");
    expect(ouvrir).toHaveBeenCalledWith("mcp");
  });
});

describe("rotation et vérification", () => {
  it("rotation : nouvelle valeur envoyée, ligne remplacée (version + 1), panneau refermé, avis aux autres vues", async () => {
    const { g, appels, toasts, notifier } = monter((url, methode) =>
      methode === "GET"
        ? json({ secrets: LISTE })
        : json({ secret: secret(1, { name: "intranet", version: 2 }) }),
    );
    await g.charger();
    g.choisir(1, "rotation");
    expect(g.panneau.value).toEqual({ id: 1, mode: "rotation" });
    await g.tourner(1);
    expect(appels).toHaveLength(1);
    g.valeurRotation.value = "n0uvelle";
    await g.tourner(1);
    expect(appels.at(-1)).toEqual({
      url: "/api/secrets/1/rotate",
      methode: "POST",
      corps: { value: "n0uvelle" },
    });
    expect(g.secrets.value.find((s) => s.id === 1)?.version).toBe(2);
    expect(g.panneau.value).toBeNull();
    expect(g.valeurRotation.value).toBe("");
    expect(toasts).toEqual(["intranet : version 2"]);
    expect(notifier).toHaveBeenCalledTimes(1);
  });

  it("rotation refusée : détail du serveur sous la ligne, valeur gardée", async () => {
    const { g } = monter((url, methode) =>
      methode === "GET"
        ? json({ secrets: LISTE })
        : refus(409, "secret_undecryptable", "Secret 'intranet' cannot be decrypted."),
    );
    await g.charger();
    g.choisir(1, "rotation");
    g.valeurRotation.value = "x";
    await g.tourner(1);
    expect(g.erreur.value).toEqual({
      cible: 1,
      message: "intranet : indéchiffrable avec la clé courante : rotation, ou ./elpis vault rekey.",
    });
    expect(g.panneau.value).toEqual({ id: 1, mode: "rotation" });
    expect(g.valeurRotation.value).toBe("x");
  });

  it("vérifier : seulement un secret unverified ; il devient active", async () => {
    const importe = secret(9, { kind: "http-auth", state: "unverified", name: "ax-intranet" });
    const { g, appels } = monter((url, methode) =>
      methode === "GET"
        ? json({ secrets: [importe, secret(1)] })
        : json({ secret: { ...importe, state: "active" } }),
    );
    await g.charger();
    g.choisir(1, "verifier");
    expect(g.panneau.value).toBeNull();
    g.choisir(9, "verifier");
    expect(g.panneau.value).toEqual({ id: 9, mode: "verifier" });
    await g.verifier(9);
    expect(appels.at(-1)).toMatchObject({ url: "/api/secrets/9/verify", methode: "POST" });
    expect(g.secrets.value.find((s) => s.id === 9)?.state).toBe("active");
  });
});

describe("création et modification", () => {
  it("création : rien ne part tant que le formulaire est faux ; puis POST et ligne ajoutée", async () => {
    const cree = secret(4, { name: "gitea-web" });
    const { g, appels } = monter((url, methode) =>
      methode === "GET" ? json({ secrets: LISTE }) : json({ secret: cree }),
    );
    await g.charger();
    g.nouveau();
    expect(await g.enregistrer(g.creation.value)).toBe(false);
    expect(appels).toHaveLength(1);
    Object.assign(g.creation.value!, {
      name: "gitea-web",
      origins: "https://gitea.example.lan",
      username: "ci",
      value: "s3cret",
    });
    expect(g.sale.value).toBe(true);
    expect(await g.enregistrer(g.creation.value)).toBe(true);
    expect(appels.at(-1)).toEqual({
      url: "/api/secrets",
      methode: "POST",
      corps: {
        kind: "web-login",
        scope: { origins: ["https://gitea.example.lan"] },
        name: "gitea-web",
        username: "ci",
        value: "s3cret",
        policy: { tls: "strict", subagents: true, routines: false },
      },
    });
    expect(g.creation.value).toBeNull();
    expect(g.secrets.value.map((s) => s.name)).toEqual(["gitea-web", "intranet", "proxy"]);
  });

  it("création refusée (nom pris) : détail du serveur sous le formulaire, saisie gardée", async () => {
    const { g } = monter((url, methode) =>
      methode === "GET"
        ? json({ secrets: [] })
        : refus(409, "secret_name_taken", "A secret named 'x' already exists."),
    );
    g.nouveau("token");
    Object.assign(g.creation.value!, { name: "x", value: "v" });
    expect(await g.enregistrer(g.creation.value)).toBe(false);
    expect(g.erreur.value).toEqual({ cible: "nouveau", message: "x : nom déjà pris." });
    expect(g.creation.value?.name).toBe("x");
  });

  it("modification : PUT des seuls champs changés ; inchangé : aucun appel", async () => {
    const { g, appels } = monter((url, methode) =>
      methode === "GET" ? json({ secrets: LISTE }) : json({ secret: secret(1, { name: "intranet-v2" }) }),
    );
    await g.charger();
    g.choisir(1, "modifier");
    expect(g.edition.value?.name).toBe("intranet");
    expect(await g.enregistrer(g.edition.value)).toBe(true);
    expect(appels).toHaveLength(1);
    g.choisir(1, "modifier");
    g.edition.value!.name = "intranet-v2";
    expect(await g.enregistrer(g.edition.value)).toBe(true);
    expect(appels.at(-1)).toEqual({ url: "/api/secrets/1", methode: "PUT", corps: { name: "intranet-v2" } });
    expect(g.secrets.value.map((s) => s.name)).toEqual(["intranet-v2", "proxy"]);
  });
});

describe("suppression confirmée sur place", () => {
  it("le même bouton arme puis confirme ; un double-clic ne vaut pas confirmation", async () => {
    let t = 1000;
    const { g, appels } = monter(
      (url, methode) => (methode === "GET" ? json({ secrets: LISTE }) : json({ ok: true })),
      { maintenant: () => t },
    );
    await g.charger();
    g.basculerMenu(1);
    await g.clicSupprimer(1);
    expect(g.confirmer.value).toBe(1);
    t += GARDE_CONFIRMATION_MS - 1;
    await g.clicSupprimer(1);
    expect(appels).toHaveLength(1);
    t += 1;
    await g.clicSupprimer(1);
    expect(appels.at(-1)).toMatchObject({ url: "/api/secrets/1", methode: "DELETE" });
    expect(g.secrets.value.map((s) => s.id)).toEqual([2]);
    expect(g.menu.value).toBeNull();
    expect(g.confirmer.value).toBeNull();
  });

  it("console : suppression par la route d'instance ; refus `secret_managed` dit en français sous la ligne", async () => {
    let t = 0;
    const { g, appels } = monter(
      (url, methode) =>
        methode === "GET"
          ? json({ secrets: [secret(5, { owner: "instance", name: "proxy-shared" })] })
          : refus(409, "secret_managed", "Secret 'proxy-shared' is managed by its connector."),
      { portee: "instance", maintenant: () => (t += 500) },
    );
    await g.charger();
    await g.clicSupprimer(5);
    await g.clicSupprimer(5);
    expect(appels.at(-1)).toMatchObject({ url: "/api/admin/secrets/5", methode: "DELETE" });
    expect(g.erreur.value).toEqual({
      cible: 5,
      message: "proxy-shared : géré par son connecteur : à modifier depuis sa page.",
    });
    expect(g.secrets.value).toHaveLength(1);
  });
});

describe("Échap par couches et sortie de la vue", () => {
  it("menu, puis confirmation, puis panneau, puis formulaire de création ; ensuite plus rien", async () => {
    const { g } = monter(() => json({ secrets: LISTE }));
    await g.charger();
    g.nouveau();
    g.choisir(1, "rotation");
    g.basculerMenu(2);
    expect(g.fermerCouche()).toBe(true);
    expect(g.menu.value).toBeNull();
    g.confirmer.value = 2;
    expect(g.fermerCouche()).toBe(true);
    expect(g.confirmer.value).toBeNull();
    expect(g.fermerCouche()).toBe(true);
    expect(g.panneau.value).toBeNull();
    expect(g.fermerCouche()).toBe(true);
    expect(g.creation.value).toBeNull();
    expect(g.fermerCouche()).toBe(false);
  });

  it("Échap sur une saisie faite : accord demandé d'abord ; refusé, rien n'est jeté ; saisie vide : fermée sans question", async () => {
    const refuse = monter(() => json({ secrets: LISTE }), { accord: false });
    refuse.g.nouveau();
    expect(refuse.g.fermerCouche()).toBe(true);
    expect(refuse.demanderAbandon).not.toHaveBeenCalled();
    expect(refuse.g.creation.value).toBeNull();
    refuse.g.nouveau();
    refuse.g.creation.value!.name = "brouillon";
    expect(refuse.g.fermerCouche()).toBe(true);
    await Promise.resolve();
    expect(refuse.demanderAbandon).toHaveBeenCalledTimes(1);
    expect(refuse.g.creation.value?.name).toBe("brouillon");
    const accepte = monter(() => json({ secrets: LISTE }), { accord: true });
    await accepte.g.charger();
    accepte.g.choisir(1, "rotation");
    accepte.g.valeurRotation.value = "n0uvelle";
    expect(accepte.g.fermerCouche()).toBe(true);
    await Promise.resolve();
    await Promise.resolve();
    expect(accepte.g.panneau.value).toBeNull();
    expect(accepte.g.valeurRotation.value).toBe("");
  });

  it("vue quittée : menus, panneaux, saisies et erreurs effacés", async () => {
    const { g } = monter(() => json({ secrets: LISTE }));
    await g.charger();
    g.choisir(1, "rotation");
    g.valeurRotation.value = "x";
    g.nouveau();
    g.reinitialiserVue();
    expect([g.panneau.value, g.creation.value, g.valeurRotation.value, g.sale.value]).toEqual([
      null,
      null,
      "",
      false,
    ]);
  });
});
