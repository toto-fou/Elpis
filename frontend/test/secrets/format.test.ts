// SPDX-License-Identifier: MIT
/** frontend/test/secrets/format.test.ts — règles du coffre côté interface : actions par genre et propriétaire (secrets de connecteur gérés par leur page, mcp sans rotation, Vérifier pour tout importé), refus en français par code, portée affichée, dernier usage, slug et origines comme le serveur, corps de création et de modification, valeur exigée par un élargissement. */
import { describe, expect, it } from "vitest";

import {
  dernierUsage,
  droitsDe,
  estAttachable,
  formulaireDe,
  formulaireModifie,
  formulaireVide,
  messageSecret,
  nomValide,
  origineExacte,
  porteeTexte,
  resumeSecret,
  verdictFormulaire,
} from "../../src/features/secrets/format";
import { secret } from "./aides";

describe("actions permises", () => {
  it("compte : web-login, http-auth et token complets ; git et llm en rotation seule ; mcp en lecture seule", () => {
    const d = (kind: "web-login" | "http-auth" | "token" | "git" | "llm" | "mcp", state = "active") =>
      droitsDe(secret(1, { kind, state: state as "active" }), "compte");
    expect(d("web-login")).toEqual({
      rotation: true,
      modification: true,
      verification: false,
      suppression: true,
      gere: null,
    });
    expect(d("http-auth", "unverified").verification).toBe(true);
    expect(d("token").suppression).toBe(true);
    expect(d("git")).toEqual({
      rotation: true,
      modification: false,
      verification: false,
      suppression: false,
      gere: { cible: "connectors", libelle: "Comptes Git" },
    });
    expect(d("llm")).toMatchObject({ rotation: true, suppression: false, gere: { cible: "ai_models" } });
    expect(d("mcp")).toEqual({
      rotation: false,
      modification: false,
      verification: false,
      suppression: false,
      gere: { cible: "mcp", libelle: "Serveurs MCP" },
    });
  });

  it("compte : Vérifier pour tout secret importé, git compris (jetons de la sandbox repris) ; rien d'autre ne change", () => {
    const git = droitsDe(secret(1, { kind: "git", state: "unverified", scope: { host: "g.lan" } }), "compte");
    expect(git).toMatchObject({
      verification: true,
      rotation: true,
      suppression: false,
      modification: false,
    });
    expect(droitsDe(secret(1, { kind: "mcp", state: "unverified" }), "compte").verification).toBe(true);
  });

  it("instance : secrets de connecteur (llm, mcp, git, moteur d'images) sans suppression, mcp sans rotation ; renvoi gardé", () => {
    const d = (o: Parameters<typeof secret>[1]) =>
      droitsDe(secret(1, { owner: "instance", ...o }), "instance");
    expect(d({ kind: "llm" })).toEqual({
      rotation: true,
      modification: false,
      verification: false,
      suppression: false,
      gere: { cible: "inference", libelle: "Inférence" },
    });
    expect(d({ kind: "mcp" })).toEqual({
      rotation: false,
      modification: false,
      verification: false,
      suppression: false,
      gere: { cible: "mcp", libelle: "Outils MCP" },
    });
    expect(d({ kind: "git" })).toMatchObject({ rotation: true, suppression: false });
    expect(d({ kind: "token", name: "image-engine" })).toMatchObject({
      rotation: true,
      suppression: false,
      gere: { cible: "images", libelle: "Images" },
    });
    expect(d({ kind: "token", name: "autre" })).toMatchObject({ suppression: true, gere: null });
    expect(d({ kind: "web-login", state: "unverified" })).toMatchObject({
      suppression: true,
      verification: false,
    });
  });

  it("refus par code : une ligne en français, nom cité en tête ; code inconnu : rien (le détail anglais servira)", () => {
    expect(messageSecret("secret_managed", "Secret 'llm-a' is managed by its connector.")).toBe(
      "llm-a : géré par son connecteur : à modifier depuis sa page.",
    );
    expect(messageSecret("secret_unknown", "No secret with id 5.")).toBe(
      "Secret introuvable (supprimé ailleurs ?).",
    );
    expect(messageSecret("secret_name_taken", "A secret named 'x' already exists.")).toBe(
      "x : nom déjà pris.",
    );
    expect(messageSecret("secret_autre", "Other.")).toBeNull();
    expect(messageSecret(null, "Other.")).toBeNull();
  });

  it("attachable : web-login ou http-auth, vérifié", () => {
    expect(estAttachable(secret(1))).toBe(true);
    expect(estAttachable(secret(1, { kind: "http-auth" }))).toBe(true);
    expect(estAttachable(secret(1, { state: "unverified" }))).toBe(false);
    expect(estAttachable(secret(1, { kind: "token", scope: {} }))).toBe(false);
  });
});

describe("affichage", () => {
  it("portée : origines, hôte, connecteur, serveur ; rien pour un jeton", () => {
    expect(porteeTexte(secret(1, { scope: { origins: ["https://a.lan", "https://b.lan:8443"] } }))).toEqual([
      "https://a.lan",
      "https://b.lan:8443",
    ]);
    expect(porteeTexte(secret(1, { kind: "git", scope: { host: "git.example.lan:3000" } }))).toEqual([
      "git.example.lan:3000",
    ]);
    expect(porteeTexte(secret(1, { kind: "llm", scope: { connector_id: 4 } }))).toEqual(["connector_id=4"]);
    expect(porteeTexte(secret(1, { kind: "mcp", scope: { server: "srv-1" } }))).toEqual(["server=srv-1"]);
    expect(porteeTexte(secret(1, { kind: "token", scope: {} }))).toEqual([]);
  });

  it("résumé d'une ligne de menu : genre, première origine (+n), identifiant ; jamais de valeur", () => {
    const s = secret(1, { scope: { origins: ["https://a.lan", "https://idp.lan"] }, username: "svc" });
    expect(resumeSecret(s)).toBe("web-login · https://a.lan +1 · user=svc");
    expect(resumeSecret(secret(2, { kind: "token", scope: {}, username: null }))).toBe("token");
  });

  it("dernier usage compact ; jamais utilisé : tiret", () => {
    const t = 1_800_000_000;
    expect(dernierUsage(null, t)).toBe("—");
    expect(dernierUsage(t - 30, t)).toBe("< 1 min");
    expect(dernierUsage(t - 180, t)).toBe("3 min");
    expect(dernierUsage(t - 7200, t)).toBe("2 h");
    expect(dernierUsage(t - 5 * 86400, t)).toBe("5 j");
  });
});

describe("formulaire", () => {
  it("slug strict et origines exactes, comme le serveur", () => {
    expect(["intranet-admin", "a", "proxy.basic_2"].every(nomValide)).toBe(true);
    expect(["Intranet", "-a", "", "a".repeat(49), "nom avec espace"].some(nomValide)).toBe(false);
    expect(origineExacte(" HTTPS://Intranet.Example.lan:443 ")).toBe("https://intranet.example.lan");
    expect(origineExacte("https://intranet.example.lan:8443")).toBe("https://intranet.example.lan:8443");
    for (const faux of ["https://a.lan/login", "https://u:p@a.lan", "ftp://a.lan", "https://a.lan?", "a.lan"])
      expect(origineExacte(faux)).toBeNull();
  });

  it("création : erreurs de champ, puis corps complet (portée normalisée, politique sans confirm_first_use)", () => {
    const f = formulaireVide("web-login");
    expect(verdictFormulaire(f).erreurs).toEqual({
      name: "slug [a-z0-9][a-z0-9._-]{0,47}",
      origins: "une origine au moins",
      value: "valeur requise",
    });
    Object.assign(f, {
      name: "intranet-admin",
      origins:
        "https://Intranet.example.lan:8443\nhttps://idp.example.lan/\n\nhttps://intranet.example.lan:8443",
      username: " admin ",
      value: "p4ss",
      tls: "insecure",
      routines: true,
    });
    expect(verdictFormulaire(f).corps).toEqual({
      kind: "web-login",
      scope: { origins: ["https://intranet.example.lan:8443", "https://idp.example.lan"] },
      name: "intranet-admin",
      username: "admin",
      value: "p4ss",
      policy: { tls: "insecure", subagents: true, routines: true },
    });
    f.origins = "https://intranet.example.lan/login";
    expect(verdictFormulaire(f).erreurs.origins).toBe(
      "origine invalide : https://intranet.example.lan/login",
    );
  });

  it("création d'un jeton : aucune portée envoyée", () => {
    const f = { ...formulaireVide("token"), name: "ci-token", value: "t" };
    expect(verdictFormulaire(f).corps).toEqual({
      kind: "token",
      name: "ci-token",
      username: null,
      value: "t",
      policy: { tls: "strict", subagents: true, routines: false },
    });
  });

  it("modification : seuls les champs changés partent, valeur vide = inchangée", () => {
    const f = formulaireDe(secret(5, { name: "intranet", username: "admin" }));
    expect(formulaireModifie(f)).toBe(false);
    expect(verdictFormulaire(f).corps).toEqual({});
    f.username = "root";
    f.subagents = false;
    expect(formulaireModifie(f)).toBe(true);
    expect(verdictFormulaire(f).corps).toEqual({
      username: "root",
      policy: { tls: "strict", subagents: false, routines: false },
    });
  });

  it("élargir la portée ou passer en tls insecure exige la valeur ; la restreindre, non", () => {
    const base = secret(5, {
      scope: { origins: ["https://a.lan", "https://b.lan"] },
    });
    const restreinte = { ...formulaireDe(base), origins: "https://a.lan" };
    expect(verdictFormulaire(restreinte)).toMatchObject({
      valeurExigee: null,
      corps: { scope: { origins: ["https://a.lan"] } },
    });
    const elargie = { ...formulaireDe(base), origins: "https://a.lan\nhttps://c.lan" };
    expect(verdictFormulaire(elargie)).toMatchObject({
      valeurExigee: "valeur requise : portée élargie",
      erreurs: { value: "valeur requise : portée élargie" },
      corps: null,
    });
    expect(verdictFormulaire({ ...elargie, value: "neuve" }).corps).toEqual({
      scope: { origins: ["https://a.lan", "https://c.lan"] },
      value: "neuve",
    });
    const insecure = { ...formulaireDe(base), tls: "insecure" as const };
    expect(verdictFormulaire(insecure).valeurExigee).toBe("valeur requise : tls insecure");
  });
});
