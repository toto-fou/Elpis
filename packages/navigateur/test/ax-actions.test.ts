// SPDX-License-Identifier: MIT
/** packages/navigateur/test/ax-actions.test.ts — mémoire AX écrite par les outils pw_* : scénarios du vrai Python (horloge fixée) rejoués sur SQLite et PostgreSQL, résultats et tables comparés. */
import { readFileSync } from "node:fs";

import type { Dict } from "@elpis/commun";
import { initialiserBase } from "@elpis/db";
import type { Base } from "@elpis/db";
import { ouvrirBaseDeTest, PG_DE_TEST } from "@elpis/db/test";
import type { BaseDeTest } from "@elpis/db/test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { findPath, recordAction, recordInspection, searchNodes } from "../src/ax-actions";
import { echapperDsl, parseTargetDsl } from "../src/client";

type Op = [string, ...unknown[]];
const V = JSON.parse(readFileSync(new URL("./vecteurs/navigateur_ax.json", import.meta.url), "utf-8")) as {
  scenarios: Op[][];
  sorties: { resultats: unknown[]; tables: Record<string, Dict[]> }[];
};
const MOTEURS = PG_DE_TEST ? (["sqlite", "postgres"] as const) : (["sqlite"] as const);
const TABLES: Record<string, string> = {
  ax_nodes:
    "id, site, path, parent_id, node_type, region_tag, role, name, node_key, verified_count, last_ok, stale, stale_at FROM ax_nodes ORDER BY id",
  ax_selectors:
    "node_id, strategy, value, success_count, failure_count, last_ok, last_fail FROM ax_selectors ORDER BY id",
  ax_transitions:
    "site, from_path, action_node_id, to_path, verified_count, last_ok FROM ax_transitions ORDER BY id",
  ax_credentials:
    "owner, site, username, password, last_ok, use_count FROM ax_credentials ORDER BY owner, site",
};

/** Tables relues comme le générateur : identifiants des nœuds renumérotés dans l'ordre d'insertion. */
async function tables(b: Base): Promise<Record<string, Dict[]>> {
  const out: Record<string, Dict[]> = {};
  for (const [t, requete] of Object.entries(TABLES)) out[t] = await b.all<Dict>(`SELECT ${requete}`);
  const rang = new Map((out["ax_nodes"] ?? []).map((n, i) => [n["id"], i + 1]));
  for (const [t, cle] of [
    ["ax_nodes", "id"],
    ["ax_nodes", "parent_id"],
    ["ax_selectors", "node_id"],
    ["ax_transitions", "action_node_id"],
  ] as const)
    for (const ligne of out[t] ?? []) ligne[cle] = rang.get(ligne[cle]) ?? ligne[cle];
  return out;
}

async function jouer(b: Base, op: Op): Promise<unknown> {
  const [genre, ...a] = op;
  if (genre === "action") {
    const x = a[0] as Dict;
    return recordAction(b, {
      url: x["url"] as string,
      role: x["role"] as string,
      name: x["name"] as string,
      result: x["result"],
      locatorKw: x["locator_kw"] as Dict | null,
      urlBefore: x["url_before"] as string | null,
      ancestors: x["ancestors"],
    });
  }
  if (genre === "inspection") return recordInspection(b, a[0] as string, a[1]);
  if (genre === "search") return searchNodes(b, a[0] as string, a[1] as string, a[2]);
  return findPath(b, a[0] as string, a[1] as string, a[2] as string | null, a[3] as number);
}

/** Écart voulu au Python (ecarts-python.md de la v0.1.2, outils web) : `find_path` donne la cible DSL de chaque étape et, sans départ, ne rend plus le trajet vide vers une page déjà source. */
function ecartChemin(op: Op, attendu: unknown): unknown {
  if (op[0] !== "path" || typeof attendu !== "object" || attendu === null) return attendu;
  const r = attendu as Dict;
  if (op[3] === null && r["found"] === true && r["depth"] === 0)
    return { found: false, site: r["site"], from_path: null, to_path: r["to_path"], depth: 0, steps: [] };
  const cible = (sel: Dict | null): string | null => {
    if (!sel) return null;
    const v = String(sel["value"]);
    if (sel["strategy"] !== "role_name") return `${String(sel["strategy"])}=${v}`;
    const [role, ...nom] = v.split("|");
    return nom.join("|") ? `role=${String(role)}|name=${echapperDsl(nom.join("|"))}` : `role=${String(role)}`;
  };
  const steps = (r["steps"] as Dict[]).map((e) => {
    const { verified_count: vc, ...debut } = e;
    return { ...debut, action_target: cible(e["action_selector"] as Dict | null), verified_count: vc };
  });
  return { ...r, steps };
}

/** Écart voulu au Python (coffre « Secrets ») : la mémoire AX n'enregistre ni ne relit plus d'identifiants de sites ; les opérations `save`/`get` des vecteurs ne sont plus jouées. */
const SANS_IDENTIFIANTS = new Set(["save", "get"]);

function ecartIdentifiants(
  attendues: Record<string, Dict[]> | undefined,
): Record<string, Dict[]> | undefined {
  return attendues === undefined ? attendues : { ...attendues, ax_credentials: [] };
}

describe.each(MOTEURS)("vecteurs Python de la mémoire AX écrite (%s)", (moteur) => {
  let t: BaseDeTest;
  beforeEach(async () => {
    t = ouvrirBaseDeTest(moteur);
    await initialiserBase(t.base);
    vi.useFakeTimers({ toFake: ["Date"] });
  });
  afterEach(async () => {
    vi.useRealTimers();
    await t.fermer();
  });

  it.each(V.scenarios.map((s, k) => [k, s] as const))("scénario %i", async (k, scenario) => {
    const resultats: unknown[] = [];
    for (const [i, op] of scenario.entries()) {
      if (SANS_IDENTIFIANTS.has(op[0] as string)) continue;
      vi.setSystemTime((1_800_000_000 + 1000 * k + 10 * i + 0.25) * 1000);
      resultats.push(await jouer(t.base, op));
    }
    const attendu = V.sorties[k];
    const resultatsAttendus = attendu?.resultats
      .map((r, i) => ecartChemin(scenario[i] as Op, r))
      .filter((_r, i) => !SANS_IDENTIFIANTS.has((scenario[i] as Op)[0] as string));
    expect(resultats).toEqual(resultatsAttendus);
    expect(JSON.stringify(resultats)).toBe(JSON.stringify(resultatsAttendus));
    expect(await tables(t.base)).toEqual(ecartIdentifiants(attendu?.tables));
  });
});

describe.each(MOTEURS)("find_path propre au TS (%s)", (moteur) => {
  let t: BaseDeTest;
  beforeEach(async () => {
    t = ouvrirBaseDeTest(moteur);
    await initialiserBase(t.base);
  });
  afterEach(async () => {
    await t.fermer();
  });

  /** Geste réussi de `avant` vers `apres` sur le site d'essai. */
  const geste = (avant: string, apres: string, role: string, name: string, kw: Dict = {}): Promise<unknown> =>
    recordAction(t.base, {
      url: `https://s.example${apres}`,
      role,
      name,
      result: { status: "success" },
      locatorKw: kw,
      urlBefore: `https://s.example${avant}`,
    });

  it("sans départ : une étape au moins, même quand la page visée a ses propres transitions ; cible DSL rendue", async () => {
    await geste("/login", "/secure", "button", "Login");
    await geste("/secure", "/login", "link", "Logout", { css: "a.logout" });
    const r = await findPath(t.base, "s.example", "/secure", null, 6);
    expect(r).toMatchObject({ found: true, from_path: "/login", depth: 1 });
    expect(r["steps"]).toEqual([
      expect.objectContaining({
        from: "/login",
        to: "/secure",
        action_name: "Login",
        action_target: "role=button|name=Login",
      }),
    ]);
    expect(await findPath(t.base, "s.example", "/secure", "/secure", 6)).toMatchObject({
      found: true,
      depth: 0,
    });
  });

  it("cible DSL d'une étape dont le nom porte « | » : relue telle quelle par pw_act", async () => {
    await geste("/", "/docs", "link", "Docs | Produit");
    await geste("/docs", "/tri", "button", "Trier | name=prix");
    const r = await findPath(t.base, "s.example", "/tri", "/", 6);
    const cibles = (r["steps"] as Dict[]).map((e) => parseTargetDsl(e["action_target"] as string));
    expect(cibles).toEqual([
      { role: "link", name: "Docs | Produit" },
      { role: "button", name: "Trier | name=prix" },
    ]);
  });

  it("navigations directes d'une base Python (goto, back) ignorées", async () => {
    await geste("/", "/secure", "navigation", "goto https://s.example/secure", {
      text: "https://s.example/secure",
    });
    await geste("/secure", "/", "navigation", "back");
    expect(await findPath(t.base, "s.example", "/secure", "/", 6)).toMatchObject({ found: false, steps: [] });
    await geste("/", "/secure", "link", "Espace");
    expect(await findPath(t.base, "s.example", "/secure", "/", 6)).toMatchObject({
      found: true,
      steps: [expect.objectContaining({ action_name: "Espace", action_target: "role=link|name=Espace" })],
    });
  });
});
