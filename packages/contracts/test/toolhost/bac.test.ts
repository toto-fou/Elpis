// SPDX-License-Identifier: MIT
/** packages/contracts/test/toolhost/bac.test.ts — contrats du cycle de vie du bac et des instantanés rejoués contre l'hôte d'outils réel (faux docker, faux agent) ; jeton d'aperçu servi par le core. */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  definirFabriqueAgent,
  privdrop,
  reglagesBac,
  resetImageLoadState,
  resetUserSandboxCache,
} from "@elpis/bac";
import type { AgentBac, ArchiveAgent } from "@elpis/bac";
import { creerFauxDocker } from "@elpis/bac/test";
import type { FauxDocker } from "@elpis/bac/test";
import type { Dict } from "@elpis/commun";
import { surchargerConfig } from "@elpis/config";
import { creerIdentite, IDENTITY_HEADER, oublierConfigurationAudit, sign } from "@elpis/securite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { oublierCachesMe } from "../../../../apps/toolhost/src/bac/routes-me";
import { dossierTemporaire, SVC } from "../../../../apps/toolhost/test/aides";
import { appelerHote, hoteTest, routesDuDomaine, verifierToolhost } from "./aides";
import type { HoteTest } from "./aides";

const PROFILS = [
  { id: "isolated", name: "Isolé", mode: "none", ips: [] },
  { id: "web", name: "Web", mode: "bridge" },
];

let tmp = "";
let nettoyer: () => void = () => undefined;
let restaurer: () => void = () => undefined;
let h: HoteTest;
let docker: FauxDocker;
const couvertes = new Set<string>();

/** Enveloppe de main avec l'imposition de profil transmise (vide : aucune), comme le fait le core. */
function enveloppeBac(): Record<string, string> {
  const identite = creerIdentite({
    user_id: 7,
    username: "hugo",
    network_profile_id: "isolated",
    forced_network_profile_id: "",
  });
  return { authorization: `Bearer ${SVC}`, [IDENTITY_HEADER]: sign(identite, SVC) };
}

async function ok(methode: string, url: string, corps?: unknown) {
  const r = await appelerHote(h, methode, url, corps, enveloppeBac());
  return { statut: r.statut, corps: verifierToolhost(methode, url, r, couvertes) as Dict };
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
      // rien à fermer
    },
    async *[Symbol.asyncIterator]() {
      for (const m of morceaux) yield m;
      a.fin = { files: 2, bytes: 10 };
    },
  };
  return a;
}

describe("contrats REST : cycle de vie du bac et instantanés (hôte d'outils réel)", () => {
  beforeEach(async () => {
    [tmp, nettoyer] = dossierTemporaire("elpis-ct-bac-");
    docker = creerFauxDocker(path.join(tmp, "docker"));
    vi.stubEnv("PATH", `${docker.bin}${path.delimiter}${process.env["PATH"] ?? ""}`);
    vi.stubEnv("FAUX_DOCKER", docker.etat);
    vi.stubEnv("SANDBOX_READINESS_CACHE", "0");
    vi.stubEnv("ELPIS_AUDIT_DIR", path.join(tmp, "audit"));
    oublierConfigurationAudit();
    writeFileSync(
      path.join(tmp, "config.json"),
      JSON.stringify({ executors: { network_profiles: PROFILS } }),
    );
    restaurer = surchargerConfig({
      SANDBOX_DIR: path.join(tmp, "sb"),
      CONFIG_JSON_PATH: path.join(tmp, "config.json"),
    });
    reglagesBac.attenteCreationMs = 0;
    h = await hoteTest();
    definirFabriqueAgent((): AgentBac => ({
      hello: async () => ({}),
      archive: async () => archiveFactice(),
      extract: async (_p, _d, o) => {
        o.onSent?.(5);
        return { files: 2, bytes: 10, conflicts: 1, conflict_paths: ["x.txt"] };
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

  it("état du bac, choix du profil réseau, redémarrage, destruction", async () => {
    const moi = await ok("GET", "/api/sandbox/me");
    expect(moi.corps["container"]).toMatchObject({ running: true });
    expect(
      (await ok("POST", "/api/sandbox/me", { mode: "docker", network_profile_id: "web" })).corps,
    ).toMatchObject({
      ok: true,
    });
    expect((await ok("POST", "/api/sandbox/me", { network_profile_id: "zzz" })).statut).toBe(400);
    expect((await ok("POST", "/api/sandbox/me/restart")).corps).toMatchObject({ ok: true });
    expect((await ok("DELETE", "/api/sandbox/me")).corps).toEqual({ ok: true });
    oublierCachesMe();
    docker.poser("demon-ko");
    expect((await ok("GET", "/api/sandbox/me")).corps["container"]).toEqual({ error: "daemon injoignable" });
  });

  it("instantanés : création et restauration en NDJSON, liste, marqueur, suppression", async () => {
    const creation = await appelerHote(
      h,
      "POST",
      "/api/sandbox/snapshots/create",
      { name: "Avant" },
      enveloppeBac(),
    );
    const evenements = verifierToolhost(
      "POST",
      "/api/sandbox/snapshots/create",
      creation,
      couvertes,
    ) as Dict[];
    expect(evenements.map((e) => e["event"])).toEqual(["preparing", "start", "progress", "progress", "done"]);
    const id = (evenements.at(-1)?.["snapshot"] as Dict)["id"] as string;
    const liste = await ok("GET", "/api/sandbox/snapshots");
    expect(liste.corps["items"]).toHaveLength(1);
    const restauration = await appelerHote(
      h,
      "POST",
      `/api/sandbox/snapshots/${id}/restore`,
      undefined,
      enveloppeBac(),
    );
    const suite = verifierToolhost(
      "POST",
      `/api/sandbox/snapshots/${id}/restore`,
      restauration,
      couvertes,
    ) as Dict[];
    expect(suite.at(-1)).toMatchObject({ event: "done", phase: "restore" });
    const dossier = path.join(tmp, "sb", "_snapshots", "hugo");
    mkdirSync(dossier, { recursive: true });
    writeFileSync(path.join(dossier, ".elpis_restore_incomplete"), '{"snap_id": "a", "ts": 1.5}');
    expect((await ok("GET", "/api/sandbox/snapshots")).corps["last_restore_incomplete"]).toEqual({
      snap_id: "a",
      ts: 1.5,
    });
    writeFileSync(path.join(dossier, ".elpis_restore_incomplete"), "{illisible");
    expect((await ok("GET", "/api/sandbox/snapshots")).corps["last_restore_incomplete"]).toEqual({});
    expect((await ok("DELETE", "/api/sandbox/snapshots/restore-marker")).corps).toEqual({ ok: true });
    expect((await ok("DELETE", `/api/sandbox/snapshots/${id}`)).corps).toEqual({ ok: true, id });
    expect((await ok("DELETE", `/api/sandbox/snapshots/${id}`)).statut).toBe(404);
    const inconnu = await appelerHote(
      h,
      "POST",
      "/api/sandbox/snapshots/ABC/restore",
      undefined,
      enveloppeBac(),
    );
    expect(inconnu.statut).toBe(400);
  });

  it("toutes les routes du domaine ont été interrogées", () => {
    const attendues = routesDuDomaine("bac-instantanes");
    expect([...couvertes].filter((k) => attendues.includes(k)).sort()).toEqual([...attendues].sort());
  });
});
