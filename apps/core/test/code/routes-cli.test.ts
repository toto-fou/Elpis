// SPDX-License-Identifier: MIT
/** apps/core/test/code/routes-cli.test.ts — distribution d'opencode rejouée contre la vraie app FastAPI : installeurs à l'octet, opencode.json, familles MCP, bundles, CA ; inventaire, ASCII du .ps1, syntaxe bash. */
import { execFile, spawnSync } from "node:child_process";
import { createHash, X509Certificate } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:https";
import type { OutgoingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { creerGardes, creerJeton, installerAuth, signerSession } from "@elpis/auth";
import type { DependancesAuth, DependancesJetons } from "@elpis/auth";
import { pyJsonDumps, pyJsonLoads } from "@elpis/commun";
import { configView, invalidateConfigCache, racineDepot, surchargerConfig } from "@elpis/config";
import { initialiserBase } from "@elpis/db";
import { ouvrirBaseDeTest } from "@elpis/db/test";
import type { BaseDeTest } from "@elpis/db/test";
import { oublierManifeste } from "@elpis/mcp";
import { oublierConfigurationAudit } from "@elpis/securite";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  INSTALL_PS1_PYTHON,
  INSTALL_PS1_TEMPLATE,
  INSTALL_SH_PYTHON,
  INSTALL_SH_TEMPLATE,
} from "../../src/code/installeurs";
import {
  creerFamilleCli,
  FALLBACK_MODELS,
  limiteSortie,
  MODEL_DISPLAY_NAMES,
  TOKEN_PLACEHOLDER,
} from "../../src/familles/cli";
import { modelCache, viderCacheModeles } from "../../src/llm/cache-modeles";
import { cachedContextSize } from "../../src/llm/modeles";
import { ingestTools, reinitialiserRegistre } from "../../src/outils/categories";
import { creerFamilleInterface } from "../../src/familles/interface";
import { appTest } from "../aides";
import { CA_TEST, CERT_SERVEUR } from "../llm/pki-test";
import { sansEmpreinteCa } from "./ecart-empreinte-ca";

type Dict = Record<string, unknown>;
type Etape = {
  m?: string;
  p?: string;
  hote?: string;
  u?: string;
  h?: Record<string, string>;
  jeton?: string;
  type?: string;
  capture?: string;
  config?: unknown;
  env?: Record<string, string | null>;
  etat?: Dict;
};
type Reponse = {
  statut?: number;
  corps?: string | { sha256: string; taille: number };
  type?: string | null;
  disposition?: string | null;
  allow?: string | null;
  longueur?: string | null;
};

const V = pyJsonLoads(readFileSync(new URL("../vecteurs/code-cli.json", import.meta.url), "utf-8")) as {
  comptes: [string, number][];
  etapes: Etape[];
  ids: Record<string, number>;
  reponses: Reponse[];
  fonctions: {
    sorties: { contexte: number; sortie: number }[];
    fallback: unknown;
    noms: unknown;
    placeholder: string;
  };
};
const T = 1_791_331_200;
const SECRET = "secret-de-test-cli";
const PEM = "-----BEGIN CERTIFICATE-----\nZmFrZQ==\n-----END CERTIFICATE-----\n";

/** Sondes ramenées à celles du Python (HEAD) pour comparer les installeurs à l'octet. */
function versSondesPython(texte: string): string {
  return texte.split('-o /dev/null "').join('--head "').split("-Method Get -Uri").join("-Method Head -Uri");
}

/** CA de test et certificat de 127.0.0.1 signé par elle. */
function pkiDeTest(d: string): { ca: string; cle: Buffer; cert: Buffer } {
  const openssl = (...args: string[]): void => {
    const r = spawnSync("openssl", args, { cwd: d, encoding: "utf-8" });
    if (r.status !== 0) throw new Error(r.stderr);
  };
  const ec = ["-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes"];
  openssl(
    "req",
    "-x509",
    ...ec,
    "-keyout",
    "ca.key",
    "-out",
    "ca.crt",
    "-days",
    "2",
    "-subj",
    "/CN=CA de test",
  );
  openssl("req", ...ec, "-keyout", "serveur.key", "-out", "serveur.csr", "-subj", "/CN=127.0.0.1");
  writeFileSync(path.join(d, "ext.cnf"), "subjectAltName=IP:127.0.0.1\nextendedKeyUsage=serverAuth\n");
  openssl(
    "x509",
    "-req",
    "-in",
    "serveur.csr",
    "-CA",
    "ca.crt",
    "-CAkey",
    "ca.key",
    "-CAcreateserial",
    "-out",
    "serveur.crt",
    "-days",
    "2",
    "-extfile",
    "ext.cnf",
  );
  return {
    ca: path.join(d, "ca.crt"),
    cle: readFileSync(path.join(d, "serveur.key")),
    cert: readFileSync(path.join(d, "serveur.crt")),
  };
}

/** Les trois sondes HTTPS d'un install.sh (téléchargements, CA déjà reconnue, app), extraites telles quelles. */
function sondesBash(script: string): string {
  const entre = (debut: string, fin: string): string => {
    const i = script.indexOf(debut);
    const j = script.indexOf(fin, i);
    if (i < 0 || j < 0) throw new Error(`bloc introuvable : ${debut}`);
    return script.slice(i, j);
  };
  return [
    entre('if [ "${BASE#https://}" != "$BASE" ]; then', "fetch()  {"),
    entre("ca_already_trusted() {", 'if [ -n "$CA_FILE" ]; then\n  WANT_TRUST'),
    entre('APP_TLS=""', "echo \"Téléchargement d'OpenCode"),
  ].join("\n");
}

let dossier: string;
const envAvant = { ...process.env };

beforeAll(() => {
  dossier = mkdtempSync(path.join(tmpdir(), "elpis-cli-"));
  process.env["ELPIS_AUDIT_DIR"] = path.join(dossier, "audit");
  process.env["APP_MCP_MANIFEST"] = path.join(dossier, "absent-mcp.json");
  for (const k of [
    "OPENCODE_DIST_DIR",
    "ELPIS_CA_FILE",
    "LOCAL_MCP_OPENCODE_FAMILIES",
    "LOCAL_MCP_URL",
    "LOCAL_MCP_TOKEN",
  ])
    delete process.env[k];
  oublierConfigurationAudit();
  oublierManifeste();
});

afterAll(() => {
  for (const k of Object.keys(process.env)) if (!(k in envAvant)) delete process.env[k];
  Object.assign(process.env, envAvant);
  oublierConfigurationAudit();
  oublierManifeste();
  viderCacheModeles();
  cachedContextSize.clear();
  reinitialiserRegistre();
  rmSync(dossier, { recursive: true, force: true });
});

describe("constantes et fonctions rejouées", () => {
  it("modèles de repli, noms affichés, espace réservé du jeton", () => {
    expect(pyJsonDumps(FALLBACK_MODELS)).toBe(pyJsonDumps(V.fonctions.fallback));
    expect(pyJsonDumps(MODEL_DISPLAY_NAMES)).toBe(pyJsonDumps(V.fonctions.noms));
    expect(TOKEN_PLACEHOLDER).toBe(V.fonctions.placeholder);
  });

  it.each(V.fonctions.sorties.map((c) => [c.contexte, c.sortie] as const))(
    "_output_limit(%s)",
    (ctx, sortie) => {
      expect(limiteSortie(Number(ctx))).toBe(Number(sortie));
    },
  );

  it("gabarits : .ps1 100 % ASCII, install.sh valide pour bash -n, sondes HTTPS en GET (seul écart au Python)", () => {
    expect([...INSTALL_PS1_TEMPLATE].every((c) => (c.codePointAt(0) ?? 0) < 128)).toBe(true);
    const r = spawnSync("bash", ["-n"], { input: INSTALL_SH_TEMPLATE, encoding: "utf-8" });
    expect([r.status, r.stderr]).toEqual([0, ""]);
    expect([INSTALL_SH_TEMPLATE.includes("--head"), INSTALL_PS1_TEMPLATE.includes("-Method Head")]).toEqual([
      false,
      false,
    ]);
    expect(INSTALL_SH_TEMPLATE.split('curl -fsS -m 5 -o /dev/null "').length - 1).toBe(3);
    expect(INSTALL_SH_TEMPLATE).toContain('--cacert "$CA_FILE" -o /dev/null "$BASE/api/cli/opencode.json"');
    expect(INSTALL_PS1_TEMPLATE.split("Invoke-WebRequest -UseBasicParsing -Method Get -Uri").length - 1).toBe(
      2,
    );
    expect([versSondesPython(INSTALL_SH_TEMPLATE), versSondesPython(INSTALL_PS1_TEMPLATE)]).toEqual([
      INSTALL_SH_PYTHON,
      INSTALL_PS1_PYTHON,
    ]);
  });
});

describe("différentiel contre la vraie app FastAPI", () => {
  let t: BaseDeTest;
  let app: FastifyInstance;
  let restaurer: () => void;
  let config: string;
  let dist: string;
  let ca: string;
  let auth: DependancesAuth & DependancesJetons;

  beforeEach(async () => {
    const essai = mkdtempSync(path.join(dossier, "essai-"));
    dist = path.join(essai, "dist");
    ca = path.join(essai, "ca");
    mkdirSync(path.join(dist, "opencode-linux.aaa"), { recursive: true });
    mkdirSync(ca);
    writeFileSync(path.join(dist, "opencode-linux.tar.gz"), "FAKE-LINUX");
    writeFileSync(path.join(dist, "opencode-linux.zip"), "AUTRE-LINUX");
    writeFileSync(path.join(dist, "opencode-macos.zip"), "MAC");
    writeFileSync(path.join(dist, "opencode-windows.é.zip"), "WIN");
    writeFileSync(path.join(essai, "dehors.bin"), "DEHORS");
    symlinkSync(path.join(essai, "dehors.bin"), path.join(dist, "opencode-darwin.bin"));
    symlinkSync(path.join(essai, "dehors.bin"), path.join(dist, "opencode-macos.000"));
    writeFileSync(path.join(ca, "ca.crt"), PEM);
    t = ouvrirBaseDeTest("sqlite");
    await initialiserBase(t.base);
    for (const [nom, admin] of V.comptes)
      await t.base.run(
        "INSERT INTO users(username, pass_salt, pass_hash, created_at, is_admin) VALUES (?, 's', 'h', 0, ?)",
        [nom, admin],
      );
    config = path.join(essai, "config.json");
    writeFileSync(config, "{}");
    restaurer = surchargerConfig({
      CONFIG_JSON_PATH: config,
      LLAMA_URL: "http://10.9.8.7:1234/v1/chat/completions",
      LOCAL_MCP_URL: "",
      LOCAL_MCP_TOKEN: "",
      LOCAL_MCP_PUBLIC_URL: "",
      LOCAL_MCP_SERVERS_RAW: {},
      LOCAL_MCP_OPENCODE_FAMILIES: "git,browser,desktop",
    });
    oublierManifeste();
    viderCacheModeles();
    cachedContextSize.clear();
    reinitialiserRegistre({ cheminCache: path.join(essai, "categories.json") });
    auth = {
      base: t.base,
      config: () => configView(),
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
    app = await appTest({
      familles: [creerFamilleCli({ base: t.base, auth })],
      gardes: creerGardes(auth),
      extensions: [(a) => installerAuth(a, auth)],
    });
  });

  afterEach(async () => {
    await app.close();
    restaurer();
    delete process.env["OPENCODE_DIST_DIR"];
    delete process.env["ELPIS_CA_FILE"];
    await t.fermer();
  });

  it("131 étapes : statut, corps (installeurs à l'octet), type et disposition ; HEAD : 405, Allow et longueur", async () => {
    const jetons = new Map<string, string>();
    const placer = (texte: string): string => {
      let s = texte.split("<DIST>").join(dist).split("<CA>").join(ca);
      for (const nom of [...jetons.keys()].sort((a, b) => b.length - a.length))
        s = s.split("$" + nom).join(jetons.get(nom) ?? "");
      return s;
    };
    const anonymiser = (texte: string): string => {
      let s = texte.split(dist).join("<DIST>").split(ca).join("<CA>").split(racineDepot()).join("<RACINE>");
      for (const [nom, v] of jetons) s = s.split(v).join("$" + nom);
      return s;
    };
    const ecarts: string[] = [];
    for (const [i, e] of V.etapes.entries()) {
      const attendu = V.reponses[i] as Reponse;
      if (e.jeton !== undefined) {
        const uid = V.ids[e.jeton] as number;
        const [tok] = await creerJeton(
          auth,
          uid,
          e.type ?? "opencode",
          "",
          e.type === "tools" ? ["git"] : undefined,
        );
        jetons.set(e.capture ?? "", tok);
        continue;
      }
      if (e.config !== undefined) {
        writeFileSync(config, placer(pyJsonDumps(e.config, { ensureAscii: false })));
        invalidateConfigCache();
        continue;
      }
      if (e.env !== undefined) {
        for (const [k, v] of Object.entries(e.env)) {
          if (v === null) delete process.env[k];
          else process.env[k] = placer(v);
        }
        continue;
      }
      if (e.etat !== undefined) {
        const et = e.etat;
        if ("cache" in et) {
          viderCacheModeles();
          Object.assign(modelCache, et["cache"]);
        }
        if ("contextes" in et) {
          cachedContextSize.clear();
          for (const [k, v] of Object.entries(et["contextes"] as Dict)) cachedContextSize.set(k, Number(v));
        }
        const reglages: Dict = {};
        if ("mcp_url" in et) reglages["LOCAL_MCP_URL"] = et["mcp_url"];
        if ("mcp_jeton" in et) reglages["LOCAL_MCP_TOKEN"] = et["mcp_jeton"];
        if ("url_publique" in et) reglages["LOCAL_MCP_PUBLIC_URL"] = et["url_publique"];
        if ("familles_opencode" in et) reglages["LOCAL_MCP_OPENCODE_FAMILIES"] = et["familles_opencode"];
        if ("serveurs_locaux" in et) reglages["LOCAL_MCP_SERVERS_RAW"] = et["serveurs_locaux"];
        if (Object.keys(reglages).length > 0) surchargerConfig(reglages);
        oublierManifeste();
        if ("outils" in et) ingestTools(et["outils"] as unknown[], "test");
        if ("reglages" in et)
          for (const [nom, r] of Object.entries(et["reglages"] as Dict))
            await t.base.run("UPDATE users SET settings_json=? WHERE id=?", [
              pyJsonDumps(r),
              V.ids[nom] as number,
            ]);
        continue;
      }
      const entetes: Record<string, string> = { host: e.hote ?? "lan.test:8000" };
      if (e.u)
        entetes["cookie"] =
          `mcpwebui_session=${signerSession({ user_id: V.ids[e.u], _login_ts: T - 10 }, SECRET, T)}`;
      for (const [k, v] of Object.entries(e.h ?? {})) entetes[k] = placer(v);
      const r = await app.inject({ method: e.m as "GET", url: e.p ?? "", headers: entetes });
      const texte = anonymiser(versSondesPython(sansEmpreinteCa(r.body)));
      const corps =
        typeof attendu.corps === "object"
          ? { sha256: createHash("sha256").update(texte).digest("hex"), taille: Array.from(texte).length }
          : texte;
      const type = r.headers["content-type"] as string | undefined;
      const obtenu = {
        statut: r.statusCode,
        corps,
        type: type === "application/json; charset=utf-8" ? "application/json" : (type ?? null),
        disposition: (r.headers["content-disposition"] as string | undefined) ?? null,
        ...(e.m === "HEAD"
          ? {
              allow: (r.headers["allow"] as string | undefined) ?? null,
              longueur: (r.headers["content-length"] as string | undefined) ?? null,
            }
          : {}),
      };
      if (pyJsonDumps(obtenu) !== pyJsonDumps(attendu)) {
        const a = typeof attendu.corps === "string" ? attendu.corps : "";
        let k = 0;
        while (k < a.length && a[k] === texte[k]) k++;
        ecarts.push(
          `${i} ${e.p} attendu ${pyJsonDumps({ ...attendu, corps: undefined })} obtenu ${pyJsonDumps({ ...obtenu, corps: undefined })}\n` +
            `  corps à partir de ${k} : attendu ${JSON.stringify(a.slice(k, k + 160))}\n  obtenu ${JSON.stringify(texte.slice(k, k + 160))}`,
        );
      }
    }
    expect(ecarts).toEqual([]);
  }, 60_000);

  it("la CA est servie comme la FileResponse de Starlette : ETag, plages d'octets, 400 et 416, jamais de 304", async () => {
    process.env["ELPIS_CA_FILE"] = path.join(ca, "ca.crt");
    const complet = await app.inject({ method: "GET", url: "/api/cli/ca.crt" });
    const etag = complet.headers["etag"] as string;
    expect([complet.statusCode, complet.body, complet.headers["content-type"]]).toEqual([
      200,
      PEM,
      "application/x-pem-file",
    ]);
    expect(complet.headers["content-disposition"]).toBe('attachment; filename="ca.crt"');
    expect(complet.headers["accept-ranges"]).toBe("bytes");
    expect(etag).toMatch(/^"[0-9a-f]{32}"$/);
    expect(complet.headers["last-modified"]).toMatch(/GMT$/);
    const sous = await app.inject({ method: "GET", url: "/api/cli/ca.crt", headers: { range: "bytes=2-6" } });
    expect([sous.statusCode, sous.body, sous.headers["content-range"]]).toEqual([
      206,
      PEM.slice(2, 7),
      `bytes 2-6/${PEM.length}`,
    ]);
    const meme = await app.inject({
      method: "GET",
      url: "/api/cli/ca.crt",
      headers: { "if-none-match": etag, "if-modified-since": complet.headers["last-modified"] as string },
    });
    expect([meme.statusCode, meme.body]).toEqual([200, PEM]);
    const mal = await app.inject({ method: "GET", url: "/api/cli/ca.crt", headers: { range: "bytes" } });
    expect([mal.statusCode, mal.body]).toEqual([400, "Malformed range header."]);
    const unite = await app.inject({ method: "GET", url: "/api/cli/ca.crt", headers: { range: "octets=1" } });
    expect([unite.statusCode, unite.body]).toEqual([400, "Only support bytes range"]);
    const hors = await app.inject({
      method: "GET",
      url: "/api/cli/ca.crt",
      headers: { range: `bytes=${PEM.length + 5}-` },
    });
    expect([hors.statusCode, hors.headers["content-range"]]).toEqual([416, `bytes */${PEM.length}`]);
  });

  it("installeurs : empreinte SHA-256 (DER) de la CA servie inscrite dans le script, vérifiée par le bash ; CA absente, illisible ou configuration mal formée : empreinte vide", async () => {
    const vraie = path.join(ca, "vraie.crt");
    const autre = path.join(ca, "autre.crt");
    writeFileSync(vraie, CA_TEST);
    writeFileSync(autre, CERT_SERVEUR);
    const empreinte = createHash("sha256").update(new X509Certificate(CA_TEST).raw).digest("hex");
    const scripts = async (): Promise<[string, string]> => {
      const sh = await app.inject({
        method: "GET",
        url: "/api/cli/install.sh",
        headers: { host: "lan.test:8000" },
      });
      const ps1 = await app.inject({
        method: "GET",
        url: "/api/cli/install.ps1",
        headers: { host: "lan.test:8000" },
      });
      expect([sh.statusCode, ps1.statusCode]).toEqual([200, 200]);
      return [sh.body, ps1.body];
    };
    process.env["ELPIS_CA_FILE"] = vraie;
    const [sh, ps1] = await scripts();
    expect(sh).toContain(`CA_SHA256="${empreinte}"`);
    expect(ps1).toContain(`$CaSha256 = '${empreinte}'`);
    const debut = sh.indexOf("CA_SHA256=");
    const fonctions = sh.slice(debut, sh.indexOf("\n", sh.indexOf("ca_matches() {", debut)) + 1);
    const verdict = (fichier: string): string =>
      spawnSync("bash", ["-c", `${fonctions}ca_matches "$1" && echo ok || echo refus`, "_", fichier], {
        encoding: "utf-8",
      }).stdout.trim();
    expect([verdict(vraie), verdict(autre), verdict(path.join(ca, "ca.crt"))]).toEqual([
      "ok",
      "refus",
      "refus",
    ]);
    for (const chemin of [path.join(ca, "absente.crt"), path.join(ca, "ca.crt")]) {
      process.env["ELPIS_CA_FILE"] = chemin;
      const [s, p] = await scripts();
      expect(s, chemin).toContain('CA_SHA256=""');
      expect(p, chemin).toContain("$CaSha256 = ''");
    }
    delete process.env["ELPIS_CA_FILE"];
    writeFileSync(config, JSON.stringify({ security: "x" }));
    invalidateConfigCache();
    const [s] = await scripts();
    expect(s).toContain('CA_SHA256=""');
  });

  it("sonde HTTPS de install.sh contre un frontal TLS : certificat valide = vérifié, CA locale = --cacert, jamais -k", async () => {
    const pki = pkiDeTest(mkdtempSync(path.join(dossier, "pki-")));
    const appTls = await appTest({
      familles: [creerFamilleCli({ base: t.base, auth }), creerFamilleInterface("main")],
      gardes: creerGardes(auth),
      extensions: [(a) => installerAuth(a, auth)],
    });
    const frontal = createServer({ key: pki.cle, cert: pki.cert }, (req, res) => {
      appTls
        .inject({ method: req.method as "GET", url: req.url ?? "/", headers: req.headers })
        .then((r) => {
          res.writeHead(r.statusCode, r.headers as OutgoingHttpHeaders);
          res.end(r.rawPayload);
        })
        .catch(() => res.destroy());
    });
    await new Promise<void>((ok) => frontal.listen(0, "127.0.0.1", ok));
    const base = `https://127.0.0.1:${(frontal.address() as AddressInfo).port}`;
    const maison = mkdtempSync(path.join(dossier, "maison-"));
    const sonder = async (script: string, confiance: boolean): Promise<string> => {
      const prefixe = `set -u\nBASE="${base}"\nAPP_URL="${base}"\nCA_FILE="${pki.ca}"\nCA_DST="${maison}/copie.crt"\nCURL_TLS=""\n`;
      const suffixe =
        '\nif ca_already_trusted; then echo "DEJA=oui"; else echo "DEJA=non"; fi\n' +
        'echo "CURL_TLS=[$CURL_TLS] APP_TLS=[$APP_TLS]"\n';
      const env: NodeJS.ProcessEnv = {
        PATH: process.env["PATH"],
        HOME: maison,
        NO_PROXY: "*",
        no_proxy: "*",
      };
      if (confiance) env["CURL_CA_BUNDLE"] = pki.ca;
      const { stdout } = await promisify(execFile)("bash", ["-c", prefixe + sondesBash(script) + suffixe], {
        env,
      });
      return stdout;
    };
    try {
      const rendu = (
        await app.inject({ method: "GET", url: "/api/cli/install.sh", headers: { host: "lan.test" } })
      ).body;
      const valide = await sonder(rendu, true);
      expect(valide).toContain("DEJA=oui\nCURL_TLS=[] APP_TLS=[]\n");
      expect(valide).not.toContain("non vérifié");
      const caLocale = await sonder(rendu, false);
      expect(caLocale).toContain("Téléchargements https vérifiés via la CA locale.");
      expect(caLocale).toContain(`DEJA=non\nCURL_TLS=[--cacert ${pki.ca}] APP_TLS=[--cacert ${pki.ca}]\n`);
      for (const url of ["/api/cli/opencode.json", "/api/public-config"])
        expect((await appTls.inject({ method: "GET", url })).statusCode, url).toBe(200);
    } finally {
      await new Promise<void>((ok) => frontal.close(() => ok()));
      await appTls.close();
    }
  }, 30_000);

  it("inventaire : 6 routes /api/cli et les 2 alias courts, publics, dans main", () => {
    const inventaire = JSON.parse(
      readFileSync(new URL("../../../../migration-kit/routes.inventory.json", import.meta.url), "utf-8"),
    ) as { routes: { methodes: string[]; chemin: string; process: string[] }[] };
    const attendues = inventaire.routes.filter(
      (r) => r.chemin.startsWith("/api/cli/") || r.chemin === "/opencode" || r.chemin === "/opencode.ps1",
    );
    expect(attendues).toHaveLength(8);
    const montees = app.elpis.routes.filter((r) => r.famille === "cli");
    expect(montees.map((r) => r.chemin).sort()).toEqual(
      attendues.map((r) => r.chemin.replace("{os_key}", ":os_key")).sort(),
    );
    expect(new Set(montees.map((r) => r.acces))).toEqual(new Set(["public"]));
    expect(new Set(attendues.flatMap((r) => r.process))).toEqual(new Set(["main"]));
  });
});
