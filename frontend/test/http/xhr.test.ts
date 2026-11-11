// SPDX-License-Identifier: MIT
/** frontend/test/http/xhr.test.ts — envois XHR d'import : progression, annulation, fin de session (interruption, réponse périmée). */
import { afterEach, describe, expect, it, vi } from "vitest";

import { GestionnaireSession } from "../../src/features/auth/session";
import { envoyerXhr } from "../../src/platform/http/xhr";
import type { ControleXhr } from "../../src/platform/http/xhr";

class FauxXhr {
  static derniers: FauxXhr[] = [];
  status = 0;
  responseText = "";
  timeout = 0;
  annule = false;
  envoye: unknown = null;
  upload: { onprogress: ((e: { lengthComputable: boolean; loaded: number; total: number }) => void) | null } =
    {
      onprogress: null,
    };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  ontimeout: (() => void) | null = null;
  constructor() {
    FauxXhr.derniers.push(this);
  }
  open(): void {}
  send(corps: unknown): void {
    this.envoye = corps;
  }
  abort(): void {
    this.annule = true;
    this.onabort?.();
  }
  repondre(status: number, corps: string): void {
    this.status = status;
    this.responseText = corps;
    this.onload?.();
  }
}

function session(): GestionnaireSession {
  const s = new GestionnaireSession();
  s.ouvrir({ id: 1, username: "u", is_admin: false, role: "user", avatar: null });
  return s;
}

describe("envoyerXhr", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    FauxXhr.derniers = [];
  });

  it("rend le JSON, la progression et le statut", async () => {
    vi.stubGlobal("XMLHttpRequest", FauxXhr);
    const vus: number[] = [];
    const p = envoyerXhr(session(), "/u", "corps", (c) => vus.push(c));
    const x = FauxXhr.derniers[0];
    x?.upload.onprogress?.({ lengthComputable: true, loaded: 5, total: 10 });
    x?.repondre(200, '{"saved":2}');
    await expect(p).resolves.toEqual({ ok: true, status: 200, data: { saved: 2 } });
    expect(vus).toEqual([5]);
    expect(x?.timeout).toBe(600_000);
  });

  it("un import déjà annulé ne part pas ; le contrôle reçoit puis rend l'XHR", async () => {
    vi.stubGlobal("XMLHttpRequest", FauxXhr);
    await expect(envoyerXhr(session(), "/u", "c", null, { cancelled: true })).resolves.toMatchObject({
      aborted: true,
    });
    expect(FauxXhr.derniers).toHaveLength(0);
    const ctl: ControleXhr = {};
    const p = envoyerXhr(session(), "/u", "c", null, ctl);
    expect(ctl.xhr).toBe(FauxXhr.derniers[0]);
    FauxXhr.derniers[0]?.repondre(413, "pas du json");
    await expect(p).resolves.toEqual({ ok: false, status: 413, data: null });
    expect(ctl.xhr).toBeNull();
  });

  it("la fin de session interrompt l'envoi en cours", async () => {
    vi.stubGlobal("XMLHttpRequest", FauxXhr);
    const s = session();
    const p = envoyerXhr(s, "/u", "c");
    s.fermer("deconnexion");
    await expect(p).resolves.toMatchObject({ aborted: true });
    expect(FauxXhr.derniers[0]?.annule).toBe(true);
  });

  it("une réponse arrivée après un changement de génération est périmée (jamais un 401 traité)", async () => {
    vi.stubGlobal("XMLHttpRequest", FauxXhr);
    const s = session();
    const p = envoyerXhr(s, "/u", "c");
    const x = FauxXhr.derniers[0];
    if (x) x.abort = () => undefined;
    s.fermer("expiration");
    x?.repondre(401, "{}");
    await expect(p).resolves.toMatchObject({ ok: false, status: 0, aborted: true });
  });
});
