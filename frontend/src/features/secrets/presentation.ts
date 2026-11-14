// SPDX-License-Identifier: MIT
/** frontend/src/features/secrets/presentation.ts — ce qu'une ligne de secret montre, pour la liste des Paramètres comme pour la table de la console : dernier usage en clair, sites repliés au-delà de trois, coupures d'un hôte. */
import type { Secret } from "@elpis/contracts";
import { ref } from "vue";

import { maintenantServeurS } from "../../platform/horloge";
import { dernierUsage, porteeTexte } from "./format";

/** Sites montrés d'emblée ; au-delà, la liste se déplie. */
const SITES_VISIBLES = 3;
const dateCourte = new Intl.DateTimeFormat("fr-FR", { dateStyle: "short", timeStyle: "short" });

export const infoUsage = (s: Secret): string =>
  s.last_used_at ? dateCourte.format(s.last_used_at * 1000) : "jamais utilisé";

/** Infobulle du nom : tout ce que la ligne résume. */
export const infoNom = (s: Secret): string =>
  `${s.name}\nuser=${s.username ?? "—"} · tls=${s.policy.tls} · version ${s.version}\n${s.use_count} usages · dernier : ${infoUsage(s)}`;

export const usages = (s: Secret): string => `${s.use_count} usage${s.use_count > 1 ? "s" : ""}`;

/** Dernier usage en clair : « il y a 2 min », « à l'instant », « jamais ». */
export function quand(s: Secret): string {
  if (!s.last_used_at) return "jamais";
  const duree = dernierUsage(s.last_used_at, maintenantServeurS());
  return duree.startsWith("<") ? "à l'instant" : `il y a ${duree}`;
}

/** Morceaux d'un hôte ou d'un identifiant entre lesquels une ligne peut se couper : après un point, une arobase ou une barre, avant un port. */
export const morceaux = (texte: string): string[] => texte.split(/(?<=[.@/])|(?=:)/u);

/** Schéma d'un site (`https://`) et le reste : l'hôte se lit d'abord. */
export function partiesSite(site: string): [string, string] {
  const i = site.indexOf("://");
  return i < 0 ? ["", site] : [site.slice(0, i + 3), site.slice(i + 3)];
}

/** Sites d'un secret, repliés quand ils sont nombreux : ceux à montrer, combien restent, et la bascule. */
export function sitesRepliables() {
  const deplies = ref<ReadonlySet<number>>(new Set());
  const repliable = (s: Secret): boolean => porteeTexte(s).length > SITES_VISIBLES + 1;
  function sitesMontres(s: Secret): string[] {
    const tous = porteeTexte(s);
    return deplies.value.has(s.id) || !repliable(s) ? tous : tous.slice(0, SITES_VISIBLES);
  }
  const sitesCaches = (s: Secret): number => porteeTexte(s).length - sitesMontres(s).length;
  function basculerSites(id: number): void {
    const suite = new Set(deplies.value);
    if (!suite.delete(id)) suite.add(id);
    deplies.value = suite;
  }
  return { deplies, repliable, sitesMontres, sitesCaches, basculerSites };
}
