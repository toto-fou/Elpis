// SPDX-License-Identifier: MIT
/** frontend/test/admin/sandbox-git.test.ts — console › Sandbox : règle Git d'un profil (trois règles, serveurs saisis un par ligne et validés dans le navigateur, port compris), envoyée à l'enregistrement. */
import * as Vue from "vue";
import { ref } from "vue";
import { describe, expect, it } from "vitest";

import { GestionnaireSession } from "../../src/features/auth/session";
import { setupAdmin } from "../../src/features/admin/console";
import { ACCES_GIT } from "../../src/features/admin/sandbox";
import type { CtxAdmin, RefsAdmin } from "../../src/features/admin/types";
import { ClientHttp } from "../../src/platform/http/client";
import { json } from "../aides";

const BASE = { ips: [], description: "", domains: [], ports: [], dns: [] };
const CONFIG = {
  limits: { memory_mb: 2048, cpu_quota_pct: 100, pids_max: 512, timeout_s: 600 },
  force_user_docker: false,
  idle_kill_hours: 24,
  network_profiles: [
    { id: "isolated", name: "Isolé", mode: "none", ...BASE },
    { id: "libre", name: "Libre", mode: "bridge", ...BASE },
    {
      id: "serveurs",
      name: "Serveurs",
      mode: "bridge",
      ...BASE,
      git_access: "servers",
      git_servers: ["github.com/acme", "git.lan:3000"],
    },
    { id: "comptes", name: "Comptes", mode: "none", ...BASE, git_access: "accounts" },
  ],
  exec_user: "10001:10001",
  runtime: "",
  extra_run_args: [],
};

function monter() {
  const corps: unknown[] = [];
  const confirmations: string[] = [];
  const route = (url: string, init?: RequestInit): Response => {
    if (url === "/api/admin/executors" && init?.method === "POST") {
      corps.push(JSON.parse(String(init.body)));
      return json({ ok: true, config: {}, warnings: [], stale_containers: [] });
    }
    if (url === "/api/admin/executors") return json({ config: CONFIG, image: "elpis/sandbox:1.0.0" });
    if (url === "/api/admin/executors/status")
      return json({ ok: true, domains_status: {}, stale_containers: [] });
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
    openConfirm: (_titre: string, message: string) => {
      confirmations.push(message);
      return Promise.resolve(true);
    },
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
  return { A, corps, confirmations, profil };
}

/** Saisit `texte` dans le champ des serveurs Git d'un profil ouvert à la règle « serveurs » ; rend les serveurs gardés, le champ et l'erreur. */
async function saisir(texte: string): Promise<{ gardes: unknown; champ: string; erreur: string }> {
  const { A, profil } = monter();
  await A.loadExecConfig();
  const p = profil("serveurs");
  p._draft["git_servers"] = texte;
  A.commitGitServers(p);
  return {
    gardes: p.git_servers,
    champ: String(p._draft["git_servers"]),
    erreur: String(p._err["git_servers"]),
  };
}

describe("console › Sandbox › règle Git d'un profil", () => {
  it("trois règles proposées, « tous » d'abord", () => {
    expect(ACCES_GIT.map((g) => [g.key, g.label])).toEqual([
      ["all", "Tous"],
      ["servers", "Serveurs choisis"],
      ["accounts", "Comptes Git"],
    ]);
    expect(monter().A.accesGit).toBe(ACCES_GIT);
  });

  it("lecture : règle et serveurs du serveur, serveurs montrés un par ligne dans le brouillon", async () => {
    const { A, profil } = monter();
    await A.loadExecConfig();
    expect(profil("libre").git_access).toBeUndefined();
    expect(profil("comptes").git_access).toBe("accounts");
    expect(profil("serveurs").git_servers).toEqual(["github.com/acme", "git.lan:3000"]);
    expect(profil("serveurs")._draft["git_servers"]).toBe("github.com/acme\ngit.lan:3000");
    expect(profil("libre")._draft["git_servers"]).toBe("");
  });

  it("profil neuf : aucune règle posée (tous les dépôts par défaut)", () => {
    const { A } = monter();
    A.addNetworkProfile();
    const p = A.execConfig.value.network_profiles.at(-1);
    expect(p?.git_access).toBeUndefined();
    expect(p?.git_servers).toBeUndefined();
    expect(p?._draft["git_servers"]).toBe("");
  });

  it.each([
    ["github.com", ["github.com"]],
    ["GitHub.com/Acme", ["github.com/Acme"]],
    ["HTTPS://GitHub.com/Acme/API.GIT", ["github.com/Acme/API"]],
    ["https://github.com/acme/api.git", ["github.com/acme/api"]],
    ["http://git.lan:3000/", ["git.lan:3000"]],
    ["git.lan:65535", ["git.lan:65535"]],
    ["a.lan\nb.lan, c.lan; d.lan", ["a.lan", "b.lan", "c.lan", "d.lan"]],
    ["a.lan A.LAN https://a.lan/", ["a.lan"]],
    ["   ", []],
  ])("saisie %j : %j gardés", async (texte, attendu) => {
    expect(await saisir(texte)).toEqual({ gardes: attendu, champ: attendu.join("\n"), erreur: "" });
  });

  it.each([
    ["git.lan:65536"],
    ["git.lan:99999"],
    ["git.lan:0"],
    ["git.lan:abc"],
    ["user@git.lan"],
    ["ssh://git@git.lan/o"],
    ["git.lan/.."],
    ["git.lan/o/./r"],
    ["git.lan//o"],
    ["git.lan/a%2fb"],
    ["-mauvais.lan"],
    ["a..b"],
  ])("serveur illisible %j : gardé dans le champ avec le motif, jamais envoyé", async (mauvais) => {
    const r = await saisir(`bon.lan ${mauvais}`);
    expect(r.gardes).toEqual(["bon.lan"]);
    expect(r.champ).toBe(`bon.lan\n${mauvais}`);
    expect(r.erreur).toBe(`Serveur illisible : ${mauvais} (hôte[:port] ou hôte/organisation)`);
  });

  it("port à la limite : 65535 accepté, 65536 refusé, dans un chemin d'organisation aussi", async () => {
    expect((await saisir("git.lan:65535/acme")).gardes).toEqual(["git.lan:65535/acme"]);
    expect((await saisir("git.lan:65536/acme")).gardes).toEqual([]);
  });

  it("fermer la carte d'un profil « serveurs » valide le brouillon en cours de frappe", async () => {
    const { A, profil } = monter();
    await A.loadExecConfig();
    const p = profil("serveurs");
    p._open = true;
    p._draft["git_servers"] = "Nouveau.LAN";
    A.toggleProfile(p);
    expect([p._open, p.git_servers]).toEqual([false, ["nouveau.lan"]]);
  });

  it("enregistrement : la règle part avec chaque profil, brouillon validé d'abord", async () => {
    const { A, corps, profil } = monter();
    await A.loadExecConfig();
    profil("serveurs")._draft["git_servers"] = "github.com/acme\nAutre.LAN";
    expect(await A.saveExecConfig()).toBe(true);
    const profils = (corps[0] as { executors: { network_profiles: Record<string, unknown>[] } }).executors
      .network_profiles;
    const par = (id: string) => profils.find((p) => p["id"] === id);
    expect([par("serveurs")?.["git_access"], par("serveurs")?.["git_servers"]]).toEqual([
      "servers",
      ["github.com/acme", "autre.lan"],
    ]);
    expect(par("comptes")?.["git_access"]).toBe("accounts");
    expect(par("libre")?.["git_access"]).toBeUndefined();
  });

  it("suppression d'un profil : la confirmation dit que les comptes retombent sur la règle du profil de repli", async () => {
    const { A, confirmations } = monter();
    await A.loadExecConfig();
    const idx = A.execConfig.value.network_profiles.findIndex((p) => p.id === "serveurs");
    await A.removeNetworkProfile(idx);
    expect(confirmations).toHaveLength(1);
    expect(confirmations[0]).toContain('repasseront en "isolated"');
    expect(confirmations[0]).toContain("règle Git");
    expect(A.execConfig.value.network_profiles.some((p) => p.id === "serveurs")).toBe(false);
  });
});
