// SPDX-License-Identifier: MIT
/** apps/core/test/bureau/routes-bureau.test.ts — /api/desktop/*, /agent, /agent.ps1 rejouées contre la vraie app FastAPI : mêmes corps, mêmes requêtes à l'agent et à la vision, mêmes archives, jetons et notifications. */
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { creerJeton, dependancesParDefaut, getUser } from "@elpis/auth";
import { runtimeRequirements } from "@elpis/bureau";
import { ArchiveZip, HttpError, pyJsonDumps, pyJsonLoads } from "@elpis/commun";
import type { Dict } from "@elpis/commun";
import { config, invalidateConfigCache, reloadDesktopConfigFromDisk, surchargerConfig } from "@elpis/config";
import { initialiserBase } from "@elpis/db";
import { ouvrirBaseDeTest } from "@elpis/db/test";
import type { BaseDeTest } from "@elpis/db/test";
import type { FastifyInstance, FastifyRequest } from "fastify";
import pngjs from "pngjs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  ancresDeLaBase,
  fermerAgentsBureau,
  frameSig,
  installerAncres,
  installerComptesBureau,
  installerPrimitivesBureau,
  PRIMITIVES_AGENT,
  REGLAGES_BUREAU,
  reinitialiserMemosBureau,
} from "../../src/bureau";
import { creerFamilleBureau } from "../../src/familles/bureau";
import { appTest } from "../aides";
import { FauxLan, portFerme } from "../faux-lan";
import type { ReponseScriptee, RequeteVue } from "../faux-lan";

type Service = ReponseScriptee & { ecran?: string; l?: number; h?: number; data_url?: boolean };
type Etape = {
  u?: number;
  m?: string;
  p?: string;
  json?: unknown;
  corps?: string;
  type?: string;
  h?: Record<string, string>;
  services?: Service[];
  config?: Dict;
  raz?: boolean;
  jeton?: number;
  racine?: string;
  notifs?: boolean;
  jetons?: boolean;
};

const V = pyJsonLoads(readFileSync(new URL("../vecteurs/routes-bureau.json", import.meta.url), "utf-8")) as {
  ecrans: Record<string, string>;
  etapes: Etape[];
  reponses: (Dict | null)[];
};
const ENV = ["DESKTOP_SCREENS_DIR", "DESKTOP_ACTIVE_PATH"];

/** Seul écart voulu des installeurs (E35) : sondes HTTPS en GET au lieu de HEAD (405 côté app). */
function sondesEnGetVecteur(texte: string): string {
  return texte.split('--head "').join('-o /dev/null "').split("-Method Head -Uri").join("-Method Get -Uri");
}

/** Garde de session des vecteurs : `x-uid`, sinon 401 (comme `require_user_id` remplacé côté Python). */
function compte(req: FastifyRequest): number {
  const v = req.headers["x-uid"];
  if (!v) throw new HttpError(401, "not logged in");
  req.utilisateur = { id: Number(v), username: null };
  return Number(v);
}

/** Image PNG d'une requête à la vision : taille et empreinte des pixels RVBA (le recadrage est réencodé). */
function image(b64: string): string {
  try {
    const p = pngjs.PNG.sync.read(Buffer.from(b64, "base64"));
    return `<IMG ${p.width}x${p.height} ${createHash("sha256").update(p.data).digest("hex").slice(0, 16)}>`;
  } catch {
    return "<IMG ?>";
  }
}

/** Étapes où le banc Python (routeur seul) répond 500 sur un OverflowError que le filet global de `create_app()` rend en 400. */
const FILET_GLOBAL = new Set([105]);

/** Archive de `desktop-agent/` : noms, méthode et modes figés par le vecteur ; contenus ceux du dépôt (l'agent évolue, écart suivi par l'archive elle-même). */
function contenuActuelDeLAgent(membre: unknown[]): unknown[] {
  const [nom, methode, attributs, , date] = membre;
  const fichier = path.join(String(config.PROJECT_ROOT), String(nom));
  return [nom, methode, attributs, createHash("sha256").update(readFileSync(fichier)).digest("hex"), date];
}

/** Paquet d'automatisation : modules du runtime et requirements.txt tirés du dépôt (dépendances figées depuis le vecteur), le reste tel que figé. */
async function contenuActuelDuRuntime(membre: unknown[], os: string): Promise<unknown[]> {
  const [nom, methode, attributs, empreinte, date] = membre;
  const reste = String(nom).split("/").slice(1).join("/");
  const agent = path.join(String(config.PROJECT_ROOT), "desktop-agent");
  let octets: Buffer | null = null;
  if (/^(backends|elpis_auto)\/[^/]+\.py$/u.test(reste) || reste === "normalize.py")
    octets = readFileSync(path.join(agent, reste));
  else if (reste === "requirements.txt")
    octets = Buffer.from(await runtimeRequirements(agent, os.toLowerCase()), "utf-8");
  const sha = octets === null ? empreinte : createHash("sha256").update(octets).digest("hex");
  return [nom, methode, attributs, sha, date];
}

describe("routes du bureau rejouées contre la vraie app FastAPI", () => {
  let app: FastifyInstance;
  let lan: FauxLan;
  let ferme: string;
  let dossier: string;
  let t: BaseDeTest;
  let restaurer: (() => void)[] = [];
  const envAvant: Record<string, string | undefined> = {};
  const ttlAvant = { ...REGLAGES_BUREAU };

  beforeAll(async () => {
    dossier = mkdtempSync(path.join(tmpdir(), "elpis-bureau-routes-"));
    mkdirSync(path.join(dossier, "vide"));
    for (const k of ENV) envAvant[k] = process.env[k];
    process.env["DESKTOP_SCREENS_DIR"] = path.join(dossier, "ecrans");
    process.env["DESKTOP_ACTIVE_PATH"] = path.join(dossier, "actif.json");
    writeFileSync(path.join(dossier, "config.json"), "{}");
    const visionAvant = {
      VISION_ENDPOINT_URL: config.VISION_ENDPOINT_URL,
      VISION_FORMAT: config.VISION_FORMAT,
      VISION_PASSES: config.VISION_PASSES,
      DESKTOP_TARGETS: config.DESKTOP_TARGETS,
    };
    restaurer = [
      surchargerConfig({ CONFIG_JSON_PATH: path.join(dossier, "config.json") }),
      () => surchargerConfig(visionAvant),
    ];
    t = ouvrirBaseDeTest("sqlite");
    await initialiserBase(t.base);
    for (const [nom, admin] of [
      ["alice", 1],
      ["bob", 0],
      ["carol", 0],
    ] as const)
      await t.base.run(
        "INSERT INTO users(username, pass_salt, pass_hash, created_at, is_admin) VALUES(?,?,?,?,?)",
        [nom, "s", "h", 0, admin],
      );
    installerPrimitivesBureau(PRIMITIVES_AGENT);
    installerAncres(ancresDeLaBase(t.base));
    installerComptesBureau({ estAdmin: async (nom) => (await getUser(t.base, nom))?.is_admin === 1 });
    Object.assign(REGLAGES_BUREAU, { a11yMemoTtlS: 3600, visionMemoTtlS: 3600, visionPromptMemoTtlS: 3600 });
    reinitialiserMemosBureau();
    lan = await FauxLan.demarrer();
    ferme = await portFerme();
    app = await appTest({
      familles: [
        creerFamilleBureau({
          base: t.base,
          auth: dependancesParDefaut(t.base),
          session: async (req) => compte(req),
        }),
      ],
      gardes: { session: (req) => void compte(req) },
    });
  });

  afterAll(async () => {
    await app.close();
    await lan.arreter();
    await fermerAgentsBureau();
    installerPrimitivesBureau(null);
    installerAncres(null);
    installerComptesBureau(null);
    Object.assign(REGLAGES_BUREAU, ttlAvant);
    for (const r of restaurer.reverse()) r();
    for (const k of ENV) {
      if (envAvant[k] === undefined) delete process.env[k];
      else process.env[k] = envAvant[k];
    }
    await t.fermer();
    rmSync(dossier, { recursive: true, force: true });
  });

  it("famille conforme à l'inventaire : main seulement, publiques comme en Python, trames relayées vers l'hôte d'outils", () => {
    const inventaire = pyJsonLoads(
      readFileSync(new URL("../../../../migration-kit/routes.inventory.json", import.meta.url), "utf-8"),
    ) as { routes: { methodes: string[]; chemin: string; process: string[]; publique: boolean | null }[] };
    const attendues = inventaire.routes.filter(
      (r) =>
        (r.chemin.startsWith("/api/desktop/") || r.chemin === "/agent" || r.chemin === "/agent.ps1") &&
        !r.chemin.startsWith("/api/desktop/frame/"),
    );
    expect(attendues).toHaveLength(22);
    const famille = creerFamilleBureau({ base: t.base, auth: dependancesParDefaut(t.base) });
    expect(famille.routes.map((r) => `${String(r.methode)} ${r.chemin} ${r.acces}`).sort()).toEqual(
      attendues
        .map((r) => `${r.methodes.join(",")} ${r.chemin} ${r.publique === false ? "session" : "public"}`)
        .sort(),
    );
    expect(new Set(famille.routes.flatMap((r) => [...r.processus]))).toEqual(new Set(["main"]));
  });

  it("chaque étape rend le même corps, les mêmes requêtes aux faux services, les mêmes archives", async () => {
    const neutre = (texte: string): string =>
      texte
        .replaceAll(lan.url, "<SERVICE>")
        .replaceAll(ferme, "<FERME>")
        .replace(/evt_[A-Za-z0-9_-]+/g, "<JETON>")
        .replace(/\/api\/desktop\/frame\/[A-Za-z0-9_-]+\?t=\d+/g, "/api/desktop/frame/<J>?t=<T>")
        .replace(/"ts":\d+/g, '"ts":0')
        .replace(/"duration_s":[0-9.e+-]+/g, '"duration_s":0');
    const vue = (v: RequeteVue): Dict => {
      const { corps, ...reste } = v;
      const texte = Buffer.from(corps, "base64")
        .toString("utf-8")
        .replace(/data:image\/(png|jpeg);base64,([A-Za-z0-9+/=]+)/g, (_m, _t, b64: string) => image(b64));
      return { ...reste, corps: neutre(texte) };
    };
    const service = (s: Service): ReponseScriptee => {
      if (s.ecran === undefined) return s;
      const img = (s.data_url ? "data:image/png;base64," : "") + (V.ecrans[s.ecran] ?? "");
      return { statut: s.statut, json: { ok: true, image: img, width: s.l, height: s.h } };
    };
    const sigE1 = await frameSig(new Uint8Array(Buffer.from(V.ecrans["E1"] ?? "", "base64")));
    let jeton = "";
    let racine: (() => void) | null = null;
    let n = 0;
    for (const [i, e] of V.etapes.entries()) {
      if (e.config !== undefined) {
        const texte = pyJsonDumps(e.config, { ensureAscii: false })
          .replaceAll("<SERVICE>", lan.url)
          .replaceAll("<FERME>", ferme);
        writeFileSync(path.join(dossier, "config.json"), texte);
        invalidateConfigCache();
        reloadDesktopConfigFromDisk(true);
        if (!(e.config["vision"] as Dict)["endpoint_url"]) surchargerConfig({ VISION_ENDPOINT_URL: "" });
        continue;
      }
      if (e.raz) {
        reinitialiserMemosBureau();
        continue;
      }
      if (e.jeton !== undefined) {
        [jeton] = await creerJeton(dependancesParDefaut(t.base), e.jeton, "vision", "vision");
        continue;
      }
      if (e.racine !== undefined) {
        racine?.();
        racine = e.racine === "vide" ? surchargerConfig({ PROJECT_ROOT: path.join(dossier, "vide") }) : null;
        continue;
      }
      lan.reponses = (e.services ?? []).map(service);
      lan.vues.length = 0;
      const entetes: Record<string, string> = {};
      for (const [k, v] of Object.entries(e.h ?? {})) entetes[k] = v.replaceAll("<JETON_VISION>", jeton);
      if (e.u) entetes["x-uid"] = String(e.u);
      let payload: string | undefined;
      if (e.json !== undefined) {
        payload = pyJsonDumps(e.json, { ensureAscii: false }).replaceAll('"<SIG_E1>"', JSON.stringify(sigE1));
        for (const [nom, img] of Object.entries(V.ecrans))
          payload = payload.replaceAll(`"<${nom}>"`, JSON.stringify(img));
        entetes["content-type"] = "application/json";
      } else if (e.corps !== undefined) {
        payload = e.corps;
        entetes["content-type"] = e.type ?? "";
      }
      const r = await app.inject({
        method: e.m as "GET",
        url: e.p ?? "/",
        headers: entetes,
        ...(payload !== undefined ? { payload } : {}),
      });
      const type = (r.headers["content-type"] as string | undefined) ?? "";
      // En-têtes de sécurité : posés par la route seulement pour run-file (ailleurs, ceux de l'app, absents du banc Python).
      const propres = (e.p ?? "").startsWith("/api/desktop/run-file") && r.statusCode === 200;
      let corps: Dict;
      if (type.startsWith("application/zip")) {
        const z = new ArchiveZip(r.rawPayload);
        corps = {
          zip: z.membres
            .map((m) => [
              m.nom,
              m.methode,
              m.attributsExternes,
              createHash("sha256").update(z.lire(m)).digest("hex"),
              m.dateHeure.join() === "1980,1,1,0,0,0" ? m.dateHeure : null,
            ])
            .sort((a, b) => ((a[0] as string) < (b[0] as string) ? -1 : 1)),
        };
      } else
        try {
          corps = { texte: neutre(new TextDecoder("utf-8", { fatal: true }).decode(r.rawPayload)) };
        } catch {
          corps = { octets: r.rawPayload.toString("base64") };
        }
      const vu: Dict = {
        statut: r.statusCode,
        type: type.startsWith("application/json") ? "application/json" : type,
        cd: (r.headers["content-disposition"] as string | undefined) ?? null,
        csp: propres ? ((r.headers["content-security-policy"] as string | undefined) ?? null) : null,
        nosniff: propres ? ((r.headers["x-content-type-options"] as string | undefined) ?? null) : null,
        ...corps,
        vues: lan.vues.map(vue),
        restantes: lan.reponses.length,
      };
      if (e.notifs)
        vu["notifs"] = (
          await t.base.valeurs(
            "SELECT owner_user_id, kind, title, body, ref_type, ref_id FROM notifications ORDER BY id",
          )
        ).map((l) => [...l]);
      if (e.jetons)
        vu["jetons"] = (
          await t.base.valeurs(
            "SELECT user_id, name, hint IS NOT NULL FROM tool_tokens WHERE kind='vision' ORDER BY id",
          )
        ).map((l) => [...l]);
      const attendu = { ...V.reponses[i] };
      if (e.p === "/api/desktop/agent-bundle" && Array.isArray(attendu["zip"]))
        attendu["zip"] = (attendu["zip"] as unknown[][]).map(contenuActuelDeLAgent);
      if (e.p === "/api/desktop/automation-bundle" && Array.isArray(attendu["zip"]))
        attendu["zip"] = await Promise.all(
          (attendu["zip"] as unknown[][]).map((m) =>
            contenuActuelDuRuntime(m, String((e.json as Dict | undefined)?.["os"] ?? "")),
          ),
        );
      if (
        /^\/(api\/desktop\/install\.(sh|ps1)|agent(\.ps1)?)$/.test(e.p ?? "") &&
        typeof attendu["texte"] === "string"
      )
        attendu["texte"] = sondesEnGetVecteur(attendu["texte"]);
      if (FILET_GLOBAL.has(i))
        Object.assign(attendu, {
          statut: 400,
          type: "application/json",
          texte: '{"detail":"Paramètre hors bornes."}',
        });
      expect(vu, `étape ${i} : ${e.m} ${e.p} ${JSON.stringify(e.json ?? e.corps ?? "")}`).toEqual(attendu);
      expect(r.body.includes("evt_"), `étape ${i} : jeton de vision renvoyé`).toBe(false);
      n++;
    }
    expect(n).toBeGreaterThan(150);
  });
});
