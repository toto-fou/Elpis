// SPDX-License-Identifier: MIT
/** apps/toolhost/test/aides.ts — hôte de test : configuration en mémoire, journal muet, enveloppes signées. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { Journal } from "@elpis/http";
import { creerIdentite, IDENTITY_HEADER, sign } from "@elpis/securite";
import type { FastifyInstance } from "fastify";

import { creerAppToolhost } from "../src/app";
import { composer } from "../src/composition";
import type { Composition, OptionsComposition } from "../src/composition";
import { configParDefaut } from "../src/config";
import type { ToolhostConfig } from "../src/config";

export const lignesJournal: string[] = [];
export const journalMuet = new Journal({ niveau: "trace", sortie: (l) => lignesJournal.push(l) });
export const SVC = "svc-jeton-de-service-de-test";

export function configTest(partiel: Partial<ToolhostConfig> = {}): ToolhostConfig {
  return { ...configParDefaut(), token: SVC, families: ["fs", "git"], ...partiel };
}

export function enveloppe(uid = 7, username = "hugo", cle = SVC, now?: number): string {
  return sign(creerIdentite({ user_id: uid, username }), cle, now === undefined ? {} : { now });
}

export function entetes(uid = 7, username = "hugo"): Record<string, string> {
  return { authorization: `Bearer ${SVC}`, [IDENTITY_HEADER]: enveloppe(uid, username) };
}

export interface HoteTest {
  app: FastifyInstance;
  composition: Composition;
  fermer(): Promise<void>;
}

export async function hoteTest(
  tc: ToolhostConfig = configTest(),
  options: Partial<OptionsComposition> = {},
): Promise<HoteTest> {
  const composition = composer(tc, { journal: journalMuet, ...options });
  const app = await creerAppToolhost({ tc, familles: composition.familles, journal: journalMuet });
  return {
    app,
    composition,
    async fermer() {
      await composition.fermer();
      app.server.closeAllConnections();
      await app.close();
    },
  };
}

/** Dossier temporaire supprimé par la fonction rendue. */
export function dossierTemporaire(prefixe: string): [string, () => void] {
  const d = mkdtempSync(path.join(tmpdir(), prefixe));
  return [d, () => rmSync(d, { recursive: true, force: true })];
}
