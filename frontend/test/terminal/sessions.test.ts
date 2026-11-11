// SPDX-License-Identifier: MIT
/** frontend/test/terminal/sessions.test.ts — panneau de terminaux : ouverture (session créée, WS), fermeture confirmée par le serveur, fin de session, 50 cycles ouverture / libération sans terminal, socket, observateur ni minuterie restants. */
import { nextTick, ref } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GestionnaireSession } from "../../src/features/auth/session";
import { setupEditorTerminal } from "../../src/features/terminal/sessions";
import { bacMoi, COMPTE_A, json, sessionTerminal } from "../aides";

const vivants = { terminaux: 0, sockets: 0, observateurs: 0 };
const tailles: Array<(t: { rows: number; cols: number }) => void> = [];

vi.mock("../../src/features/terminal/xterm", () => ({
  chargerXterm: () => Promise.resolve({}),
  creerTerminal: () => {
    vivants.terminaux++;
    let libere = false;
    const term = {
      rows: 24,
      cols: 80,
      open: () => undefined,
      onData: () => ({ dispose: () => undefined }),
      onResize: (rappel: (t: { rows: number; cols: number }) => void) => {
        tailles.push(rappel);
        return { dispose: () => undefined };
      },
      write: () => undefined,
      focus: () => undefined,
      refresh: () => undefined,
    };
    return {
      term,
      fitAddon: { fit: () => undefined },
      liberer: () => {
        if (!libere) vivants.terminaux--;
        libere = true;
      },
    };
  },
}));

class FauxWs {
  static derniers: FauxWs[] = [];
  readyState = 0;
  binaryType = "";
  onopen: (() => void) | null = null;
  onclose: ((e: { code: number }) => void) | null = null;
  onmessage: ((e: unknown) => void) | null = null;
  envoyes: unknown[] = [];
  url: string;
  constructor(url: string) {
    this.url = url;
    vivants.sockets++;
    FauxWs.derniers.push(this);
    queueMicrotask(() => {
      if (this.readyState !== 0) return;
      this.readyState = 1;
      this.onopen?.();
    });
  }
  send(d: unknown): void {
    this.envoyes.push(d);
  }
  close(): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    vivants.sockets--;
    this.onclose?.({ code: 1000 });
  }
}

class FauxRO {
  observe(): void {
    vivants.observateurs++;
  }
  disconnect(): void {
    vivants.observateurs--;
  }
  unobserve(): void {}
}

function monde(supprimerOk = true) {
  const session = new GestionnaireSession();
  session.ouvrir(COMPTE_A);
  let n = 0;
  const appels: string[] = [];
  const toasts: string[] = [];
  const fetchAuth = (url: string, init?: RequestInit): Promise<Response | null> => {
    const m = init?.method ?? "GET";
    appels.push(m + " " + url);
    if (url === "/api/sandbox/me") return Promise.resolve(json(bacMoi()));
    if (url === "/api/terminal/sessions" && m === "GET")
      return Promise.resolve(json({ sessions: [], max: 4 }));
    if (url === "/api/terminal/sessions" && m === "POST") {
      n++;
      return Promise.resolve(json({ ok: true, session: sessionTerminal("s" + n, "Terminal " + n), max: 4 }));
    }
    if (m === "DELETE") return Promise.resolve(supprimerOk ? json({ ok: true }) : json({ detail: "x" }, 500));
    return Promise.resolve(json({}));
  };
  const t = setupEditorTerminal(
    session,
    { user: ref<unknown>({ id: 1 }), monacoRef: { instance: null } },
    { fetchAuth, showToast: (m) => toasts.push(m) },
    { verifierDisqueBientot: () => undefined, liens: () => undefined, apresCommande: () => undefined },
  );
  return { session, t, appels, toasts };
}

/** Conteneurs `[data-term-sid]` que rend le gabarit pour chaque session. */
function rendreConteneurs(sids: string[]): void {
  document.body.innerHTML = sids.map((s) => `<div data-term-sid="${s}"></div>`).join("");
}

async function ouvrir(m: ReturnType<typeof monde>): Promise<void> {
  rendreConteneurs(["__legacy__"].concat(Array.from({ length: 120 }, (_, i) => "s" + (i + 1))));
  await m.t.toggleTerminal();
  await vi.waitFor(() => expect(m.t.termSessionState(m.t.termActiveSid.value ?? "")).toBe("open"));
}

beforeEach(() => {
  vi.stubGlobal("WebSocket", FauxWs);
  vi.stubGlobal("ResizeObserver", FauxRO);
  FauxWs.derniers = [];
  vivants.terminaux = 0;
  vivants.sockets = 0;
  vivants.observateurs = 0;
});
afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("panneau de terminaux", () => {
  it("première ouverture : session créée côté serveur, WebSocket ouvert, taille envoyée", async () => {
    const m = monde();
    await ouvrir(m);
    expect(m.t.termSessions.value.map((s) => s.id)).toEqual(["s1"]);
    expect(FauxWs.derniers[0]?.url).toMatch(/\/ws\/terminal\/s1$/);
    expect(FauxWs.derniers[0]?.envoyes[0]).toBe(JSON.stringify({ op: "resize", rows: 24, cols: 80 }));
    await m.t._destroyAllTerminals();
  });

  it("redimensionnement : le shell ne reçoit que la taille finale, une fois le geste posé", async () => {
    const m = monde();
    await ouvrir(m);
    const ws = FauxWs.derniers[0];
    const avant = ws?.envoyes.length ?? 0;
    const redim = tailles.at(-1);
    for (const rows of [25, 26, 27, 28]) redim?.({ rows, cols: 80 });
    expect(ws?.envoyes.length).toBe(avant);
    await new Promise((r) => setTimeout(r, 160));
    expect(ws?.envoyes.slice(avant)).toEqual([JSON.stringify({ op: "resize", rows: 28, cols: 80 })]);
    await m.t._destroyAllTerminals();
  });

  it("fermeture refusée par le serveur : l'onglet et son terminal restent", async () => {
    const m = monde(false);
    await ouvrir(m);
    await m.t.termCloseSession("s1");
    expect(m.t.termSessions.value).toHaveLength(1);
    expect(vivants.terminaux).toBe(1);
    expect(m.toasts[0]).toMatch(/Fermeture impossible/);
    await m.t._destroyAllTerminals();
  });

  it("fin de session : socket fermée sans reconnexion", async () => {
    vi.useFakeTimers();
    try {
      const m = monde();
      await ouvrir(m);
      m.session.fermer("expiration");
      expect(vivants.sockets).toBe(0);
      await vi.advanceTimersByTimeAsync(5000);
      expect(FauxWs.derniers).toHaveLength(1);
      await m.t._destroyAllTerminals();
    } finally {
      vi.useRealTimers();
    }
  });

  it("50 cycles ouverture, nouvel onglet, libération : aucun terminal, socket ni observateur restant", async () => {
    const m = monde();
    for (let i = 0; i < 50; i++) {
      await ouvrir(m);
      await m.t.termNewSession();
      await nextTick();
      expect(vivants.terminaux).toBe(2);
      await m.t._destroyAllTerminals();
      expect(vivants).toEqual({ terminaux: 0, sockets: 0, observateurs: 0 });
      expect(m.t.termSessions.value).toEqual([]);
      expect(m.t.showTerminal.value).toBe(false);
    }
  });
});
