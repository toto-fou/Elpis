// SPDX-License-Identifier: MIT
/** apps/toolhost/test/bac.test.ts — routes du cycle de vie du bac sur l'hôte TS (faux docker, faux agent) : /api/sandbox/me (imposition de l'enveloppe), redémarrage, destruction, instantanés en NDJSON. */
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  definirFabriqueAgent,
  erreurAgent,
  privdrop,
  reglagesBac,
  resetImageLoadState,
  resetUserSandboxCache,
} from "@elpis/bac";
import type { AgentBac, ArchiveAgent, DonneesEnvoi } from "@elpis/bac";
import { creerFauxDocker } from "@elpis/bac/test";
import type { FauxDocker } from "@elpis/bac/test";
import type { Dict } from "@elpis/commun";
import { surchargerConfig } from "@elpis/config";
import { creerIdentite, IDENTITY_HEADER, oublierConfigurationAudit, sign } from "@elpis/securite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { nomDossierInstantanes } from "../src/bac/instantanes";
import { oublierCachesMe } from "../src/bac/routes-me";
import { fermerBaseHote, ouvrirBaseHote } from "../src/base-hote";
import { dossierTemporaire, hoteTest, journalMuet, SVC } from "./aides";
import type { HoteTest } from "./aides";

const PROFILS = [
  { id: "isolated", name: "Isolé", mode: "none", ips: [] },
  { id: "web", name: "Web", mode: "bridge" },
  { id: "lan", name: "LAN", mode: "allowlist_ip", ips: ["10.0.0.0/24"] },
];

let tmp = "";
let nettoyer: () => void = () => undefined;
let restaurer: () => void = () => undefined;
let h: HoteTest;
let docker: FauxDocker;
let agentAppels: string[] = [];
let extraction: (path: string, d: DonneesEnvoi) => Promise<Dict> = async () => ({});

/** Enveloppe de main : imposition transmise (`""` : aucune), `forced: null` = non transmise. */
function entetesId(champs: { forced?: string | null; profil?: string; uid?: number; nom?: string } = {}) {
  const identite = creerIdentite({
    user_id: champs.uid ?? 7,
    username: champs.nom ?? "hugo",
    network_profile_id: champs.profil ?? "isolated",
    ...(champs.forced === null ? {} : { forced_network_profile_id: champs.forced ?? "" }),
  });
  return { authorization: `Bearer ${SVC}`, [IDENTITY_HEADER]: sign(identite, SVC) };
}

function archiveFactice(): ArchiveAgent {
  const morceaux: (Buffer | Dict)[] = [
    { progress: true, files: 1, bytes: 5, current: "a.txt" },
    Buffer.from("tgz-"),
    { progress: true, files: 2, bytes: 10, current: "b/é.txt" },
    Buffer.from("octets"),
  ];
  const a: ArchiveAgent & { fin: Dict | null } = {
    debut: { start: true, files: 2, dirs: 1, bytes: 10 },
    fin: null,
    async fermer() {
      agentAppels.push("fermer");
    },
    async *[Symbol.asyncIterator]() {
      for (const m of morceaux) yield m;
      a.fin = { files: 2, bytes: 10 };
    },
  };
  return a;
}

beforeEach(async () => {
  [tmp, nettoyer] = dossierTemporaire("elpis-th-bac-");
  docker = creerFauxDocker(path.join(tmp, "docker"));
  vi.stubEnv("PATH", `${docker.bin}${path.delimiter}${process.env["PATH"] ?? ""}`);
  vi.stubEnv("FAUX_DOCKER", docker.etat);
  vi.stubEnv("SANDBOX_READINESS_CACHE", "0");
  vi.stubEnv("ELPIS_AUDIT_DIR", path.join(tmp, "audit"));
  oublierConfigurationAudit();
  writeFileSync(path.join(tmp, "config.json"), JSON.stringify({ executors: { network_profiles: PROFILS } }));
  restaurer = surchargerConfig({
    SANDBOX_DIR: path.join(tmp, "sb"),
    CONFIG_JSON_PATH: path.join(tmp, "config.json"),
  });
  reglagesBac.attenteCreationMs = 0;
  agentAppels = [];
  extraction = async () => ({ files: 2, bytes: 10, conflicts: 1, conflict_paths: ["x".repeat(600)] });
  h = await hoteTest();
  definirFabriqueAgent((): AgentBac => ({
    hello: async () => ({}),
    archive: async (paths, o) => {
      agentAppels.push(`archive ${JSON.stringify([...paths])} ${o.format} ${o.maxFiles}`);
      return archiveFactice();
    },
    extract: async (p, d, o) => {
      agentAppels.push(`extract ${p} ${JSON.stringify(d)} ${o.maxMembers}`);
      o.onSent?.(5);
      return extraction(p, d);
    },
  }));
});

afterEach(async () => {
  await h.fermer();
  definirFabriqueAgent(null);
  reglagesBac.attenteCreationMs = 800;
  resetUserSandboxCache();
  resetImageLoadState();
  oublierCachesMe();
  privdrop.oublierSondes();
  oublierConfigurationAudit();
  restaurer();
  vi.unstubAllEnvs();
  nettoyer();
});

async function requete(
  methode: "GET" | "POST" | "DELETE",
  url: string,
  corps?: unknown,
  ident = entetesId(),
) {
  return h.app.inject({
    method: methode,
    url,
    headers: { ...ident, ...(corps !== undefined ? { "content-type": "application/json" } : {}) },
    ...(corps !== undefined ? { payload: typeof corps === "string" ? corps : JSON.stringify(corps) } : {}),
  });
}

describe("/api/sandbox/me", () => {
  it("GET : profils, image chargée à la volée puis conteneur créé, statistiques", async () => {
    const r1 = await requete("GET", "/api/sandbox/me");
    expect(r1.statusCode).toBe(200);
    expect(r1.headers["content-type"]).toBe("application/json");
    const c1 = r1.json();
    expect(c1).toMatchObject({
      user_mode: "docker",
      effective_mode: "docker",
      force_admin: false,
      image: "elpis/sandbox:1.7.0",
      limits: { memory_mb: 2048, cpu_quota_pct: 100, pids_max: 512, timeout_s: 600 },
      idle_kill_hours: 24,
      image_status: { status: "not_checked", image: null, archive_path: null, progress_msg: "" },
      network_profile_id: "isolated",
      network_profile_locked: false,
      daemon_ok: true,
      daemon_info: "27.3.1",
    });
    expect(c1.network_profiles.map((p: { id: string }) => p.id)).toEqual(["isolated", "web", "lan"]);
    expect(c1.container).toEqual({
      exists: true,
      running: true,
      container_id: "0123456789ab",
      container_name: "elpis-sb-hugo",
      image: "elpis/sandbox:1.7.0",
      started_at: "2026-10-10T00:00:00Z",
    });
    expect(c1.stats).toEqual({ cpu: "0.50%", mem: "12MiB / 2GiB", mem_pct: "0.59%", pids: "4" });
    const run = readFileSync(path.join(docker.etat, "elpis-sb-hugo.run"), "utf-8").split("\n");
    expect(run).toContain("elpis.user_id=7");
    expect(run).toContain(`${path.join(tmp, "sb", "hugo", "work")}:/work:rw`);
    expect(existsSync(path.join(tmp, "sb", "hugo", ".work-migrated"))).toBe(true);
  });

  it("GET : imposition portée par l'enveloppe (verrouillée), imposition d'un profil disparu ignorée, démon injoignable", async () => {
    docker.poser("demon-ko");
    const r = (
      await requete("GET", "/api/sandbox/me", undefined, entetesId({ forced: "lan", profil: "lan" }))
    ).json();
    expect([r.network_profile_id, r.network_profile_locked, r.daemon_ok, r.container]).toEqual([
      "lan",
      true,
      false,
      { error: "daemon injoignable" },
    ]);
    expect(r.daemon_info).toBe("Cannot connect to the Docker daemon");
    const r2 = (
      await requete("GET", "/api/sandbox/me", undefined, entetesId({ forced: "disparu", profil: "disparu" }))
    ).json();
    expect([r2.network_profile_id, r2.network_profile_locked]).toEqual(["isolated", false]);
  });

  it("POST : imposition de l'enveloppe = autorité (403), profil inconnu (400), mode invalide (400), corps illisible (500)", async () => {
    const imp = entetesId({ forced: "isolated" });
    const r403 = await requete("POST", "/api/sandbox/me", { mode: "docker", network_profile_id: "web" }, imp);
    expect([r403.statusCode, r403.json()]).toEqual([
      403,
      {
        detail:
          "Votre profil réseau est imposé par l'administrateur ('isolated') et ne peut pas être changé ici.",
      },
    ]);
    const r400 = await requete("POST", "/api/sandbox/me", { network_profile_id: "zzz" });
    expect([r400.statusCode, r400.json()]).toEqual([
      400,
      { detail: "Profil réseau 'zzz' introuvable. Disponibles : ['isolated', 'web', 'lan']" },
    ]);
    const rMode = await requete("POST", "/api/sandbox/me", { mode: { a: [1, true] } });
    expect(rMode.json()).toEqual({ detail: "mode doit être 'docker' (reçu {'a': [1, True]})" });
    expect((await requete("POST", "/api/sandbox/me", "{pas du json")).statusCode).toBe(500);
    expect((await requete("POST", "/api/sandbox/me", [1])).statusCode).toBe(500);
  });

  it("POST : imposition non transmise → changement refusé (503), même profil accepté ; choix retenu jusqu'à l'enveloppe à jour", async () => {
    const sans = entetesId({ forced: null });
    const r503 = await requete("POST", "/api/sandbox/me", { network_profile_id: "web" }, sans);
    expect([r503.statusCode, r503.json()]).toEqual([
      503,
      { detail: "Imposition du profil réseau non transmise par l'application : réessayez dans un instant." },
    ]);
    expect(
      (await requete("POST", "/api/sandbox/me", { network_profile_id: "isolated" }, sans)).statusCode,
    ).toBe(200);
    expect((await requete("POST", "/api/sandbox/me", { network_profile_id: "web" })).statusCode).toBe(200);
    const perime = (await requete("GET", "/api/sandbox/me")).json();
    expect(perime.network_profile_id).toBe("web");
    const runs = () => docker.appels().filter((a) => a.startsWith("run ")).length;
    const avant = runs();
    await requete("GET", "/api/sandbox/me");
    expect(runs()).toBe(avant);
    const impose = (
      await requete("GET", "/api/sandbox/me", undefined, entetesId({ forced: "lan", profil: "lan" }))
    ).json();
    expect([impose.network_profile_id, impose.network_profile_locked]).toEqual(["lan", true]);
  });

  it("POST : profil changé → ancien conteneur détruit, nouveau démarré sur le profil choisi, audit écrit", async () => {
    await requete("GET", "/api/sandbox/me");
    const r = await requete("POST", "/api/sandbox/me", { mode: "folder", network_profile_id: "web" });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({
      ok: true,
      mode: "docker",
      network_profile_id: "web",
      bootstrap: {
        image_status: {
          status: "loaded",
          image: "elpis/sandbox:1.7.0",
          archive_path: null,
          progress_msg: "Image déjà présente",
        },
        container: { running: true, container_name: "elpis-sb-hugo", profile_id: "web" },
      },
    });
    expect(docker.appels()).toContain("rm -fv elpis-sb-hugo");
    const run = readFileSync(path.join(docker.etat, "elpis-sb-hugo.run"), "utf-8").split("\n");
    expect(run).not.toContain("none");
    const audit = readdirSync(path.join(tmp, "audit")).map((f) =>
      readFileSync(path.join(tmp, "audit", f), "utf-8"),
    );
    const lignes = audit
      .join("")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lignes).toContainEqual(
      expect.objectContaining({
        action: "user.sandbox.mode",
        details: { mode: "docker", network_profile_id: "web" },
      }),
    );
  });

  it("POST : échec de démarrage → erreur, journaux du conteneur, nettoyage des conteneurs arrêtés", async () => {
    docker.poser("run-ko");
    const r = await requete("POST", "/api/sandbox/me", { network_profile_id: "isolated" });
    expect(r.json().bootstrap.container).toEqual({
      error: "docker run a échoué : docker: Error response from daemon: boom.",
      logs: "journal du conteneur",
    });
    expect(docker.appels().filter((a) => a.startsWith("ps -a"))).toEqual([
      "ps -a --filter label=elpis.user_id=7 --filter status=exited --filter status=dead --filter status=created --format {{.ID}}",
    ]);
  });

  it("restart et DELETE : 400 sans conteneur, 503 sans image, puis recréé et détruit", async () => {
    const r400 = await requete("POST", "/api/sandbox/me/restart");
    expect([r400.statusCode, r400.json().detail]).toEqual([
      400,
      "Pas de container à redémarrer. Démarre-le d'abord dans tes paramètres.",
    ]);
    await requete("GET", "/api/sandbox/me");
    const ok = await requete("POST", "/api/sandbox/me/restart");
    expect(ok.json()).toEqual({
      ok: true,
      container: { running: true, container_name: "elpis-sb-hugo", container_id: "0123456789ab" },
    });
    const sup = await requete("DELETE", "/api/sandbox/me");
    expect([sup.statusCode, sup.json()]).toEqual([200, { ok: true }]);
    expect(existsSync(path.join(docker.etat, "elpis-sb-hugo.run"))).toBe(false);
  });
});

describe("/api/internal/sandbox/delete (suppression d'un compte par la console)", () => {
  const FAUX = entetesId({ nom: "pbacfaux" });

  /** Conteneur créé, puis /work garni d'un dossier refusé à l'hôte (fichiers à l'UID du conteneur) et P d'un fichier. */
  async function bacGarni(): Promise<{ dossier: string; refuse: string }> {
    await requete("GET", "/api/sandbox/me", undefined, FAUX);
    const dossier = path.join(tmp, "sb", "pbacfaux");
    const refuse = path.join(dossier, "work", "d");
    mkdirSync(refuse, { recursive: true });
    writeFileSync(path.join(refuse, "f"), "x");
    chmodSync(refuse, 0o500);
    writeFileSync(path.join(dossier, "miroir"), "y");
    return { dossier, refuse };
  }

  it("conteneur retiré, /work vidé par le root du conteneur recréé, P supprimé, nom de l'enveloppe, audit", async () => {
    const { dossier } = await bacGarni();
    const avant = docker.appels().length;
    const r = await requete("POST", "/api/internal/sandbox/delete", undefined, FAUX);
    expect([r.statusCode, r.json()]).toEqual([200, { ok: true, deleted: true }]);
    expect(existsSync(dossier)).toBe(false);
    expect(existsSync(path.join(docker.etat, "elpis-sb-pbacfaux.run"))).toBe(false);
    expect(
      docker
        .appels()
        .slice(avant)
        .filter((a) => /^(exec|rm) /u.test(a)),
    ).toEqual([
      "rm -fv elpis-sb-pbacfaux",
      "exec -u 0:0 elpis-sb-pbacfaux pkill -KILL -U 10001",
      "exec -u 0:0 elpis-sb-pbacfaux find /work -xdev -mindepth 1 -delete",
      "rm -fv elpis-sb-pbacfaux",
    ]);
    const audit = readdirSync(path.join(tmp, "audit")).map((f) =>
      readFileSync(path.join(tmp, "audit", f), "utf-8"),
    );
    expect(audit.join("")).toContain('"action":"user.sandbox.delete"');
    const absent = await requete("POST", "/api/internal/sandbox/delete", undefined, FAUX);
    expect([absent.statusCode, absent.json()]).toEqual([200, { ok: true, deleted: false }]);
  });

  it("purge impossible : 502 avec la raison, rien de supprimé ; sans enveloppe : refusé", async () => {
    const { dossier, refuse } = await bacGarni();
    await requete("DELETE", "/api/sandbox/me", undefined, FAUX);
    docker.poser("run-ko");
    const r = await requete("POST", "/api/internal/sandbox/delete", undefined, FAUX);
    expect(r.statusCode).toBe(502);
    expect(String(r.json().detail)).toContain("boom");
    expect([existsSync(path.join(refuse, "f")), existsSync(path.join(dossier, "miroir"))]).toEqual([
      true,
      true,
    ]);
    chmodSync(refuse, 0o700);
    const sans = await h.app.inject({ method: "POST", url: "/api/internal/sandbox/delete" });
    expect(sans.statusCode).toBe(401);
    expect(existsSync(dossier)).toBe(true);
  });
});

describe("/api/internal/account/purge (identifiants de sites d'un compte supprimé)", () => {
  const FAUX = entetesId({ nom: "pbacfaux" });

  it("base de l'hôte : identifiants du nom de l'enveloppe retirés, ceux d'un autre compte gardés ; 401 sans enveloppe, 503 sans base", async () => {
    expect((await requete("POST", "/api/internal/account/purge", undefined, FAUX)).statusCode).toBe(503);
    const avant = surchargerConfig({ DB_BACKEND: "sqlite", DB_PATH: path.join(tmp, "toolhost.db") });
    try {
      const base = await ouvrirBaseHote(() => journalMuet);
      if (base === null) throw new Error("base de l'hôte non ouverte");
      for (const owner of ["pbacfaux", "pbacfaux", "bob"])
        await base.run(
          "INSERT INTO ax_credentials (owner, site, username, password, last_ok, use_count) VALUES (?, ?, 'u', 'p', 0, 1)",
          [owner, `https://${owner}-${Math.random()}.test`],
        );
      expect((await h.app.inject({ method: "POST", url: "/api/internal/account/purge" })).statusCode).toBe(
        401,
      );
      const r = await requete("POST", "/api/internal/account/purge", undefined, FAUX);
      expect([r.statusCode, r.json()]).toEqual([200, { ok: true, credentials: 2 }]);
      expect(await base.all("SELECT owner FROM ax_credentials")).toEqual([{ owner: "bob" }]);
    } finally {
      await fermerBaseHote();
      avant();
    }
  });
});

function lignes(corps: string): Dict[] {
  return corps
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => JSON.parse(l) as Dict);
}

describe("/api/sandbox/snapshots", () => {
  it("création en NDJSON (archive par l'agent), liste, restauration, suppression", async () => {
    const c = await requete("POST", "/api/sandbox/snapshots/create", { name: "  Avant refacto  " });
    expect(c.headers["content-type"]).toBe("application/x-ndjson; charset=utf-8");
    expect([
      c.headers["x-accel-buffering"],
      c.headers["cache-control"],
      c.headers["content-encoding"],
    ]).toEqual(["no", "no-cache", "identity"]);
    const ev = lignes(c.body);
    expect(ev.map((e) => e["event"])).toEqual(["preparing", "start", "progress", "progress", "done"]);
    expect(ev[2]).toEqual({
      event: "progress",
      phase: "snapshot",
      files_done: 1,
      total_files: 2,
      bytes_done: 5,
      total_bytes: 10,
      pct: 50.0,
      current_file: "a.txt",
    });
    expect(c.body).toContain('"pct":50.0');
    const meta = ev[4]?.["snapshot"] as Dict;
    expect(meta).toMatchObject({ name: "Avant refacto", file_count: 2, src_bytes: 10, archive_bytes: 10 });
    const dossier = path.join(tmp, "sb", "_snapshots", "hugo");
    expect(readFileSync(path.join(dossier, `${String(meta["id"])}.tar.gz`), "utf-8")).toBe("tgz-octets");
    expect(readdirSync(dossier).filter((f) => f.endsWith(".tmp"))).toEqual([]);
    expect(agentAppels).toEqual(['archive [""] tgz 500000', "fermer"]);

    const l = await requete("GET", "/api/sandbox/snapshots");
    expect([l.headers["cache-control"], l.json().max, l.json().last_restore_incomplete]).toEqual([
      "no-cache",
      10,
      null,
    ]);
    expect(l.json().items.map((m: Dict) => m["id"])).toEqual([meta["id"]]);

    const r = await requete("POST", `/api/sandbox/snapshots/${String(meta["id"])}/restore`);
    const er = lignes(r.body);
    expect(er[0]).toEqual({ event: "preparing", phase: "restore" });
    expect(er[1]).toEqual({ event: "start", phase: "restore", total_files: 2, total_bytes: 10 });
    expect(er.at(-1)).toEqual({
      event: "done",
      phase: "restore",
      files_restored: 2,
      bytes_restored: 10,
      conflicts: 1,
      conflict_paths: ["x".repeat(512)],
    });
    expect(agentAppels.at(-1)).toContain(
      `extract  {"chemin":"${path.join(dossier, `${String(meta["id"])}.tar.gz`)}"} 500000`,
    );
    expect(existsSync(path.join(dossier, ".elpis_restore_incomplete"))).toBe(false);

    const d = await requete("DELETE", `/api/sandbox/snapshots/${String(meta["id"])}`);
    expect(d.json()).toEqual({ ok: true, id: meta["id"] });
    expect((await requete("DELETE", `/api/sandbox/snapshots/${String(meta["id"])}`)).statusCode).toBe(404);
  });

  it("identifiants invalides (400), marqueur de restauration interrompue exposé puis acquitté", async () => {
    expect((await requete("POST", "/api/sandbox/snapshots/ABC/restore")).json()).toEqual({
      detail: "Invalid snapshot id",
    });
    expect((await requete("DELETE", "/api/sandbox/snapshots/..")).statusCode).toBe(404);
    const dossier = path.join(tmp, "sb", "_snapshots", "hugo");
    mkdirSync(dossier, { recursive: true });
    writeFileSync(path.join(dossier, ".elpis_restore_incomplete"), '{"snap_id": "a", "ts": 1.5}');
    expect((await requete("GET", "/api/sandbox/snapshots")).json().last_restore_incomplete).toEqual({
      snap_id: "a",
      ts: 1.5,
    });
    writeFileSync(path.join(dossier, ".elpis_restore_incomplete"), "{illisible");
    expect((await requete("GET", "/api/sandbox/snapshots")).json().last_restore_incomplete).toEqual({});
    expect((await requete("DELETE", "/api/sandbox/snapshots/restore-marker")).json()).toEqual({ ok: true });
    expect((await requete("DELETE", "/api/sandbox/snapshots/restore-marker")).json()).toEqual({ ok: true });
  });

  it("refus de l'agent : message de l'utilisateur ; restauration refusée lève le marqueur ; agent absent", async () => {
    const c = lignes((await requete("POST", "/api/sandbox/snapshots/create")).body);
    const id = String((c.at(-1)?.["snapshot"] as Dict)["id"]);
    extraction = async () => {
      throw erreurAgent("too_large", "trop", 413, { limit: "member" });
    };
    const r = lignes((await requete("POST", `/api/sandbox/snapshots/${id}/restore`)).body);
    expect(r.at(-1)).toEqual({
      event: "error",
      message:
        "Archive refusée : un fichier dépasse le cap par membre (1024 Mo ; SNAPSHOT_MAX_MEMBER_MB pour ajuster)",
    });
    expect(existsSync(path.join(tmp, "sb", "_snapshots", "hugo", ".elpis_restore_incomplete"))).toBe(false);
    definirFabriqueAgent(null);
    resetUserSandboxCache();
    const sans = lignes((await requete("POST", "/api/sandbox/snapshots/create")).body);
    expect(sans.at(-1)).toEqual({
      event: "error",
      message: "Environnement sandbox indisponible — réessayez dans un instant.",
    });
  });

  it("nom du dossier des instantanés : vecteurs Python de `_safe_username`", () => {
    const v = JSON.parse(
      readFileSync(new URL("../../../packages/bac/test/vecteurs/bac.json", import.meta.url), "utf-8"),
    ) as { noms_instantanes: { nom: string; dossier: string }[] };
    for (const c of v.noms_instantanes) expect(nomDossierInstantanes(c.nom, 42), c.nom).toBe(c.dossier);
  });

  it("nom du dossier des instantanés : alphanumériques Unicode, - et _", () => {
    expect(nomDossierInstantanes("José.D-u_p", 3)).toBe("JoséD-u_p");
    expect(nomDossierInstantanes("../$", 3)).toBe("user_3");
  });
});
