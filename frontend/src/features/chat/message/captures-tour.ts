// SPDX-License-Identifier: MIT
/** frontend/src/features/chat/message/captures-tour.ts — captures du navigateur rattachées aux étapes du tour (nouvelle interface) : numéro et libellé de l'étape, source lisible, éléments de la visionneuse. */
import { libelleEtape } from "../outils/verbes.ts";
import { chronologieTour } from "./chronologie.ts";
import type { MessageFil } from "./chronologie.ts";
import type { CaptureWeb, ImageVisionneuse } from "./types.ts";

export interface CaptureDuTour {
  /** Position de l'étape dans `toolSteps`, -1 si inconnue. */
  flat: number;
  numero: number;
  titre: string;
  /** Blob local, sinon adresse de la capture sur le serveur. */
  url: string;
  attente: boolean;
}

export interface VisionneuseCaptures {
  items: (ImageVisionneuse & { prompt: string })[];
  /** Étape (`flat`) → rang de sa première capture dans `items`. */
  parEtape: ReadonlyMap<number, number>;
}

/** Source affichable d'une capture : blob local, sinon l'adresse du serveur (même origine). */
export function sourceCapture(c: CaptureWeb): string {
  if (c.blobUrl) return c.blobUrl;
  const u = c.serverUrl ?? "";
  return u.startsWith("/api/playwright/screenshot/") ? u : "";
}

/** Captures du message dans l'ordre d'arrivée, chacune titrée par son étape (« Étape 2 · Agit sur … »). */
export function capturesDuTour(
  m: MessageFil & { webScreenshots?: readonly CaptureWeb[] | null },
): CaptureDuTour[] {
  const caps = m.webScreenshots ?? [];
  if (!caps.length) return [];
  const numeros = new Map<number, number>();
  for (const b of chronologieTour(m))
    if (b.k === "etapes") for (const e of b.etapes) numeros.set(e.flat, e.numero);
  const steps = m.toolSteps ?? [];
  return caps.map((c, k) => {
    const flat = typeof c.stepIdx === "number" ? c.stepIdx : -1;
    const numero = numeros.get(flat) ?? 0;
    const s = steps[flat];
    const l = s ? libelleEtape(s) : null;
    const quoi = l ? [l.verbe ?? l.outil, l.objet].filter(Boolean).join(" ") : "";
    return {
      flat,
      numero,
      titre: numero ? `Étape ${numero}${quoi ? " · " + quoi : ""}` : `Capture ${k + 1}`,
      url: sourceCapture(c),
      attente: !!c.pending && !c.blobUrl,
    };
  });
}

/** Captures prêtes pour la visionneuse, et le rang de la première capture de chaque étape. */
export function visionneuseCaptures(caps: readonly CaptureDuTour[]): VisionneuseCaptures {
  const items: VisionneuseCaptures["items"] = [];
  const parEtape = new Map<number, number>();
  caps.forEach((c, k) => {
    if (!c.url || c.attente) return;
    if (c.flat >= 0 && !parEtape.has(c.flat)) parEtape.set(c.flat, items.length);
    items.push({ id: "capture:" + k, url: c.url, prompt: c.titre });
  });
  return { items, parEtape };
}
