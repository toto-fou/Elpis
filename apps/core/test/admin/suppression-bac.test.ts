// SPDX-License-Identifier: MIT
/** apps/core/test/admin/suppression-bac.test.ts — pilote du bac branché dans la console composée (faux docker, vrai hôte d'outils local, faux hôte distant) : suppression d'un compte avec son bac, profil réseau imposé. */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { getUserSandbox, reglagesBac, resetUserSandboxCache, WORK_SUBDIR } from "@elpis/bac";
import { creerFauxDocker } from "@elpis/bac/test";
import type { FauxDocker } from "@elpis/bac/test";
import { invalidateConfigCache, surchargerConfig } from "@elpis/config";
import { oublierConfigurationAudit } from "@elpis/securite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { oublierHotes } from "../../src/relais/hotes";
import { FauxToolhost, JETON } from "../relais/aides";
import { demarrerHoteReel, MOTEURS, ouvrirConsole } from "./aides-bac";
import type { ConsoleDeTest, HoteReel } from "./aides-bac";

const PROFILS = [
  { id: "isolated", name: "Isolé", mode: "none", ips: [] },
  { id: "web", name: "Web", mode: "bridge" },
];

let tmp: string;
let docker: FauxDocker;
let c: ConsoleDeTest;
let restaurer: () => void;
let compte: number;
let distant: FauxToolhost | null = null;
let reel: HoteReel | null = null;
const manifesteAvant = process.env["APP_MCP_MANIFEST"];

/** Bac du compte : conteneur démarré, /work garni d'un dossier refusé à l'hôte (fichiers à l'UID du conteneur), P d'un fichier. */
async function bacGarni(): Promise<{ dossier: string; refuse: string }> {
  const dossier = join(tmp, "sb", "pbacfaux");
  await getUserSandbox(compte, "pbacfaux", join(dossier, WORK_SUBDIR)).ensureRunning();
  resetUserSandboxCache();
  const refuse = join(dossier, WORK_SUBDIR, "d");
  mkdirSync(refuse, { recursive: true });
  writeFileSync(join(refuse, "f"), "x");
  chmodSync(refuse, 0o500);
  writeFileSync(join(dossier, "miroir"), "y");
  return { dossier, refuse };
}

/** Manifeste mcp.json déclarant l'hôte d'outils `url`, seul hôte d'un placement `by_user`. */
function declarerHote(url: string): void {
  const manifeste = join(tmp, "mcp.json");
  writeFileSync(
    manifeste,
    JSON.stringify({
      mcpServers: {},
      sandboxHosts: { loin: { url, token: JETON } },
      placement: { strategy: "by_user" },
    }),
  );
  process.env["APP_MCP_MANIFEST"] = manifeste;
  oublierHotes();
}

/** Faux hôte d'outils déclaré dans mcp.json : distant (127.0.0.2) ou en boucle locale. */
async function hoteDistant(adresse = "127.0.0.2"): Promise<FauxToolhost> {
  distant = await new FauxToolhost().demarrer(adresse);
  declarerHote(distant.url);
  return distant;
}

/** Vrai hôte d'outils du process (faux docker) déclaré comme hôte local du compte. */
async function hoteLocal(): Promise<void> {
  reel = await demarrerHoteReel();
  declarerHote(reel.url);
}

function supprimer(): Promise<{ statusCode: number; json(): unknown }> {
  return c.app.inject({
    method: "DELETE",
    url: `/api/admin/users/${compte}?delete_sandbox=true`,
    headers: c.entetes,
  });
}

describe.each(MOTEURS)("suppression d'un compte avec son bac (%s)", (moteur) => {
  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "elpis-suppression-bac-"));
    docker = creerFauxDocker(join(tmp, "docker"));
    vi.stubEnv("PATH", `${docker.bin}:${process.env["PATH"] ?? ""}`);
    vi.stubEnv("FAUX_DOCKER", docker.etat);
    vi.stubEnv("SANDBOX_READINESS_CACHE", "0");
    vi.stubEnv("ELPIS_AUDIT_DIR", join(tmp, "audit"));
    oublierConfigurationAudit();
    writeFileSync(join(tmp, "config.json"), JSON.stringify({ executors: { network_profiles: PROFILS } }));
    restaurer = surchargerConfig({
      SANDBOX_DIR: join(tmp, "sb"),
      CONFIG_JSON_PATH: join(tmp, "config.json"),
    });
    invalidateConfigCache();
    reglagesBac.attenteCreationMs = 0;
    process.env["APP_MCP_MANIFEST"] = join(tmp, "absent.json");
    oublierHotes();
    c = await ouvrirConsole(["pbacfaux"], moteur);
    compte = c.ids.get("pbacfaux") ?? 0;
  });

  afterEach(async () => {
    await c.fermer();
    await distant?.arreter();
    distant = null;
    await reel?.arreter();
    reel = null;
    reglagesBac.attenteCreationMs = 800;
    resetUserSandboxCache();
    oublierConfigurationAudit();
    restaurer();
    vi.unstubAllEnvs();
    if (manifesteAvant === undefined) delete process.env["APP_MCP_MANIFEST"];
    else process.env["APP_MCP_MANIFEST"] = manifesteAvant;
    oublierHotes();
    const refuse = join(tmp, "sb", "pbacfaux", WORK_SUBDIR, "d");
    if (existsSync(refuse)) chmodSync(refuse, 0o700);
    rmSync(tmp, { recursive: true, force: true });
  });

  describe("suppression d'un compte avec son bac (delete_sandbox=true)", () => {
    it("bac local : conteneur retiré, /work refusé à l'hôte vidé par le root du conteneur recréé, P supprimé", async () => {
      const { dossier } = await bacGarni();
      await hoteLocal();
      const avant = docker.appels().length;
      const r = await supprimer();
      expect([r.statusCode, r.json()]).toEqual([200, { ok: true, sandbox_deleted: true }]);
      expect(existsSync(dossier)).toBe(false);
      expect(existsSync(join(docker.etat, "elpis-sb-pbacfaux.run"))).toBe(false);
      expect(
        docker
          .appels()
          .slice(avant)
          .filter((a) => /^(exec|rm) /u.test(a)),
      ).toEqual([
        "rm -fv elpis-sb-pbacfaux",
        expect.stringContaining(
          "exec -u 0:0 -e PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin -w / elpis-sb-pbacfaux sh -c chown ",
        ),
        "exec -u 0:0 -e PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin -w / elpis-sb-pbacfaux pkill -KILL -U 10001",
        "exec -u 0:0 -e PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin -w / elpis-sb-pbacfaux find /work -xdev -mindepth 1 -delete",
        "rm -fv elpis-sb-pbacfaux",
      ]);
    });

    it("bac local, /work supprimable par l'hôte : conteneur retiré quand même (processus du compte arrêtés)", async () => {
      await getUserSandbox(compte, "pbacfaux", join(tmp, "sb", "pbacfaux", WORK_SUBDIR)).ensureRunning();
      resetUserSandboxCache();
      writeFileSync(join(tmp, "sb", "pbacfaux", WORK_SUBDIR, "f"), "x");
      await hoteLocal();
      const avant = docker.appels().length;
      const r = await supprimer();
      expect([r.statusCode, r.json()]).toEqual([200, { ok: true, sandbox_deleted: true }]);
      expect(existsSync(join(tmp, "sb", "pbacfaux"))).toBe(false);
      expect(existsSync(join(docker.etat, "elpis-sb-pbacfaux.run"))).toBe(false);
      expect(
        docker
          .appels()
          .slice(avant)
          .filter((a) => /^(exec|rm) /u.test(a)),
      ).toEqual(["rm -fv elpis-sb-pbacfaux"]);
    });

    it("hôte d'outils en boucle locale : P renommé ici, conteneur retiré et /work refusé vidé par ses routes internes (même horodatage), aucun appel docker du core", async () => {
      const { dossier } = await bacGarni();
      const hote = await hoteDistant("127.0.0.1");
      const corps: unknown[] = [];
      hote.traitements.set("/api/internal/sandbox/purge-work", async (req, rep) => {
        const morceaux: Buffer[] = [];
        for await (const m of req) morceaux.push(m as Buffer);
        corps.push(JSON.parse(Buffer.concat(morceaux).toString("utf-8")));
        for (const n of readdirSync(join(tmp, "sb")).filter((m) => m.startsWith(".supprime-"))) {
          chmodSync(join(tmp, "sb", n, WORK_SUBDIR, "d"), 0o700);
          rmSync(join(tmp, "sb", n, WORK_SUBDIR), { recursive: true, force: true });
        }
        rep.writeHead(200, { "content-type": "application/json" });
        rep.end(JSON.stringify({ ok: true }));
      });
      const avant = docker.appels().length;
      const r = await supprimer();
      expect([r.statusCode, r.json()]).toEqual([200, { ok: true, sandbox_deleted: true }]);
      expect(existsSync(dossier)).toBe(false);
      expect(readdirSync(join(tmp, "sb")).filter((n) => n.startsWith(".supprime-"))).toEqual([]);
      expect(docker.appels().length).toBe(avant);
      expect(hote.requetes.map((q) => [q.methode, q.url, q.identite?.user_id, q.identite?.username])).toEqual(
        [
          ["POST", "/api/internal/sandboxes/destroy", compte, "pbacfaux"],
          ["POST", "/api/internal/account/purge", compte, "pbacfaux"],
          ["POST", "/api/internal/sandbox/purge-work", compte, "pbacfaux"],
        ],
      );
      expect(corps).toEqual([{ stamp: expect.any(Number) }]);
    });

    it("compte placé sur un autre hôte : le reliquat local est retiré par l'hôte de cette machine, jamais par l'hôte du compte", async () => {
      const { dossier } = await bacGarni();
      await hoteLocal();
      distant = await new FauxToolhost().demarrer("127.0.0.2");
      writeFileSync(
        process.env["APP_MCP_MANIFEST"] ?? "",
        JSON.stringify({
          mcpServers: {},
          sandboxHosts: {
            loin: { url: distant.url, token: JETON },
            ici: { url: reel?.url ?? "", token: JETON },
          },
          placement: { strategy: "by_user" },
        }),
      );
      oublierHotes();
      await c.t.base.run(
        "INSERT INTO sandbox_placements(user_id, host_id, created_at, updated_at) VALUES (?, 'loin', 1, 1)",
        [compte],
      );
      const r = await supprimer();
      expect([r.statusCode, r.json()]).toEqual([200, { ok: true, sandbox_deleted: true }]);
      expect(existsSync(dossier)).toBe(false);
      expect(readdirSync(join(tmp, "sb")).filter((n) => n.startsWith(".supprime-"))).toEqual([]);
      expect(existsSync(join(docker.etat, "elpis-sb-pbacfaux.run"))).toBe(false);
      expect(distant.requetes.map((q) => q.url)).toEqual([
        "/api/internal/sandbox/set-aside",
        "/api/internal/account/purge",
        "/api/internal/sandbox/discard",
      ]);
    });

    it("hôte d'outils de cette machine arrêté : suppression refusée, compte et bac intacts", async () => {
      const { dossier } = await bacGarni();
      await hoteLocal();
      await reel?.arreter();
      const r = await supprimer();
      expect(r.statusCode).toBe(502);
      expect(await c.t.base.all("SELECT id FROM users WHERE id=?", [compte])).toEqual([{ id: compte }]);
      expect(existsSync(join(dossier, "miroir"))).toBe(true);
      expect(readdirSync(join(tmp, "sb")).filter((n) => n.startsWith(".supprime-"))).toEqual([]);
    });

    it("hôte distant qui partage le disque : dossiers mis de côté supprimés par l'hôte, suppression rendue vraie", async () => {
      const hote = await hoteDistant();
      hote.traitements.set("/api/internal/sandbox/discard", (_req, rep) => {
        for (const n of readdirSync(join(tmp, "sb")).filter((m) => m.startsWith(".supprime-")))
          rmSync(join(tmp, "sb", n), { recursive: true, force: true });
        rep.writeHead(200, { "content-type": "application/json" });
        rep.end(JSON.stringify({ ok: true, deleted: true }));
      });
      mkdirSync(join(tmp, "sb", "pbacfaux"), { recursive: true });
      const r = await supprimer();
      expect([r.statusCode, r.json()]).toEqual([200, { ok: true, sandbox_deleted: true }]);
    });

    it("bac d'un hôte distant : mis de côté puis supprimé par ses routes internes (même horodatage, nom gardé du compte), identifiants de sites purgés avant la base", async () => {
      const hote = await hoteDistant();
      const corps: unknown[] = [];
      for (const chemin of ["set-aside", "discard"])
        hote.traitements.set(`/api/internal/sandbox/${chemin}`, async (req, rep) => {
          const morceaux: Buffer[] = [];
          for await (const m of req) morceaux.push(m as Buffer);
          corps.push(JSON.parse(Buffer.concat(morceaux).toString("utf-8")));
          rep.writeHead(200, { "content-type": "application/json" });
          rep.end(JSON.stringify({ ok: true, renamed: true, deleted: true }));
        });
      const r = await supprimer();
      expect([r.statusCode, r.json()]).toEqual([200, { ok: true, sandbox_deleted: true }]);
      expect(hote.requetes.map((q) => [q.methode, q.url, q.identite?.user_id, q.identite?.username])).toEqual(
        [
          ["POST", "/api/internal/sandboxes/destroy", compte, "pbacfaux"],
          ["POST", "/api/internal/sandbox/set-aside", compte, "pbacfaux"],
          ["POST", "/api/internal/account/purge", compte, "pbacfaux"],
          ["POST", "/api/internal/sandbox/discard", compte, "pbacfaux"],
        ],
      );
      expect(corps).toHaveLength(2);
      expect(corps[0]).toEqual({ stamp: expect.any(Number) });
      expect(corps[1]).toEqual(corps[0]);
      expect(await c.t.base.all("SELECT user_id FROM sandbox_placements")).toEqual([]);
    });

    it("purge des identifiants de sites en échec sur un hôte : suppression refusée avec chaque hôte nommé au journal, compte intact, bac remis en place localement et sur l'hôte", async () => {
      const hote = await hoteDistant("127.0.0.1");
      hote.traitements.set("/api/internal/account/purge", (_req, rep) => {
        rep.writeHead(404, { "content-type": "application/json" });
        rep.end(JSON.stringify({ detail: "Not Found" }));
      });
      writeFileSync(
        process.env["APP_MCP_MANIFEST"] ?? "",
        JSON.stringify({
          mcpServers: {},
          sandboxHosts: { loin: { url: hote.url, token: JETON }, nu: { url: "http://127.0.0.1:9" } },
        }),
      );
      oublierHotes();
      mkdirSync(join(tmp, "sb", "pbacfaux", "work"), { recursive: true });
      writeFileSync(join(tmp, "sb", "pbacfaux", "work", "secret.txt"), "ancien");
      const r = await supprimer();
      expect(r.statusCode).toBe(502);
      expect(JSON.stringify(r.json())).not.toContain("loin");
      expect(await c.t.base.all("SELECT id FROM users WHERE id=?", [compte])).toEqual([{ id: compte }]);
      expect(readFileSync(join(tmp, "sb", "pbacfaux", "work", "secret.txt"), "utf-8")).toBe("ancien");
      expect(readdirSync(join(tmp, "sb")).filter((n) => n.startsWith(".supprime-"))).toEqual([]);
    });

    it("hôtes déclarés sans jeton de service ou sans URL : ignorés pour la purge des identifiants de sites, suppression acceptée", async () => {
      writeFileSync(
        process.env["APP_MCP_MANIFEST"] ?? "",
        JSON.stringify({
          mcpServers: {},
          sandboxHosts: { nu: { url: "http://127.0.0.1:9" }, vide: {} },
        }),
      );
      oublierHotes();
      const r = await c.app.inject({
        method: "DELETE",
        url: `/api/admin/users/${compte}`,
        headers: c.entetes,
      });
      expect([r.statusCode, r.json()]).toEqual([200, { ok: true, sandbox_deleted: false }]);
      expect(await c.t.base.all("SELECT id FROM users WHERE id=?", [compte])).toEqual([]);
    });

    it("purge en échec avec un bac distant : l'hôte reçoit la remise en place du même horodatage", async () => {
      const hote = await hoteDistant();
      hote.traitements.set("/api/internal/account/purge", (_req, rep) => {
        rep.writeHead(502, { "content-type": "application/json" });
        rep.end(JSON.stringify({ detail: "refus" }));
      });
      const r = await supprimer();
      expect(r.statusCode).toBe(502);
      expect(hote.requetes.map((q) => q.url)).toEqual([
        "/api/internal/sandboxes/destroy",
        "/api/internal/sandbox/set-aside",
        "/api/internal/account/purge",
        "/api/internal/sandbox/restore",
      ]);
      expect(await c.t.base.all("SELECT id FROM users WHERE id=?", [compte])).toEqual([{ id: compte }]);
    });

    it("hôte distant qui refuse la suppression des dossiers mis de côté : compte supprimé, erreur rendue, rien ne reste sous le nom", async () => {
      const hote = await hoteDistant();
      hote.traitements.set("/api/internal/sandbox/discard", (_req, rep) => {
        rep.writeHead(502, { "content-type": "application/json" });
        rep.end(JSON.stringify({ detail: "/work non vidé" }));
      });
      mkdirSync(join(tmp, "sb", "pbacfaux"), { recursive: true });
      writeFileSync(join(tmp, "sb", "pbacfaux", "miroir"), "y");
      const r = await supprimer();
      expect([r.statusCode, r.json()]).toEqual([
        200,
        { ok: true, sandbox_deleted: false, sandbox_error: "hôte d'outils loin : /work non vidé" },
      ]);
      expect(existsSync(join(tmp, "sb", "pbacfaux"))).toBe(false);
    });
  });

  describe("profil réseau imposé par la console", () => {
    it("bac local : conteneur détruit tout de suite par l'hôte local (la restriction mord sans attendre la recréation)", async () => {
      await bacGarni();
      await hoteLocal();
      const r = await c.app.inject({
        method: "POST",
        url: `/api/admin/users/${compte}/network-profile`,
        headers: { ...c.entetes, "content-type": "application/json" },
        payload: JSON.stringify({ profile_id: "web" }),
      });
      expect(r.json()).toMatchObject({ ok: true, network_profile_id: "web", container_destroyed: true });
      expect(existsSync(join(docker.etat, "elpis-sb-pbacfaux.run"))).toBe(false);
    });

    it("bac d'un hôte distant : conteneur détruit par l'hôte (POST /api/internal/sandboxes/destroy)", async () => {
      const hote = await hoteDistant();
      const r = await c.app.inject({
        method: "POST",
        url: `/api/admin/users/${compte}/network-profile`,
        headers: { ...c.entetes, "content-type": "application/json" },
        payload: JSON.stringify({ profile_id: "web" }),
      });
      expect(r.json()).toMatchObject({ ok: true, container_destroyed: true });
      expect(hote.requetes.map((q) => [q.methode, q.url, q.identite?.username])).toEqual([
        ["POST", "/api/internal/sandboxes/destroy", "pbacfaux"],
      ]);
    });
  });
});
