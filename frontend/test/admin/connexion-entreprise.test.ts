// SPDX-License-Identifier: MIT
/** frontend/test/admin/connexion-entreprise.test.ts — console › Connexion d'entreprise : page vide, création d'un SSO, secret en écriture seule, Activer grisé, erreurs du serveur, champs figés, confirmations. */
import { afterEach, describe, expect, it } from "vitest";

import { reinitialiserSuiviChargement } from "../../src/features/admin/suivi-chargement";
import { json, vider } from "../aides";
import { OIDC, clic, demonter, el, etat as etatAide, monter, saisir } from "./rattachement-aide";

const etat = (over: Record<string, unknown> = {}) => etatAide([], over);

afterEach(() => {
  demonter();
  reinitialiserSuiviChargement();
});

async function ouvrir(m: ReturnType<typeof monter>): Promise<void> {
  await m.A.loadEnterpriseAuth();
  await vider();
}

describe("Connexion d'entreprise : page vide", () => {
  it("dit « Connexion locale seule » et liste les prérequis", async () => {
    const m = monter(
      etat({ prerequisites: { public_url_https: false, cookie_secure: false, local_admins: 0 } }),
    );
    expect(m.hote.querySelector('[aria-busy="true"]')).not.toBeNull();
    await ouvrir(m);
    const t = m.hote.textContent ?? "";
    expect(t).toContain("Connexion locale seule");
    expect(t).toContain("Rien ne change tant qu'aucun fournisseur n'est activé");
    expect(t).toContain("✗ Adresse publique en https");
    expect(t).toContain("Activez l'accès HTTPS, puis redémarrez.");
    expect(t).toContain("Aucun fournisseur déclaré.");
  });

  it("« Administrateurs seulement » demande une confirmation avant l'écriture", async () => {
    const m = monter();
    await ouvrir(m);
    m.A.authMode.value = "admins";
    m.refuser();
    await m.A.authEnregistrerReglages();
    expect(m.confirmations).toHaveLength(1);
    expect(m.appels.some((a) => a.startsWith("PUT"))).toBe(false);
  });

  it("enregistre l'adresse publique et recharge l'état de la réponse", async () => {
    const m = monter();
    m.reponses["PUT /api/admin/auth/settings"] = [json(etat({ public_url: "https://autre.example.lan" }))];
    await ouvrir(m);
    await saisir("#ent-url", "https://autre.example.lan");
    await clic("#ent-enregistrer");
    expect(m.corps["PUT /api/admin/auth/settings"]).toEqual([{ public_url: "https://autre.example.lan" }]);
    expect(m.A.authEtat.value?.public_url).toBe("https://autre.example.lan");
    expect(m.A.authReglagesModifies.value).toBe(false);
  });
});

describe("Connexion d'entreprise : création", () => {
  it("SSO OpenID Connect : corps, adresses à déclarer et Copier", async () => {
    const m = monter();
    m.reponses["POST /api/admin/auth/providers"] = [json(etat({ providers: [OIDC] }))];
    await ouvrir(m);
    await clic("#ent-ajouter");
    expect(el("#ent-retour")).toBeNull();
    await saisir("#ent-id", "sso");
    await saisir("#ent-label", "SSO siège");
    await saisir("#ent-issuer", "https://sso.example.lan/realms/x");
    await saisir("#ent-client", "elpis");
    expect(el("#ent-retour")?.textContent).toBe("https://elpis.example.lan/api/auth/oidc/sso/callback");
    expect(el("#ent-deconnexion")?.textContent).toBe(
      "https://elpis.example.lan/api/auth/oidc/sso/backchannel-logout",
    );
    await clic("#ent-enregistrer-fournisseur");
    const [creation] = m.corps["POST /api/admin/auth/providers"] ?? [];
    expect(creation).toMatchObject({
      id: "sso",
      type: "oidc",
      issuer: "https://sso.example.lan/realms/x",
      client_id: "elpis",
    });
    expect(m.appels).not.toContain("PUT /api/admin/auth/providers/sso/secret");
  });

  it("sans adresse publique, aucune adresse à déclarer", async () => {
    const m = monter(etat({ public_url: "" }));
    await ouvrir(m);
    await clic("#ent-ajouter");
    await saisir("#ent-id", "sso");
    expect(el("#ent-retour")).toBeNull();
  });

  it("un champ obligatoire vide n'est pas envoyé", async () => {
    const m = monter();
    await ouvrir(m);
    await clic("#ent-ajouter");
    await clic("#ent-enregistrer-fournisseur");
    expect(m.appels.some((a) => a.startsWith("POST"))).toBe(false);
    expect(document.body.textContent).toContain("à renseigner");
  });
});

describe("Connexion d'entreprise : fournisseur existant", () => {
  it("le secret enregistré n'est jamais réaffiché ni renvoyé à l'enregistrement", async () => {
    const m = monter(etat({ providers: [OIDC] }));
    m.reponses["PUT /api/admin/auth/providers/sso"] = [json(etat({ providers: [OIDC] }))];
    await ouvrir(m);
    m.hote.querySelector<HTMLButtonElement>('button[aria-label="Modifier SSO siège"]')?.click();
    await vider();
    const champ = el<HTMLInputElement>("#ent-secret");
    expect(champ?.value).toBe("");
    expect(champ?.placeholder).toBe("Inchangé");
    expect(el("#ent-secret-etat")?.textContent).toContain("Enregistré");
    await clic("#ent-enregistrer-fournisseur");
    expect(m.corps["PUT /api/admin/auth/providers/sso"]?.[0]).not.toHaveProperty("secret");
    expect(m.appels).not.toContain("PUT /api/admin/auth/providers/sso/secret");
    expect(m.corps["PUT /api/admin/auth/providers/sso"]?.[0]).not.toHaveProperty("id");
    expect(m.corps["PUT /api/admin/auth/providers/sso"]?.[0]).not.toHaveProperty("enabled");
  });

  it("Activer est grisé tant que le fournisseur n'est pas testé", async () => {
    const m = monter(etat({ providers: [OIDC] }));
    await ouvrir(m);
    m.A.authModifier("sso");
    await vider();
    const b = el<HTMLButtonElement>("#ent-activer");
    expect(b?.disabled).toBe(true);
    expect(b?.title).toBe("Lancez d'abord un essai de connexion.");
    await clic("#ent-activer");
    expect(m.appels.some((a) => a.includes("/enable"))).toBe(false);
  });

  it("le message d'un 409 du serveur est affiché tel quel", async () => {
    const m = monter(etat({ providers: [OIDC] }));
    m.reponses["PUT /api/admin/auth/providers/sso"] = [
      json({ detail: "Ce réglage ne se modifie plus : des comptes sont rattachés à ce fournisseur." }, 409),
    ];
    await ouvrir(m);
    m.A.authModifier("sso");
    await vider();
    await clic("#ent-enregistrer-fournisseur");
    expect(document.body.textContent).toContain("des comptes sont rattachés à ce fournisseur");
    expect(el("#ent-label")).not.toBeNull();
  });

  it("des comptes rattachés figent l'autorité et l'identifiant client avec leur raison", async () => {
    const m = monter(etat({ providers: [{ ...OIDC, identities: 3 }] }));
    await ouvrir(m);
    m.A.authModifier("sso");
    await vider();
    const issuer = el<HTMLInputElement>("#ent-issuer");
    expect(issuer?.disabled).toBe(true);
    expect(issuer?.title).toContain("des comptes sont rattachés");
    expect(el<HTMLInputElement>("#ent-client")?.disabled).toBe(true);
    expect(el<HTMLInputElement>("#ent-label")?.disabled).toBe(false);
    expect(el<HTMLInputElement>("#ent-id")?.disabled).toBe(true);
    expect(m.A.authFige("subject_claim")).toContain("des comptes sont rattachés");
    expect(m.A.authFige("label")).toBe("");
  });

  it("un fournisseur actif a tous ses réglages grisés et propose Désactiver", async () => {
    const m = monter(etat({ providers: [{ ...OIDC, enabled: true, active: true, tested: true }] }));
    await ouvrir(m);
    expect(m.hote.textContent).toContain("Connexion d'entreprise active");
    m.A.authModifier("sso");
    await vider();
    expect(el<HTMLInputElement>("#ent-label")?.disabled).toBe(true);
    expect(el("#ent-activer")).toBeNull();
    expect(el("#ent-desactiver")).not.toBeNull();
    expect(el<HTMLButtonElement>("#ent-supprimer")?.disabled).toBe(true);
  });

  it("désactiver demande une confirmation qui dit que les sessions seront fermées", async () => {
    const m = monter(etat({ providers: [{ ...OIDC, enabled: true, active: true, tested: true }] }));
    m.reponses["POST /api/admin/auth/providers/sso/disable"] = [json(etat({ providers: [OIDC] }))];
    await ouvrir(m);
    m.A.authModifier("sso");
    await vider();
    m.refuser();
    await clic("#ent-desactiver");
    expect(m.confirmations).toEqual(["Désactiver ce fournisseur"]);
    expect(m.appels).not.toContain("POST /api/admin/auth/providers/sso/disable");
    expect(m.A.authFournisseur.value?.active).toBe(true);
  });

  it("désactiver confirmé envoie la demande et reprend l'état rendu", async () => {
    const m = monter(etat({ providers: [{ ...OIDC, enabled: true, active: true, tested: true }] }));
    m.reponses["POST /api/admin/auth/providers/sso/disable"] = [json(etat({ providers: [OIDC] }))];
    await ouvrir(m);
    m.A.authModifier("sso");
    await vider();
    await clic("#ent-desactiver");
    expect(m.appels).toContain("POST /api/admin/auth/providers/sso/disable");
    expect(m.A.authActifs.value).toHaveLength(0);
    expect(el("#ent-activer")).not.toBeNull();
  });

  it("supprimer demande de taper l'identifiant, puis recharge", async () => {
    const m = monter(etat({ providers: [OIDC] }));
    m.reponses["DELETE /api/admin/auth/providers/sso"] = [json({ ok: true })];
    m.reponses["GET /api/admin/auth"] = [json(etat({ providers: [OIDC] })), json(etat())];
    await ouvrir(m);
    m.A.authModifier("sso");
    await vider();
    m.refuser();
    await clic("#ent-supprimer");
    expect(m.mots).toEqual(["sso"]);
    expect(m.appels).not.toContain("DELETE /api/admin/auth/providers/sso");
  });

  it("un fournisseur illisible est listé, jamais actif, et seulement supprimable", async () => {
    const m = monter(
      etat({
        invalid_providers: [
          { id: "vieux", label: "Ancien", enabled: true },
          { id: null, label: null, enabled: false },
        ],
      }),
    );
    m.reponses["DELETE /api/admin/auth/providers/vieux"] = [json({ ok: true })];
    await ouvrir(m);
    expect(m.hote.textContent).toContain("Illisible");
    expect(m.hote.textContent).toContain("Connexion locale seule");
    const supprimer = [...m.hote.querySelectorAll("button")].filter((b) =>
      b.textContent?.includes("Supprimer"),
    );
    expect(supprimer).toHaveLength(1);
    supprimer[0]?.click();
    await vider();
    expect(m.mots).toEqual(["vieux"]);
    expect(m.appels).toContain("DELETE /api/admin/auth/providers/vieux");
  });
});
