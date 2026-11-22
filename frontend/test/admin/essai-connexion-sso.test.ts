// SPDX-License-Identifier: MIT
/** frontend/test/admin/essai-connexion-sso.test.ts — console › fournisseur SSO : algorithme du jeton, ligne du second facteur, « Se connecter pour essayer » (ouverture https seulement, interrogation bornée et arrêtée, décision, activation dégrisée, raison du grisé). */
import * as Vue from "vue";
import { RAISONS_ESSAI, schemaResultatEssaiBlanc } from "@elpis/contracts";
import type { ResultatEssaiBlanc } from "@elpis/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  lignesDroits,
  lignesRevendications,
  phraseDecision,
  RAISONS_ESSAI_PHRASES,
} from "../../src/features/admin/identite";
import { reinitialiserSuiviChargement } from "../../src/features/admin/suivi-chargement";
import { json, vider } from "../aides";
import { OIDC as OIDC_BASE, clic, demonter, el, etat as etatAide, monter } from "./rattachement-aide";

const OIDC = {
  ...OIDC_BASE,
  label: "SSO",
  issuer: "https://idp.example.lan",
  id_token_alg: "RS256",
  scopes: ["openid"],
};
const etat = (over: Record<string, unknown> = {}) => etatAide([], over);

afterEach(() => {
  demonter();
  reinitialiserSuiviChargement();
});

const TRIAL = "/api/admin/auth/providers/sso/trial";
const ETAPE_OK = { id: "discovery", label: "Découverte", level: "ok", detail: "Réussi.", target: null };
const RESULTAT = {
  at: 2000,
  ok: true,
  claims: {
    iss: "https://idp.example.lan",
    subject: "abc",
    identifier: "alice",
    name: "Alice <b>A</b>",
    email: "alice@example.lan",
    email_verified: true,
    acr: null,
    amr: ["pwd"],
    second_factor: null,
    groups: null,
  },
  decision: { outcome: "login", username: "alice", reason: null },
  warnings: ["Groupes tronqués."],
};

async function ouvrir(m: ReturnType<typeof monter>): Promise<void> {
  await m.A.loadEnterpriseAuth();
  m.A.authModifier("sso");
  await vider();
}
const pomper = async (ms = 0): Promise<void> => {
  await vi.advanceTimersByTimeAsync(ms);
  await Vue.nextTick();
};
const cliquer = async (id: string): Promise<void> => {
  el(id)?.click();
  await pomper();
};

describe("tiroir SSO : réglages", () => {
  it("l'algorithme de signature a la liste du contrat, RS256 par défaut, et part dans le corps", async () => {
    const m = monter(etat({ providers: [OIDC] }));
    await ouvrir(m);
    const sel = document.querySelector<HTMLSelectElement>("[data-id-token-alg]")!;
    expect(sel.value).toBe("RS256");
    expect([...sel.options].map((o) => o.value)).toEqual([
      "RS256",
      "RS384",
      "RS512",
      "PS256",
      "PS384",
      "PS512",
      "ES256",
      "ES384",
      "ES512",
      "EdDSA",
    ]);
    sel.value = "ES256";
    sel.dispatchEvent(new Event("change", { bubbles: true }));
    await vider();
    m.reponses["PUT /api/admin/auth/providers/sso"] = [json(etat({ providers: [OIDC] }))];
    await clic("#ent-enregistrer-fournisseur");
    expect(
      (m.corps["PUT /api/admin/auth/providers/sso"]?.[0] as Record<string, unknown>)["id_token_alg"],
    ).toBe("ES256");
  });

  it("la ligne du second facteur reste en place et suit la règle du serveur : pour tous les comptes, pour les administrateurs seulement, ou aucun ; seuls les niveaux déclarés comptent", async () => {
    const m = monter(etat({ providers: [OIDC] }));
    await ouvrir(m);
    const f = m.A.authTiroir.value!;
    const ligne = async (acr: string, amr: string, mfa = "", admins = false) => {
      f.required_acr = acr;
      f.required_amr = amr;
      f.mfa_acr = mfa;
      f.roles_enabled = admins;
      f.admin_groups = admins ? ["admins"] : [];
      await vider();
      return document.querySelector("[data-aide-second-facteur]")?.textContent?.trim();
    };
    const AUCUN = "⚠ Aucun second facteur garanti par Elpis.";
    const ADMINS = "⚠ Second facteur exigé des administrateurs seulement : les autres comptes peuvent entrer";
    expect(await ligne("", "")).toBe(AUCUN);
    expect(await ligne("", "mfa")).toBe("Second facteur exigé pour tous les comptes : amr mfa.");
    expect(await ligne("urn:gold", "", "urn:gold")).toBe(
      "Second facteur exigé pour tous les comptes : acr urn:gold.",
    );
    expect(await ligne("loa-5", "", "loa-5")).toBe("Second facteur exigé pour tous les comptes : acr loa-5.");
    expect(await ligne("gold silver", "otp, hwk", "silver gold")).toBe(
      "Second facteur exigé pour tous les comptes : acr gold ou silver et amr otp ou hwk.",
    );
    expect(await ligne("0 urn:gold", "MFA")).toBe(
      "Second facteur exigé pour tous les comptes : acr 0 ou urn:gold et amr MFA.",
    );
    expect(await ligne("", "pwd otp", "", true)).toBe(`${ADMINS} avec amr pwd ou otp.`);
    expect(await ligne("", "otp hwk", "", true)).toBe(`${ADMINS} avec amr otp ou hwk.`);
    expect(await ligne("0 urn:gold", "", "urn:gold", true)).toBe(`${ADMINS} avec acr 0.`);
    expect(await ligne("1 urn:gold", "pwd mfa", "urn:gold", true)).toBe(`${ADMINS} avec acr 1 et amr pwd.`);
    expect(await ligne("loa-2 loa-5", "", "loa-5", true)).toBe(`${ADMINS} avec acr loa-2.`);
    expect(await ligne("", "", "loa-5", true)).toBe(`${ADMINS} sans second facteur.`);
    expect(await ligne("urn:gold", "")).toBe(AUCUN);
    expect(await ligne("loa-2 loa-5", "", "", true)).toBe(AUCUN);
    expect(await ligne("2", "", "", true)).toBe(AUCUN);
    expect(await ligne("", "pwd otp")).toBe(AUCUN);
    expect(await ligne("0 urn:gold", "", "urn:gold")).toBe(AUCUN);
    expect(await ligne("1", "pwd", "", true)).toBe(AUCUN);
    const TOUJOURS =
      "⚠ Administrateurs toujours refusés : aucun des niveaux exigés (acr) n'est déclaré comme second facteur, et aucune méthode forte (amr) n'est exigée.";
    expect(await ligne("loa-2", "", "loa-5", true)).toBe(TOUJOURS);
    expect(await ligne("1 2", "pwd", "3", true)).toBe(TOUJOURS);
    expect(await ligne("loa-2", "otp", "loa-5", true)).toBe(`${ADMINS} avec acr loa-2 et amr otp.`);
    expect(await ligne("loa-2", "", "loa-5")).toBe(AUCUN);
    const avance = document.querySelector("details[data-section-tiroir='avance']");
    for (const id of ["#ent-acr", "#ent-mfa-acr"]) {
      expect(avance?.querySelector(id), id).toBeNull();
      expect(document.querySelector(`[data-section-tiroir='acces'] ${id}`), id).not.toBeNull();
    }
    expect(document.querySelector("[data-aide-mfa-acr]")?.textContent?.trim()).toBe(
      "Ceux que votre fournisseur ne délivre qu'après un second facteur.",
    );
  });

  it("section 4 : les trois champs du second facteur l'un sous l'autre, pleine largeur, dans l'ordre, chacun avec son aide écrite", async () => {
    const m = monter(etat({ providers: [OIDC] }));
    await ouvrir(m);
    const acces = document.querySelector("[data-section-tiroir='acces']")!;
    const champs = [...acces.querySelectorAll<HTMLElement>("[data-champ-acces]")];
    expect(champs.map((c) => c.dataset["champAcces"])).toEqual(["required_acr", "mfa_acr", "required_amr"]);
    for (const c of champs) {
      expect(c.parentElement, c.dataset["champAcces"]).toBe(acces);
      expect(c.closest(".grid"), c.dataset["champAcces"]).toBeNull();
      const champ = c.querySelector("input")!;
      expect(c.querySelector(`label[for='${champ.id}']`)?.textContent?.trim()).toMatch(/\((acr|amr)\)$/u);
      const aide = champ.getAttribute("aria-describedby")!.split(" ");
      expect(aide).toContain("ent-second-facteur");
      const propre = document.getElementById(aide[0] ?? "");
      expect(propre?.parentElement, champ.id).toBe(c);
      expect(propre?.textContent?.trim().length, champ.id).toBeGreaterThan(10);
    }
  });

  it("le champ des niveaux qui prouvent un second facteur est relu des réglages et part dans le corps, vide compris", async () => {
    const m = monter(
      etat({ providers: [{ ...OIDC, required_acr: ["loa-2", "loa-5"], mfa_acr: ["loa-5"] }] }),
    );
    await ouvrir(m);
    const champ = document.querySelector<HTMLInputElement>("#ent-mfa-acr")!;
    expect(champ.value).toBe("loa-5");
    m.reponses["PUT /api/admin/auth/providers/sso"] = [json(etat({ providers: [OIDC] }))];
    await clic("#ent-enregistrer-fournisseur");
    expect((m.corps["PUT /api/admin/auth/providers/sso"]?.[0] as Record<string, unknown>)["mfa_acr"]).toEqual(
      ["loa-5"],
    );
  });
});

describe("tiroir SSO : essai de connexion", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  async function lancer(url: string | null, ok = true, steps: unknown[] = [ETAPE_OK]) {
    const m = monter(etat({ providers: [OIDC] }));
    await ouvrir(m);
    const ouvrirOnglet = vi.spyOn(window, "open").mockReturnValue(null);
    m.reponses["POST " + TRIAL] = [json({ ok, steps, url })];
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    vi.setSystemTime(new Date(1000 * 1500));
    await cliquer("#ent-trial");
    return { m, ouvrirOnglet };
  }
  const lectures = (m: ReturnType<typeof monter>) => m.appels.filter((a) => a === "GET " + TRIAL).length;

  it("ouvre l'adresse https dans un nouvel onglet sans opener", async () => {
    const { ouvrirOnglet } = await lancer("https://idp.example.lan/auth?x=1");
    expect(ouvrirOnglet).toHaveBeenCalledWith("https://idp.example.lan/auth?x=1", "_blank", "noopener");
  });

  it("n'ouvre rien quand l'adresse n'est pas https ou absente", async () => {
    for (const url of ["http://idp.example.lan/a", "javascript:alert(1)", null]) {
      const { ouvrirOnglet } = await lancer(url);
      expect(ouvrirOnglet).not.toHaveBeenCalled();
      demonter();
      vi.useRealTimers();
    }
  });

  it("étapes en échec : elles s'affichent, aucun onglet, aucune interrogation", async () => {
    const { m, ouvrirOnglet } = await lancer(null, false, [
      { id: "jwks", label: "Clés", level: "fail", detail: "Illisibles.", target: null },
    ]);
    expect(ouvrirOnglet).not.toHaveBeenCalled();
    expect(document.querySelector('[data-etape="jwks"]')).not.toBeNull();
    await pomper(10000);
    expect(lectures(m)).toBe(0);
  });

  it("interroge toutes les 2 s, ignore un résultat ancien, affiche la décision et recharge l'état", async () => {
    const { m } = await lancer("https://idp.example.lan/auth");
    m.reponses["GET " + TRIAL] = [
      json({ result: { ...RESULTAT, at: 100 } }),
      json({ result: { ...RESULTAT, at: 100 } }),
      json({ result: RESULTAT }),
    ];
    await pomper(2000);
    expect(lectures(m)).toBe(1);
    expect(el("#ent-trial-decision")).toBeNull();
    await pomper(2000);
    expect(lectures(m)).toBe(2);
    await pomper(2000);
    expect(lectures(m)).toBe(3);
    expect(el("#ent-trial-decision")?.textContent?.trim()).toBe(
      "Cette personne se connecterait au compte alice.",
    );
    const liste = document.querySelector("[data-revendications]")!;
    expect(liste.textContent).toContain("groupes absents ou illisibles");
    expect(liste.textContent).toContain("alice@example.lan (vérifié)");
    expect(liste.querySelector("b")).toBeNull();
    expect(document.querySelector("[data-avertissement-essai]")?.textContent).toBe("Groupes tronqués.");
    const lecturesEtat = m.appels.filter((a) => a === "GET /api/admin/auth").length;
    expect(lecturesEtat).toBeGreaterThan(1);
    await pomper(10000);
    expect(lectures(m)).toBe(3);
  });

  it("s'arrête au bout de 5 minutes avec un message", async () => {
    const { m } = await lancer("https://idp.example.lan/auth");
    m.reponses["GET " + TRIAL] = [json({ result: null })];
    await pomper(300000 + 4000);
    const n = lectures(m);
    expect(n).toBeGreaterThanOrEqual(100);
    expect(n).toBeLessThanOrEqual(151);
    expect(el("#ent-trial-erreur")?.textContent).toContain("n'a pas abouti à temps");
    await pomper(20000);
    expect(lectures(m)).toBe(n);
  });

  it("fermer le tiroir arrête l'interrogation", async () => {
    const { m } = await lancer("https://idp.example.lan/auth");
    m.reponses["GET " + TRIAL] = [json({ result: null })];
    await pomper(4000);
    const n = lectures(m);
    m.A.authFermer();
    await pomper(20000);
    expect(lectures(m)).toBe(n);
  });

  it("phrases de décision : création, refus en clair, jamais le texte du fournisseur", async () => {
    expect(phraseDecision({ outcome: "create", username: "bob", reason: null })).toBe(
      "Un compte bob serait créé.",
    );
    expect(phraseDecision({ outcome: "refuse", username: null, reason: "not_in_group" })).toBe(
      "Connexion refusée : la personne n'est dans aucun groupe requis.",
    );
    expect(phraseDecision({ outcome: "refuse", username: null, reason: "<i>x</i>" as never })).toBe(
      "Connexion refusée : cause non précisée.",
    );
    expect(phraseDecision({ outcome: "refuse", username: null, reason: "groups_unknown" })).toBe(
      "Connexion refusée : groupes absents ou illisibles (aucune liste de groupes lisible reçue pour cette personne).",
    );
  });

  it("chaque raison que le serveur peut rendre à l'essai (liste fermée des contrats) a sa phrase dans la console ; une raison hors liste ne passe pas le schéma", () => {
    expect(Object.keys(RAISONS_ESSAI_PHRASES).sort()).toEqual([...new Set(RAISONS_ESSAI)].sort());
    for (const reason of RAISONS_ESSAI)
      for (const outcome of ["refuse", "error"] as const) {
        const p = phraseDecision({ outcome, username: null, reason });
        expect(p, reason).not.toContain("cause non précisée");
        expect(p, reason).toContain(RAISONS_ESSAI_PHRASES[reason]);
      }
    for (const reason of ["account_conflict", "name_invalid", "issuer_mismatch", "prelink_invalid"])
      expect(RAISONS_ESSAI, reason).toContain(reason);
    const brut = {
      ...RESULTAT,
      decision: { outcome: "refuse", username: null, reason: "texte du fournisseur" },
    };
    expect(schemaResultatEssaiBlanc.safeParse(brut).success).toBe(false);
  });

  it("échecs techniques : la cause, l'action à faire et la section où la faire, sans détail interne", () => {
    const phrase = (reason: ResultatEssaiBlanc["decision"]["reason"]) =>
      phraseDecision({ outcome: "error", username: null, reason });
    expect(phrase("client_auth_rejected")).toBe(
      "L'essai a échoué : le fournisseur refuse l'authentification du client ; vérifiez le secret client (section 3) et la méthode d'authentification du client (token_endpoint_auth_method, section 6) tels que réglés chez le fournisseur.",
    );
    expect(phrase("aud_untrusted")).toContain("retirez chez le fournisseur les audiences ajoutées");
    expect(phrase("alg_unexpected")).toContain("section 6 (id_token_signed_response_alg)");
    expect(phrase("secret_missing")).toContain("section 3");
    expect(phrase("code_rejected")).toContain("adresse de retour déclarée chez lui (section 2)");
    expect(phrase("token_mismatch")).toContain("issuer, section 1");
    expect(phrase("settings_changed")).toContain("relancez « Se connecter pour essayer »");
    for (const r of RAISONS_ESSAI)
      expect(RAISONS_ESSAI_PHRASES[r], r).not.toMatch(/lib:|OAUTH_|token_endpoint:|cause_/u);
  });

  it("décisions de compte : rattachement préparé avec preuve ou dispense, refus pour un compte nommé", () => {
    expect(phraseDecision({ outcome: "proof", username: "homonyme", reason: null })).toBe(
      "Cette personne devrait d'abord saisir l'ancien mot de passe du compte homonyme pour s'y rattacher ; à cette première connexion, ses droits ne peuvent que baisser.",
    );
    expect(phraseDecision({ outcome: "link", username: "jean", reason: null })).toBe(
      "Cette personne serait rattachée au compte jean sans ancien mot de passe (dispense), puis connectée.",
    );
    expect(phraseDecision({ outcome: "refuse", username: "alice", reason: "suspended" })).toBe(
      "Connexion refusée pour le compte alice : le compte est suspendu.",
    );
    expect(phraseDecision({ outcome: "refuse", username: "homonyme", reason: "account_conflict" })).toBe(
      "Connexion refusée pour le compte homonyme : un compte local porte déjà ce nom ; préparez son rattachement (carte « 3. Comptes existants »).",
    );
  });

  it("nom pris par un compte déjà rattaché : pas de rattachement à préparer, mais l'action pour une personne à deux identités ; un compte local garde la sienne", async () => {
    const LOCAL =
      "Connexion refusée pour le compte homonyme : un compte local porte déjà ce nom ; préparez son rattachement (carte « 3. Comptes existants »).";
    const conflit = (conflict_linked?: boolean) =>
      phraseDecision({
        outcome: "refuse",
        username: "chloe-martin",
        reason: "account_conflict",
        ...(conflict_linked === undefined ? {} : { conflict_linked }),
      });
    expect(conflit(true)).toBe(
      "Connexion refusée pour le compte chloe-martin : un compte rattaché à un fournisseur porte déjà ce nom, et une personne n'a qu'une identité ; renommez son identifiant chez l'un des fournisseurs, ou supprimez dans Comptes le compte Elpis en trop (voir le guide).",
    );
    expect(conflit(true)).not.toMatch(/local|préparez/u);
    expect(conflit(false)).toBe(LOCAL.replace("homonyme", "chloe-martin"));
    expect(conflit()).toBe(conflit(false));
    expect(
      phraseDecision({ outcome: "refuse", username: null, reason: "name_invalid", conflict_linked: true }),
    ).toBe(`Connexion refusée : ${RAISONS_ESSAI_PHRASES.name_invalid}.`);
    const decision = { outcome: "refuse", username: "chloe-martin", reason: "account_conflict" };
    expect(schemaResultatEssaiBlanc.safeParse({ ...RESULTAT, decision }).success).toBe(true);
    expect(
      schemaResultatEssaiBlanc.safeParse({ ...RESULTAT, decision: { ...decision, conflict_linked: true } })
        .success,
    ).toBe(true);
    expect(
      schemaResultatEssaiBlanc.safeParse({ ...RESULTAT, decision: { ...decision, conflict_linked: "oui" } })
        .success,
    ).toBe(false);

    const { m } = await lancer("https://idp.example.lan/auth");
    m.reponses["GET " + TRIAL] = [
      json({ result: { ...RESULTAT, ok: false, decision: { ...decision, conflict_linked: true } } }),
    ];
    await pomper(2000);
    expect(el("#ent-trial-decision")?.textContent?.trim()).toBe(conflit(true));
  });

  it("refus : aucun rôle annoncé (les droits d'un refus ne sont pas rendus)", () => {
    expect(lignesDroits(null)).toEqual([]);
    const lisible = {
      roles_enabled: true,
      groups_enabled: false,
      readable: false,
      role: null,
      groups: [],
      missing_group_ids: [],
      admin_ignored: false,
    };
    expect(lignesDroits(lisible)).toEqual([
      "Groupes absents ou illisibles : aucun rôle ni groupe ne serait modifié.",
    ]);
  });

  it("les revendications disent si le jeton prouve un second facteur et, sinon, ce qui manque selon les réglages", () => {
    const AMR = { required_acr: [], required_amr: ["pwd", "otp"], mfa_acr: [] };
    const ACR = { required_acr: ["loa-2", "loa-5"], required_amr: [], mfa_acr: ["loa-5"] };
    const LES_DEUX = { required_acr: [], required_amr: ["otp"], mfa_acr: ["loa-5"] };
    const RIEN = { required_acr: [], required_amr: [], mfa_acr: [] };
    const ligne = (
      c: Partial<NonNullable<ResultatEssaiBlanc["claims"]>>,
      e: Parameters<typeof lignesRevendications>[1] = ACR,
    ) => new Map(lignesRevendications({ ...RESULTAT.claims, ...c }, e)).get("Second facteur");
    expect(ligne({ acr: "loa-5", second_factor: "acr" })).toBe("prouvé par le niveau acr");
    expect(ligne({ acr: "1", amr: ["pwd", "otp"], second_factor: "amr" }, AMR)).toBe(
      "prouvé par les méthodes amr",
    );
    expect(ligne({ acr: "loa-2", second_factor: null })).toBe(
      "non prouvé : le niveau acr reçu n'est pas déclaré comme second facteur ; les méthodes amr reçues ne suffisent pas (mfa, mca, ou deux familles comme pwd et otp)",
    );
    expect(ligne({ acr: null, amr: [], second_factor: null })).toBe(
      "non prouvé : aucun niveau acr reçu ; aucune méthode amr reçue",
    );
    expect(ligne({ acr: "1", amr: ["pwd"], second_factor: null }, AMR)).toBe(
      "non prouvé : les méthodes amr reçues ne suffisent pas (mfa, mca, ou deux familles comme pwd et otp)",
    );
    expect(ligne({ acr: "1", amr: [], second_factor: null }, AMR)).toBe(
      "non prouvé : aucune méthode amr reçue",
    );
    expect(ligne({ acr: "1", amr: ["pwd"], second_factor: null }, LES_DEUX)).toBe(
      "non prouvé : le niveau acr reçu n'est pas déclaré comme second facteur ; les méthodes amr reçues ne suffisent pas (mfa, mca, ou deux familles comme pwd et otp)",
    );
    expect(ligne({ acr: "1", second_factor: null }, RIEN)).toBe(
      "non prouvé : aucun second facteur n'est demandé à ce fournisseur (section 4)",
    );
    expect(new Map(lignesRevendications(RESULTAT.claims, ACR)).get("Groupes")).toBe(
      "groupes absents ou illisibles",
    );
  });

  it("409 : détail affiché ; 409 avec canonical : phrase dédiée", async () => {
    const m = monter(etat({ providers: [OIDC] }));
    await ouvrir(m);
    m.reponses["POST " + TRIAL] = [json({ detail: "Désactivez d'abord le fournisseur." }, 409)];
    await clic("#ent-trial");
    expect(el("#ent-trial-erreur")?.textContent).toContain("Désactivez d'abord le fournisseur.");
    m.reponses["POST " + TRIAL] = [json({ detail: "Hôte", canonical: "https://elpis.example.lan" }, 409)];
    await clic("#ent-trial");
    expect(el("#ent-trial-erreur")?.textContent).toContain(
      "Ouvrez la console depuis https://elpis.example.lan pour lancer l'essai.",
    );
  });

  it("Activer se dégrise quand l'état relu dit tested", async () => {
    const m = monter(etat({ providers: [OIDC] }));
    await ouvrir(m);
    expect(el<HTMLButtonElement>("#ent-activer")?.disabled).toBe(true);
    expect(el<HTMLButtonElement>("#ent-activer")?.title).toBe(
      "Réussissez d'abord « Se connecter pour essayer ».",
    );
    m.reponses["GET /api/admin/auth"] = [json(etat({ providers: [{ ...OIDC, tested: true }] }))];
    await m.A.loadEnterpriseAuth();
    await vider();
    expect(el<HTMLButtonElement>("#ent-activer")?.disabled).toBe(false);
  });
});

describe("tiroir SSO : « Se connecter pour essayer » toujours visible", () => {
  it("grisé avec sa raison écrite : fournisseur activé, puis adresse publique absente", async () => {
    const m = monter(etat({ providers: [{ ...OIDC, enabled: true, active: true, tested: true }] }));
    await ouvrir(m);
    expect(el<HTMLButtonElement>("#ent-trial")?.disabled).toBe(true);
    expect(el("[data-raison-essai]")?.textContent?.trim()).toBe(
      "Désactivez d'abord ce fournisseur pour l'essayer.",
    );
    await clic("#ent-trial");
    expect(m.appels.some((a) => a.startsWith("POST " + TRIAL))).toBe(false);
    demonter();
    const sansAdresse = monter(etat({ public_url: "", providers: [OIDC] }));
    await ouvrir(sansAdresse);
    expect(el<HTMLButtonElement>("#ent-trial")?.disabled).toBe(true);
    expect(el("[data-raison-essai]")?.textContent?.trim()).toBe(
      "Renseignez d'abord l'adresse publique en https.",
    );
  });
});
