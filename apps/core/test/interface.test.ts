// SPDX-License-Identifier: MIT
/** apps/core/test/interface.test.ts — pages, configuration publique, logo d'accueil, voix et hôte d'écoute (vecteurs Python). */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { invalidateConfigCache, surchargerConfig } from "@elpis/config";

import { creerApp } from "../src/app";
import {
  CHEMIN_APERCU_CODE,
  PAGE_APERCU_CODE,
  POLITIQUE_APERCU_CODE,
  POLITIQUE_CSP,
} from "../src/interface/pages";
import { hotePourConfig, hoteParDefaut } from "../src/ecoute";
import { configVoix, drapeauxVoix } from "../src/voix/config";
import { journalMuet } from "./aides";

const vecteurs = JSON.parse(
  readFileSync(new URL("./vecteurs/voix-ecoute.json", import.meta.url), "utf-8"),
) as {
  voix: { section: unknown; config: unknown; drapeaux: [boolean, boolean] }[];
  hotes: (
    { config: Record<string, unknown>; hote: string } | { config: Record<string, unknown>; erreur: string }
  )[];
  fichiers: { cas: string; contenu: string | null; hote: string }[];
};

const dossier = mkdtempSync(join(tmpdir(), "elpis-interface-"));
afterAll(() => rmSync(dossier, { recursive: true, force: true }));

async function avecConfig(contenu: unknown, f: () => Promise<void>): Promise<void> {
  const chemin = join(dossier, `config-${Math.random().toString(16).slice(2)}.json`);
  writeFileSync(chemin, JSON.stringify(contenu));
  const restaurer = surchargerConfig({ CONFIG_JSON_PATH: chemin });
  invalidateConfigCache();
  try {
    await f();
  } finally {
    restaurer();
    invalidateConfigCache();
  }
}

describe("vecteurs Python : voix et hôte d'écoute", () => {
  it("get_voice_config et voice_flags", () => {
    for (const v of vecteurs.voix) {
      const cfg = configVoix({ voice: v.section });
      expect(cfg, JSON.stringify(v.section)).toEqual(v.config);
      expect(drapeauxVoix(cfg)).toEqual(v.drapeaux);
    }
  });

  it("host_for", () => {
    for (const h of vecteurs.hotes) {
      if ("hote" in h) expect(hotePourConfig(h.config), JSON.stringify(h.config)).toBe(h.hote);
      else expect(() => hotePourConfig(h.config), JSON.stringify(h.config)).toThrow();
    }
  });

  it("default_host selon le fichier", () => {
    for (const f of vecteurs.fichiers) {
      const chemin = join(dossier, `${f.cas}.json`);
      if (f.contenu !== null) writeFileSync(chemin, f.contenu);
      expect(hoteParDefaut(chemin), f.cas).toBe(f.hote);
    }
  });
});

describe("routes de l'interface", () => {
  it("main : page d'accueil sans cache, /admin redirige vers l'URL synthétisée", async () => {
    const app = await creerApp({ mode: "main", journal: journalMuet });
    const accueil = await app.inject({ method: "GET", url: "/" });
    expect(accueil.statusCode).toBe(200);
    expect(accueil.headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(accueil.headers["cache-control"]).toBe("no-cache, no-store, must-revalidate");
    expect(accueil.headers["pragma"]).toBe("no-cache");
    expect(accueil.body).not.toContain("<script>");
    expect(accueil.headers["content-security-policy"]).toBe(POLITIQUE_CSP);
    const admin = await app.inject({ method: "GET", url: "/admin", headers: { host: "elpis.lan:8001" } });
    expect(admin.statusCode).toBe(302);
    expect(admin.headers["location"]).toBe("http://elpis.lan:8002/admin");
    const statique = await app.inject({ method: "GET", url: "/static/elpis-32.png" });
    expect([statique.statusCode, statique.headers["content-type"]]).toEqual([200, "image/png"]);
    await app.close();
  });

  it("admin : la console sur /, /admin et /admin/ ; pas de logo d'accueil", async () => {
    const app = await creerApp({ mode: "admin", journal: journalMuet });
    for (const url of ["/", "/admin", "/admin/"]) {
      const r = await app.inject({ method: "GET", url });
      expect(r.statusCode, url).toBe(200);
      expect(r.headers["cache-control"], url).toBe("no-cache, no-store, must-revalidate");
      expect(r.headers["pragma"], url).toBeUndefined();
      expect(r.headers["content-security-policy"], url).toBe(POLITIQUE_CSP);
    }
    expect((await app.inject({ method: "GET", url: "/api/welcome-image" })).statusCode).toBe(404);
    await app.close();
  });

  it("security.csp : report-only signale sans bloquer, off retire la politique, relu sans redémarrage", async () => {
    const commun = "frame-ancestors 'self'";
    const app = await creerApp({ mode: "main", journal: journalMuet });
    await avecConfig({ security: { csp: "report-only" } }, async () => {
      const r = await app.inject({ method: "GET", url: "/" });
      expect(r.headers["content-security-policy"]).toBe(commun);
      expect(r.headers["content-security-policy-report-only"]).toBe(POLITIQUE_CSP);
    });
    await avecConfig({ security: { csp: "off" } }, async () => {
      const r = await app.inject({ method: "GET", url: "/" });
      expect(r.headers["content-security-policy"]).toBe(commun);
      expect(r.headers["content-security-policy-report-only"]).toBeUndefined();
    });
    expect((await app.inject({ method: "GET", url: "/" })).headers["content-security-policy"]).toBe(
      POLITIQUE_CSP,
    );
    await app.close();
  });

  it("aperçu des blocs de code : page fixe, sa propre politique (bac à sable, aucun réseau), quel que soit security.csp", async () => {
    const app = await creerApp({ mode: "main", journal: journalMuet });
    const verifier = async (): Promise<void> => {
      const r = await app.inject({ method: "GET", url: CHEMIN_APERCU_CODE });
      expect(r.statusCode).toBe(200);
      expect(r.headers["content-type"]).toBe("text/html; charset=utf-8");
      expect(r.headers["content-security-policy"]).toBe(POLITIQUE_APERCU_CODE);
      expect(r.headers["content-security-policy-report-only"]).toBeUndefined();
      expect(r.body).toBe(PAGE_APERCU_CODE);
    };
    await verifier();
    await avecConfig({ security: { csp: "off" } }, verifier);
    const directives = POLITIQUE_APERCU_CODE.split("; ");
    expect(directives[0]).toBe("sandbox allow-scripts allow-modals allow-popups");
    expect(directives).toContain("default-src 'none'");
    expect(directives).toContain("frame-ancestors 'self'");
    expect(POLITIQUE_APERCU_CODE).not.toMatch(/allow-same-origin|connect-src|https?:|\*/);
    expect(PAGE_APERCU_CODE).toContain("e.source !== parent");
    await app.close();
    const console = await creerApp({ mode: "admin", journal: journalMuet });
    const r = await console.inject({ method: "GET", url: CHEMIN_APERCU_CODE });
    expect([r.statusCode, r.headers["content-security-policy"]]).toEqual([200, POLITIQUE_APERCU_CODE]);
    await console.close();
  });

  it("configuration publique : défauts, fonctions, voix, logo stocké", async () => {
    const app = await creerApp({ mode: "main", journal: journalMuet });
    const defauts = (await app.inject({ method: "GET", url: "/api/public-config" })).json() as Record<
      string,
      unknown
    >;
    expect(defauts["app_mode"]).toBe("main");
    expect((defauts["welcome"] as Record<string, unknown>)["image_b64"]).toBe("static/elpis-256.png");
    expect(defauts["features"]).toMatchObject({
      opencode: true,
      office_preview: true,
      voice_stt: false,
      voice_tts: false,
    });
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64");
    const config = {
      welcome: { image_b64: `data:image/png;base64,${png}` },
      features: { opencode: false },
      voice: { enabled: true, stt: { endpoint_url: "http://voix:8090" } },
    };
    await avecConfig(config, async () => {
      const r = (await app.inject({ method: "GET", url: "/api/public-config" })).json() as Record<
        string,
        unknown
      >;
      expect((r["welcome"] as Record<string, unknown>)["image_b64"]).toMatch(
        /^\/api\/welcome-image\?v=[0-9a-f]{16}$/,
      );
      expect(r["features"]).toMatchObject({ opencode: false, voice_stt: true, voice_tts: false });
      const logo = await app.inject({ method: "GET", url: "/api/welcome-image" });
      expect([logo.statusCode, logo.headers["content-type"], logo.rawPayload.length]).toEqual([
        200,
        "image/png",
        4,
      ]);
      expect(logo.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
    });
    await app.close();
  });

  it("logo de l'application (écart voulu : avatar de l'assistant) : adresse à empreinte, servi sur main et admin, défaut d'Elpis", async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    for (const mode of ["main", "admin"] as const) {
      const app = await creerApp({ mode, journal: journalMuet });
      const config = async () =>
        (await app.inject({ method: "GET", url: "/api/public-config" })).json<Record<string, unknown>>();
      expect((await config())["app_logo_url"]).toBe("static/elpis-256.png");
      expect((await app.inject({ method: "GET", url: "/api/app-logo" })).statusCode).toBe(404);
      await avecConfig(
        { app_info: { logo_b64: `data:image/png;base64,${png.toString("base64")}` } },
        async () => {
          const url = String((await config())["app_logo_url"]);
          expect(url).toMatch(/^\/api\/app-logo\?v=[0-9a-f]{16}$/);
          const r = await app.inject({ method: "GET", url });
          expect([r.statusCode, r.headers["content-type"], r.rawPayload]).toEqual([200, "image/png", png]);
          expect(r.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
          expect(r.headers["x-content-type-options"]).toBe("nosniff");
          expect(r.headers["content-security-policy"]).toContain("sandbox");
        },
      );
      // Type non servi (page HTML déguisée) ou data-URI illisible : logo d'Elpis.
      for (const logo of ["data:text/html;base64,PHNjcmlwdD4=", "data:image/png;base64,", "pas une image"])
        await avecConfig({ app_info: { logo_b64: logo } }, async () => {
          expect((await config())["app_logo_url"], logo).toBe("static/elpis-256.png");
          expect((await app.inject({ method: "GET", url: "/api/app-logo" })).statusCode, logo).toBe(404);
        });
      await app.close();
    }
  });
});
