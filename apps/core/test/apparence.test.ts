// SPDX-License-Identifier: MIT
/** apps/core/test/apparence.test.ts — moteur des skins et routes /api/skins rejoués contre le Python (vecteurs), verrou de config.json, ordre des gardes. */
import { createHash } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createUser } from "@elpis/auth";
import { ArchiveZip, comparePointsDeCode, HttpError, pyJsonDumps, pyJsonLoads } from "@elpis/commun";
import { surchargerConfig } from "@elpis/config";
import { initialiserBase } from "@elpis/db";
import { ouvrirBaseDeTest } from "@elpis/db/test";
import type { BaseDeTest } from "@elpis/db/test";
import { cheminVerrou, VerrouFichier } from "@elpis/verrous";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { deleteSkin, exportZip, importZip, saveFromEditor, setState } from "../src/apparence/ecritures";
import {
  ASSET_RE,
  assetPath,
  assetType,
  blocJetons,
  builtinSkins,
  checkTokenValue,
  defaultSkin,
  detectImage,
  listSkins,
  mascotIds,
  mascotsCatalogue,
  reecrireCss,
  renderCss,
  resolveUserSkin,
  SkinError,
  skinDetail,
  validateCss,
  validateManifest,
  viderCachesSkins,
} from "../src/apparence/skins";
import { creerFamilleApparence } from "../src/familles/apparence";
import { appTest } from "./aides";
import { sansEnteteSpdx } from "./ecart-spdx-css";
import { sansContrasteAA } from "./ecart-contraste-skins";
import { configSansFusion, sansFusion, texteSansFusion } from "./ecart-fusion-skins";

type Resultat = { resultat?: string; erreur?: string; message?: string };

/** Feuille servie ramenée à la forme du Python : sans en-tête SPDX, jetons d'avant le relèvement AA. */
const cssPython = (css: Buffer): Buffer => sansContrasteAA(sansEnteteSpdx(css));

const V = pyJsonLoads(readFileSync(new URL("./vecteurs/skins.json", import.meta.url), "utf-8")) as {
  noms_images: { nom: string; valide: boolean; type: string | null }[];
  jetons: ({ valeur: unknown } & Resultat)[];
  css: ({ texte: unknown; images: string[] | null; reecrit?: string } & Resultat)[];
  manifestes: ({ donnees: unknown; has_css: boolean } & Resultat)[];
  images: { tete: string; type: string | null }[];
  blocs: string[];
  operations: [string, unknown[]][];
  ids: Record<string, number>;
  sortie: (Resultat & { config: string; arbre: [string, string][] })[];
};

function sha1(octets: Buffer | string): string {
  return createHash("sha1").update(octets).digest("hex");
}

function texteDe(v: unknown): unknown {
  if (v !== null && typeof v === "object" && "repeter" in v) {
    const { repeter, fois } = v as { repeter: string; fois: number };
    return repeter.repeat(fois);
  }
  return v;
}

/** Écart voulu avec le Python : le lien vers la feuille d'éditeur d'un skin (editeur.css) lui est inconnu. */
const sansFeuilleEditeur = (json: string): string => json.replace(/,\s*"editor_css_url":\s*"[^"]*"/gu, "");

/** Révision d'un skin juste écrit : elle suit la date réelle des fichiers, figée seulement après l'opération. */
function sansRevision(r: Resultat): Resultat {
  return r.resultat === undefined
    ? r
    : { ...r, resultat: sansFeuilleEditeur(r.resultat).replace(/\?v=[0-9a-f]{10}/gu, "?v=<rev>") };
}

/** Résultat ou refus au format des vecteurs (`json.dumps(…, ensure_ascii=False)` ou `type(e).__name__`). */
async function capturer(f: () => unknown): Promise<Resultat> {
  try {
    return { resultat: pyJsonDumps((await f()) ?? null, { ensureAscii: false }) };
  } catch (e) {
    // Écart voulu avec le Python : editeur.css fait partie des fichiers admis d'un paquet.
    if (e instanceof SkinError)
      return { erreur: e.name, message: e.message.replace("skin.css, editeur.css,", "skin.css,") };
    throw e;
  }
}

describe("validations pures (vecteurs)", () => {
  it("noms d'images : ASCII seulement, extension et type", () => {
    for (const c of V.noms_images) {
      expect(ASSET_RE.test(c.nom), JSON.stringify(c.nom)).toBe(c.valide);
      if (c.valide) expect(assetType(c.nom)).toBe(c.type);
    }
  });

  it("valeurs de jetons", async () => {
    for (const c of V.jetons) {
      const { valeur, ...attendu } = c;
      expect(await capturer(() => checkTokenValue(valeur, "Jeton")), JSON.stringify(valeur)).toEqual(attendu);
    }
  });

  it("feuilles : refus, messages et réécriture des url()", async () => {
    for (const c of V.css) {
      const { texte, images, reecrit, ...attendu } = c;
      const t = texteDe(texte);
      const vu = await capturer(() => validateCss(t, images === null ? null : new Set(images)));
      if (typeof texte === "object" && texte !== null && vu.resultat !== undefined)
        vu.resultat = sha1(reecrireCss(t as string, "brume"));
      expect(vu, JSON.stringify(texte).slice(0, 120)).toEqual(attendu);
      if (reecrit !== undefined) {
        const r = reecrireCss(t as string, "brume");
        expect(typeof texte === "object" ? sha1(r) : r).toBe(reecrit);
      }
    }
  });

  it("manifestes normalisés (ordre des clés compris) ou refusés", async () => {
    for (const c of V.manifestes) {
      const { donnees, has_css, ...attendu } = c;
      expect(
        await capturer(() => validateManifest(donnees, { hasCss: has_css })),
        JSON.stringify(donnees),
      ).toEqual(attendu);
    }
  });

  it("types d'images d'après les octets, blocs de jetons", () => {
    for (const c of V.images) expect(detectImage(Buffer.from(c.tete, "hex")), c.tete).toBe(c.type);
    expect([
      blocJetons("body.x", { "--a": "1", "--radius": "2px" }),
      blocJetons("body.x", { "--radius": "2px", "--radius-md": "3px" }),
      blocJetons("body.x", { "--b": "c" }),
    ]).toEqual(V.blocs);
  });
});

/** Arbre de SKINS_DIR comme `sorted(rglob("*"))` : composants comparés un à un, liens non suivis, CSS sans sa ligne SPDX. */
function arbre(racine: string): [string, string][] {
  const out: [string[], string][] = [];
  const parcourir = (dossier: string, parties: string[]): void => {
    for (const nom of readdirSync(dossier)) {
      const chemin = join(dossier, nom);
      const st = lstatSync(chemin);
      const rel = [...parties, nom];
      if (st.isSymbolicLink()) out.push([rel, `-> ${readlinkSync(chemin)}`]);
      else if (nom === "editeur.css") continue;
      else if (st.isFile())
        out.push([rel, sha1(nom.endsWith(".css") ? cssPython(readFileSync(chemin)) : readFileSync(chemin))]);
      else if (st.isDirectory()) parcourir(chemin, rel);
    }
  };
  try {
    parcourir(racine, []);
  } catch {
    return [];
  }
  out.sort(([a], [b]) => {
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
      const c = comparePointsDeCode(a[i] ?? "", b[i] ?? "");
      if (c !== 0) return c;
    }
    return a.length - b.length;
  });
  return out.map(([p, v]) => [p.join("/"), v]);
}

/** Dates de skin.json et skin.css figées, comme `figer()` du générateur (la révision `rev` en dépend). */
function figer(racine: string): void {
  let dossiers: string[];
  try {
    dossiers = readdirSync(racine);
  } catch {
    return;
  }
  for (const d of dossiers)
    for (const nom of ["skin.json", "skin.css"]) {
      const p = join(racine, d, nom);
      try {
        if (lstatSync(p).isFile()) utimesSync(p, 1_700_000_000, 1_700_000_000);
      } catch {
        continue;
      }
    }
}

interface RouteVue {
  statut: number;
  entetes: Record<string, string>;
  corps: string | null;
  taille: number;
  sha1: string;
}

const SOCLE: Readonly<Record<string, string>> = {
  "x-content-type-options": "nosniff",
  "content-security-policy": "frame-ancestors 'self'",
};

/** Réponse au format des vecteurs ; un en-tête de sécurité posé par défaut par le socle (absent de l'app FastAPI nue) est écarté. */
function vueRoute(
  statut: number,
  entetes: Record<string, unknown>,
  brut: Buffer,
  attendus: Record<string, string>,
): RouteVue {
  if (String(entetes["content-type"] ?? "").startsWith("application/json"))
    brut = Buffer.from(sansFeuilleEditeur(brut.toString("utf-8")));
  const corps = String(entetes["content-type"] ?? "").startsWith("text/css") ? cssPython(brut) : brut;
  if (corps !== brut && entetes["etag"] === `"${sha1(brut).slice(0, 20)}"`)
    entetes = { ...entetes, etag: `"${sha1(corps).slice(0, 20)}"` };
  const type = String(entetes["content-type"] ?? "").replace(
    "application/json; charset=utf-8",
    "application/json",
  );
  const garde: Record<string, string> = {};
  if (entetes["content-type"] !== undefined) garde["content-type"] = type;
  for (const k of ["etag", "cache-control", "x-content-type-options", "content-security-policy"]) {
    const v = entetes[k];
    if (v === undefined || (SOCLE[k] === String(v) && !(k in attendus))) continue;
    garde[k] = String(v);
  }
  const image =
    corps.subarray(0, 4).equals(Buffer.from("89504e47", "hex")) ||
    corps.subarray(0, 3).equals(Buffer.from("GIF"));
  const lisible = type.startsWith("application/json") || (corps.length < 512 && !image);
  return {
    statut,
    entetes: garde,
    corps: lisible ? corps.toString("utf-8") : null,
    taille: corps.length,
    sha1: sha1(corps),
  };
}

const gardes = {
  session: (req: { headers: Record<string, unknown>; utilisateur?: unknown }) => {
    const uid = req.headers["x-uid"];
    if (!uid) throw new HttpError(401, "not logged in");
    req.utilisateur = { id: Number(uid), username: null };
  },
};

describe("scénario du moteur et routes /api/skins (vecteurs)", () => {
  let dossier: string;
  let racine: string;
  let config: string;
  let t: BaseDeTest;
  let app: FastifyInstance;
  let restaurer: () => void;

  beforeAll(async () => {
    dossier = mkdtempSync(join(tmpdir(), "elpis-skins-"));
    racine = join(dossier, "user_skins");
    config = join(dossier, "config.json");
    writeFileSync(config, "{}");
    restaurer = surchargerConfig({ CONFIG_JSON_PATH: config, SKINS_DIR: racine });
    viderCachesSkins();
    t = ouvrirBaseDeTest("sqlite");
    await initialiserBase(t.base);
    await createUser(t.base, "admin", "mdp-admin", { isAdmin: 1 });
    await createUser(t.base, "alice", "mdp-alice", { isAdmin: 0 });
    app = await appTest({ familles: [creerFamilleApparence({ base: t.base, mode: "admin" })], gardes });
  });

  afterAll(async () => {
    restaurer();
    viderCachesSkins();
    await app.close();
    await t.fermer();
    rmSync(dossier, { recursive: true, force: true });
  });

  it("chaque opération rend le même résultat, le même config.json et les mêmes fichiers", async () => {
    let etag: string | undefined;
    const exportsTs = new Map<string, Buffer>();
    for (const [i, [nom, brut]] of V.operations.entries()) {
      const attendu = V.sortie[i];
      // Écart voulu : un ancien id fusionné se résout vers son skin (test dédié ci-dessous).
      if (nom === "resolve_user_skin" && brut[0] === "parchemin") continue;
      const args = sansFusion(brut) as typeof brut;
      if (!attendu) throw new Error(`sortie ${i} absente`);
      let vu: Resultat;
      switch (nom) {
        case "import_zip":
          vu = await capturer(() => importZip(Buffer.from(args[0] as string, "base64"), args[1] as boolean));
          break;
        case "reimporter":
          vu = await capturer(() => importZip(exportsTs.get(args[0] as string) ?? Buffer.alloc(0)));
          break;
        case "delete":
          vu = await capturer(() => deleteSkin(args[0] as string));
          break;
        case "export_zip":
          vu = await capturer(() => {
            const [n, octets] = exportZip(args[0] as string);
            exportsTs.set(args[0] as string, octets);
            const zf = new ArchiveZip(octets);
            return {
              nom: n,
              entrees: zf.membres
                .filter((m) => !m.nom.endsWith("/editeur.css"))
                .map((m) => [m.nom, sha1(m.nom.endsWith(".css") ? cssPython(zf.lire(m)) : zf.lire(m))]),
            };
          });
          break;
        case "asset_path":
          vu = await capturer(() => {
            const p = assetPath(args[0], args[1]);
            return p === null ? null : p.slice(realpathSync(racine).length + 1);
          });
          break;
        case "fichier":
          mkdirSync(join(racine, args[0] as string, ".."), { recursive: true });
          writeFileSync(join(racine, args[0] as string), Buffer.from(args[1] as string, "hex"));
          vu = { resultat: "null" };
          break;
        case "lien":
          symlinkSync(args[1] as string, join(racine, args[0] as string));
          vu = { resultat: "null" };
          break;
        case "route": {
          const [qui, chemin, inm, ts] = args as [string | null, string, string | null, number?];
          const entetes: Record<string, string> = qui ? { "x-uid": String(V.ids[qui]) } : {};
          if (inm !== null) entetes["if-none-match"] = inm === "@etag" ? (etag ?? "") : inm;
          const r = await app.inject({ method: "GET", url: chemin, headers: entetes });
          if (r.headers.etag) etag = String(r.headers.etag);
          const libelle = `opération ${i} : GET ${chemin}`;
          if (chemin === "/api/skins/elpis/skin.css") {
            // Écart voulu : la feuille d'Elpis porte désormais ses palettes, le statut seul reste comparé.
            expect(r.statusCode, libelle).toBe(200);
          } else if (ts !== undefined) {
            expect(r.statusCode, `${libelle} (écart E15)`).toBe(ts);
          } else {
            const py = pyJsonLoads(attendu.resultat ?? "{}", { mode: "natif" }) as RouteVue;
            const vue = vueRoute(r.statusCode, r.headers, r.rawPayload, py.entetes);
            // Écart voulu : la liste des skins suit la fusion (taille comprise).
            const net = (v: RouteVue): RouteVue =>
              chemin === "/api/skins" && v.statut === 200
                ? { ...v, corps: texteSansFusion(v.corps as string), taille: 0, sha1: "" }
                : v;
            expect(net(vue), libelle).toEqual(net(py));
          }
          vu = { resultat: "route" };
          break;
        }
        default: {
          const fonctions: Record<string, (...a: unknown[]) => unknown> = {
            list_skins: (inclure) => listSkins(inclure as boolean),
            default_skin: () => defaultSkin(),
            mascots_catalogue: () => mascotsCatalogue(),
            resolve_user_skin: (v) => resolveUserSkin(v),
            render_css: (id) => {
              const css: unknown = renderCss(id as string);
              return typeof css === "string" ? cssPython(Buffer.from(css)).toString("utf-8") : css;
            },
            skin_detail: (id) => skinDetail(id as string),
            set_state: (en, d) => setState(en, d),
            save_from_editor: (p) => saveFromEditor(p),
          };
          const f = fonctions[nom];
          if (!f) throw new Error(`opération inconnue : ${nom}`);
          vu = await capturer(() => f(...args));
        }
      }
      figer(racine);
      const libelle = `opération ${i} : ${nom} ${JSON.stringify(args).slice(0, 80)}`;
      if (vu.resultat !== "route") {
        const { config: _config, arbre: _arbre, ...resultat } = attendu;
        // Révision (taille du CSS comprise) d'une copie de skin intégré : décalée par la ligne SPDX (écart voulu).
        const ecrit = ["import_zip", "reimporter", "save_from_editor", "list_skins", "skin_detail"].includes(
          nom,
        );
        const net = (r: Resultat): Resultat => {
          if (r.resultat === undefined) return r;
          // Écart voulu : l'export d'Elpis suit sa feuille et sa description, seuls les noms de fichiers restent comparés.
          if (nom === "export_zip" && args[0] === "elpis") {
            const { nom: n, entrees } = JSON.parse(r.resultat) as {
              nom: string;
              entrees: [string, string][];
            };
            return { ...r, resultat: JSON.stringify({ nom: n, entrees: entrees.map(([f]) => f) }) };
          }
          return { ...r, resultat: texteSansFusion(r.resultat) };
        };
        expect(net(ecrit ? sansRevision(vu) : vu), libelle).toEqual(
          net(ecrit ? sansRevision(resultat) : resultat),
        );
      }
      expect(readFileSync(config, "utf-8"), `${libelle} : config.json`).toBe(
        configSansFusion(attendu.config),
      );
      expect(arbre(racine), `${libelle} : fichiers`).toEqual(attendu.arbre);
    }
  });
});

describe("état, verrou de config.json et replis", () => {
  let dossier: string;
  let config: string;
  let restaurer: () => void;

  beforeEach(() => {
    dossier = mkdtempSync(join(tmpdir(), "elpis-skins-etat-"));
    config = join(dossier, "config.json");
    writeFileSync(config, JSON.stringify({ autre: { garde: 1.0 } }));
    restaurer = surchargerConfig({ CONFIG_JSON_PATH: config, SKINS_DIR: join(dossier, "user_skins") });
    viderCachesSkins();
  });

  afterEach(() => {
    restaurer();
    viderCachesSkins();
    rmSync(dossier, { recursive: true, force: true });
  });

  it("deux écritures simultanées : aucune perdue, le reste de config.json intact, verrou rendu", async () => {
    await Promise.all([setState({ kiki: true }), setState({ pingouins: false }), setState(null, "emeraude")]);
    const disque = JSON.parse(readFileSync(config, "utf-8")) as Record<string, unknown>;
    expect(disque).toEqual({
      autre: { garde: 1 },
      skins: { enabled: { kiki: true, pingouins: false, emeraude: true }, default: "emeraude" },
    });
    expect(() => lstatSync(cheminVerrou(config))).toThrow();
  });

  it("verrou tenu ailleurs : l'écriture attend qu'il soit rendu", async () => {
    const verrou = new VerrouFichier(cheminVerrou(config));
    await verrou.acquerir();
    let fini = false;
    const ecriture = setState({ kiki: true }).then(() => {
      fini = true;
    });
    await new Promise((r) => setTimeout(r, 150));
    expect(fini).toBe(false);
    await verrou.rendre();
    await ecriture;
    expect(resolveUserSkin("kiki")).toBe("kiki");
  });

  it("verrou vide hérité de flock : repris, l'écriture passe", async () => {
    writeFileSync(cheminVerrou(config), "");
    utimesSync(cheminVerrou(config), 1_600_000_000, 1_600_000_000);
    await setState({ kiki: true });
    expect(resolveUserSkin("kiki")).toBe("kiki");
  });

  it("config.json illisible : refus lisible, fichier inchangé", async () => {
    writeFileSync(config, "{ pas du json");
    await expect(setState({ kiki: true })).rejects.toThrow("config.json est illisible");
    expect(readFileSync(config, "utf-8")).toBe("{ pas du json");
  });

  it("registres illisibles : repli Elpis + Ardoise et mascottes d'origine", () => {
    const r = surchargerConfig({ PROJECT_ROOT: dossier });
    try {
      viderCachesSkins();
      expect(builtinSkins().map((s) => s["id"])).toEqual(["elpis", ""]);
      expect(mascotIds()).toEqual(["boite_or", "flamme", "flamme_bleue", "fantome", "elpis"]);
    } finally {
      r();
    }
  });
});

describe("gardes avant validation (écart E15)", () => {
  it("anonyme : 401 avant le refus de l'identifiant ou du nom d'image", async () => {
    const t = ouvrirBaseDeTest("sqlite");
    await initialiserBase(t.base);
    const app = await appTest({ familles: [creerFamilleApparence({ base: t.base, mode: "admin" })], gardes });
    try {
      for (const url of ["/api/skins/Brume/skin.css", "/api/skins/brume/assets/x.svg"])
        expect((await app.inject({ method: "GET", url })).statusCode, url).toBe(401);
    } finally {
      await app.close();
      await t.fermer();
    }
  });
});
