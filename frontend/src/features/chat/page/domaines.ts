// SPDX-License-Identifier: MIT
/** frontend/src/features/chat/page/domaines.ts — injection typée par domaine des composants du chat ; pendant la coexistence, la racine historique fournit chaque domaine. */
import { inject, onMounted, provide } from "vue";
import type { InjectionKey } from "vue";

import type { ContexteListe, ContexteMessage } from "../message/types";
import { journal } from "../../../platform/journal";
import { CLES_DOMAINES } from "./cles";
import type {
  DomaineComposeur,
  DomaineConversation,
  DomaineEntete,
  DomaineBarre,
  DomaineImage,
  DomaineModeles,
  DomainePage,
} from "./types";

export const CLE_FIL: InjectionKey<ContexteMessage> = Symbol("elpis:chat:fil");
export const CLE_LISTE: InjectionKey<ContexteListe> = Symbol("elpis:chat:liste");
export const CLE_ENTETE: InjectionKey<DomaineEntete> = Symbol("elpis:chat:entete");
export const CLE_CONVERSATION: InjectionKey<DomaineConversation> = Symbol("elpis:chat:conversation");
export const CLE_COMPOSEUR: InjectionKey<DomaineComposeur> = Symbol("elpis:chat:composeur");
export const CLE_MODELES: InjectionKey<DomaineModeles> = Symbol("elpis:chat:modeles");
export const CLE_IMAGE: InjectionKey<DomaineImage> = Symbol("elpis:chat:image");
export const CLE_BARRE: InjectionKey<DomaineBarre> = Symbol("elpis:chat:barre");
export const CLE_PAGE: InjectionKey<DomainePage> = Symbol("elpis:chat:page");

/** Les domaines que la racine fournit (clé → type), à étendre avec chaque composant converti. */
export const DOMAINES = {
  fil: CLE_FIL,
  liste: CLE_LISTE,
  entete: CLE_ENTETE,
  conversation: CLE_CONVERSATION,
  composeur: CLE_COMPOSEUR,
  modeles: CLE_MODELES,
  image: CLE_IMAGE,
  barre: CLE_BARRE,
  page: CLE_PAGE,
} as const;

/** Lit un domaine fourni par un ancêtre ; son absence est une erreur de montage, pas un cas silencieux. */
export function domaine<T>(cle: InjectionKey<T>): T {
  const valeur = inject(cle, null);
  if (valeur === null) throw new Error(`domaine du chat non fourni : ${String(cle.description)}`);
  return valeur;
}

/** Clés d'un domaine que la racine n'expose pas : le cast de `fournirDomainesChat` les lirait `undefined` sans rien dire. */
export function clesAbsentes(racine: object): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [nom, cles] of Object.entries(CLES_DOMAINES)) {
    const absentes = Object.keys(cles).filter((k) => !(k in racine));
    if (absentes.length) out[nom] = absentes;
  }
  return out;
}

/** Fournit tous les domaines depuis un même objet (la racine historique) ; à appeler dans un `setup`. */
export function fournirDomainesChat(racine: object): void {
  for (const cle of Object.values(DOMAINES)) provide(cle as InjectionKey<object>, racine);
  onMounted(() => {
    for (const [nom, absentes] of Object.entries(clesAbsentes(racine)))
      journal.avertir(`[chat] domaine « ${nom} » : absent de la racine : ${absentes.join(", ")}`);
  });
}
