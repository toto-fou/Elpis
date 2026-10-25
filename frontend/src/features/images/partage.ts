// SPDX-License-Identifier: MIT
/** frontend/src/features/images/partage.ts — accès partagé aux actions et à l'état des images, posé par le module du chat et lu par les composants de tuile et de grille. */
import type { ComputedRef } from "vue";

export interface ImageAffichee {
  id: string;
  url?: string;
  thumb_url?: string;
  width?: number;
  height?: number;
  seed?: number | null;
  mime?: string;
  model?: string;
  prompt?: string;
  [cle: string]: unknown;
}

export interface InfosVisionneuse {
  prompt?: string;
  revised?: string;
  meta?: { model?: string; duration_s?: number } | null;
  /** Captures du navigateur : ni modification, ni copie, ni suppression. */
  captures?: boolean;
}

export interface ApiPartageeImages {
  readonly state: Record<string, string>;
  readonly canEdit: ComputedRef<boolean>;
  openViewer(items: readonly ImageAffichee[], idx: number, info?: InfosVisionneuse): void;
  edit(ref: ImageAffichee): void;
  download(ref: ImageAffichee, prompt?: string): void;
  remove(ref: ImageAffichee): void;
  markExpired(id: string): void;
  copyText(texte: string): void;
}

let courante: ApiPartageeImages | null = null;

export function definirApiImages(api: ApiPartageeImages): void {
  courante = api;
}

export function apiImages(): ApiPartageeImages | null {
  return courante;
}
