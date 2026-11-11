// SPDX-License-Identifier: MIT
/** apps/core/test/relais/services.test.ts — appels de service vers l'hôte d'un compte : actifs, miroir des skills, session d'historique. */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import type { Server, Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { fetchRelayedBytes, ouvrirSessionHistorique, pushSkillsMirror } from "../../src/relais/services";
import { FauxToolhost, JETON, journalTest, lignes, monterBanc } from "./aides";
import type { Banc } from "./aides";

/** Membres d'une archive tar (ustar, chemins longs en en-tête pax) : nom → contenu. */
function lireTar(archive: Buffer): Map<string, Buffer> {
  const membres = new Map<string, Buffer>();
  let i = 0;
  let nomPax: string | undefined;
  while (i + 512 <= archive.length) {
    const entete = archive.subarray(i, i + 512);
    if (entete.every((o) => o === 0)) break;
    const somme = parseInt(entete.subarray(148, 156).toString("latin1").replace(/\0.*$/su, "").trim(), 8);
    const calcul = [...entete].reduce((s, o, j) => s + (j >= 148 && j < 156 ? 32 : o), 0);
    expect(calcul).toBe(somme);
    const taille = parseInt(entete.subarray(124, 136).toString("latin1").replace(/\0.*$/su, ""), 8);
    const type = String.fromCharCode(entete[156] ?? 0);
    const contenu = archive.subarray(i + 512, i + 512 + taille);
    if (type === "x") {
      nomPax = /path=([^\n]*)\n/u.exec(contenu.toString("utf8"))?.[1];
    } else {
      const nom = nomPax ?? entete.subarray(0, 100).toString("utf8").replace(/\0.*$/su, "");
      membres.set(nom, Buffer.from(contenu));
      nomPax = undefined;
    }
    i += 512 + Math.ceil(taille / 512) * 512;
  }
  expect(archive.length % 10240).toBe(0);
  return membres;
}

let banc: Banc;
let hote: FauxToolhost;
const journal = journalTest.child({ domaine: "sandbox-relay" });

beforeEach(async () => {
  lignes.length = 0;
  hote = await new FauxToolhost().demarrer();
  banc = await monterBanc();
  banc.manifeste({ main: { url: hote.url, token: JETON } });
});

afterEach(async () => {
  await banc.fermer();
  await hote.arreter();
});

describe("fetchRelayedBytes", () => {
  it("octets d'un actif de l'hôte pour ce compte ; null hors 200, sans hôte, sans jeton, hors préfixes, injoignable", async () => {
    hote.traitements.set("/api/playwright/screenshot/x.png", (_req, res, vue) => {
      res.writeHead(vue.identite?.user_id === 1 ? 200 : 403);
      res.end(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    });
    expect(await fetchRelayedBytes(1, "/api/playwright/screenshot/x.png", { journal })).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    );
    expect(await fetchRelayedBytes(2, "/api/playwright/screenshot/x.png", { journal })).toBeNull();
    hote.traitements.set("/api/desktop/frame/absente", (_req, res) => {
      res.writeHead(404);
      res.end("absente");
    });
    expect(await fetchRelayedBytes(1, "/api/desktop/frame/absente", { journal })).toBeNull();
    const avant = hote.requetes.length;
    expect(await fetchRelayedBytes(1, "/api/desktop/frame/../../manifest", { journal })).toBeNull();
    expect(await fetchRelayedBytes(1, "/manifest", { journal })).toBeNull();
    expect(hote.requetes).toHaveLength(avant);
    banc.manifeste({ main: { url: hote.url } });
    expect(await fetchRelayedBytes(1, "/api/playwright/screenshot/x.png", { journal })).toBeNull();
    banc.manifeste({});
    expect(await fetchRelayedBytes(1, "/api/playwright/screenshot/x.png", { journal })).toBeNull();
    banc.manifeste({ main: { url: "http://127.0.0.1:1", token: JETON } });
    expect(await fetchRelayedBytes(1, "/api/playwright/screenshot/x.png", { journal })).toBeNull();
    expect(lignes.some((l) => l.includes("actif /api/playwright/screenshot/x.png"))).toBe(true);
  });
});

describe("pushSkillsMirror", () => {
  let dossier = "";

  beforeEach(() => {
    dossier = mkdtempSync(join(tmpdir(), "elpis-skills-"));
    mkdirSync(join(dossier, "demo", "scripts"), { recursive: true });
    mkdirSync(join(dossier, "demo", "__pycache__"));
    writeFileSync(join(dossier, "demo", "SKILL.md"), "# demo");
    writeFileSync(join(dossier, "demo", "scripts", "run.sh"), "echo hi");
    writeFileSync(join(dossier, "demo", "__pycache__", "x.pyc"), "x");
    writeFileSync(join(dossier, ".cache"), "cache");
    const long = `${"d".repeat(60)}/${"e".repeat(60)}`;
    mkdirSync(join(dossier, long), { recursive: true });
    writeFileSync(join(dossier, long, "fichier-é.txt"), "long");
    symlinkSync("/etc/passwd", join(dossier, "lien"));
  });

  afterEach(() => {
    rmSync(dossier, { recursive: true, force: true });
  });

  it("hôte en boucle locale : rien n'est poussé (même disque)", async () => {
    expect(await pushSkillsMirror(1, dossier, { journal })).toBe(false);
    expect(hote.requetes).toHaveLength(0);
  });

  it("hôte distant : tar.gz multipart « archive », fichiers ordinaires hors __pycache__, noms longs et accentués", async () => {
    const distant = await new FauxToolhost().demarrer("127.0.0.2");
    try {
      let membres = new Map<string, Buffer>();
      distant.traitements.set("/api/sandbox/skills-mirror", async (req, res, vue) => {
        const morceaux: Buffer[] = [];
        for await (const m of req) morceaux.push(m as Buffer);
        const formulaire = await new Response(Buffer.concat(morceaux), {
          headers: { "content-type": String(req.headers["content-type"]) },
        }).formData();
        const archive = formulaire.get("archive") as File;
        expect([archive.name, archive.type, vue.identite?.user_id]).toEqual([
          "skills.tar.gz",
          "application/gzip",
          1,
        ]);
        membres = lireTar(gunzipSync(Buffer.from(await archive.arrayBuffer())));
        res.writeHead(200, { "content-type": "application/json" });
        res.end('{"ok": true, "files": 4}');
      });
      banc.manifeste({ vm: { url: distant.url, token: JETON } });
      expect(await pushSkillsMirror(1, dossier, { journal })).toBe(true);
      expect([...membres.keys()].sort()).toEqual([
        ".cache",
        `${"d".repeat(60)}/${"e".repeat(60)}/fichier-é.txt`,
        "demo/SKILL.md",
        "demo/scripts/run.sh",
      ]);
      expect(membres.get("demo/scripts/run.sh")?.toString()).toBe("echo hi");
      distant.traitements.set("/api/sandbox/skills-mirror", (_req, res) => {
        res.writeHead(500);
        res.end();
      });
      expect(await pushSkillsMirror(1, dossier, { journal })).toBe(false);
      expect(await pushSkillsMirror(1, join(dossier, "absent"), { journal })).toBe(false);
      banc.manifeste({ vm: { url: "http://127.0.0.2:1", token: JETON } });
      expect(await pushSkillsMirror(1, dossier, { journal })).toBe(false);
      expect(lignes.some((l) => l.includes("miroir des skills non poussé (vm)"))).toBe(true);
    } finally {
      await distant.arreter();
    }
  });

  it("hôte distant déclaré sans relais (`relay: false`) : rien n'est poussé, comme le Python", async () => {
    const distant = await new FauxToolhost().demarrer("127.0.0.2");
    try {
      banc.manifeste({ vm: { url: distant.url, token: JETON, relay: false } });
      expect(await pushSkillsMirror(1, dossier, { journal })).toBe(false);
      expect(distant.requetes).toHaveLength(0);
    } finally {
      await distant.arreter();
    }
  });
});

describe("ouvrirSessionHistorique", () => {
  let muet: Server | undefined;
  const sockets = new Set<Socket>();

  afterEach(async () => {
    for (const s of sockets) s.destroy();
    await new Promise<void>((fin) => (muet ? muet.close(() => fin()) : fin()));
    muet = undefined;
  });

  it("POST vers l'hôte du compte : enveloppe exacte (nom, admin plein, profil), id rendu", async () => {
    hote.traitements.set("/internal/file-history/session", (req, res, vue) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, id: `session-${vue.identite?.username}`, methode: req.method }));
    });
    expect(await ouvrirSessionHistorique(3, { journal })).toBe("session-chef");
    const vue = hote.requetes.at(-1);
    expect(vue?.methode).toBe("POST");
    expect(vue?.entetes["content-length"] ?? "0").toBe("0");
    expect(vue?.identite).toMatchObject({
      user_id: 3,
      username: "chef",
      is_admin: true,
      network_profile_id: "lan",
    });
  });

  it("ok faux, 404 d'un ancien hôte, 401 de la porte, corps illisible : null et avertissement, jamais d'exception", async () => {
    const reponses: [number, string][] = [
      [200, '{"ok": false, "id": "x"}'],
      [404, '{"detail":"Not Found"}'],
      [200, "pas du json"],
      [200, "[1]"],
    ];
    for (const [statut, corps] of reponses) {
      lignes.length = 0;
      hote.traitements.set("/internal/file-history/session", (_req, res) => {
        res.writeHead(statut, { "content-type": "application/json" });
        res.end(corps);
      });
      expect(await ouvrirSessionHistorique(1, { journal })).toBeNull();
      expect(lignes.some((l) => l.includes("session d'historique non ouverte"))).toBe(true);
    }
    hote.jeton = "autre-jeton";
    expect(await ouvrirSessionHistorique(1, { journal })).toBeNull();
    expect(lignes.at(-1)).toContain("HTTP 401");
  });

  it("hôte muet : null dans le délai ; hôte arrêté ou absent : null et avertissement", async () => {
    muet = createServer((s) => sockets.add(s));
    await new Promise<void>((fin) => muet?.listen(0, "127.0.0.1", fin));
    const adresse = muet.address();
    banc.manifeste({
      main: {
        url: `http://127.0.0.1:${typeof adresse === "object" && adresse ? adresse.port : 0}`,
        token: JETON,
      },
    });
    const debut = performance.now();
    expect(await ouvrirSessionHistorique(1, { delaiMs: 300, journal })).toBeNull();
    expect(performance.now() - debut).toBeLessThan(2_000);
    banc.manifeste({ main: { url: "http://127.0.0.1:1", token: JETON } });
    expect(await ouvrirSessionHistorique(1, { journal })).toBeNull();
    banc.manifeste({});
    lignes.length = 0;
    expect(await ouvrirSessionHistorique(1, { journal })).toBeNull();
    expect(lignes.join("\n")).toContain("aucun hôte d'outils déclaré");
  });

  it("placement by_user : la résolution de l'hôte au login enregistre l'affectation", async () => {
    const autre = await new FauxToolhost().demarrer();
    try {
      for (const t of [hote, autre]) {
        t.traitements.set("/internal/file-history/session", (_req, res) => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end('{"ok": true, "id": "s"}');
        });
      }
      await banc.base.base.run(
        "INSERT INTO sandbox_placements(user_id, host_id, created_at, updated_at) VALUES (40, 'a', 0, 0)",
      );
      banc.manifeste(
        { a: { url: hote.url, token: JETON }, b: { url: autre.url, token: JETON } },
        { strategy: "by_user", host: "a" },
      );
      expect(await ouvrirSessionHistorique(2, { journal })).toBe("s");
      expect(autre.requetes).toHaveLength(1);
      const ligne = await banc.base.base.get<{ host_id: string; created_at: number }>(
        "SELECT host_id, created_at FROM sandbox_placements WHERE user_id = 2",
      );
      expect(ligne?.host_id).toBe("b");
      expect(ligne?.created_at).toBeGreaterThan(1_700_000_000);
    } finally {
      await autre.arreter();
    }
  });
});
