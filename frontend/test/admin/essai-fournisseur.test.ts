// SPDX-License-Identifier: MIT
/** frontend/test/admin/essai-fournisseur.test.ts — console › SSO OpenID Connect : étapes d'un test (niveaux, regroupement par cible, liste vide) et bouton « Contrôler les réglages » du tiroir (réglages non enregistrés sans secret, effacement à la saisie, test incomplet, 429). */
import { createApp, defineComponent, h } from "vue";
import type { App } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";

import EtapesEssai from "../../src/components/admin/EtapesEssai.vue";
import { reinitialiserSuiviChargement } from "../../src/features/admin/suivi-chargement";
import { json, vider } from "../aides";
import { OIDC as OIDC_BASE, clic, demonter, el, etat as etatAide, monter, saisir } from "./rattachement-aide";

const OIDC = { ...OIDC_BASE, issuer: "https://idp.example.lan", scopes: ["openid"] };
const etat = (over: Record<string, unknown> = {}) => etatAide([], over);

const ETAPES = [
  { id: "settings", label: "Réglages", level: "ok", detail: "Réglages valides.", target: null },
  { id: "tcp", label: "Connexion", level: "warn", detail: "Réponse lente.", target: "idp.example.lan:443" },
  {
    id: "tls",
    label: "Certificat",
    level: "fail",
    detail: "Certificat non reconnu.",
    target: "idp.example.lan:443",
  },
] as const;
const TEST = "POST /api/admin/auth/providers/test";

let appEtapes: App | null = null;
afterEach(() => {
  appEtapes?.unmount();
  appEtapes = null;
  demonter();
  reinitialiserSuiviChargement();
});

function monterEtapes(steps: unknown[]): HTMLElement {
  const hote = document.createElement("div");
  document.body.appendChild(hote);
  appEtapes = createApp(defineComponent({ setup: () => () => h(EtapesEssai, { steps: steps as never }) }));
  appEtapes.mount(hote);
  return hote;
}

async function ouvrirTiroir(m: ReturnType<typeof monter>): Promise<void> {
  await m.A.loadEnterpriseAuth();
  m.A.authModifier("sso");
  await vider();
}

describe("EtapesEssai", () => {
  it("rend les trois niveaux avec leur pictogramme et leur phrase", () => {
    const hote = monterEtapes([ETAPES[0], { ...ETAPES[1], target: null }, { ...ETAPES[2], target: null }]);
    const niveaux = [...hote.querySelectorAll("[data-etape]")].map((n) => n.getAttribute("data-niveau"));
    expect(niveaux).toEqual(["ok", "warn", "fail"]);
    const texte = hote.textContent ?? "";
    expect(texte).toContain("✓");
    expect(texte).toContain("⚠");
    expect(texte).toContain("✗");
    expect(texte).toContain("Certificat non reconnu.");
    expect(hote.querySelector('[data-niveau="fail"]')?.className).toContain("text-red-600");
    expect(hote.querySelector('[data-niveau="ok"]')?.className).not.toMatch(/red|amber|emerald/u);
    expect(hote.querySelector("[data-etapes-essai]")?.getAttribute("aria-live")).toBeNull();
  });

  it("une seule cible : affichée discrètement sur chaque ligne, sans regroupement", () => {
    const hote = monterEtapes([ETAPES[0], ETAPES[1], ETAPES[2]]);
    expect(hote.querySelectorAll("[data-cible-groupe]")).toHaveLength(0);
    expect(hote.textContent).toContain("idp.example.lan:443");
  });

  it("plusieurs cibles : les étapes d'une même cible sont regroupées sous elle", () => {
    const hote = monterEtapes([
      ETAPES[0],
      { id: "a1", label: "Connexion", level: "ok", detail: "ok", target: "a.example.lan:636" },
      { id: "b1", label: "Connexion", level: "fail", detail: "refusée", target: "b.example.lan:636" },
      { id: "a2", label: "Certificat", level: "ok", detail: "ok", target: "a.example.lan:636" },
    ]);
    const cibles = [...hote.querySelectorAll("[data-cible-groupe]")].map((n) => n.textContent?.trim());
    expect(cibles).toEqual(["a.example.lan:636", "b.example.lan:636"]);
    const groupeA = hote.querySelectorAll("[data-groupe-essai]")[1];
    expect(groupeA?.querySelectorAll("[data-etape]")).toHaveLength(2);
  });

  it("liste vide : une phrase, aucune ligne", () => {
    const hote = monterEtapes([]);
    expect(hote.querySelector("[data-etapes-vide]")).not.toBeNull();
    expect(hote.querySelectorAll("[data-etape]")).toHaveLength(0);
  });
});

describe("SSO OpenID Connect : bouton « Contrôler les réglages »", () => {
  it("envoie les réglages du formulaire non enregistrés, jamais le secret saisi", async () => {
    const m = monter(etat({ providers: [OIDC] }));
    m.reponses[TEST] = [json({ ok: true, steps: [ETAPES[0]] })];
    await ouvrirTiroir(m);
    await saisir("#ent-label", "SSO modifié");
    await saisir("#ent-secret", "jamais-envoye");
    await clic("#ent-tester");
    expect(m.appels.filter((a) => a === TEST)).toHaveLength(1);
    expect(m.appels.some((a) => a.startsWith("PUT "))).toBe(false);
    const corps = m.corps[TEST]?.[0] as Record<string, unknown>;
    expect(corps["label"]).toBe("SSO modifié");
    expect(corps["type"]).toBe("oidc");
    expect(corps["id"]).toBe("sso");
    expect(corps["issuer"]).toBe("https://idp.example.lan");
    expect(corps).not.toHaveProperty("secret");
    expect(JSON.stringify(corps)).not.toContain("jamais-envoye");
  });

  it("test réussi : synthèse, activation toujours grisée sans essai de connexion", async () => {
    const m = monter(etat({ providers: [OIDC] }));
    m.reponses[TEST] = [json({ ok: true, steps: [ETAPES[0]] })];
    await ouvrirTiroir(m);
    await clic("#ent-tester");
    expect(el("#ent-essai-synthese")?.textContent).toBe(
      "Les contrôles passent. Faites ensuite « Se connecter pour essayer » pour pouvoir activer ce fournisseur.",
    );
    expect(document.querySelectorAll("[data-etape]")).toHaveLength(1);
    expect(el<HTMLButtonElement>("#ent-activer")?.disabled).toBe(true);
  });

  const PRET = { ...OIDC, tested: true };
  const SYNTHESES: [string, unknown, string, string][] = [
    ["activable", PRET, "", "Les contrôles passent. Ce fournisseur peut être activé (section 8)."],
    [
      "secret manquant",
      { ...PRET, has_secret: false },
      "",
      "Les contrôles passent. Enregistrez d'abord le secret.",
    ],
    ["modifié", PRET, "Autre libellé", "Les contrôles passent. Enregistrez d'abord vos modifications."],
    ["déjà activé", { ...PRET, enabled: true, active: true }, "", "Les contrôles passent."],
  ];
  for (const [nom, p, libelle, attendu] of SYNTHESES)
    it(`la synthèse ne dit « peut être activé » que si la section 8 le permet : ${nom}`, async () => {
      const m = monter(etat({ providers: [p] }));
      m.reponses[TEST] = [json({ ok: true, steps: [ETAPES[0]] })];
      await ouvrirTiroir(m);
      if (libelle) await saisir("#ent-label", libelle);
      await clic("#ent-tester");
      expect(el("#ent-essai-synthese")?.textContent).toBe(attendu);
    });

  it("un test raté reste affiché avec « Un contrôle a échoué. »", async () => {
    const m = monter(etat({ providers: [OIDC] }));
    m.reponses[TEST] = [json({ ok: false, steps: ETAPES })];
    await ouvrirTiroir(m);
    await clic("#ent-tester");
    expect(el("#ent-essai-synthese")?.textContent).toBe("Un contrôle a échoué.");
    expect(document.querySelectorAll("[data-etape]")).toHaveLength(3);
  });

  it("un simple avertissement n'est pas annoncé comme un échec", async () => {
    const m = monter(etat({ providers: [OIDC] }));
    const avert = [
      { id: "tls", label: "Certificat", level: "warn", detail: "Échéance dans 12 jours.", target: null },
    ];
    m.reponses[TEST] = [json({ ok: true, steps: avert })];
    await ouvrirTiroir(m);
    await clic("#ent-tester");
    expect(el("#ent-essai-synthese")?.textContent).not.toBe("Un contrôle a échoué.");
    expect(document.querySelectorAll("[data-etape]")).toHaveLength(1);
  });

  it("rien saisi : aucun secret dans la requête", async () => {
    const m = monter(etat({ providers: [OIDC] }));
    m.reponses[TEST] = [json({ ok: true, steps: [ETAPES[0]] })];
    await ouvrirTiroir(m);
    await clic("#ent-tester");
    const corps = m.corps[TEST]?.[0] as Record<string, unknown>;
    expect(corps).not.toHaveProperty("secret");
  });

  it("le secret saisi ne part pas dans la requête de test, n'est ni affiché ni gardé, et disparaît avec le tiroir", async () => {
    const SECRET = "S3cret-d-essai-unique";
    const journal: string[] = [];
    const espions = (["log", "info", "warn", "error", "debug"] as const).map((n) =>
      vi
        .spyOn(console, n)
        .mockImplementation((...a: unknown[]) => void journal.push(a.map(String).join(" "))),
    );
    try {
      const m = monter(etat({ providers: [OIDC] }));
      m.reponses[TEST] = [json({ ok: true, steps: [ETAPES[0]] })];
      await ouvrirTiroir(m);
      await saisir("#ent-secret", SECRET);
      await clic("#ent-tester");
      const corps = m.corps[TEST]?.[0] as Record<string, unknown>;
      expect(corps).not.toHaveProperty("secret");
      for (const cle of Object.keys(m.corps)) expect(JSON.stringify(m.corps[cle])).not.toContain(SECRET);
      expect(m.appels.some((a) => a.includes(SECRET))).toBe(false);
      expect(JSON.stringify(m.A.authEssai.value)).not.toContain(SECRET);
      expect(JSON.stringify(m.A.authEtat.value)).not.toContain(SECRET);
      expect(document.body.textContent).not.toContain(SECRET);
      expect(el<HTMLInputElement>("#ent-secret")?.type).toBe("password");
      m.A.authFermer();
      await vider();
      expect(m.A.authTiroir.value).toBeNull();
      expect(JSON.stringify(m.A.authEssai.value)).not.toContain(SECRET);
      m.A.authModifier("sso");
      await vider();
      expect(el<HTMLInputElement>("#ent-secret")?.value).toBe("");
      expect(JSON.stringify(m.A.authTiroir.value)).not.toContain(SECRET);
      expect(document.body.innerHTML).not.toContain(SECRET);
      expect(window.location.href).not.toContain(SECRET);
      expect(JSON.stringify({ ...window.localStorage })).not.toContain(SECRET);
      expect(JSON.stringify({ ...window.sessionStorage })).not.toContain(SECRET);
      expect(journal.join("\n")).not.toContain(SECRET);
    } finally {
      espions.forEach((x) => x.mockRestore());
    }
  });

  it("un test ne recharge pas l'état", async () => {
    const m = monter(etat({ providers: [OIDC] }));
    m.reponses[TEST] = [json({ ok: true, steps: [ETAPES[0]] })];
    await ouvrirTiroir(m);
    await clic("#ent-tester");
    expect(m.appels.filter((a) => a === "GET /api/admin/auth")).toHaveLength(1);
  });

  it("pendant le test : bouton grisé avec indicateur d'attente, un seul envoi", async () => {
    const m = monter(etat({ providers: [OIDC] }));
    let fin: (r: Response) => void = () => undefined;
    m.reponses[TEST] = [() => new Promise<Response>((r) => (fin = r))];
    await ouvrirTiroir(m);
    await clic("#ent-tester");
    const b = el<HTMLButtonElement>("#ent-tester");
    expect(b?.disabled).toBe(true);
    expect(b?.textContent).toContain("Contrôle en cours");
    expect(b?.querySelector(".animate-spin")).not.toBeNull();
    await clic("#ent-tester");
    expect(m.appels.filter((a) => a === TEST)).toHaveLength(1);
    fin(json({ ok: true, steps: [ETAPES[0]] }));
    await vider();
    expect(el<HTMLButtonElement>("#ent-tester")?.disabled).toBe(false);
    expect(el("#ent-essai-synthese")).not.toBeNull();
  });

  it("le résultat s'efface dès qu'un champ change", async () => {
    const m = monter(etat({ providers: [OIDC] }));
    m.reponses[TEST] = [json({ ok: true, steps: [ETAPES[0]] })];
    await ouvrirTiroir(m);
    await clic("#ent-tester");
    expect(el("#ent-essai-synthese")).not.toBeNull();
    await saisir("#ent-label", "Autre libellé");
    expect(el("#ent-essai-synthese")).toBeNull();
    expect(document.querySelectorAll("[data-etape]")).toHaveLength(0);
  });

  it("une réponse arrivée après une modification du formulaire est ignorée", async () => {
    const m = monter(etat({ providers: [OIDC] }));
    let fin: (r: Response) => void = () => undefined;
    m.reponses[TEST] = [() => new Promise<Response>((r) => (fin = r))];
    await ouvrirTiroir(m);
    await clic("#ent-tester");
    await saisir("#ent-label", "Autre libellé");
    fin(json({ ok: true, steps: [ETAPES[0]] }));
    await vider();
    expect(el("#ent-essai-synthese")).toBeNull();
    expect(el<HTMLButtonElement>("#ent-tester")?.disabled).toBe(false);
  });

  it("un 429 affiche le message du serveur", async () => {
    const m = monter(etat({ providers: [OIDC] }));
    const detail = "Deux tests sont déjà en cours, réessayez dans un instant.";
    m.reponses[TEST] = [json({ detail }, 429)];
    await ouvrirTiroir(m);
    await clic("#ent-tester");
    expect(el("#ent-essai-erreur")?.textContent?.trim()).toBe(detail);
    expect(el("#ent-essai-synthese")).toBeNull();
  });

  it("la carte Fournisseurs ne dit plus que le test est indisponible", async () => {
    const m = monter(etat({ providers: [OIDC] }));
    await m.A.loadEnterpriseAuth();
    await vider();
    expect(m.hote.textContent).not.toContain("pas encore disponible");
  });
});
