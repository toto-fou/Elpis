// SPDX-License-Identifier: MIT
/** apps/core/test/admin/admin-executeurs.test.ts — `/api/admin` des exécuteurs et des hôtes d'outils rejoué contre le routeur admin Python (vecteurs, faux docker, faux hôtes) sur SQLite et PostgreSQL ; empreintes netcfg, images, verrou de cycle de vie, délais Docker, migration sans affectation. */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import type { ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";

import { signerSession } from "@elpis/auth";
import type { DependancesAuth, DependancesJetons } from "@elpis/auth";
import { configuredImage, DEFAUTS_DISQUE, DOMAIN_RE, netcfgHash, profilReseauDepuis } from "@elpis/bac";
import { pyJsonDumps, pyJsonLoads } from "@elpis/commun";
import { DEFAUTS_SEUILS_DISQUE } from "@elpis/contracts";
import { surchargerConfig } from "@elpis/config";
import { initialiserBase } from "@elpis/db";
import type { Base } from "@elpis/db";
import { ouvrirBaseDeTest, PG_DE_TEST } from "@elpis/db/test";
import type { BaseDeTest } from "@elpis/db/test";
import { oublierConfigurationAudit } from "@elpis/securite";
import { avecVerrou } from "@elpis/verrous";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { configAssainie, delaisDocker } from "../../src/administration/executeurs";
import { DEFAUTS_JOBS } from "../../src/jobs/reglages";
import { remplacerBase } from "../../src/base";
import { composer } from "../../src/composition";
import { creerFamilleAdminExecuteurs } from "../../src/familles/admin-executeurs";
import { oublierHotes } from "../../src/relais/hotes";
import { appTest, journalMuet, lignesAuditRecentes } from "../aides";
import { FauxServeur } from "../llm/faux-serveur";
import type { RequeteRecue } from "../llm/faux-serveur";

type Dict = Record<string, unknown>;

/** Écarts propres au TS (tâches de fond `shell_job`, seuils disque du harnais N-08) : la vue GET des exécuteurs porte les sections `jobs` et `disk`, défauts compris. */
function avecSectionJobs(
  methode: string,
  chemin: string,
  attendu: { statut: number; corps: string } | null | undefined,
): unknown {
  if (methode !== "GET" || chemin !== "/api/admin/executors" || attendu?.statut !== 200) return attendu;
  return {
    ...attendu,
    corps: attendu.corps.replace(
      '},"image":',
      `,"jobs":${JSON.stringify(DEFAUTS_JOBS)},"disk":${JSON.stringify(DEFAUTS_DISQUE)}},"image":`,
    ),
  };
}
/** [compte, méthode (ou CONFIG, DOCKER, MTIME, MCP), chemin, corps, statut TS si écart]. */
type Etape = [string, string, string, unknown, number?];

const TEXTE_V = readFileSync(new URL("../vecteurs/admin-executeurs.json", import.meta.url), "utf-8");
/** Valeurs Python relues sans perte (`1.0` reste un flottant) : entrées des fonctions pures, corps des étapes. */
const SANS_PERTE = pyJsonLoads(TEXTE_V) as { fonctions: { images: [unknown, string][] }; etapes: Etape[] };
const IMAGES = SANS_PERTE.fonctions.images;
const CORPS = SANS_PERTE.etapes.map((e) => e[3]);
const V = JSON.parse(TEXTE_V) as {
  comptes: [string, number][];
  reglages: Record<string, Dict>;
  placements: [number, string, number, number][];
  docker_factice: string;
  config_texte: string;
  hotes: Record<string, [number, string, string, string | null]>;
  etapes: Etape[];
  fonctions: { profils: [Dict, string][]; images: [unknown, string][] };
  ids: Record<string, number>;
  reponses: ({ statut: number; corps: string } | null)[];
  config_finale: string;
  appels_docker: string[];
  placements_finaux: unknown[][];
  requetes_hotes: [string, string, string, boolean][];
};

const MOTEURS = PG_DE_TEST ? (["sqlite", "postgres"] as const) : (["sqlite"] as const);
const T = 1_791_331_200;
const T0 = 1_800_000_000.5;
const SECRET = "secret-de-test";
const DELAIS_AVANT = { ...delaisDocker };
const ENV = [
  "FAUX_DOCKER",
  "PATH",
  "ELPIS_SANDBOX_IMAGE_TAR",
  "APP_MCP_MANIFEST",
  "ELPIS_AUDIT_DIR",
] as const;
const envAvant = Object.fromEntries(ENV.map((n) => [n, process.env[n]]));

afterAll(() => {
  for (const [nom, valeur] of Object.entries(envAvant)) {
    if (valeur === undefined) delete process.env[nom];
    else process.env[nom] = valeur;
  }
  oublierConfigurationAudit();
});

function cookie(uid: number): string {
  return `mcpwebui_session=${signerSession({ user_id: uid, _login_ts: T - 10 }, SECRET, T)}`;
}

describe("exécuteurs : fonctions pures (vecteurs)", () => {
  it("netcfg_hash de profils variés (relus par NetworkProfile.from_dict) et configured_image", () => {
    for (const [profil, attendu] of V.fonctions.profils)
      expect(netcfgHash(profilReseauDepuis(profil, () => undefined)), String(profil["id"])).toBe(attendu);
    for (const [valeur, attendu] of IMAGES) expect(configuredImage(valeur), String(valeur)).toBe(attendu);
  });

  it("exec_user et domaines : chiffres et lettres ASCII seulement, chaîne entière (676e766, 8f8d5c6)", () => {
    for (const u of ["10001:10001", "0:0", " 1:2 "])
      expect(() => configAssainie({ exec_user: u }, {}, []), u).not.toThrow();
    for (const u of ["\u0661\u0660:\u0661", "\uff11:\uff11", "\u00b2:0", "1:2:3", "1:2 x"])
      expect(() => configAssainie({ exec_user: u }, {}, []), u).toThrow(/UID:GID/u);
    expect(["kelvin.fr", "Exemple.FR"].map((d) => DOMAIN_RE.test(d))).toEqual([true, true]);
    expect(["\u212aelvin.fr", "exemple.fr\n", "\u0131stanbul.tr"].map((d) => DOMAIN_RE.test(d))).toEqual([
      false,
      false,
      false,
    ]);
  });
});

describe("exécuteurs : seuils disque (harnais N-08, propres au TS)", () => {
  it("section disk validée (bornes, alerte sous le refus), gardée quand le POST n'en porte pas, absente sinon", () => {
    expect(DEFAUTS_SEUILS_DISQUE).toEqual(DEFAUTS_DISQUE);
    expect(configAssainie({ disk: { warn_pct: 50, refuse_pct: 60 } }, {}, [])["disk"]).toEqual({
      warn_pct: 50,
      refuse_pct: 60,
    });
    expect(configAssainie({ disk: {} }, {}, [])["disk"]).toEqual(DEFAUTS_DISQUE);
    for (const disk of [{ warn_pct: 9 }, { refuse_pct: 101 }, { warn_pct: 90, refuse_pct: 80 }, "x"])
      expect(() => configAssainie({ disk }, {}, []), JSON.stringify(disk)).toThrow(/disk/u);
    expect(configAssainie({}, { disk: { warn_pct: 70, refuse_pct: 90 } }, [])["disk"]).toEqual({
      warn_pct: 70,
      refuse_pct: 90,
    });
    expect(configAssainie({}, {}, [])).not.toHaveProperty("disk");
  });
});

describe.each(MOTEURS)("famille /api/admin des exécuteurs et hôtes d'outils (%s)", (moteur) => {
  let t: BaseDeTest;
  let app: FastifyInstance;
  let hotes: FauxServeur;
  let d: string;
  let restaurer: () => void;
  let miroirs: number[];

  async function monter(mode: "main" | "admin"): Promise<FastifyInstance> {
    const dep: DependancesAuth & DependancesJetons = {
      base: t.base,
      config: () => ({}),
      attributsCookie: () => ({
        cookie_name: "mcpwebui_session",
        same_site: "lax",
        https_only: false,
        max_age: 86400,
      }),
      secret: () => SECRET,
      jetonService: () => "",
      maintenant: () => T,
    };
    const c = await composer(mode, t.base, journalMuet, dep, d);
    const familles = c.familles.map((f) =>
      f.nom === "admin-executeurs"
        ? creerFamilleAdminExecuteurs({
            base: t.base,
            journal: journalMuet,
            synchroniserMiroir: async (uid) => void miroirs.push(uid),
          })
        : f,
    );
    return appTest({ ...c, mode, familles });
  }

  function appel(uid: number, method: string, url: string, corps?: unknown): Promise<LightMyRequestResponse> {
    const entetes: Record<string, string> = { cookie: cookie(uid) };
    let payload: Buffer | undefined;
    if (typeof corps === "string" && corps.startsWith("<<"))
      payload = Buffer.from(corps.slice(2, -2), "utf8");
    else if (corps !== undefined && corps !== null)
      payload = Buffer.from(pyJsonDumps(corps, { ensureAscii: false }), "utf8");
    if (payload !== undefined) entetes["content-type"] = "application/json";
    return app.inject({ method: method as "GET", url, headers: entetes, ...(payload ? { payload } : {}) });
  }

  /** Préparations rejouées comme le script Python : config.json, état du faux docker, dates d'activité, manifeste. */
  function preparer(methode: string, corps: unknown): void {
    if (methode === "CONFIG")
      writeFileSync(path.join(d, "config.json"), pyJsonDumps(corps, { ensureAscii: false, indent: 2 }));
    else if (methode === "DOCKER") {
      for (const [fichier, contenu] of Object.entries(corps as Record<string, string | null>)) {
        const p = path.join(d, "docker", fichier);
        if (contenu === null) {
          if (existsSync(p)) unlinkSync(p);
        } else if (contenu.startsWith("hex:")) writeFileSync(p, Buffer.from(contenu.slice(4), "hex"));
        else writeFileSync(p, contenu, "utf8");
      }
    } else if (methode === "MTIME") {
      const dates = Object.entries(corps as Record<string, number>);
      for (const [rel] of dates) {
        const p = path.join(d, "sb", rel);
        if (rel.endsWith(".log")) {
          mkdirSync(path.dirname(p), { recursive: true });
          writeFileSync(p, "x");
        } else mkdirSync(p, { recursive: true });
      }
      for (const [rel, date] of [...dates].sort((a, b) => b[0].length - a[0].length))
        utimesSync(path.join(d, "sb", rel), date, date);
    } else if (methode === "MCP")
      writeFileSync(path.join(d, "mcp.json"), JSON.stringify(corps).replaceAll("{h}", hotes.url));
  }

  async function peupler(base: Base): Promise<void> {
    for (const [nom, admin] of V.comptes)
      await base.run(
        "INSERT INTO users(username, pass_salt, pass_hash, created_at, is_admin) VALUES (?, 's', 'h', 0, ?)",
        [nom, admin],
      );
    for (const [nom, reglages] of Object.entries(V.reglages))
      await base.run("UPDATE users SET settings_json=? WHERE id=?", [
        JSON.stringify(reglages),
        V.ids[nom] ?? 0,
      ]);
    for (const ligne of V.placements)
      await base.run(
        "INSERT INTO sandbox_placements(user_id, host_id, created_at, updated_at) VALUES(?,?,?,?)",
        ligne,
      );
  }

  function repondreHote(req: RequeteRecue, rep: ServerResponse): void {
    const [, , , jeton] = V.hotes[`${req.methode} ${req.url.pathname}`] ?? [404, "", "", null];
    let [statut, type, corps] = V.hotes[`${req.methode} ${req.url.pathname}`] ?? [
      404,
      "text/plain",
      "absent",
    ];
    if (jeton && req.entetes["authorization"] !== `Bearer ${jeton}`)
      [statut, type, corps] = [401, "text/plain", "jeton"];
    rep.writeHead(statut, { "content-type": type });
    rep.end(corps);
  }

  beforeEach(async () => {
    d = mkdtempSync(path.join(tmpdir(), "elpis-admin-executeurs-"));
    for (const sous of ["docker", "bin", "sb"]) mkdirSync(path.join(d, sous));
    writeFileSync(path.join(d, "config.json"), V.config_texte);
    writeFileSync(path.join(d, "bin", "docker"), V.docker_factice);
    chmodSync(path.join(d, "bin", "docker"), 0o755);
    writeFileSync(path.join(d, "archive.tar.gz"), "x");
    process.env["FAUX_DOCKER"] = path.join(d, "docker");
    process.env["PATH"] = `${path.join(d, "bin")}${path.delimiter}${envAvant["PATH"] ?? ""}`;
    process.env["ELPIS_SANDBOX_IMAGE_TAR"] = path.join(d, "archive.tar.gz");
    process.env["APP_MCP_MANIFEST"] = path.join(d, "mcp.json");
    process.env["ELPIS_AUDIT_DIR"] = path.join(d, "audit");
    oublierConfigurationAudit();
    oublierHotes();
    restaurer = surchargerConfig({
      CONFIG_JSON_PATH: path.join(d, "config.json"),
      SANDBOX_DIR: path.join(d, "sb"),
    });
    t = ouvrirBaseDeTest(moteur);
    await initialiserBase(t.base);
    await peupler(t.base);
    remplacerBase(t.base);
    hotes = await FauxServeur.demarrer({ "*": repondreHote });
    miroirs = [];
    app = await monter("admin");
  });

  afterEach(async () => {
    vi.useRealTimers();
    Object.assign(delaisDocker, DELAIS_AVANT);
    await app.close();
    restaurer();
    remplacerBase(undefined);
    oublierHotes();
    await hotes.arreter();
    await t.fermer();
    rmSync(d, { recursive: true, force: true });
  });

  it("inventaire : 11 routes du process admin sous la garde admin, rien dans main ; anonyme = 401", async () => {
    const inventaire = JSON.parse(
      readFileSync(new URL("../../../../migration-kit/routes.inventory.json", import.meta.url), "utf-8"),
    ) as { routes: { methodes: string[]; chemin: string; process: string[]; module: string }[] };
    const attendues = inventaire.routes.filter((r) =>
      ["shared_infra/routes/admin/executors.py", "shared_infra/routes/admin/toolhosts.py"].includes(r.module),
    );
    expect(attendues).toHaveLength(11);
    const montees = app.elpis.routes.filter((r) => r.famille === "admin-executeurs");
    expect(montees).toHaveLength(11);
    for (const r of attendues) {
      const chemin = r.chemin.replace("{user_id}", ":user_id");
      const m = montees.find((x) => x.chemin === chemin && x.methodes[0] === r.methodes[0]);
      expect([m?.acces, r.process], `${r.methodes[0]} ${r.chemin}`).toEqual(["admin", ["admin"]]);
      const url = r.chemin.replace("{user_id}", "abc");
      const rep = await app.inject({
        method: r.methodes[0] as "GET",
        url,
        ...(r.methodes[0] === "GET" ? {} : { payload: {} }),
      });
      expect([rep.statusCode, rep.json()], `${r.methodes[0]} ${url}`).toEqual([
        401,
        { detail: "not logged in" },
      ]);
    }
    const main = await monter("main");
    expect(main.elpis.routes.filter((r) => r.famille === "admin-executeurs")).toEqual([]);
    await main.close();
  });

  it("rejoue les étapes et rend les mêmes réponses, au texte près (vecteurs) ; docker, hôtes et base dans le même état", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    for (const [i, [nom, methode, chemin, , statutTs]] of V.etapes.entries()) {
      const corps = CORPS[i];
      vi.setSystemTime(Math.round((T0 + 10 * i) * 1000));
      if (["CONFIG", "DOCKER", "MTIME", "MCP"].includes(methode)) {
        preparer(methode, corps);
        continue;
      }
      const r = await appel(V.ids[nom] ?? 0, methode, chemin, corps);
      if (statutTs !== undefined && statutTs !== null) {
        expect(r.statusCode, `étape ${i} (écart) : ${methode} ${chemin}`).toBe(statutTs);
        continue;
      }
      expect(
        { statut: r.statusCode, corps: r.body.replaceAll(hotes.url, "{h}").replaceAll(d, "<R>") },
        `étape ${i} : ${methode} ${chemin}`,
      ).toEqual(avecSectionJobs(methode, chemin, V.reponses[i]));
      for (const jeton of ["jeton-a", "jeton-b"]) expect(r.body).not.toContain(jeton);
    }
    const audit = lignesAuditRecentes({ limit: 200, actionPrefix: "admin." }).map((l) => pyJsonDumps(l));
    vi.useRealTimers();
    expect(readFileSync(path.join(d, "config.json"), "utf-8")).toBe(V.config_finale);
    const appels = readFileSync(path.join(d, "docker", "appels.log"), "utf-8")
      .split("\n")
      .filter((l) => l);
    expect(appels).toEqual(V.appels_docker);
    expect(
      await t.base.valeurs(
        "SELECT user_id, host_id, created_at, updated_at FROM sandbox_placements ORDER BY user_id",
      ),
    ).toEqual(V.placements_finaux);
    const recues = hotes.requetes
      .map((q) => [
        q.methode,
        q.url.pathname,
        q.entetes["authorization"] ?? "",
        Boolean(q.entetes["x-elpis-identity"]),
      ])
      .sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1));
    expect(recues).toEqual(V.requetes_hotes);
    expect(miroirs).toEqual([4]);
    expect(
      audit.some((l) => l.includes('"admin.sandbox.stop"') && l.includes('"target_username": "Jean.Dupont"')),
    ).toBe(true);
    expect(
      audit.some(
        (l) =>
          l.includes('"admin.toolhosts.migrate"') &&
          l.includes(
            '"details": {"bytes": 9, "files": 7, "from": "a", "moved": true, "to": "b", "user_id": 4}',
          ),
      ),
    ).toBe(true);
    for (const jeton of ["jeton-a", "jeton-b"]) expect(audit.join("\n")).not.toContain(jeton);
  });

  it("migration d'un compte sans affectation : export depuis l'hôte par défaut du placement (pas de bac à sable local en TS)", async () => {
    preparer("MCP", {
      sandboxHosts: {
        b: { url: "{h}/b", token: "jeton-b", relay: true },
        a: { url: "{h}/a", token: "jeton-a", relay: true },
      },
      placement: { strategy: "by_user", host: "a" },
    });
    const r = await appel(1, "POST", "/api/admin/toolhosts/placements/4/migrate", { host_id: "b" });
    expect([r.statusCode, r.json()]).toEqual([
      200,
      { ok: true, moved: true, from: null, to: "b", files: 7, bytes: 9 },
    ]);
    expect(hotes.requetes.map((q) => `${q.methode} ${q.url.pathname}`)).toEqual([
      "GET /a/api/sandbox/export",
      "POST /b/api/sandbox/import",
    ]);
    expect(String(hotes.requetes[1]?.entetes["content-type"])).toMatch(/^multipart\/form-data; boundary=/u);
    expect(hotes.requetes[1]?.corps).toContain('name="archive"; filename="work.tar.gz"');
  });

  it("config.json illisible : enregistrement refusé (500) et fichier intact, au lieu de repartir de {} comme le Python", async () => {
    const chemin = path.join(d, "config.json");
    for (const brut of ['{"executors": {', Buffer.from([0x7b, 0xff, 0x7d])]) {
      writeFileSync(chemin, brut);
      const r = await appel(1, "POST", "/api/admin/executors", { executors: { exec_user: "1000:1000" } });
      expect([r.statusCode, r.json()]).toEqual([
        500,
        { detail: "config.json est illisible : corrigez-le avant d'enregistrer." },
      ]);
      expect(readFileSync(chemin)).toEqual(Buffer.from(brut));
    }
  });

  it("arrêt d'un conteneur : la commande attend le verrou de cycle de vie partagé avec l'hôte d'outils", async () => {
    mkdirSync(path.join(d, "sb", ".lifecycle_locks"), { recursive: true });
    let libere = false;
    const tenu = avecVerrou(path.join(d, "sb", ".lifecycle_locks", "u3.lock"), {}, async () => {
      await new Promise((ok) => setTimeout(ok, 300));
      libere = true;
    });
    await new Promise((ok) => setTimeout(ok, 50));
    const r = await appel(1, "POST", "/api/admin/sandbox/containers/3/stop");
    expect([r.statusCode, libere]).toEqual([200, true]);
    await tenu;
    expect(readFileSync(path.join(d, "docker", "appels.log"), "utf-8")).toBe("stop -t 5 elpis-sb-bob\n");
    expect(existsSync(path.join(d, "sb", ".lifecycle_locks", "u3.lock"))).toBe(false);
  });

  it("délais Docker : démon muet = daemon_ok faux et processus tué, `docker ps` muet = 502", async () => {
    Object.assign(delaisDocker, { version: 200, ps: 200 });
    preparer("DOCKER", { "version.dort": "5", "ps-a.dort": "5" });
    const debut = performance.now();
    const sante = await appel(1, "GET", "/api/admin/executors/healthcheck");
    expect([sante.statusCode, sante.json()]).toEqual([
      200,
      {
        daemon_ok: false,
        error: "Timeout — le daemon Docker ne répond pas",
        hint: "Vérifie : sudo systemctl status docker",
      },
    ]);
    const liste = await appel(1, "GET", "/api/admin/sandbox/containers");
    expect([liste.statusCode, liste.json()]).toEqual([502, { detail: "docker ps timeout" }]);
    expect(performance.now() - debut).toBeLessThan(4_000);
  });
});
