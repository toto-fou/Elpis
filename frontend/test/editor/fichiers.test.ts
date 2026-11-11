// SPDX-License-Identifier: MIT
/** frontend/test/editor/fichiers.test.ts — fichiers du bac : renommage et déplacement (quatre états migrés, préfixe strict), refus serveur, flux de progression des instantanés. */
import { describe, expect, it } from "vitest";
import { ref } from "vue";

import { setupEditorSandboxFs } from "../../src/features/editor/fichiers";
import type { Onglet, RappelsFichiers, ResultatRecherche } from "../../src/features/editor/fichiers";
import type { NoeudArbre } from "../../src/features/editor/schemas-bac";

interface Options {
  onglets?: string[];
  actif?: string | null;
  nouveauNom?: string | null;
  echecRename?: boolean;
  morceaux?: Array<string | Uint8Array>;
  reponse?: () => Response;
  rappels?: RappelsFichiers;
}

function json(corps: unknown, status = 200): Response {
  return new Response(JSON.stringify(corps), { status, headers: { "Content-Type": "application/json" } });
}

function ndjson(morceaux: Array<string | Uint8Array>): Response {
  const enc = new TextEncoder();
  const flux = new ReadableStream<Uint8Array>({
    start(c) {
      for (const m of morceaux) c.enqueue(typeof m === "string" ? enc.encode(m) : m);
      c.close();
    },
  });
  return new Response(flux, { status: 200 });
}

function monter(o: Options = {}) {
  const chemins = o.onglets ?? [];
  const models: Record<string, unknown> = {};
  const origines: Record<string, string | undefined> = {};
  for (const p of chemins) {
    models[p] = { id: p };
    origines[p] = "contenu de " + p;
  }
  const refs = {
    sandboxFiles: ref<NoeudArbre[]>([]),
    sandboxQuota: ref<unknown>(null),
    isLoadingFiles: ref(false),
    sandboxSearch: ref(""),
    sandboxSearchMode: ref("name"),
    sandboxSearchResults: ref<ResultatRecherche[]>([]),
    isSearchingSandbox: ref(false),
    sandboxFileInput: ref<HTMLInputElement | null>(null),
    sandboxFolderInput: ref<HTMLInputElement | null>(null),
    showImportMenu: ref(false),
    openTabs: ref<Onglet[]>(chemins.map((p) => ({ path: p, name: p.split("/").pop() ?? p }))),
    activeTabPath: ref<string | null>(o.actif !== undefined ? o.actif : (chemins[0] ?? null)),
    models,
    originalFileContent: origines,
    monacoRef: { instance: null },
    showHiddenFiles: ref(false),
  };
  const requetes: string[] = [];
  const toasts: string[] = [];
  const migrations: [string, string][] = [];
  const api = setupEditorSandboxFs(
    refs,
    {
      showToast: (m) => toasts.push(m),
      openPrompt: () => Promise.resolve(o.nouveauNom !== undefined ? o.nouveauNom : "neuf"),
      openConfirm: () => Promise.resolve(true),
      fetchAuth: (url) => {
        requetes.push(url);
        if (o.reponse) return Promise.resolve(o.reponse());
        if (url.includes("snapshots/create") || url.includes("snapshots/restore"))
          return Promise.resolve(ndjson(o.morceaux ?? []));
        if (o.echecRename && url.includes("rename"))
          return Promise.resolve(json({ detail: "nom déjà utilisé" }, 409));
        return Promise.resolve(json({ files: [], items: [] }));
      },
    },
    {
      _migrateModel: (avant, apres) => {
        migrations.push([avant, apres]);
        if (models[avant] !== undefined) {
          models[apres] = models[avant];
          delete models[avant];
        }
      },
      ...o.rappels,
    },
  );
  return {
    api,
    refs,
    models,
    origines,
    requetes,
    toasts,
    migrations,
    onglets: () => refs.openTabs.value.map((t) => t.path),
    noms: () => refs.openTabs.value.map((t) => t.name),
  };
}

describe("renommage : les quatre états migrés", () => {
  it("fichier : modèle, contenu de référence, onglet et onglet actif", async () => {
    const v = monter({
      onglets: ["dossier/a.txt", "c.txt"],
      actif: "dossier/a.txt",
      nouveauNom: "  b.txt  ",
    });
    await v.api.renameItem("dossier/a.txt");
    expect(v.migrations).toEqual([["dossier/a.txt", "dossier/b.txt"]]);
    expect(v.models["dossier/a.txt"]).toBeUndefined();
    expect(v.origines["dossier/b.txt"]).toBe("contenu de dossier/a.txt");
    expect(v.origines["dossier/a.txt"]).toBeUndefined();
    expect(v.onglets()).toEqual(["dossier/b.txt", "c.txt"]);
    expect(v.noms()).toEqual(["b.txt", "c.txt"]);
    expect(v.refs.activeTabPath.value).toBe("dossier/b.txt");
  });

  it("dossier : toute la descendance, rien au-dehors", async () => {
    const v = monter({
      onglets: ["src/a.js", "src/sous/b.js", "autre/c.js"],
      actif: "src/sous/b.js",
      nouveauNom: "lib",
    });
    await v.api.renameItem("src");
    expect(v.models["lib/a.js"] && v.models["lib/sous/b.js"]).toBeTruthy();
    expect(v.origines["lib/sous/b.js"]).toBe("contenu de src/sous/b.js");
    expect(v.onglets().sort()).toEqual(["autre/c.js", "lib/a.js", "lib/sous/b.js"]);
    expect(v.refs.activeTabPath.value).toBe("lib/sous/b.js");
    expect(v.origines["autre/c.js"]).toBe("contenu de autre/c.js");
  });

  it("préfixe strict : « src » ne migre ni « src2 », ni « srcbackup », ni « src.old »", async () => {
    const v = monter({
      onglets: ["src/a.js", "src2/b.js", "srcbackup/c.js", "src.old"],
      actif: "src2/b.js",
      nouveauNom: "lib",
    });
    await v.api.renameItem("src");
    expect(v.onglets().sort()).toEqual(["lib/a.js", "src.old", "src2/b.js", "srcbackup/c.js"]);
    expect(v.migrations).toEqual([["src/a.js", "lib/a.js"]]);
    expect(v.refs.activeTabPath.value).toBe("src2/b.js");
  });

  it("nom avec séparateur, identique ou vide : aucune requête", async () => {
    for (const nom of ["sous/b.txt", "sous\\b.txt", "a.txt", "", "   ", null]) {
      const v = monter({ onglets: ["a.txt"], nouveauNom: nom });
      await v.api.renameItem("a.txt");
      expect(v.requetes, JSON.stringify(nom)).toEqual([]);
      expect(v.onglets()).toEqual(["a.txt"]);
    }
  });

  it("refus serveur : rien ne migre et le détail remonte", async () => {
    const v = monter({ onglets: ["a.txt"], actif: "a.txt", nouveauNom: "b.txt", echecRename: true });
    await v.api.renameItem("a.txt");
    expect(v.onglets()).toEqual(["a.txt"]);
    expect(v.migrations).toEqual([]);
    expect(v.toasts).toContain("nom déjà utilisé");
  });

  it("visualiseur : fermeture puis réouverture au nouveau chemin", async () => {
    const appels: string[] = [];
    const v = monter({
      onglets: ["img.png"],
      nouveauNom: "photo.png",
      rappels: {
        isSpecialPath: () => true,
        closeTab: (p, _e, force) => {
          appels.push(`fermer ${p} ${String(force)}`);
        },
        openFile: (p) => {
          appels.push(`ouvrir ${p}`);
          return Promise.resolve();
        },
      },
    });
    await v.api.renameItem("img.png");
    expect(appels).toEqual(["fermer img.png true", "ouvrir photo.png"]);
    expect(v.migrations).toEqual([]);
  });
});

describe("déplacement", () => {
  it("fichier et dossier, vers un dossier ou la racine", async () => {
    const v = monter({
      onglets: ["a.txt", "src/x.js", "src/sous/y.js", "src2/z.js"],
      actif: "src/sous/y.js",
    });
    await v.api.moveItem("a.txt", "archives");
    await v.api.moveItem("src", "archives");
    expect(v.onglets()).toEqual([
      "archives/a.txt",
      "archives/src/x.js",
      "archives/src/sous/y.js",
      "src2/z.js",
    ]);
    expect(v.origines["archives/a.txt"]).toBe("contenu de a.txt");
    expect(v.refs.activeTabPath.value).toBe("archives/src/sous/y.js");
    await v.api.moveItem("archives/a.txt", "");
    expect(v.onglets()[0]).toBe("a.txt");
  });

  it("même endroit, chemin vide ou doublon rapproché : aucune requête de plus", async () => {
    const v = monter({ onglets: ["dossier/a.txt"] });
    await v.api.moveItem("dossier/a.txt", "dossier");
    await v.api.moveItem("", "ailleurs");
    expect(v.requetes).toEqual([]);
    await v.api.moveItem("dossier/a.txt", "x");
    const n = v.requetes.length;
    await v.api.moveItem("dossier/a.txt", "x");
    expect(v.requetes.length).toBe(n);
  });

  it("refus serveur : rien ne migre et la cause est dite", async () => {
    const v = monter({ onglets: ["a.txt"], actif: "a.txt", echecRename: true });
    await v.api.moveItem("a.txt", "archives");
    expect(v.onglets()).toEqual(["a.txt"]);
    expect(v.toasts).toContain("nom déjà utilisé");
  });
});

describe("arbre et recherche", () => {
  it("chargements concurrents fusionnés ; une réponse hors forme garde l'arbre", async () => {
    let n = 0;
    const v = monter({
      reponse: () => {
        n++;
        return n === 1
          ? json({
              root: "work",
              items: [{ name: "a", path: "a", type: "file", size: 1 }],
              truncated: true,
              max_entries: 5,
            })
          : json({ items: "pas un tableau" });
      },
    });
    const p1 = v.api.loadSandboxFiles();
    const p2 = v.api.loadSandboxFiles();
    expect(p2).toBe(p1);
    await p1;
    expect(v.refs.sandboxFiles.value.map((x) => x.path)).toEqual(["a"]);
    expect(v.api.treeTruncated.value).toEqual({ max: 5 });
    expect(n).toBe(2);
  });
});

describe("instantanés : flux de progression", () => {
  async function flux(morceaux: Array<string | Uint8Array>) {
    const v = monter({ morceaux });
    await v.api.createSnapshot();
    return { p: v.api.snapshotProgress.value, v };
  }

  it("ligne coupée entre deux morceaux, y compris au milieu d'un caractère accentué", async () => {
    const { p } = await flux([
      '{"event":"start","total_files":10,"total_bytes":1000,"phase":"snapshot"}\n{"event":"progr',
      'ess","pct":50,"files_done":5,"phase":"snapshot"}\n',
    ]);
    expect([p.pct, p.files_done, p.total_files]).toEqual([50, 5, 10]);
    const octets = new TextEncoder().encode(
      '{"event":"progress","pct":7,"current_file":"café.txt","phase":"snapshot"}\n',
    );
    const coupe = octets.indexOf(0xc3);
    const r = await flux([octets.slice(0, coupe + 1), octets.slice(coupe + 1)]);
    expect([r.p.pct, r.p.current_file]).toEqual([7, "café.txt"]);
  });

  it("résidu sans saut final, ligne corrompue, lignes vides, octet par octet", async () => {
    expect(
      (
        await flux([
          '{"event":"start","total_files":3,"phase":"snapshot","total_bytes":0}\n',
          '{"event":"progress","pct":99,"phase":"snapshot"}',
        ])
      ).p.pct,
    ).toBe(99);
    const c = await flux([
      '{"event":"start","total_files":3,"phase":"snapshot","total_bytes":0}\n',
      "pas du json\n",
      '{"event":"progress","pct":42,"phase":"snapshot"}\n',
    ]);
    expect([c.p.pct, c.p.total_files]).toEqual([42, 3]);
    expect(
      (
        await flux([
          '{"event":"start","phase":"snapshot","total_files":0,"total_bytes":0}\n\n\n   \n{"event":"progress","pct":11,"phase":"snapshot"}\n',
        ])
      ).p.pct,
    ).toBe(11);
    expect((await flux([])).p.pct).toBe(0);
    const texte =
      '{"event":"start","total_files":4,"phase":"snapshot","total_bytes":0}\n{"event":"progress","pct":73,"files_done":3,"phase":"snapshot"}\n';
    const o = await flux(Array.from(new TextEncoder().encode(texte), (x) => Uint8Array.of(x)));
    expect([o.p.pct, o.p.files_done, o.p.total_files]).toEqual([73, 3, 4]);
  });

  it("start remet tout à zéro ; phase seule ; current_file effacé, phase gardée ; compteurs absents gardés", async () => {
    const s = await flux([
      '{"event":"progress","pct":90,"files_done":9,"phase":"snapshot"}\n',
      '{"event":"start","total_files":5,"total_bytes":500,"phase":"snapshot"}\n',
    ]);
    expect(s.p).toEqual({
      pct: 0,
      files_done: 0,
      total_files: 5,
      bytes_done: 0,
      total_bytes: 500,
      current_file: "",
      phase: "snapshot",
    });
    const ph = await flux([
      '{"event":"progress","pct":40,"files_done":2,"current_file":"x.txt","phase":"snapshot"}\n',
      '{"event":"phase","phase":"extract"}\n',
    ]);
    expect([ph.p.phase, ph.p.pct, ph.p.current_file]).toEqual(["extract", 40, "x.txt"]);
    const a = await flux([
      '{"event":"progress","pct":10,"current_file":"a.txt","phase":"snapshot","files_done":3,"bytes_done":300}\n',
      '{"event":"progress","pct":20,"phase":"snapshot"}\n',
    ]);
    expect([a.p.current_file, a.p.phase, a.p.pct, a.p.files_done, a.p.bytes_done]).toEqual([
      "",
      "snapshot",
      20,
      3,
      300,
    ]);
    const z = await flux([
      '{"event":"progress","pct":50,"files_done":7,"phase":"snapshot"}\n',
      '{"event":"progress","pct":0,"files_done":0,"phase":"snapshot"}\n',
    ]);
    expect([z.p.pct, z.p.files_done]).toEqual([0, 0]);
    expect(
      (
        await flux([
          '{"event":"progress","pct":33,"phase":"snapshot"}\n',
          '{"event":"progress","pct":"beaucoup","phase":"snapshot"}\n',
        ])
      ).p.pct,
    ).toBe(33);
    expect(
      (await flux(['{"event":"progress","pct":55,"phase":"snapshot"}\n', '{"event":"neuf","x":1}\n'])).p.pct,
    ).toBe(55);
  });

  it("occupation retombée à « idle », erreur remontée, seconde création refusée", async () => {
    const ok = await flux(['{"event":"done","phase":"snapshot"}\n']);
    expect(ok.v.api.snapshotBusy.value).toBe("idle");
    expect(ok.v.toasts).toContain("Snapshot créée");
    const ko = await flux(['{"event":"error","message":"disque plein"}\n']);
    expect(ko.v.api.snapshotBusy.value).toBe("idle");
    expect(ko.v.toasts).toContain("disque plein");
    const v = monter({ morceaux: ['{"event":"done","phase":"snapshot"}\n'] });
    v.api.snapshotBusy.value = "create";
    await v.api.createSnapshot();
    expect(v.requetes).toEqual([]);
  });
});
