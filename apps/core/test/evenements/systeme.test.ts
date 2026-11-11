// SPDX-License-Identifier: MIT
/** apps/core/test/evenements/systeme.test.ts — SystemEvents : routage, saturation, sentinelle, revalidation, fermeture, relais. */
import { describe, expect, it } from "vitest";

import { FileAttente } from "../../src/evenements/file";
import { CLIENT_CLOSED, SystemEvents } from "../../src/evenements/systeme";
import type { ElementSysteme, Message } from "../../src/evenements/systeme";
import { attendreQue } from "./aides";

function busAvec(...abonnes: [boolean, number | null][]): {
  bus: SystemEvents;
  files: FileAttente<ElementSysteme>[];
} {
  const bus = new SystemEvents();
  const files = abonnes.map(([staff, uid]) => {
    const file = new FileAttente<ElementSysteme>();
    bus.clients.set(file, { staff, uid, journal: staff });
    return file;
  });
  return { bus, files };
}

async function premier(flux: AsyncGenerator<string>): Promise<IteratorResult<string>> {
  return flux.next();
}

describe("routage (test_system_events_notifications)", () => {
  it("une notification ne va qu'aux flux du destinataire", () => {
    const { bus, files } = busAvec([false, 1], [false, 2], [true, 3]);
    bus.broadcast({ type: "notification", data: { user_id: 1, kind: "routine_ok", unread: 3 } });
    expect(files.map((f) => f.taille)).toEqual([1, 0, 0]);
  });

  it("jobs et réveils des tâches de fond (`chat_job`, `chat_wake`) au seul compte de `data.user_id`", () => {
    const { bus, files } = busAvec([false, 1], [false, 2], [true, 3]);
    bus.broadcast({
      type: "chat_job",
      data: { user_id: 2, chat_id: "c", job: {}, active: 1, active_total: 1 },
    });
    bus.broadcast({ type: "chat_wake", data: { user_id: 1, chat_id: "c", status: "started" } });
    bus.broadcast({ type: "chat_wake", data: { chat_id: "c", status: "done" } });
    expect(files.map((f) => f.taille)).toEqual([1, 1, 0]);
  });

  it("progression d'indexation RAG (`rag_job`) au seul propriétaire, jamais sans user_id", () => {
    const { bus, files } = busAvec([false, 1], [false, 2], [true, 3]);
    bus.broadcast({ type: "rag_job", data: { user_id: 2, collection_id: "c", job: {} } });
    bus.broadcast({ type: "rag_job", data: { collection_id: "c", job: {} } });
    expect(files.map((f) => f.taille)).toEqual([0, 1, 0]);
  });

  it("une notification sans user_id exploitable n'est remise à personne", () => {
    const { bus, files } = busAvec([false, 1], [true, 2]);
    bus.broadcast({ type: "notification", data: { kind: "routine_ok" } });
    bus.broadcast({ type: "notification", data: { user_id: "abc" } });
    bus.broadcast({ type: "notification" });
    expect(files.map((f) => f.taille)).toEqual([0, 0]);
  });

  it("les logs vont au staff abonné au journal seul, le reste à tous", () => {
    const { bus, files } = busAvec([false, 1], [true, 2]);
    bus.fanout({ type: "log", message: "m", level: "INFO" });
    expect(files.map((f) => f.taille)).toEqual([0, 1]);
    bus.broadcast({ type: "model_status", data: {} });
    expect(files.map((f) => f.taille)).toEqual([1, 2]);
  });

  it("l'état des modèles ne part qu'aux comptes qui ont accès au moteur intégré (repli : accès)", () => {
    const vus: number[] = [];
    const bus = new SystemEvents({
      peutVoirModeles: (uid) => {
        vus.push(uid);
        if (uid === 3) throw new Error("base indisponible");
        return uid !== 2;
      },
    });
    const files = [1, 2, 2, 3, null].map((uid) => {
      const f = new FileAttente<ElementSysteme>();
      bus.clients.set(f, { staff: false, uid });
      return f;
    });
    bus.broadcast({ type: "model_status", data: { models: [] } });
    expect(files.map((f) => f.taille)).toEqual([1, 0, 0, 1, 1]);
    expect(vus).toEqual([1, 2, 3]);
  });

  it("un message est sérialisé une seule fois pour tous les clients", () => {
    let appels = 0;
    const { bus, files } = busAvec([false, null], [false, null], [false, null], [false, null], [false, null]);
    const compteur = {
      toJSON() {
        appels += 1;
        return "m";
      },
    };
    bus.fanout({ type: "restart", message: compteur });
    expect(appels).toBe(1);
    for (const f of files) expect(f.retirer()).toBe('{"type": "restart", "message": "m"}');
  });

  it("un message non sérialisable est jeté sans casser le bus", () => {
    const { bus, files } = busAvec([false, 1]);
    const cyclique: Message = { type: "x" };
    cyclique["moi"] = cyclique;
    expect(bus.fanout(cyclique)).toBeNull();
    bus.broadcast({ type: "y" });
    expect(files[0]?.contenu()).toEqual(['{"type": "y"}']);
  });
});

describe("saturation et sentinelle (test_system_events_queue_full)", () => {
  it("un client saturé reste inscrit et reçoit à nouveau", async () => {
    const bus = new SystemEvents();
    const flux = bus.listen({ isStaff: true, journal: true, userId: 1 });
    const attente = premier(flux);
    expect(bus.clients.size).toBe(1);
    for (let i = 0; i < SystemEvents.QUEUE_MAX_SIZE + 5; i++)
      bus.fanout({ type: "log", level: "info", message: `m${i}` });
    expect(bus.clients.size).toBe(1);
    bus.fanout({ type: "log", level: "info", message: "APRES-SATURATION" });
    const recus = [(await attente).value as string];
    const file = [...bus.clients.keys()][0] as FileAttente<ElementSysteme>;
    recus.push(...file.contenu().map((e) => (typeof e === "string" ? e : JSON.stringify(e))));
    expect(recus.join("\n")).toContain("APRES-SATURATION");
    expect(recus.join("\n")).toContain("client saturé");
    await flux.return();
    expect(bus.clients.size).toBe(0);
  });

  it("la sentinelle termine le flux et le désinscrit", async () => {
    const bus = new SystemEvents();
    const flux = bus.listen({ isStaff: true, userId: 1 });
    const attente = premier(flux);
    const file = [...bus.clients.keys()][0] as FileAttente<ElementSysteme>;
    file.deposer(CLIENT_CLOSED);
    expect(await attente).toEqual({ value: undefined, done: true });
    expect(bus.clients.size).toBe(0);
  });

  it("disconnect_user pousse la cause avant la sentinelle, même sur une file pleine", () => {
    const bus = new SystemEvents();
    const pleine = new FileAttente<ElementSysteme>(2);
    pleine.deposer("a");
    pleine.deposer("b");
    const autre = new FileAttente<ElementSysteme>();
    bus.clients.set(pleine, { staff: false, uid: 3 });
    bus.clients.set(autre, { staff: false, uid: 4 });
    expect(bus.disconnectUser(3, { type: "session_expired" })).toBe(1);
    expect(pleine.contenu()).toEqual([{ type: "session_expired" }, CLIENT_CLOSED]);
    expect(bus.clients.has(pleine)).toBe(false);
    expect(autre.taille).toBe(0);
    expect(bus.disconnectUser(null)).toBe(1);
    expect(autre.contenu()).toEqual([CLIENT_CLOSED]);
  });
});

describe("flux d'un client", () => {
  it("le texte déjà sérialisé passe tel quel, un objet est sérialisé comme json.dumps", async () => {
    const bus = new SystemEvents();
    const flux = bus.listen({ userId: 1 });
    const attente = premier(flux);
    bus.broadcast({ type: "restart", message: "é" });
    expect((await attente).value).toBe('{"type": "restart", "message": "\\u00e9"}');
    bus.disconnectUser(1, { type: "session_expired", n: [1.5, null] });
    expect((await flux.next()).value).toBe('{"type": "session_expired", "n": [1.5, null]}');
    expect((await flux.next()).done).toBe(true);
  });

  it("la déconnexion du client (signal) désinscrit tout de suite, sans attendre l'échéance", async () => {
    const bus = new SystemEvents({ attenteMs: 60_000 });
    const fin = new AbortController();
    const flux = bus.listen({ userId: 1, signal: fin.signal });
    const attente = premier(flux);
    expect(bus.nombreClients).toBe(1);
    fin.abort();
    expect(bus.nombreClients).toBe(0);
    expect((await attente).done).toBe(true);
  });

  it("revalidation : session invalide ⇒ session_expired puis fin ; erreur ⇒ le flux continue", async () => {
    const bus = new SystemEvents({ attenteMs: 20, revalidationMs: 30 });
    let etat: "ok" | "erreur" | "expire" = "erreur";
    const flux = bus.listen({
      userId: 1,
      validityCheck: () => {
        if (etat === "erreur") throw new Error("base occupée");
        return etat === "ok";
      },
    });
    const attente = premier(flux);
    await new Promise((r) => setTimeout(r, 120));
    expect(bus.nombreClients).toBe(1);
    etat = "expire";
    expect((await attente).value).toBe('{"type": "session_expired"}');
    expect((await flux.next()).done).toBe(true);
    expect(bus.nombreClients).toBe(0);
  });

  it("seul un staff abonné au journal lance son suivi ; un staff sans abonnement ne reçoit pas les logs", () => {
    let lances = 0;
    const bus = new SystemEvents({ surAbonneJournal: () => (lances += 1) });
    void bus.listen({ userId: 1, journal: true });
    void bus.listen({ userId: 2, isStaff: true });
    expect([lances, bus.aUnAbonneJournal]).toEqual([0, false]);
    void bus.listen({ userId: 3, isStaff: true, journal: true });
    expect([lances, bus.aUnAbonneJournal, bus.nombreAbonnesJournal]).toEqual([1, true, 1]);
    const [, staff, abonne] = [...bus.clients.keys()] as FileAttente<ElementSysteme>[];
    bus.fanout({ type: "log", level: "info", message: "ligne" });
    expect([staff?.contenu().length, abonne?.contenu().length]).toEqual([0, 1]);
  });

  it("fermer : chaque flux reçoit la cause puis se termine, ceux qui arrivent ensuite aussi", async () => {
    const bus = new SystemEvents();
    const avant = bus.listen({ userId: 1 });
    expect(bus.fermer({ type: "worker_recycling" })).toBe(1);
    expect((await avant.next()).value).toBe('{"type": "worker_recycling"}');
    expect((await avant.next()).done).toBe(true);
    const apres = bus.listen({ userId: 2, isStaff: true });
    expect((await apres.next()).value).toBe('{"type": "worker_recycling"}');
    expect((await apres.next()).done).toBe(true);
    expect(bus.nombreClients).toBe(0);
  });
});

describe("broadcast d'un log et historique", () => {
  it("un log va à l'historique et au journal commun, pas aux files locales", () => {
    const lignes: unknown[] = [];
    const bus = new SystemEvents({ ecrireJournal: (l) => lignes.push(l) });
    const staff = new FileAttente<ElementSysteme>();
    bus.clients.set(staff, { staff: true, uid: 1 });
    bus.broadcast({ type: "log", message: "vu partout", level: "info" });
    bus.broadcast({ type: "log", message: 7, category: "llm" });
    bus.broadcast({ type: "log" });
    expect(staff.taille).toBe(0);
    expect(lignes).toEqual([
      { level: "INFO", category: "app", message: "vu partout", logger: "system_events" },
      { level: "INFO", category: "llm", message: "7", logger: "system_events" },
      { level: "INFO", category: "app", message: "", logger: "system_events" },
    ]);
    expect(bus.getRecentLogs().map((e) => [e.message, e.level])).toEqual([
      ["vu partout", "info"],
      [7, ""],
      ["", ""],
    ]);
  });

  it("un journal en échec ne casse pas la diffusion", () => {
    const bus = new SystemEvents({
      ecrireJournal: () => {
        throw new Error("disque plein");
      },
    });
    expect(() => bus.broadcast({ type: "log", message: "x" })).not.toThrow();
    expect(bus.getRecentLogs()).toHaveLength(1);
  });

  it("historique borné à 300 lignes, format de SSELogHandler", () => {
    const bus = new SystemEvents();
    for (let i = 0; i < 305; i++) bus.broadcast({ type: "log", message: `l${i}`, level: "INFO" });
    const historique = bus.getRecentLogs();
    expect(historique).toHaveLength(SystemEvents.LOG_HISTORY_MAXLEN);
    expect(historique[0]?.message).toBe("l5");
    bus.noterLigneJournal("WARNING", "attention", new Date(2026, 9, 6, 9, 5, 7));
    expect(bus.getRecentLogs().at(-1)).toMatchObject({
      message: "09:05:07 - WARNING - attention",
      level: "WARNING",
    });
  });
});

describe("relais vers le canal interne", () => {
  it("relaie les diffusions (texte sérialisé), sauf logs, relais:false et notifications sans destinataire", () => {
    const bus = new SystemEvents();
    const relayes: [Message, string][] = [];
    const retirer = bus.surDiffusion((m, d) => relayes.push([m, d]));
    bus.broadcast({ type: "model_status", data: { n: 1 } });
    bus.broadcast({ type: "log", message: "x" });
    bus.broadcast({ type: "restart" }, { relais: false });
    bus.broadcast({ type: "notification", data: {} });
    bus.broadcast({ type: "notification", data: { user_id: 4 } });
    expect(relayes.map(([, d]) => d)).toEqual([
      '{"type": "model_status", "data": {"n": 1}}',
      '{"type": "notification", "data": {"user_id": 4}}',
    ]);
    retirer();
    bus.broadcast({ type: "restart" });
    expect(relayes).toHaveLength(2);
  });

  it("un texte fourni (republication de l'admin) part tel quel aux clients", async () => {
    const bus = new SystemEvents();
    const flux = bus.listen({ userId: 1 });
    const attente = premier(flux);
    bus.broadcast(
      { type: "restart", message: "x" },
      { relais: false, donnees: '{"type": "restart", "message": "x"}' },
    );
    expect((await attente).value).toBe('{"type": "restart", "message": "x"}');
    await flux.return();
  });

  it("un relais en échec n'empêche ni la diffusion ni les autres relais", async () => {
    const bus = new SystemEvents();
    const recus: string[] = [];
    bus.surDiffusion(() => {
      throw new Error("x");
    });
    bus.surDiffusion((_m, d) => recus.push(d));
    const flux = bus.listen({ userId: 1 });
    const attente = premier(flux);
    bus.broadcast({ type: "restart" });
    expect((await attente).value).toBe('{"type": "restart"}');
    await attendreQue(() => recus.length === 1);
    await flux.return();
  });
});
