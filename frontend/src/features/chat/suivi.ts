// SPDX-License-Identifier: MIT
/** frontend/src/features/chat/suivi.ts — suivi d'une lecture de flux : décodage, journalisation, gardes et état de rendu courant. */
import { journal } from "../../platform/journal";
import { decoderEvenement } from "./evenements";
import { etatInitial, peutRejouer, reduire, refus } from "./etat-flux";
import type { EtatRendu, Refus } from "./etat-flux";
import type { EvenementFlux } from "@elpis/contracts";

export interface OptionsSuivi {
  readonly chatId: string | null;
  readonly generation: number;
  readonly generationCourante: () => number;
  /** Garde propre à l'appelant (lecture supplantée, chat quitté) : faux = plus rien n'est appliqué. */
  readonly actif?: () => boolean;
  readonly rejeu?: boolean;
}

export interface Recu {
  /** Événement décodé à transmettre à la vue : présent seulement si l'entrée est valide et non refusée. */
  readonly ev: EvenementFlux | null;
  readonly appliquer: boolean;
  readonly refus: Refus;
  readonly type: string | null;
  readonly terminal: boolean;
}

export class SuiviFlux {
  #etat: EtatRendu;
  readonly #opts: OptionsSuivi;
  readonly #signales = new Set<string>();

  constructor(opts: OptionsSuivi) {
    this.#opts = opts;
    this.#etat = etatInitial(opts.generation, opts.chatId, opts.rejeu === true);
  }

  get etat(): EtatRendu {
    return this.#etat;
  }

  get peutRejouer(): boolean {
    return peutRejouer(this.#etat);
  }

  #signaler(cle: string, ...details: unknown[]): void {
    if (this.#signales.has(cle)) return;
    this.#signales.add(cle);
    journal.avertir(...details);
  }

  /** Une valeur du flux : `ev` est l'événement décodé que la vue peut traiter (jamais hors contrat). */
  recevoir(brut: unknown): Recu {
    const decode = decoderEvenement(brut);
    const actif = this.#opts.actif ? this.#opts.actif() : true;
    const generation = actif ? this.#opts.generationCourante() : -1;
    const entree = { generation, decode };
    const r = refus(this.#etat, entree);
    if (decode.statut === "inconnu")
      this.#signaler("inconnu:" + decode.type, "[flux] événement inconnu, ignoré :", decode.type);
    else if (decode.statut === "invalide")
      this.#signaler("invalide:" + decode.raison, "[flux] événement illisible, ignoré :", decode.raison);
    else if (decode.statut === "hors_contrat")
      this.#signaler("hors:" + decode.type, "[flux] événement hors contrat :", decode.type, decode.raison);
    const avant = this.#etat.terminal;
    this.#etat = reduire(this.#etat, entree);
    const type =
      decode.statut === "valide" ? decode.ev.type : decode.statut === "invalide" ? null : decode.type;
    return {
      ev: r === null && decode.statut === "valide" ? decode.ev : null,
      appliquer: r === null && decode.statut === "valide",
      refus: r,
      type,
      terminal: avant === null && this.#etat.terminal !== null,
    };
  }
}
