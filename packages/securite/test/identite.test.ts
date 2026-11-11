// SPDX-License-Identifier: MIT
/** packages/securite/test/identite.test.ts — enveloppes Python vérifiées, reproduites à l'octet près du type ajouté ; audience refusée ; registre. */
import { afterEach, describe, expect, it } from "vitest";

import {
  avecIdentite,
  creerIdentite,
  current,
  DELEGATION_AUDIENCE,
  forgetAll,
  fromMeta,
  identityAsRow,
  identityFromDict,
  identityToDict,
  remember,
  resolveForcedNetworkProfileId,
  resolveNetworkProfileId,
  resolveUser,
  resolveUsername,
  sign,
  signClaims,
  userIdFor,
  usernameFor,
  userNetworkProfileId,
  verify,
  verifyClaims,
} from "../src/identite";
import type { ChampsIdentite, Identity } from "../src/identite";
import { brancherComptes } from "../src/ports";
import type { ComptesEnBase } from "../src/ports";
import { attendu, essai, flottant, vecteurs } from "./aides";

const NOW = vecteurs.maintenant;

function versDict(identite: Identity | null): Record<string, unknown> | null {
  return identite === null ? null : identityToDict(identite);
}

/** Charge (JSON) d'une enveloppe `<charge b64>.<signature>`. */
const charge = (e: string): string => Buffer.from(e.split(".")[0] ?? "", "base64url").toString("utf8");

/** Écart voulu au Python : `sign` ajoute `"typ":"identite"` (clés triées, entre `ts` et `user_id`). */
const typee = (chargePython: string): string =>
  chargePython.replace(',"user_id":', ',"typ":"identite","user_id":');

/** Vrai si la charge porte une audience : enveloppe de revendications, refusée par `verify` (écart voulu). */
function porteAudience(e: string): boolean {
  try {
    const corps: unknown = JSON.parse(charge(e));
    return typeof corps === "object" && corps !== null && Object.hasOwn(corps, "aud");
  } catch {
    return false;
  }
}

afterEach(() => {
  forgetAll();
  brancherComptes(null);
});

describe("enveloppes x-elpis-identity signées par Python (relues telles quelles ; signées en TS avec leur type)", () => {
  for (const [i, cas] of vecteurs.identite.signatures.entries()) {
    const nom = `${i} ${JSON.stringify(cas.identite["username"])} clé ${cas.cle.length} ts ${JSON.stringify(cas.now)}`;
    it(nom, () => {
      const now = flottant(cas.now) as number;
      const identite = creerIdentite(cas.identite as unknown as ChampsIdentite);
      const signee = sign(identite, cas.cle, { now });
      expect(charge(signee)).toBe(typee(charge(cas.entete)));
      if (Number.isFinite(now))
        expect(versDict(verify(signee, cas.cle, { now }))).toEqual(
          versDict(verify(cas.entete, cas.cle, { now })),
        );
      for (const v of cas.verifications) {
        const options =
          v.skew === undefined ? { now: now + v.ecart } : { now: now + v.ecart, maxSkewS: v.skew };
        expect(versDict(verify(cas.entete, cas.cle, options))).toEqual(v.sortie);
      }
    });
  }

  for (const cas of vecteurs.identite.signatures_refusees) {
    it(`refuse de signer avec la clé ${JSON.stringify(cas.cle)}`, () => {
      const obtenu = cas.identite
        ? essai(() => sign(creerIdentite(cas.identite as unknown as ChampsIdentite), cas.cle, { now: NOW }))
        : essai(() => signClaims(cas.revendications ?? {}, cas.cle, { aud: DELEGATION_AUDIENCE, now: NOW }));
      expect(obtenu).toEqual(attendu(cas));
    });
  }

  it("un `ts` NaN (jamais émis par sign) : JSON.parse refuse le corps côté TS", () => {
    const entete = vecteurs.identite.signatures.find((c) => Number.isNaN(flottant(c.now)))?.entete ?? "";
    expect(entete).not.toBe("");
    expect(verify(entete, "svc", { now: NOW })).toBeNull();
  });
});

describe("en-têtes forgés, altérés ou exotiques : même verdict que verify() (audience refusée, écart voulu)", () => {
  for (const cas of vecteurs.identite.verifications) {
    it(cas.nom, () => {
      const voulu = porteAudience(cas.entete) ? { sortie: null } : attendu(cas);
      expect(essai(() => versDict(verify(cas.entete, cas.cle, { now: NOW })))).toEqual(voulu);
    });
  }

  it("corps signé qui porte une audience, ou un autre type : jamais une identité ; sans type (Python, hôte ancien) : accepté", () => {
    const delegation = signClaims({ user_id: 7, username: "hugo" }, "svc", {
      aud: DELEGATION_AUDIENCE,
      now: NOW,
    });
    expect(verifyClaims(delegation, "svc", { aud: DELEGATION_AUDIENCE, now: NOW })).toMatchObject({
      user_id: 7,
    });
    expect(verify(delegation, "svc", { now: NOW })).toBeNull();
    const vide = signClaims({ user_id: 7, username: "hugo" }, "svc", { aud: "", now: NOW });
    expect(verify(vide, "svc", { now: NOW })).toBeNull();
    const autreType = signClaims({ user_id: 7, username: "hugo", typ: "consentement" }, "svc", {
      aud: "x",
      now: NOW,
    });
    expect(verify(autreType, "svc", { now: NOW })).toBeNull();
    const signee = sign(creerIdentite({ user_id: 7, username: "hugo" }), "svc", { now: NOW });
    expect(JSON.parse(charge(signee))).toMatchObject({ typ: "identite", user_id: 7 });
    expect(verify(signee, "svc", { now: NOW })?.username).toBe("hugo");
    expect(verifyClaims(signee, "svc", { aud: DELEGATION_AUDIENCE, now: NOW })).toBeNull();
  });
});

describe("revendications (x-elpis-mcp-client, consentement OAuth)", () => {
  for (const [i, cas] of vecteurs.identite.revendications.entries()) {
    it(cas.nom ?? `${i} aud ${cas.aud}`, () => {
      if (cas.revendications !== undefined && cas.cle !== undefined && cas.now !== undefined) {
        expect(signClaims(cas.revendications, cas.cle, { aud: cas.aud, now: cas.now })).toBe(cas.entete);
        for (const v of cas.verifications ?? []) {
          const options = {
            aud: v.aud,
            now: cas.now + v.ecart,
            ...(v.skew === null ? {} : { maxSkewS: v.skew }),
          };
          expect(verifyClaims(cas.entete, cas.cle, options)).toEqual(v.sortie);
        }
        expect(versDict(verify(cas.entete, cas.cle, { now: cas.now }))).toEqual(
          porteAudience(cas.entete) ? null : cas.verify,
        );
        return;
      }
      expect(verifyClaims(cas.entete, "svc", { aud: cas.aud, now: NOW })).toEqual(cas.sortie);
      if (cas.verify !== undefined)
        expect(versDict(verify(cas.entete, "svc", { now: NOW }))).toEqual(
          porteAudience(cas.entete) ? null : cas.verify,
        );
    });
  }
});

describe("Identity.from_dict et from_meta", () => {
  for (const [i, cas] of vecteurs.identite.depuis_dict.entries()) {
    it(`from_dict ${i} ${JSON.stringify(cas.entree).slice(0, 50)}`, () => {
      const obtenu = essai(() => {
        const r = identityFromDict(cas.entree);
        return r === null ? null : { ...identityToDict(r), as_row: identityAsRow(r) };
      });
      expect(obtenu).toEqual(attendu(cas));
    });
  }

  for (const [i, cas] of vecteurs.identite.depuis_meta.entries()) {
    it(`from_meta ${i} ${JSON.stringify(cas.entree)}`, () => {
      expect(essai(() => versDict(fromMeta(cas.entree)))).toEqual(attendu(cas));
    });
  }
});

describe("registre et identité courante (vecteurs)", () => {
  it("rejoue la plage de remember, les évictions et les requêtes avec et sans contexte", () => {
    const r = vecteurs.identite.registre;
    for (let i = r.plage[0]; i <= r.plage[1]; i++) {
      remember(creerIdentite({ user_id: i, username: `u${i}`, network_profile_id: i % 3 === 0 ? "np" : "" }));
    }
    for (const d of r.suite) remember(creerIdentite(d as unknown as ChampsIdentite));
    const requetes = (): unknown => ({
      usernames: r.ids.map((u) => essai(() => resolveUsername(u))),
      utilisateurs: r.noms.map((n) => essai(() => resolveUser(n)?.user_id ?? null)),
      profils: r.ids.map((u) => essai(() => resolveNetworkProfileId(u))),
      imposes: r.ids.map((u) => essai(() => resolveForcedNetworkProfileId(u))),
    });
    expect(requetes()).toEqual(r.hors_contexte);
    avecIdentite(creerIdentite(r.courant as unknown as ChampsIdentite), () => {
      expect(requetes()).toEqual(r.dans_le_contexte);
    });
    expect(requetes()).toEqual(r.apres_contexte);
  });
});

describe("comportement porté des tests pytest", () => {
  it("enveloppe signée et bornée (test_enveloppe_signee_et_bornee)", () => {
    const ident = creerIdentite({
      user_id: 7,
      username: "hugo",
      roles: ["user"],
      network_profile_id: "bridge",
    });
    const h = sign(ident, "svc");
    expect(verify(h, "svc")).toEqual(ident);
    expect(verify(h, "autre")).toBeNull();
    expect(verify(h, "svc", { now: Date.now() / 1000 + 120 })).toBeNull();
    expect(verify(h + "x", "svc")).toBeNull();
    expect(verify("", "svc")).toBeNull();
    expect(verify(h, "")).toBeNull();
    expect(verify(null, "svc")).toBeNull();
    expect(() => sign(ident, "")).toThrow(/jeton de service absent/);
  });

  it("contexte et registre (test_contexte_et_registre)", async () => {
    const ident = creerIdentite({ user_id: 42, username: "zoe", network_profile_id: "isolated" });
    expect(resolveUsername(42)).toBeNull();
    await avecIdentite(ident, async () => {
      await Promise.resolve();
      expect(current()).toBe(ident);
      expect(resolveUsername(42)).toBe("zoe");
      expect(resolveUser("zoe")?.user_id).toBe(42);
      expect(resolveNetworkProfileId(42)).toBe("isolated");
    });
    expect(current()).toBeNull();
    expect(resolveUsername(42)).toBe("zoe");
    expect(resolveUsername("x")).toBeNull();
    expect(resolveUser("")).toBeNull();
  });

  it("from_meta (test_from_meta)", () => {
    const m = fromMeta({ username: "hugo", user_id: "7", chat_id: "c1" });
    expect(m?.user_id).toBe(7);
    expect(m?.chat_id).toBe("c1");
    expect(fromMeta({ username: "" })).toBeNull();
    expect(fromMeta(null)).toBeNull();
    expect(fromMeta({ username: "x", user_id: "abc" })?.user_id).toBe(0);
  });

  it.each([
    [1, true],
    [true, true],
    [2, false],
    [0, false],
    [null, false],
    [false, false],
  ])("modérateur non admin : is_admin=%s → %s (test_identity_from_dict_modo_non_admin)", (brut, admin) => {
    const ident = identityFromDict({ user_id: 7, username: "u7", is_admin: brut });
    expect(ident?.is_admin).toBe(admin);
    expect(ident === null ? null : identityAsRow(ident).is_admin).toBe(admin ? 1 : 0);
  });

  it("revendications : audience, clé et délai (test_delegation_origine_mcp)", () => {
    const tok = signClaims({ sub: "alice", uid: 3, kind: "tools", families: ["fs"] }, "cle", {
      aud: DELEGATION_AUDIENCE,
    });
    expect(verifyClaims(tok, "cle", { aud: DELEGATION_AUDIENCE })?.["sub"]).toBe("alice");
    expect(verifyClaims(tok, "autre", { aud: DELEGATION_AUDIENCE })).toBeNull();
    expect(verifyClaims(tok, "cle", { aud: DELEGATION_AUDIENCE, now: Date.now() / 1000 + 600 })).toBeNull();
    expect(verifyClaims(tok, "cle", { aud: "elpis-sandbox" })).toBeNull();
    expect(() => signClaims({}, "", { aud: "x" })).toThrow(/jeton de service absent/);
  });
});

describe("contexte asynchrone (ContextVar → AsyncLocalStorage)", () => {
  it("deux requêtes entrelacées gardent chacune leur identité", async () => {
    const vues: string[] = [];
    const requete = (nom: string, id: number, attente: number): Promise<void> =>
      avecIdentite(creerIdentite({ user_id: id, username: nom }), async () => {
        await new Promise((r) => setTimeout(r, attente));
        vues.push(`${nom}:${current()?.username}:${resolveUsername(id)}`);
      });
    await Promise.all([requete("a", 1, 30), requete("b", 2, 5), requete("c", 3, 15)]);
    expect(vues.sort()).toEqual(["a:a:a", "b:b:b", "c:c:c"]);
    expect(current()).toBeNull();
  });

  it("une identité nulle masque celle du contexte englobant, sans entrer au registre", () => {
    avecIdentite(creerIdentite({ user_id: 5, username: "e" }), () => {
      avecIdentite(null, () => expect(current()).toBeNull());
      expect(current()?.username).toBe("e");
    });
  });
});

describe("identité d'abord, base ensuite (port ComptesEnBase)", () => {
  const base: ComptesEnBase = {
    getUsernameById: async (id) => (id === 9 ? "en-base" : null),
    getUserIdByUsername: async (nom) => (nom === "en-base" ? 9 : null),
    getNetworkProfileId: async (id) => (id === 9 ? "bridge" : "isolated"),
  };

  it("usernameFor : identité, puis base, puis user_<id>", async () => {
    expect(await usernameFor(9)).toBe("user_9");
    brancherComptes(base);
    expect(await usernameFor(9)).toBe("en-base");
    expect(await usernameFor(4)).toBe("user_4");
    remember(creerIdentite({ user_id: 9, username: "distante" }));
    expect(await usernameFor(9)).toBe("distante");
    brancherComptes({ ...base, getUsernameById: () => Promise.reject(new Error("base")) });
    expect(await usernameFor(4)).toBe("user_4");
  });

  it("userIdFor : id non nul de l'identité, sinon base, sinon 0", async () => {
    expect(await userIdFor("en-base")).toBe(0);
    brancherComptes(base);
    expect(await userIdFor("en-base")).toBe(9);
    remember(creerIdentite({ user_id: 0, username: "en-base" }));
    expect(await userIdFor("en-base")).toBe(9);
    await avecIdentite(creerIdentite({ user_id: 77, username: "en-base" }), async () => {
      expect(await userIdFor("en-base")).toBe(77);
    });
    brancherComptes({ ...base, getUserIdByUsername: () => Promise.reject(new Error("base")) });
    expect(await userIdFor("x")).toBe(0);
  });

  it("userNetworkProfileId : profil de l'identité, sinon base, « isolated » en cas d'échec", async () => {
    expect(await userNetworkProfileId(9)).toBe("isolated");
    brancherComptes(base);
    expect(await userNetworkProfileId(9)).toBe("bridge");
    remember(creerIdentite({ user_id: 9, username: "n", network_profile_id: "host" }));
    expect(await userNetworkProfileId(9)).toBe("host");
    brancherComptes({ ...base, getNetworkProfileId: () => Promise.reject(new Error("base")) });
    expect(await userNetworkProfileId(3)).toBe("isolated");
  });
});

describe("imposition du profil réseau transmise par main (champ facultatif)", () => {
  it("absente : forme signée inchangée ; présente, même vide : signée et relue telle quelle", () => {
    const sans = creerIdentite({ user_id: 7, username: "hugo", network_profile_id: "lan" });
    expect(charge(sign(sans, "svc", { now: 1.5 }))).toBe(
      '{"chat_id":"","is_admin":false,"network_profile_id":"lan","roles":[],"ts":1.5,"typ":"identite","user_id":7,"username":"hugo"}',
    );
    for (const impose of ["", "lan"]) {
      const avec = creerIdentite({ user_id: 7, username: "hugo", forced_network_profile_id: impose });
      expect(verify(sign(avec, "svc"), "svc")?.forced_network_profile_id).toBe(impose);
    }
    expect(verify(sign(sans, "svc"), "svc")?.forced_network_profile_id).toBeNull();
  });

  it("résolue par le contexte puis le registre ; `null` si non transmise", () => {
    expect(resolveForcedNetworkProfileId(7)).toBeNull();
    avecIdentite(creerIdentite({ user_id: 7, username: "hugo", forced_network_profile_id: "lan" }), () => {
      expect([7, "7", 8].map(resolveForcedNetworkProfileId)).toEqual(["lan", "lan", null]);
      remember(creerIdentite({ user_id: 7, username: "hugo", forced_network_profile_id: "" }));
      expect(resolveForcedNetworkProfileId(7)).toBe("lan");
    });
    expect(resolveForcedNetworkProfileId(7)).toBe("");
    remember(creerIdentite({ user_id: 7, username: "hugo" }));
    expect(resolveForcedNetworkProfileId(7)).toBeNull();
  });
});
