// SPDX-License-Identifier: MIT
/** frontend/test/editor/clonage.test.ts — fenêtre « Cloner un dépôt » : compte qui servira selon l'adresse, dossier créé, portées des identifiants saisis, compte proposé ; clonage avec identifiants (portée envoyée, refus d'accès, purge) ; fenêtre montée (état d'accès, saisie sur place, dépôts du compte proposé). */
import { createApp, defineComponent, h, nextTick, proxyRefs, ref } from "vue";
import type { App } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";

import ModaleClonage from "../../src/components/editor/ModaleClonage.vue";
import {
  accesClone,
  comptePropose,
  comptesUtilisables,
  dossierDuClone,
  nomCompte,
  porteesIdentifiants,
  refusDAcces,
} from "../../src/features/editor/clonage";
import type { CompteClone } from "../../src/features/editor/clonage";
import { fournirDomaineEditeur } from "../../src/features/editor/domaine";
import { setupEditorGit } from "../../src/features/editor/git";

const compte = (
  id: number,
  host: string,
  path: string | null,
  plus: Partial<CompteClone> = {},
): CompteClone => ({
  id,
  host,
  path,
  has_token: true,
  ...plus,
});
const PERSO = compte(1, "github.com", "", { label: "perso", last_used: 50 });
const ROBOT = compte(2, "github.com", "acme", { label: "robot", last_used: 90 });
const SANS_PORTEE = compte(3, "github.com", null, { last_used: 999 });
const SANS_JETON = compte(4, "forge.lan", "", { has_token: false, last_used: 999 });
const TOUS = [PERSO, ROBOT, SANS_PORTEE, SANS_JETON];

/** Ce que dit git dans le bac quand un dépôt demande des identifiants qu'il n'a pas (il ne peut pas les demander). */
const REFUS_GIT = "fatal: could not read Username for 'https://forge.lan': terminal prompts disabled";

function json(corps: unknown, status = 200): Response {
  return new Response(JSON.stringify(corps), { status, headers: { "Content-Type": "application/json" } });
}

describe("ce que dit l'adresse", () => {
  it("compte que le serveur prendra : le plus précis de l'hôte, même sans jeton (il n'en essaie pas d'autre) ; jamais un compte sans portée ; autre schéma : invalide", () => {
    expect(accesClone("  ", TOUS)).toEqual({ etat: "vide" });
    expect(accesClone("git@github.com:acme/api.git", TOUS)).toEqual({ etat: "invalide" });
    expect(accesClone("HTTPS://github.com/acme/api.git", TOUS)).toEqual({ etat: "invalide" });
    expect(accesClone("https://github.com/Acme/API.git", TOUS)).toMatchObject({
      etat: "compte",
      hote: "github.com",
      chemin: "Acme/API",
      compte: ROBOT,
    });
    expect(accesClone("https://github.com/autre/depot", TOUS)).toMatchObject({
      etat: "compte",
      compte: PERSO,
    });
    expect(accesClone("https://forge.lan/a/b.git", TOUS)).toMatchObject({
      etat: "sans-jeton",
      compte: SANS_JETON,
    });
    expect(accesClone("https://ailleurs.lan/a/b.git", TOUS)).toEqual({
      etat: "aucun",
      hote: "ailleurs.lan",
      origine: "https://ailleurs.lan",
      clair: false,
      chemin: "a/b",
    });
    expect(accesClone("http://ailleurs.lan/a/b.git", TOUS)).toMatchObject({
      origine: "http://ailleurs.lan",
      clair: true,
    });
    // Dépôt à la racine de l'hôte : le serveur ne lui cherche aucun compte, même celui de tout l'hôte.
    expect(accesClone("https://github.com/projet.git", [PERSO])).toMatchObject({ etat: "aucun" });
    // Jeton importé du bac, pas encore vérifié : dit, ce n'est pas « sans jeton ».
    const importe = compte(8, "import.lan", "", { has_token: false, to_verify: true });
    expect(accesClone("https://import.lan/a/b", [importe])).toMatchObject({
      etat: "a-verifier",
      compte: importe,
    });
    // Un compte plus précis sans jeton masque celui de tout l'hôte, comme côté serveur.
    const vide = compte(7, "github.com", "acme/api", { has_token: false });
    expect(accesClone("https://github.com/acme/api", [PERSO, vide])).toMatchObject({
      etat: "sans-jeton",
      compte: vide,
    });
    // Hôte lu tel qu'écrit, port compris : un port explicite n'est pas l'hôte du compte.
    expect(accesClone("https://github.com:443/acme/api", TOUS)).toMatchObject({
      etat: "aucun",
      hote: "github.com:443",
    });
    // Adresse illisible sur un hôte découpé en portées : aucun compte.
    expect(accesClone("https://github.com/acme/api?x=1", TOUS)).toMatchObject({ etat: "aucun" });
    expect(accesClone("https://github.com/acme/api", [SANS_PORTEE])).toMatchObject({ etat: "aucun" });
    expect(accesClone("https://github.com/acme/api", null)).toMatchObject({ etat: "aucun" });
    expect(comptesUtilisables(TOUS).map((c) => c.id)).toEqual([1, 2]);
    expect(nomCompte(ROBOT)).toBe("github.com/acme · robot");
    expect(nomCompte(compte(9, "h", ""))).toBe("h");
  });

  it("dossier créé : dernier segment sans `.git` ; portées des identifiants : de l'hôte au dépôt, celle d'un compte existant signalée, proposée comme le serveur ; rien d'office pour une adresse illisible sur un hôte déjà pris", () => {
    expect(dossierDuClone("https://github.com/acme/api.git")).toBe("api");
    expect(dossierDuClone(" https://github.com/acme/api/ ")).toBe("api");
    expect(dossierDuClone("")).toBe("");
    const p = (url: string, comptes: CompteClone[]) => porteesIdentifiants(accesClone(url, comptes), comptes);
    expect(p("https://forge.lan/acme/api.git", [])).toEqual({
      choix: [
        { valeur: "", libelle: "forge.lan", remplace: null, fermee: false },
        { valeur: "acme", libelle: "forge.lan/acme", remplace: null, fermee: false },
        { valeur: "acme/api", libelle: "forge.lan/acme/api", remplace: null, fermee: false },
      ],
      defaut: "",
    });
    expect(p("https://github.com/autre/depot", [PERSO]).defaut).toBe("autre");
    const tous = p("https://github.com/Acme/api", TOUS);
    expect(tous.defaut).toBe("Acme");
    expect(tous.choix.map((c) => c.remplace)).toEqual([
      "github.com · perso",
      "github.com/acme · robot",
      null,
    ]);
    expect(p("https://github.com/seul.git", [PERSO])).toEqual({
      choix: [{ valeur: "", libelle: "github.com", remplace: "github.com · perso", fermee: false }],
      defaut: null,
    });
    // Compte à vérifier : sa portée est fermée, et rien n'est proposé d'office si elle l'était.
    const importe = compte(8, "import.lan", "acme", { has_token: false, to_verify: true });
    const ferme = p("https://import.lan/acme/api", [importe]);
    expect(ferme.choix.map((c) => c.fermee)).toEqual([false, true, false]);
    expect(ferme.defaut).toBeNull();
    expect(p("https://github.com/seul.git", []).defaut).toBe("");
    expect(p("pas une adresse", TOUS)).toEqual({ choix: [], defaut: null });
  });

  it("compte proposé : le seul utilisable, sinon le dernier utilisé ; refus d'accès : les messages de git et des forges, jamais un 409 du relais ni un simple nom de dépôt", () => {
    expect(comptePropose(TOUS)?.id).toBe(2);
    expect(comptePropose([PERSO])?.id).toBe(1);
    expect(comptePropose([SANS_PORTEE, SANS_JETON])).toBeNull();
    expect(comptePropose(undefined)).toBeNull();
    for (const message of [
      "fatal: could not read Username for 'https://forge.lan': terminal prompts disabled",
      "fatal: Authentication failed for 'https://…'",
      "remote: HTTP Basic: Access denied",
      "The requested URL returned error: 403",
      "remote: Invalid username or password.",
    ])
      expect(refusDAcces(400, message), message).toBe(true);
    expect(refusDAcces(409, "Relais Git : authentification refusée (401)")).toBe(false);
    for (const message of [
      "fatal: repository 'https://h/acme/oauth-lib.git/' not found",
      "fatal: repository 'https://h/acme/issue-401.git/' not found",
      "fatal: unable to access: Could not resolve host",
      "remote: Enumerating objects: 403, done.\nremote: Counting objects: 100% (401/401), done.\nfatal: early EOF",
      "error: unable to write file src/unauthorized.ts: No space left on device",
    ])
      expect(refusDAcces(400, message), message).toBe(false);
  });
});

describe("clonage avec identifiants saisis", () => {
  function monter(repondre: (url: string, init?: RequestInit) => Response) {
    const vus: Array<[string, Record<string, unknown>]> = [];
    const toasts: string[] = [];
    const api = setupEditorGit(
      { openTabs: ref([]), models: {} },
      {
        showToast: (m) => toasts.push(m),
        fetchAuth: (url, init) => {
          if (init?.method === "POST")
            vus.push([url, JSON.parse(String(init.body)) as Record<string, unknown>]);
          return Promise.resolve(repondre(url, init));
        },
        openPrompt: () => Promise.resolve(""),
        openConfirm: () => Promise.resolve(true),
      },
    );
    return { api, vus, toasts };
  }
  const reussi = (url: string): Response =>
    url.endsWith("/clone")
      ? json({ ok: true, repo: "api", message: "Cloné dans api/", credentials_saved: true })
      : json({ repos: [], is_repo: false });

  it("sans saisie : l'adresse et le dossier seuls ; bloc fermé : rien d'autre, même un jeton tapé avant", async () => {
    const v = monter(reussi);
    v.api.gitOpenCloneModal();
    v.api.gitCloneForm.value = { url: "https://forge.lan/acme/api.git", dir: "" };
    Object.assign(v.api.gitCloneCreds.value, { user: "u", token: "tok" });
    expect(await v.api.gitClone("acme")).toBe(true);
    expect(v.vus[0]).toEqual(["/api/sandbox/git/clone", { url: "https://forge.lan/acme/api.git", dir: "" }]);
  });

  it("identifiants saisis : envoyés avec la portée choisie ; réussi : fenêtre fermée, saisie purgée, enregistrement signalé", async () => {
    const v = monter(reussi);
    v.api.gitOpenCloneModal();
    v.api.gitCloneForm.value = { url: "https://forge.lan/acme/api.git", dir: "copie" };
    Object.assign(v.api.gitCloneCreds.value, { ouvert: true, user: " bob ", token: " tok " });
    expect(await v.api.gitClone("acme")).toBe(true);
    expect(v.vus[0]?.[1]).toEqual({
      url: "https://forge.lan/acme/api.git",
      dir: "copie",
      cred_user: "bob",
      cred_token: "tok",
      cred_scope: "acme",
    });
    expect(v.api.showGitCloneModal.value).toBe(false);
    expect(v.api.gitCloneCreds.value).toEqual({
      ouvert: false,
      user: "",
      token: "",
      portee: null,
      refus: false,
    });
    expect(v.toasts.at(-1)).toBe("Cloné dans api/ Identifiants enregistrés.");
    expect(JSON.stringify(v.toasts)).not.toContain("tok");
    // Saisis mais non enregistrés (dépôt public, portée prise, compte à vérifier) : dit.
    const sans = monter((url) =>
      url.endsWith("/clone")
        ? json({ ok: true, repo: "api", message: "Cloné dans api/", credentials_saved: false })
        : json({ repos: [], is_repo: false }),
    );
    sans.api.gitOpenCloneModal();
    sans.api.gitCloneForm.value = { url: "https://forge.lan/acme/api.git", dir: "" };
    Object.assign(sans.api.gitCloneCreds.value, { ouvert: true, token: "tok" });
    expect(await sans.api.gitClone()).toBe(false);
    expect(sans.vus[0]?.[1]).not.toHaveProperty("cred_scope");
    expect(sans.toasts.at(-1)).toBe("Cloné dans api/ Identifiants non enregistrés.");
  });

  it("refus d'accès : la fenêtre reste, la saisie des identifiants s'ouvre ; un refus du relais ne la demande pas ; la déconnexion purge tout", async () => {
    const refus = monter(() => json({ detail: REFUS_GIT }, 400));
    refus.api.gitOpenCloneModal();
    refus.api.gitCloneForm.value = { url: "https://forge.lan/acme/api.git", dir: "" };
    expect(await refus.api.gitClone()).toBe(false);
    expect(refus.api.showGitCloneModal.value).toBe(true);
    expect(refus.api.gitError.value).toBe(REFUS_GIT);
    expect(refus.api.gitCloneCreds.value).toMatchObject({ ouvert: true, refus: true });
    refus.api.gitCloneCreds.value.token = "secret";
    refus.api.resetOnLogout();
    expect(refus.api.gitCloneCreds.value.token).toBe("");
    expect(refus.api.showGitCloneModal.value).toBe(false);
    const relais = monter(() => json({ detail: "Relais Git : dépôt refusé (401)" }, 409));
    relais.api.gitOpenCloneModal();
    relais.api.gitCloneForm.value = { url: "https://forge.lan/acme/api.git", dir: "" };
    await relais.api.gitClone();
    expect(relais.api.gitCloneCreds.value).toMatchObject({ ouvert: false, refus: false });
  });
});

describe("fenêtre montée", () => {
  let app: App | null = null;
  afterEach(() => {
    app?.unmount();
    app = null;
    document.body.innerHTML = "";
  });

  function monter(comptes: CompteClone[]) {
    const chargements: string[] = [];
    const clones: Array<string | undefined> = [];
    const etat = {
      showGitCloneModal: ref(true),
      gitCloneForm: ref({ url: "", dir: "" }),
      gitCloneCreds: ref({ ouvert: false, user: "", token: "", portee: null as string | null, refus: false }),
      gitCloneConnectorId: ref(""),
      gitCloneRepos: ref<Array<Record<string, unknown>>>([]),
      gitCloneReposLoading: ref(false),
      gitCloneReposError: ref(""),
      gitCloneRepoFilter: ref(""),
      gitFilteredCloneRepos: ref<Array<Record<string, unknown>>>([]),
      gitError: ref(""),
      gitLoading: ref(false),
      gitConnectors: ref(comptes),
    };
    const racine = proxyRefs({
      ...etat,
      gitLoadConnectorRepos: (id: string) => {
        chargements.push(id);
      },
      gitPickRepo: (r: { clone_url: string }) => {
        etat.gitCloneForm.value.url = r.clone_url;
      },
      gitClone: vi.fn(async (portee?: string) => {
        clones.push(portee);
        return true;
      }),
      loadGitConnectors: vi.fn(),
      openSettingsTab: vi.fn(),
    });
    const hote = document.createElement("div");
    document.body.appendChild(hote);
    app = createApp(
      defineComponent({
        setup() {
          fournirDomaineEditeur(racine);
          return () => h(ModaleClonage);
        },
      }),
    );
    app.config.warnHandler = () => {};
    app.mount(hote);
    const q = <T extends Element = HTMLElement>(s: string): T | null => document.querySelector<T>(s);
    const saisir = async (s: string, valeur: string): Promise<void> => {
      const champ = q<HTMLInputElement>(s)!;
      champ.value = valeur;
      champ.dispatchEvent(new Event("input"));
      await nextTick();
    };
    return { racine, etat, chargements, clones, q, saisir };
  }

  it("à l'ouverture : les dépôts du compte proposé sont demandés ; un seul compte : son nom, plusieurs : un choix", async () => {
    const seul = monter([PERSO]);
    await nextTick();
    expect(seul.chargements).toEqual(["1"]);
    expect(seul.q("[data-compte-seul]")?.textContent).toBe("github.com · perso");
    expect(seul.q("#clone-compte")).toBeNull();
    app?.unmount();
    document.body.innerHTML = "";
    const deux = monter(TOUS);
    await nextTick();
    expect(deux.chargements).toEqual(["2"]);
    expect([...document.querySelectorAll("#clone-compte option")].map((o) => o.textContent)).toEqual([
      "github.com · perso",
      "github.com/acme · robot",
    ]);
    app?.unmount();
    document.body.innerHTML = "";
    const aucun = monter([SANS_PORTEE]);
    await nextTick();
    expect(aucun.chargements).toEqual([]);
    expect(aucun.q("[data-mes-depots]")).toBeNull();
  });

  it("l'adresse dit quel compte servira ; sans compte : identifiants saisis sur place, enregistrés pour la portée proposée puis choisie", async () => {
    const v = monter([PERSO, ROBOT]);
    await v.saisir("#clone-url", "https://github.com/acme/api.git");
    expect(v.q("[data-acces]")?.getAttribute("data-etat")).toBe("compte");
    expect(v.q("[data-acces]")?.textContent).toContain("github.com/acme · robot");
    expect(v.q<HTMLInputElement>("#clone-dossier")?.placeholder).toBe("api");
    expect(v.q("[data-identifiants]")).toBeNull();
    await v.saisir("#clone-url", "https://forge.lan/equipe/outil.git");
    expect(v.q("[data-acces]")?.getAttribute("data-etat")).toBe("aucun");
    expect(v.q("[data-acces]")?.textContent).toContain("Aucun compte ne s'applique à cette adresse");
    v.q<HTMLButtonElement>("[data-saisir]")!.click();
    await nextTick();
    expect([...document.querySelectorAll("#clone-portee option")].map((o) => o.textContent?.trim())).toEqual([
      "forge.lan",
      "forge.lan/equipe",
      "forge.lan/equipe/outil",
    ]);
    expect(v.q<HTMLSelectElement>("#clone-portee")?.value).toBe("");
    await v.saisir("#clone-jeton", "tok");
    expect(v.q("[data-acces]")?.textContent).toContain("Identifiants saisis pour forge.lan");
    v.q<HTMLButtonElement>("[data-cloner]")!.click();
    await nextTick();
    expect(v.clones).toEqual([""]);
    expect(v.racine.loadGitConnectors).toHaveBeenCalledTimes(1);
    const choix = v.q<HTMLSelectElement>("#clone-portee")!;
    choix.value = "equipe";
    choix.dispatchEvent(new Event("change"));
    await nextTick();
    v.q<HTMLButtonElement>("[data-cloner]")!.click();
    await nextTick();
    expect(v.clones.at(-1)).toBe("equipe");
    // Même hôte, autre dépôt : les identifiants restent, la portée choisie ne suit pas.
    await v.saisir("#clone-url", "https://forge.lan/autre/depot.git");
    expect(v.etat.gitCloneCreds.value).toMatchObject({ ouvert: true, token: "tok", portee: null });
    expect(v.q<HTMLSelectElement>("#clone-portee")?.value).toBe("");
    // Même hôte en http : ce qui a été saisi pour https ne part pas en clair.
    await v.saisir("#clone-url", "http://forge.lan/autre/depot.git");
    expect(v.etat.gitCloneCreds.value).toMatchObject({ ouvert: false, token: "" });
    expect(v.q("[data-clair]")?.textContent).toContain("http : envoi en clair");
    await v.saisir("#clone-url", "git@github.com:acme/api.git");
    expect(v.q("[data-acces]")?.textContent).toContain("Adresse http(s) attendue");
    expect(v.q("[data-identifiants]")).toBeNull();
  });

  it("identifiants saisis pour un hôte : oubliés dès que l'adresse change d'hôte (dépôt choisi dans la liste compris) et à la fermeture", async () => {
    const v = monter([PERSO, ROBOT]);
    await v.saisir("#clone-url", "https://forge.lan/equipe/outil.git");
    v.q<HTMLButtonElement>("[data-saisir]")!.click();
    await nextTick();
    await v.saisir("#clone-identifiant", "bob");
    await v.saisir("#clone-jeton", "jeton-forge");
    v.racine.gitPickRepo({ clone_url: "https://github.com/acme/site.git" });
    await nextTick();
    expect(v.etat.gitCloneCreds.value).toEqual({
      ouvert: false,
      user: "",
      token: "",
      portee: null,
      refus: false,
    });
    expect(v.q("[data-acces]")?.textContent).toContain("Compte github.com/acme · robot");
    v.q<HTMLButtonElement>("[data-cloner]")!.click();
    await nextTick();
    expect(v.etat.gitCloneCreds.value.token).toBe("");
    v.q<HTMLButtonElement>("[data-saisir]")!.click();
    await nextTick();
    await v.saisir("#clone-jeton", "autre");
    v.etat.showGitCloneModal.value = false;
    await nextTick();
    expect(v.etat.gitCloneCreds.value).toEqual({
      ouvert: false,
      user: "",
      token: "",
      portee: null,
      refus: false,
    });
  });

  it("compte sans jeton : annoncé comme tel ; une portée déjà prise dit qu'elle remplace son jeton ; adresse illisible sur un hôte déjà pris : identifiants pour ce clone seulement, rien n'est envoyé à enregistrer", async () => {
    const vide = compte(7, "github.com", "acme/api", { has_token: false, label: "ci" });
    const v = monter([PERSO, vide]);
    await v.saisir("#clone-url", "https://github.com/acme/api.git");
    expect(v.q("[data-acces]")?.getAttribute("data-etat")).toBe("sans-jeton");
    expect(v.q("[data-acces]")?.textContent?.replace(/\s+/gu, " ")).toContain(
      "Compte github.com/acme/api · ci sans jeton",
    );
    v.q<HTMLButtonElement>("[data-saisir]")!.click();
    await nextTick();
    expect(v.q<HTMLSelectElement>("#clone-portee")?.value).toBe("acme/api");
    expect([...document.querySelectorAll("#clone-portee option")].map((o) => o.textContent?.trim())).toEqual([
      "github.com — met à jour ce compte",
      "github.com/acme",
      "github.com/acme/api — met à jour ce compte",
    ]);
    // Même hôte : le bloc reste ouvert.
    await v.saisir("#clone-url", "https://github.com/seul.git");
    expect(v.q("[data-acces]")?.getAttribute("data-etat")).toBe("aucun");
    expect(v.q("#clone-portee")).toBeNull();
    expect(v.q("[data-non-enregistres]")?.textContent).toContain("Non enregistrés");
    await v.saisir("#clone-jeton", "tok");
    expect(v.clones).toEqual([]);
    v.q<HTMLButtonElement>("[data-cloner]")!.click();
    await nextTick();
    expect(v.clones).toEqual([undefined]);
  });

  it("compte au jeton importé à vérifier : dit, avec le chemin vers Comptes Git ; sa portée ne peut pas être choisie", async () => {
    const importe = compte(8, "import.lan", "", { has_token: false, to_verify: true, label: "imported" });
    const v = monter([importe]);
    await v.saisir("#clone-url", "https://import.lan/acme/api.git");
    expect(v.q("[data-acces]")?.getAttribute("data-etat")).toBe("a-verifier");
    expect(v.q("[data-acces]")?.textContent?.replace(/\s+/gu, " ")).toContain(
      "Compte import.lan · imported à vérifier",
    );
    v.q<HTMLButtonElement>("[data-saisir]")!.click();
    await nextTick();
    const options = [...document.querySelectorAll<HTMLOptionElement>("#clone-portee option")];
    expect(options.map((o) => [o.textContent?.trim(), o.disabled])).toEqual([
      ["import.lan — compte à vérifier", true],
      ["import.lan/acme", false],
      ["import.lan/acme/api", false],
    ]);
    expect(v.q<HTMLSelectElement>("#clone-portee")?.value).toBe("acme");
    v.q<HTMLButtonElement>("[data-verifier]")!.click();
    await nextTick();
    expect(v.racine.openSettingsTab).toHaveBeenCalledWith("secrets:git");
  });

  it("refus d'accès : le message le dit avant le détail, le focus va à l'identifiant ; « Comptes Git » ferme la fenêtre et ouvre la partie des Paramètres", async () => {
    const v = monter([]);
    await v.saisir("#clone-url", "https://forge.lan/a/b.git");
    v.etat.gitError.value = REFUS_GIT;
    Object.assign(v.etat.gitCloneCreds.value, { ouvert: true, refus: true });
    await nextTick();
    await nextTick();
    expect(document.activeElement?.id).toBe("clone-identifiant");
    expect(v.q("[data-erreur]")?.textContent).toContain("Accès refusé : saisissez des identifiants.");
    expect(v.q("[data-erreur]")?.textContent).toContain(REFUS_GIT);
    v.q<HTMLButtonElement>("[data-comptes]")!.click();
    await nextTick();
    expect(v.etat.showGitCloneModal.value).toBe(false);
    expect(v.racine.openSettingsTab).toHaveBeenCalledWith("secrets:git");
  });
});
