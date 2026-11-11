// SPDX-License-Identifier: MIT
/** apps/core/test/voix/voix.test.ts — moteur vocal : fonctions pures (vecteurs Python), routes /api/voice/* rejouées contre la vraie app FastAPI avec de faux services, créneaux, débit, gardes. */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { FlottantPy, HttpError, pyJsonDumps, pyJsonLoads } from "@elpis/commun";
import { invalidateConfigCache, surchargerConfig } from "@elpis/config";
import { initialiserBase } from "@elpis/db";
import { ouvrirBaseDeTest } from "@elpis/db/test";
import type { BaseDeTest } from "@elpis/db/test";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  controleDebit,
  creerFamilleVoix,
  Jauge,
  jaugeVoix,
  REGLAGES_VOIX,
  reinitialiserVoix,
  cleCache,
} from "../../src/familles/voix";
import type { MoteurVoix } from "../../src/familles/voix";
import { ReponseHttp } from "../../src/llm/client-http";
import { audioCtxPour, dureeMs, litEnteteWav, valideWavDictee } from "../../src/voix/audio";
import type { EnTeteWav } from "../../src/voix/audio";
import {
  CLIENT_VOIX,
  confiance,
  courant,
  delaiStt,
  detailHttp,
  messageHttp,
  multipartHttpx,
  racineMoteur,
  silenceWav,
  synthesize,
  transcribe,
  urlMoteur,
} from "../../src/voix/client";
import type { SectionVoix } from "../../src/voix/client";
import { configVoix } from "../../src/voix/config";
import { VoiceError, VoiceTimeout } from "../../src/voix/erreurs";
import { clientVoix, installerClientVoix } from "../../src/voix/ports";
import { estBruit } from "../../src/voix/filtre";
import { estPrononcable, pourLaVoix } from "../../src/voix/texte";
import { appTest } from "../aides";
import { FauxLan, portFerme } from "../faux-lan";
import type { ReponseScriptee, RequeteVue } from "../faux-lan";

type Dict = Record<string, unknown>;
type Issue = { valeur: unknown } | { erreur: string; message: string };
type Etape = {
  u?: number;
  m?: string;
  p?: string;
  json?: unknown;
  corps?: string;
  type?: string;
  fichier?: string;
  nom?: string;
  type_fichier?: string;
  services?: ReponseScriptee[];
  config?: Dict;
  reglages?: Record<string, Dict>;
  debit?: Record<string, number>;
  raz?: boolean;
};
type Reponse = {
  statut: number;
  type: string | null;
  cache: string | null;
  voix: string | null;
  car: string | null;
  corps: string;
  vues: RequeteVue[];
  restantes: number;
} | null;

const brut = readFileSync(new URL("../vecteurs/voix.json", import.meta.url), "utf-8");
const V = JSON.parse(brut) as { pures: Record<string, unknown[]> };
const VP = pyJsonLoads(brut) as { etapes: Etape[]; reponses: Reponse[] };

function nombre(v: unknown): unknown {
  if (v !== null && typeof v === "object" && "$flottant" in (v as Dict))
    return { nan: Number.NaN, inf: Infinity, "-inf": -Infinity }[(v as Dict)["$flottant"] as string];
  return v;
}

function issue(f: () => unknown): Issue {
  try {
    return { valeur: f() };
  } catch (e) {
    return { erreur: (e as Error).name, message: (e as Error).message };
  }
}

function enteteDict(e: EnTeteWav): Dict {
  return {
    taux: e.taux,
    canaux: e.canaux,
    bits: e.bits,
    octets_donnees: e.octets_donnees,
    duree_ms: dureeMs(e),
  };
}

describe("voix : fonctions pures (vecteurs Python)", () => {
  it("markdown → texte prononçable, coupe à une fin de phrase", () => {
    for (const [t, m, attendu] of V.pures["textes"] as [string | null, number, Issue][])
      expect(
        issue(() => pourLaVoix(t, m)),
        JSON.stringify([t, m]),
      ).toEqual(attendu);
    for (const [t, attendu] of V.pures["prononcables"] as [string | null, boolean][])
      expect(estPrononcable(t), JSON.stringify(t)).toBe(attendu);
  });

  it("hallucinations de whisper : génériques, formules courtes douteuses, enveloppes, boucles", () => {
    for (const [[t, l, n], attendu] of V.pures["bruits"] as [[string, unknown, unknown], boolean][])
      expect(
        estBruit(t, nombre(l) as number | null, nombre(n) as number | null),
        JSON.stringify([t, l, n]),
      ).toBe(attendu);
  });

  it("en-tête WAV : blocs parcourus, formats refusés, plafond de durée (messages identiques)", () => {
    for (const [b64, lu, valide30, valide1] of V.pures["wavs"] as [string, Issue, Issue, Issue][]) {
      const d = new Uint8Array(Buffer.from(b64, "base64"));
      const nom = b64.slice(0, 24);
      const norme = (i: Issue): Issue => ("erreur" in i ? { erreur: i.erreur, message: i.message } : i);
      expect(norme(issue(() => enteteDict(litEnteteWav(d)))), nom).toEqual(lu);
      expect(norme(issue(() => enteteDict(valideWavDictee(d, 30)))), nom).toEqual(valide30);
      expect(norme(issue(() => enteteDict(valideWavDictee(d, 1)))), nom).toEqual(valide1);
    }
  });

  it("contexte d'encodeur, délai proportionnel, URL du moteur, messages HTTP", () => {
    for (const [d, attendu] of V.pures["contextes"] as [unknown, Issue][])
      expect(
        issue(() => audioCtxPour(nombre(d) as number)),
        String(d),
      ).toEqual(attendu);
    for (const [t, d, attendu] of V.pures["delais"] as [number, number, number][])
      expect(delaiStt(t, d), `${t} ${d}`).toBe(attendu);
    for (const [b, s, attendu] of V.pures["urls"] as [string | null, string, Issue][])
      expect(
        issue(() => urlMoteur(b, s)),
        `${b} ${s}`,
      ).toEqual(attendu);
    for (const [c, attendu] of V.pures["messages"] as [number, string][])
      expect(messageHttp(c)).toBe(attendu);
    for (const [r, attendu] of V.pures["racines"] as [string | null, Issue][])
      expect(
        issue(() => racineMoteur(r)),
        String(r),
      ).toEqual(attendu);
    for (const [ids, cfg, a, attendu] of V.pures["courants"] as [string[], string, string | null, unknown][])
      expect(courant(ids, cfg, a)).toBe(attendu);
  });

  it("détail d'une réponse en erreur, scores des segments, clé du cache de synthèse", () => {
    for (const [b64, type, attendu] of V.pures["details"] as [string, string | null, string][]) {
      const r = new ReponseHttp({
        statusCode: 500,
        request: { method: "POST", url: "http://x" },
        content: new Uint8Array(Buffer.from(b64, "base64")),
        headers: type ? { "content-type": type } : {},
      });
      expect(detailHttp(r), b64).toBe(attendu);
    }
    for (const [charge, attendu] of V.pures["confiances"] as [string, Issue][]) {
      const c = pyJsonLoads(JSON.stringify(charge).replaceAll('{"$flottant":"nan"}', "NaN")) as Dict;
      const obtenu = issue(() => confiance(c));
      if ("erreur" in attendu) expect(obtenu, JSON.stringify(charge)).toEqual(attendu);
      else
        expect(obtenu, JSON.stringify(charge)).toEqual({ valeur: (attendu.valeur as unknown[]).map(nombre) });
    }
    for (const [t, cfg, attendu] of V.pures["cles"] as [string, Dict, string][])
      expect(cleCache(t, cfg as SectionVoix)).toBe(attendu);
  });

  it("multipart à l'octet de httpx et silence de la sonde à l'octet du module wave", () => {
    for (const [champs, attendu] of V.pures["multipart"] as [[string, string][], string][]) {
      const c = multipartHttpx(
        champs,
        {
          champ: "file",
          nom: "dictee.wav",
          type: "audio/wav",
          data: new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0xff]),
        },
        "B0UNDARY",
      );
      expect(`${Buffer.from(c.octets).toString("base64")}|${c.type}`).toBe(attendu);
    }
    expect(Buffer.from(silenceWav()).toString("base64")).toBe(V.pures["silence"]);
  });
});

describe("voix : routes rejouées contre la vraie app FastAPI (faux services du LAN)", () => {
  let t: BaseDeTest;
  let app: FastifyInstance;
  let lan: FauxLan;
  let ferme: string;
  let dossier: string;
  let restaurer: () => void;
  const debitAvant = { ...REGLAGES_VOIX.debitMax };

  beforeAll(async () => {
    t = ouvrirBaseDeTest("sqlite");
    await initialiserBase(t.base);
    for (const nom of ["alice", "bob"])
      await t.base.run(
        "INSERT INTO users(username, pass_salt, pass_hash, created_at, is_admin) VALUES(?,?,?,?,0)",
        [nom, "s", "h", 0],
      );
    dossier = mkdtempSync(path.join(tmpdir(), "elpis-voix-"));
    writeFileSync(path.join(dossier, "config.json"), "{}");
    restaurer = surchargerConfig({ CONFIG_JSON_PATH: path.join(dossier, "config.json") });
    invalidateConfigCache();
    lan = await FauxLan.demarrer();
    ferme = await portFerme();
    reinitialiserVoix();
    app = await appTest({
      familles: [creerFamilleVoix({ base: t.base })],
      gardes: {
        session: (req) => {
          const v = req.headers["x-uid"];
          if (!v) throw new HttpError(401, "not logged in");
          req.utilisateur = { id: Number(v), username: null };
        },
      },
    });
  });

  afterAll(async () => {
    Object.assign(REGLAGES_VOIX.debitMax, debitAvant);
    reinitialiserVoix();
    await app.close();
    await lan.arreter();
    await t.fermer();
    restaurer();
    invalidateConfigCache();
    rmSync(dossier, { recursive: true, force: true });
  });

  it("chaque étape rend le même statut, le même corps et les mêmes requêtes aux services", async () => {
    let n = 0;
    for (const [i, e] of VP.etapes.entries()) {
      const attendu = VP.reponses[i];
      if (e.config !== undefined) {
        const texte = pyJsonDumps(e.config, { ensureAscii: false })
          .replaceAll("<SERVICE>", lan.url)
          .replaceAll("<FERME>", ferme);
        writeFileSync(path.join(dossier, "config.json"), texte);
        invalidateConfigCache();
        continue;
      }
      if (e.reglages !== undefined) {
        for (const [uid, r] of Object.entries(e.reglages))
          await t.base.run("UPDATE users SET settings_json=? WHERE id=?", [
            pyJsonDumps(r, { ensureAscii: false }),
            Number(uid),
          ]);
        continue;
      }
      if (e.debit !== undefined) {
        Object.assign(REGLAGES_VOIX.debitMax, e.debit);
        continue;
      }
      if (e.raz) {
        reinitialiserVoix();
        continue;
      }
      lan.reponses = [...(e.services ?? [])];
      lan.vues.length = 0;
      const entetes: Record<string, string> = { "x-uid": String(e.u) };
      let payload: Buffer | undefined;
      if (e.fichier !== undefined) {
        const c = multipartHttpx([], {
          champ: "file",
          nom: e.nom ?? "dictee.wav",
          type: e.type_fichier ?? "audio/wav",
          data: new Uint8Array(Buffer.from(e.fichier, "base64")),
        });
        payload = Buffer.from(c.octets);
        entetes["content-type"] = c.type;
      } else if (e.json !== undefined) {
        payload = Buffer.from(pyJsonDumps(e.json, { ensureAscii: false }), "utf-8");
        entetes["content-type"] = "application/json";
      } else if (e.corps !== undefined) {
        payload = Buffer.from(e.corps, "utf-8");
        entetes["content-type"] = e.type ?? "";
      }
      const r = await app.inject({
        method: e.m as "GET",
        url: e.p ?? "/",
        headers: entetes,
        ...(payload ? { payload } : {}),
      });
      const type = r.headers["content-type"] as string | undefined;
      expect(
        {
          statut: r.statusCode,
          type: type?.startsWith("application/json") ? "application/json" : (type ?? null),
          cache: (r.headers["cache-control"] as string | undefined) ?? null,
          voix: (r.headers["x-elpis-voice"] as string | undefined) ?? null,
          car: (r.headers["x-elpis-chars"] as string | undefined) ?? null,
          corps: r.rawPayload.toString("base64"),
          vues: lan.vues,
          restantes: lan.reponses.length,
        },
        `étape ${i} : ${e.m} ${e.p} ${JSON.stringify(e.json ?? e.corps ?? "")}`,
      ).toEqual(attendu);
      n++;
    }
    expect(n).toBeGreaterThan(60);
  });
});

describe("voix : créneaux, débit et gardes", () => {
  beforeEach(() => reinitialiserVoix());

  it("changer le plafond ne perd pas les détenteurs (dette remboursée par les retours)", async () => {
    const j = new Jauge(2);
    await j.prendre(2, 0.1);
    await j.prendre(2, 0.1);
    await expect(j.prendre(1, 0.02)).rejects.toThrow();
    j.rendre();
    await expect(j.prendre(1, 0.02)).rejects.toThrow();
    j.rendre();
    await j.prendre(1, 0.1);
    await expect(j.prendre(1, 0.02)).rejects.toThrow();
    await j.prendre(2, 0.1);
  });

  it("baisse avec des créneaux libres : retirés tout de suite ; un retour réveille le premier en attente", async () => {
    const j = new Jauge(3);
    await j.prendre(1, 0.1);
    await expect(j.prendre(1, 0.02)).rejects.toThrow();
    const attente = j.prendre(1, 1);
    j.rendre();
    await attente;
  });

  it("fenêtre glissante d'une minute par route et par compte", () => {
    let horloge = 1000;
    reinitialiserVoix(() => horloge);
    const avant = REGLAGES_VOIX.debitMax.speak;
    REGLAGES_VOIX.debitMax.speak = 2;
    try {
      controleDebit("speak", 7);
      controleDebit("speak", 7);
      expect(() => controleDebit("speak", 7)).toThrow(HttpError);
      controleDebit("speak", 8);
      controleDebit("transcribe", 7);
      horloge += 61;
      controleDebit("speak", 7);
    } finally {
      REGLAGES_VOIX.debitMax.speak = avant;
    }
  });

  it("aucun créneau libre : 503 « occupé », le moteur n'est jamais appelé", async () => {
    const d = mkdtempSync(path.join(tmpdir(), "elpis-voix-occupe-"));
    writeFileSync(
      path.join(d, "config.json"),
      JSON.stringify({
        voice: { enabled: true, stt: { endpoint_url: "http://stt" }, tts: { endpoint_url: "http://tts" } },
      }),
    );
    const restaurer = surchargerConfig({ CONFIG_JSON_PATH: path.join(d, "config.json") });
    invalidateConfigCache();
    const t = ouvrirBaseDeTest("sqlite");
    await initialiserBase(t.base);
    await t.base.run(
      "INSERT INTO users(username, pass_salt, pass_hash, created_at, is_admin, settings_json) VALUES(?,?,?,?,0,?)",
      ["alice", "s", "h", 0, '{"voice_input_enabled": true, "voice_reply_enabled": true}'],
    );
    const appels: string[] = [];
    const moteur: MoteurVoix = {
      transcribe: async () => {
        appels.push("stt");
        return { text: "x", avg_logprob: null, no_speech_prob: null };
      },
      synthesize: async () => {
        appels.push("tts");
        return [new Uint8Array([1]), "audio/wav"];
      },
    };
    const app = await appTest({
      familles: [creerFamilleVoix({ base: t.base, moteur })],
      gardes: { session: (req) => void (req.utilisateur = { id: 1, username: "alice" }) },
    });
    const attenteAvant = REGLAGES_VOIX.attenteCreneauMaxSec;
    REGLAGES_VOIX.attenteCreneauMaxSec = 0.05;
    try {
      await jaugeVoix("tts", 2).prendre(2, 0.1);
      await jaugeVoix("tts", 2).prendre(2, 0.1);
      const r = await app.inject({ method: "POST", url: "/api/voice/speak", payload: { text: "Bonjour." } });
      expect([r.statusCode, r.json()]).toEqual([
        503,
        { detail: "Moteur de synthèse occupé : réessayez dans un instant." },
      ]);
      expect(appels).toEqual([]);
    } finally {
      REGLAGES_VOIX.attenteCreneauMaxSec = attenteAvant;
      await app.close();
      await t.fermer();
      restaurer();
      invalidateConfigCache();
      rmSync(d, { recursive: true, force: true });
    }
  });

  it("un anonyme est refusé avant toute validation (écart E15)", async () => {
    const t = ouvrirBaseDeTest("sqlite");
    await initialiserBase(t.base);
    const app = await appTest({
      familles: [creerFamilleVoix({ base: t.base })],
      gardes: {
        session: () => {
          throw new HttpError(401, "not logged in");
        },
      },
    });
    try {
      for (const [m, u] of [
        ["GET", "/api/voice/status"],
        ["POST", "/api/voice/transcribe"],
        ["POST", "/api/voice/speak"],
      ] as const)
        expect((await app.inject({ method: m, url: u })).json()).toEqual({ detail: "not logged in" });
    } finally {
      await app.close();
      await t.fermer();
    }
  });
});

describe("voix : client (délais, vérification TLS, panne)", () => {
  let lan: FauxLan;
  beforeAll(async () => {
    lan = await FauxLan.demarrer();
  });
  afterAll(async () => {
    await lan.arreter();
  });

  it("un moteur trop lent rend VoiceTimeout (504) sans attendre au-delà du délai", async () => {
    lan.reponses = [{ statut: 200, octets: "UklGRg==", delaiMs: 3000 }];
    const cfg = { ...configVoix({}).tts, endpoint_url: lan.url, timeout_sec: 0.2 } as SectionVoix;
    const debut = Date.now();
    await expect(synthesize("Bonjour.", cfg)).rejects.toBeInstanceOf(VoiceTimeout);
    expect(Date.now() - debut).toBeLessThan(2500);
  });

  it("un moteur qui coupe la connexion rend « Moteur vocal injoignable. » ; vitesse écrite en flottant", async () => {
    lan.reponses = [{ statut: 200, coupe: true }];
    const cfg = { ...configVoix({}).stt, endpoint_url: lan.url } as SectionVoix;
    await expect(transcribe(silenceWav(), cfg, 1000)).rejects.toMatchObject({
      statut: 502,
      message: "Moteur vocal injoignable.",
    });
    lan.reponses = [{ statut: 200, octets: "UklGRg==" }];
    lan.vues.length = 0;
    await synthesize("x", { ...configVoix({}).tts, endpoint_url: lan.url, speed: 1 } as SectionVoix);
    expect(Buffer.from(lan.vues[0]?.corps ?? "", "base64").toString()).toBe(
      '{"text":"x","voice":"fr_FR-siwis-medium","speed":1.0}',
    );
    expect(new FlottantPy(1).toString()).toBe("1.0");
  });

  it("adresse sans schéma (« IP:port ») : « Moteur vocal injoignable. » (502) comme httpx, pas une panne 500", async () => {
    for (const adresse of ["192.0.2.10:8090", "vm-sans-schema", "localhost:8090"]) {
      const cfg = { ...configVoix({}).stt, endpoint_url: adresse } as SectionVoix;
      await expect(transcribe(silenceWav(), cfg, 1000), adresse).rejects.toMatchObject({
        statut: 502,
        message: "Moteur vocal injoignable.",
      });
    }
  });

  it("client de la console branché par le port : mêmes sondes et listes que le client des routes", async () => {
    installerClientVoix(CLIENT_VOIX);
    try {
      expect(clientVoix()).toBe(CLIENT_VOIX);
      await expect(clientVoix().sondeStt({ ...configVoix({}).stt, endpoint_url: "" })).rejects.toBeInstanceOf(
        VoiceError,
      );
      lan.reponses = [{ statut: 200, json: { text: " ok " } }];
      expect(await clientVoix().sondeStt({ ...configVoix({}).stt, endpoint_url: lan.url })).toMatchObject({
        text: "ok",
      });
    } finally {
      installerClientVoix(null);
    }
    expect(() => clientVoix()).toThrow("client du moteur vocal non branché");
  });
});
