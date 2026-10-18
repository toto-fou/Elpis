// SPDX-License-Identifier: MIT
/** apps/core/src/journal.ts — journal du process : celui de @elpis/http (lignes texte sur stderr, interface de Fastify, copie vers l'historique du bus). */
export { installerCrochetJournal, Journal, journal, journalRacine } from "@elpis/http";
export type { CrochetJournal, Niveau, SortieJournal as Sortie } from "@elpis/http";
