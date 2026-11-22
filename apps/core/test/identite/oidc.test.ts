// SPDX-License-Identifier: MIT
/** apps/core/test/identite/oidc.test.ts — lecture des revendications (jamais d'accès par le prototype), suite OAuth admise, document de découverte retenu clé par clé. */
import { describe, expect, it } from "vitest";

import { oauthNextAdmis } from "../../src/identite/oidc/depart";
import { lireMetadonnees, USERINFO_HORS_ORIGINE } from "../../src/identite/oidc/metadonnees";
import { pageRetour } from "../../src/identite/oidc/page";
import {
  appartenanceDe,
  emailVerifieDe,
  groupeRequisSeulDe,
  groupesDe,
  lireRevendication,
  secondFacteurSatisfait,
  sujetDe,
} from "../../src/identite/oidc/revendications";
import { validerFournisseur } from "../../src/identite/reglages";
import type { Fournisseur } from "../../src/identite/reglages";
import { oidcValide } from "./aides";

const f = (extra: Record<string, unknown> = {}): Fournisseur =>
  validerFournisseur(oidcValide({ required_groups: ["elpis"], ...extra })) as Fournisseur;

describe("revendications", () => {
  it("ne lisent que des propriétés propres, jamais celles du prototype", () => {
    const claims = JSON.parse('{"a":{"b":1},"__proto__":{"x":1},"constructor":"c"}') as Record<
      string,
      unknown
    >;
    expect(lireRevendication({}, "constructor")).toBeUndefined();
    expect(lireRevendication({}, "__proto__.x")).toBeUndefined();
    expect(lireRevendication({ a: {} }, "a.toString")).toBeUndefined();
    expect(lireRevendication(claims, "a.b")).toBe(1);
    expect(lireRevendication({ "realm_access.roles": ["x"] }, "realm_access.roles")).toEqual(["x"]);
  });

  it("noms de revendication de prototype refusés par les réglages", () => {
    for (const nom of ["constructor", "__proto__", "a.__proto__", "toString"])
      expect(() => f({ groups_claim: nom }), nom).toThrow();
  });

  it("sujet : chaîne non vide de 255 caractères au plus", () => {
    expect(sujetDe({ sub: "a" }, f())).toBe("a");
    for (const sub of ["", "a".repeat(256), 5, null, ["a"], undefined])
      expect(sujetDe({ sub }, f()), String(sub)).toBeNull();
    expect(sujetDe({ sub: "\ud800" }, f())).toBeNull();
  });

  it("groupes : liste de chaînes, sinon inconnus ; appartenance oui, non ou inconnu", () => {
    expect(groupesDe({ groups: ["a", "elpis"] }, f())).toEqual(["a", "elpis"]);
    expect(groupesDe({ groups: [] }, f())).toEqual([]);
    for (const groups of [undefined, "autre", "", "elpis;x", " elpis", [1], {}, null])
      expect(groupesDe({ groups }, f())).toBeNull();
    expect(groupesDe({ groups: ["elpis"], hasgroups: true }, f())).toBeNull();
    expect(groupesDe({ groups: ["elpis"], _claim_names: { groups: "s" } }, f())).toBeNull();
    expect(appartenanceDe(["elpis"], f())).toBe("oui");
    expect(appartenanceDe([], f())).toBe("non");
    expect(appartenanceDe(null, f())).toBe("inconnu");
  });

  it("groupes : une chaîne n'est jamais une liste ; seule une chaîne exactement égale à un groupe REQUIS prouve l'appartenance, sans découpage ni rognage", () => {
    const g = f({ required_groups: ["elpis", "equipe a;b"] });
    for (const v of ["elpis", "equipe a;b", "adm", "mod", "carte", "elpis;adm"])
      expect(groupesDe({ groups: v }, g), v).toBeNull();
    for (const v of ["elpis", "equipe a;b"]) expect(groupeRequisSeulDe({ groups: v }, g), v).toBe(v);
    for (const v of ["", "adm", "mod", "carte", "elpis;adm", "elpis,adm", "ELPIS", "elpis ", "equipe a"])
      expect(groupeRequisSeulDe({ groups: v }, g), v).toBeNull();
    expect(groupeRequisSeulDe({ groups: ["elpis"] }, g)).toBeNull();
    expect(groupeRequisSeulDe({ groups: "elpis", hasgroups: true }, g)).toBeNull();
    const roles = f({ roles: { enabled: true, admin_groups: [], moderator_groups: ["mod"] } });
    const carte = f({ group_map: { enabled: true, map: [{ external: "carte", group_id: 3 }] } });
    for (const suivi of [roles, carte]) expect(groupeRequisSeulDe({ groups: "elpis" }, suivi)).toBeNull();
  });

  it("`acr` et `amr` : seules les valeurs réglées passent", () => {
    const g = f({ required_acr: ["mfa"], required_amr: ["otp"] });
    expect(secondFacteurSatisfait({ acr: "mfa", amr: ["otp"] }, g)).toBe(true);
    for (const claims of [
      { acr: "mfa" },
      { amr: ["otp"] },
      { acr: ["mfa"], amr: ["otp"] },
      { acr: "mfa", amr: "otp" },
    ])
      expect(secondFacteurSatisfait(claims, g)).toBe(false);
    expect(secondFacteurSatisfait({}, f())).toBe(true);
  });

  it("`amr` exigés comparés sans tenir compte de la casse, des deux côtés ; `acr` comparé exactement", () => {
    const g = f({ required_amr: ["OTP", "hwk"] });
    for (const amr of [["otp"], ["OTP"], ["pwd", "Otp"], ["HWK"]])
      expect(secondFacteurSatisfait({ amr }, g), amr.join()).toBe(true);
    for (const amr of [["pwd"], ["ot p"], []])
      expect(secondFacteurSatisfait({ amr }, g), amr.join()).toBe(false);
    const acr = f({ required_acr: ["Loa-5"] });
    expect(secondFacteurSatisfait({ acr: "Loa-5" }, acr)).toBe(true);
    expect(secondFacteurSatisfait({ acr: "loa-5" }, acr)).toBe(false);
  });

  it("e-mail : seulement si `email_verified` vaut vrai (booléen)", () => {
    expect(emailVerifieDe({ email: "a@b.c", email_verified: true }, f())).toBe("a@b.c");
    for (const v of [false, "true", 1, undefined])
      expect(emailVerifieDe({ email: "a@b.c", email_verified: v }, f())).toBe("");
  });
});

describe("suite OAuth admise", () => {
  it("`/oauth/authorize?…` seulement, sans `//`, sans contrôle ni espace ni barre inverse, 2 000 caractères au plus", () => {
    expect(oauthNextAdmis("/oauth/authorize?a=1&b=%2F")).toBe("/oauth/authorize?a=1&b=%2F");
    for (const v of [
      "//oauth/authorize?a",
      "/oauth/authorize",
      "http://x/oauth/authorize?a",
      "/oauth/authorize?a\n",
      "/oauth/authorize?a b",
      "/oauth/authorize?\\\\x",
      `/oauth/authorize?${"a".repeat(2000)}`,
      undefined,
      12,
    ])
      expect(oauthNextAdmis(v), String(v)).toBeNull();
  });
});

describe("document de découverte", () => {
  const ISS = "https://idp.exemple.lan/realms/elpis";
  const doc = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    issuer: ISS,
    authorization_endpoint: "https://login.exemple.lan/auth",
    token_endpoint: `${ISS}/token`,
    jwks_uri: `${ISS}/certs`,
    end_session_endpoint: "https://pirate.exemple.lan/out",
    introspection_endpoint: "https://pirate.exemple.lan/i",
    ...extra,
  });

  it("n'en garde que ce qui sert : rien d'autre ne traverse", () => {
    const v = lireMetadonnees(doc(), ISS);
    expect(v.ok && Object.keys(v.metadonnees).sort()).toEqual(
      ["authorization_endpoint", "issuer", "jwks_uri", "token_endpoint"].sort(),
    );
  });

  it("refus : émetteur différent, point d'accès absent, http, autre origine, données imbriquées de prototype", () => {
    const refus = [
      doc({ issuer: `${ISS}/` }),
      doc({ token_endpoint: undefined }),
      doc({ authorization_endpoint: "http://login.exemple.lan/auth" }),
      doc({ token_endpoint: "https://autre.exemple.lan/token" }),
      doc({ jwks_uri: "https://user:mdp@idp.exemple.lan/certs" }),
      doc({ userinfo_endpoint: "http://idp.exemple.lan/u" }),
      doc({ userinfo_endpoint: 5 }),
      doc({ pushed_authorization_request_endpoint: "https://autre.exemple.lan/par" }),
      [],
      null,
      "texte",
    ];
    for (const d of refus) expect(lireMetadonnees(d, ISS).ok, JSON.stringify(d)).toBe(false);
  });

  it("point d'information hors de l'origine : non retenu et signalé, sans refuser le document ; sur l'origine : retenu", () => {
    const hors = lireMetadonnees(doc({ userinfo_endpoint: "https://autre.exemple.lan/u" }), ISS);
    expect(hors.ok && hors.metadonnees.userinfo_endpoint).toBeUndefined();
    expect(hors.ok && hors.metadonnees[USERINFO_HORS_ORIGINE]).toBe(true);
    expect(JSON.stringify(hors)).not.toContain("autre.exemple.lan");
    const sur = lireMetadonnees(doc({ userinfo_endpoint: `${ISS}/userinfo` }), ISS);
    expect(sur.ok && sur.metadonnees.userinfo_endpoint).toBe(`${ISS}/userinfo`);
    expect(sur.ok && sur.metadonnees[USERINFO_HORS_ORIGINE]).toBeUndefined();
  });

  it("l'émetteur n'est jamais lu depuis le prototype", () => {
    expect(lireMetadonnees(Object.create({ issuer: ISS }), ISS).ok).toBe(false);
  });
});

describe("page de retour", () => {
  it("échappe la cible et ne porte aucun script", () => {
    const p = pageRetour('/?a="><script>x</script>&b=1');
    expect(p).not.toMatch(/<script|<style/iu);
    expect(p).toContain("&quot;&gt;&lt;script&gt;");
    expect(p).toContain('http-equiv="refresh"');
  });
});
