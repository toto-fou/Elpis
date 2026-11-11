// SPDX-License-Identifier: MIT
/** apps/core/test/evenements/vecteurs.test.ts — cron, journal staff, trames SSE, diffusion, pipeline et redémarrage rejouent le Python. */
import { readFileSync } from "node:fs";

import { comparePointsDeCode, pyJsonDumps } from "@elpis/commun";
import { describe, expect, it } from "vitest";

import { cronMatches } from "../../src/evenements/cron";
import { FileAttente } from "../../src/evenements/file";
import { logRecordToEvent } from "../../src/evenements/journal-staff";
import { PipelineEvents } from "../../src/evenements/pipeline";
import type { ElementPipeline } from "../../src/evenements/pipeline";
import {
  digest,
  digests,
  EXTRA_BOOT_PATHS,
  getChemin,
  MISSING,
  pending,
  restartPaths,
} from "../../src/evenements/redemarrage";
import { encoderDonneeSse, tramePing } from "../../src/evenements/sse";
import { CLIENT_CLOSED, SystemEvents } from "../../src/evenements/systeme";
import type { ElementSysteme, Message } from "../../src/evenements/systeme";

type Dict = Record<string, unknown>;

const V = JSON.parse(readFileSync(new URL("../vecteurs/evenements.json", import.meta.url), "utf-8")) as {
  cron: { expr: string; date: [number, number, number, number, number]; attendu: boolean }[];
  redemarrage: {
    missing: string;
    extra_boot_paths: string[];
    prefixes_chauds: string[];
    chemins_chauds: string[];
    digest: { valeur: unknown; attendu: string }[];
    get: { cfg: Dict; chemin: string; attendu: unknown }[];
    restart_paths: { lectures: string[]; attendu: string[] }[];
    pending: {
      nom: string;
      boot: Dict;
      empreinte: Record<string, string> | null;
      courant: Dict;
      chemins: string[];
      attendu: string[];
    }[];
  };
  journal: { rec: Message; attendu: Message | null }[];
  sse: { donnees: { donnees: string; trames: string[] }[]; pings: { ms: number; trame: string }[] };
  diffusion: {
    nom: string;
    abonnes: [boolean, number | null, number][];
    messages: Message[];
    files: { inscrit: boolean; elements: string[] }[];
  }[];
  pipeline: {
    nom: string;
    abonnes: [number, number][];
    operations: (
      ["distribuer", number, Message] | ["deconnecter", number, Message | null] | ["tout", Message | null]
    )[];
    inscriptions: boolean[];
    retours: (number | null)[];
    files: string[][];
    stats: Dict;
  }[];
};

function rendu(element: ElementSysteme | ElementPipeline): string {
  if (element === CLIENT_CLOSED) return "<FERME>";
  return typeof element === "string" ? element : pyJsonDumps(element);
}

describe("_cron_matches", () => {
  it(`${V.cron.length} cas (expressions × dates locales)`, () => {
    const ecarts = V.cron.filter(({ expr, date: [a, mo, j, h, mi], attendu }) => {
      return cronMatches(expr, new Date(a, mo - 1, j, h, mi)) !== attendu;
    });
    expect(ecarts).toEqual([]);
  });
});

describe("restart_pending", () => {
  const R = V.redemarrage;

  it("constantes", () => {
    expect(MISSING).toBe(R.missing);
    expect([...EXTRA_BOOT_PATHS].sort(comparePointsDeCode)).toEqual(R.extra_boot_paths);
  });

  it("_digest et _get", () => {
    for (const { valeur, attendu } of R.digest) expect(digest(valeur), pyJsonDumps(valeur)).toBe(attendu);
    for (const { cfg, chemin, attendu } of R.get) expect(getChemin(cfg, chemin), chemin).toEqual(attendu);
  });

  it("restart_paths (lectures réelles et synthétiques)", () => {
    for (const { lectures, attendu } of R.restart_paths) {
      expect(restartPaths(lectures, R.prefixes_chauds, R.chemins_chauds)).toEqual(attendu);
    }
  });

  it("pending, avec ou sans empreinte", () => {
    for (const c of R.pending) {
      const reference = c.empreinte ?? digests(c.boot, c.chemins);
      expect(pending(c.courant, c.chemins, reference), c.nom).toEqual(c.attendu);
    }
  });
});

describe("_log_record_to_event", () => {
  it("lignes du journal JSONL", () => {
    for (const { rec, attendu } of V.journal) {
      const ev = logRecordToEvent(rec);
      expect(ev, JSON.stringify(rec)).toEqual(attendu);
      if (ev !== null && attendu !== null) expect(Object.keys(ev)).toEqual(Object.keys(attendu));
    }
  });
});

describe("trames de sse-starlette", () => {
  it("data après l'adaptateur de routes_events.py", () => {
    for (const { donnees, trames } of V.sse.donnees)
      expect(encoderDonneeSse(donnees), donnees).toBe(trames.join(""));
  });

  it("ping horodaté (str(datetime) en UTC)", () => {
    for (const { ms, trame } of V.sse.pings) expect(tramePing(new Date(ms)), String(ms)).toBe(trame);
  });
});

describe("SystemEvents._fanout", () => {
  for (const scenario of V.diffusion) {
    it(scenario.nom, () => {
      const bus = new SystemEvents({ peutVoirModeles: (uid) => uid !== 2 });
      const files = scenario.abonnes.map(([staff, uid, taille]) => {
        const file = new FileAttente<ElementSysteme>(taille);
        // Le Python relayait le journal à tout staff : ici, chaque staff du vecteur est abonné au journal.
        bus.clients.set(file, { staff, uid, journal: staff });
        return file;
      });
      for (const m of scenario.messages) bus.fanout(m);
      const obtenu = files.map((f) => ({ inscrit: bus.clients.has(f), elements: f.contenu().map(rendu) }));
      expect(obtenu).toEqual(scenario.files);
    });
  }
});

describe("PipelineEvents : inscription, distribution, déconnexion", () => {
  for (const scenario of V.pipeline) {
    it(scenario.nom, () => {
      const bus = new PipelineEvents();
      const inscriptions: boolean[] = [];
      const files = scenario.abonnes.map(([uid, taille]) => {
        const file = new FileAttente<ElementPipeline>(taille);
        inscriptions.push(bus.register(uid, file));
        return file;
      });
      const retours = scenario.operations.map((op) => {
        if (op[0] === "distribuer") {
          bus.distributeLocal(op[1], op[2]);
          return null;
        }
        if (op[0] === "deconnecter") return bus.disconnectUser(op[1], op[2] ?? undefined);
        return bus.disconnectAll(op[1] ?? undefined);
      });
      const stats = bus.stats();
      expect(inscriptions).toEqual(scenario.inscriptions);
      expect(retours).toEqual(scenario.retours);
      expect(files.map((f) => f.contenu().map(rendu))).toEqual(scenario.files);
      expect({
        users_connected: stats.users_connected,
        total_clients: stats.total_clients,
        events_dropped: stats.events_dropped,
        errors: stats.errors,
      }).toEqual(scenario.stats);
    });
  }
});
