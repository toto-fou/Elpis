// SPDX-License-Identifier: MIT
/** apps/core/test/executions/goldens-runs.test.ts — goldens `runs_execution_*` rejoués : table `runs` après chaque opération (portées imbriquées, mesures, issues, pertes, purge) sous horloge logique, SQLite et PostgreSQL. */
import "../moteur-environnement";

import { AsyncLocalStorage } from "node:async_hooks";
import { readdirSync, readFileSync } from "node:fs";

import { CancelledError } from "@elpis/commun";
import { initialiserBase } from "@elpis/db";
import type { Base } from "@elpis/db";
import { ouvrirBaseDeTest, PG_DE_TEST } from "@elpis/db/test";
import { afterEach, describe, expect, it } from "vitest";

import type { Execution } from "../../src/executions/registre";
import {
  installerBaseExecutions,
  markLostRuns,
  purgeRuns,
  reglerExecutionsPourTests,
  runScope,
} from "../../src/executions/registre";

type Dict = Record<string, unknown>;
const DOSSIER = new URL("../../../../tests/goldens/", import.meta.url);
const GOLDENS = readdirSync(DOSSIER)
  .filter((n) => n.startsWith("runs_execution_") && n.endsWith(".json"))
  .sort();
const MOTEURS = PG_DE_TEST ? (["sqlite", "postgres"] as const) : (["sqlite"] as const);
const T0 = 1_700_000_000;
const ERREURS: Readonly<Record<string, [() => Error, string]>> = {
  annulation: [() => new CancelledError(), "CancelledError"],
  delai: [() => Object.assign(new Error("délai"), { name: "TimeoutError" }), "TimeoutError"],
  erreur: [() => new Error("panne"), "RuntimeError"],
};

/** Instant relatif à T0 au millième, entier quand il l'est (même écriture que le harnais Python). */
function relatif(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  return Math.round((Number(v) - T0) * 1000) / 1000;
}

async function table(base: Base): Promise<Dict[]> {
  const lignes = await base.all("SELECT * FROM runs ORDER BY started_at, id");
  return lignes.map((r) => ({
    ...Object.fromEntries(Object.entries(r).map(([k, v]) => [k, typeof v === "bigint" ? Number(v) : v])),
    started_at: relatif(r["started_at"]),
    ended_at: relatif(r["ended_at"]),
    tool_families: JSON.parse(String(r["tool_families"] || "{}")) as unknown,
  }));
}

interface Ouverte {
  execution: Execution;
  fermer: (par: string) => void;
  fin: Promise<unknown>;
  dansContexte: <R>(fn: () => R) => R;
}

async function rejouer(base: Base, operations: Dict[]): Promise<Dict[]> {
  const horloge = { t: 0 };
  reglerExecutionsPourTests({ horloge: () => T0 + horloge.t });
  const ouvertes = new Map<string, Ouverte>();
  const toutes: Execution[] = [];
  const etapes: Dict[] = [];
  for (const op of operations) {
    horloge.t = Number(op["a"]);
    const [nom, c] = Object.entries(op).find(([k]) => k !== "a") as [string, Dict];
    let rendu: unknown = null;
    const e =
      typeof c === "object" && c !== null && typeof c["cle"] === "string"
        ? ouvertes.get(c["cle"])?.execution
        : undefined;
    if (nom === "ouvrir") {
      const ouvrir = async (): Promise<Ouverte> => {
        let fermer: (par: string) => void = () => undefined;
        const commande = new Promise<string>((ok) => (fermer = ok));
        let pret: (o: Omit<Ouverte, "fin">) => void = () => undefined;
        const prete = new Promise<Omit<Ouverte, "fin">>((ok) => (pret = ok));
        const fin = runScope(
          String(c["type"]),
          {
            runId: String(c["cle"]),
            userId: c["compte"],
            chatId: c["chat"] ?? "",
            routineId: (c["routine"] as number | undefined) ?? null,
            parentId: "dans" in c ? undefined : String(c["parent"] ?? ""),
            model: String(c["modele"] ?? ""),
            engine: String(c["moteur"] ?? ""),
            sampleSandbox: false,
          },
          async (ex) => {
            toutes.push(ex);
            pret({ execution: ex, fermer, dansContexte: AsyncLocalStorage.snapshot() });
            const par = await commande;
            const erreur = ERREURS[par];
            if (erreur) throw erreur[0]();
          },
        );
        fin.catch(() => undefined);
        return { ...(await prete), fin };
      };
      const dans = "dans" in c ? ouvertes.get(String(c["dans"])) : undefined;
      ouvertes.set(String(c["cle"]), await (dans ? dans.dansContexte(ouvrir) : ouvrir()));
    } else if (nom === "usage") {
      e!.addUsage({
        source: String(c["source"]),
        status: String(c["statut"]),
        input_tokens: c["entree"] ?? 0,
        output_tokens: c["sortie"] ?? 0,
        cache_read_tokens: c["cache_lu"] ?? 0,
        cache_creation_tokens: c["cache_cree"] ?? 0,
        thinking_tokens: c["reflexion"] ?? 0,
        tool_tokens: c["outils"] ?? 0,
        error_kind: String(c["type_erreur"] ?? ""),
      });
    } else if (nom === "appel_llm") {
      e!.addLlmCall(
        Object.fromEntries(["prompt_ms", "predicted_ms"].filter((k) => k in c).map((k) => [k, c[k]])),
      );
    } else if (nom === "attente") e!.addWait(c["ms"]);
    else if (nom === "outil") e!.addToolCall(String(c["categorie"]), String(c["statut"]));
    else if (nom === "fichiers") e!.addFiles(c["chemins"] as unknown[]);
    else if (nom === "issue") e!.finish(String(c["statut"]), String(c["type_erreur"] ?? ""));
    else if (nom === "fermer") {
      const o = ouvertes.get(String(c["cle"]))!;
      ouvertes.delete(String(c["cle"]));
      const par = String(c["par"]);
      o.fermer(par);
      try {
        await o.fin;
      } catch (err) {
        const attendu = ERREURS[par];
        expect(attendu && (err as Error).name === attendu[0]().name).toBe(true);
        rendu = attendu?.[1] ?? "?";
      }
    } else if (nom === "perdre") rendu = await markLostRuns(base, Number(c["age_max_s"]));
    else rendu = await purgeRuns(base, Number(c["jours"]));
    for (const x of toutes) await x.ecrituresTerminees();
    etapes.push({ a: op["a"], op: nom, rendu, table: await table(base) });
  }
  for (const o of ouvertes.values()) o.fermer("annulation");
  return etapes;
}

afterEach(() => {
  reglerExecutionsPourTests({ horloge: null });
  installerBaseExecutions(null);
});

describe.each(MOTEURS)("goldens runs_execution_* (%s)", (moteur) => {
  it.each(GOLDENS)("%s", async (nom) => {
    const g = JSON.parse(readFileSync(new URL(nom, DOSSIER), "utf-8")) as { entrees: Dict; etapes: Dict[] };
    const t = ouvrirBaseDeTest(moteur);
    try {
      await initialiserBase(t.base);
      await t.base.run(
        "INSERT INTO users(username, pass_salt, pass_hash, created_at, is_admin) VALUES('alice','s','h',0,0)",
      );
      await t.base.run(
        "INSERT INTO users(username, pass_salt, pass_hash, created_at, is_admin) VALUES('bob','s','h',0,0)",
      );
      installerBaseExecutions(t.base);
      const etapes = await rejouer(t.base, g.entrees["operations"] as Dict[]);
      expect(etapes).toEqual(g.etapes);
    } finally {
      await t.fermer();
    }
  });
});
