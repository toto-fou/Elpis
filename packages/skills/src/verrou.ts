// SPDX-License-Identifier: MIT
/** packages/skills/src/verrou.ts — verrou des écritures de skills : réentrant dans une même chaîne d'appels, exclusif dans le processus, puis `.skills_write.lock` (v1.1) entre processus, fail-open. */
import { AsyncLocalStorage } from "node:async_hooks";

import { lowerPy, stripPy } from "@elpis/commun";
import { journal } from "@elpis/http";
import { Verrou } from "@elpis/mcp";
import { VerrouFichier, VerrouOccupe } from "@elpis/verrous";

import { pyJoin, pyPath } from "./chemins";

/** Plafond d'attente du verrou de fichier sous contention avant fail-open. */
export const VERROU_DELAI_S = 5.0;

function verrouFichierActif(): boolean {
  return !["0", "false", "no", ""].includes(lowerPy(stripPy(process.env["SKILLS_FILELOCK"] ?? "1")));
}

/** Deux niveaux : verrou du processus (réentrant par contexte asynchrone), verrou de fichier à la profondeur 0. */
export class VerrouEcritureSkills {
  private readonly interne = new Verrou();
  private readonly contexte = new AsyncLocalStorage<object>();
  private detenteur: object | null = null;
  private fichier: VerrouFichier | null = null;
  private readonly cheminVerrou: () => string;

  constructor(cheminVerrou: () => string) {
    this.cheminVerrou = cheminVerrou;
  }

  /** Exécute `f` sous le verrou ; un appel imbriqué dans `f` ne se bloque pas lui-même. */
  async avec<T>(f: () => Promise<T>): Promise<T> {
    const jeton = this.contexte.getStore();
    if (jeton !== undefined && jeton === this.detenteur) return f();
    await this.interne.acquerir();
    const nouveau = {};
    this.detenteur = nouveau;
    try {
      await this.prendreFichier();
      return await this.contexte.run(nouveau, f);
    } finally {
      this.detenteur = null;
      try {
        await this.rendreFichier();
      } finally {
        this.interne.liberer();
      }
    }
  }

  /** Vrai si l'appelant courant tient le verrou. */
  tenuIci(): boolean {
    const jeton = this.contexte.getStore();
    return jeton !== undefined && jeton === this.detenteur;
  }

  private async prendreFichier(): Promise<void> {
    if (!verrouFichierActif()) return;
    try {
      const v = new VerrouFichier(this.cheminVerrou(), { delaiMs: VERROU_DELAI_S * 1000 });
      await v.acquerir();
      this.fichier = v;
    } catch (e) {
      this.fichier = null;
      if (e instanceof VerrouOccupe)
        journal("skills").warn(`flock contention > ${VERROU_DELAI_S.toFixed(0)}s — fail-open (RLock seul)`);
      else journal("skills").debug({ err: e }, "flock indisponible (fail-open, RLock seul)");
    }
  }

  private async rendreFichier(): Promise<void> {
    const v = this.fichier;
    this.fichier = null;
    if (v !== null) await v.rendre();
  }
}

/** Chemin du verrou : `SKILLS_LOCK_PATH`, sinon `<racine des skills globaux>/.skills_write.lock`. */
export function cheminVerrouSkills(racineGlobale: () => string): string {
  const surcharge = stripPy(process.env["SKILLS_LOCK_PATH"] ?? "");
  return surcharge ? pyPath(surcharge) : pyJoin(racineGlobale(), ".skills_write.lock");
}
