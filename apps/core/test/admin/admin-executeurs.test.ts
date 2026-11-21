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
import type * as Dns from "node:dns/promises";
import type { ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";

import { signerSession } from "@elpis/auth";
import type { DependancesAuth, DependancesJetons } from "@elpis/auth";
import {
  configuredImage,
  DEFAUTS_DISQUE,
  DOMAIN_RE,
  etiquetteNetcfg,
  netcfgHash,
  plagesRefusees,
  profilReseauDepuis,
  RUN_SPEC,
} from "@elpis/bac";
import { adresseIpOuNul, pyJsonDumps, pyJsonLoads } from "@elpis/commun";
import type { AdresseIp } from "@elpis/commun";
import { DEFAUTS_SEUILS_DISQUE } from "@elpis/contracts";
import { invalidateConfigCache, surchargerConfig } from "@elpis/config";
import { initialiserBase } from "@elpis/db";
import type { Base } from "@elpis/db";
import { ouvrirBaseDeTest, PG_DE_TEST } from "@elpis/db/test";
import type { BaseDeTest } from "@elpis/db/test";
import { oublierConfigurationAudit } from "@elpis/securite";
import type { HoteMachine } from "@elpis/securite";
import { avecVerrou } from "@elpis/verrous";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  conteneursPerimes,
  configAssainie,
  delaisDocker,
  oublierEtatDomaines,
  profilsAssainis,
  vueExecuteurs,
} from "../../src/administration/executeurs";
import { DEFAUTS_JOBS } from "../../src/jobs/reglages";
import { remplacerBase } from "../../src/base";
import { composer } from "../../src/composition";
import { creerFamilleAdminExecuteurs } from "../../src/familles/admin-executeurs";
import { oublierHotes } from "../../src/relais/hotes";
import { appTest, journalMuet, lignesAuditRecentes } from "../aides";
import { FauxServeur } from "../llm/faux-serveur";
import type { RequeteRecue } from "../llm/faux-serveur";

type Dict = Record<string, unknown>;

/** Noms résolus par le test (documentation IPv4) ; les autres passent par le vrai résolveur. */
const noms = vi.hoisted(() => ({ table: {} as Record<string, string[]> }));
vi.mock("node:dns/promises", async (original) => {
  const reel = await original<typeof Dns>();
  return {
    ...reel,
    lookup: (nom: string, ...reste: unknown[]) =>
      nom in noms.table
        ? Promise.resolve(noms.table[nom]?.map((address) => ({ address, family: 4 })))
        : (reel.lookup as (...a: unknown[]) => unknown)(nom, ...reste),
  };
});

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
      `,"allow_sudo":true,"jobs":${JSON.stringify(DEFAUTS_JOBS)},"disk":${JSON.stringify(DEFAUTS_DISQUE)}},"image":`,
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

describe("exécuteurs : profils réseau, IPv4 seulement et forme canonique", () => {
  it("un profil enregistré avec 10.0.0.7/24 est stocké 10.0.0.0/24 ; /32 sans préfixe ; résolveur rogné", () => {
    const avertis: string[] = [];
    const [p] = profilsAssainis(
      {
        network_profiles: [
          {
            id: "web",
            name: "Web",
            mode: "allowlist_ip",
            ips: ["10.0.0.7/24", " 1.2.3.4/32 ", "192.168.1.1"],
            dns: [" 9.9.9.9 "],
          },
        ],
      },
      avertis,
    );
    expect([p?.["ips"], p?.["dns"]]).toEqual([["10.0.0.0/24", "1.2.3.4", "192.168.1.1"], ["9.9.9.9"]]);
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
  /** Relevé de la machine servi à la famille : boucle, adresses de documentation, IPv6 et diffusions. */
  let releve: () => Promise<HoteMachine>;

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
            machine: () => releve(),
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
        else writeFileSync(p, contenu.replaceAll("{spec}", RUN_SPEC), "utf8");
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
    const ip = (texte: string): AdresseIp => {
      const a = adresseIpOuNul(texte);
      if (a === null) throw new Error(texte);
      return a;
    };
    releve = () =>
      Promise.resolve({
        adresses: ["127.0.0.1", "198.51.100.7", "192.0.2.10", "::1"].map(ip),
        reseaux: [],
        diffusions: ["127.255.255.255", "192.0.2.255"].map(ip),
      });
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

  it("inventaire : 11 routes du process admin (plus l'état des exécuteurs, propre au TS) sous la garde admin, rien dans main ; anonyme = 401", async () => {
    const inventaire = JSON.parse(
      readFileSync(new URL("../../../../migration-kit/routes.inventory.json", import.meta.url), "utf-8"),
    ) as { routes: { methodes: string[]; chemin: string; process: string[]; module: string }[] };
    const attendues = inventaire.routes.filter((r) =>
      ["shared_infra/routes/admin/executors.py", "shared_infra/routes/admin/toolhosts.py"].includes(r.module),
    );
    expect(attendues).toHaveLength(11);
    const montees = app.elpis.routes.filter((r) => r.famille === "admin-executeurs");
    expect(montees).toHaveLength(12);
    const etat = montees.find((x) => x.chemin === "/api/admin/executors/status");
    expect([etat?.methodes, etat?.acces]).toEqual([["GET"], "admin"]);
    expect((await app.inject({ method: "GET", url: "/api/admin/executors/status" })).statusCode).toBe(401);
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

  it("allow_sudo : booléen seulement (400 sinon), root refusé quand sudo l'est, valeur enregistrée rendue", async () => {
    for (const valeur of ["false", 0, null, []]) {
      const r = await appel(1, "POST", "/api/admin/executors", { executors: { allow_sudo: valeur } });
      expect([r.statusCode, r.json()], JSON.stringify(valeur)).toEqual([
        400,
        { detail: "allow_sudo doit valoir true ou false" },
      ]);
    }
    const root = await appel(1, "POST", "/api/admin/executors", {
      executors: { allow_sudo: false, exec_user: "0:0" },
    });
    expect([root.statusCode, root.json()]).toEqual([
      400,
      { detail: "exec_user root refusé : sudo n'est pas permis dans les sandboxes" },
    ]);
    const ok = await appel(1, "POST", "/api/admin/executors", { executors: { allow_sudo: false } });
    expect(ok.statusCode).toBe(200);
    expect((ok.json() as { config: Dict }).config["allow_sudo"]).toBe(false);
    const lu = await appel(1, "GET", "/api/admin/executors");
    expect(((lu.json() as { config: Dict }).config as Dict)["allow_sudo"]).toBe(false);
    expect(JSON.parse(readFileSync(path.join(d, "config.json"), "utf-8")).executors.allow_sudo).toBe(false);
  });

  it("extra_run_args : options hors liste et montage dont la source manque refusés (400) avec leur motif, sans valeur de variable ; permises enregistrées", async () => {
    const poster = (extra: unknown[]): Promise<LightMyRequestResponse> =>
      appel(1, "POST", "/api/admin/executors", { executors: { extra_run_args: extra } });
    const refus = await poster(["--cap-add=NET_ADMIN", "--env", "LD_PRELOAD=/secret.so", "--shm-size=1g"]);
    expect([refus.statusCode, refus.json()]).toEqual([
      400,
      {
        detail:
          "extra_run_args refusé : --cap-add NET_ADMIN (option non permise), --env LD_PRELOAD (variable réservée ou mal formée)",
      },
    ]);
    expect(refus.body).not.toContain("secret.so");
    const trop = await poster(Array.from({ length: 33 }, () => "--shm-size=1g"));
    expect([trop.statusCode, trop.json()]).toEqual([
      400,
      { detail: "extra_run_args : trop d'arguments (max 32)" },
    ]);
    const montage = await poster(["--volume", "/data/absent-elpis-42:/mnt/x:ro"]);
    expect([montage.statusCode, montage.json()]).toEqual([
      400,
      {
        detail:
          "extra_run_args : montage refusé : /data/absent-elpis-42 → /mnt/x (source absente, illisible ou sans réponse)",
      },
    ]);
    const ok = await poster(["--shm-size", "2g", "-e", "A=1", "--ulimit", "nofile=4096:8192"]);
    expect(ok.statusCode).toBe(200);
    expect((ok.json() as { config: Dict }).config["extra_run_args"]).toEqual([
      "--shm-size",
      "2g",
      "-e",
      "A=1",
      "--ulimit",
      "nofile=4096:8192",
    ]);
  });

  it("règle Git d'un profil : enregistrée, relue ; git_servers qui n'est pas une liste : 400", async () => {
    const poster = (profil: Dict): Promise<LightMyRequestResponse> =>
      appel(1, "POST", "/api/admin/executors", {
        executors: {
          extra_run_args: [],
          network_profiles: [{ id: "gitp", name: "G", mode: "none", ...profil }],
        },
      });
    const refus = await poster({ git_access: "servers", git_servers: "git.lan" });
    expect([refus.statusCode, refus.json()]).toEqual([
      400,
      { detail: "Profil 'gitp' : git_servers doit être une liste" },
    ]);
    const ok = await poster({
      git_access: "servers",
      git_servers: ["Git.LAN:3000", "https://github.com/Acme.git"],
    });
    expect(ok.statusCode, ok.body).toBe(200);
    const lu = (await appel(1, "GET", "/api/admin/executors")).json() as {
      config: { network_profiles: Dict[] };
    };
    const p = lu.config.network_profiles.find((x) => x["id"] === "gitp");
    expect([p?.["git_access"], p?.["git_servers"]]).toEqual(["servers", ["git.lan:3000", "github.com/Acme"]]);
  });

  it("vue des exécuteurs : allow_sudo vrai seulement pour true, un autre type est rendu faux", () => {
    const vue = (executors: Dict): unknown => (vueExecuteurs({ executors })["config"] as Dict)["allow_sudo"];
    expect(
      [{}, { allow_sudo: true }, { allow_sudo: false }, { allow_sudo: "true" }, { allow_sudo: 1 }].map(vue),
    ).toEqual([true, true, false, false, false]);
  });

  describe("conteneurs périmés selon allow_sudo", () => {
    const profils: Dict[] = [
      { id: "isolated", name: "Isolé", mode: "none" },
      { id: "web", name: "Web", mode: "allowlist_ip", ips: ["192.0.2.0/24"] },
    ];
    const hashWeb = (): string => netcfgHash(profilReseauDepuis(profils[1] as Dict));
    const perimes = async (sudo: boolean, lignes: string[]): Promise<string[]> => {
      preparer("DOCKER", { "ps-netcfg.out": `${lignes.join("\n")}\n` });
      const r = await conteneursPerimes(
        profils,
        async (uid) => ({ profil: uid === 2 ? "web" : "isolated" }),
        (reglages) => String(reglages["profil"]),
        sudo,
      );
      return r.map((c) => String(c["container"]));
    };

    it("sudo permis : à jour s'il est non durci (profil sans filtre) ; périmé s'il est durci ou d'une autre version", async () => {
      expect(
        await perimes(true, [
          `elpis-sb-a\t1\ta\t\t${RUN_SPEC}\t0`,
          `elpis-sb-b\t2\tb\t${hashWeb()}\t${RUN_SPEC}\t1`,
          `elpis-sb-c\t1\tc\t\t${RUN_SPEC}\t1`,
          `elpis-sb-d\t1\td\t\t1\t0`,
          `elpis-sb-e\t1\te\t\t${RUN_SPEC}\t`,
        ]),
      ).toEqual(["elpis-sb-c", "elpis-sb-d", "elpis-sb-e"]);
    });

    it("sudo refusé : tout conteneur non durci est périmé, un durci à jour ne l'est pas", async () => {
      expect(
        await perimes(false, [
          `elpis-sb-a\t1\ta\t\t${RUN_SPEC}\t0`,
          `elpis-sb-b\t2\tb\t${hashWeb()}\t${RUN_SPEC}\t1`,
          `elpis-sb-c\t1\tc\t\t${RUN_SPEC}\t1`,
        ]),
      ).toEqual(["elpis-sb-a"]);
    });
  });

  describe("conteneurs périmés selon les protections et les domaines", () => {
    const profils: Dict[] = [
      { id: "isolated", name: "Isolé", mode: "none" },
      { id: "web", name: "Web", mode: "allowlist_ip", ips: ["192.0.2.0/24"], domains: ["a.example"] },
      { id: "garde", name: "Gardé", mode: "bridge", block_metadata: true, block_lan: true },
      { id: "libre", name: "Libre", mode: "bridge" },
    ];
    const profil = (id: string) => profilReseauDepuis(profils.find((p) => p["id"] === id) as Dict);
    const chez: Record<number, string> = { 1: "web", 2: "garde", 3: "libre" };
    const perimesDe = async (
      lignes: string[],
      domaines: Record<string, Record<string, string[] | null>> = {},
      sudo = true,
    ): Promise<string[]> => {
      preparer("DOCKER", { "ps-netcfg.out": `${lignes.join("\n")}\n` });
      const r = await conteneursPerimes(
        profils,
        async (uid) => ({ profil: chez[uid] ?? "isolated" }),
        (reglages) => String(reglages["profil"]),
        sudo,
        domaines,
      );
      return r.map((c) => String(c["container"]));
    };
    const protege = async (): Promise<string> =>
      etiquetteNetcfg(profil("garde"), await plagesRefusees(["metadata", "lan"]));
    const web = (resolu: string, durci = "1"): string =>
      `elpis-sb-web\t1\tw\t${netcfgHash(profil("web"))}\t${RUN_SPEC}\t${durci}\t${resolu}`;

    it("profil ouvert protégé : à jour avec l'empreinte du profil suivie de celle de ses plages (la sandbox relit la machine) ; périmé avec l'empreinte seule, sans étiquette ou non durci", async () => {
      expect(
        await perimesDe([
          `elpis-sb-g\t2\tg\t${await protege()}\t${RUN_SPEC}\t1\t`,
          `elpis-sb-autre\t2\tb\t${netcfgHash(profil("garde"))}-000000000000\t${RUN_SPEC}\t1\t`,
        ]),
      ).toEqual([]);
      expect(
        await perimesDe([
          `elpis-sb-ancien\t2\ta\t${netcfgHash(profil("garde"))}\t${RUN_SPEC}\t1\t`,
          `elpis-sb-vide\t2\tc\t\t${RUN_SPEC}\t1\t`,
          `elpis-sb-clair\t2\td\t${await protege()}\t${RUN_SPEC}\t0\t`,
        ]),
      ).toEqual(["elpis-sb-ancien", "elpis-sb-vide", "elpis-sb-clair"]);
    });

    it("profil ouvert sans protection : étiquette absente ou égale à l'empreinte, à jour ; non durci", async () => {
      expect(
        await perimesDe([
          `elpis-sb-l1\t3\tl\t\t${RUN_SPEC}\t0\t`,
          `elpis-sb-l2\t3\tl\t${netcfgHash(profil("libre"))}\t${RUN_SPEC}\t0\t`,
        ]),
      ).toEqual([]);
    });

    it("domaines : à jour si une adresse épinglée est encore rendue, périmé sinon ou si le domaine n'était pas épinglé", async () => {
      const epingle = '{"a.example":["198.51.100.1"]}';
      const cas = async (resolu: string, actuels: string[] | null | undefined): Promise<string[]> =>
        perimesDe([web(resolu)], actuels === undefined ? {} : { web: { "a.example": actuels } });
      expect(await cas(epingle, ["198.51.100.1", "198.51.100.2"])).toEqual([]);
      expect(await cas(epingle, ["198.51.100.9"])).toEqual(["elpis-sb-web"]);
      expect(await cas(epingle, null)).toEqual([]);
      expect(await cas(epingle, [])).toEqual([]);
      expect(await cas(epingle, undefined)).toEqual([]);
      expect(await cas("{}", ["198.51.100.9"])).toEqual(["elpis-sb-web"]);
      expect(await cas("", ["198.51.100.9"])).toEqual(["elpis-sb-web"]);
      expect(await cas("<no value>", ["198.51.100.9"])).toEqual(["elpis-sb-web"]);
      expect(await cas("{}", [])).toEqual([]);
    });

    it("l'état des domaines d'un autre profil, ou d'un profil non filtré, est sans effet", async () => {
      expect(
        await perimesDe([web('{"a.example":["198.51.100.1"]}'), `elpis-sb-l\t3\tl\t\t${RUN_SPEC}\t0\t`], {
          libre: { "a.example": ["198.51.100.9"] },
          autre: { "a.example": ["198.51.100.9"] },
        }),
      ).toEqual([]);
    });
  });

  describe("GET /api/admin/executors/status", () => {
    const etat = async (): Promise<{ statut: number; corps: Dict }> => {
      const r = await appel(1, "GET", "/api/admin/executors/status");
      return { statut: r.statusCode, corps: r.json() as Dict };
    };
    const ecrire = (cfg: unknown): void => {
      writeFileSync(path.join(d, "config.json"), JSON.stringify(cfg));
      invalidateConfigCache();
    };
    const config = (): void =>
      ecrire({
        executors: {
          network_profiles: [
            { id: "isolated", name: "Isolé", mode: "none" },
            { id: "web", name: "Web", mode: "allowlist_ip", ips: ["192.0.2.0/24"], domains: ["web.example"] },
          ],
        },
      });
    const hashWeb = (): string =>
      netcfgHash(
        profilReseauDepuis({
          id: "web",
          name: "Web",
          mode: "allowlist_ip",
          ips: ["192.0.2.0/24"],
          domains: ["web.example"],
        }),
      );

    beforeEach(() => {
      noms.table = { "web.example": ["198.51.100.1"] };
    });
    afterEach(() => {
      noms.table = {};
      oublierEtatDomaines();
    });

    it("adresses du moment des domaines et conteneurs à recréer ; vide sans conteneur", async () => {
      config();
      preparer("DOCKER", { "ps-netcfg.out": "" });
      const r = await etat();
      expect(r.statut).toBe(200);
      expect([r.corps["ok"], r.corps["domains_status"], r.corps["stale_containers"]]).toEqual([
        true,
        { web: { "web.example": ["198.51.100.1"] } },
        [],
      ]);
      expect(Object.keys(r.corps).sort()).toEqual([
        "accounts",
        "domains_status",
        "machine",
        "ok",
        "remote_toolhosts",
        "stale_containers",
      ]);
    });

    it("conteneur dont les adresses épinglées ne sont plus rendues : listé ; encore rendues : absent", async () => {
      config();
      const ligne = (resolu: string): string =>
        `elpis-sb-bob\t3\tbob\t${hashWeb()}\t${RUN_SPEC}\t1\t${resolu}`;
      preparer("DOCKER", { "ps-netcfg.out": `${ligne('{"web.example":["10.9.9.9"]}')}\n` });
      expect((await etat()).corps["stale_containers"]).toEqual([
        { user_id: 3, username: "bob", container: "elpis-sb-bob", profile_id: "web" },
      ]);
      preparer("DOCKER", { "ps-netcfg.out": `${ligne('{"web.example":["198.51.100.1"]}')}\n` });
      expect((await etat()).corps["stale_containers"]).toEqual([]);
    });

    it("sudo refusé dans la config : les conteneurs non durcis sont listés aussi", async () => {
      writeFileSync(
        path.join(d, "config.json"),
        JSON.stringify({
          executors: { allow_sudo: false, network_profiles: [{ id: "isolated", name: "I", mode: "none" }] },
        }),
      );
      preparer("DOCKER", { "ps-netcfg.out": `elpis-sb-bob\t3\tbob\t\t${RUN_SPEC}\t0\t\n` });
      const r = await etat();
      expect(r.corps["domains_status"]).toEqual({});
      expect((r.corps["stale_containers"] as Dict[]).map((c) => c["container"])).toEqual(["elpis-sb-bob"]);
    });

    it("relevé de la machine : IPv4 hors boucle, triées ; relevé en échec : null", async () => {
      config();
      preparer("DOCKER", { "ps-netcfg.out": "" });
      expect((await etat()).corps["machine"]).toEqual({
        addresses: ["192.0.2.10", "198.51.100.7"],
        broadcasts: ["192.0.2.255"],
      });
      releve = () => Promise.reject(new Error("interfaces illisibles"));
      const r = await etat();
      expect([r.statut, r.corps["machine"]]).toEqual([200, null]);
    });

    it("hôtes d'outils : distant s'il n'est ni en boucle locale ni sur une adresse relevée de la machine", async () => {
      config();
      preparer("DOCKER", { "ps-netcfg.out": "" });
      expect((await etat()).corps["remote_toolhosts"]).toBe(false);
      const declarer = (hotesOutils: Dict): void => {
        preparer("MCP", { toolHosts: hotesOutils, mcpServers: {} });
        oublierHotes();
      };
      declarer({ main: { url: "{h}" }, voisin: { url: "http://192.0.2.10:8765" } });
      expect((await etat()).corps["remote_toolhosts"]).toBe(false);
      declarer({ main: { url: "http://localhost:8765" }, autre: { url: "http://198.51.100.20:8765" } });
      expect((await etat()).corps["remote_toolhosts"]).toBe(true);
    });

    it("réservé à l'administrateur", async () => {
      const r = await appel(2, "GET", "/api/admin/executors/status");
      expect(r.statusCode).toBe(403);
    });
  });
});
