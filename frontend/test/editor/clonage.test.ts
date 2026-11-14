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

function json(corps: unknown, status = 200): Response {
  return new Response(JSON.stringify(corps), { status, headers: { "Content-Type": "application/json" } });
}

describe("ce que dit l'adresse", () => {
  it("compte qui servira : le plus précis de l'hôte ; ni un compte sans portée, ni sans jeton ; autre schéma : invalide", () => {
    expect(accesClone("  ", TOUS)).toEqual({ etat: "vide" });
    expect(accesClone("git@github.com:acme/api.git", TOUS)).toEqual({ etat: "invalide" });
    expect(accesClone("https://github.com/acme/api.git", TOUS)).toMatchObject({
      etat: "compte",
      hote: "github.com",
      chemin: "acme/api",
      compte: ROBOT,
    });
    expect(accesClone("https://github.com/autre/depot", TOUS)).toMatchObject({
      etat: "compte",
      compte: PERSO,
    });
    expect(accesClone("https://forge.lan/a/b.git", TOUS)).toEqual({
      etat: "aucun",
      hote: "forge.lan",
      chemin: "a/b",
    });
    expect(accesClone("https://github.com/acme/api", [SANS_PORTEE])).toMatchObject({ etat: "aucun" });
    expect(accesClone("https://github.com/acme/api", null)).toMatchObject({ etat: "aucun" });
    expect(comptesUtilisables(TOUS).map((c) => c.id)).toEqual([1, 2]);
    expect(nomCompte(ROBOT)).toBe("github.com/acme · robot");
    expect(nomCompte(compte(9, "h", ""))).toBe("h");
  });

  it("dossier créé : dernier segment sans `.git` ; portées des identifiants : de l'hôte au dépôt, proposée comme le serveur", () => {
    expect(dossierDuClone("https://github.com/acme/api.git")).toBe("api");
    expect(dossierDuClone(" https://github.com/acme/api/ ")).toBe("api");
    expect(dossierDuClone("")).toBe("");
    const p = (url: string, comptes: CompteClone[]) => porteesIdentifiants(accesClone(url, comptes), comptes);
    expect(p("https://forge.lan/acme/api.git", [])).toEqual({
      choix: [
        { valeur: "", libelle: "forge.lan" },
        { valeur: "acme", libelle: "forge.lan/acme" },
        { valeur: "acme/api", libelle: "forge.lan/acme/api" },
      ],
      defaut: "",
    });
    expect(p("https://github.com/autre/depot", [PERSO]).defaut).toBe("autre");
    expect(p("https://github.com/acme/api", TOUS).defaut).toBe("acme");
    expect(p("https://github.com/acme/api?x=1", [PERSO])).toEqual({
      choix: [{ valeur: "", libelle: "github.com" }],
      defaut: "",
    });
    expect(p("pas une adresse", TOUS)).toEqual({ choix: [], defaut: "" });
  });

  it("compte proposé : le seul utilisable, sinon le dernier utilisé ; refus d'accès : identifiants en cause, jamais un 409 du relais", () => {
    expect(comptePropose(TOUS)?.id).toBe(2);
    expect(comptePropose([PERSO])?.id).toBe(1);
    expect(comptePropose([SANS_PORTEE, SANS_JETON])).toBeNull();
    expect(comptePropose(undefined)).toBeNull();
    expect(refusDAcces(400, "fatal: Authentication failed for 'https://…'")).toBe(true);
    expect(refusDAcces(400, "The requested URL returned error: 403")).toBe(true);
    expect(refusDAcces(409, "Relais Git : authentification hors de l'opération")).toBe(false);
    expect(refusDAcces(400, "fatal: repository not found")).toBe(false);
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
  });

  it("refus d'accès : la fenêtre reste, la saisie des identifiants s'ouvre ; un refus du relais ne la demande pas ; la déconnexion purge tout", async () => {
    const refus = monter(() => json({ detail: "fatal: Authentication failed" }, 400));
    refus.api.gitOpenCloneModal();
    refus.api.gitCloneForm.value = { url: "https://forge.lan/acme/api.git", dir: "" };
    expect(await refus.api.gitClone()).toBe(false);
    expect(refus.api.showGitCloneModal.value).toBe(true);
    expect(refus.api.gitError.value).toBe("fatal: Authentication failed");
    expect(refus.api.gitCloneCreds.value).toMatchObject({ ouvert: true, refus: true });
    refus.api.gitCloneCreds.value.token = "secret";
    refus.api.resetOnLogout();
    expect(refus.api.gitCloneCreds.value.token).toBe("");
    expect(refus.api.showGitCloneModal.value).toBe(false);
    const relais = monter(() => json({ detail: "Relais Git : dépôt refusé (auth)" }, 409));
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
    expect(v.q("[data-acces]")?.textContent).toContain("Aucun compte pour forge.lan");
    v.q<HTMLButtonElement>("[data-saisir]")!.click();
    await nextTick();
    expect([...document.querySelectorAll("#clone-portee option")].map((o) => o.textContent)).toEqual([
      "forge.lan",
      "forge.lan/equipe",
      "forge.lan/equipe/outil",
    ]);
    expect(v.q<HTMLSelectElement>("#clone-portee")?.value).toBe("");
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
    // Une autre adresse : la portée choisie pour la précédente ne suit pas.
    await v.saisir("#clone-url", "https://github.com/autre/depot.git");
    expect(v.etat.gitCloneCreds.value.portee).toBeNull();
    expect(v.q<HTMLSelectElement>("#clone-portee")?.value).toBe("autre");
    await v.saisir("#clone-url", "git@github.com:acme/api.git");
    expect(v.q("[data-acces]")?.textContent).toContain("Adresse http(s) attendue");
    expect(v.q("[data-identifiants]")).toBeNull();
  });

  it("refus d'accès : le message le dit avant le détail ; « Comptes Git » ferme la fenêtre et ouvre la partie des Paramètres", async () => {
    const v = monter([]);
    v.etat.gitError.value = "fatal: Authentication failed";
    v.etat.gitCloneCreds.value.refus = true;
    await nextTick();
    expect(v.q("[data-erreur]")?.textContent).toContain("Accès refusé : saisissez des identifiants.");
    expect(v.q("[data-erreur]")?.textContent).toContain("fatal: Authentication failed");
    v.q<HTMLButtonElement>("[data-comptes]")!.click();
    await nextTick();
    expect(v.etat.showGitCloneModal.value).toBe(false);
    expect(v.racine.openSettingsTab).toHaveBeenCalledWith("secrets:git");
  });
});
