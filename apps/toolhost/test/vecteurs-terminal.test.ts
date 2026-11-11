// SPDX-License-Identifier: MIT
/** apps/toolhost/test/vecteurs-terminal.test.ts — vecteurs du vrai Python (migration-kit/vecteurs/terminal.py) : argv du PTY, identifiants, noms par défaut et de création, taille, frappe, messages de contrôle de la boucle WebSocket. */
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { privdrop } from "@elpis/bac";
import { pyJsonLoads } from "@elpis/commun";
import type { HttpError } from "@elpis/commun";
import { surchargerConfig } from "@elpis/config";
import { initialiserBase } from "@elpis/db";
import { ouvrirBaseDeTest } from "@elpis/db/test";
import type { BaseDeTest } from "@elpis/db/test";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  construireCommandePty,
  DEFAULT_SID,
  MAX_SESSIONS_PER_USER,
  PTY_EXEC_USER,
  PTY_IDLE_TIMEOUT_S,
  PTY_PRIVDROP_WRAP,
  Terminal,
  Terminaux,
  TERM_BOOTSTRAP,
} from "../src/terminal/pty";
import { lireTaille, nomDeCreation } from "../src/terminal/routes";
import { nomParDefaut, SESSION_DB_RETENTION_S, sidValide } from "../src/terminal/sessions";
import {
  boucleWs,
  jsonCompact,
  tamponner,
  WS_INPUT_RATE_CAPACITY,
  WS_INPUT_RATE_REFILL,
  WS_MAX_CTRL_BYTES,
  WS_QUOTA_INTERVAL_S,
  WS_QUOTA_WARN_PCT,
} from "../src/terminal/ws";
import { configTest, entetes, hoteTest, journalMuet } from "./aides";
import type { HoteTest } from "./aides";
import { creerFauxDockerTerminal, FausseSocket, FauxPty, lanceurFactice } from "./terminal-aides";

interface Vecteurs {
  constantes: Record<string, unknown>;
  commandes: { conteneur: string; verdict: boolean | null; argv: string[] }[];
  sids: { sid: string; valide: boolean }[];
  noms: { noms: unknown[]; attendu: string }[];
  creation: { corps: unknown; nom: string }[];
  taille: { corps: unknown; reponse?: unknown; statut?: number; detail?: string; pose: number[] | null }[];
  frappe: { corps: unknown; reponse?: unknown; statut?: number; cree: boolean; octets: string }[];
  controles: { messages: string[]; trames: unknown[]; taille: number[]; ferme: number; hello: boolean }[];
  json_controle: string;
}

const TEXTE = readFileSync(new URL("./vecteurs/terminal.json", import.meta.url), "utf-8");
const V = JSON.parse(TEXTE) as Vecteurs;
/** Lu comme `json.loads` : `1.0` reste un flottant (le corps reçu par la route passe par pyJsonLoads). */
const VP = pyJsonLoads(TEXTE) as Vecteurs;

describe("vecteurs du terminal (Python)", () => {
  it("constantes", () => {
    expect(V.constantes).toEqual({
      DEFAULT_SID,
      MAX_SESSIONS_PER_USER,
      TERM_BOOTSTRAP,
      PTY_EXEC_USER,
      PTY_PRIVDROP_WRAP,
      PTY_IDLE_TIMEOUT_SEC: PTY_IDLE_TIMEOUT_S,
      SESSION_DB_RETENTION_SEC: SESSION_DB_RETENTION_S,
      WS_INPUT_RATE_CAPACITY,
      WS_INPUT_RATE_REFILL,
      WS_MAX_CTRL_BYTES,
      WS_QUOTA_INTERVAL_S,
      WS_QUOTA_WARN_PCT,
    });
    expect(jsonCompact({ type: "hello", fresh_shell: true })).toBe(V.json_controle);
  });

  it.each(V.commandes)("argv du PTY : $conteneur, sonde $verdict", ({ conteneur, verdict, argv }) => {
    privdrop.forget(conteneur);
    if (verdict !== null) privdrop.remember(conteneur, PTY_EXEC_USER, verdict);
    try {
      expect(construireCommandePty(conteneur)).toEqual(argv);
    } finally {
      privdrop.forget(conteneur);
    }
  });

  it("identifiants de session", () => {
    expect(V.sids.map((c) => [c.sid, sidValide(c.sid)])).toEqual(V.sids.map((c) => [c.sid, c.valide]));
  });

  it("noms par défaut", () => {
    expect(V.noms.map((c) => nomParDefaut(c.noms))).toEqual(V.noms.map((c) => c.attendu));
  });

  it("nom retenu à la création (vide : premier libre après « Terminal 1 »)", () => {
    expect(VP.creation.map((c) => nomDeCreation(c.corps) || nomParDefaut(["Terminal 1"]))).toEqual(
      VP.creation.map((c) => c.nom),
    );
  });

  it("taille demandée : valeurs posées, 400, tailles hors `unsigned short` ignorées", () => {
    for (const c of V.taille) {
      let obtenu: unknown;
      try {
        const [l, col] = lireTaille(c.corps);
        const p = new FauxPty();
        new Terminal(p.commeIPty(), 7, "s", "/tmp", "elpis-sb-x").redimensionner(l, col);
        obtenu = { reponse: { ok: true }, pose: p.tailles[0] ?? null };
      } catch (e) {
        obtenu = { statut: (e as HttpError).statusCode, detail: (e as HttpError).detail, pose: null };
      }
      const { corps: _c, ...attendu } = c;
      expect(obtenu, JSON.stringify(c.corps)).toEqual(attendu);
    }
  });
});

describe("vecteurs du terminal : frappe par la route", () => {
  let dossier: string;
  let h: HoteTest;
  let t: BaseDeTest;
  let restaurer: () => void = () => undefined;
  const faux = lanceurFactice();

  beforeAll(async () => {
    dossier = realpathSync(mkdtempSync(path.join(tmpdir(), "elpis-terminal-vecteurs-")));
    const docker = creerFauxDockerTerminal(path.join(dossier, "docker"));
    vi.stubEnv("PATH", `${docker.bin}${path.delimiter}${process.env["PATH"] ?? ""}`);
    restaurer = surchargerConfig({ SANDBOX_DIR: path.join(dossier, "sb") });
    t = ouvrirBaseDeTest("sqlite");
    await initialiserBase(t.base);
    h = await hoteTest(configTest(), { base: t.base, lanceurPty: faux.lanceur });
  });

  afterAll(async () => {
    await h?.fermer();
    await t?.fermer();
    restaurer();
    vi.unstubAllEnvs();
    if (dossier) rmSync(dossier, { recursive: true, force: true });
  });

  it.each(V.frappe.map((c, i) => [i, c] as const))("cas %i", async (_i, c) => {
    const obtenir = vi.spyOn(h.composition.terminaux, "obtenir");
    const avant = faux.crees.reduce((n, p) => n + p.ecrits.length, 0);
    const corps = c.corps === "<json invalide>" ? "{pas du json" : JSON.stringify(c.corps);
    const r = await h.app.inject({
      method: "POST",
      url: "/api/terminal/input",
      headers: { ...entetes(), "content-type": "application/json" },
      payload: corps,
    });
    const ecrits = faux.crees.flatMap((p) => p.ecrits).slice(avant);
    const obtenu = {
      ...(r.statusCode === 200 ? { reponse: r.json() as unknown } : { statut: r.statusCode }),
      cree: obtenir.mock.calls.length > 0,
      octets: Buffer.concat(ecrits).toString("hex"),
    };
    obtenir.mockRestore();
    const { corps: _c, type: _t, ...attendu } = c as typeof c & { type?: string };
    expect(obtenu).toEqual(attendu);
    if (r.statusCode === 500) expect(r.body).toBe("Internal Server Error");
  });
});

describe("vecteurs du terminal : messages de contrôle de la boucle WebSocket", () => {
  it.each(V.controles.map((c, i) => [i, c] as const))("cas %i", async (_i, c) => {
    const pty = new FauxPty();
    const term = new Terminal(pty.commeIPty(), 7, "s1", tmpdir(), "elpis-sb-x");
    const socket = new FausseSocket();
    const terminaux = new Terminaux({ journal: journalMuet });
    const tampon = tamponner(socket.commeWs());
    for (const m of c.messages) socket.recevoir(m, false);
    const boucle = boucleWs(
      socket.commeWs(),
      term,
      {
        terminaux,
        base: () => Promise.reject(new Error("sans base")),
        journal: journalMuet,
      },
      tampon,
    );
    await new Promise((ok) => setTimeout(ok, 20));
    socket.fermeParLeClient(1000);
    await boucle;
    const textes = socket.textes();
    expect(textes[0]).toEqual({ type: "hello", fresh_shell: true });
    const derniere = pty.tailles.at(-1);
    expect({
      trames: textes.slice(1),
      taille: derniere === undefined ? [0, 0] : [derniere[0], derniere[1]],
    }).toEqual({ trames: c.trames, taille: c.taille });
  });
});
