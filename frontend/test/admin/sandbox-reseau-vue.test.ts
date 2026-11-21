// SPDX-License-Identifier: MIT
/** frontend/test/admin/sandbox-reseau-vue.test.ts — console › Sandbox › Réseau : tête repliée (sans sudo, domaines sans adresse, comptes), carte dépliée (éditeur et ses aides, ce que voient les sandboxes), onglets au clic et au clavier, règles suivies à l'édition et copiées, comptes du profil, état du serveur en échec, identifiant changé, hôtes d'outils distants. */
import * as Vue from "vue";
import { createApp, defineComponent, h, provide, reactive, ref } from "vue";
import type { App } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";

import PageSandbox from "../../src/components/admin/PageSandbox.vue";
import { GestionnaireSession } from "../../src/features/auth/session";
import { setupAdmin } from "../../src/features/admin/console";
import { CLE_ADMIN } from "../../src/features/admin/domaine";
import type { DomaineAdmin } from "../../src/features/admin/domaine";
import { reglesPosees, texteRegles } from "../../src/features/admin/reseau-vue";
import type { CtxAdmin, RefsAdmin } from "../../src/features/admin/types";
import { ClientHttp } from "../../src/platform/http/client";
import { json, vider } from "../aides";

const vide = { ips: [], domains: [], ports: [], dns: [], description: "" };
const CONFIG = {
  limits: { memory_mb: 2048, cpu_quota_pct: 100, pids_max: 512, timeout_s: 600 },
  force_user_docker: false,
  idle_kill_hours: 24,
  network_profiles: [
    { ...vide, id: "isolated", name: "Isolé total", mode: "none" },
    {
      ...vide,
      id: "ouvert",
      name: "Ouvert",
      mode: "bridge",
      block_metadata: false,
      block_lan: false,
      block_host: false,
    },
    {
      ...vide,
      id: "liste",
      name: "Liste",
      mode: "allowlist_ip",
      ips: ["203.0.113.10"],
      domains: ["api.example.com", "absent.example.net"],
      ports: [443],
    },
  ],
  exec_user: "10001:10001",
  runtime: "",
  extra_run_args: [],
  allow_sudo: true,
};
const ETAT = {
  ok: true,
  domains_status: { liste: { "api.example.com": ["192.0.2.20"], "absent.example.net": [] } },
  stale_containers: [],
  accounts: [
    { user_id: 1, username: "alice", profile_id: "liste", origin: "chosen" },
    { user_id: 2, username: "bob", profile_id: "liste", origin: "forced" },
    { user_id: 3, username: "carole", profile_id: "isolated", origin: "default" },
  ],
  machine: { addresses: ["192.0.2.10"], broadcasts: ["192.0.2.255"] },
  remote_toolhosts: false,
};

let app: App | null = null;
afterEach(() => {
  app?.unmount();
  app = null;
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

/** Console montée sur la page Réseau ; `etat` : réponse de /status, `null` pour un échec du serveur. */
async function monter(etat: unknown = ETAT) {
  const fetchFaux = (url: string): Promise<Response> => {
    if (url === "/api/admin/executors")
      return Promise.resolve(json({ config: CONFIG, image: "elpis/sandbox:1.0.0" }));
    if (url === "/api/admin/executors/status")
      return Promise.resolve(etat === null ? json({ detail: "panne" }, 500) : json(etat));
    if (url === "/api/admin/sandbox/containers") return Promise.resolve(json({ containers: [], count: 0 }));
    return Promise.resolve(json({ daemon_ok: false, error: "absent", hint: "" }));
  };
  const toasts: string[] = [];
  const refs: RefsAdmin = {
    user: ref({ username: "root", role: "admin", is_admin: 1 }),
    isAdminView: ref(true),
  };
  const ctx: CtxAdmin = {
    showToast: (m) => void toasts.push(m),
    fetchAuth: (url) => fetchFaux(url),
    openConfirm: () => Promise.resolve(true),
    openChoice: () => Promise.resolve("save"),
    nextTick: () => Vue.nextTick(),
    loadPublicConfig: () => undefined,
    systemAlert: ref(""),
  };
  const pages: string[] = [];
  const tenu: { adm?: ReturnType<typeof setupAdmin> } = {};
  const Racine = defineComponent({
    setup() {
      const a = setupAdmin(Vue, refs, ctx, new ClientHttp(new GestionnaireSession(), fetchFaux));
      a.goAdminPage = (id: string) => {
        pages.push(id);
        return Promise.resolve(true);
      };
      tenu.adm = a;
      provide(CLE_ADMIN, reactive(a) as unknown as DomaineAdmin);
      return () => h(PageSandbox);
    },
  });
  const hote = document.createElement("div");
  document.body.appendChild(hote);
  app = createApp(Racine);
  app.mount(hote);
  const adm = tenu.adm;
  if (!adm) throw new Error("console non montée");
  adm.adminTab.value = "sandbox-network";
  await adm.loadExecConfig();
  await vider();
  const carte = (id: string): HTMLElement => {
    const c = [...hote.querySelectorAll<HTMLElement>(".np-card")].find(
      (e) => e.querySelector(".np-card__id")?.textContent === id,
    );
    if (!c) throw new Error(`carte ${id} absente`);
    return c;
  };
  const textes = (racine: Element, selecteur: string): string[] =>
    [...racine.querySelectorAll(selecteur)].map((e) => (e.textContent ?? "").replace(/\s+/g, " ").trim());
  /** Textes tels qu'un lecteur d'écran les lit : parties `aria-hidden` écartées. */
  const lus = (racine: Element, selecteur: string): string[] =>
    [...racine.querySelectorAll(selecteur)].map((e) => {
      const copie = e.cloneNode(true) as Element;
      for (const cache of copie.querySelectorAll('[aria-hidden="true"]')) cache.remove();
      return (copie.textContent ?? "").replace(/\s+/g, " ").trim();
    });
  const lignesTableau = (racine: Element): string[] =>
    [...racine.querySelectorAll(".np-table tbody tr")].map((tr) => textes(tr, "td").join(" | "));
  return { adm, hote, toasts, pages, carte, textes, lus, lignesTableau };
}

describe("console › Sandbox › Réseau : ce que voient les sandboxes", () => {
  it("têtes repliées : badge du mode, sans sudo sur le profil filtré, domaine sans adresse, nombre de comptes accordé", async () => {
    const { hote, carte, textes, lus } = await monter();
    expect(hote.querySelectorAll(".np-card")).toHaveLength(3);
    expect(hote.querySelectorAll(".np-card--open")).toHaveLength(0);
    expect(textes(hote, ".np-badge")).toEqual(["Bloqué", "Ouvert", "Liste"]);
    expect(lus(carte("liste"), ".np-pastille")).toEqual(["sans sudo", "1 domaine sans adresse", "2 comptes"]);
    expect(textes(carte("liste"), '.np-pastille span[aria-hidden="true"]')).toEqual(["2"]);
    expect(lus(carte("ouvert"), ".np-pastille")).toEqual(["0 compte"]);
    expect(lus(carte("isolated"), ".np-pastille")).toEqual(["1 compte"]);
    expect(hote.querySelector(".adm-card__hint")?.textContent).toContain("Le profil isolé sert de repli");
  });

  it("carte dépliée : éditeur en sections avec ses aides, graphe des destinations, comptes du profil et lien vers Utilisateurs", async () => {
    const { carte, textes, pages } = await monter();
    const c = carte("liste");
    c.querySelector<HTMLButtonElement>(".np-card__toggle")?.click();
    await vider();
    expect(c.classList.contains("np-card--open")).toBe(true);
    expect(c.querySelector(".np-card__toggle")?.getAttribute("aria-expanded")).toBe("true");
    expect(textes(c, ".np-sec__t")).toEqual([
      "Profil",
      "Sortie réseau",
      "Destinations autorisées",
      "Relais Git",
      "2 comptes",
    ]);
    const aides = textes(c, ".np-aide");
    for (const aide of [
      "Tout est refusé, sauf les destinations listées ci-dessous ; les sandboxes tournent sans sudo.",
      "IPv4 ou réseau IPv4 ; l'IPv6 est refusée.",
      "Résolus à la création de la sandbox : la première adresse est épinglée, toutes sont autorisées.",
      "Liste : TCP sur ces ports ; Tous : tous ports et protocoles.",
      "Le relais Git joint tous les dépôts (par défaut). La règle borne le relais Git et les PR qu'Elpis ouvre, pas le réseau du profil.",
    ])
      expect(aides).toContain(aide);
    expect(c.querySelector('[role="tab"][aria-selected="true"]')?.textContent?.trim()).toBe("Graphe");
    expect(textes(c, ".np-dest__texte").slice(0, 3)).toEqual([
      "203.0.113.10",
      "api.example.com",
      "absent.example.net",
    ]);
    expect(c.querySelectorAll(".np-dest--inactif")).toHaveLength(1);
    expect(c.querySelectorAll(".np-graphe__fleches path.np-arc")).toHaveLength(
      c.querySelectorAll(".np-dest").length,
    );
    expect(textes(c, ".np-graphe__source span")).toEqual([
      "Sandbox du profil",
      "2 comptes",
      "sans sudo · lecture seule",
      "réseau elpis-sandbox",
    ]);
    expect(textes(c, ".np-compte")).toEqual(["alice choisi", "bob imposé"]);
    c.querySelector<HTMLButtonElement>(".np-comptes__lien")?.click();
    expect(pages).toEqual(["accounts"]);
  });

  it("onglets : tableau puis règles au clic, retour au graphe au clavier ; les règles suivent l'édition et se copient", async () => {
    const { adm, carte, toasts, lignesTableau } = await monter();
    const c = carte("liste");
    const onglet = (nom: string): HTMLButtonElement | undefined =>
      [...c.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((b) => b.textContent?.trim() === nom);
    onglet("Tableau")?.click();
    await vider();
    expect(c.querySelector('[role="tabpanel"]')?.getAttribute("data-vue")).toBe("tableau");
    expect(lignesTableau(c).slice(0, 3)).toEqual([
      "203.0.113.10 | TCP 443 | Autorisé | adresse autorisée",
      "api.example.com | TCP 443 | Autorisé | 192.0.2.20 épinglée",
      "absent.example.net | — | Inactif | nom introuvable : une sandbox créée maintenant ne le joindrait pas",
    ]);
    onglet("Règles posées")?.click();
    await vider();
    const prof = adm.execConfig.value.network_profiles.find((p) => p.id === "liste");
    if (!prof) throw new Error("profil absent");
    const attendu = (): string => {
      const r = reglesPosees(prof, adm.contexteReseau.value);
      return r.genre === "regles" ? texteRegles(r) : "";
    };
    expect(c.querySelector("pre.np-regles")?.textContent).toBe(attendu());
    expect(c.querySelector("pre.np-regles")?.textContent).toContain(
      "-A OUTPUT -d 192.0.2.20 -p tcp -m multiport --dports 443 -j ACCEPT",
    );
    prof._draft["ports"] = "22";
    adm.commitNetValue(prof, "ports");
    await vider();
    expect(c.querySelector("pre.np-regles")?.textContent).toContain("--dports 443,22 -j ACCEPT");
    expect(c.querySelector("pre.np-regles")?.textContent).toBe(attendu());
    const ecrits: string[] = [];
    vi.stubGlobal("navigator", {
      clipboard: { writeText: (t: string) => Promise.resolve(void ecrits.push(t)) },
    });
    [...c.querySelectorAll<HTMLButtonElement>(".np-regles__tete button")][0]?.click();
    await vider();
    expect(ecrits).toEqual([attendu()]);
    expect(toasts).toContain("Règles copiées");
    c.querySelector('[role="tablist"]')?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Home", bubbles: true }),
    );
    await vider();
    expect(c.querySelector('[role="tabpanel"]')?.getAttribute("data-vue")).toBe("graphe");
    expect(prof._onglet).toBe("graphe");
  });

  it("profil ouvert : cases « Refuser aussi », repères à protéger, règles posées dès la première case, verdicts tirés de ces règles", async () => {
    const { adm, carte, textes, lignesTableau } = await monter();
    const c = carte("ouvert");
    expect(textes(c, ".np-case__t")).toEqual(["Métadonnées du cloud", "Réseau local", "Machine hôte"]);
    expect(c.querySelectorAll(".np-graphe__dest .np-risque")).toHaveLength(3);
    expect(textes(c, ".np-aide--warn")).toEqual([
      "Accès total : internet, réseau local, machine hôte et métadonnées du cloud.",
    ]);
    const prof = adm.execConfig.value.network_profiles.find((p) => p.id === "ouvert");
    if (!prof) throw new Error("profil absent");
    adm.choisirVueReseau(prof, "regles");
    await vider();
    expect(textes(c, ".np-vide")[0]).toContain("le réseau du profil sort sans filtre");
    const lan = [...c.querySelectorAll<HTMLInputElement>(".np-case input")][1];
    if (!lan) throw new Error("case absente");
    lan.checked = true;
    lan.dispatchEvent(new Event("change"));
    await vider();
    expect(prof.block_lan).toBe(true);
    expect(textes(c, ".np-pastille")).toContain("sans sudo");
    expect(c.querySelector("pre.np-regles")?.textContent).toContain(
      "-A OUTPUT -d 10.0.0.0/8 -j REJECT --reject-with icmp-host-unreachable",
    );
    adm.choisirVueReseau(prof, "tableau");
    await vider();
    expect(lignesTableau(c).slice(1, 4)).toEqual([
      "Métadonnées du cloud (ouvert, à protéger) | — | Partiel | joignables : 168.63.129.16 ; refusées par Réseau local : 169.254.0.0/16, 100.100.100.200",
      "Réseau local | — | Refusé | refusé par Réseau local",
      "Machine hôte (ouvert, à protéger) | tous | Autorisé | ports de l'hôte joignables",
    ]);
  });

  it("profil isolé : aide du repli, aucune règle à poser, son compte par défaut", async () => {
    const { adm, carte, textes } = await monter();
    const c = carte("isolated");
    expect(textes(c, ".np-aide")).toContain(
      "Profil de repli : toujours sans réseau. Le conteneur n'a aucune interface réseau ; seuls les relais de l'hôte (Git, navigateur) répondent.",
    );
    const prof = adm.execConfig.value.network_profiles.find((p) => p.id === "isolated");
    if (!prof) throw new Error("profil absent");
    adm.choisirVueReseau(prof, "regles");
    await vider();
    expect(textes(c, ".np-vide")).toEqual([
      "Le conteneur démarre sans interface réseau (--network none) : aucune règle à poser.",
    ]);
    expect(textes(c, ".np-compte")).toEqual(["carole par défaut"]);
  });

  it("état du serveur en échec : comptes et relevé dits indisponibles, jamais « Chargement… » qui dure", async () => {
    const { adm, carte, textes, lus, lignesTableau } = await monter(null);
    expect(adm.contexteReseau.value.etat).toBe("echec");
    expect(lus(carte("liste"), ".np-pastille")).toEqual(["sans sudo"]);
    const c = carte("liste");
    expect(textes(c, ".np-comptes .np-chips__empty")).toEqual(["Comptes indisponibles"]);
    expect(textes(c, ".np-graphe__source span")[1]).toBe("comptes indisponibles");
    const prof = adm.execConfig.value.network_profiles.find((p) => p.id === "liste");
    if (!prof) throw new Error("profil absent");
    adm.choisirVueReseau(prof, "tableau");
    await vider();
    expect(lignesTableau(c)[1]).toBe(
      "api.example.com | TCP 443 | Autorisé | résolution indisponible : adresses relevées à la création",
    );
    const o = carte("ouvert");
    const ouvert = adm.execConfig.value.network_profiles.find((p) => p.id === "ouvert");
    if (!ouvert) throw new Error("profil absent");
    ouvert.block_host = true;
    adm.choisirVueReseau(ouvert, "regles");
    await vider();
    expect(textes(o, ".np-vide")).toEqual([
      "Relevé de la machine indisponible : les règles de la protection « Machine hôte » ne peuvent pas être montrées.",
    ]);
    adm.choisirVueReseau(ouvert, "tableau");
    await vider();
    expect(lignesTableau(o)[3]).toBe("Machine hôte | — | Refusé | relevé de la machine indisponible");
  });

  it("identifiant changé : les comptes restent rattachés au profil chargé, l'éditeur prévient de leur repli sur le profil isolé", async () => {
    const { adm, carte, textes } = await monter();
    const c = carte("liste");
    const prof = adm.execConfig.value.network_profiles.find((p) => p.id === "liste");
    if (!prof) throw new Error("profil absent");
    prof.id = "liste-2";
    await vider();
    expect(textes(c, ".np-compte")).toEqual(["alice choisi", "bob imposé"]);
    expect(textes(c, ".np-aide--warn")).toContain(
      "Identifiant changé : à l'enregistrement, 2 comptes repasseront sur le profil isolé, car leur réglage vise « liste ».",
    );
    prof.id = "liste";
    await vider();
    expect(textes(c, ".np-aide--warn").filter((t) => t.startsWith("Identifiant changé"))).toEqual([]);
  });

  it("hôtes d'outils distants déclarés : la vue dit que le relevé est celui de la machine de la console", async () => {
    const sans = await monter();
    expect(sans.hote.querySelectorAll(".np-aide--info")).toHaveLength(0);
    app?.unmount();
    document.body.innerHTML = "";
    const { carte, textes } = await monter({ ...ETAT, remote_toolhosts: true });
    expect(textes(carte("liste"), ".np-aide--info")).toEqual([
      "Relevé de la machine de la console ; une sandbox placée sur un autre hôte d'outils reçoit les adresses de cet hôte.",
    ]);
  });
});
