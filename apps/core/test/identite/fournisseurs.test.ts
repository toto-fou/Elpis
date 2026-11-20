// SPDX-License-Identifier: MIT
/** apps/core/test/identite/fournisseurs.test.ts — fournisseurs actifs : chaque invariant de lecture tient quoi que le fichier contienne, secret absent ou hors portée = null, empreinte du dernier test réussi, coupure des sessions (SQLite, PostgreSQL si ELPIS_TEST_PG). */
import { readFileSync } from "node:fs";

import { createUser } from "@elpis/auth";
import { sessionCookieAttrs } from "@elpis/config";
import { initialiserBase } from "@elpis/db";
import { ouvrirBaseDeTest, PG_DE_TEST } from "@elpis/db/test";
import type { BaseDeTest } from "@elpis/db/test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  couperSessionsDesFournisseurs,
  empreinteFournisseur,
  enregistrerSecret,
  enregistrerTestReussi,
  etatFournisseur,
  fournisseurParId,
  fournisseursActifs,
  hotesDuFournisseur,
  secretFournisseur,
  supprimerSecretFournisseur,
  testReussiCourant,
} from "../../src/identite/fournisseurs";
import { validerFournisseur } from "../../src/identite/reglages";
import type { Fournisseur } from "../../src/identite/reglages";
import { installerCrochetJournal } from "../../src/journal";
import { configDeTest, cleCoffreDeTest, oidcValide } from "./aides";
import type { ConfigDeTest } from "./aides";

const MOTEURS = PG_DE_TEST ? (["sqlite", "postgres"] as const) : (["sqlite"] as const);
const URL_PUBLIQUE = "https://elpis.exemple.lan";
const ACTEUR = { userId: null, username: null, ip: null };
let compteur = 0;

describe.each(MOTEURS)("fournisseurs d'identité (%s)", (moteur) => {
  let t: BaseDeTest;
  let cfg: ConfigDeTest;
  let lignes: string[];

  beforeEach(async () => {
    t = ouvrirBaseDeTest(moteur);
    await initialiserBase(t.base);
    await createUser(t.base, "chef-local", "mdp-chef-1", { isAdmin: 1 });
    cleCoffreDeTest();
    cfg = configDeTest({ https: true });
    lignes = [];
    installerCrochetJournal((_n, m) => lignes.push(m));
  });
  afterEach(async () => {
    installerCrochetJournal(null);
    cfg.fermer();
    await t.fermer();
  });

  /** Fournisseur prêt : fichier, secret rangé, test réussi ; `ecart` modifie ce qui est écrit dans le fichier après coup. */
  async function pret(
    ecart: Record<string, unknown> = {},
    avant: Record<string, unknown> = {},
  ): Promise<string> {
    const id = `sso${++compteur}`;
    const brut = oidcValide({ id, enabled: true, required_groups: ["cn=elpis"], ...avant });
    const f = validerFournisseur(brut);
    await enregistrerSecret(t.base, f, "mot-de-passe-de-service", ACTEUR);
    await enregistrerTestReussi(t.base, f, URL_PUBLIQUE);
    cfg.ecrire({ auth: { public_url: URL_PUBLIQUE, providers: [{ ...brut, ...ecart }] } });
    return id;
  }
  const actifs = async (cookieSecure = true): Promise<string[]> =>
    (await fournisseursActifs(t.base, () => cookieSecure)).map((f) => f.id);

  it("fournisseur prêt : actif", async () => {
    const id = await pret();
    expect(await actifs()).toEqual([id]);
  });

  it("cookie de session sans l'attribut Secure : plus aucun fournisseur actif, signalé au journal", async () => {
    const id = await pret();
    expect(await actifs(false)).toEqual([]);
    expect(lignes.join("\n")).toContain(
      `fournisseur d'identité ${id} allumé mais écarté : cookie de session non sécurisé`,
    );
    expect(await actifs(true)).toEqual([id]);
  });

  it("la condition du cookie n'a aucune valeur par défaut : un appelant qui ne la passe pas ne compile pas", async () => {
    const id = await pret();
    const f = fournisseurParId(id);
    // @ts-expect-error la valeur figée du processus appelant est obligatoire
    const sans = fournisseursActifs(t.base);
    // @ts-expect-error idem pour l'état d'un fournisseur
    const etat = f === undefined ? null : etatFournisseur(t.base, f, URL_PUBLIQUE);
    await Promise.allSettled([sans, etat]);
    expect(f).toBeDefined();
  });

  it("HTTPS doit être en service : `same_site: none` force le cookie `Secure` sans suffire à rendre un fournisseur actif", async () => {
    const id = await pret();
    const brut = JSON.parse(readFileSync(cfg.chemin, "utf8")) as Record<string, unknown>;
    const lu = (): boolean => sessionCookieAttrs().https_only;
    cfg.ecrire({ ...brut, security: { https: { enabled: false }, session: { same_site: "none" } } });
    expect(lu()).toBe(true);
    expect((await fournisseursActifs(t.base, lu)).map((f) => f.id)).toEqual([]);
    cfg.ecrire({ ...brut, security: { https: { enabled: true }, session: { same_site: "none" } } });
    expect((await fournisseursActifs(t.base, lu)).map((f) => f.id)).toEqual([id]);
  });

  it("section absente ou corrompue : aucun fournisseur actif", async () => {
    expect(await actifs()).toEqual([]);
    cfg.ecrire({ auth: "corrompue" });
    expect(await actifs()).toEqual([]);
    cfg.ecrire({ auth: { providers: "x" } });
    expect(await actifs()).toEqual([]);
  });

  it.each([
    ["éteint", { enabled: false }],
    ["aucun groupe requis", { required_groups: [] }],
    ["réglages invalides (issuer en http)", { issuer: "http://idp.exemple.lan/realms/elpis" }],
    ["clé inconnue", { verify_tls: false }],
    ["réglages changés à la main depuis le test (client_id)", { client_id: "autre" }],
    ["revendication de groupes changée à la main depuis le test", { groups_claim: "roles" }],
    ["groupe requis ajouté à la main depuis le test", { required_groups: ["cn=elpis", "cn=tous"] }],
  ])("non actif : %s", async (_nom, ecart) => {
    await pret(ecart);
    expect(await actifs()).toEqual([]);
  });

  it("allumé à la main sans test réussi : non actif ; avertissement unique au journal", async () => {
    const id = `sso${++compteur}`;
    const brut = oidcValide({ id, enabled: true, required_groups: ["cn=elpis"] });
    await enregistrerSecret(t.base, validerFournisseur(brut), "mdp", ACTEUR);
    cfg.ecrire({ auth: { public_url: URL_PUBLIQUE, providers: [brut] } });
    for (let i = 0; i < 3; i++) expect(await actifs()).toEqual([]);
    const avert = lignes.filter((l) => l.includes(id));
    expect(avert).toHaveLength(1);
    expect(avert[0]).toMatch(/écarté.*test/u);
    expect(avert[0]).not.toMatch(/mdp/u);
  });

  it("adresse publique absente, http ou avec chemin : non actif", async () => {
    const id = await pret();
    const f = oidcValide({ id, enabled: true, required_groups: ["cn=elpis"] });
    for (const url of ["", "http://elpis.exemple.lan", "https://elpis.exemple.lan/x", "elpis.exemple.lan"]) {
      cfg.ecrire({ auth: { public_url: url, providers: [f] } });
      expect(await actifs(), url).toEqual([]);
    }
    cfg.ecrire({ auth: { public_url: URL_PUBLIQUE, providers: [f] } });
    expect(await actifs()).toEqual([id]);
  });

  it("changer l'adresse publique après le test : non actif (l'empreinte la compte)", async () => {
    const id = await pret();
    const f = oidcValide({ id, enabled: true, required_groups: ["cn=elpis"] });
    cfg.ecrire({ auth: { public_url: "https://autre.exemple.lan", providers: [f] } });
    expect(await actifs()).toEqual([]);
  });

  it("libellé et fraîcheur ne changent pas l'empreinte : toujours actif", async () => {
    const id = await pret({ label: "Autre libellé", freshness_days: 30 });
    expect(await actifs()).toEqual([id]);
  });

  it("secret absent : non actif ; secret supprimé ensuite : non actif", async () => {
    const id = await pret();
    await supprimerSecretFournisseur(t.base, id, ACTEUR);
    expect(await actifs()).toEqual([]);
  });

  it("changer d'hôte ou de port : le secret n'est plus rendu (null), il faut le ressaisir", async () => {
    const id = await pret();
    const f = fournisseurParId(id);
    expect(f).toBeDefined();
    expect(await secretFournisseur(t.base, f as never)).toBe("mot-de-passe-de-service");
    for (const issuer of [
      "https://autre.exemple.lan/realms/elpis",
      "https://idp.exemple.lan:8443/realms/elpis",
    ]) {
      const brut = oidcValide({ id, enabled: true, required_groups: ["cn=elpis"], issuer });
      cfg.ecrire({ auth: { public_url: URL_PUBLIQUE, providers: [brut] } });
      const modifie = validerFournisseur(brut);
      expect(await secretFournisseur(t.base, modifie), issuer).toBeNull();
      await enregistrerTestReussi(t.base, modifie, URL_PUBLIQUE);
      expect(await actifs(), issuer).toEqual([]);
      await enregistrerSecret(t.base, modifie, "nouveau", ACTEUR);
      expect(await secretFournisseur(t.base, modifie)).toBe("nouveau");
      expect(await actifs(), `${issuer} : test à refaire avec le nouveau secret`).toEqual([]);
      await enregistrerTestReussi(t.base, modifie, URL_PUBLIQUE);
      expect(await actifs()).toEqual([id]);
    }
  });

  it("port 443 par défaut : https://h et https://h:443 désignent la même portée", async () => {
    const f = validerFournisseur(
      oidcValide({ id: `sso${++compteur}`, issuer: "https://IdP.exemple.lan/realms/a" }),
    );
    expect(hotesDuFournisseur(f)).toEqual(["idp.exemple.lan:443"]);
    await enregistrerSecret(t.base, f, "x", ACTEUR);
    const meme = validerFournisseur({ ...f, issuer: "https://idp.exemple.lan:443/realms/a" });
    expect(await secretFournisseur(t.base, meme)).toBe("x");
  });

  it("secret vide ou illisible : null, jamais une chaîne vide", async () => {
    const f = validerFournisseur(oidcValide({ id: `sso${++compteur}` }));
    expect(await secretFournisseur(t.base, f)).toBeNull();
    await expect(enregistrerSecret(t.base, f, "", ACTEUR)).rejects.toThrow();
    expect(await secretFournisseur(t.base, f)).toBeNull();
    await enregistrerSecret(t.base, f, "x", ACTEUR);
    await t.base.run("UPDATE vault_secrets SET secret_enc='corrompu' WHERE name=?", [`auth-${f.id}`]);
    expect(await secretFournisseur(t.base, f)).toBeNull();
  });

  it("empreinte : tout sauf libellé, activation et fraîcheur ; adresse publique comprise", () => {
    const f = validerFournisseur(oidcValide());
    const e = empreinteFournisseur(f, URL_PUBLIQUE);
    expect(empreinteFournisseur({ ...f, label: "x", enabled: true, freshness_days: 2 }, URL_PUBLIQUE)).toBe(
      e,
    );
    expect(empreinteFournisseur(f, "https://autre.lan")).not.toBe(e);
    for (const modif of [
      { client_id: "x" },
      { preset: "keycloak" },
      { ca_pem: "", required_groups: ["cn=a"] },
      { clock_skew_sec: 61 },
    ])
      expect(empreinteFournisseur({ ...f, ...modif } as never, URL_PUBLIQUE), JSON.stringify(modif)).not.toBe(
        e,
      );
  });

  it("un test réussi n'est courant que pour ses réglages", async () => {
    const f = validerFournisseur(oidcValide({ id: `sso${++compteur}` }));
    expect(await testReussiCourant(t.base, f, URL_PUBLIQUE)).toBe(false);
    await enregistrerTestReussi(t.base, f, URL_PUBLIQUE);
    expect(await testReussiCourant(t.base, f, URL_PUBLIQUE)).toBe(true);
    expect(await testReussiCourant(t.base, { ...f, client_id: "x" } as Fournisseur, URL_PUBLIQUE)).toBe(
      false,
    );
    await enregistrerTestReussi(t.base, f, URL_PUBLIQUE);
    await enregistrerTestReussi(t.base, f, URL_PUBLIQUE);
    expect(
      (await t.base.valeurs("SELECT COUNT(*) FROM auth_provider_state WHERE provider_id=?", [f.id]))[0],
    ).toEqual([1]);
  });

  it("couper les sessions : seuls les comptes rattachés aux fournisseurs visés, sans baisser un plancher plus récent", async () => {
    const a = await createUser(t.base, `a${compteur}`, "mdp-a");
    const b = await createUser(t.base, `b${compteur}`, "mdp-b");
    const c = await createUser(t.base, `c${compteur}`, "mdp-c");
    const ins =
      "INSERT INTO user_identities(user_id, provider_id, subject, issuer, linked_by, linked_at) VALUES(?,?,?,?,?,?)";
    await t.base.run(ins, [a, "p1", "s1", "i", "admin", 1]);
    await t.base.run(ins, [b, "p2", "s2", "i", "admin", 1]);
    await t.base.run("UPDATE users SET session_min_ts=? WHERE id=?", [5000, a]);
    expect(await couperSessionsDesFournisseurs(t.base, ["p1"], 100)).toEqual([a]);
    expect(await couperSessionsDesFournisseurs(t.base, ["p2"], 100)).toEqual([b]);
    expect(await couperSessionsDesFournisseurs(t.base, [], 100)).toEqual([]);
    const min = async (u: number): Promise<number> =>
      Number((await t.base.valeurs("SELECT session_min_ts FROM users WHERE id=?", [u]))[0]?.[0]);
    expect([await min(a), await min(b), await min(c)]).toEqual([5000, 100, 0]);
  });
});
