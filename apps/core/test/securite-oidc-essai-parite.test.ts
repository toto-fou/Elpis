// SPDX-License-Identifier: MIT
/** apps/core/test/securite-oidc-essai-parite.test.ts — « Se connecter pour essayer » rend la même décision qu'une vraie connexion, raison notée comprise (administrateur sans preuve d'un second facteur refusé sans rôle annoncé, rattachement préparé avec ou sans preuve, préparé qui ne vaut plus ou du dernier administrateur local, émetteur changé, nom invalide ou pris, aucun administrateur local, suspension, groupes), sans créer ni compte ni session ni rien écrire ; la décision partagée ne fait aucune écriture (SQLite, PostgreSQL si ELPIS_TEST_PG). */
import { readFileSync } from "node:fs";

import { createUser, MARQUEUR_SANS_MOT_DE_PASSE } from "@elpis/auth";
import { schemaReponseDernierEssai } from "@elpis/contracts";
import type { ResultatEssaiBlanc } from "@elpis/contracts";
import type { Executeur } from "@elpis/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ancreIdentite } from "../src/identite/ancre";
import { deciderIdentite } from "../src/identite/decision";
import { preparerRattachement } from "../src/identite/rattachement";
import { lignesAuditRecentes } from "./aides";
import { MOTEURS } from "./identite/banc";
import { adresseNeuve, cookies, ELPIS, HOTE_PUBLIC, ouvrirBancOidc } from "./identite/banc-oidc";
import type { BancOidc } from "./identite/banc-oidc";
import { OPENSSL_DISPONIBLE } from "./identite/pki-openssl";

type Utilisateur = ReturnType<typeof ELPIS>;
type Issue =
  | { type: "refus"; code: string; cause: unknown }
  | { type: "inoperant" }
  | { type: "preuve" }
  | { type: "session"; compte: string };

/** Code rendu au navigateur par la vraie connexion pour une raison de l'essai. */
const CODE_DE_RAISON: Readonly<Record<string, string>> = {
  mfa_required: "mfa_required",
  not_in_group: "not_in_group",
  groups_unknown: "groups_unknown",
  suspended: "suspended",
};

/** Cause que la vraie connexion note pour une raison de l'essai : la même pour un refus du compte ; second facteur non prouvé : admin_without_mfa ou acr_amr. */
const causeDe = (raison: string | null): unknown =>
  raison === "mfa_required" ? expect.stringMatching(/^(admin_without_mfa|acr_amr)$/u) : raison;

/** Ce que la vraie connexion ferait, selon la décision de l'essai ; sans administrateur local, le fournisseur est inopérant avant toute décision. */
function attendue(d: ResultatEssaiBlanc["decision"]): Issue {
  if (d.reason === "no_local_admin") return { type: "inoperant" };
  if (d.outcome === "refuse")
    return { type: "refus", code: CODE_DE_RAISON[d.reason ?? ""] ?? "conflict", cause: causeDe(d.reason) };
  if (d.outcome === "proof") return { type: "preuve" };
  return { type: "session", compte: d.username ?? "" };
}

describe.skipIf(!OPENSSL_DISPONIBLE).each(MOTEURS)("essai à blanc et vraie connexion (%s)", (moteur) => {
  let b: BancOidc;
  let admin: string;

  beforeEach(async () => {
    b = await ouvrirBancOidc(moteur, { actif: false });
    const r = await b.console.inject({
      method: "POST",
      url: "/api/login-lite",
      headers: { host: HOTE_PUBLIC, "sec-fetch-site": "same-origin" },
      payload: { username: "chef", password: "mdp-chef-1" },
    });
    expect(r.statusCode, r.body).toBe(200);
    admin = cookies(r);
  });
  afterEach(async () => {
    await b.fermer();
  });

  /** Tout ce qu'une connexion pourrait écrire : comptes, rôles, suspensions, identités, préparés, sessions. */
  const etatEcrit = async (): Promise<string> =>
    JSON.stringify([
      await b.t.base.valeurs(
        "SELECT id, username, is_admin, suspended_at, suspended_by, pass_hash, last_login_at FROM users ORDER BY id",
      ),
      await b.t.base.valeurs("SELECT user_id, group_id FROM user_groups ORDER BY user_id, group_id"),
      await b.t.base.valeurs(
        "SELECT user_id, provider_id, subject, ext_username, checked_at FROM user_identities ORDER BY user_id",
      ),
      await b.t.base.valeurs("SELECT id, user_id, attempts FROM auth_prelinks ORDER BY id"),
      await b.t.base.valeurs("SELECT COUNT(*) FROM auth_ext_sessions"),
      await b.t.base.valeurs("SELECT COUNT(*) FROM revoked_sessions"),
      await b.t.base.valeurs("SELECT COUNT(*) FROM tool_tokens"),
    ]);

  /** Essai à blanc complet pour cette personne (`pendant` agit sur la base avant le retour) : rien d'écrit hors de son résultat, résultat valide pour le schéma. */
  async function essayer(u: Utilisateur, pendant?: () => Promise<unknown>): Promise<ResultatEssaiBlanc> {
    await b.reglages({ enabled: false });
    let avant = await etatEcrit();
    const l = await b.console.inject({
      method: "POST",
      url: "/api/admin/auth/providers/sso/trial",
      headers: { host: HOTE_PUBLIC, cookie: admin, "sec-fetch-site": "same-origin" },
      payload: {},
    });
    expect(l.statusCode, l.body).toBe(200);
    const { retour } = b.idp.autoriser(l.json<{ url: string }>().url, u);
    if (pendant !== undefined) {
      expect(await etatEcrit(), `départ de l'essai de ${u.sub}`).toBe(avant);
      await pendant();
      avant = await etatEcrit();
    }
    const r = await b.retourner(retour, { cookie: `${cookies(l)}; ${admin}` });
    expect(r.statusCode, r.body).toBe(200);
    expect(String(r.headers["set-cookie"] ?? "")).not.toContain("mcpwebui_session");
    expect(await etatEcrit(), `essai de ${u.sub}`).toBe(avant);
    const lu = await b.console.inject({
      method: "GET",
      url: "/api/admin/auth/providers/sso/trial",
      headers: { host: HOTE_PUBLIC, cookie: admin },
    });
    const v = schemaReponseDernierEssai.safeParse(lu.json());
    expect(v.success, lu.body).toBe(true);
    const resultat = v.data?.result;
    if (!resultat) throw new Error("aucun résultat d'essai");
    return resultat;
  }

  /** Vraie connexion de cette personne, fournisseur actif (`pendant` agit sur la base avant le retour) : refus, son code et la cause notée au journal de sécurité, fournisseur devenu inopérant, preuve demandée, ou session du compte. */
  async function connecter(u: Utilisateur, pendant?: () => Promise<unknown>): Promise<Issue> {
    await b.reglages({ enabled: true });
    const adresse = adresseNeuve();
    const depart = await b.demarrer({ adresse });
    if (depart.url === null) throw new Error(`départ refusé : ${depart.reponse.statusCode}`);
    const { retour: adresseRetour } = b.idp.autoriser(depart.url, u);
    await pendant?.();
    const retour = await b.retourner(adresseRetour, { cookie: depart.cookie, adresse });
    if (retour.statusCode === 404) return { type: "inoperant" };
    const lieu = String(retour.headers.location ?? "");
    if (retour.statusCode === 302) {
      const [, code, ref] = /^\/\?auth_error=([a-z_]+)&ref=([\w-]+)$/u.exec(lieu) ?? [];
      if (code === undefined || ref === undefined) throw new Error(`retour inattendu : ${lieu}`);
      const details = lignesAuditRecentes({ actionPrefix: "auth.login.denied" })
        .map((l) => l["details"] as Record<string, unknown> | undefined)
        .find((d) => d?.["ref"] === ref);
      return { type: "refus", code, cause: details?.["reason"] };
    }
    expect(retour.statusCode, retour.body).toBe(200);
    if (retour.body.includes("url=/?auth_link=1")) return { type: "preuve" };
    expect(String(retour.headers["set-cookie"] ?? "")).toContain("mcpwebui_session");
    const l = await b.t.base.get<{ username: string }>(
      "SELECT u.username FROM user_identities i JOIN users u ON u.id=i.user_id WHERE i.provider_id='sso' AND i.subject=?",
      [u.sub],
    );
    return { type: "session", compte: String(l?.username ?? "") };
  }

  /** L'essai puis la vraie connexion de la même personne : même décision ; `pendant` change la base entre l'autorisation et le retour de chacun, `apres` la remet en état. */
  async function memeDecision(
    u: Utilisateur,
    decision: Partial<ResultatEssaiBlanc["decision"]>,
    o: { pendant?: () => Promise<unknown>; apres?: () => Promise<unknown> } = {},
  ) {
    const essai = await essayer(u, o.pendant);
    await o.apres?.();
    expect(essai.decision, u.sub).toMatchObject(decision);
    expect(await connecter(u, o.pendant), u.sub).toEqual(attendue(essai.decision));
    await o.apres?.();
    return essai;
  }

  const preparer = async (
    uid: number,
    attendu: string,
    dispense: boolean,
    confirmeAdmin = false,
  ): Promise<void> => {
    const r = await b.t.base.ecriture((x) =>
      preparerRattachement(x, {
        uid,
        fournisseurId: "sso",
        ancre: ancreIdentite(b.fournisseur),
        attendu,
        dispense,
        confirmeAdmin,
        par: b.chef,
        t: Date.now() / 1000,
      }),
    );
    if ("raison" in r) throw new Error(r.raison);
  };
  const rattacherA = (uid: number, sub: string): Promise<unknown> =>
    b.t.base.run(
      "INSERT INTO user_identities(user_id, provider_id, subject, issuer, linked_by, linked_at) VALUES(?, 'sso', ?, ?, 'auto', 1)",
      [uid, sub, ancreIdentite(b.fournisseur)],
    );

  it("compte, rattachement préparé, suspension, conflit de nom, groupes : l'essai dit ce que la connexion fait", async () => {
    await memeDecision(ELPIS("p-neuf"), { outcome: "create", username: "p-neuf", reason: null });

    await createUser(b.t.base, "p-homonyme", "mdp-homonyme-1");
    await memeDecision(ELPIS("s-homonyme", { preferred_username: "p-homonyme" }), {
      outcome: "refuse",
      username: "p-homonyme",
      reason: "account_conflict",
      conflict_linked: false,
    });

    const prouve = await createUser(b.t.base, "p-prouve", "mdp-prouve-1");
    await preparer(prouve, "p-prouve", false);
    await memeDecision(ELPIS("s-prouve", { preferred_username: "p-prouve" }), {
      outcome: "proof",
      username: "p-prouve",
      reason: null,
    });

    const dispense = await createUser(b.t.base, "p-dispense", "mdp-dispense-1");
    await preparer(dispense, "p-dispense", true);
    await memeDecision(ELPIS("s-dispense", { preferred_username: "p-dispense" }), {
      outcome: "link",
      username: "p-dispense",
      reason: null,
    });

    const suspendu = await createUser(b.t.base, "p-suspendu", "mdp-suspendu-1");
    await rattacherA(suspendu, "s-suspendu");
    await b.t.base.run("UPDATE users SET suspended_at=?, suspended_by=? WHERE id=?", [
      Math.floor(Date.now() / 1000),
      `admin:${b.chef}`,
      suspendu,
    ]);
    const essaiSuspendu = await memeDecision(ELPIS("s-suspendu"), {
      outcome: "refuse",
      username: "p-suspendu",
      reason: "suspended",
    });
    expect(essaiSuspendu.rights).toBeNull();

    const sorti = await createUser(b.t.base, "p-sorti", "mdp-sorti-1");
    await rattacherA(sorti, "s-sorti");
    await b.t.base.run("UPDATE users SET suspended_at=?, suspended_by='provider:sso' WHERE id=?", [
      Math.floor(Date.now() / 1000),
      sorti,
    ]);
    await memeDecision(ELPIS("s-sorti"), { outcome: "login", username: "p-sorti", reason: null });

    const parti = await createUser(b.t.base, "p-parti", "mdp-parti-1");
    await rattacherA(parti, "s-parti");
    await memeDecision(ELPIS("s-parti", { groups: ["autres"] }), {
      outcome: "refuse",
      username: "p-parti",
      reason: "not_in_group",
    });
    b.idp.userinfo = (x) => ({ sub: x.sub });
    await memeDecision(ELPIS("s-sans-groupes", { groups: undefined }), {
      outcome: "refuse",
      reason: "groups_unknown",
    });
    await b.reglages({ required_amr: ["otp"] });
    const sansOtp = await memeDecision(ELPIS("s-sans-otp", { amr: ["pwd"] }), {
      outcome: "refuse",
      reason: "mfa_required",
    });
    expect(sansOtp.rights).toBeNull();
  });

  it("émetteur changé, nom invalide, nom d'un compte rattaché ailleurs, préparé échu ou qui ne vaut plus, dernier administrateur local, aucun administrateur local : l'essai dit ce que la connexion fait", async () => {
    const lierA = (uid: number, fournisseur: string, sub: string, ancre: string): Promise<unknown> =>
      b.t.base.run(
        "INSERT INTO user_identities(user_id, provider_id, subject, issuer, linked_by, linked_at) VALUES(?, ?, ?, ?, 'auto', 1)",
        [uid, fournisseur, sub, ancre],
      );
    const ANCIENNE_ANCRE = "oidc:https://ancien.exemple.lan";

    await lierA(
      await createUser(b.t.base, "p-emetteur", "mdp-emetteur-1"),
      "sso",
      "s-emetteur",
      ANCIENNE_ANCRE,
    );
    await memeDecision(ELPIS("s-emetteur"), {
      outcome: "refuse",
      username: "p-emetteur",
      reason: "issuer_mismatch",
    });

    await memeDecision(ELPIS("s-reserve", { preferred_username: "root" }), {
      outcome: "refuse",
      username: null,
      reason: "name_invalid",
    });
    await memeDecision(ELPIS("s-long", { preferred_username: "x".repeat(256) }), {
      outcome: "refuse",
      username: null,
      reason: "name_invalid",
    });

    await lierA(
      await createUser(b.t.base, "p-ailleurs", "mdp-ailleurs-1"),
      "autre",
      "s-autre",
      ANCIENNE_ANCRE,
    );
    await memeDecision(ELPIS("s-ailleurs", { preferred_username: "p.ailleurs" }), {
      outcome: "refuse",
      username: "p-ailleurs",
      reason: "account_conflict",
      conflict_linked: true,
    });

    const echu = await createUser(b.t.base, "p-echu", "mdp-echu-1");
    await preparer(echu, "p-echu", false);
    await b.t.base.run("UPDATE auth_prelinks SET expires_at=? WHERE user_id=?", [
      Math.floor(Date.now() / 1000) - 1,
      echu,
    ]);
    await memeDecision(ELPIS("s-echu", { preferred_username: "p-echu" }), {
      outcome: "refuse",
      username: "p-echu",
      reason: "account_conflict",
      conflict_linked: false,
    });

    const ancre = await createUser(b.t.base, "p-ancre", "mdp-ancre-1");
    await preparer(ancre, "p-ancre", true);
    await b.t.base.run("UPDATE auth_prelinks SET issuer=? WHERE user_id=?", [ANCIENNE_ANCRE, ancre]);
    await memeDecision(ELPIS("s-ancre", { preferred_username: "p-ancre" }), {
      outcome: "refuse",
      username: "p-ancre",
      reason: "prelink_invalid",
    });

    const promu = await createUser(b.t.base, "p-promu", "mdp-promu-1");
    await preparer(promu, "p-promu", true);
    await b.t.base.run("UPDATE users SET is_admin=2 WHERE id=?", [promu]);
    await memeDecision(ELPIS("s-promu", { preferred_username: "p-promu" }), {
      outcome: "refuse",
      username: "p-promu",
      reason: "prelink_invalid",
    });
    expect(await b.t.base.valeurs("SELECT COUNT(*) FROM auth_prelinks WHERE user_id=?", [promu])).toEqual([
      [0],
    ]);

    const sansMotDePasse = (uid: number): Promise<unknown> =>
      b.t.base.run("UPDATE users SET pass_hash=? WHERE id=?", [MARQUEUR_SANS_MOT_DE_PASSE, uid]);
    await b.ajouter("autre", { enabled: true });
    const parSso = await createUser(b.t.base, "a-sso", "mdp-a-sso-1", { isAdmin: 1 });
    await lierA(parSso, "autre", "s-a-sso", ancreIdentite(b.fournisseur));
    await sansMotDePasse(parSso);
    const ici = adresseNeuve();
    const d = await b.demarrer({
      id: "autre",
      process: "console",
      corps: { target: "console" },
      adresse: ici,
    });
    expect(d.url, d.reponse.body).not.toBeNull();
    const { retour } = b.idp.autoriser(d.url ?? "", ELPIS("s-a-sso"));
    const r = await b.retourner(retour, { id: "autre", cookie: d.cookie, adresse: ici });
    expect(r.statusCode, r.body).toBe(200);
    expect(String(r.headers["set-cookie"] ?? "")).toContain("mcpwebui_session");
    admin = cookies(r, d.cookie);

    const dernier = await createUser(b.t.base, "p-dernier", "mdp-dernier-1", { isAdmin: 1 });
    await preparer(dernier, "p-dernier", false, true);
    await sansMotDePasse(b.chef);
    await memeDecision(ELPIS("s-dernier", { preferred_username: "p-dernier" }), {
      outcome: "refuse",
      username: "p-dernier",
      reason: "prelink_invalid",
    });

    const motDePasse = String(
      (await b.t.base.get<{ pass_hash: string }>("SELECT pass_hash FROM users WHERE id=?", [dernier]))
        ?.pass_hash,
    );
    await memeDecision(
      ELPIS("s-seul"),
      { outcome: "refuse", username: null, reason: "no_local_admin" },
      {
        pendant: () => sansMotDePasse(dernier),
        apres: () => b.t.base.run("UPDATE users SET pass_hash=? WHERE id=?", [motDePasse, dernier]),
      },
    );
    expect(await b.utilisateurs()).not.toContain("s-seul");
  });

  it("administrateur : sans preuve d'un second facteur, refusé comme à la connexion et sans rôle annoncé, même hors des groupes requis ; avec preuve, administrateur", async () => {
    await b.reglages({
      roles: { enabled: true, admin_groups: ["admins"], moderator_groups: [] },
      mfa_acr: ["loa-5"],
    });
    const sansPreuve = await memeDecision(ELPIS("a-sans", { groups: ["elpis", "admins"], acr: "loa-2" }), {
      outcome: "refuse",
      reason: "mfa_required",
    });
    expect(sansPreuve.rights).toBeNull();
    expect(sansPreuve.claims?.second_factor).toBeNull();
    await memeDecision(ELPIS("a-hors", { groups: ["admins"], acr: "loa-2" }), {
      outcome: "refuse",
      reason: "mfa_required",
    });
    const avecPreuve = await memeDecision(ELPIS("a-avec", { groups: ["elpis", "admins"], acr: "loa-5" }), {
      outcome: "create",
      username: "a-avec",
    });
    expect(avecPreuve.rights?.role).toBe("admin");
    expect(
      Number(
        (await b.t.base.get<{ is_admin: number }>("SELECT is_admin FROM users WHERE username='a-avec'"))
          ?.is_admin,
      ),
    ).toBe(1);
  });

  it("rattachement préparé avec preuve : l'aperçu des droits est celui de la première connexion, qui ne peut que baisser", async () => {
    await b.reglages({ roles: { enabled: true, admin_groups: [], moderator_groups: ["modos"] } });
    const uid = await createUser(b.t.base, "p-modo", "mdp-modo-1");
    await preparer(uid, "p-modo", false);
    const essai = await essayer(
      ELPIS("s-modo", { preferred_username: "p-modo", groups: ["elpis", "modos"] }),
    );
    expect(essai.decision).toEqual({ outcome: "proof", username: "p-modo", reason: null });
    expect(essai.rights?.role).toBe("user");
  });

  it("la décision partagée ne fait que lire : un exécuteur qui refuse toute écriture suffit, quel que soit le cas", async () => {
    const lecture: Executeur = {
      dialecte: b.t.base.dialecte,
      all: (sql, p) => (/^\s*SELECT /iu.test(sql) ? b.t.base.all(sql, p) : Promise.reject(new Error(sql))),
      get: (sql, p) => (/^\s*SELECT /iu.test(sql) ? b.t.base.get(sql, p) : Promise.reject(new Error(sql))),
      valeurs: (sql, p) =>
        /^\s*SELECT /iu.test(sql) ? b.t.base.valeurs(sql, p) : Promise.reject(new Error(sql)),
      run: (sql) => Promise.reject(new Error(`écriture : ${sql}`)),
      exec: (sql) => Promise.reject(new Error(`écriture : ${sql}`)),
      insertId: (sql) => Promise.reject(new Error(`écriture : ${sql}`)),
      runMany: (sql) => Promise.reject(new Error(`écriture : ${sql}`)),
    };
    const t = Date.now() / 1000;
    const prouve = await createUser(b.t.base, "l-prouve", "mdp-l-1");
    await preparer(prouve, "l-prouve", false);
    const dispense = await createUser(b.t.base, "l-dispense", "mdp-l-2");
    await preparer(dispense, "l-dispense", true);
    const modo = await createUser(b.t.base, "l-modo", "mdp-l-3", { isAdmin: 2 });
    await b.t.base.run(
      "INSERT INTO auth_prelinks(user_id, provider_id, expected, waiver, created_by, created_at, expires_at, issuer, admin_confirmed, attempts) VALUES(?, 'sso', 'l-modo', 1, ?, ?, ?, ?, 0, 0)",
      [modo, b.chef, t, t + 3600, ancreIdentite(b.fournisseur)],
    );
    const connu = await createUser(b.t.base, "l-connu", "mdp-l-4");
    await rattacherA(connu, "s-connu");
    await createUser(b.t.base, "l-pris", "mdp-l-5");
    const cas: [string, string, "oui" | "non" | "inconnu", string][] = [
      ["s-neuf", "l-neuf", "oui", "creation"],
      ["s-pris", "l-pris", "oui", "refus"],
      ["s-prouve", "l-prouve", "oui", "preuve"],
      ["s-dispense", "l-dispense", "oui", "dispense"],
      ["s-modo", "l-modo", "oui", "refus"],
      ["s-connu", "l-connu", "oui", "connu"],
      ["s-connu", "l-connu", "non", "refus"],
      ["s-connu", "l-connu", "inconnu", "refus"],
      ["s-x", "", "oui", "refus"],
    ];
    const avant = await etatEcrit();
    for (const [subject, extUsername, appartenance, type] of cas) {
      const p = await deciderIdentite(lecture, {
        fournisseur: b.fournisseur,
        profil: { subject, issuer: ancreIdentite(b.fournisseur), extUsername },
        appartenance,
        maintenant: t,
        instant: () => t,
      });
      expect(p.type, `${subject} ${appartenance}`).toBe(type);
    }
    expect(await etatEcrit()).toBe(avant);
  });

  it("le module de décision n'importe ni l'écriture d'un compte ni l'ouverture de session, et n'écrit rien", () => {
    const src = readFileSync(new URL("../src/identite/decision.ts", import.meta.url), "utf8");
    const imports = src.split("\n").filter((l) => /^import (?!type )/u.test(l));
    for (const l of imports)
      expect(l).not.toMatch(
        /provisionnement|ouverture|connexion"|comptes\/etat|createExternalUser|ouvrirSession/u,
      );
    expect(src).not.toMatch(
      /\.run\(|\.exec\(|insertId|runMany|ecriture\(|transaction\(|createExternalUser|poserSuspension|poserReactivation|rattacher\(|etablirConnexion/u,
    );
  });
});
