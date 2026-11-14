// SPDX-License-Identifier: MIT
/** frontend/src/features/chat/rendu/porteur-flux.ts — porteur d'affichage d'un message en cours de flux : objet hors réactivité, une référence peu profonde par partie (corps, narration, réflexion), mise à jour à chaque image sans remplacer le message. */
import { markRaw, shallowRef } from "vue";
import type { ShallowRef } from "vue";

export interface BlocAffiche {
  i: number;
  html: string;
}

/** Blocs figés et HTML du bloc actif d'une partie du flux. */
export interface AffichageBlocs {
  readonly blocs: readonly BlocAffiche[] | null;
  readonly actif: string;
}

export interface PorteurFlux {
  readonly corps: ShallowRef<AffichageBlocs>;
  readonly narration: ShallowRef<AffichageBlocs>;
  readonly reflexion: ShallowRef<string>;
}

/** Champs du message que le porteur reflète. */
export interface SourcePorteur {
  thinking?: string | null;
  _mdBlocks?: readonly BlocAffiche[] | null;
  _mdActiveHtml?: string | null;
  _ppBlocks?: readonly BlocAffiche[] | null;
  _ppActiveHtml?: string | null;
}

const VIDE: AffichageBlocs = Object.freeze({ blocs: null, actif: "" });

export function creerPorteur(): PorteurFlux {
  return markRaw({ corps: shallowRef(VIDE), narration: shallowRef(VIDE), reflexion: shallowRef("") });
}

function poserBlocs(
  ref: ShallowRef<AffichageBlocs>,
  blocs: readonly BlocAffiche[] | null,
  actif: string,
): void {
  const v = ref.value;
  if (v.blocs !== blocs || v.actif !== actif) ref.value = blocs || actif ? { blocs, actif } : VIDE;
}

/** Recopie dans le porteur les champs d'affichage du message : seules les références dont la valeur change préviennent leurs composants. */
export function synchroniserPorteur(p: PorteurFlux, m: SourcePorteur): void {
  poserBlocs(p.corps, m._mdBlocks ?? null, m._mdActiveHtml ?? "");
  poserBlocs(p.narration, m._ppBlocks ?? null, m._ppActiveHtml ?? "");
  const t = m.thinking ?? "";
  if (p.reflexion.value !== t) p.reflexion.value = t;
}
