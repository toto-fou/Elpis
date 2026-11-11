// SPDX-License-Identifier: MIT
/** frontend/test/chat/goldens.test.ts — rejoue les goldens backend `flux_*`, `boucle_*` et `rattachement_*` : même séquence, même état de rendu. */
import { describe, expect, it } from "vitest";

import { decoderEvenement } from "../../src/features/chat/evenements";
import { etatInitial, peutRejouer, reduire } from "../../src/features/chat/etat-flux";
import type { EtatRendu } from "../../src/features/chat/etat-flux";
import { lireNdjson } from "../../src/platform/streams/ndjson";

type Ev = Record<string, unknown>;

const fichiers = import.meta.glob<Record<string, unknown>>(
  [
    "../../../tests/goldens/flux_*.json",
    "../../../tests/goldens/boucle_*.json",
    "../../../tests/goldens/rattachement_*.json",
  ],
  { eager: true, import: "default" },
);

function evenements(g: Record<string, unknown>): Ev[] {
  const brut = g["evenements"] ?? g["evenements_avant_depart"] ?? g["flux"];
  return Array.isArray(brut) ? (brut as Ev[]) : [];
}

/** Forme du fil : les goldens résument `final` (`cles`) et gardent les champs du moteur simulé (`id`, `ok`, `ahead`). */
function versFil(e: Ev): Ev {
  const { cles: _c, ahead: _a, ok: _o, id, mode: _m, ...reste } = e;
  const t = e["type"];
  const out: Ev = { ...reste };
  if ((t === "tool_call" || t === "tool_result") && out["call_id"] === undefined) out["call_id"] = id ?? "";
  if (t === "tool_result" && out["duration_ms"] === undefined) out["duration_ms"] = null;
  if (t === "final") {
    const n = out["run_ids"];
    if (typeof n === "number") out["run_ids"] = Array.from({ length: n }, (_v, i) => `run-${i + 1}`);
    const m = out["metrics"];
    if (Array.isArray(m)) out["metrics"] = Object.fromEntries(m.map((k) => [String(k), 0]));
  }
  if (t === "run_started")
    Object.assign(out, {
      engine_key: "",
      model: "",
      is_continue: false,
      base_count: 0,
      user_message: "",
      ...reste,
    });
  return out;
}

function rejouer(evs: readonly Ev[]): EtatRendu {
  return evs.reduce<EtatRendu>(
    (s, e) => reduire(s, { generation: 1, decode: decoderEvenement(e) }),
    etatInitial(1, null),
  );
}

const noms = Object.keys(fichiers).sort();

describe("goldens du flux rejoués par le reducer", () => {
  it("les trois familles sont présentes", () => {
    const n = (p: string) => noms.filter((f) => f.includes(`/${p}_`)).length;
    expect([n("flux"), n("boucle"), n("rattachement")]).toEqual([23, 22, 10]);
  });

  for (const f of noms) {
    const nom = f.replace(/^.*\//, "").replace(/\.json$/, "");
    const g = fichiers[f] ?? {};
    it(nom, async () => {
      const fil = evenements(g).map(versFil);
      for (const e of fil) expect(decoderEvenement(e).statut, JSON.stringify(e)).toBe("valide");
      const etat = rejouer(fil);
      expect(etat.horsContrat).toBe(0);
      expect(rejouer(fil)).toEqual(etat);
      const ndjson = new TextEncoder().encode(fil.map((e) => JSON.stringify(e)).join("\n"));
      const morceaux: Uint8Array[] = [];
      for (let i = 0; i < ndjson.length; i += 7) morceaux.push(ndjson.slice(i, i + 7));
      let i = 0;
      const flux = new ReadableStream<Uint8Array>({
        pull(c) {
          const m = morceaux[i++];
          if (m) c.enqueue(m);
          else c.close();
        },
      });
      let parFlux = etatInitial(1, null);
      for await (const v of lireNdjson(flux))
        parFlux = reduire(parFlux, { generation: 1, decode: decoderEvenement(v) });
      expect(parFlux).toEqual(etat);
      const final = g["final"];
      if (typeof final === "string" && etat.terminal === "final") expect(etat.contenu).toBe(final);
      expect(etat).toMatchSnapshot();
    });
  }

  it("runs détachés : sans conclusion (rattachement attendu), jamais renvoyés si un outil a pu agir", () => {
    const etat = (n: string) =>
      rejouer(evenements(fichiers[noms.find((f) => f.endsWith(`/${n}.json`)) ?? ""] ?? {}).map(versFil));
    const sansOutil = etat("flux_route_detache");
    const avecOutil = etat("flux_route_outils_detache_outil");
    expect([sansOutil.terminal, avecOutil.terminal]).toEqual([null, null]);
    expect([peutRejouer(sansOutil), peutRejouer(avecOutil)]).toEqual([true, false]);
    expect(etat("flux_route_conflit").terminal).toBe("final");
  });

  it("goldens bruts (forme résumée) : hors contrat signalé, fin du tour reconnue, contenu intact", () => {
    const g = fichiers[noms.find((f) => f.endsWith("flux_route_classique.json")) ?? ""] ?? {};
    const etat = rejouer(evenements(g));
    expect(etat.horsContrat).toBeGreaterThan(0);
    expect(etat.terminal).toBe("final");
    expect(etat.contenu).toBe("Bonjour.");
    expect(etat.final).toBeNull();
  });
});
