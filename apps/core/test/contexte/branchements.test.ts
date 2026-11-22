// SPDX-License-Identifier: MIT
/** apps/core/test/contexte/branchements.test.ts — ports du contexte branchés sur la base (vecteurs Python) : ligne réseau et tête system stable d'un tour à l'autre, détection et rendu contextuel de la mémoire AX, URL de session Playwright, index des sessions en masse. */
import "../moteur-environnement";

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { RequestListener, Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createUser } from "@elpis/auth";
import { invalidateConfigCache, reinitialiserCaches, surchargerConfig } from "@elpis/config";
import { initialiserBase } from "@elpis/db";
import type { Base, Valeur } from "@elpis/db";
import { ouvrirBaseDeTest, PG_DE_TEST } from "@elpis/db/test";
import type { BaseDeTest } from "@elpis/db/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { assembleOperationalContext, networkStatusLine } from "../../src/contexte/assemblage";
import {
  brancherContexte,
  compresseurDuProcess,
  profilReseauDuProcess,
} from "../../src/contexte/branchements";
import {
  installerMemoireAx,
  installerPortCompresseur,
  installerProfilReseau,
  installerPromptsCapacites,
  portMemoireAx,
} from "../../src/contexte/ports";
import type { ProfilEffectif } from "../../src/contexte/ports";
import {
  detectSessionUrl,
  detectSitesFromText,
  renderFocusedDomForPrompt,
  renderSiteContextual,
  serviceNavigateur,
  siteSignal,
  urlCouranteDeSession,
} from "@elpis/navigateur";
import { sessionIndexMessages } from "../../src/memoire/sessions";
import { lireVecteurs } from "../vecteurs-moteur";

type Dict = Record<string, unknown>;
const V = lireVecteurs<{
  comptes: [string, string | null][];
  ax: Record<string, Dict[]>;
  config_ax: Dict;
  configs_bac: Dict[];
  noms_reseau: string[];
  textes: string[];
  rendus: [number, string][];
  sessions: [unknown[], string][];
  reponses_pw: string[];
  indexations: unknown[][];
  ids: Record<string, number>;
  reseau: string[][];
  detection: string[][];
  signaux: [string, number][];
  contextuels: [string, number, string | null, number, string, string][];
  cibles: [string, string, number, string, string][];
  sessions_obtenues: { demande: [string, string, number] | null; resultat: string | null }[];
  indexations_obtenues: { rendu: number; table: unknown[][] }[];
}>("contexte-ports");
const MOTEURS = PG_DE_TEST ? (["sqlite", "postgres"] as const) : (["sqlite"] as const);

async function peupler(base: Base): Promise<void> {
  for (const [nom, brut] of V.comptes) {
    await createUser(base, nom, `mdp-${nom}`, { isAdmin: 0 });
    if (brut !== null) await base.run("UPDATE users SET settings_json=? WHERE username=?", [brut, nom]);
  }
  for (const [table, lignes] of Object.entries(V.ax))
    for (const ligne of lignes) {
      const cols = Object.keys(ligne);
      await base.run(
        `INSERT INTO ${table}(${cols.join(", ")}) VALUES(${cols.map(() => "?").join(", ")})`,
        cols.map((k) => ligne[k] as Valeur),
      );
    }
}

describe.each(MOTEURS)("ports du contexte branchés (%s)", (moteur) => {
  let t: BaseDeTest;
  let dossier: string;
  let restaurer: () => void;
  const ecrireConfig = (cfg: unknown): void => {
    writeFileSync(join(dossier, "config.json"), JSON.stringify(cfg));
    invalidateConfigCache();
  };

  beforeAll(async () => {
    t = ouvrirBaseDeTest(moteur);
    await initialiserBase(t.base);
    await peupler(t.base);
    dossier = mkdtempSync(join(tmpdir(), "elpis-contexte-ports-"));
    restaurer = surchargerConfig({ CONFIG_JSON_PATH: join(dossier, "config.json") });
    reinitialiserCaches();
    brancherContexte(t.base);
  });

  afterAll(async () => {
    installerProfilReseau(null);
    installerMemoireAx(null);
    installerPortCompresseur(null);
    restaurer();
    reinitialiserCaches();
    await t.fermer();
    rmSync(dossier, { recursive: true, force: true });
  });

  it("ligne réseau de l'assemblage : imposition, choix, profil inconnu, réglages illisibles, config invalide", async () => {
    for (const [i, cfg] of V.configs_bac.entries()) {
      ecrireConfig(cfg);
      const obtenu: string[] = [];
      for (const nom of V.noms_reseau) obtenu.push(await networkStatusLine(nom));
      expect(obtenu, JSON.stringify(cfg)).toEqual(V.reseau[i]);
    }
  });

  it("ligne « pas de root » : seulement quand sudo est refusé ou le profil filtré, réglage relu à chaque appel", async () => {
    const SANS_ROOT = "No root in this container";
    ecrireConfig({ executors: { allow_sudo: true } });
    expect(await networkStatusLine("inconnu")).not.toContain(SANS_ROOT);
    ecrireConfig({ executors: { allow_sudo: false } });
    expect(await networkStatusLine("inconnu")).toContain(SANS_ROOT);
    ecrireConfig({ executors: { allow_sudo: "oui" } });
    expect(await networkStatusLine("inconnu")).toContain(SANS_ROOT);
    ecrireConfig({});
    expect(await networkStatusLine("inconnu")).not.toContain(SANS_ROOT);
  });

  it("ligne « pas de root » : un profil filtré (liste blanche ou protection) l'ajoute même si sudo est permis", async () => {
    const SANS_ROOT = "No root in this container";
    ecrireConfig({ executors: { allow_sudo: true } });
    const ligne = async (profil: ProfilEffectif): Promise<string> => {
      installerProfilReseau({ profilReseau: async () => profil });
      return networkStatusLine("inconnu");
    };
    try {
      expect(await ligne({ mode: "bridge" })).not.toContain(SANS_ROOT);
      for (const coche of ["block_metadata", "block_lan", "block_host"] as const)
        expect(await ligne({ mode: "bridge", [coche]: true }), coche).toContain(SANS_ROOT);
      expect(await ligne({ mode: "allowlist_ip" })).toContain(SANS_ROOT);
      expect(await ligne({ mode: "none", block_lan: true })).not.toContain(SANS_ROOT);
    } finally {
      brancherContexte(t.base);
    }
  });

  /** Réglages de bob remplacés le temps de `f`, puis rendus. */
  async function avecReglagesDeBob<T>(reglages: Dict, f: () => Promise<T>): Promise<T> {
    const avant = (await t.base.valeurs("SELECT settings_json FROM users WHERE username=?", ["bob"]))[0]?.[0];
    await t.base.run("UPDATE users SET settings_json=? WHERE username=?", [JSON.stringify(reglages), "bob"]);
    try {
      return await f();
    } finally {
      await t.base.run("UPDATE users SET settings_json=? WHERE username=?", [avant as Valeur, "bob"]);
    }
  }

  it("profil du process : le profil appliqué entier (liste, protections, règle Git), « isolated » pour un profil inconnu", async () => {
    ecrireConfig({
      executors: {
        network_profiles: [
          { id: "isolated", name: "I", mode: "none" },
          { id: "garde", name: "G", mode: "bridge", block_lan: true, git_access: "accounts" },
          {
            id: "liste",
            name: "W",
            mode: "allowlist_ip",
            ips: ["192.0.2.1"],
            ports: [443],
            git_access: "servers",
            git_servers: ["git.example.org/acme"],
          },
        ],
      },
    });
    const port = profilReseauDuProcess(t.base);
    const rendus: unknown[] = [];
    for (const id of ["garde", "liste", "absent"])
      await avecReglagesDeBob({ network_profile_id: id }, async () => {
        const p = await port.profilReseau("bob");
        rendus.push([p.id, p.mode, p.block_lan, p.ips, p.ports, p.git_access, p.git_servers]);
      });
    expect(rendus).toEqual([
      ["garde", "bridge", true, [], [], "accounts", []],
      ["liste", "allowlist_ip", false, ["192.0.2.1"], [443], "servers", ["git.example.org/acme"]],
      ["isolated", "none", false, [], [], "all", []],
    ]);
  });

  it("deux tours de suite, même profil : tête system identique à l'octet ; profil ou choix du compte changé : tête changée", async () => {
    const profils = (web: Dict): Dict => ({
      executors: {
        network_profiles: [
          { id: "lan", name: "LAN", mode: "bridge", block_metadata: true, block_host: true },
          {
            id: "web",
            name: "Web",
            mode: "allowlist_ip",
            ips: ["192.0.2.7", "10.0.0.0/24"],
            domains: ["pypi.org", "files.pythonhosted.org"],
            ports: [443, 80],
            dns: ["10.0.0.53"],
            git_access: "servers",
            git_servers: ["github.com/acme", "git.example.org"],
            ...web,
          },
        ],
      },
    });
    const tour1: Dict[] = [{ role: "user", content: "Installe requests." }];
    const tour2: Dict[] = [
      ...tour1,
      { role: "assistant", content: "Fait." },
      { role: "user", content: "Et numpy ?" },
    ];
    const tete = async (username: string, messages: Dict[]): Promise<unknown> => {
      const [w] = await assembleOperationalContext(messages, {
        allowedToolNames: ["execute_shell", "git_clone"],
        username,
      });
      return (w[0] as Dict)["content"];
    };
    installerPromptsCapacites({
      capabilityWantsRuntimeContext: () => true,
      buildCapabilityBlock: () => null,
    });
    try {
      ecrireConfig(profils({}));
      const limite = await tete("carol", tour1);
      expect(limite).toContain(
        "  • Network: limited. The shell and the browser reach only the domains files.pythonhosted.org, pypi.org " +
          "and 2 address ranges set by the administrator, on TCP ports 80, 443. DNS for the shell: 1 resolver " +
          "set by the administrator.",
      );
      expect(limite).not.toMatch(/10\.0\.0\.|192\.0\.2\./u);
      expect(await tete("carol", tour2)).toBe(limite);
      ecrireConfig(
        profils({
          ips: ["10.0.0.0/24", "192.0.2.7", "10.0.0.0/24"],
          domains: ["files.pythonhosted.org", "pypi.org"],
          ports: [80, 443],
          git_servers: ["git.example.org", "github.com/acme"],
        }),
      );
      expect(await tete("carol", tour2)).toBe(limite);
      ecrireConfig(profils({ domains: ["pypi.org"] }));
      expect(await tete("carol", tour2)).not.toBe(limite);
      const ouvert = await tete("bob", tour1);
      expect(ouvert).toContain("  • Network: full.");
      expect(await tete("bob", tour2)).toBe(ouvert);
      const choixChange = await avecReglagesDeBob({ network_profile_id: "web" }, () => tete("bob", tour2));
      expect(choixChange).not.toBe(ouvert);
      expect(choixChange).toContain("  • Network: limited.");
    } finally {
      installerPromptsCapacites(null);
    }
  });

  it("mémoire AX : sites du texte, signal, rendu contextuel et ciblé", async () => {
    ecrireConfig(V.config_ax);
    expect(V.textes.map((x) => detectSitesFromText(x))).toEqual(V.detection);
    for (const [s, n] of V.signaux) expect(await siteSignal(t.base, s), s).toBe(n);
    for (const [s, it, p, m, o, attendu] of V.contextuels) {
      const rendu = await renderSiteContextual(t.base, s, {
        currentPath: p,
        maxChars: m,
        iteration: it,
        owner: o,
      });
      // Les lignes d'identifiants des vecteurs ont une clé sans origine : plus d'indice au modèle, le reste est couvert par les autres comptes.
      if (attendu.includes("CREDENTIALS KNOWN") || o === "bob")
        expect(rendu).not.toContain("CREDENTIALS KNOWN");
      else expect(rendu, `${s} ${it} ${p} ${m} ${o}`).toBe(attendu);
    }
    for (const [s, p, m, o, attendu] of V.cibles) {
      const rendu = await renderFocusedDomForPrompt(t.base, s, p, { maxChars: m, owner: o });
      if (attendu.includes("CREDENTIALS KNOWN") || o === "bob")
        expect(rendu).not.toContain("CREDENTIALS KNOWN");
      else expect(rendu, `${s} ${p} ${m} ${o}`).toBe(attendu);
    }
    expect(
      await portMemoireAx().renderSiteContextual("jira", { currentPath: null, iteration: 0, owner: "" }),
    ).toBe(await renderSiteContextual(t.base, "jira"));
  });

  it("index des sessions en masse : entrées invalides sautées, défauts, une transaction", async () => {
    for (const [i, lignes] of V.indexations.entries()) {
      const avecIds = lignes.map((l) =>
        l !== null && typeof l === "object" && !Array.isArray(l)
          ? {
              ...(l as Dict),
              user_id: (l as Dict)["user_id"] === null ? null : V.ids[String((l as Dict)["user_id"])],
            }
          : l,
      );
      expect(await sessionIndexMessages(t.base, avecIds, () => 1_800_000_000.25)).toBe(
        V.indexations_obtenues[i]?.rendu,
      );
      const table = await t.base.all(
        "SELECT user_id, app, session_id, scope_key, role, content, ts FROM session_messages ORDER BY id",
      );
      expect(table.map((r) => Object.values(r).map((v) => (typeof v === "string" ? v : Number(v))))).toEqual(
        V.indexations_obtenues[i]?.table,
      );
      await t.base.run("DELETE FROM session_messages");
    }
    expect(V.ids).toEqual(Object.fromEntries(V.comptes.map(([nom], i) => [nom, i + 1])));
    const port = compresseurDuProcess(t.base);
    expect([await port.userIdParNom("carol"), await port.userIdParNom("personne")]).toEqual([3, null]);
    expect(
      port.recordTurnUsage({}, { model: "m", path: "compression", durationMs: 1, iterations: 1 }),
    ).toBeUndefined();
  });
});

describe("URL de la session Playwright (service simulé du bac du compte, vecteurs Python)", () => {
  it("dernière session citée, propriétaire du service navigateur, réponses et pannes", async () => {
    const demandes: string[] = [];
    let corps = "";
    const servir: RequestListener = (req, rep) => {
      demandes.push(`${req.method} ${req.url}`);
      if (corps === "<panne>") {
        req.socket.destroy();
        return;
      }
      rep.writeHead(200, { "content-type": "application/json" }).end(corps);
    };
    // Service du bac de chaque compte des vecteurs (nom sûr : « rené » → « ren »), sur son socket.
    const sb = mkdtempSync(join(tmpdir(), "elpis-sb-ax-"));
    const restaurer = surchargerConfig({ SANDBOX_DIR: sb });
    const serveurs: Server[] = [];
    for (const compte of ["bob", "ren"]) {
      mkdirSync(join(sb, compte, ".elpis-agent"), { recursive: true });
      const s = createServer(servir);
      await new Promise<void>((ok) => s.listen(join(sb, compte, ".elpis-agent", "browser.sock"), ok));
      serveurs.push(s);
    }
    try {
      let k = 0;
      for (const [messages, owner] of V.sessions)
        for (const reponse of V.reponses_pw) {
          corps = reponse;
          demandes.length = 0;
          const attendu = V.sessions_obtenues[k++]!;
          const obtenu = await detectSessionUrl(messages, owner, (id) =>
            urlCouranteDeSession(serviceNavigateur(owner), owner, id),
          );
          const ctx = `${JSON.stringify(messages).slice(0, 80)} ${owner} ${reponse}`;
          expect(obtenu, ctx).toBe(attendu.resultat);
          expect(demandes, ctx).toEqual(
            attendu.demande === null
              ? []
              : [`GET ${attendu.demande[0].replace("http://pw.invalid:3000", "")}`],
          );
        }
    } finally {
      restaurer();
      for (const s of serveurs) await new Promise((ok) => s.close(ok));
      rmSync(sb, { recursive: true, force: true });
    }
  });
});
