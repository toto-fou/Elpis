// SPDX-License-Identifier: MIT
/** frontend/test/admin/sandbox-protections.test.ts — console › Sandbox : protections d'un profil ouvert (cases, résumé, profil neuf) et état des domaines chargé en arrière-plan (réponse d'avant une sauvegarde ignorée). */
import * as Vue from "vue";
import { ref } from "vue";
import { describe, expect, it } from "vitest";

import { GestionnaireSession } from "../../src/features/auth/session";
import { setupAdmin } from "../../src/features/admin/console";
import { PROTECTIONS_RESEAU } from "../../src/features/admin/sandbox";
import type { CtxAdmin, RefsAdmin } from "../../src/features/admin/types";
import { ClientHttp } from "../../src/platform/http/client";
import { json } from "../aides";

const CONFIG = {
  limits: { memory_mb: 2048, cpu_quota_pct: 100, pids_max: 512, timeout_s: 600 },
  force_user_docker: false,
  idle_kill_hours: 24,
  network_profiles: [
    {
      id: "isolated",
      name: "Isolé",
      mode: "none",
      ips: [],
      description: "",
      domains: [],
      ports: [],
      dns: [],
    },
    { id: "libre", name: "Libre", mode: "bridge", ips: [], description: "", domains: [], ports: [], dns: [] },
    {
      id: "garde",
      name: "Gardé",
      mode: "bridge",
      ips: [],
      description: "",
      domains: [],
      ports: [],
      dns: [],
      block_metadata: true,
      block_host: true,
    },
    {
      id: "web",
      name: "Web",
      mode: "allowlist_ip",
      ips: ["192.0.2.1"],
      description: "",
      domains: ["a.example", "b.example", "c.example"],
      ports: [],
      dns: [],
    },
  ],
  exec_user: "10001:10001",
  runtime: "",
  extra_run_args: [],
};
const STALE = { user_id: 3, username: "bob", container: "elpis-sb-bob", profile_id: "web" };

/** Console branchée sur de fausses routes ; les réponses de `/status` sont rendues à la main, dans l'ordre des demandes. */
function monter() {
  const corps: unknown[] = [];
  const demandesEtat: ((r: Response) => void)[] = [];
  const route = (url: string, init?: RequestInit): Response | Promise<Response> => {
    if (url === "/api/admin/executors/status") return new Promise<Response>((ok) => demandesEtat.push(ok));
    if (url === "/api/admin/executors" && init?.method === "POST") {
      corps.push(JSON.parse(String(init.body)));
      return json({ ok: true, config: {}, warnings: [], stale_containers: [] });
    }
    if (url === "/api/admin/executors") return json({ config: CONFIG, image: "elpis/sandbox:1.0.0" });
    return json({});
  };
  const fetchFaux = (url: string, init?: RequestInit): Promise<Response> => Promise.resolve(route(url, init));
  const refs: RefsAdmin = {
    user: ref({ username: "root", role: "admin", is_admin: 1 }),
    isAdminView: ref(true),
  };
  const ctx: CtxAdmin = {
    showToast: () => undefined,
    fetchAuth: (url, options) => fetchFaux(url, options),
    openConfirm: () => Promise.resolve(true),
    openChoice: () => Promise.resolve("save"),
    nextTick: () => Vue.nextTick(),
    loadPublicConfig: () => undefined,
    systemAlert: ref(""),
  };
  const A = setupAdmin(Vue, refs, ctx, new ClientHttp(new GestionnaireSession(), fetchFaux));
  const profil = (id: string) => {
    const p = A.execConfig.value.network_profiles.find((x) => x.id === id);
    if (!p) throw new Error(`profil ${id} absent`);
    return p;
  };
  return { A, corps, demandesEtat, profil };
}
const etat = (domains_status: unknown, stale_containers: unknown[] = []): Response =>
  json({ ok: true, domains_status, stale_containers });

describe("console › Sandbox › protections d'un profil ouvert", () => {
  it("les trois cases : métadonnées du cloud, réseau local, machine hôte", () => {
    expect(PROTECTIONS_RESEAU.map((p) => [p.key, p.label])).toEqual([
      ["block_metadata", "Métadonnées du cloud"],
      ["block_lan", "Réseau local"],
      ["block_host", "Machine hôte"],
    ]);
    expect(monter().A.netProtections).toBe(PROTECTIONS_RESEAU);
  });

  it("profil neuf : métadonnées et hôte cochées, réseau local non", () => {
    const { A } = monter();
    A.addNetworkProfile();
    const p = A.execConfig.value.network_profiles.at(-1);
    expect([p?.block_metadata, p?.block_lan, p?.block_host]).toEqual([true, false, true]);
  });

  it("résumé d'un profil ouvert : les refus cochés, ou l'accès total", async () => {
    const { A, profil } = monter();
    await A.loadExecConfig();
    expect(A.netProfileSummary(profil("libre"))).toBe(
      "Internet, réseau local, machine hôte et métadonnées du cloud",
    );
    expect(A.netProfileSummary(profil("garde"))).toBe(
      "Internet ; refusés : métadonnées du cloud, machine hôte",
    );
    profil("garde").block_lan = true;
    expect(A.netProfileSummary(profil("garde"))).toBe(
      "Internet ; refusés : métadonnées du cloud, réseau local, machine hôte",
    );
    expect(A.netProfileSummary(profil("isolated"))).toBe("Aucune sortie réseau");
  });

  it("enregistrement : les cases cochées partent avec chaque profil", async () => {
    const { A, corps, profil } = monter();
    await A.loadExecConfig();
    profil("libre").block_lan = true;
    expect(await A.saveExecConfig()).toBe(true);
    const profils = (corps[0] as { executors: { network_profiles: Record<string, unknown>[] } }).executors
      .network_profiles;
    const par = (id: string) => profils.find((p) => p["id"] === id);
    expect(par("libre")?.["block_lan"]).toBe(true);
    expect([par("garde")?.["block_metadata"], par("garde")?.["block_host"]]).toEqual([true, true]);
  });
});

describe("console › Sandbox › état des domaines", () => {
  it("chargé en arrière-plan après la configuration : domaines sans adresse listés pour un profil en liste blanche", async () => {
    const { A, demandesEtat, profil } = monter();
    await A.loadExecConfig();
    expect(A.etatDomaines.value).toEqual({});
    await Vue.nextTick();
    expect(demandesEtat).toHaveLength(1);
    demandesEtat[0]?.(etat({ web: { "a.example": ["198.51.100.1"], "b.example": [], "c.example": null } }));
    await Vue.nextTick();
    await new Promise((ok) => setTimeout(ok, 0));
    expect(A.domainesNonResolus(profil("web"))).toEqual(["b.example", "c.example"]);
    expect(A.domainesNonResolus(profil("libre"))).toEqual([]);
  });

  it("conteneurs à recréer de l'état : listés ; liste vide : celle de la sauvegarde n'est pas effacée", async () => {
    const { A, demandesEtat } = monter();
    await A.loadExecConfig();
    demandesEtat[0]?.(etat({}, [STALE]));
    await new Promise((ok) => setTimeout(ok, 0));
    expect(A.staleNetContainers.value).toEqual([STALE]);
    await A.loadExecConfig();
    demandesEtat[1]?.(etat({}, []));
    await new Promise((ok) => setTimeout(ok, 0));
    expect(A.staleNetContainers.value).toEqual([STALE]);
  });

  it("réponse reçue après une sauvegarde : ignorée ; celle demandée après la sauvegarde : gardée", async () => {
    const { A, demandesEtat, profil } = monter();
    await A.loadExecConfig();
    expect(demandesEtat).toHaveLength(1);
    const sauvegarde = A.saveExecConfig();
    await sauvegarde;
    await new Promise((ok) => setTimeout(ok, 0));
    expect(demandesEtat).toHaveLength(2);
    demandesEtat[0]?.(etat({ web: { "a.example": [] } }, [STALE]));
    await new Promise((ok) => setTimeout(ok, 0));
    expect(A.etatDomaines.value).toEqual({});
    expect(A.staleNetContainers.value).toEqual([]);
    demandesEtat[1]?.(etat({ web: { "a.example": [], "b.example": ["198.51.100.2"] } }));
    await new Promise((ok) => setTimeout(ok, 0));
    expect(A.domainesNonResolus(profil("web"))).toEqual(["a.example"]);
  });

  it("état illisible ou en erreur : la page reste utilisable", async () => {
    const { A, demandesEtat, profil } = monter();
    await A.loadExecConfig();
    demandesEtat[0]?.(json({ pas: "un état" }));
    await new Promise((ok) => setTimeout(ok, 0));
    expect(A.etatDomaines.value).toEqual({});
    expect(A.domainesNonResolus(profil("web"))).toEqual([]);
  });
});
