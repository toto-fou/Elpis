// SPDX-License-Identifier: MIT
/** frontend/src/features/chat/message/appels.ts — un tour regroupé par appel du modèle (sa réflexion, son texte, ce qu'il a fait), pour le déroulé « En bloc ». */
import type { BlocFil } from "./chronologie.ts";

export type BlocReflexion = Extract<BlocFil, { k: "reflexion" }>;
export type BlocTexte = Extract<BlocFil, { k: "texte" }>;
export type BlocAction = Exclude<BlocFil, BlocReflexion | BlocTexte>;

export interface AppelTour {
  cle: string;
  reflexion: BlocReflexion | null;
  texte: BlocTexte | null;
  actions: BlocAction[];
}

/** Appels dans l'ordre : un appel s'ouvre sur sa réflexion, ou sur son texte quand il n'en a pas. */
export function appelsDuTour(blocs: readonly BlocFil[]): AppelTour[] {
  const out: AppelTour[] = [];
  const ouvrir = (cle: string): AppelTour => {
    const a: AppelTour = { cle, reflexion: null, texte: null, actions: [] };
    out.push(a);
    return a;
  };
  for (const b of blocs) {
    const cur = out[out.length - 1];
    if (b.k === "reflexion") ouvrir(b.cle).reflexion = b;
    else if (b.k === "texte") (cur && !cur.texte && !cur.actions.length ? cur : ouvrir(b.cle)).texte = b;
    else (cur ?? ouvrir(b.cle)).actions.push(b);
  }
  return out;
}
