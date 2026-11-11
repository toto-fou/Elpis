// SPDX-License-Identifier: MIT
/** apps/core/test/memoire/magasin.test.ts — mémoire : verrous du magasin, écritures atomiques, portées, fournisseur figé, gestionnaire, migration et journal (port de tests/memory). */
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as dormir } from "node:timers/promises";
import { afterAll, afterEach, describe, expect, it } from "vitest";

import { ErreurPython, strPy } from "@elpis/commun";
import { surchargerConfig } from "@elpis/config";
import { VerrouFichier } from "@elpis/verrous";

import {
  buildDefaultManager,
  computeEntryId,
  installerComptesMemoire,
  installerIndexSessions,
  LEGACY_MEMORY_SUBDIR,
  MarkdownMemoryProvider,
  MarkdownStore,
  MEMORY_SUBDIR,
  MemoryManager,
  MemoryProvider,
  memoryJournal,
  migrateLegacyMemory,
  safeUsername,
  scopeHash,
  storeFor,
  StoreBusyError,
  storeTransaction,
} from "../../src/memoire";
import type { MessageIndexe } from "../../src/memoire";

const dossiers: string[] = [];

async function tmp(): Promise<string> {
  const d = await mkdtemp(path.join(os.tmpdir(), "elpis-memoire-"));
  dossiers.push(d);
  return d;
}

afterAll(async () => {
  await Promise.all(dossiers.map((d) => rm(d, { recursive: true, force: true })));
});

const existe = (p: string): Promise<boolean> =>
  stat(p).then(
    () => true,
    () => false,
  );

describe("magasin : verrous bornés", () => {
  it("un verrou tenu par un autre détenteur lève StoreBusyError, puis l'écriture repasse", async () => {
    const s = new MarkdownStore(path.join(await tmp(), "MEMORY.md"), 200, {
      label: "MEMORY.md",
      lockTimeoutS: 0.3,
    });
    expect((await s.add("fact")).ok).toBe(true);
    const verrou = `${s.path}.lock`;
    expect(await existe(verrou)).toBe(false);
    const autre = new VerrouFichier(verrou);
    await autre.acquerir();
    try {
      await expect(s.add("autre fait")).rejects.toThrow(
        new StoreBusyError("lock MEMORY.md.lock not acquired after 0.3s"),
      );
    } finally {
      await autre.rendre();
    }
    expect((await s.add("autre fait")).ok).toBe(true);
  });

  it("le verrou d'un processus disparu est repris", async () => {
    const s = new MarkdownStore(path.join(await tmp(), "MEMORY.md"), 200, {
      label: "MEMORY.md",
      lockTimeoutS: 0.3,
    });
    const verrou = `${s.path}.lock`;
    await writeFile(
      verrou,
      JSON.stringify({ v: 1, pid: 2 ** 22 + 7, hote: os.hostname(), debut: 0, proc: "appmcp" }) + "\n",
    );
    expect((await s.add("fact")).ok).toBe(true);
    expect(await existe(verrou)).toBe(false);
  });

  it("le verrou du processus est borné lui aussi (message de Python)", async () => {
    const chemin = path.join(await tmp(), "MEMORY.md");
    const long = storeTransaction(chemin, 5, () => dormir(400));
    await expect(storeTransaction(chemin, 0.2, async () => undefined)).rejects.toThrow(
      new StoreBusyError("internal lock of MEMORY.md not acquired after 0.2s"),
    );
    await long;
  });

  it("des ajouts concurrents ne perdent aucune entrée", async () => {
    const s = new MarkdownStore(path.join(await tmp(), "MEMORY.md"), 100_000);
    const r = await Promise.all(Array.from({ length: 25 }, (_v, i) => s.add(`fait ${i}`)));
    expect(r.every((x) => x.ok)).toBe(true);
    expect((await s.entries()).toSorted()).toEqual(
      Array.from({ length: 25 }, (_v, i) => `fait ${i}`).toSorted(),
    );
  });

  it("écrit par un temporaire 0600 remplacé, sans résidu", async () => {
    const d = await tmp();
    const s = new MarkdownStore(path.join(d, "sous", "MEMORY.md"), 1000);
    await s.add("un");
    await s.replace("un", "deux");
    expect((await stat(s.path)).mode & 0o777).toBe(0o600);
    expect(await readdir(path.join(d, "sous"))).toEqual(["MEMORY.md"]);
    expect(await readFile(s.path, "utf8")).toBe("deux");
  });

  it("usagePct est un flottant de Python", async () => {
    const d = await tmp();
    await new MarkdownStore(path.join(d, "MEMORY.md"), 10).add("12345");
    const pct = await new MarkdownStore(path.join(d, "MEMORY.md"), 10).usagePct();
    expect(strPy(pct)).toBe("50.0");
    expect(strPy((await new MarkdownStore(path.join(d, "MEMORY.md"), 0).add("x")).usage_pct)).toBe("0.0");
  });

  it("l'id rendu préfixe la première ligne de l'entrée seulement", async () => {
    const d = await tmp();
    await new MarkdownStore(path.join(d, "MEMORY.md"), 200).add("ligne un\nligne deux");
    const bloc = await new MarkdownStore(path.join(d, "MEMORY.md"), 200).renderBlock();
    const id = computeEntryId("ligne un\nligne deux");
    expect(bloc).toContain(`[${id}] ligne un\nligne deux`);
    expect(bloc).not.toContain(`[${id}] ligne deux`);
  });
});

describe("portées", () => {
  it("racine pour le chat, scopes/<hash> pour l'agentique, USER.md commun", async () => {
    const d = await tmp();
    expect(storeFor("memory", "alice", "user", d).path).toBe(
      path.join(d, "alice", MEMORY_SUBDIR, "MEMORY.md"),
    );
    expect(storeFor("memory", "alice", "", d).path).toBe(path.join(d, "alice", MEMORY_SUBDIR, "MEMORY.md"));
    expect(storeFor("memory", "bob", "pipeline:42:node:7", d).path).toBe(
      path.join(d, "bob", MEMORY_SUBDIR, "scopes", scopeHash("pipeline:42:node:7"), "MEMORY.md"),
    );
    expect(storeFor("user", "carol", "team:5", d).path).toBe(storeFor("user", "carol", "user", d).path);
    expect(safeUsername("../../etc")).toBe("etc");
    expect(safeUsername(null)).toBe("guest");
  });

  it("limites et libellés par genre", async () => {
    const d = await tmp();
    const m = storeFor("memory", "eve", "user", d, { memoryLimit: 2200, userLimit: 1375 });
    const u = storeFor("user", "eve", "user", d, { memoryLimit: 2200, userLimit: 1375 });
    expect([m.charLimit, m.label, u.charLimit, u.label]).toEqual([2200, "MEMORY.md", 1375, "USER.md"]);
  });
});

describe("fournisseur intégré", () => {
  it("fige le bloc à initialize ; une nouvelle session voit la mise à jour", async () => {
    const d = await tmp();
    const f = new MarkdownMemoryProvider("frank", "user", d, { memoryLimit: 2200, userLimit: 1375 });
    await storeFor("memory", "frank", "user", d).add("initial fact");
    await f.initialize("sess1");
    const instantane = await f.systemPromptBlock();
    expect(instantane).toContain("initial fact");
    expect(instantane.startsWith("# Memory (snapshot)\n\n")).toBe(true);
    await storeFor("memory", "frank", "user", d).add("added mid-session");
    expect(await f.systemPromptBlock()).toBe(instantane);
    await f.initialize("sess2");
    expect(await f.systemPromptBlock()).toContain("added mid-session");
  });

  it("USER.md avant MEMORY.md ; rien si les deux sont vides", async () => {
    const d = await tmp();
    const f = new MarkdownMemoryProvider("gus", "user", d, { memoryLimit: 100, userLimit: 100 });
    expect(await f.systemPromptBlock()).toBe("");
    await storeFor("memory", "gus", "user", d).add("note");
    await storeFor("user", "gus", "user", d).add("profil");
    const bloc = await f.systemPromptBlock();
    expect(bloc.indexOf("## USER.md")).toBeLessThan(bloc.indexOf("## MEMORY.md"));
    expect(bloc).toContain("chars · 6.0%)\n");
  });
});

class Externe extends MemoryProvider {
  readonly name: string;
  bloc = "";
  echec = false;
  disponible = true;
  readonly appels: string[] = [];

  constructor(name: string) {
    super();
    this.name = name;
  }

  override get isExternal(): boolean {
    return true;
  }

  override async isAvailable(): Promise<boolean> {
    return this.disponible;
  }

  override async initialize(sessionId: string): Promise<void> {
    this.appels.push(`initialize:${sessionId}`);
    if (this.echec) throw new Error("panne");
  }

  override async systemPromptBlock(): Promise<string> {
    if (this.echec) throw new Error("panne");
    return this.bloc;
  }

  override async syncTurn(u: string, a: string, sessionId = ""): Promise<void> {
    this.appels.push(`sync:${u}|${a}|${sessionId}`);
    if (this.echec) throw new Error("panne");
  }

  override async onMemoryWrite(action: string, target: string, content: string): Promise<void> {
    this.appels.push(`write:${action}|${target}|${content}`);
    if (this.echec) throw new Error("panne");
  }
}

describe("gestionnaire", () => {
  afterEach(() => {
    installerComptesMemoire(null);
    installerIndexSessions(null);
  });

  it("un seul fournisseur externe", () => {
    const g = new MemoryManager("alice").register(new Externe("a"));
    let levee: unknown = null;
    try {
      g.register(new Externe("b"));
    } catch (e) {
      levee = e;
    }
    expect(levee).toBeInstanceOf(ErreurPython);
    expect((levee as ErreurPython).type).toBe("ValueError");
    expect((levee as Error).message).toBe("Only one external memory provider is allowed at a time");
    expect(g.providers.map((p) => p.name)).toEqual(["a"]);
  });

  it("agrège les blocs non vides et survit aux fournisseurs en panne", async () => {
    const d = await tmp();
    await storeFor("memory", "hal", "user", d).add("note");
    const ext = new Externe("ext");
    ext.bloc = "  bloc externe \n";
    const g = buildDefaultManager("hal", "user", { sandboxDir: d }).register(ext);
    await g.initialize("s1");
    expect(ext.appels).toEqual(["initialize:s1"]);
    const bloc = await g.systemPromptBlock();
    expect(bloc.endsWith("\n\nbloc externe")).toBe(true);
    expect(bloc.startsWith("# Memory (snapshot)\n\n## MEMORY.md  (4/2200 chars · 0.2%)")).toBe(true);
    ext.echec = true;
    await g.initialize("s2");
    expect(await g.systemPromptBlock()).toBe(bloc.slice(0, -"\n\nbloc externe".length));
    await g.syncTurn("q", "r");
    await g.onMemoryWrite("add", "memory", "x");
    expect(ext.appels.slice(-2)).toEqual(["sync:q|r|s2", "write:add|memory|x"]);
  });

  it("un fournisseur indisponible n'est pas initialisé", async () => {
    const ext = new Externe("ext");
    ext.disponible = false;
    await new MemoryManager("ivy").register(ext).initialize("s");
    expect(ext.appels).toEqual([]);
  });

  it("indexe les deux messages du tour (portée chat = ''), id du compte résolu une fois", async () => {
    const indexes: MessageIndexe[] = [];
    let resolutions = 0;
    installerComptesMemoire({
      idUtilisateur: async (u) => {
        resolutions++;
        return u === "jo" ? 7 : null;
      },
    });
    installerIndexSessions({
      indexerMessage: async (m) => {
        indexes.push(m);
      },
    });
    const g = new MemoryManager("jo", { sessionId: "c1" });
    await g.syncTurn("  question  ", "réponse");
    await g.syncTurn("", "   ");
    expect(resolutions).toBe(1);
    expect(indexes.map(({ ts: _ts, ...m }) => m)).toEqual([
      { user_id: 7, app: "chat", session_id: "c1", scope_key: "", role: "user", content: "question" },
      { user_id: 7, app: "chat", session_id: "c1", scope_key: "", role: "assistant", content: "réponse" },
    ]);
    const a = new MemoryManager("jo", { scopeKey: "pipeline:1", app: "agentic" });
    await a.syncTurn("x", "");
    expect(indexes.at(-1)).toMatchObject({ app: "agentic", scope_key: "pipeline:1", session_id: "" });
    await new MemoryManager("inconnu").syncTurn("x", "y");
    expect(indexes).toHaveLength(3);
  });

  it("sans comptes ni index installés, le tour passe quand même", async () => {
    const ext = new Externe("ext");
    const g = new MemoryManager("kim").register(ext);
    await g.syncTurn("a", "b");
    expect(ext.appels).toEqual(["sync:a|b|"]);
  });

  it("la fabrique lit MEMORY_DIR et les limites de la config, sauf dossier fourni", async () => {
    const d = await tmp();
    const remettre = surchargerConfig({ MEMORY_DIR: d, MEMORY_MD_CHAR_LIMIT: 300, USER_MD_CHAR_LIMIT: 250 });
    try {
      await storeFor("memory", "lea", "user", d).add("note");
      expect(await buildDefaultManager("lea").systemPromptBlock()).toContain(
        "## MEMORY.md  (4/300 chars · 1.3%)",
      );
      expect(await buildDefaultManager("lea", "user", { sandboxDir: d }).systemPromptBlock()).toContain(
        "(4/2200 chars",
      );
    } finally {
      remettre();
    }
  });
});

describe("migration de l'ancien .memory", () => {
  it("crée memory quand il n'y a rien à migrer", async () => {
    const d = await tmp();
    const neuf = await migrateLegacyMemory(d, "alice");
    expect(neuf).toBe(path.join(d, "alice", MEMORY_SUBDIR));
    expect((await stat(neuf)).isDirectory()).toBe(true);
    expect(await existe(path.join(d, "alice", LEGACY_MEMORY_SUBDIR))).toBe(false);
  });

  it("copie l'ancien contenu une fois, sous-dossiers compris", async () => {
    const d = await tmp();
    const ancien = path.join(d, "bob", LEGACY_MEMORY_SUBDIR);
    await mkdir(path.join(ancien, "scopes", "deadbeef0000"), { recursive: true });
    await writeFile(path.join(ancien, "USER.md"), "profil bob");
    await writeFile(path.join(ancien, "MEMORY.md"), "note bob");
    await writeFile(path.join(ancien, "scopes", "deadbeef0000", "MEMORY.md"), "scoped");
    const neuf = await migrateLegacyMemory(d, "bob");
    expect(await readFile(path.join(neuf, "USER.md"), "utf8")).toBe("profil bob");
    expect(await readFile(path.join(neuf, "MEMORY.md"), "utf8")).toBe("note bob");
    expect(await readFile(path.join(neuf, "scopes", "deadbeef0000", "MEMORY.md"), "utf8")).toBe("scoped");
  });

  it("n'écrase jamais un memory existant", async () => {
    const d = await tmp();
    const neuf = path.join(d, "carol", MEMORY_SUBDIR);
    await mkdir(neuf, { recursive: true });
    await writeFile(path.join(neuf, "USER.md"), "courant");
    await mkdir(path.join(d, "carol", LEGACY_MEMORY_SUBDIR));
    await writeFile(path.join(d, "carol", LEGACY_MEMORY_SUBDIR, "USER.md"), "ancien");
    expect(await migrateLegacyMemory(d, "carol")).toBe(neuf);
    expect(await readFile(path.join(neuf, "USER.md"), "utf8")).toBe("courant");
  });

  it("nom de compte assaini ; une copie en échec crée quand même le dossier, sans lever", async () => {
    const d = await tmp();
    expect(await migrateLegacyMemory(d, "Jean.Dupont")).toBe(path.join(d, "JeanDupont", MEMORY_SUBDIR));
    const ancien = path.join(d, "dan", LEGACY_MEMORY_SUBDIR);
    await mkdir(ancien, { recursive: true });
    await writeFile(path.join(ancien, "USER.md"), "secret");
    await chmod(path.join(ancien, "USER.md"), 0o000);
    try {
      const neuf = await migrateLegacyMemory(d, "dan");
      expect((await stat(neuf)).isDirectory()).toBe(true);
    } finally {
      await chmod(path.join(ancien, "USER.md"), 0o600);
    }
  });
});

describe("journal", () => {
  it("borné : au-delà de 250 lignes, les 200 dernières sont gardées", async () => {
    const d = await tmp();
    for (let i = 0; i < 255; i++)
      await memoryJournal.append(d, { action: "add", store: "memory", before: [], after: [`n${i}`] });
    const recs = await memoryJournal.records(d);
    expect(recs.length).toBeLessThanOrEqual(250);
    expect(recs.at(-1)?.["after"]).toEqual(["n254"]);
  });

  it("une écriture sans effet n'est pas journalisée (ni fichier ni dossier)", async () => {
    const d = path.join(await tmp(), "absent");
    expect(
      await memoryJournal.append(d, { action: "add", store: "memory", before: ["a"], after: ["a"] }),
    ).toBeNull();
    expect(await memoryJournal.records(d)).toEqual([]);
    expect(await existe(d)).toBe(false);
  });

  it("des écritures concurrentes donnent chacune une ligne entière", async () => {
    const d = await tmp();
    const ops = await Promise.all(
      Array.from({ length: 30 }, (_v, i) =>
        memoryJournal.append(d, {
          action: "add",
          store: "user",
          before: [],
          after: [`é ${i}`],
          chat_id: `c${i}`,
        }),
      ),
    );
    const recs = await memoryJournal.records(d);
    expect(recs.map((r) => r["op"]).toSorted()).toEqual(ops.toSorted());
    expect(await existe(`${memoryJournal.journalPath(d)}.lock`)).toBe(false);
    const r = await memoryJournal.get(d, ` ${String(ops[3]).toUpperCase()} `);
    expect(r?.["chat_id"]).toBe("c3");
  });
});
