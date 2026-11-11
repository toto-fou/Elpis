// SPDX-License-Identifier: MIT
/** apps/toolhost/test/office-worker.test.ts — canal du worker Office sur un faux lanceur : appels parallèles, rappels, annulation (démarrage compris), mort du worker sans rejeu, relance, fermeture, lanceur sans descripteur 3. */
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import type { Dict } from "@elpis/commun";
import { Journal } from "@elpis/http";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DecodeurCadres, encoderCadre } from "../src/mcp/office/cadres";
import { CanalOffice, ErreurWorker, RefusRappel, VERSION_CANAL } from "../src/mcp/office/worker";
import type { AppelOffice, Rappels } from "../src/mcp/office/worker";

const journalLignes: string[] = [];
const journal = new Journal({ niveau: "trace", sortie: (l) => journalLignes.push(l) });

/** Faux process : ce que l'hôte écrit sur stdin est décodé dans `recus`, `envoyer` parle sur le descripteur 3. */
class FauxWorker extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly protocole = new PassThrough();
  readonly stdio: (PassThrough | null)[];
  readonly recus: Dict[] = [];
  readonly corps: Buffer[] = [];
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly signaux: string[] = [];
  private readonly decodeur = new DecodeurCadres();
  private readonly attentes: { test: (e: Dict) => boolean; fin: (e: Dict) => void }[] = [];

  constructor(o: { sansProtocole?: boolean; sortAFinStdin?: boolean } = {}) {
    super();
    this.stdio = [this.stdin, this.stdout, this.stderr, ...(o.sansProtocole ? [] : [this.protocole])];
    this.stdin.on("data", (m: Buffer) => {
      for (const c of this.decodeur.pousser(m)) {
        this.recus.push(c.entete);
        this.corps.push(c.corps);
        for (const a of this.attentes.splice(0)) {
          if (a.test(c.entete)) a.fin(c.entete);
          else this.attentes.push(a);
        }
      }
    });
    if (o.sortAFinStdin !== false) this.stdin.on("end", () => this.sortir(0, null));
  }

  envoyer(entete: Dict, corps?: Uint8Array): void {
    this.protocole.write(encoderCadre(entete, corps));
  }

  annoncer(version = VERSION_CANAL): void {
    this.envoyer({ type: "pret", version, outils: [] });
  }

  /** Premier cadre reçu (déjà ou à venir) qui satisfait `test`. */
  attendre(test: (e: Dict) => boolean): Promise<Dict> {
    const deja = this.recus.find(test);
    if (deja !== undefined) return Promise.resolve(deja);
    return new Promise((fin) => this.attentes.push({ test, fin }));
  }

  appelDe(outil: string): Promise<Dict> {
    return this.attendre((e) => e["type"] === "appel" && e["outil"] === outil);
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    this.signaux.push(signal);
    this.sortir(null, signal);
    return true;
  }

  sortir(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.exitCode !== null || this.signalCode !== null) return;
    this.exitCode = code;
    this.signalCode = signal;
    queueMicrotask(() => this.emit("exit", code, signal));
  }

  get enfant(): ChildProcess {
    return this as unknown as ChildProcess;
  }
}

/** Lanceur qui fabrique des faux workers (annoncés tout de suite sauf `annonce: false`) et les garde dans l'ordre. */
function lanceur(o: { annonce?: boolean; sansProtocole?: boolean; sortAFinStdin?: boolean } = {}) {
  const lances: FauxWorker[] = [];
  const lancer = (): ChildProcess => {
    const w = new FauxWorker(o);
    lances.push(w);
    if (o.annonce !== false) queueMicrotask(() => w.annoncer());
    return w.enfant;
  };
  return { lances, lancer };
}

const AUCUN_RAPPEL: Rappels = () => Promise.reject(new Error("aucun rappel attendu"));
const CONTEXTE = { session: "hugo:1", convertir: false, svg_png: false, echarts_svg: false };

function appel(outil: string, signal = new AbortController().signal, rappels = AUCUN_RAPPEL): AppelOffice {
  return { outil, args: { path: `${outil}.docx` }, contexte: CONTEXTE, signal, rappels };
}

const canaux: CanalOffice[] = [];

function canal(lancer: () => ChildProcess, delaiPretMs?: number): CanalOffice {
  const c = new CanalOffice({
    journal,
    lanceur: lancer,
    ...(delaiPretMs === undefined ? {} : { delaiPretMs }),
  });
  canaux.push(c);
  return c;
}

afterEach(async () => {
  vi.useRealTimers();
  journalLignes.length = 0;
  for (const c of canaux.splice(0)) await c.fermer();
});

describe("canal du worker Office", () => {
  it("appels parallèles sur un seul worker : réponses rendues à leur appel, dans l'ordre où le worker les donne", async () => {
    const l = lanceur();
    const c = canal(l.lancer);
    const lent = c.appeler(appel("docx_read"));
    const vif = c.appeler(appel("pptx_read"));
    const w = l.lances[0] as FauxWorker;
    const [a, b] = await Promise.all([w.appelDe("docx_read"), w.appelDe("pptx_read")]);
    expect(l.lances.length).toBe(1);
    expect(a).toMatchObject({ type: "appel", args: { path: "docx_read.docx" }, contexte: CONTEXTE });
    expect(a["id"]).not.toBe(b["id"]);
    w.envoyer({ type: "resultat", id: b["id"], valeur: { ok: true, de: "pptx" } });
    expect(await vif).toEqual({ ok: true, de: "pptx" });
    w.envoyer({ type: "resultat", id: a["id"], valeur: { ok: true, de: "docx" } });
    expect(await lent).toEqual({ ok: true, de: "docx" });
    expect(l.lances.length).toBe(1);
  });

  it("rappels : opération, arguments et corps rendus au worker ; refus typé (RefusRappel) ou erreur quelconque traduits", async () => {
    const l = lanceur();
    const c = canal(l.lancer);
    const vus: [string, Dict, string][] = [];
    const rappels: Rappels = async (op, args, corps) => {
      vus.push([op, args, corps.toString()]);
      if (op === "lire") return { valeur: { taille: 3 }, corps: Buffer.from("PK!") };
      if (op === "ecrire")
        throw new RefusRappel("office", "disque plein", {
          code: "no_space",
          fix: "libérer",
          retryable: true,
        });
      throw new Error("panne");
    };
    const r = c.appeler(appel("docx_edit", undefined, rappels));
    const w = l.lances[0] as FauxWorker;
    const { id } = await w.appelDe("docx_edit");
    w.envoyer({ type: "rappel", id, rid: 1, op: "lire", args: { chemin: "a.docx" } });
    w.envoyer({ type: "rappel", id, rid: 2, op: "ecrire", args: { chemin: "a.docx" } }, Buffer.from("xyz"));
    w.envoyer({ type: "rappel", id, rid: 3, op: "graphique", args: { id: "g" } });
    const reponses = await Promise.all(
      [1, 2, 3].map((rid) => w.attendre((e) => e["type"] === "reponse" && e["rid"] === rid)),
    );
    expect(reponses[0]).toEqual({ type: "reponse", id, rid: 1, ok: true, valeur: { taille: 3 } });
    expect(w.corps[w.recus.indexOf(reponses[0] as Dict)]?.toString()).toBe("PK!");
    expect(reponses[1]).toEqual({
      type: "reponse",
      id,
      rid: 2,
      ok: false,
      erreur: { genre: "office", message: "disque plein", code: "no_space", fix: "libérer", retryable: true },
    });
    expect(reponses[2]).toMatchObject({ ok: false, erreur: { genre: "execution", message: "panne" } });
    expect(vus).toEqual([
      ["lire", { chemin: "a.docx" }, ""],
      ["ecrire", { chemin: "a.docx" }, "xyz"],
      ["graphique", { id: "g" }, ""],
    ]);
    w.envoyer({ type: "resultat", id, valeur: { ok: true } });
    expect(await r).toEqual({ ok: true });
  });

  it("annulation en vol : la raison du signal est rendue tout de suite, le worker reçoit `annuler`, un rappel tardif est refusé", async () => {
    const l = lanceur();
    const c = canal(l.lancer);
    const ac = new AbortController();
    const r = c.appeler(appel("docx_create", ac.signal));
    const w = l.lances[0] as FauxWorker;
    const { id } = await w.appelDe("docx_create");
    ac.abort(new Error("stop de l'utilisateur"));
    await expect(r).rejects.toThrow("stop de l'utilisateur");
    expect(await w.attendre((e) => e["type"] === "annuler")).toEqual({ type: "annuler", id });
    w.envoyer({ type: "rappel", id, rid: 1, op: "lire", args: {} });
    expect(await w.attendre((e) => e["type"] === "reponse")).toMatchObject({
      ok: false,
      erreur: { genre: "annule" },
    });
    w.envoyer({ type: "resultat", id, valeur: { ok: true } });
    const suivant = c.appeler(appel("docx_read"));
    const a2 = await w.appelDe("docx_read");
    w.envoyer({ type: "resultat", id: a2["id"], valeur: { ok: true, n: 2 } });
    expect(await suivant).toEqual({ ok: true, n: 2 });
  });

  it("annulation pendant le démarrage : rejet immédiat, aucun appel envoyé ; le démarrage continue pour l'appel suivant (un seul lancement)", async () => {
    const l = lanceur({ annonce: false });
    const c = canal(l.lancer);
    const ac = new AbortController();
    const r = c.appeler(appel("docx_create", ac.signal));
    await vi.waitFor(() => expect(l.lances.length).toBe(1));
    ac.abort(new Error("annulé au démarrage"));
    await expect(r).rejects.toThrow("annulé au démarrage");
    const w = l.lances[0] as FauxWorker;
    const deja = new AbortController();
    deja.abort(new Error("déjà annulé"));
    await expect(c.appeler(appel("docx_read", deja.signal))).rejects.toThrow("déjà annulé");
    const suivant = c.appeler(appel("pptx_read"));
    w.annoncer();
    const a = await w.appelDe("pptx_read");
    w.envoyer({ type: "resultat", id: a["id"], valeur: { ok: true } });
    expect(await suivant).toEqual({ ok: true });
    expect(l.lances.length).toBe(1);
    expect(w.recus.filter((e) => e["type"] === "appel").map((e) => e["outil"])).toEqual(["pptx_read"]);
  });

  it("mort du worker en route : ErreurWorker, appel jamais rejoué ; l'appel suivant relance un worker", async () => {
    const l = lanceur();
    const c = canal(l.lancer);
    const r = c.appeler(appel("docx_edit"));
    const w1 = l.lances[0] as FauxWorker;
    await w1.appelDe("docx_edit");
    w1.stderr.write("Traceback (most recent call last):\nMemoryError\npartiel");
    await new Promise((fin) => setImmediate(fin));
    w1.sortir(137, null);
    await expect(r).rejects.toThrow(ErreurWorker);
    await expect(r).rejects.toThrow("worker Office arrêté (code 137)");
    expect(journalLignes.join("\n")).toContain("[office] worker : MemoryError");
    expect(journalLignes.join("\n")).toContain("[office] worker : partiel");
    const suivant = c.appeler(appel("docx_read"));
    await vi.waitFor(() => expect(l.lances.length).toBe(2));
    const w2 = l.lances[1] as FauxWorker;
    const a = await w2.appelDe("docx_read");
    w2.envoyer({ type: "resultat", id: a["id"], valeur: { ok: true, relance: true } });
    expect(await suivant).toEqual({ ok: true, relance: true });
    expect(w2.recus.filter((e) => e["type"] === "appel").map((e) => e["outil"])).toEqual(["docx_read"]);
  });

  it("worker qui meurt au démarrage, échec du moteur ou résultat illisible : ErreurWorker ; stdout journalisé", async () => {
    const l = lanceur({ annonce: false });
    const c = canal(l.lancer);
    const r = c.appeler(appel("docx_read"));
    await vi.waitFor(() => expect(l.lances.length).toBe(1));
    (l.lances[0] as FauxWorker).sortir(2, null);
    await expect(r).rejects.toThrow("worker Office arrêté au démarrage (code 2)");
    const r2 = c.appeler(appel("docx_read"));
    await vi.waitFor(() => expect(l.lances.length).toBe(2));
    const w = l.lances[1] as FauxWorker;
    w.stdout.write("BAVARD à l'import\n");
    w.annoncer();
    const a = await w.appelDe("docx_read");
    w.envoyer({ type: "echec", id: a["id"], message: "KeyError: 'x'" });
    await expect(r2).rejects.toThrow("worker Office : KeyError: 'x'");
    const r3 = c.appeler(appel("pptx_read"));
    const b = await w.appelDe("pptx_read");
    w.envoyer({ type: "resultat", id: b["id"], valeur: [1, 2] });
    await expect(r3).rejects.toThrow("résultat illisible");
    expect(journalLignes.join("\n")).toContain("[office] worker : BAVARD à l'import");
  });

  it("annonce d'une autre version : ErreurWorker, worker tué", async () => {
    const l = lanceur({ annonce: false });
    const c = canal(l.lancer);
    const r = c.appeler(appel("docx_read"));
    await vi.waitFor(() => expect(l.lances.length).toBe(1));
    (l.lances[0] as FauxWorker).annoncer(VERSION_CANAL + 1);
    await expect(r).rejects.toThrow("annonce inattendue");
    expect((l.lances[0] as FauxWorker).signaux).toEqual(["SIGKILL"]);
  });

  it("pas d'annonce dans le délai : ErreurWorker, worker tué", async () => {
    const l = lanceur({ annonce: false });
    const c = canal(l.lancer, 30);
    await expect(c.appeler(appel("docx_read"))).rejects.toThrow("pas de réponse au démarrage");
    expect((l.lances[0] as FauxWorker).signaux).toEqual(["SIGKILL"]);
  });

  it("lanceur sans `stdio[3]` : refus immédiat, minuteur de démarrage désarmé, process tué", async () => {
    vi.useFakeTimers();
    const l = lanceur({ sansProtocole: true, annonce: false });
    const c = canal(l.lancer);
    await expect(c.appeler(appel("docx_read"))).rejects.toThrow("sans canal de protocole (descripteur 3)");
    expect(vi.getTimerCount()).toBe(0);
    expect((l.lances[0] as FauxWorker).signaux).toEqual(["SIGKILL"]);
    (l.lances[0] as FauxWorker).emit("error", new Error("spawn EACCES"));
  });

  it("fermeture à l'arrêt de l'hôte : appels en vol refusés, stdin fermé, worker parti ; plus aucun appel ensuite", async () => {
    const l = lanceur();
    const c = canal(l.lancer);
    const r = c.appeler(appel("docx_create"));
    const w = l.lances[0] as FauxWorker;
    await w.appelDe("docx_create");
    await c.fermer();
    await expect(r).rejects.toThrow("worker Office arrêté");
    expect(w.stdin.writableEnded).toBe(true);
    expect(w.exitCode).toBe(0);
    expect(w.signaux).toEqual([]);
    await expect(c.appeler(appel("docx_read"))).rejects.toThrow(ErreurWorker);
    expect(l.lances.length).toBe(1);
  });

  it("fermeture d'un worker qui ne sort pas : tué (SIGKILL) après le délai d'arrêt", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const l = lanceur({ sortAFinStdin: false });
    const c = canal(l.lancer);
    const r = c.appeler(appel("docx_read"));
    const w = l.lances[0] as FauxWorker;
    await w.appelDe("docx_read");
    const ferme = c.fermer();
    await expect(r).rejects.toThrow(ErreurWorker);
    await vi.advanceTimersByTimeAsync(3_000);
    await ferme;
    expect(w.signaux).toEqual(["SIGKILL"]);
  });
});
