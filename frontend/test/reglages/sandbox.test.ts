// SPDX-License-Identifier: MIT
/** frontend/test/reglages/sandbox.test.ts — Paramètres › Sandbox : état lu par le contrat de `/api/sandbox/me`, réponse hors contrat ignorée et journalisée, amorce en erreur rendue en toast avec ses journaux. */
import { schemaReponseBacMoi, schemaReponseChoixBac, schemaSessionTerminal } from "@elpis/contracts";
import { computed, nextTick, ref, watch } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";

import { creerSandbox } from "../../src/features/reglages/sandbox";
import { journal } from "../../src/platform/journal";
import { bacMoi, json, sessionTerminal } from "../aides";

const CHOIX_EN_ERREUR = {
  ok: true,
  mode: "docker",
  network_profile_id: "isolated",
  bootstrap: { container: { error: "boum", logs: "trace du conteneur" } },
};

let monte: ReturnType<typeof creerSandbox> | null = null;

function monter(repondre: (url: string, init?: RequestInit) => Response) {
  const toasts: string[] = [];
  const appels: string[] = [];
  monte = creerSandbox(
    { computed, nextTick, ref, watch },
    {
      showToast: (m) => toasts.push(m),
      fetchAuth: (url, init) => {
        appels.push((init?.method ?? "GET") + " " + url);
        return Promise.resolve(repondre(url, init));
      },
      openConfirm: () => Promise.resolve(true),
      openPrompt: () => Promise.resolve(null),
    },
  );
  return { sb: monte, toasts, appels };
}

afterEach(() => {
  monte?.stopSandboxPolling();
  monte = null;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("reglages/sandbox", () => {
  it("les réponses factices des tests suivent le contrat", () => {
    expect(schemaReponseBacMoi.safeParse(bacMoi()).success).toBe(true);
    expect(schemaReponseChoixBac.safeParse(CHOIX_EN_ERREUR).success).toBe(true);
    expect(schemaSessionTerminal.safeParse(sessionTerminal("s1", "Terminal 1")).success).toBe(true);
  });

  it("l'état vient de la réponse validée", async () => {
    const { sb } = monter(() => json(bacMoi()));
    await sb.loadSandboxState();
    expect(sb.sandboxState.value.effective_mode).toBe("docker");
    expect(sb.sandboxState.value.container?.running).toBe(true);
    expect(sb.sandboxState.value.stats).toBeNull();
    expect(sb.activeNetProfile.value?.name).toBe("Isolé");
    expect(sb.sandboxStatus.value.tone).toBe("ok");
  });

  it("une réponse hors contrat laisse l'état tel quel et se journalise, sauf en sondage silencieux", async () => {
    const avertir = vi.spyOn(journal, "avertir").mockImplementation(() => undefined);
    const { sb } = monter(() => json({ container: { running: true } }));
    await sb.loadSandboxState();
    expect(sb.sandboxState.value.effective_mode).toBe("folder");
    expect(sb.sandboxState.value.container).toBeNull();
    expect(avertir).toHaveBeenCalledTimes(1);
    await sb.loadSandboxState({ silent: true });
    expect(avertir).toHaveBeenCalledTimes(1);
  });

  it("une amorce en erreur devient un toast et garde les journaux du conteneur", async () => {
    vi.useFakeTimers();
    const { sb, toasts, appels } = monter((url, init) =>
      init?.method === "POST" ? json(CHOIX_EN_ERREUR) : json(bacMoi({ exists: false, running: false })),
    );
    const fin = sb.changeSandboxMode();
    await vi.advanceTimersByTimeAsync(9000);
    await fin;
    expect(toasts).toEqual(["Échec : boum"]);
    expect(sb.transitionState.value.containerLogs).toBe("trace du conteneur");
    expect(appels.slice(0, 2)).toEqual(["POST /api/sandbox/me", "GET /api/sandbox/me"]);
  });
});
