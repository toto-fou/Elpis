// SPDX-License-Identifier: MIT
/** apps/core/test/admin/secrets-config.test.ts — secrets de config.json : masqués à la lecture par la console, préservés à l'écriture, absents de /api/config, jamais envoyés ailleurs par les essais du formulaire. */
import { createServer } from "node:http";
import type { Server } from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createUser, dependancesParDefaut, installerAuth, signerSession } from "@elpis/auth";
import type { DependancesAuth } from "@elpis/auth";
import type { Dict } from "@elpis/commun";
import { invalidateConfigCache, surchargerConfig } from "@elpis/config";
import { initialiserBase } from "@elpis/db";
import { ouvrirBaseDeTest } from "@elpis/db/test";
import type { BaseDeTest } from "@elpis/db/test";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { fusionVoix, ecartsVoix } from "../../src/administration/voix";
import { CHEMINS_SECRETS_CONFIG } from "@elpis/contracts";

import { dig, MASQUE_SECRET, plant, SECRETS_MASQUES } from "../../src/admin/config";
import { creerFamilleAdminConfig } from "../../src/familles/admin-config";
import { creerFamilleAdminIntegrations } from "../../src/familles/admin-integrations";
import { creerFamilleConfig, SECRET_PATHS } from "../../src/familles/config";
import { configVoix } from "../../src/voix/config";
import { appTest, journalMuet } from "../aides";

/** Une valeur distincte par secret : la fuite d'un seul est vue. */
const VALEURS: Readonly<Record<string, string>> = Object.fromEntries(
  SECRETS_MASQUES.map((c, i) => [c.join("."), `secret-n${i}-${c.join("-")}`]),
);

function configAvecSecrets(vides: readonly string[] = []): Dict {
  const cfg: Dict = {
    rag: { embed: { url: "http://emb.test", model: "m1", batch: 16 }, quotas: { collections: 4 } },
    voice: { stt: { endpoint_url: "http://stt.test", format: "whisper.cpp" } },
    llm: { compaction: { threshold_tokens: 6000 } },
  };
  for (const c of SECRETS_MASQUES)
    plant(cfg, [...c], vides.includes(c.join(".")) ? "" : VALEURS[c.join(".")]);
  return cfg;
}

describe("secrets de config.json", () => {
  let t: BaseDeTest;
  let auth: DependancesAuth;
  let dossier: string;
  let fichier: string;
  let restaurer: () => void;
  let admin: FastifyInstance;
  let main: FastifyInstance;
  let cookieBob = "";
  const serveurs: Server[] = [];

  const disque = (): Dict => JSON.parse(readFileSync(fichier, "utf8")) as Dict;
  const ecrire = (cfg: Dict): void => {
    writeFileSync(fichier, JSON.stringify(cfg));
    invalidateConfigCache();
  };
  const lire = async (): Promise<{ texte: string; cfg: Dict }> => {
    const r = await admin.inject({ method: "GET", url: "/api/admin/config-file?type=main" });
    expect(r.statusCode).toBe(200);
    const texte = (r.json() as { content: string }).content;
    return { texte, cfg: JSON.parse(texte) as Dict };
  };

  beforeAll(async () => {
    t = ouvrirBaseDeTest("sqlite");
    await initialiserBase(t.base);
    await createUser(t.base, "root", "mdp-de-root-1", { isAdmin: 1 });
    const bob = await createUser(t.base, "bob", "mdp-de-bob-1", { isAdmin: 0 });
    auth = { ...dependancesParDefaut(t.base), secret: () => "secret-de-test" };
    const t0 = Date.now() / 1000;
    cookieBob = `mcpwebui_session=${signerSession({ user_id: bob, _login_ts: t0 - 10, _sid: "s", csrf: "x" }, "secret-de-test", t0)}`;
    dossier = mkdtempSync(join(tmpdir(), "elpis-secrets-config-"));
    fichier = join(dossier, "config.json");
    restaurer = surchargerConfig({ CONFIG_JSON_PATH: fichier });
    admin = await appTest({
      mode: "admin",
      familles: [
        creerFamilleAdminConfig({ journal: journalMuet }),
        creerFamilleAdminIntegrations({ journal: journalMuet }),
      ],
      gardes: {
        admin: () => undefined,
        staff: () => undefined,
        session: (req) => {
          req.utilisateur = { id: 1, username: "root" };
        },
      },
    });
    main = await appTest({
      familles: [creerFamilleConfig({ auth, racine: dossier })],
      extensions: [(a) => installerAuth(a, auth)],
    });
  });

  afterAll(async () => {
    await admin.close();
    await main.close();
    restaurer();
    await t.fermer();
    rmSync(dossier, { recursive: true, force: true });
  });

  beforeEach(() => ecrire(configAvecSecrets()));

  afterEach(async () => {
    for (const s of serveurs.splice(0)) await new Promise<void>((fini) => s.close(() => fini()));
    delete process.env["RAG_SERVICE_URL"];
    delete process.env["RAG_SERVICE_TOKEN"];
  });

  it("lecture par la console : chaque secret non vide vaut le masque, les voisins et les secrets vides sont rendus tels quels", async () => {
    ecrire(configAvecSecrets(["rag.service_token"]));
    const { texte, cfg } = await lire();
    for (const [chemin, valeur] of Object.entries(VALEURS)) expect(texte, chemin).not.toContain(valeur);
    for (const c of SECRETS_MASQUES) {
      const attendu = c.join(".") === "rag.service_token" ? "" : MASQUE_SECRET;
      expect(dig(cfg, c), c.join(".")).toEqual([true, attendu]);
    }
    expect(cfg["rag"]).toMatchObject({ embed: { url: "http://emb.test", model: "m1", batch: 16 } });
    expect(cfg["voice"]).toMatchObject({ stt: { endpoint_url: "http://stt.test" } });
    expect(cfg["llm"]).toEqual({ compaction: { threshold_tokens: 6000 } });
  });

  it("fichier illisible : les valeurs des clés de secrets sont tout de même masquées", async () => {
    writeFileSync(
      fichier,
      `{"rag": {"embed": {"api_key": "cle-a-masquer", "model": "m1"}, "service_token": "jeton-a-masquer"}, "voice": {"stt": {"token": "tok-voix"}}, "mcp": {"local_client_tokens": {"jeton-client-cache": "u:fs"}}, "x": `,
    );
    invalidateConfigCache();
    const r = await admin.inject({ method: "GET", url: "/api/admin/config-file?type=main" });
    const contenu = (r.json() as { content: string }).content;
    for (const fuite of ["cle-a-masquer", "jeton-a-masquer", "tok-voix", "jeton-client-cache", "u:fs"])
      expect(contenu).not.toContain(fuite);
    expect(contenu).toContain('"model": "m1"');
    expect(contenu).toContain(MASQUE_SECRET);
  });

  it("écriture du fichier entier : le masque rendu garde les valeurs du disque, une valeur saisie remplace la sienne seule", async () => {
    const { texte, cfg } = await lire();
    const envoi = async (corps: Dict) =>
      admin.inject({
        method: "POST",
        url: "/api/admin/config-file",
        headers: { "content-type": "application/json" },
        payload: JSON.stringify({ type: "main", content: JSON.stringify(corps) }),
      });
    expect(
      (
        await admin.inject({
          method: "POST",
          url: "/api/admin/config-file",
          headers: { "content-type": "application/json" },
          payload: JSON.stringify({ type: "main", content: texte }),
        })
      ).statusCode,
    ).toBe(200);
    for (const c of SECRETS_MASQUES)
      expect(dig(disque(), c), c.join(".")).toEqual([true, VALEURS[c.join(".")]]);
    plant(cfg, ["rag", "embed", "api_key"], "cle-saisie-dans-la-console");
    plant(cfg, ["rag", "embed", "model"], "m2");
    expect((await envoi(cfg)).statusCode).toBe(200);
    const apres = disque();
    expect(dig(apres, ["rag", "embed", "api_key"])).toEqual([true, "cle-saisie-dans-la-console"]);
    expect(dig(apres, ["rag", "embed", "model"])).toEqual([true, "m2"]);
    for (const c of SECRETS_MASQUES.filter((x) => x.join(".") !== "rag.embed.api_key"))
      expect(dig(apres, c), c.join(".")).toEqual([true, VALEURS[c.join(".")]]);
  });

  it("écriture champ par champ : le masque ne remplace jamais une clé, une valeur saisie la remplace sans conflit, un secret changé ailleurs n'est pas un conflit", async () => {
    const patch = (changes: Dict[]) =>
      admin.inject({
        method: "PATCH",
        url: "/api/admin/config",
        headers: { "content-type": "application/json" },
        payload: JSON.stringify({ changes }),
      });
    // `image.api_key_enc` est écrit par son seul écran (zone possédée) : la console ne le modifie jamais par PATCH.
    const conserve = await patch(
      SECRETS_MASQUES.filter((c) => c.join(".") !== "image.api_key_enc").map((c) => ({
        path: c.join("."),
        from: MASQUE_SECRET,
        to: MASQUE_SECRET,
      })),
    );
    expect(conserve.statusCode).toBe(200);
    for (const c of SECRETS_MASQUES)
      expect(dig(disque(), c), c.join(".")).toEqual([true, VALEURS[c.join(".")]]);
    const cfg = disque();
    plant(cfg, ["voice", "stt", "token"], "jeton-change-ailleurs");
    ecrire(cfg);
    const neuf = await patch([
      { path: "voice.stt.token", from: MASQUE_SECRET, to: "jeton-voix-neuf" },
      { path: "rag.service_token", from: MASQUE_SECRET, to: "jeton-rag-neuf" },
      { path: "rag.embed.model", from: "m1", to: "m3" },
    ]);
    expect(neuf.statusCode, neuf.body).toBe(200);
    const apres = disque();
    expect(dig(apres, ["voice", "stt", "token"])).toEqual([true, "jeton-voix-neuf"]);
    expect(dig(apres, ["rag", "service_token"])).toEqual([true, "jeton-rag-neuf"]);
    expect(dig(apres, ["rag", "embed", "model"])).toEqual([true, "m3"]);
    expect(dig(apres, ["rag", "embed", "api_key"])).toEqual([true, VALEURS["rag.embed.api_key"]]);
  });

  it("/api/config d'un compte ordinaire ne rend aucun secret, y compris la clé des embeddings", async () => {
    const cfg = configAvecSecrets();
    plant(cfg, ["metrics", "scrape_token"], "jeton-prometheus-secret");
    ecrire(cfg);
    const r = await main.inject({ method: "GET", url: "/api/config", headers: { cookie: cookieBob } });
    expect(r.statusCode).toBe(200);
    for (const [chemin, valeur] of Object.entries(VALEURS)) expect(r.body, chemin).not.toContain(valeur);
    expect(r.body).not.toContain("jeton-prometheus-secret");
    expect((r.json() as { config: Dict }).config["rag"]).toMatchObject({
      embed: { model: "m1", api_key: "" },
    });
  });

  it("la liste des secrets masqués à la console et celle blanchie pour les comptes disent la même chose", () => {
    const masques = SECRETS_MASQUES.map((c) => c.join(".")).sort();
    // Hors du masque : le jeton de scrape, que sa page montre à l'administrateur.
    const blanchis = SECRET_PATHS.filter((p) => p !== "metrics.scrape_token").sort();
    expect(masques).toEqual(blanchis);
    expect([...CHEMINS_SECRETS_CONFIG].sort()).toEqual(masques);
  });

  it("jetons clients du pont MCP (un objet dont les clés sont les jetons) : masqués en bloc, gardés à l'écriture", async () => {
    const cfg = configAvecSecrets();
    plant(cfg, ["mcp", "local_client_tokens"], { "jeton-client-tres-secret": "alice:fs+git" });
    ecrire(cfg);
    const { texte, cfg: vu } = await lire();
    expect(texte).not.toContain("jeton-client-tres-secret");
    expect(dig(vu, ["mcp", "local_client_tokens"])).toEqual([true, MASQUE_SECRET]);
    const r = await admin.inject({
      method: "POST",
      url: "/api/admin/config-file",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ type: "main", content: texte }),
    });
    expect(r.statusCode).toBe(200);
    expect(dig(disque(), ["mcp", "local_client_tokens"])).toEqual([
      true,
      { "jeton-client-tres-secret": "alice:fs+git" },
    ]);
    plant(cfg, ["mcp", "local_client_tokens"], {});
    ecrire(cfg);
    expect(dig((await lire()).cfg, ["mcp", "local_client_tokens"])).toEqual([true, {}]);
  });

  it("essai de l'extracteur avec le masque : le jeton enregistré part à l'adresse enregistrée, jamais ailleurs", async () => {
    const recus: { port: number; auth: string }[] = [];
    const demarrer = async (): Promise<string> => {
      const s = createServer((req, res) => {
        recus.push({
          port: (s.address() as { port: number }).port,
          auth: String(req.headers["authorization"] ?? ""),
        });
        res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true,"version":"x"}');
      });
      await new Promise<void>((fini) => s.listen(0, "127.0.0.1", () => fini()));
      serveurs.push(s);
      return `http://127.0.0.1:${(s.address() as { port: number }).port}`;
    };
    const enregistree = await demarrer();
    const autre = await demarrer();
    const cfg = configAvecSecrets();
    plant(cfg, ["rag", "service_url"], enregistree);
    plant(cfg, ["rag", "service_token"], "JETON-ENREGISTRE");
    ecrire(cfg);
    const essai = async (corps: Dict): Promise<Dict> =>
      (
        await admin.inject({
          method: "POST",
          url: "/api/admin/rag-service/test",
          headers: { "content-type": "application/json" },
          payload: JSON.stringify(corps),
        })
      ).json() as Dict;
    expect(await essai({ url: enregistree, token: MASQUE_SECRET })).toMatchObject({ ok: true });
    expect(await essai({ url: `${enregistree}/`, token: MASQUE_SECRET })).toMatchObject({ ok: true });
    expect(await essai({ url: autre, token: MASQUE_SECRET })).toMatchObject({ ok: true });
    expect(await essai({ url: autre, token: "saisi" })).toMatchObject({ ok: true });
    expect(recus.map((r) => r.auth)).toEqual([
      "Bearer JETON-ENREGISTRE",
      "Bearer JETON-ENREGISTRE",
      "",
      "Bearer saisi",
    ]);
  });

  it("essai du moteur vocal avec le masque : le jeton enregistré pour la même adresse seulement, aucun écart signalé", () => {
    const voix = configVoix({
      voice: {
        enabled: true,
        stt: { endpoint_url: "http://stt.test/", format: "whisper.cpp", token: "JETON-STT" },
        tts: { endpoint_url: "http://tts.test", format: "elpis-tts", token: "JETON-TTS" },
      },
    });
    const meme = { stt: { endpoint_url: "http://stt.test", token: MASQUE_SECRET } };
    expect(fusionVoix(voix, meme, "stt")["token"]).toBe("JETON-STT");
    expect(ecartsVoix(voix, meme)).toEqual([]);
    expect(fusionVoix(voix, { stt: { token: MASQUE_SECRET } }, "stt")["token"]).toBe("JETON-STT");
    const ailleurs = { tts: { endpoint_url: "http://pirate.test", token: MASQUE_SECRET } };
    expect(fusionVoix(voix, ailleurs, "tts")["token"]).toBe("");
    expect(
      fusionVoix(voix, { tts: { endpoint_url: "http://tts.test", token: "saisi" } }, "tts")["token"],
    ).toBe("saisi");
    expect(JSON.stringify(fusionVoix(voix, ailleurs, "tts"))).not.toContain("JETON-TTS");
  });
});
