// SPDX-License-Identifier: MIT
/** frontend/test/admin/connexion-entreprise.test.ts — console › SSO OpenID Connect : page vide, cartes numérotées, création d'un SSO, identifiant déduit, secret en écriture seule, sections stables, conditions d'activation, fournisseur actif, erreurs du serveur, champs figés, confirmations. */
import { REGEX_ID_FOURNISSEUR } from "@elpis/contracts";
import { afterEach, describe, expect, it } from "vitest";

import { reinitialiserSuiviChargement } from "../../src/features/admin/suivi-chargement";
import { json, vider } from "../aides";
import { OIDC, clic, demonter, el, etat as etatAide, monter, saisir, tous } from "./rattachement-aide";

const etat = (over: Record<string, unknown> = {}) => etatAide([], over);
const ACTIF = { ...OIDC, enabled: true, active: true, tested: true };
const texte = (sel: string): string => el(sel)?.textContent?.trim() ?? "";

afterEach(() => {
  demonter();
  reinitialiserSuiviChargement();
});

async function ouvrir(m: ReturnType<typeof monter>): Promise<void> {
  await m.A.loadEnterpriseAuth();
  await vider();
}

describe("SSO OpenID Connect : page vide", () => {
  it("dit « Connexion locale seule » et liste les prérequis", async () => {
    const m = monter(
      etat({ prerequisites: { public_url_https: false, cookie_secure: false, local_admins: 0 } }),
    );
    expect(m.hote.querySelector('[aria-busy="true"]')).not.toBeNull();
    await ouvrir(m);
    const t = m.hote.textContent ?? "";
    expect(t).toContain("Connexion locale seule");
    expect(texte("[data-etat-page]")).toBe(
      "Aucun fournisseur activé : chacun se connecte avec son mot de passe local.",
    );
    expect(t).toContain("✗ Adresse publique en https");
    expect(t).toContain("Activez l'accès HTTPS, puis redémarrez.");
    expect(t).toContain("Aucun fournisseur déclaré.");
  });

  it("cartes numérotées dans l'ordre du parcours, chacune avec son Enregistrer", async () => {
    const m = monter();
    await ouvrir(m);
    const titres = tous(".adm-card__title").map((n) => n.textContent?.trim());
    expect(titres).toEqual([
      "Connexion locale seule",
      "1. Prérequis",
      "2. Fournisseurs",
      "3. Comptes existants",
      "4. Mots de passe locaux",
    ]);
    expect(el("#ent-prerequis #ent-url")).not.toBeNull();
    expect(el("#ent-prerequis #ent-enregistrer-url")).not.toBeNull();
    expect(el("#ent-local #ent-enregistrer-mode")).not.toBeNull();
    expect(el("#ent-comptes #ent-prelien-ajouter")).not.toBeNull();
  });

  it("prérequis manquants : chaque ligne dit quoi faire, Accès HTTPS s'ouvre depuis la carte", async () => {
    const m = monter(
      etat({
        public_url: "",
        prerequisites: { public_url_https: false, cookie_secure: false, local_admins: 0 },
      }),
    );
    await ouvrir(m);
    expect(texte('[data-prerequis="public_url"]')).toContain("Renseignez l'adresse publique");
    expect(texte('[data-prerequis="https"]')).toContain("Activez l'accès HTTPS, puis redémarrez.");
    expect(texte('[data-prerequis="local_admin"]')).toContain("Gardez au moins un administrateur");
    await clic("#ent-ouvrir-https");
    expect(m.A.adminTab.value).toBe("https");
  });

  it("prérequis réunis : mêmes lignes, mêmes contrôles, le bouton Accès HTTPS reste", async () => {
    const m = monter();
    await ouvrir(m);
    expect(tous("[data-prerequis]").map((n) => n.getAttribute("data-prerequis"))).toEqual([
      "public_url",
      "https",
      "local_admin",
    ]);
    expect(texte('[data-prerequis="https"]')).toContain("✓ Accès HTTPS");
    expect(el<HTMLButtonElement>("#ent-ouvrir-https")?.disabled).toBe(false);
  });

  it("« Administrateurs seulement » demande une confirmation avant l'écriture", async () => {
    const m = monter(etat({ providers: [ACTIF] }));
    await ouvrir(m);
    m.A.authMode.value = "admins";
    m.refuser();
    await m.A.authEnregistrerReglages("mode");
    expect(m.confirmations).toHaveLength(1);
    expect(m.appels.some((a) => a.startsWith("PUT"))).toBe(false);
  });

  it("sans fournisseur actif, « Administrateurs seulement » est grisé avec sa raison écrite, rien ne part", async () => {
    const m = monter(etat({ providers: [OIDC] }));
    await ouvrir(m);
    const admins = el<HTMLButtonElement>('[data-mode="admins"]');
    expect(admins?.disabled).toBe(true);
    expect(texte("[data-mode-aide]")).toBe(
      "Indisponible tant qu'aucun fournisseur n'est actif : les autres comptes ne pourraient plus se connecter.",
    );
    m.A.authMode.value = "admins";
    await m.A.authEnregistrerReglages("mode");
    expect(m.confirmations).toEqual([]);
    expect(m.appels.some((a) => a.startsWith("PUT"))).toBe(false);
  });

  it("mode « Administrateurs seulement » déjà enregistré sans fournisseur actif : avertissement, retour à « Tous les comptes » possible", async () => {
    const m = monter(etat({ local: { mode: "admins" } }));
    m.reponses["PUT /api/admin/auth/settings"] = [json(etat())];
    await ouvrir(m);
    expect(texte("[data-mode-aide]")).toContain("⚠ Aucun fournisseur actif");
    expect(el<HTMLButtonElement>('[data-mode="all"]')?.disabled).toBe(false);
    await clic('[data-mode="all"]');
    await clic("#ent-enregistrer-mode");
    expect(m.corps["PUT /api/admin/auth/settings"]).toEqual([{ local: { mode: "all" } }]);
  });

  it("enregistre l'adresse publique et recharge l'état de la réponse", async () => {
    const m = monter();
    m.reponses["PUT /api/admin/auth/settings"] = [json(etat({ public_url: "https://autre.example.lan" }))];
    await ouvrir(m);
    await saisir("#ent-url", "https://autre.example.lan");
    await clic("#ent-enregistrer-url");
    expect(m.corps["PUT /api/admin/auth/settings"]).toEqual([{ public_url: "https://autre.example.lan" }]);
    expect(m.A.authEtat.value?.public_url).toBe("https://autre.example.lan");
    expect(m.A.authUrlModifiee.value).toBe(false);
    expect(el<HTMLButtonElement>("#ent-enregistrer-url")?.disabled).toBe(true);
  });

  it("chaque carte n'envoie que son champ : le mode modifié reste à l'écran après l'enregistrement de l'adresse", async () => {
    const m = monter(etat({ local: { mode: "admins" } }));
    m.reponses["PUT /api/admin/auth/settings"] = [
      json(etat({ local: { mode: "admins" }, public_url: "https://b.lan" })),
    ];
    await ouvrir(m);
    await saisir("#ent-url", "https://b.lan");
    await clic('[data-mode="all"]');
    await clic("#ent-enregistrer-url");
    expect(m.corps["PUT /api/admin/auth/settings"]).toEqual([{ public_url: "https://b.lan" }]);
    expect(m.A.authUrlModifiee.value).toBe(false);
    expect(m.A.authMode.value).toBe("all");
    expect(m.A.authModeModifie.value).toBe(true);
    expect(el<HTMLButtonElement>("#ent-enregistrer-mode")?.disabled).toBe(false);
  });

  it("adresse publique figée par un fournisseur activé : la raison est écrite sous le champ", async () => {
    const m = monter(etat({ providers: [ACTIF] }));
    await ouvrir(m);
    expect(el<HTMLInputElement>("#ent-url")?.disabled).toBe(true);
    expect(texte("[data-url-aide]")).toBe(
      "Désactivez d'abord les fournisseurs pour changer l'adresse publique.",
    );
  });
});

describe("SSO OpenID Connect : liste des fournisseurs", () => {
  it("statuts Actif, Éteint et Inopérant ; un inopérant porte sa raison dans sa ligne", async () => {
    const m = monter(
      etat({
        providers: [
          { ...ACTIF, id: "a", label: "Actif" },
          { ...OIDC, id: "b", label: "Éteint" },
          { ...OIDC, id: "c", label: "Cassé", enabled: true, active: false, tested: false },
        ],
      }),
    );
    await ouvrir(m);
    const pastille = (id: string) => texte(`[data-fournisseur="${id}"] .adm-pill`);
    expect([pastille("a"), pastille("b"), pastille("c")]).toEqual(["Actif", "Éteint", "Inopérant"]);
    expect(texte('[data-fournisseur="c"] [data-raison-inoperant]')).toBe(
      "· Connexion d'essai à refaire : désactivez-le pour refaire « Se connecter pour essayer ».",
    );
    expect(el('[data-fournisseur="a"] [data-raison-inoperant]')).toBeNull();
    expect(el('[data-fournisseur="b"] [data-raison-inoperant]')).toBeNull();
    expect(m.hote.textContent).not.toContain("À tester");
  });
});

describe("SSO OpenID Connect : création", () => {
  it("SSO OpenID Connect : corps, adresses à déclarer et Copier", async () => {
    const m = monter();
    m.reponses["POST /api/admin/auth/providers"] = [json(etat({ providers: [OIDC] }))];
    await ouvrir(m);
    await clic("#ent-ajouter");
    expect(el("#ent-retour")).toBeNull();
    expect(tous("[data-adresse-manque]").map((n) => n.textContent?.trim())).toEqual([
      "Identifiant dans Elpis manquant : renseignez-le en section 1.",
      "Identifiant dans Elpis manquant : renseignez-le en section 1.",
    ]);
    expect(el<HTMLButtonElement>("[data-copier-retour]")?.disabled).toBe(true);
    await saisir("#ent-id", "sso");
    await saisir("#ent-label", "SSO siège");
    await saisir("#ent-issuer", "https://sso.example.lan/realms/x");
    await saisir("#ent-client", "elpis");
    expect(el("#ent-retour")?.textContent).toBe("https://elpis.example.lan/api/auth/oidc/sso/callback");
    expect(el("#ent-deconnexion")?.textContent).toBe(
      "https://elpis.example.lan/api/auth/oidc/sso/backchannel-logout",
    );
    expect(el("[data-adresse-manque]")).toBeNull();
    expect(el<HTMLButtonElement>("[data-copier-retour]")?.disabled).toBe(false);
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

  it("sans adresse publique, aucune adresse à déclarer : la ligne dit ce qui manque", async () => {
    const m = monter(etat({ public_url: "" }));
    await ouvrir(m);
    await clic("#ent-ajouter");
    await saisir("#ent-id", "sso");
    expect(el("#ent-retour")).toBeNull();
    expect(texte("[data-adresse-manque]")).toBe(
      "Adresse publique manquante : renseignez-la dans la carte « 1. Prérequis ».",
    );
    expect(el<HTMLButtonElement>("[data-copier-deconnexion]")?.disabled).toBe(true);
  });

  it("l'identifiant est déduit du libellé tant qu'il n'est pas saisi, puis ne bouge plus", async () => {
    const m = monter();
    await ouvrir(m);
    await clic("#ent-ajouter");
    await saisir("#ent-label", "SSO Siège Été 2026 !");
    expect(el<HTMLInputElement>("#ent-id")?.value).toBe("sso-siege-ete-2026");
    await saisir("#ent-label", "  --Annuaire  central--  ");
    expect(el<HTMLInputElement>("#ent-id")?.value).toBe("annuaire-central");
    await saisir("#ent-label", "x".repeat(40));
    expect(el<HTMLInputElement>("#ent-id")?.value).toBe("x".repeat(31));
    await saisir("#ent-id", "perso");
    await saisir("#ent-label", "Autre libellé");
    expect(el<HTMLInputElement>("#ent-id")?.value).toBe("perso");
    expect(el("#ent-retour")?.textContent).toBe("https://elpis.example.lan/api/auth/oidc/perso/callback");
  });

  it("un fournisseur enregistré garde son identifiant quand le libellé change", async () => {
    const m = monter(etat({ providers: [OIDC] }));
    await ouvrir(m);
    m.A.authModifier("sso");
    await vider();
    await saisir("#ent-label", "Tout autre nom");
    expect(el<HTMLInputElement>("#ent-id")?.value).toBe("sso");
    expect(el<HTMLInputElement>("#ent-id")?.disabled).toBe(true);
  });

  it("un identifiant invalide n'écrit aucune adresse et le dit", async () => {
    const m = monter();
    await ouvrir(m);
    await clic("#ent-ajouter");
    await saisir("#ent-id", "SSO Siège");
    expect(el("#ent-retour")).toBeNull();
    expect(texte("[data-adresse-manque]")).toContain("Identifiant dans Elpis invalide");
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

describe("SSO OpenID Connect : fournisseur existant", () => {
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
    expect(b?.title).toBe("Réussissez d'abord « Se connecter pour essayer ».");
    expect(texte("[data-raison-activer]")).toBe("Réussissez d'abord « Se connecter pour essayer ».");
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

  it("des comptes rattachés figent l'émetteur et l'identifiant client avec leur raison écrite", async () => {
    const m = monter(etat({ providers: [{ ...OIDC, identities: 3 }] }));
    await ouvrir(m);
    m.A.authModifier("sso");
    await vider();
    const issuer = el<HTMLInputElement>("#ent-issuer");
    expect(issuer?.disabled).toBe(true);
    expect(issuer?.title).toContain("des comptes sont rattachés");
    expect(texte("[data-aide-issuer]")).toContain("des comptes sont rattachés");
    expect(el<HTMLInputElement>("#ent-client")?.disabled).toBe(true);
    expect(texte("[data-aide-client]")).toContain("des comptes sont rattachés");
    expect(texte("[data-aide-sujet]")).toContain("des comptes sont rattachés");
    expect(texte("[data-etat-tiroir]")).toContain("figés par les comptes rattachés");
    expect(el<HTMLInputElement>("#ent-label")?.disabled).toBe(false);
    expect(el<HTMLInputElement>("#ent-id")?.disabled).toBe(true);
    expect(m.A.authFige("subject_claim")).toContain("des comptes sont rattachés");
    expect(m.A.authFige("label")).toBe("");
  });

  it("un fournisseur actif : libellé et fraîcheur modifiables, le reste grisé avec sa raison écrite, Désactiver proposé", async () => {
    const m = monter(etat({ providers: [ACTIF] }));
    await ouvrir(m);
    expect(m.hote.textContent).toContain("SSO OpenID Connect actif");
    m.A.authModifier("sso");
    await vider();
    expect(el<HTMLInputElement>("#ent-label")?.disabled).toBe(false);
    expect(el<HTMLInputElement>("#ent-fraicheur")?.disabled).toBe(false);
    for (const sel of [
      "#ent-issuer",
      "#ent-client",
      "#ent-secret",
      "#ent-ca",
      "#ent-acr",
      "#ent-amr",
      "#ent-groupe",
    ])
      expect(el<HTMLInputElement>(sel)?.disabled, sel).toBe(true);
    expect(el<HTMLButtonElement>("#ent-secret-supprimer")?.disabled).toBe(true);
    expect(el<HTMLInputElement>("#ent-roles-actif")?.disabled).toBe(true);
    expect(texte("[data-etat-tiroir]")).toBe(
      "Fournisseur activé : seuls le libellé et la fraîcheur se modifient. Pour le reste, désactivez-le (section 8) ; les sessions des comptes rattachés seront fermées.",
    );
    expect(m.A.authFige("issuer")).toBe("Désactivez d'abord ce fournisseur pour modifier ce réglage.");
    expect(m.A.authFige("label")).toBe("");
    expect(m.A.authFige("freshness_days")).toBe("");
    expect(el("#ent-activer")).toBeNull();
    expect(el("#ent-desactiver")).not.toBeNull();
    expect(el<HTMLButtonElement>("#ent-supprimer")?.disabled).toBe(true);
    expect(texte("[data-raison-supprimer]")).toBe("Désactivez d'abord ce fournisseur.");
  });

  it("un fournisseur actif : l'enregistrement n'envoie que le libellé et la fraîcheur modifiés", async () => {
    const m = monter(etat({ providers: [ACTIF] }));
    m.reponses["PUT /api/admin/auth/providers/sso"] = [json(etat({ providers: [ACTIF] }))];
    await ouvrir(m);
    m.A.authModifier("sso");
    await vider();
    await saisir("#ent-label", " Nouveau nom ");
    await saisir("#ent-fraicheur", "30");
    await clic("#ent-enregistrer-fournisseur");
    expect(m.corps["PUT /api/admin/auth/providers/sso"]).toEqual([
      { label: "Nouveau nom", freshness_days: 30 },
    ]);
    expect(m.mots).toEqual([]);
    expect(m.A.authTiroir.value).toBeNull();
  });

  it("un nombre saisi dans un champ numérique part en entier", async () => {
    const m = monter(etat({ providers: [OIDC] }));
    m.reponses["PUT /api/admin/auth/providers/sso"] = [json(etat({ providers: [OIDC] }))];
    await ouvrir(m);
    m.A.authModifier("sso");
    await vider();
    await saisir("#ent-fraicheur", "21");
    await clic("#ent-enregistrer-fournisseur");
    expect(m.corps["PUT /api/admin/auth/providers/sso"]?.[0]).toMatchObject({ freshness_days: 21 });
  });

  it("un fournisseur actif inchangé : Enregistrer ne renvoie rien", async () => {
    const m = monter(etat({ providers: [ACTIF] }));
    await ouvrir(m);
    m.A.authModifier("sso");
    await vider();
    await clic("#ent-enregistrer-fournisseur");
    expect(m.appels.some((a) => a.startsWith("PUT"))).toBe(false);
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
    expect(el("#ent-desactiver")).toBeNull();
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

describe("SSO OpenID Connect : panneau stable", () => {
  const SECTIONS = [
    "fournisseur",
    "declarer",
    "client",
    "acces",
    "droits",
    "avance",
    "verification",
    "activation",
    "zone",
  ];
  /** Sections et contrôles du tiroir, Activer et Désactiver comptés comme un seul emplacement ; les pastilles de groupes saisis sont du contenu. */
  const plan = () => ({
    sections: tous(".adm-drawer [data-section-tiroir]").map((n) => n.getAttribute("data-section-tiroir")),
    controles: tous(".adm-drawer input, .adm-drawer select, .adm-drawer textarea, .adm-drawer button")
      .filter((n) => !n.getAttribute("aria-label")?.startsWith("Retirer"))
      .map((n) => {
        const id = n.id === "ent-activer" || n.id === "ent-desactiver" ? "bascule" : n.id;
        return `${n.tagName}#${id}[${n.getAttribute("type") ?? ""}]`;
      }),
  });

  it("nouveau, enregistré et actif : mêmes sections, même ordre, mêmes contrôles", async () => {
    const neuf = monter();
    await ouvrir(neuf);
    await clic("#ent-ajouter");
    const a = plan();
    demonter();
    const enregistre = monter(etat({ providers: [OIDC] }));
    await ouvrir(enregistre);
    enregistre.A.authModifier("sso");
    await vider();
    const b = plan();
    demonter();
    const actif = monter(etat({ providers: [ACTIF] }));
    await ouvrir(actif);
    actif.A.authModifier("sso");
    await vider();
    const c = plan();
    expect(a.sections).toEqual(SECTIONS);
    expect(b).toEqual(a);
    expect(c).toEqual(a);
    expect(a.controles.length).toBeGreaterThan(30);
    expect(tous("[data-bascule] button")).toHaveLength(1);
  });

  it("nouveau fournisseur : vérification et activation visibles, grisées avec leur raison écrite", async () => {
    const m = monter();
    await ouvrir(m);
    await clic("#ent-ajouter");
    expect(el<HTMLButtonElement>("#ent-tester")?.disabled).toBe(false);
    expect(el<HTMLButtonElement>("#ent-trial")?.disabled).toBe(true);
    expect(texte("[data-raison-essai]")).toBe(
      "Enregistrez d'abord ce fournisseur : l'essai part des réglages enregistrés.",
    );
    expect(tous("[data-condition]")).toHaveLength(7);
    expect(el<HTMLButtonElement>("#ent-activer")?.disabled).toBe(true);
    expect(texte("[data-raison-activer]")).toBe("Enregistrez d'abord ce fournisseur.");
    expect(el<HTMLButtonElement>("#ent-supprimer")?.disabled).toBe(true);
    expect(texte("[data-raison-supprimer]")).toBe("Ce fournisseur n'est pas encore enregistré.");
    expect(texte("[data-etat-pastille]")).toBe("Nouveau");
    expect(texte("[data-aide-second-facteur]")).toBe("⚠ Aucun second facteur garanti par Elpis.");
  });

  const PRET = { ...OIDC, tested: true };
  const PREREQUIS = { public_url_https: true, cookie_secure: true, local_admins: 1 };
  const CAS = [
    {
      id: "public_url",
      etat: etat({
        public_url: "",
        providers: [PRET],
        prerequisites: { ...PREREQUIS, public_url_https: false },
      }),
      raison: "Renseignez d'abord l'adresse publique en https.",
    },
    {
      id: "https",
      etat: etat({ providers: [PRET], prerequisites: { ...PREREQUIS, cookie_secure: false } }),
      raison: "Activez d'abord l'accès HTTPS.",
    },
    {
      id: "local_admin",
      etat: etat({ providers: [PRET], prerequisites: { ...PREREQUIS, local_admins: 0 } }),
      raison: "Un administrateur avec mot de passe local est requis.",
    },
    {
      id: "required_group",
      etat: etat({ providers: [{ ...PRET, required_groups: [] }] }),
      raison: "Indiquez d'abord au moins un groupe requis.",
    },
    {
      id: "secret",
      etat: etat({ providers: [{ ...PRET, has_secret: false }] }),
      raison: "Enregistrez d'abord le secret.",
    },
    {
      id: "trial",
      etat: etat({ providers: [{ ...PRET, tested: false }] }),
      raison: "Réussissez d'abord « Se connecter pour essayer ».",
    },
  ] as const;

  for (const cas of CAS)
    it(`la liste d'activation suit la condition « ${cas.id} »`, async () => {
      const m = monter(cas.etat);
      await ouvrir(m);
      m.A.authModifier("sso");
      await vider();
      const etats = tous("[data-condition]").map((n) => [
        n.getAttribute("data-condition"),
        n.getAttribute("data-ok"),
      ]);
      expect(etats).toEqual([...CAS.map((c) => [c.id, c.id === cas.id ? "non" : "oui"]), ["saved", "oui"]]);
      expect(el(`[data-condition="${cas.id}"]`)?.textContent).toContain("✗");
      expect(el<HTMLButtonElement>("#ent-activer")?.disabled).toBe(true);
      expect(texte("[data-raison-activer]")).toBe(cas.raison);
      await clic("#ent-activer");
      expect(m.appels.some((a) => a.includes("/enable"))).toBe(false);
    });

  it("les six conditions remplies : toutes cochées, Activer disponible et envoyé", async () => {
    const m = monter(etat({ providers: [PRET] }));
    m.reponses["POST /api/admin/auth/providers/sso/enable"] = [json(etat({ providers: [ACTIF] }))];
    await ouvrir(m);
    m.A.authModifier("sso");
    await vider();
    expect(tous("[data-condition]").every((n) => n.getAttribute("data-ok") === "oui")).toBe(true);
    expect(texte("[data-raison-activer]")).toBe("Toutes les conditions sont remplies.");
    expect(el<HTMLButtonElement>("#ent-activer")?.disabled).toBe(false);
    await clic("#ent-activer");
    expect(m.appels).toContain("POST /api/admin/auth/providers/sso/enable");
    expect(el("#ent-desactiver")).not.toBeNull();
    expect(tous("[data-section-tiroir]").map((n) => n.getAttribute("data-section-tiroir"))).toEqual(SECTIONS);
  });
});

describe("SSO OpenID Connect : carte d'état fidèle à l'état réel", () => {
  const CAS = [
    [
      "aucun fournisseur activé",
      etat({ providers: [OIDC] }),
      "Connexion locale seule",
      "Aucun fournisseur activé : chacun se connecte avec son mot de passe local.",
    ],
    [
      "activé mais inopérant",
      etat({ providers: [{ ...OIDC, enabled: true, tested: false }] }),
      "Connexion locale seule",
      "⚠ Aucun fournisseur activé n'est opérant (carte 2) : seule la connexion locale fonctionne.",
    ],
    [
      "illisible et activé",
      etat({ invalid_providers: [{ id: "vieux", label: "Ancien", enabled: true }] }),
      "Connexion locale seule",
      "⚠ Aucun fournisseur activé n'est opérant (carte 2) : seule la connexion locale fonctionne.",
    ],
    [
      "« Administrateurs seulement » sans fournisseur actif",
      etat({ local: { mode: "admins" }, providers: [{ ...OIDC, enabled: true, tested: false }] }),
      "Connexion locale seule",
      "⚠ Aucun fournisseur actif et mots de passe locaux réservés aux administrateurs : seuls les administrateurs peuvent se connecter.",
    ],
    [
      "fournisseur actif",
      etat({ local: { mode: "admins" }, providers: [ACTIF] }),
      "SSO OpenID Connect actif",
      "Fournisseurs actifs : SSO siège.",
    ],
  ] as const;
  for (const [nom, e, titre, phrase] of CAS)
    it(`${nom} : « ${titre} » et sa phrase`, async () => {
      const m = monter(e);
      await ouvrir(m);
      expect(texte("#ent-etat .adm-card__title")).toBe(titre);
      expect(texte("[data-etat-page]")).toBe(phrase);
    });
});

describe("SSO OpenID Connect : raison d'un fournisseur inopérant", () => {
  const INOPERANT = { ...OIDC, enabled: true, tested: true };
  const PREREQUIS = { public_url_https: true, cookie_secure: true, local_admins: 1 };
  const CAS = [
    [
      etat({
        public_url: "",
        providers: [INOPERANT],
        prerequisites: { ...PREREQUIS, public_url_https: false },
      }),
      "Adresse publique manquante : désactivez les fournisseurs pour la renseigner.",
    ],
    [
      etat({ providers: [INOPERANT], prerequisites: { ...PREREQUIS, cookie_secure: false } }),
      "Accès HTTPS hors service : rétablissez-le depuis la carte « 1. Prérequis ».",
    ],
    [
      etat({ providers: [INOPERANT], prerequisites: { ...PREREQUIS, local_admins: 0 } }),
      "Aucun administrateur à mot de passe local : rétablissez-en un dans la page Comptes.",
    ],
    [
      etat({ providers: [{ ...INOPERANT, required_groups: [] }] }),
      "Aucun groupe requis : désactivez-le pour en indiquer un.",
    ],
    [
      etat({ providers: [{ ...INOPERANT, has_secret: false }] }),
      "Secret client manquant : désactivez-le pour l'enregistrer.",
    ],
    [
      etat({ providers: [{ ...INOPERANT, tested: false }] }),
      "Connexion d'essai à refaire : désactivez-le pour refaire « Se connecter pour essayer ».",
    ],
    [
      etat({ providers: [INOPERANT] }),
      "Condition d'activation manquante : désactivez-le, puis vérifiez sa section « 8. Activation ».",
    ],
  ] as const;
  for (const [e, raison] of CAS)
    it(`dit la cause et le remède : « ${raison} »`, async () => {
      const m = monter(e);
      await ouvrir(m);
      expect(texte('[data-fournisseur="sso"] [data-raison-inoperant]')).toBe(`· ${raison}`);
      expect(texte('[data-fournisseur="sso"] [data-raison-inoperant]')).not.toContain("d'abord");
    });
});

describe("SSO OpenID Connect : le secret ne part jamais pour un fournisseur activé", () => {
  const PRET = { ...OIDC, tested: true };

  it("activé depuis une autre session pendant la saisie : le champ se vide, Enregistrer n'envoie que le libellé", async () => {
    const m = monter(etat({ providers: [PRET] }));
    m.reponses["PUT /api/admin/auth/providers/sso"] = [json(etat({ providers: [ACTIF] }))];
    await ouvrir(m);
    m.A.authModifier("sso");
    await vider();
    await saisir("#ent-secret", "nouveau-secret");
    m.reponses["GET /api/admin/auth"] = [json(etat({ providers: [ACTIF] }))];
    await m.A.loadEnterpriseAuth();
    await vider();
    expect(el<HTMLInputElement>("#ent-secret")?.value).toBe("");
    expect(el<HTMLInputElement>("#ent-secret")?.disabled).toBe(true);
    m.A.authTiroir.value!.secret = "glissé autrement";
    await saisir("#ent-label", "Nouveau nom");
    await clic("#ent-enregistrer-fournisseur");
    expect(m.corps["PUT /api/admin/auth/providers/sso"]).toEqual([{ label: "Nouveau nom" }]);
    expect(m.appels.some((a) => a.endsWith("/secret"))).toBe(false);
  });

  it("la réponse de l'enregistrement dit le fournisseur activé : le secret saisi ne part pas, la raison est écrite", async () => {
    const m = monter(etat({ providers: [PRET] }));
    m.reponses["PUT /api/admin/auth/providers/sso"] = [json(etat({ providers: [ACTIF] }))];
    await ouvrir(m);
    m.A.authModifier("sso");
    await vider();
    await saisir("#ent-secret", "nouveau-secret");
    await clic("#ent-enregistrer-fournisseur");
    expect(m.appels).toContain("PUT /api/admin/auth/providers/sso");
    expect(m.appels.some((a) => a.endsWith("/secret"))).toBe(false);
    expect(texte("[data-tiroir-erreur]")).toBe(
      "Ce fournisseur vient d'être activé : le secret n'a pas été envoyé. Désactivez-le pour le changer.",
    );
    expect(el<HTMLInputElement>("#ent-secret")?.value).toBe("");
  });

  it("Supprimer le secret ne part pas pour un fournisseur activé", async () => {
    const m = monter(etat({ providers: [ACTIF] }));
    await ouvrir(m);
    m.A.authModifier("sso");
    await vider();
    await m.A.authSupprimerSecret();
    expect(m.confirmations).toEqual([]);
    expect(m.appels.some((a) => a.endsWith("/secret"))).toBe(false);
  });
});

describe("SSO OpenID Connect : Activer et Désactiver partent des réglages enregistrés", () => {
  const PRET = { ...OIDC, tested: true };

  it("modification non enregistrée : Activer est grisé, la ligne « Modifications enregistrées » et la raison le disent, rien ne part", async () => {
    const m = monter(etat({ providers: [PRET] }));
    await ouvrir(m);
    m.A.authModifier("sso");
    await vider();
    expect(el(`[data-condition="saved"]`)?.getAttribute("data-ok")).toBe("oui");
    m.A.authRetirerGroupe("required_groups", 0);
    await saisir("#ent-groupe", "autres");
    m.A.authAjouterGroupe();
    await vider();
    expect(el(`[data-condition="saved"]`)?.getAttribute("data-ok")).toBe("non");
    expect(texte(`[data-condition="saved"]`)).toContain("Modifications enregistrées");
    expect(el<HTMLButtonElement>("#ent-activer")?.disabled).toBe(true);
    expect(texte("[data-raison-activer]")).toBe("Enregistrez d'abord vos modifications.");
    expect(await m.A.authBasculer(true)).toBe(false);
    await clic("#ent-activer");
    expect(m.appels.some((a) => a.includes("/enable"))).toBe(false);
    m.A.authRetirerGroupe("required_groups", 0);
    await saisir("#ent-groupe", "elpis");
    m.A.authAjouterGroupe();
    await vider();
    expect(el<HTMLButtonElement>("#ent-activer")?.disabled).toBe(false);
    await saisir("#ent-secret", "nouveau-secret");
    expect(el<HTMLButtonElement>("#ent-activer")?.disabled).toBe(true);
    expect(texte("[data-raison-activer]")).toBe("Enregistrez d'abord vos modifications.");
  });

  it("après Activer puis Désactiver, le tiroir est relu depuis l'état rendu et le focus revient sur le bouton", async () => {
    const m = monter(etat({ providers: [PRET] }));
    /** Le navigateur retire le focus d'un bouton grisé pendant la demande. */
    const grise = (corps: unknown) => () => {
      (document.activeElement as HTMLElement | null)?.blur();
      return json(corps);
    };
    m.reponses["POST /api/admin/auth/providers/sso/enable"] = [
      grise(
        etat({ providers: [{ ...ACTIF, label: "Nom du serveur", required_groups: ["elpis", "autres"] }] }),
      ),
    ];
    m.reponses["POST /api/admin/auth/providers/sso/disable"] = [grise(etat({ providers: [PRET] }))];
    await ouvrir(m);
    m.A.authModifier("sso");
    await vider();
    const bouton = el<HTMLButtonElement>("#ent-activer");
    bouton?.focus();
    await clic("#ent-activer");
    expect(el<HTMLInputElement>("#ent-label")?.value).toBe("Nom du serveur");
    expect(m.A.authTiroir.value?.required_groups).toEqual(["elpis", "autres"]);
    expect(document.activeElement).toBe(bouton);
    expect(document.activeElement?.id).toBe("ent-desactiver");
    expect(document.activeElement?.textContent?.trim()).toBe("Désactiver");
    await saisir("#ent-label", "Brouillon");
    await clic("#ent-desactiver");
    expect(m.appels).toContain("POST /api/admin/auth/providers/sso/disable");
    expect(el<HTMLInputElement>("#ent-label")?.value).toBe("SSO siège");
    expect(document.activeElement).toBe(bouton);
    expect(document.activeElement?.id).toBe("ent-activer");
  });
});

describe("SSO OpenID Connect : Ajouter enchaîne sur la vérification", () => {
  it("après l'ajout, le tiroir reste ouvert sur le fournisseur créé, secret rangé, « Se connecter pour essayer » disponible et focalisé", async () => {
    const m = monter();
    m.reponses["POST /api/admin/auth/providers"] = [
      json(etat({ providers: [{ ...OIDC, has_secret: false }] })),
    ];
    m.reponses["PUT /api/admin/auth/providers/sso/secret"] = [json(etat({ providers: [OIDC] }))];
    await ouvrir(m);
    await clic("#ent-ajouter");
    await saisir("#ent-label", "SSO siège");
    await saisir("#ent-id", "sso");
    await saisir("#ent-issuer", "https://sso.example.lan/realms/x");
    await saisir("#ent-client", "elpis");
    await saisir("#ent-secret", "s3cret");
    await clic("#ent-enregistrer-fournisseur");
    expect(m.appels).toEqual(
      expect.arrayContaining(["POST /api/admin/auth/providers", "PUT /api/admin/auth/providers/sso/secret"]),
    );
    expect(m.toasts).toContain("Fournisseur enregistré");
    expect(m.A.authTiroir.value?.nouveau).toBe(false);
    expect(el<HTMLInputElement>("#ent-secret")?.value).toBe("");
    expect(texte("#ent-enregistrer-fournisseur")).toBe("Enregistrer");
    expect(texte("[data-etat-pastille]")).toBe("Éteint");
    expect(el<HTMLInputElement>("#ent-id")?.disabled).toBe(true);
    expect(el<HTMLButtonElement>("#ent-trial")?.disabled).toBe(false);
    expect(document.activeElement?.id).toBe("ent-trial");
    expect(texte("[data-raison-activer]")).toBe("Réussissez d'abord « Se connecter pour essayer ».");
  });
});

describe("SSO OpenID Connect : accessibilité et termes", () => {
  it("les deux boutons Copier ont chacun leur nom et sont reliés à leur ligne", async () => {
    const m = monter();
    await ouvrir(m);
    await clic("#ent-ajouter");
    const retour = el<HTMLButtonElement>("[data-copier-retour]");
    const deconnexion = el<HTMLButtonElement>("[data-copier-deconnexion]");
    expect(retour?.getAttribute("aria-label")).toBe("Copier l'adresse de retour");
    expect(deconnexion?.getAttribute("aria-label")).toBe("Copier l'adresse de déconnexion par canal arrière");
    for (const b of [retour, deconnexion])
      expect(el(`#${b?.getAttribute("aria-describedby") ?? "absent"}`)?.textContent).toContain(
        "Identifiant dans Elpis manquant",
      );
    await saisir("#ent-id", "sso");
    expect(el(`#${retour?.getAttribute("aria-describedby") ?? "absent"}`)?.textContent).toBe(
      "https://elpis.example.lan/api/auth/oidc/sso/callback",
    );
    expect(el(`#${deconnexion?.getAttribute("aria-describedby") ?? "absent"}`)?.textContent).toBe(
      "https://elpis.example.lan/api/auth/oidc/sso/backchannel-logout",
    );
  });

  it("chaque ✓ / ✗ des prérequis a son texte pour lecteur d'écran", async () => {
    const m = monter(
      etat({ prerequisites: { public_url_https: false, cookie_secure: true, local_admins: 0 } }),
    );
    await ouvrir(m);
    expect(tous("[data-prerequis] .sr-only").map((n) => n.textContent?.trim())).toEqual([
      ": manquant",
      ": rempli",
      ": manquant",
    ]);
    for (const n of tous("[data-prerequis] .adm-row__label > [aria-hidden]"))
      expect(["✓", "✗"]).toContain(n.textContent?.trim());
  });

  it("les trois identifiants sont distingués", async () => {
    const m = monter(etat({ providers: [OIDC] }));
    await ouvrir(m);
    expect(texte('label[for="ent-prelien-attendu"]')).toBe("Identifiant attendu chez le fournisseur");
    await clic("#ent-ajouter");
    expect(texte('label[for="ent-id"]')).toBe("Identifiant dans Elpis");
    expect(texte('label[for="ent-client"]')).toBe("Identifiant client (client_id)");
    await clic("#ent-enregistrer-fournisseur");
    expect(texte("[data-tiroir-erreur]")).toBe("Champ « Identifiant dans Elpis » : à renseigner.");
  });

  it("l'identifiant suit la règle commune au serveur : adresses écrites seulement pour un identifiant admis", async () => {
    const m = monter();
    await ouvrir(m);
    await clic("#ent-ajouter");
    for (const id of [
      "sso",
      "a",
      "9-a",
      "sso-",
      "x".repeat(31),
      "x".repeat(32),
      "-sso",
      "SSO",
      "sso_1",
      "é",
    ]) {
      await saisir("#ent-id", id);
      expect(el("#ent-retour") !== null, id).toBe(REGEX_ID_FOURNISSEUR.test(id));
    }
  });
});

describe("SSO OpenID Connect : Enregistrer de la carte 4 suit le choix", () => {
  it("« Administrateurs seulement » devenu indisponible (plus de fournisseur actif) : Enregistrer est grisé, la raison est écrite", async () => {
    const m = monter(etat({ providers: [ACTIF] }));
    await ouvrir(m);
    await clic('[data-mode="admins"]');
    expect(el<HTMLButtonElement>("#ent-enregistrer-mode")?.disabled).toBe(false);
    m.reponses["GET /api/admin/auth"] = [json(etat({ providers: [OIDC] }))];
    await m.A.loadEnterpriseAuth();
    await vider();
    expect(m.A.authMode.value).toBe("admins");
    expect(el<HTMLButtonElement>("#ent-enregistrer-mode")?.disabled).toBe(true);
    expect(texte("[data-mode-aide]")).toBe(
      "Indisponible tant qu'aucun fournisseur n'est actif : les autres comptes ne pourraient plus se connecter.",
    );
    await clic('[data-mode="all"]');
    expect(el<HTMLButtonElement>("#ent-enregistrer-mode")?.disabled).toBe(true);
  });
});
