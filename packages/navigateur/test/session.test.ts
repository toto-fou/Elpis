// SPDX-License-Identifier: MIT
/** packages/navigateur/test/session.test.ts — sessions Playwright : vecteurs Python (propriétaire, verbes, captures, suivi, pose par l'outil) et fichiers compagnons. */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Dict } from "@elpis/commun";
import { afterEach, describe, expect, it, onTestFinished } from "vitest";

import {
  extractPwScreenshotUrl,
  extractPwVisionCapture,
  getPwSessionOwner,
  proprietaire,
  PW_VERB_ALIASES,
  pwOwner,
  pwOwnerPath,
  pwVerbOf,
  recordPwSessionOwner,
  registerPwSessionOwner,
  trackPwSessionOwnership,
  unregisterPwSessionOwner,
} from "../src/session";

type Etape = {
  utilisateur: string;
  outil: string;
  args: unknown;
  resultat: unknown;
  memoire: [string, string][];
  fichiers: Record<string, string>;
  proprietaires: Record<string, string | null>;
};
const v = JSON.parse(readFileSync(new URL("./vecteurs/navigateur.json", import.meta.url), "utf-8")) as {
  proprietaires: { nom: string | null; pw_owner: string; proprietaire: string }[];
  verbes: { outil: string; args: unknown; valeur: string }[];
  captures: { outil: unknown; args: unknown; resultat: unknown; valeur: Dict | null }[];
  chemins: { sid: unknown; valeur: string | null }[];
  suivis: Etape[][];
  enregistrements: {
    sid: string;
    utilisateur: string;
    fichiers: Record<string, string>;
    proprietaires: Record<string, string | null>;
  }[];
  alias: Record<string, string[]>;
  constantes: { max: number; ttl: number };
};

const avant = process.env["PW_OWNERS_DIR"];
afterEach(() => {
  if (avant === undefined) delete process.env["PW_OWNERS_DIR"];
  else process.env["PW_OWNERS_DIR"] = avant;
});

function dossierPrive(): string {
  const d = mkdtempSync(join(tmpdir(), "elpis-pw-"));
  onTestFinished(() => rmSync(d, { recursive: true, force: true }));
  process.env["PW_OWNERS_DIR"] = d;
  return d;
}

describe("vecteurs Python de _pw_session", () => {
  it("propriétaire transmis au service : nom sûr ou empreinte, après safe_sandbox_name", () => {
    for (const c of v.proprietaires) {
      expect(pwOwner(c.nom), String(c.nom)).toBe(c.pw_owner);
      expect(proprietaire(c.nom), String(c.nom)).toBe(c.proprietaire);
    }
  });

  it("verbes des outils pw_* (synonymes) et URL des captures", () => {
    expect(PW_VERB_ALIASES).toEqual(v.alias);
    for (const c of v.verbes) expect(pwVerbOf(c.outil, c.args), JSON.stringify(c)).toBe(c.valeur);
    for (const c of v.captures) {
      const r = extractPwScreenshotUrl(c.outil, c.args, c.resultat, 1_700_000_000.123);
      const pas = r?.["step"];
      expect(
        r === null ? null : { ...r, step: typeof pas === "bigint" ? Number(pas) : pas },
        JSON.stringify(c),
      ).toEqual(c.valeur);
    }
  });

  it("capture de la vision : seulement celle de pw_page inspect, de sa propre session, nom strict", () => {
    const args = { session_id: "sessAAAA1111", action: "inspect" };
    const res = (nom: unknown): string => JSON.stringify({ ok: true, step: 4, vision_screenshot: nom });
    expect(extractPwVisionCapture("pw_page", args, res("vision_sessAAAA1111_4.jpg"))).toBe(
      "vision_sessAAAA1111_4.jpg",
    );
    expect(
      extractPwVisionCapture(
        "pw_page",
        { sid: "sessAAAA1111", op: "inspect" },
        res("vision_sessAAAA1111_4.jpg"),
      ),
    ).toBe("vision_sessAAAA1111_4.jpg");
    for (const [outil, a, r] of [
      ["pw_page", args, res("vision_sessBBBB2222_4.jpg")],
      ["pw_page", args, res("vision_sessAAAA1111_4.png")],
      ["pw_page", args, res("vision_sessAAAA1111_4.jpg/../x")],
      ["pw_page", args, res("../vision_sessAAAA1111_4.jpg")],
      ["pw_page", args, res(4)],
      ["pw_page", args, JSON.stringify({ ok: true, step: 4 })],
      ["pw_page", { ...args, action: "screenshot" }, res("vision_sessAAAA1111_4.jpg")],
      ["pw_act", args, res("vision_sessAAAA1111_4.jpg")],
      ["pw_page", { session_id: "../x", action: "inspect" }, res("vision_../x_4.jpg")],
      ["pw_page", args, "pas du json vision_screenshot"],
    ] as const)
      expect(extractPwVisionCapture(outil, a, r), JSON.stringify([outil, a, r])).toBeNull();
  });

  it("capture explicite (pw_page screenshot, pw_observe som) : montrée sans capture d'étape, de sa propre session, nom strict", () => {
    const args = { session_id: "sessAAAA1111", action: "screenshot" };
    const res = (nom: unknown, extra: object = {}): string =>
      JSON.stringify({
        ok: true,
        screenshot: nom,
        screenshot_url: `/api/playwright/screenshot/${String(nom)}`,
        ...extra,
      });
    const attendu = (pas: number, nom = `shot_sessAAAA1111_${pas}.png`) => ({
      url: `/api/playwright/screenshot/${nom}?t=1700000000123`,
      step: pas,
      session_id: "sessAAAA1111",
    });
    const lire = (outil: string, a: object, r: string) =>
      extractPwScreenshotUrl(outil, a, r, 1_700_000_000.123);
    expect(lire("pw_page", args, res("shot_sessAAAA1111_7.png"))).toEqual(attendu(7));
    expect(lire("pw_observe", { sid: "sessAAAA1111", mode: "som" }, res("shot_sessAAAA1111_12.png"))).toEqual(
      attendu(12),
    );
    // Préférée à une capture d'étape du même résultat.
    expect(lire("pw_page", args, res("shot_sessAAAA1111_7.png", { screenshot_step: 7 }))).toEqual(attendu(7));
    for (const nom of [
      "shot_sessBBBB2222_7.png",
      "shot_sessAAAA1111_7.jpg",
      "shot_sessAAAA1111_0.png",
      "shot_sessAAAA1111_1731500000000.png",
      "shot_sessAAAA1111_7.png/../x",
      "../shot_sessAAAA1111_7.png",
      "shot_sessAAAA1111_x.png",
      "smart_sessAAAA1111.png",
      "view_sessAAAA1111.png",
      7,
      null,
    ])
      expect(lire("pw_page", args, res(nom)), JSON.stringify(nom)).toBeNull();
    expect(lire("desktop_act", args, res("shot_sessAAAA1111_7.png"))).toBeNull();
    expect(lire("pw_page", { session_id: "../x", action: "screenshot" }, res("shot_../x_7.png"))).toBeNull();
  });

  it("chemins des fichiers compagnons : aucune traversée", () => {
    process.env["PW_OWNERS_DIR"] = "/srv/proprietaires";
    for (const c of v.chemins) expect(pwOwnerPath(c.sid), String(c.sid)).toBe(c.valeur);
  });

  it("suivi start/stop/cleanup : même mémoire, mêmes fichiers, mêmes propriétaires", async () => {
    for (const seq of v.suivis) {
      const dossier = dossierPrive();
      for (const e of seq) {
        await trackPwSessionOwnership(e.outil, e.args, e.resultat, e.utilisateur);
        const fichiers = Object.fromEntries(
          readdirSync(dossier)
            .sort()
            .map((n) => [n, readFileSync(join(dossier, n), "utf-8")]),
        );
        expect(fichiers, JSON.stringify(e.args)).toEqual(e.fichiers);
        const proprios: Record<string, string | null> = {};
        for (const sid of Object.keys(e.proprietaires)) proprios[sid] = await getPwSessionOwner(sid);
        expect(proprios, JSON.stringify(e.args)).toEqual(e.proprietaires);
      }
      for (const e of seq)
        for (const sid of [...e.memoire.map(([s]) => s), ...Object.keys(e.proprietaires)])
          await unregisterPwSessionOwner(sid);
    }
  });
});

describe("pose par l'outil pw_session (record_pw_session_owner)", () => {
  it("vecteurs Python : vides ignorés, compagnon écrit si le sid est sûr, mémoire sinon, dernier propriétaire gagnant", async () => {
    const dossier = dossierPrive();
    for (const e of v.enregistrements) {
      await recordPwSessionOwner(e.sid, e.utilisateur);
      const fichiers = Object.fromEntries(
        readdirSync(dossier)
          .sort()
          .map((n) => [n, readFileSync(join(dossier, n), "utf-8")]),
      );
      expect(fichiers, `${e.sid} ${e.utilisateur}`).toEqual(e.fichiers);
      for (const [sid, attendu] of Object.entries(e.proprietaires))
        expect(await getPwSessionOwner(sid), `${e.sid} → ${sid}`).toBe(attendu);
    }
    for (const e of v.enregistrements) if (e.sid) await unregisterPwSessionOwner(e.sid);
  });
});

describe("fichiers compagnons", () => {
  it("un compagnon de plus de 24 h est purgé à la prochaine écriture", async () => {
    const dossier = dossierPrive();
    writeFileSync(join(dossier, "vieuxAAAA1111.owner"), "x");
    const jadis = Date.now() / 1000 - v.constantes.ttl - 60;
    utimesSync(join(dossier, "vieuxAAAA1111.owner"), jadis, jadis);
    await registerPwSessionOwner("neufBBBB2222", "alice");
    expect(existsSync(join(dossier, "vieuxAAAA1111.owner"))).toBe(false);
    expect(readFileSync(join(dossier, "neufBBBB2222.owner"), "utf-8")).toBe("alice");
    await unregisterPwSessionOwner("neufBBBB2222");
  });

  it("dossier ouvert aux autres comptes : compagnons ignorés (contrôle en mémoire seul)", async () => {
    const dossier = mkdtempSync(join(tmpdir(), "elpis-pw-ouvert-"));
    onTestFinished(() => rmSync(dossier, { recursive: true, force: true }));
    chmodSync(dossier, 0o755);
    process.env["PW_OWNERS_DIR"] = dossier;
    writeFileSync(join(dossier, "autreCCCC3333.owner"), "mallory");
    expect(await getPwSessionOwner("autreCCCC3333")).toBeNull();
    await registerPwSessionOwner("sessDDDD4444", "bob");
    expect(existsSync(join(dossier, "sessDDDD4444.owner"))).toBe(false);
    expect(await getPwSessionOwner("sessDDDD4444")).toBe("bob");
    await unregisterPwSessionOwner("sessDDDD4444");
  });

  it(`registre en mémoire borné à ${v.constantes.max} sessions (les plus anciennes sortent)`, async () => {
    const dossier = join(dossierPrive(), "absent");
    mkdirSync(dossier);
    chmodSync(dossier, 0o777);
    process.env["PW_OWNERS_DIR"] = dossier;
    for (let i = 0; i <= v.constantes.max; i++)
      await registerPwSessionOwner(`sess${String(i).padStart(8, "0")}`, "u");
    expect(await getPwSessionOwner("sess00000000")).toBeNull();
    expect(await getPwSessionOwner(`sess${String(v.constantes.max).padStart(8, "0")}`)).toBe("u");
  });
});
