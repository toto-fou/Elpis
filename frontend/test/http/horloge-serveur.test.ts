// SPDX-License-Identifier: MIT
/** frontend/test/http/horloge-serveur.test.ts — écart d'horloge entre le serveur et le navigateur : lu dans l'en-tête Date, appliqué aux durées des tâches de fond et à l'âge des notifications. */
import type { ResumeJob } from "@elpis/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { notifTimeAgo } from "../../src/app/racine/notifications";
import { GestionnaireSession } from "../../src/features/auth/session";
import { dureeJob } from "../../src/features/chat/jobs/format";
import { ClientHttp } from "../../src/platform/http/client";
import { maintenantServeurS, noterHeureServeur, oublierHeureServeur } from "../../src/platform/horloge";

const T0 = Date.parse("2026-10-24T17:00:00Z");

afterEach(() => {
  oublierHeureServeur();
  vi.useRealTimers();
});

describe("heure du serveur", () => {
  it("un poste en avance de 3 min : l'écart est retenu, une tâche qui démarre affiche 0 s", () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0 + 180_000);
    noterHeureServeur(new Date(T0).toUTCString());
    expect(Math.round(maintenantServeurS())).toBe(T0 / 1000);
    const job = { started_at: T0 / 1000, ended_at: null } as unknown as ResumeJob;
    expect(dureeJob(job, maintenantServeurS())).toBe("0 s");
    expect(notifTimeAgo(T0 / 1000)).toBe("à l'instant");
  });

  it("un écart d'une seconde (précision de l'en-tête) est ignoré", () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0 + 900);
    noterHeureServeur(new Date(T0).toUTCString());
    expect(maintenantServeurS()).toBe((T0 + 900) / 1000);
  });

  it("en-tête absent ou illisible : rien ne change", () => {
    noterHeureServeur(null);
    noterHeureServeur("pas une date");
    const avant = Date.now() / 1000;
    expect(Math.abs(maintenantServeurS() - avant)).toBeLessThan(1);
  });

  it("le client HTTP lit l'en-tête Date de chaque réponse", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0 - 240_000);
    const fauxFetch = () =>
      Promise.resolve(new Response(null, { status: 204, headers: { date: new Date(T0).toUTCString() } }));
    const http = new ClientHttp(new GestionnaireSession(), fauxFetch);
    await http.requete("/api/health");
    expect(Math.round(maintenantServeurS())).toBe(T0 / 1000);
  });
});
