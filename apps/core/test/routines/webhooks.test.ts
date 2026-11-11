// SPDX-License-Identifier: MIT
/** apps/core/test/routines/webhooks.test.ts — livraison des webhooks de routine rejouée contre le Python (vecteurs) : signatures, jetons, réponses indifférenciées, filtres, dédup, 503, 413, débit ; résumé d'événement ; corps en flux. */
import { createHmac, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { Readable } from "node:stream";

import { ErreurPython, pyJsonLoads } from "@elpis/commun";
import type { Dict } from "@elpis/commun";
import { initialiserBase } from "@elpis/db";
import { ouvrirBaseDeTest, PG_DE_TEST } from "@elpis/db/test";
import type { BaseDeTest } from "@elpis/db/test";
import type { FastifyInstance } from "fastify";
import { configurerCoffre } from "@elpis/securite";
import { afterEach, describe, expect, it, vi } from "vitest";

import { creerFamilleWebhooks } from "../../src/familles/webhooks";
import { installerCrochetJournal } from "../../src/journal";
import { createRoutine, markRunCancelled, setRoutineWebhook } from "../../src/routines/magasin";
import { Planificateur } from "../../src/routines/planificateur";
import { brancheDe, LimiteurDebit, resumeEvenement } from "../../src/routines/webhooks";
import { appTest } from "../aides";

/** Clé du coffre de l'essai (secrets de webhook chiffrés), jamais celle du système. */
configurerCoffre({
  cleEnv: randomBytes(32).toString("base64"),
  systeme: "/nonexistent/vault.key",
  repli: "/nonexistent/.vault.key",
});

type Corps = string | { hex: string } | { repete: [string, number] } | null;
type Requete = [string, [string, string][], Corps, number?];
type Etape = Requete | ["RAFALE", number, string] | ["AVANCER", number];

const V = JSON.parse(readFileSync(new URL("../vecteurs/routes-webhooks.json", import.meta.url), "utf-8")) as {
  resumes: [string, string][];
  resultats_resumes: ({ resume: string; branche: string | null } | { erreur: string })[];
  routines: [string, string, boolean, boolean, boolean, Dict | null][];
  gardes: number[];
  en_panne: number[];
  t0: number;
  pas: number;
  etapes: Etape[];
  reponses: { statut: number; corps: string }[];
  lancements: [number, string, string][];
  livraisons: [string, number][];
  runs: [number, number, string, string][];
};

const MOTEURS = PG_DE_TEST ? (["sqlite", "postgres"] as const) : (["sqlite"] as const);
const leaderFactice = { tenu: false, essayer: async () => false, rendre: async () => undefined };

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("résumé d'événement et branche (vecteurs purs)", () => {
  it.each(V.resumes.map((r, i) => [i, ...r] as const))("cas %i", (i, event, texte) => {
    const payload = pyJsonLoads(texte) as Dict;
    const attendu = V.resultats_resumes[i];
    if (attendu && "erreur" in attendu) {
      expect(() => resumeEvenement(event, payload)).toThrow(ErreurPython);
      return;
    }
    expect({ resume: resumeEvenement(event, payload), branche: brancheDe(event, payload) }).toEqual(attendu);
  });
});

interface Banc {
  t: BaseDeTest;
  app: FastifyInstance;
  secrets: Map<number, string>;
  lancements: [number, string, string][];
}

/** Routines du banc, secrets tirés ici (jamais ceux du Python), lancements tracés ; runs finis aussitôt hors routines gardées. */
async function monterBanc(moteur: "sqlite" | "postgres"): Promise<Banc> {
  const t = ouvrirBaseDeTest(moteur);
  await initialiserBase(t.base);
  const ids: Record<string, number> = {};
  for (const nom of ["alice", "bob"])
    ids[nom] = await t.base.insertId(
      "INSERT INTO users(username, pass_salt, pass_hash, created_at, is_admin) VALUES(?,?,?,?,?)",
      [nom, "s", "h", 0, 0],
    );
  vi.setSystemTime((V.t0 - 1000) * 1000);
  const secrets = new Map<number, string>();
  for (const [nom, titre, active, webhook, avecSecret, filtre] of V.routines) {
    const uid = ids[nom] as number;
    const rid = await createRoutine(t.base, uid, {
      name: titre,
      cron_expr: "",
      model: null,
      system_prompt: "",
      task_prompt: "t",
      mcp_servers: [],
      enabled: active,
    });
    const secret = avecSecret ? randomBytes(32).toString("hex") : undefined;
    if (secret !== undefined) secrets.set(rid, secret);
    await setRoutineWebhook(t.base, rid, uid, {
      enabled: webhook,
      ...(secret === undefined ? {} : { secret }),
      ...(filtre === null ? {} : { filter: filtre }),
    });
  }
  const planificateur = new Planificateur({ base: t.base, meneur: leaderFactice });
  vi.spyOn(planificateur, "executerRun").mockResolvedValue(undefined);
  const original = planificateur.lancerRun.bind(planificateur);
  const lancements: [number, string, string][] = [];
  vi.spyOn(planificateur, "lancerRun").mockImplementation(async (r, o) => {
    const rid = r["id"] as number;
    lancements.push([rid, o.trigger, o.context ?? ""]);
    if (V.en_panne.includes(rid)) throw new Error("base verrouillée");
    const runId = await original(r, o);
    if (runId !== null && !V.gardes.includes(rid)) await markRunCancelled(t.base, runId, 0);
    return runId;
  });
  const app = await appTest({ familles: [creerFamilleWebhooks({ base: t.base, planificateur })] });
  return { t, app, secrets, lancements };
}

function octets(corps: Corps): Buffer | null {
  if (corps === null) return null;
  if (typeof corps === "string") return Buffer.from(corps, "utf8");
  if ("hex" in corps) return Buffer.from(corps.hex, "hex");
  return Buffer.from(corps.repete[0].repeat(corps.repete[1]), "utf8");
}

function remplir(texte: string, brut: Buffer | null, secrets: Map<number, string>): string {
  let s = texte;
  for (const [rid, secret] of secrets) {
    const sig = createHmac("sha256", secret)
      .update(brut ?? Buffer.alloc(0))
      .digest("hex");
    s = s
      .replaceAll(`{sig:${rid}}`, sig)
      .replaceAll(`{SIG:${rid}}`, sig.toUpperCase())
      .replaceAll(`{secret:${rid}}`, secret);
  }
  return s.replaceAll("{faux}", "0".repeat(64));
}

describe.each(MOTEURS)("livraison rejouée contre le Python (%s)", (moteur) => {
  it("réponses, lancements, dédup et runs identiques ; aucun secret dans une réponse", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const banc = await monterBanc(moteur);
    try {
      let saut = 0;
      for (const [i, etape] of V.etapes.entries()) {
        vi.setSystemTime((V.t0 + V.pas * i + saut) * 1000);
        if (etape[0] === "AVANCER") {
          saut += etape[1] as number;
          continue;
        }
        if (etape[0] === "RAFALE") {
          const [, n, url] = etape as ["RAFALE", number, string];
          const compte: Record<string, number> = {};
          for (let k = 0; k < n; k++) {
            const r = await banc.app.inject({ method: "POST", url });
            compte[String(r.statusCode)] = (compte[String(r.statusCode)] ?? 0) + 1;
          }
          expect({
            statut: 0,
            corps: JSON.stringify(compte).replaceAll(",", ", ").replaceAll(":", ": "),
          }).toEqual(V.reponses[i]);
          continue;
        }
        const [chemin, entetes, corps, statutTs] = etape as Requete;
        const brut = octets(corps);
        const r = await banc.app.inject({
          method: "POST",
          url: remplir(chemin, brut, banc.secrets),
          headers: Object.fromEntries(entetes.map(([k, v]) => [k, remplir(v, brut, banc.secrets)])),
          ...(brut === null ? {} : { payload: brut }),
        });
        const etiquette = `étape ${i} : ${chemin}`;
        for (const secret of banc.secrets.values()) expect(r.body, etiquette).not.toContain(secret);
        if (statutTs !== undefined) {
          expect(r.statusCode, `${etiquette} (écart déclaré)`).toBe(statutTs);
          continue;
        }
        expect({ statut: r.statusCode, corps: r.body }, etiquette).toEqual(V.reponses[i]);
      }
      expect(banc.lancements).toEqual(V.lancements);
      const livraisons = await banc.t.base.valeurs(
        "SELECT delivery_id, routine_id FROM editor_webhook_deliveries ORDER BY routine_id, delivery_id",
      );
      expect(livraisons.map(([d, r]) => [d, Number(r)])).toEqual(V.livraisons);
      const runs = await banc.t.base.valeurs(
        'SELECT id, routine_id, status, "trigger" FROM editor_routine_runs ORDER BY id',
      );
      expect(runs.map(([a, b, c, d]) => [Number(a), Number(b), c, d])).toEqual(V.runs);
    } finally {
      await banc.app.close();
      await banc.t.fermer();
    }
  }, 120_000);
});

describe("livraison : cas hors vecteurs", () => {
  it("corps en flux sans longueur annoncée : coupé à 1 Mio (413), sinon lu en entier", async () => {
    const banc = await monterBanc("sqlite");
    try {
      const envoyer = (taille: number) =>
        banc.app.inject({
          method: "POST",
          url: "/api/webhooks/routines/1",
          headers: { "x-gitea-signature": "0".repeat(64) },
          payload: Readable.from([Buffer.alloc(taille - 10, 0x78), Buffer.alloc(10, 0x78)]),
        });
      const trop = await envoyer(1024 * 1024 + 1);
      expect([trop.statusCode, trop.json()]).toEqual([413, { ok: false, error: "payload trop volumineux" }]);
      const juste = await envoyer(1024 * 1024);
      expect([juste.statusCode, juste.json()]).toEqual([202, { ok: true }]);
    } finally {
      await banc.app.close();
      await banc.t.fermer();
    }
  });

  it("type de contenu multipart : octets bruts signés comme les autres", async () => {
    const banc = await monterBanc("sqlite");
    try {
      const brut = Buffer.from('--x\r\nContent-Disposition: form-data; name="a"\r\n\r\n1\r\n--x--\r\n');
      const sig = createHmac("sha256", banc.secrets.get(1) as string)
        .update(brut)
        .digest("hex");
      const r = await banc.app.inject({
        method: "POST",
        url: "/api/webhooks/routines/1",
        headers: { "x-gitea-signature": sig, "content-type": "multipart/form-data; boundary=x" },
        payload: brut,
      });
      expect([r.statusCode, r.json()]).toEqual([202, { ok: true, run_id: 1 }]);
    } finally {
      await banc.app.close();
      await banc.t.fermer();
    }
  });

  it("résumé qui lève (message de commit blanc) : 500 sans marque de dédup, la relivraison n'est pas « duplicate »", async () => {
    const banc = await monterBanc("sqlite");
    try {
      const brut = Buffer.from(JSON.stringify({ head_commit: { message: "  " } }));
      const sig = createHmac("sha256", banc.secrets.get(1) as string)
        .update(brut)
        .digest("hex");
      const livrer = () =>
        banc.app.inject({
          method: "POST",
          url: "/api/webhooks/routines/1",
          headers: { "x-gitea-signature": sig, "x-gitea-delivery": "d-x" },
          payload: brut,
        });
      expect([(await livrer()).statusCode, (await livrer()).statusCode]).toEqual([500, 500]);
      expect(await banc.t.base.valeurs("SELECT delivery_id FROM editor_webhook_deliveries")).toEqual([]);
    } finally {
      await banc.app.close();
      await banc.t.fermer();
    }
  });

  it("panne (500) d'une livraison par jeton de requête : journalisée sans la requête ni le secret", async () => {
    const banc = await monterBanc("sqlite");
    const lignes: string[] = [];
    installerCrochetJournal((_niveau, message) => void lignes.push(message));
    try {
      const secret = banc.secrets.get(1) as string;
      const r = await banc.app.inject({
        method: "POST",
        url: `/api/webhooks/routines/1?token=${secret}`,
        payload: "[".repeat(20_000),
      });
      expect([r.statusCode, r.body]).toEqual([500, "Internal Server Error"]);
      expect(lignes.some((l) => l.includes("500 sur POST /api/webhooks/routines/1\n"))).toBe(true);
      expect(lignes.some((l) => l.includes(secret))).toBe(false);
    } finally {
      installerCrochetJournal(null);
      await banc.app.close();
      await banc.t.fermer();
    }
  });

  it("débit par IP : 120 par fenêtre glissante de 60 s, IP indépendantes, IP inactives purgées", () => {
    const l = new LimiteurDebit();
    for (let k = 0; k < 120; k++) expect(l.limite("a", 1000)).toBe(false);
    expect([l.limite("a", 1000), l.limite("b", 1000), l.limite("a", 1060), l.limite("a", 1060.01)]).toEqual([
      true,
      false,
      true,
      false,
    ]);
    for (let k = 0; k < 1100; k++) l.limite(`ip-${k}`, 2000 + k * 0.01);
    expect(l.limite("a", 2100)).toBe(false);
  });
});
