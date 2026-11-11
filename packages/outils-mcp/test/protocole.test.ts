// SPDX-License-Identifier: MIT
/** packages/outils-mcp/test/protocole.test.ts — scénarios protocolaires enregistrés sur local_mcp_server.py (vecteurs) rejoués sur le service TS (le Python d'origine est retiré). */
import { readdirSync } from "node:fs";

import { validerPy } from "@elpis/http";
import type { SchemaPy } from "@elpis/http";
import { FAMILY_NAMES } from "@elpis/mcp";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { ecartsSignature, schemaDAnnotation, signatureDuGolden } from "../src/goldens";
import { construireTable, VerificateurJetons } from "../src/jetons";
import { ServeurOutils } from "../src/serveur";
import type { Etape } from "./differentiel";
import { demarrerTs, ecarts, rejouer } from "./differentiel";
import { famillesTodoMemory, lireGolden, SIGNATURES_REELLES } from "./familles-test";
import { lireVecteurs } from "./vecteurs";

const V = lireVecteurs<{
  service: string;
  maintenant: number;
  env: Record<string, string>;
  etapes: { http: Etape[]; sse: Etape[] };
  reponses: { http: unknown[]; sse: unknown[] };
}>("protocole");

/** Service TS configuré comme le Python des vecteurs : familles todo et memory, pages de 2, jetons clients, délégations datées. */
const VERSION_ENREGISTREE = "0.1.0";

function serveurTs(): { serveur: ServeurOutils; verificateur: VerificateurJetons } {
  const serveur = new ServeurOutils({
    nom: "local-tools",
    // Scénarios enregistrés sur le Python 0.1.0 : la version annoncée est celle de l'enregistrement, pas celle du dépôt.
    version: VERSION_ENREGISTREE,
    taillePage: Number(V.env["LOCAL_MCP_LIST_PAGE_SIZE"]),
    famillesOpencode: (V.env["LOCAL_MCP_OPENCODE_FAMILIES"] ?? "").split(","),
  });
  for (const [famille, outils] of famillesTodoMemory()) serveur.enregistrerFamille(famille, outils);
  const verificateur = new VerificateurJetons({
    table: construireTable(V.service, { "cli-mem": "alice", "cli-all": "bob" }, { "cli-mem": ["memory"] }),
    maintenant: () => V.maintenant,
  });
  return { serveur, verificateur };
}

/** Goldens d'outils publiés seulement sur réglage (desktop_screenshot et desktop_inspect : DESKTOP_EXPOSE_RAW_TOOLS). */
const BRUTS = ["desktop-brut.json"];

describe("goldens tools/list des familles", () => {
  it("un golden par famille, outils nommés une fois, définitions publiées complètes", () => {
    const fichiers = readdirSync(new URL("../goldens/", import.meta.url)).sort();
    expect(fichiers).toEqual([...FAMILY_NAMES.map((f) => `${f}.json`), ...BRUTS].sort());
    const vus = new Set<string>();
    for (const f of FAMILY_NAMES) {
      const g = lireGolden(f);
      expect(g.famille).toBe(f);
      for (const d of g.outils) {
        expect(vus.has(d["name"] as string), d["name"] as string).toBe(false);
        vus.add(d["name"] as string);
        expect(Object.keys(d).slice(0, 4)).toEqual(["name", "title", "description", "inputSchema"]);
        expect(g.fonctions[d["name"] as string]?.parametres).toBeDefined();
      }
    }
    expect(vus.size).toBe(89);
  });

  it("signatures TS de todowrite, memory et session_search conformes au Python ; écart signalé sinon", () => {
    for (const [nom, sig] of Object.entries(SIGNATURES_REELLES))
      expect(
        ecartsSignature(lireGolden(nom === "todowrite" ? "todo" : "memory"), nom, sig.parametres),
      ).toEqual([]);
    const { session_search: s } = SIGNATURES_REELLES;
    const { limit: _limite, ...sansLimite } = s?.parametres ?? {};
    expect(ecartsSignature(lireGolden("memory"), "session_search", sansLimite)).toEqual([
      "session_search : paramètres query,ref ≠ query,limit,ref",
    ]);
  });

  it("signatureDuGolden : paramètres, requis et défauts identiques à l'inputSchema publié par le Python (flottant `$f`, `None`, listes de dictionnaires)", () => {
    const g = lireGolden("browser");
    for (const d of g.outils) {
      const nom = d["name"] as string;
      const publie = d["inputSchema"] as {
        properties: Record<string, Record<string, unknown>>;
        required?: string[];
      };
      const sig = signatureDuGolden(g, nom);
      expect(Object.keys(sig), nom).toEqual(Object.keys(publie.properties));
      expect(
        Object.keys(sig).filter((k) => !sig[k]?.options.defaut),
        nom,
      ).toEqual(publie.required ?? []);
      for (const [k, schema] of Object.entries(sig))
        if (schema.options.defaut)
          expect(schema.options.defaut(), `${nom}.${k}`).toEqual(publie.properties[k]?.["default"]);
    }
    const wait = signatureDuGolden(g, "pw_wait");
    expect([wait["seconds"]?.options.defaut?.(), wait["max_wait_s"]?.options.defaut?.()]).toEqual([0, 60]);
    expect(signatureDuGolden(g, "pw_session")["load_state_id"]?.options.defaut?.()).toBeNull();
    expect(signatureDuGolden(g, "pw_session")["username"]).toBeUndefined();
    expect(
      validerPy(signatureDuGolden(g, "pw_chain")["actions"] as SchemaPy<unknown>, [{ a: 1.5 }, "x"]).ok,
    ).toBe(false);
    expect(() => schemaDAnnotation("Tuple[int]")).toThrow(
      "annotation Python non prise en charge : Tuple[int]",
    );
  });
});

describe("scénarios protocolaires enregistrés sur le Python, rejoués sur le TS", () => {
  beforeAll(() => {
    vi.stubEnv("LOCAL_MCP_ALLOWED_ORIGINS", V.env["LOCAL_MCP_ALLOWED_ORIGINS"] ?? "");
  });

  afterAll(() => {
    vi.unstubAllEnvs();
  });

  for (const transport of ["http", "sse"] as const)
    it(`${transport} : mêmes statuts, en-têtes, corps et événements (${V.etapes[transport].length} étapes)`, async () => {
      const { serveur, verificateur } = serveurTs();
      const cible = await demarrerTs({ serveur, verificateur, transport });
      try {
        const obtenues = await rejouer(V.etapes[transport], cible.base);
        expect(ecarts(V.etapes[transport], V.reponses[transport], obtenues)).toEqual([]);
      } finally {
        await cible.arreter();
      }
    });
});
