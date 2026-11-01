// SPDX-License-Identifier: MIT
/** frontend/src/features/chat/outils/actions-resultat.ts — registre des actions proposées sous le résultat d'un outil réussi (ex. ouvrir la routine ou l'agent créé) ; chaque entrée = un outil, une action. */
import { enObjet } from "./sortie";
import type { EtapeOutil } from "./types";

export interface ActionResultat {
  libelle: string;
  icone: string;
  /** Événement fenêtre traité par la racine. */
  evenement: string;
  detail: Record<string, unknown>;
}

export const EVT_OUVRIR_ROUTINE = "elpis:ouvrir-routine";
export const EVT_OUVRIR_AGENT = "elpis:ouvrir-agent";

const ACTIONS: Readonly<Record<string, (r: Record<string, unknown>) => ActionResultat | null>> = {
  routine_save: (r) =>
    r["ok"] === true && typeof r["id"] === "number"
      ? {
          libelle: "Ouvrir dans Routines",
          icone: "ph-clock-countdown",
          evenement: EVT_OUVRIR_ROUTINE,
          detail: { id: r["id"] },
        }
      : null,
  agent_save: (r) =>
    r["ok"] === true && typeof r["name"] === "string"
      ? {
          libelle: "Ouvrir dans Agents",
          icone: "ph-robot",
          evenement: EVT_OUVRIR_AGENT,
          detail: { name: r["name"] },
        }
      : null,
};

/** Action sous le résultat d'une étape terminée, `null` si l'outil n'en a pas ou a échoué. */
export function actionResultat(step: EtapeOutil): ActionResultat | null {
  const fabrique = ACTIONS[step.name];
  if (!fabrique || step.status === "running" || step._is_error) return null;
  const r = enObjet(step.result);
  return r ? fabrique(r) : null;
}

export function declencherAction(a: ActionResultat): void {
  window.dispatchEvent(new CustomEvent(a.evenement, { detail: a.detail }));
}
