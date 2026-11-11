// SPDX-License-Identifier: MIT
/** apps/core/test/images/routes.test.ts — routes des images rejouées contre FastAPI (vecteurs ; la clé du moteur, dans le coffre, est relue du coffre pour l'état disque), FileResponse de Starlette (stat, plages, disposition), nom de téléchargement, sonde du modèle bornée. */
import { randomBytes } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createUser, ligneUtilisateur, signerSession } from "@elpis/auth";
import type { DependancesAuth, DependancesJetons } from "@elpis/auth";
import { HttpError, pyJsonLoads } from "@elpis/commun";
import type { Dict } from "@elpis/commun";
import { config, invalidateConfigCache, surchargerConfig } from "@elpis/config";
import { initialiserBase, NOM_CLE_IMAGES } from "@elpis/db";
import type { Base } from "@elpis/db";
import { ouvrirBaseDeTest, PG_DE_TEST } from "@elpis/db/test";
import type { BaseDeTest } from "@elpis/db/test";
import { configurerChiffrement, configurerCoffre, decrypt } from "@elpis/securite";
import type { FastifyInstance, FastifyRequest } from "fastify";

import { remplacerBase } from "../../src/base";
import { composer } from "../../src/composition";
import { origines } from "../../src/secrets/portee";
import { creerSecret, dechiffrerLigne, lireLigneParNom, porteeDe } from "../../src/secrets/stockage";
import { creerFamilleAdminImages } from "../../src/familles/admin-images";
import { creerFamilleImages, downloadName } from "../../src/familles/images";
import { forgetCapabilities } from "../../src/images/service";
import { portFerme } from "../llm/faux-serveur";
import { appTest, journalMuet } from "../aides";
import { FauxMoteur } from "./faux-moteur";
import {
  contentDisposition,
  entetesStat,
  parseRangeHeader,
  PlageInsatisfiable,
  PlageMalformee,
  reponseFichier,
} from "@elpis/http";

type Reponse = {
  statut: number;
  corps: string;
  entetes: Record<string, string>;
  moteur: [string, string, string | null][];
};
type Etape = [string, ...unknown[]];

const V = pyJsonLoads(readFileSync(new URL("../vecteurs/images-routes.json", import.meta.url), "utf-8"), {
  mode: "natif",
}) as {
  noms_cas: [string, unknown, string, string][];
  noms: string[];
  dispositions_cas: [string, string][];
  dispositions: string[];
  plages_cas: [string, number][];
  plages: { resultat?: number[][]; erreur?: string; contenu?: string | null; taille?: number | null }[];
  stats: {
    ns: string;
    taille: number;
    mtime: string;
    etag: string;
    last_modified: string;
    content_length: string;
  }[];
  cle_fernet: string;
  moteurs: Record<string, string>;
  comptes: [string, number][];
  reglages: Record<string, string>;
  images: [string, string, string, string, string, string, string, number][];
  fichiers: [string, string, number][];
  etapes: Etape[];
  entetes: string[];
  ids: Record<string, number>;
  reponses: (Reponse | { disque: unknown } | null)[];
  fichiers_restants: string[];
  config_finale: unknown;
};

describe("fonctions pures (vecteurs Python)", () => {
  it("download_name : comme imageFileName de l'interface", () => {
    const texte = readFileSync(new URL("../vecteurs/images-routes.json", import.meta.url), "utf-8");
    const cas = (pyJsonLoads(texte) as { noms_cas: [string, unknown, string, string][] }).noms_cas;
    expect(cas.map(([p, s, m, i]) => downloadName(p, s, m, i))).toEqual(V.noms);
  });

  it("Content-Disposition de FileResponse", () => {
    expect(V.dispositions_cas.map(([n, t]) => contentDisposition(n, t))).toEqual(V.dispositions);
  });

  it("_parse_range_header : plages fusionnées, erreurs 400 et 416", () => {
    for (const [i, [h, taille]] of V.plages_cas.entries()) {
      let obtenu: (typeof V.plages)[number];
      try {
        obtenu = { resultat: parseRangeHeader(h, taille) };
      } catch (e) {
        if (e instanceof PlageMalformee)
          obtenu = { erreur: "MalformedRangeHeader", contenu: e.contenu, taille: null };
        else if (e instanceof PlageInsatisfiable)
          obtenu = { erreur: "RangeNotSatisfiable", contenu: null, taille: e.taille };
        else throw e;
      }
      expect(obtenu, `${JSON.stringify(h)} / ${taille}`).toEqual(V.plages[i]);
    }
  });

  it("set_stat_headers : ETag de `str(st_mtime)`, Last-Modified de formatdate", () => {
    for (const s of V.stats)
      expect(entetesStat(BigInt(s.ns), s.taille), String(s.ns)).toEqual({
        "content-length": s.content_length,
        "last-modified": s.last_modified,
        etag: s.etag,
      });
  });
});

const MOTEURS_BASE = PG_DE_TEST ? (["sqlite", "postgres"] as const) : (["sqlite"] as const);

/** Garde de session des tests : compte lu dans `x-uid`, 401 sans lui. */
const gardes = {
  session: (req: { headers: Record<string, unknown>; utilisateur?: unknown }) => {
    const uid = req.headers["x-uid"];
    if (!uid) throw new HttpError(401, "not logged in");
    req.utilisateur = { id: Number(uid), username: null };
  },
};

let sd: FauxMoteur;
let oa: FauxMoteur;
let urls: Record<string, string>;
let dossierCoffre: string;
const CLE_COFFRE = randomBytes(32).toString("base64");

/** Clé du coffre des essais (jamais /etc/elpis), ou chemin absent pour un coffre indisponible. */
function coffreDeTest(indisponible = false): void {
  configurerCoffre(
    indisponible
      ? { fichier: join(dossierCoffre, "absente", "vault.key"), repli: join(dossierCoffre, ".vault.key") }
      : {
          cleEnv: CLE_COFFRE,
          systeme: join(dossierCoffre, "absente.key"),
          repli: join(dossierCoffre, ".vault.key"),
        },
  );
}

beforeAll(async () => {
  sd = await FauxMoteur.demarrer();
  oa = await FauxMoteur.demarrer();
  oa.file("GET /v1/models", [{ texte: JSON.stringify({ data: [{ id: "m1" }, { id: "dall-e-3" }] }) }]);
  urls = { "{sd}": sd.url, "{oa}": oa.url, "{panne}": `http://127.0.0.1:${await portFerme()}` };
  configurerChiffrement({ cleEnv: V.cle_fernet, fichierCle: "/inexistant/.encryption_key" });
  dossierCoffre = mkdtempSync(join(tmpdir(), "elpis-images-coffre-"));
  coffreDeTest();
});
afterAll(async () => {
  await sd.arreter();
  await oa.arreter();
  rmSync(dossierCoffre, { recursive: true, force: true });
});

function remplacer(v: unknown): unknown {
  if (typeof v === "string") return Object.entries(urls).reduce((s, [cle, url]) => s.replaceAll(cle, url), v);
  if (Array.isArray(v)) return v.map(remplacer);
  if (v !== null && typeof v === "object")
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, remplacer(x)]));
  return v;
}

function etatMoteur(e: { modele: string; mode: string }): void {
  sd.file("GET /sdcpp/v1/capabilities", [
    {
      texte: JSON.stringify({ current_mode: e.mode, limits: { max_width: 2048 }, model: { name: e.modele } }),
    },
  ]);
}

function lireConfig(): Dict {
  try {
    return JSON.parse(readFileSync(config.CONFIG_JSON_PATH, "utf-8")) as Dict;
  } catch {
    return {};
  }
}

/** Bloc `image` de config.json, adresses des faux moteurs remplacées par leurs repères ; `api_key_enc` (`{k, o}` du Python) lu du secret `image-engine` du coffre, sinon de l'ancienne clé, sinon vide. */
async function disque(b: Base): Promise<unknown> {
  const inverse = (texte: string): string =>
    Object.entries(urls).reduce((s, [cle, url]) => s.replaceAll(url, cle), texte);
  const image: Dict = { ...((lireConfig()["image"] as Dict | undefined) ?? {}) };
  const l = await lireLigneParNom(b, null, NOM_CLE_IMAGES);
  if (l !== null) image["api_key_enc"] = { k: dechiffrerLigne(l), o: origines(porteeDe(l))[0] };
  else if (image["api_key_enc"])
    image["api_key_enc"] = JSON.parse(inverse(decrypt(image["api_key_enc"] as string)) || "null");
  else image["api_key_enc"] = "";
  return JSON.parse(inverse(JSON.stringify(image)));
}

/** Prépare base, dossier, comptes, réglages, images et fichiers comme le générateur. */
async function preparer(t: BaseDeTest, dossier: string): Promise<Record<string, number>> {
  const b = t.base;
  await initialiserBase(b);
  const ids: Record<string, number> = {};
  for (const [nom, admin] of V.comptes) ids[nom] = await createUser(b, nom, `mdp-${nom}`, { isAdmin: admin });
  const design = await b.insertId(
    `INSERT INTO "groups" (name, description, created_at) VALUES ('Design', '', 0)`,
  );
  await b.run("INSERT INTO user_groups (user_id, group_id) VALUES (?, ?)", [ids["alice"] ?? 0, design]);
  for (const [nom, texte] of Object.entries(V.reglages))
    await b.run("UPDATE users SET settings_json=? WHERE id=?", [texte, ids[nom] ?? 0]);
  const racine = join(dossier, "user_db", "generated_images");
  for (const [rel, contenu, mtime] of V.fichiers) {
    const p = join(racine, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, contenu, "utf-8");
    utimesSync(p, mtime, mtime);
  }
  for (const [iid, nom, prompt, pj, mime, rel, vig, quand] of V.images)
    await b.run(
      "INSERT INTO generated_images (id, user_id, chat_id, prompt, params_json, model, mime, width, height, " +
        "bytes, rel_path, thumb_rel_path, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
      [
        iid,
        ids[nom] ?? 0,
        iid.endsWith("2") ? "c1" : null,
        prompt,
        pj,
        "m",
        mime,
        64,
        48,
        10,
        rel,
        vig,
        quand,
      ],
    );
  return ids;
}

describe.each(MOTEURS_BASE)("routes rejouées contre FastAPI (%s)", (moteurBase) => {
  let t: BaseDeTest;
  let dossier: string;
  let restaurer: () => void;
  let app: FastifyInstance;
  let appAdmin: FastifyInstance;

  beforeEach(async () => {
    t = ouvrirBaseDeTest(moteurBase);
    dossier = mkdtempSync(join(tmpdir(), "elpis-images-routes-"));
    restaurer = surchargerConfig({
      DB_PATH: join(dossier, "user_db", "app.db"),
      CONFIG_JSON_PATH: join(dossier, "config.json"),
    });
    forgetCapabilities();
    remplacerBase(t.base);
  });
  afterEach(async () => {
    remplacerBase(undefined);
    await app.close();
    await appAdmin.close();
    restaurer();
    invalidateConfigCache();
    await t.fermer();
    rmSync(dossier, { recursive: true, force: true });
  });

  it("état, galerie, fichiers (plages, vignette, disposition), suppressions : réponses et appels au moteur identiques", async () => {
    const ids = await preparer(t, dossier);
    expect(ids).toEqual(V.ids);
    app = await appTest({ familles: [creerFamilleImages({ base: t.base })], gardes });
    const admin = async (req: FastifyRequest): Promise<void> => {
      gardes.session(req as unknown as Parameters<typeof gardes.session>[0]);
      const moi = await ligneUtilisateur(t.base, req.utilisateur?.id ?? 0);
      if (!moi || Number(moi.is_admin) !== 1) throw new HttpError(403, "Admin required");
    };
    appAdmin = await appTest({
      mode: "admin",
      familles: [creerFamilleAdminImages({ base: t.base })],
      gardes: { ...gardes, admin },
    });
    let etag: string | undefined;
    let lm: string | undefined;
    for (const [i, etape] of V.etapes.entries()) {
      const attendu = V.reponses[i];
      if (etape[0] === "config") {
        const bloc = remplacer(etape[1]) as Dict;
        if (etape[2])
          bloc["api_key_enc"] = (lireConfig()["image"] as Dict | undefined)?.["api_key_enc"] ?? "";
        writeFileSync(join(dossier, "config.json"), JSON.stringify({ image: bloc }), "utf-8");
        invalidateConfigCache();
        continue;
      }
      if (etape[0] === "disque") {
        expect({ disque: await disque(t.base) }, `étape ${i} : disque`).toEqual(attendu);
        continue;
      }
      if (etape[0] === "moteur") {
        etatMoteur(etape[1] as { modele: string; mode: string });
        continue;
      }
      if (etape[0] === "oublier") {
        forgetCapabilities();
        continue;
      }
      const [nom, methode, chemin, options, statutTs] = etape as [
        string | null,
        string,
        string,
        { entetes?: Record<string, string>; json?: unknown; corps?: string },
        number?,
      ];
      const entetes: Record<string, string> = {};
      for (const [k, v] of Object.entries(options.entetes ?? {}))
        entetes[k] = v === "{etag}" ? (etag ?? "") : v === "{lm}" ? (lm ?? "") : v;
      if (nom) entetes["x-uid"] = String(ids[nom]);
      const avant = [sd.requetes.length, oa.requetes.length];
      const cible = chemin.startsWith("/api/admin/") ? appAdmin : app;
      const r = await cible.inject({
        method: methode as "GET",
        url: chemin,
        headers: entetes,
        ...(options.json !== undefined ? { payload: remplacer(options.json) as Dict } : {}),
        ...(options.corps !== undefined ? { payload: options.corps } : {}),
      });
      const recu = [...sd.requetes.slice(avant[0]), ...oa.requetes.slice(avant[1])].map(
        (q): [string, string, string | null] => [
          q.methode,
          q.chemin.split("?")[0] ?? "",
          (q.entetes["authorization"] as string | undefined) ?? null,
        ],
      );
      if (statutTs !== undefined) {
        expect(r.statusCode, `étape ${i} : ${methode} ${chemin} (écart déclaré)`).toBe(statutTs);
        continue;
      }
      let corps = r.rawPayload;
      const h: Record<string, string> = {};
      for (const k of V.entetes) if (r.headers[k] !== undefined) h[k] = String(r.headers[k]);
      const borne = /boundary=([0-9a-f]+)/.exec(h["content-type"] ?? "")?.[1];
      if (borne) {
        corps = Buffer.from(corps.toString("latin1").replaceAll(borne, "<BORNE>"), "latin1");
        h["content-type"] = (h["content-type"] ?? "").replace(borne, "<BORNE>");
      }
      if (r.statusCode === 200 && h["etag"] && etag === undefined)
        [etag, lm] = [h["etag"], h["last-modified"]];
      // Le générateur monte le routeur sans les intergiciels de server/app.py (nosniff) ; le socle les applique.
      if (h["content-type"] === "application/json; charset=utf-8") h["content-type"] = "application/json";
      if (attendu && "entetes" in attendu && !("x-content-type-options" in attendu.entetes))
        delete h["x-content-type-options"];
      const texte = new TextDecoder("utf-8").decode(corps).replace(/"latency_ms":\d+/g, '"latency_ms":0');
      if (texte.includes('"latency_ms"')) delete h["content-length"];
      expect(
        {
          statut: r.statusCode,
          corps: Buffer.from(texte, "utf-8").toString("base64"),
          entetes: h,
          moteur: recu,
        },
        `étape ${i} : ${nom ?? "anonyme"} ${methode} ${chemin} ${JSON.stringify(options)}\n${texte}`,
      ).toEqual(attendu);
    }
    expect(await disque(t.base)).toEqual(V.config_finale);
    const restants: string[] = [];
    const racine = join(dossier, "user_db", "generated_images");
    for (const d of ["2", "3", "6"]) for (const f of readdirSync(join(racine, d))) restants.push(`${d}/${f}`);
    expect(restants.sort()).toEqual(V.fichiers_restants);
  });
});

describe("sonde du modèle et montage", () => {
  let t: BaseDeTest;
  let dossier: string;
  let restaurer: () => void;

  beforeEach(async () => {
    t = ouvrirBaseDeTest("sqlite");
    dossier = mkdtempSync(join(tmpdir(), "elpis-images-routes-"));
    restaurer = surchargerConfig({
      DB_PATH: join(dossier, "user_db", "app.db"),
      CONFIG_JSON_PATH: join(dossier, "config.json"),
    });
    forgetCapabilities();
  });
  afterEach(async () => {
    restaurer();
    invalidateConfigCache();
    await t.fermer();
    rmSync(dossier, { recursive: true, force: true });
  });

  it("sd-server qui ne répond pas : modèle vide après 3 s, sans attendre le délai de la requête", async () => {
    await preparer(t, dossier);
    const lent = await FauxMoteur.demarrer();
    try {
      lent.file("GET /sdcpp/v1/capabilities", [{ attendreMs: 10_000, texte: "{}" }]);
      writeFileSync(
        join(dossier, "config.json"),
        JSON.stringify({ image: { enabled: true, url: lent.url, model: "configuré" } }),
      );
      invalidateConfigCache();
      const app = await appTest({ familles: [creerFamilleImages({ base: t.base })], gardes });
      const debut = performance.now();
      const r = await app.inject({ method: "GET", url: "/api/image/status", headers: { "x-uid": "2" } });
      const duree = performance.now() - debut;
      expect([r.statusCode, r.json()["model"]]).toEqual([200, ""]);
      expect(duree).toBeGreaterThan(2900);
      expect(duree).toBeLessThan(6000);
      await app.close();
    } finally {
      await lent.arreter();
    }
  });

  it("clé : coffre indisponible → 503 sans rien écrire ; demi-paire → 500 ; config.json non modifié", async () => {
    await preparer(t, dossier);
    writeFileSync(join(dossier, "config.json"), JSON.stringify({ image: { enabled: true, url: sd.url } }));
    invalidateConfigCache();
    const admin = (req: FastifyRequest): void =>
      gardes.session(req as unknown as Parameters<typeof gardes.session>[0]);
    const app = await appTest({
      mode: "admin",
      familles: [creerFamilleAdminImages({ base: t.base })],
      gardes: { ...gardes, admin },
    });
    try {
      coffreDeTest(true);
      const r = await app.inject({
        method: "PUT",
        url: "/api/admin/image/key",
        headers: { "x-uid": "1" },
        payload: { api_key: "sk" },
      });
      expect([r.statusCode, r.json()]).toEqual([
        503,
        { detail: "Clé du coffre indisponible sur ce serveur (./elpis doctor)." },
      ]);
      expect(await t.base.get("SELECT COUNT(*) AS n FROM vault_secrets")).toEqual({ n: 0 });
      coffreDeTest();
      const s = await app.inject({
        method: "PUT",
        url: "/api/admin/image/key",
        headers: { "x-uid": "1", "content-type": "application/json" },
        payload: '{"api_key": "sk\\ud800"}',
      });
      expect(s.statusCode).toBe(500);
      expect(lireConfig()).toEqual({ image: { enabled: true, url: sd.url } });
      const k = await app.inject({
        method: "PUT",
        url: "/api/admin/image/key",
        headers: { "x-uid": "1" },
        payload: { api_key: "sk-coffre" },
      });
      expect([k.statusCode, k.json()]).toEqual([200, { ok: true, has_key: true, stale: false }]);
      expect(lireConfig()).toEqual({ image: { enabled: true, url: sd.url } });
      expect(JSON.stringify(await t.base.all("SELECT * FROM vault_secrets"))).not.toContain("sk-coffre");
    } finally {
      coffreDeTest();
      await app.close();
    }
  });

  it("clé : nom image-engine pris par un autre genre → 409, ce secret intact, effacer n'y touche pas", async () => {
    await preparer(t, dossier);
    writeFileSync(join(dossier, "config.json"), JSON.stringify({ image: { enabled: true, url: sd.url } }));
    invalidateConfigCache();
    const autre = await creerSecret(
      t.base,
      null,
      {
        name: NOM_CLE_IMAGES,
        kind: "http-auth",
        scope: { origins: ["https://autre.test"] },
        value: "mot-de-passe",
      },
      { userId: 1, username: "admin" },
    );
    const admin = (req: FastifyRequest): void =>
      gardes.session(req as unknown as Parameters<typeof gardes.session>[0]);
    const app = await appTest({
      mode: "admin",
      familles: [creerFamilleAdminImages({ base: t.base })],
      gardes: { ...gardes, admin },
    });
    try {
      for (const [api_key, statut] of [
        ["sk-images", 409],
        ["", 200],
      ] as const) {
        const r = await app.inject({
          method: "PUT",
          url: "/api/admin/image/key",
          headers: { "x-uid": "1" },
          payload: { api_key },
        });
        expect(r.statusCode).toBe(statut);
      }
      const l = await lireLigneParNom(t.base, null, NOM_CLE_IMAGES);
      expect([l?.id, l?.kind, l?.version, l === null ? "" : dechiffrerLigne(l)]).toEqual([
        autre.id,
        "http-auth",
        1,
        "mot-de-passe",
      ]);
    } finally {
      await app.close();
    }
  });

  it("clé : config.json illisible n'empêche pas d'effacer la clé du coffre et reste intact", async () => {
    await preparer(t, dossier);
    writeFileSync(join(dossier, "config.json"), '{"image": {"url": "x"}, "security": ');
    invalidateConfigCache();
    const admin = (req: FastifyRequest): void =>
      gardes.session(req as unknown as Parameters<typeof gardes.session>[0]);
    const app = await appTest({
      mode: "admin",
      familles: [creerFamilleAdminImages({ base: t.base })],
      gardes: { ...gardes, admin },
    });
    try {
      const r = await app.inject({
        method: "PUT",
        url: "/api/admin/image/key",
        headers: { "x-uid": "1" },
        payload: { api_key: "" },
      });
      expect([r.statusCode, r.json()]).toEqual([200, { ok: true, has_key: false, stale: false }]);
      expect(readFileSync(join(dossier, "config.json"), "utf-8")).toBe(
        '{"image": {"url": "x"}, "security": ',
      );
    } finally {
      await app.close();
    }
  });

  it("FileResponse : fichier absent (cause ENOENT), dossier refusé, descripteur refermé", async () => {
    const app = await appTest({
      familles: [
        {
          nom: "f",
          routes: [
            {
              methode: "GET",
              chemin: "/f",
              processus: ["main"],
              acces: "public",
              traiter: async (req, rep) => {
                const q = req.query as { p: string };
                try {
                  return await reponseFichier(req, rep, q.p, { mediaType: "text/plain" });
                } catch (e) {
                  return {
                    erreur: (e as Error).message,
                    cause: (e as { cause?: { code?: string } }).cause?.code ?? null,
                  };
                }
              },
            },
          ],
        },
      ],
    });
    try {
      const absent = join(dossier, "absent.txt");
      expect((await app.inject({ url: `/f?p=${encodeURIComponent(absent)}` })).json()).toEqual({
        erreur: `File at path ${absent} does not exist.`,
        cause: "ENOENT",
      });
      expect((await app.inject({ url: `/f?p=${encodeURIComponent(dossier)}` })).json()).toEqual({
        erreur: `File at path ${dossier} is not a file.`,
        cause: null,
      });
      const p = join(dossier, "t.txt");
      writeFileSync(p, "0123456789");
      const r = await app.inject({
        url: `/f?p=${encodeURIComponent(p)}`,
        headers: { range: "bytes=2-3,6-7" },
      });
      expect([
        r.statusCode,
        r.headers["content-type"]?.toString().startsWith("multipart/byteranges"),
      ]).toEqual([206, true]);
      const t = await app.inject({ url: `/f?p=${encodeURIComponent(p)}` });
      expect([t.statusCode, t.body, t.headers["content-type"]]).toEqual([
        200,
        "0123456789",
        "text/plain; charset=utf-8",
      ]);
      const ouverts = readdirSync("/proc/self/fd").length;
      for (let i = 0; i < 20; i++)
        await app.inject({ url: `/f?p=${encodeURIComponent(p)}`, headers: { range: "bytes=x" } });
      for (let i = 0; i < 20; i++) await app.inject({ url: `/f?p=${encodeURIComponent(dossier)}` });
      expect(readdirSync("/proc/self/fd").length).toBeLessThanOrEqual(ouverts + 2);
    } finally {
      await app.close();
    }
  });

  it("composition : routes utilisateur dans main (session), console dans admin (administrateur)", async () => {
    await initialiserBase(t.base);
    const dep: DependancesAuth & DependancesJetons = {
      base: t.base,
      config: () => ({}),
      attributsCookie: () => ({
        cookie_name: "mcpwebui_session",
        same_site: "lax",
        https_only: false,
        max_age: 86400,
      }),
      secret: () => "secret-de-test",
      jetonService: () => "",
      maintenant: () => 1_791_331_200,
    };
    await createUser(t.base, "alice", "pw-alice-12");
    const cookie = `mcpwebui_session=${signerSession({ user_id: 1, _login_ts: 1_791_331_190 }, "secret-de-test", 1_791_331_200)}`;
    const attendues = [
      "GET /api/image/status",
      "GET /api/images",
      "GET /api/images/:image_id",
      "DELETE /api/images/:image_id",
    ];
    const console = [
      "POST /api/admin/image/test admin",
      "POST /api/admin/image/models admin",
      "GET /api/admin/image/key admin",
      "PUT /api/admin/image/key admin",
    ];
    for (const mode of ["main", "admin"] as const) {
      const c = await composer(mode, t.base, journalMuet, dep);
      const app = await appTest({ ...c, mode });
      const montees = app.elpis.routes
        .filter((r) => r.famille === "images" || r.famille === "admin-images")
        .flatMap((r) => r.methodes.map((m) => `${m} ${r.chemin} ${r.acces}`));
      expect(montees, mode).toEqual(mode === "main" ? attendues.map((x) => `${x} session`) : console);
      const r = await app.inject({ method: "GET", url: "/api/images", headers: { cookie } });
      expect(r.statusCode, mode).toBe(mode === "main" ? 200 : 404);
      const k = await app.inject({ method: "GET", url: "/api/admin/image/key", headers: { cookie } });
      expect(k.statusCode, mode).toBe(mode === "main" ? 404 : 403);
      await app.close();
    }
  });
});
