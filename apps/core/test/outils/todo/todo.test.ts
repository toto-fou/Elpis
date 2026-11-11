// SPDX-License-Identifier: MIT
/** apps/core/test/outils/todo/todo.test.ts — logique de `todowrite` rejouée sur les vecteurs Python (migration-kit/vecteurs/outils_todo.py) et sur les cas des tests pytest. */
import "../../moteur-environnement";

import { describe, expect, it } from "vitest";

import { ratio } from "@elpis/commun";

import {
  buildResult,
  coerce,
  normalize,
  normStatus,
  normText,
  signature,
  similar,
  strictItemSchema,
  todoItemDump,
  todowrite,
} from "../../../src/outils/todo";
import type { DependancesTodo } from "../../../src/outils/todo";
import { lireVecteurs } from "../../vecteurs-moteur";

type Cas = { items: unknown[] | null; prev: unknown[] | null };

const V = lireVecteurs<{
  normalisation: (Cas & { todos: unknown[]; notes: string[]; coerce: unknown[] })[];
  resultats: { cas: number; mode: "aucune" | "vrai" | "faux"; resultat: unknown; appels: unknown[] }[];
  similarites: {
    paires: { a: unknown; b: unknown; sim: boolean; sans_autojunk: boolean }[];
    textes: { texte: unknown; norme: string; statut: string | null; signature: [string, string][] }[];
  };
  schema: {
    brut: Record<string, unknown>;
    final: unknown;
    cas: { entree: Record<string, unknown>; sortie: unknown }[];
  };
  dumps: { entree: unknown; dump: unknown }[];
  flux: {
    comptes: Record<string, number>;
    listes: [number, string, unknown[]][];
    scenarios: {
      meta: { username?: string; chat_id?: string };
      todos: unknown[];
      ecriture: boolean | "erreur";
      lecture: "erreur" | null;
      compte: "erreur" | null;
      resultat: unknown;
      journal: unknown[][];
    }[];
  };
}>("outils-todo");

describe("normalisation de la liste de tâches", () => {
  it("normalize et coerce identiques au Python sur chaque cas", () => {
    expect(V.normalisation.length).toBeGreaterThan(250);
    V.normalisation.forEach((c, i) => {
      expect(normalize(c.items, c.prev), `cas ${i}`).toEqual([c.todos, c.notes]);
      expect(coerce(c.items), `cas ${i}`).toEqual(c.coerce);
    });
  });

  it("libellé, statut et signature identiques au Python", () => {
    for (const t of V.similarites.textes) {
      expect(normText(t.texte), JSON.stringify(t.texte)).toBe(t.norme);
      expect(normStatus(t.texte), JSON.stringify(t.texte)).toBe(t.statut);
      expect(signature([{ content: t.texte, status: t.texte }, "x", 5, { content: t.texte }])).toEqual(
        t.signature,
      );
    }
  });

  it("similarité identique au Python, autojunk des libellés de 200 caractères et plus compris", () => {
    expect(V.similarites.paires.some((p) => p.sim)).toBe(true);
    expect(V.similarites.paires.some((p) => !p.sim)).toBe(true);
    for (const p of V.similarites.paires) expect(similar(p.a, p.b), JSON.stringify([p.a, p.b])).toBe(p.sim);
  });

  it("l'autojunk de Python change le résultat sur des libellés de 200 caractères et plus, et ratio(…, false) donne l'autre", () => {
    const decisives = V.similarites.paires.filter((p) => p.sim !== p.sans_autojunk);
    expect(decisives.length).toBeGreaterThanOrEqual(3);
    for (const p of V.similarites.paires) {
      const [x, y] = [Array.from(normText(p.a)), Array.from(normText(p.b))];
      expect(x.length > 0 && y.length > 0 && ratio(x, y, false) >= 0.6, JSON.stringify([p.a, p.b])).toBe(
        p.sans_autojunk,
      );
    }
  });
});

describe("schéma de la tâche vu par le modèle", () => {
  it("strictItemSchema redonne le schéma final du Python depuis le schéma brut de pydantic", () => {
    const brut = structuredClone(V.schema.brut);
    strictItemSchema(brut);
    expect(brut).toEqual(V.schema.final);
    expect(Object.keys((brut["properties"] as Record<string, unknown>) ?? {})).toEqual(["content", "status"]);
  });

  it("cas limites : propriétés absentes, status remplacé, required et additionalProperties posés", () => {
    for (const c of V.schema.cas) {
      const x = structuredClone(c.entree);
      strictItemSchema(x);
      expect(x).toEqual(c.sortie);
      expect(Object.keys(x)).toEqual(Object.keys(c.sortie as Record<string, unknown>));
    }
  });

  it("todoItemDump garde content et status, comme TodoItem.model_dump()", () => {
    for (const d of V.dumps) expect(todoItemDump(d.entree)).toEqual(d.dump);
  });
});

describe("résultat de todowrite", () => {
  it("buildResult identique au Python (comptes, terminées maintenant, remarques, liste inchangée), persistance appelée avec la liste normalisée", async () => {
    expect(V.resultats.length).toBeGreaterThan(300);
    for (const r of V.resultats) {
      const c = V.normalisation[r.cas] as Cas;
      const appels: unknown[] = [];
      const persistance =
        r.mode === "aucune" ? null : (lst: unknown[]): boolean => (appels.push(lst), r.mode === "vrai");
      const res = await buildResult(c.items, c.prev as unknown[], persistance);
      expect(res, `cas ${r.cas} ${r.mode}`).toEqual(r.resultat);
      expect(Object.keys(res), `cas ${r.cas} : ordre des clés`).toEqual(Object.keys(r.resultat as object));
      expect(appels).toEqual(r.appels);
    }
  });

  it("une persistance asynchrone est attendue avant le résultat", async () => {
    const r = await buildResult([{ content: "a", status: "pending" }], [], async () => {
      await new Promise((ok) => setTimeout(ok, 5));
      return true;
    });
    expect(r.persisted).toBe(true);
  });

  it("une persistance qui lève propage l'erreur, comme en Python", async () => {
    await expect(
      buildResult([{ content: "a" }], [], () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
  });
});

function fausseDependance(f: Flux, sc: ScenarioFlux, journal: unknown[][]): DependancesTodo {
  const listes = new Map(f.listes.map(([u, c, l]) => [`${u}/${c}`, l]));
  return {
    idUtilisateur: (nom) => {
      journal.push(["compte", nom]);
      if (sc.compte === "erreur") return Promise.reject(new Error("base indisponible"));
      return Promise.resolve(f.comptes[nom] ?? null);
    },
    lireTodos: (uid, chat) => {
      journal.push(["lire", uid, chat]);
      if (sc.lecture === "erreur") return Promise.reject(new Error("lecture impossible"));
      return Promise.resolve(listes.get(`${uid}/${chat}`) ?? []);
    },
    ecrireTodos: (uid, chat, lst) => {
      journal.push(["ecrire", uid, chat, lst]);
      if (sc.ecriture === "erreur") return Promise.reject(new Error("écriture impossible"));
      return Promise.resolve(sc.ecriture === true && listes.has(`${uid}/${chat}`));
    },
  };
}
type Flux = (typeof V)["flux"];
type ScenarioFlux = Flux["scenarios"][number];

describe("corps de todowrite", () => {
  it("compte, liste précédente et enregistrement identiques au Python (appels et résultat), erreurs de port avalées", async () => {
    expect(V.flux.scenarios.length).toBeGreaterThan(10);
    for (const sc of V.flux.scenarios) {
      const journal: unknown[][] = [];
      const dep = fausseDependance(V.flux, sc, journal);
      const res = await todowrite(
        dep,
        { username: sc.meta.username ?? "", chatId: sc.meta.chat_id ?? "" },
        sc.todos,
      );
      expect(res, JSON.stringify(sc.meta)).toEqual(sc.resultat);
      expect(journal, JSON.stringify(sc.meta)).toEqual(sc.journal);
    }
  });
});

const PREV = [
  { content: "Créer l'arborescence", status: "completed", priority: "medium" },
  { content: "Écrire le serveur", status: "in_progress", priority: "high" },
  { content: "Lancer les tests", status: "pending", priority: "medium" },
];

describe("cas des tests pytest de todowrite", () => {
  it("coerce normalise et tolère : statut synonyme, chaîne simple, contenu rogné à 300, types étrangers ignorés", () => {
    const out = coerce([
      { content: "step 1", status: "IN-PROGRESS", priority: "HIGH" },
      { content: "", status: "pending" },
      "plain string",
      { content: "step 2", status: "weird", priority: "urgent" },
      { content: "x".repeat(500) },
      42,
    ]);
    expect(out[0]).toEqual({ content: "step 1", status: "in_progress", priority: "high" });
    expect(out[1]).toEqual({ content: "plain string", status: "pending", priority: "medium" });
    expect(out[2]).toMatchObject({ status: "pending", priority: "medium" });
    expect(out[3]?.content).toHaveLength(300);
    expect(out).toHaveLength(4);
    expect(coerce(Array.from({ length: 80 }, (_v, i) => ({ content: `t${i}` })))).toHaveLength(50);
  });

  it("un statut absent est hérité de la liste précédente, jamais régressé", () => {
    const [todos, notes] = normalize(
      PREV.map((t) => ({ content: t.content })),
      PREV,
    );
    expect(todos.map((t) => t.status)).toEqual(["completed", "in_progress", "pending"]);
    expect(notes).toHaveLength(3);
    expect(notes.every((n) => n.includes("kept"))).toBe(true);
  });

  it("un statut glissé dans priority est ignoré et le statut manquant hérité", () => {
    const [todos, notes] = normalize(
      [{ content: "Créer l'arborescence", priority: 'high", "status": "completed' }],
      PREV,
    );
    expect(todos[0]?.status).toBe("completed");
    expect(notes).toHaveLength(1);
  });

  it("statut inconnu signalé avec son repr, synonymes acceptés", () => {
    const [todos, notes] = normalize(
      [
        { content: "x", status: "done" },
        { content: "y", status: "IN-PROGRESS" },
        { content: "z", status: "bizarre" },
      ],
      [],
    );
    expect(todos.map((t) => t.status)).toEqual(["completed", "in_progress", "pending"]);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain("unknown status 'bizarre'");
  });

  it("héritage par position si les libellés se ressemblent, priorité reprise de la liste précédente", () => {
    const [todos] = normalize(
      [
        { content: "Créer l'arborescence du projet" },
        { content: "Écrire le serveur", status: "completed" },
        { content: "Lancer les tests" },
      ],
      PREV,
    );
    expect(todos.map((t) => t.status)).toEqual(["completed", "completed", "pending"]);
    expect(todos[1]?.priority).toBe("high");
  });

  it("un nouveau plan de même longueur n'hérite de rien", async () => {
    const prev = [
      { content: "A terminé", status: "completed" },
      { content: "B terminé", status: "completed" },
    ];
    const [todos] = normalize(["Déployer sur la VM", "Écrire la doc"], prev);
    expect(todos.map((t) => t.status)).toEqual(["pending", "pending"]);
    const r = await buildResult(["Déployer sur la VM", "Écrire la doc"], prev);
    expect(r.remaining).toBe(2);
    expect(r.notes).not.toContain("All tasks are closed.");
  });

  it("résultat : checklist, compteurs, terminée maintenant, liste inchangée, plusieurs en cours, tout clos", async () => {
    const r = await buildResult(
      [
        { content: "Créer l'arborescence", status: "completed" },
        { content: "Écrire le serveur", status: "completed" },
        { content: "Lancer les tests", status: "in_progress" },
      ],
      PREV,
    );
    expect([r.done, r.total, r.remaining]).toEqual([2, 3, 1]);
    expect(r.in_progress).toBe("Lancer les tests");
    expect(r.completed_now).toEqual(["Écrire le serveur"]);
    expect(r.notes).toEqual([]);
    const inchangee = await buildResult(
      PREV.map((t) => ({ content: t.content, status: t.status })),
      PREV,
    );
    expect(inchangee.notes.some((n) => n.includes("List unchanged") && n.includes("Écrire le serveur"))).toBe(
      true,
    );
    const deux = await buildResult(
      [
        { content: "a", status: "in_progress" },
        { content: "b", status: "in_progress" },
      ],
      [],
    );
    expect(deux.notes.some((n) => n.includes("exactly ONE"))).toBe(true);
    expect((await buildResult([{ content: "a", status: "completed" }], [])).notes).toContain(
      "All tasks are closed.",
    );
  });
});
