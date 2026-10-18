// SPDX-License-Identifier: MIT
/** packages/verrous/src/index.ts — point d'entrée de @elpis/verrous : protocole de fichier elpis.verrou.v1.1 partagé avec les services Python. */
export {
  avecVerrou,
  avecVerrouSync,
  cheminVerrou,
  definirProcessus,
  identiteMachine,
  nomProcessus,
  PEREMPTION_DEFAUT_MS,
  pidVivant,
  SUFFIXE_PERIME,
  SUFFIXE_REPRISE,
  VerrouFichier,
  VerrouOccupe,
  VERSION,
} from "./verrou";
export type { OptionsVerrou } from "./verrou";
export { brancherJournal } from "./ports";
export type { FabriqueJournal, Journal } from "./ports";
export { SYSTEMES_DISTANTS, systemesDistants } from "./distants";
