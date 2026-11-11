// SPDX-License-Identifier: MIT
/** frontend/test/terminal/connexion.test.ts — WebSocket du terminal : ouverture, battement, reconnexion, 4001 et fin de session liés à la génération, libération sans fuite de timers. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GestionnaireSession } from "../../src/features/auth/session";
import { ConnexionTerminal } from "../../src/features/terminal/connexion";
import type { RappelsConnexion, StatutTerminal } from "../../src/features/terminal/connexion";

class FausseSocket {
  readyState = 0;
  binaryType = "";
  envoyes: unknown[] = [];
  fermeture: [number | undefined, string | undefined] | null = null;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onclose: ((e: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  readonly url: string;
  constructor(url: string) {
    this.url = url;
  }
  send(d: unknown): void {
    this.envoyes.push(d);
  }
  close(code?: number, raison?: string): void {
    this.fermeture = [code, raison];
    this.readyState = 3;
  }
  ouvrir(): void {
    this.readyState = 1;
    this.onopen?.();
  }
  couper(code: number): void {
    this.readyState = 3;
    this.onclose?.({ code });
  }
}

function banc(opts: { reconnecter?: boolean; repli?: boolean; inconnue?: boolean } = {}) {
  const session = new GestionnaireSession();
  session.ouvrir({ id: 1, username: "u", is_admin: false, role: "user", avatar: null });
  const sockets: FausseSocket[] = [];
  const statuts: StatutTerminal[] = [];
  const sorties: number[][] = [];
  const ecrits: string[] = [];
  const rappels: RappelsConnexion = {
    statut: (s) => statuts.push(s),
    sortie: (o) => sorties.push([...o]),
    taille: () => ({ rows: 24, cols: 80 }),
    ecrire: (t) => ecrits.push(t),
    inconnue: () => opts.inconnue ?? true,
    echecInitial: () => opts.repli ?? false,
    doitReconnecter: () => opts.reconnecter ?? true,
  };
  const conn = new ConnexionTerminal(
    session,
    {
      url: () => "ws://x/t",
      battementMs: 25_000,
      reconnexionMs: 1_200,
      fabrique: (u) => {
        const s = new FausseSocket(u);
        sockets.push(s);
        return s as unknown as WebSocket;
      },
    },
    rappels,
  );
  return { session, conn, sockets, statuts, sorties, ecrits };
}

describe("ConnexionTerminal", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("ouverture : taille envoyée, battement, sortie binaire et envoi", async () => {
    const b = banc();
    const p = b.conn.connecter();
    b.sockets[0]?.ouvrir();
    await expect(p).resolves.toBe(true);
    expect(b.statuts).toEqual(["connecting", "open"]);
    expect(b.sockets[0]?.envoyes[0]).toBe(JSON.stringify({ op: "resize", rows: 24, cols: 80 }));
    vi.advanceTimersByTime(25_000);
    expect(b.sockets[0]?.envoyes[1]).toBe(JSON.stringify({ op: "ping" }));
    b.sockets[0]?.onmessage?.({ data: new Uint8Array([104, 105]).buffer });
    expect(b.sorties).toEqual([[104, 105]]);
    expect(b.conn.envoyer("a")).toBe(true);
    expect(b.conn.redimensionner(30, 100)).toBe(true);
  });

  it("coupure après ouverture : reconnexion différée, puis nouveau shell signalé", async () => {
    const b = banc();
    const p = b.conn.connecter();
    b.sockets[0]?.ouvrir();
    await p;
    b.sockets[0]?.onmessage?.({ data: JSON.stringify({ type: "hello", fresh_shell: true }) });
    b.sockets[0]?.couper(1006);
    expect(b.statuts.at(-1)).toBe("reconnecting");
    vi.advanceTimersByTime(1_200);
    expect(b.sockets).toHaveLength(2);
    b.sockets[1]?.ouvrir();
    b.sockets[1]?.onmessage?.({ data: JSON.stringify({ type: "hello", fresh_shell: true }) });
    expect(b.ecrits.join("")).toContain("nouveau shell");
  });

  it("4001 : expiration signalée pour la génération de la socket, sans repli ni reconnexion", async () => {
    const b = banc({ repli: true });
    const p = b.conn.connecter();
    b.sockets[0]?.ouvrir();
    await p;
    b.sockets[0]?.couper(4001);
    expect(b.session.etat.statut).toBe("deconnecte");
    vi.advanceTimersByTime(10_000);
    expect(b.sockets).toHaveLength(1);
  });

  it("4001 d'une génération révolue : ignoré (la session courante reste ouverte)", async () => {
    const b = banc();
    const p = b.conn.connecter();
    b.sockets[0]?.ouvrir();
    await p;
    const vieille = b.sockets[0];
    b.session.ouvrir({ id: 2, username: "v", is_admin: false, role: "user", avatar: null });
    expect(vieille?.fermeture).toEqual([1000, "session"]);
    vieille?.couper(4001);
    expect(b.session.etat.statut).toBe("connecte");
  });

  it("session_expired puis fermeture : même traitement que 4001", async () => {
    const b = banc();
    const p = b.conn.connecter();
    b.sockets[0]?.ouvrir();
    await p;
    b.sockets[0]?.onmessage?.({ data: JSON.stringify({ type: "session_expired" }) });
    b.sockets[0]?.couper(1000);
    expect(b.session.etat.statut).toBe("deconnecte");
  });

  it("fin de session pendant l'attente de reconnexion : socket fermée et reprise annulée", async () => {
    const b = banc();
    const p = b.conn.connecter();
    b.sockets[0]?.ouvrir();
    await p;
    b.sockets[0]?.couper(1006);
    b.session.fermer("deconnexion");
    vi.advanceTimersByTime(5_000);
    expect(b.sockets).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("échec avant ouverture : repli de l'appelant, 4004 traité, sinon fermé", async () => {
    const r = banc({ repli: true });
    const p1 = r.conn.connecter();
    r.sockets[0]?.couper(1006);
    await expect(p1).resolves.toBe(true);
    const i = banc();
    const p2 = i.conn.connecter();
    i.sockets[0]?.couper(4004);
    await expect(p2).resolves.toBe(false);
    expect(i.statuts.at(-1)).toBe("connecting");
    const f = banc();
    const p3 = f.conn.connecter();
    f.sockets[0]?.couper(1006);
    await expect(p3).resolves.toBe(false);
    expect(f.statuts.at(-1)).toBe("closed");
  });

  it("cycles ouverture/fermeture : aucune socket ni minuterie laissée", async () => {
    const b = banc();
    for (let n = 0; n < 5; n++) {
      const p = b.conn.connecter();
      b.sockets[n]?.ouvrir();
      await p;
      b.conn.liberer();
      expect(b.sockets[n]?.fermeture).toEqual([1000, "unmount"]);
    }
    expect(vi.getTimerCount()).toBe(0);
    expect(b.conn.envoyer("x")).toBe(false);
  });
});
