// SPDX-License-Identifier: MIT
/** apps/core/test/contexte/branchements.test.ts — ports du contexte branchés sur la base (vecteurs Python) : ligne réseau, détection et rendu contextuel de la mémoire AX, URL de session Playwright, index des sessions en masse. */
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

import { networkStatusLine } from "../../src/contexte/assemblage";
import {
  brancherContexte,
  compresseurDuProcess,
  profilReseauDuProcess,
} from "../../src/contexte/branchements";
import {
  installerMemoireAx,
  installerPortCompresseur,
  installerProfilReseau,
  portMemoireAx,
} from "../../src/contexte/ports";
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
    const ligne = async (profil: { id: string; mode: unknown; filtre?: boolean }): Promise<string> => {
      installerProfilReseau({ profilReseau: async () => profil });
      return networkStatusLine("inconnu");
    };
    try {
      expect(await ligne({ id: "libre", mode: "bridge", filtre: false })).not.toContain(SANS_ROOT);
      expect(await ligne({ id: "garde", mode: "bridge", filtre: true })).toContain(SANS_ROOT);
      expect(await ligne({ id: "liste", mode: "allowlist_ip", filtre: true })).toContain(SANS_ROOT);
      expect(await ligne({ id: "liste", mode: "allowlist_ip" })).toContain(SANS_ROOT);
      expect(await ligne({ id: "libre", mode: "bridge" })).not.toContain(SANS_ROOT);
      expect(await ligne({ id: "ferme", mode: "none", filtre: false })).not.toContain(SANS_ROOT);
    } finally {
      brancherContexte(t.base);
    }
  });

  it("profil du process : filtre vrai pour une liste blanche ou un profil ouvert protégé, faux sinon", async () => {
    ecrireConfig({
      executors: {
        network_profiles: [
          { id: "isolated", name: "I", mode: "none" },
          { id: "libre", name: "L", mode: "bridge" },
          { id: "garde", name: "G", mode: "bridge", block_lan: true },
          { id: "liste", name: "W", mode: "allowlist_ip", ips: ["192.0.2.1"] },
        ],
      },
    });
    const port = profilReseauDuProcess(t.base);
    const rendus: unknown[] = [];
    const avant = (await t.base.valeurs("SELECT settings_json FROM users WHERE username=?", ["bob"]))[0]?.[0];
    try {
      for (const id of ["libre", "garde", "liste", "isolated"]) {
        await t.base.run("UPDATE users SET settings_json=? WHERE username=?", [
          JSON.stringify({ network_profile_id: id }),
          "bob",
        ]);
        const { filtre, mode } = await port.profilReseau("bob");
        rendus.push([id, mode, filtre]);
      }
    } finally {
      await t.base.run("UPDATE users SET settings_json=? WHERE username=?", [avant as Valeur, "bob"]);
    }
    expect(rendus).toEqual([
      ["libre", "bridge", false],
      ["garde", "bridge", true],
      ["liste", "allowlist_ip", true],
      ["isolated", "none", false],
    ]);
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
