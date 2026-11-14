// SPDX-License-Identifier: MIT
/** frontend/test/editor/clonage.test.ts — fenêtre « Cloner un dépôt » : adresse lue, compte qui servira, dossier créé, portées des identifiants saisis, compte proposé ; clonage avec identifiants (portée envoyée, refus d'accès, purge) ; fenêtre montée (liste ou adresse, récapitulatif, saisie sur place, dépôts du compte proposé). */
import { createApp, defineComponent, h, nextTick, proxyRefs, ref } from "vue";
import type { App } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";

import ModaleClonage from "../../src/components/editor/ModaleClonage.vue";
import {
  accesClone,
  comptePropose,
  comptesListables,
  comptesUtilisables,
  dossierDuClone,
  exempleAdresse,
  lectureAdresse,
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
    // Dépôt à la racine de l'hôte, ou « @ » dans le chemin : le serveur ne leur cherche aucun compte, même celui de tout l'hôte.
    expect(accesClone("https://github.com/projet.git", [PERSO])).toMatchObject({ etat: "aucun" });
    expect(accesClone("https://github.com/@scope/pkg.git", [PERSO])).toMatchObject({ etat: "aucun" });
    // En http, un jeton enregistré ne part que vers le réseau local, ou si l'API du compte est en http.
    expect(accesClone("http://github.com/autre/depot", [PERSO])).toMatchObject({
      etat: "aucun",
      clair: true,
    });
    const local = compte(10, "forge.lan:3000", "");
    expect(accesClone("http://forge.lan:3000/a/b", [local])).toMatchObject({ etat: "compte", clair: true });
    expect(accesClone("http://192.168.1.20/a/b", [compte(11, "192.168.1.20", "")])).toMatchObject({
      etat: "compte",
    });
    const enHttp = compte(12, "git.exemple.org", "", { api_base: "http://git.exemple.org/api/v1" });
    expect(accesClone("http://git.exemple.org/a/b", [enHttp])).toMatchObject({ etat: "compte" });
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

  it("adresse lue comme le serveur l'acceptera : hôte et dépôt d'une adresse http(s) ; SSH, identifiants, autre schéma, « ? », « # », hôte ou chemin mal formés refusés ; en cours de saisie : incomplète, sans reproche", () => {
    expect(lectureAdresse("  ")).toEqual({ etat: "vide" });
    expect(lectureAdresse(" https://Forge.lan:3000/equipe/outil.git/ ")).toEqual({
      etat: "lue",
      hote: "forge.lan:3000",
      depot: "equipe/outil",
    });
    expect(lectureAdresse("HTTPS://forge.lan/a/b/c")).toEqual({
      etat: "lue",
      hote: "forge.lan",
      depot: "a/b/c",
    });
    expect(lectureAdresse("https://forge.lan/seul")).toMatchObject({ etat: "lue", depot: "seul" });
    expect(lectureAdresse("http://[::1]:3000/a/b.git")).toMatchObject({ etat: "lue", hote: "[::1]:3000" });
    for (const ssh of ["git@github.com:acme/api.git", "ssh://git@forge.lan:2222/acme/api.git"])
      expect(lectureAdresse(ssh), ssh).toEqual({ etat: "ssh" });
    for (const avec of [
      "https://u:p@forge.lan/a/b.git",
      "https://jeton@forge.lan/a/b",
      "https://@forge.lan/a/b",
    ])
      expect(lectureAdresse(avec), avec).toEqual({ etat: "identifiants" });
    for (const autre of [
      "git://forge.lan/a/b.git",
      "forge.lan/a/b",
      "/chemin/local",
      "acme/api",
      "https://forge.lan/a/b.git?x=1",
      "https://forge.lan/a/b#frag",
      "https://?x",
      "https:///a/b",
      "https://for ge.lan/a/b",
      "https://forge.lan:99999/a/b",
      "https://forge.lan\\x/a/b",
      "https://forge.lan/a b/c",
      "https://forge.lan/./a",
      "https://forge.lan/a/%2e%2e/b",
      "https://forge.lan/a/b.git\\",
    ])
      expect(lectureAdresse(autre), autre).toEqual({ etat: "invalide" });
    for (const debut of ["h", "http", "https:/", "https://", "https://forge.lan", "https://forge.lan/"])
      expect(lectureAdresse(debut), debut).toEqual({ etat: "incomplete" });
    // Une adresse lue l'est aussi pour chercher son compte, au schéma en majuscules près.
    for (const lue of ["https://forge.lan/a/b.git", "http://[::1]:3000/a/b", "https://forge.lan/seul"])
      expect(accesClone(lue, TOUS).etat, lue).not.toBe("invalide");
  });

  it("comptes dont les dépôts sont proposés : ceux qui savent les lister, pas un compte « generic » ; exemple du champ : sur l'hôte du dernier compte utilisé, même « generic »", () => {
    const generique = compte(6, "git.lan", "", { provider_type: "generic", last_used: 500 });
    expect(comptesListables([...TOUS, generique]).map((c) => c.id)).toEqual([1, 2]);
    expect(comptePropose([generique])).toBeNull();
    expect(comptePropose([PERSO, generique])?.id).toBe(1);
    expect(exempleAdresse([])).toBe("https://forge.exemple/organisation/depot.git");
    expect(exempleAdresse(TOUS)).toBe("https://github.com/acme/depot.git");
    expect(exempleAdresse([PERSO, generique])).toBe("https://git.lan/organisation/depot.git");
    expect(
      exempleAdresse([compte(5, "192.168.1.10:3000", "", { api_base: "http://192.168.1.10:3000/api/v1" })]),
    ).toBe("http://192.168.1.10:3000/organisation/depot.git");
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
    // La portée d'office tomberait sur ce compte : la plus proche ouverte, plus précise d'abord.
    expect(ferme.defaut).toBe("acme/api");
    const seule = p("https://import.lan/seul.git", [compte(9, "import.lan", "", { to_verify: true })]);
    expect(seule.defaut).toBeNull();
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
      if (q(s) === null && s === "#clone-url") {
        q<HTMLButtonElement>('[data-source="adresse"]')!.click();
        await nextTick();
      }
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
    // Sans compte utilisable : ni onglets ni liste, l'adresse seule.
    expect(aucun.q("[role=tablist]")).toBeNull();
    expect(aucun.q("#clone-url")).not.toBeNull();
  });

  it("un seul champ à la fois : la liste d'abord, l'adresse sous son onglet ; le focus suit, les flèches changent d'onglet ; la liste garde sa place pendant le chargement et en cas d'erreur", async () => {
    const v = monter([PERSO]);
    await nextTick();
    await nextTick();
    const onglet = (s: string) => v.q<HTMLButtonElement>(`[data-source="${s}"]`)!;
    expect(onglet("depots").getAttribute("aria-selected")).toBe("true");
    expect(v.q("#clone-url")).toBeNull();
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Filtrer mes dépôts");
    // Chargement, erreur, liste : la même boîte.
    v.etat.gitCloneReposLoading.value = true;
    await nextTick();
    expect(v.q("[data-liste-depots] [role=status]")?.textContent).toContain("Chargement des dépôts");
    v.etat.gitCloneReposLoading.value = false;
    v.etat.gitCloneReposError.value = "Aucun dépôt accessible";
    await nextTick();
    expect(v.q("[data-liste-vide]")?.textContent).toContain("Aucun dépôt accessible");
    v.q<HTMLButtonElement>("[data-vers-adresse]")!.click();
    await nextTick();
    await nextTick();
    expect(onglet("adresse").getAttribute("aria-selected")).toBe("true");
    expect(v.q("[data-mes-depots]")).toBeNull();
    expect(document.activeElement?.id).toBe("clone-url");
    expect(v.q<HTMLInputElement>("#clone-url")?.placeholder).toBe(
      "https://github.com/organisation/depot.git",
    );
    v.q("[role=tablist]")!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
    await nextTick();
    await nextTick();
    expect(onglet("depots").getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(onglet("depots"));
    // Dépôt choisi dans la liste : il se lit dans le récapitulatif, l'adresse le retrouve sous son onglet.
    v.etat.gitCloneReposError.value = "";
    v.etat.gitFilteredCloneRepos.value = [
      { full_name: "acme/site", clone_url: "https://github.com/acme/site.git" },
    ];
    await nextTick();
    v.q<HTMLButtonElement>("[data-depot]")!.click();
    await nextTick();
    expect(v.q("[data-depot-lu]")?.textContent?.replace(/\s+/gu, " ").trim()).toBe(
      "acme/site sur github.com",
    );
    onglet("adresse").click();
    await nextTick();
    expect(v.q<HTMLInputElement>("#clone-url")?.value).toBe("https://github.com/acme/site.git");
  });

  it("comptes arrivés après l'ouverture : leur liste prend la place et le focus, sauf si une adresse est déjà saisie ; compte « generic » seul : l'adresse, sans onglets ni liste demandée", async () => {
    const v = monter([]);
    await nextTick();
    await nextTick();
    expect(document.activeElement?.id).toBe("clone-url");
    v.etat.gitConnectors.value = [PERSO];
    await nextTick();
    await nextTick();
    expect(v.q('[data-source="depots"]')?.getAttribute("aria-selected")).toBe("true");
    expect(v.q("#clone-url")).toBeNull();
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Filtrer mes dépôts");
    expect(v.chargements).toEqual(["1"]);
    app?.unmount();
    document.body.innerHTML = "";
    const saisie = monter([]);
    await saisie.saisir("#clone-url", "https://forge.lan/a/b.git");
    saisie.etat.gitConnectors.value = [PERSO];
    await nextTick();
    await nextTick();
    expect(saisie.q('[data-source="adresse"]')?.getAttribute("aria-selected")).toBe("true");
    expect(saisie.q<HTMLInputElement>("#clone-url")?.value).toBe("https://forge.lan/a/b.git");
    app?.unmount();
    document.body.innerHTML = "";
    const generique = monter([compte(6, "git.lan", "", { provider_type: "generic", label: "interne" })]);
    await nextTick();
    expect(generique.chargements).toEqual([]);
    expect(generique.q("[role=tablist]")).toBeNull();
    expect(generique.q<HTMLInputElement>("#clone-url")?.placeholder).toBe(
      "https://git.lan/organisation/depot.git",
    );
    await generique.saisir("#clone-url", "https://git.lan/equipe/outil.git");
    expect(generique.q("[data-acces]")?.textContent).toContain("Compte git.lan · interne");
  });

  it("réouverture : la liste des dépôts attend la fin de l'animation d'ouverture, le focus revient au filtre", async () => {
    const v = monter([PERSO]);
    v.etat.gitFilteredCloneRepos.value = [
      { full_name: "acme/site", clone_url: "https://github.com/acme/site.git" },
    ];
    await nextTick();
    expect(document.querySelectorAll("[data-depot]").length).toBe(1);
    v.etat.showGitCloneModal.value = false;
    await nextTick();
    v.etat.showGitCloneModal.value = true;
    await nextTick();
    expect(document.querySelectorAll("[data-depot]").length).toBe(0);
    expect(v.q("[data-liste-depots] [role=status]")).not.toBeNull();
    await vi.waitFor(() => expect(document.querySelectorAll("[data-depot]").length).toBe(1));
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Filtrer mes dépôts");
  });

  it("récapitulatif : rien de choisi, adresse en cours, adresse SSH ou autre refusée avec la raison ; « Cloner » n'est offert qu'une fois le dépôt lu", async () => {
    const v = monter([PERSO]);
    await nextTick();
    const lu = () => v.q("[data-depot-lu]")?.textContent?.replace(/\s+/gu, " ").trim();
    const bouton = () => v.q<HTMLButtonElement>("[data-cloner]")!;
    expect(lu()).toBe("Choisissez un dépôt dans la liste");
    expect(v.q("[data-acces]")?.textContent?.trim()).toBe("—");
    expect(bouton().disabled).toBe(true);
    await v.saisir("#clone-url", "");
    expect(lu()).toBe("Saisissez son adresse");
    expect(v.q("[data-aide]")?.textContent).toContain("Adresse http(s) que la forge propose");
    await v.saisir("#clone-url", "https://github.com/");
    expect(lu()).toBe("Adresse incomplète");
    expect(bouton().disabled).toBe(true);
    await v.saisir("#clone-url", "git@github.com:acme/api.git");
    expect(lu()).toBe("Adresse non acceptée");
    expect(v.q("[data-aide]")?.textContent).toContain("Adresse SSH non prise en charge");
    expect(bouton().disabled).toBe(true);
    v.q<HTMLInputElement>("#clone-url")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    await nextTick();
    expect(v.clones).toEqual([]);
    await v.saisir("#clone-url", "ftp://github.com/acme/api.git");
    expect(v.q("[data-aide]")?.textContent?.replace(/\s+/gu, " ")).toContain(
      "Adresse non reconnue. Exemple : https://github.com/organisation/depot.git",
    );
    // Identifiants ou requête dans l'adresse : le serveur la refuserait, aucun compte n'est annoncé.
    await v.saisir("#clone-url", "https://bob:jeton@github.com/acme/api.git");
    expect(lu()).toBe("Adresse non acceptée");
    expect(v.q("[data-aide]")?.textContent).toContain("Identifiants dans l'adresse refusés");
    expect(v.q("[data-acces]")?.textContent?.trim()).toBe("—");
    expect(bouton().disabled).toBe(true);
    await v.saisir("#clone-url", "https://github.com/acme/api.git?x=1");
    expect(v.q("[data-acces]")?.textContent?.trim()).toBe("—");
    expect(bouton().disabled).toBe(true);
    // Schéma en majuscules : cloné par le serveur, mais aucun compte n'est annoncé ni promis.
    await v.saisir("#clone-url", "HTTPS://github.com/acme/api.git");
    expect(lu()).toBe("acme/api sur github.com");
    expect(v.q("[data-acces]")?.textContent?.trim()).toBe("—");
    expect(bouton().disabled).toBe(false);
    v.etat.gitError.value = REFUS_GIT;
    Object.assign(v.etat.gitCloneCreds.value, { ouvert: true, refus: true });
    await nextTick();
    expect(v.q("[data-erreur]")?.textContent).not.toContain("saisissez des identifiants");
    expect(v.q("[data-identifiants]")).toBeNull();
    v.etat.gitError.value = "";
    await v.saisir("#clone-url", "https://github.com/acme/api.git");
    expect(lu()).toBe("acme/api sur github.com");
    expect(v.q("[data-acces]")?.textContent).toContain("Compte github.com · perso");
    expect(bouton().disabled).toBe(false);
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
    expect(v.q("[data-acces]")?.textContent?.replace(/\s+/gu, " ")).toContain(
      "Aucun compte : dépôt public, ou",
    );
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
    // Rien ne part encore : la mention « en clair » ne vient qu'avec des identifiants saisis ou un compte utilisé.
    expect(v.q("[data-clair]")).toBeNull();
    v.q<HTMLButtonElement>("[data-saisir]")!.click();
    await nextTick();
    await v.saisir("#clone-jeton", "tok2");
    expect(v.q("[data-clair]")?.textContent).toContain("http : envoi en clair");
    await v.saisir("#clone-url", "git@github.com:acme/api.git");
    expect(v.q("[data-acces]")?.textContent?.trim()).toBe("—");
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
