// SPDX-License-Identifier: MIT
/** apps/core/src/app.ts — fabrique du serveur Fastify d'un process (main ou admin) : socle de @elpis/http, familles du core par défaut. */
import { creerAppHttp } from "@elpis/http";
import type { Extension } from "@elpis/http";
import type { FastifyInstance } from "fastify";

import { famillesParDefaut } from "./familles";
import type { Journal } from "./journal";
import type { ModeApp } from "./mode";
import { verificationDuMode } from "./routes";
import type { Famille, Gardes } from "./routes";

export { MANDATAIRES_DE_CONFIANCE } from "@elpis/http";
export type { Extension } from "@elpis/http";

export interface OptionsApp {
  mode: ModeApp;
  familles?: readonly Famille[];
  gardes?: Gardes;
  extensions?: readonly Extension[];
  limiteCorps?: number;
  journal?: Journal;
  arretEnCours?: () => boolean;
  corsOrigines?: readonly string[];
  /** Extensions posées avant le montage des routes (session et CSRF de @elpis/auth). */
  avantRoutes?: (app: FastifyInstance) => void | Promise<void>;
}

/** Connexions gardées 120 s comme Gunicorn ; une route de la console ne se monte jamais dans main. */
export async function creerApp(options: OptionsApp): Promise<FastifyInstance> {
  return creerAppHttp({
    ...options,
    famillesParDefaut: () => famillesParDefaut(options.mode),
    verifierRoute: verificationDuMode(options.mode),
  });
}
