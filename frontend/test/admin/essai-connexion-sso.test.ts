// SPDX-License-Identifier: MIT
/** frontend/test/admin/essai-connexion-sso.test.ts — console › fournisseur SSO : algorithme du jeton, aide du second facteur, essai de connexion (ouverture https seulement, interrogation bornée et arrêtée, décision, activation dégrisée). */
import * as Vue from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";

import { phraseDecision } from "../../src/features/admin/identite";
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

  it("l'aide du second facteur n'apparaît que si acr et amr sont vides", async () => {
    const m = monter(etat({ providers: [OIDC] }));
    await ouvrir(m);
    const aide = "Sans ce réglage, aucune vérification en deux étapes n'est garantie par Elpis.";
    expect(document.querySelector("[data-aide-second-facteur]")?.textContent?.trim()).toBe(aide);
    m.A.authTiroir.value!.required_amr = "mfa";
    await vider();
    expect(document.querySelector("[data-aide-second-facteur]")).toBeNull();
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
    expect(liste.textContent).toContain("groupes non lisibles");
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
    expect(phraseDecision({ outcome: "refuse", username: null, reason: "<i>x</i>" })).toBe(
      "Connexion refusée : cause non précisée.",
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
    expect(el<HTMLButtonElement>("#ent-activer")?.title).toBe("Lancez d'abord un essai de connexion.");
    m.reponses["GET /api/admin/auth"] = [json(etat({ providers: [{ ...OIDC, tested: true }] }))];
    await m.A.loadEnterpriseAuth();
    await vider();
    expect(el<HTMLButtonElement>("#ent-activer")?.disabled).toBe(false);
  });
});
