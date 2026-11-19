// SPDX-License-Identifier: MIT
/** apps/core/test/conformite/repertoire-ldap.ts — annuaire en mémoire évalué comme un serveur LDAP (filtres RFC 4515, portées, limites, règle en chaîne, références) pour le serveur de test. */
import {
  AndFilter,
  EqualityFilter,
  ExtensibleFilter,
  NotFilter,
  OrFilter,
  PresenceFilter,
  SubstringFilter,
} from "ldapts";
import type { Filter } from "ldapts";

import type {
  DemandeRecherche,
  ElementRecherche,
  EntreeServeur,
  ReponseRecherche,
} from "../identite/annuaire/serveur-ldap";

export const REGLE_CHAINE = "1.2.840.113556.1.4.1941";

export interface OptionsRepertoire {
  /** Plafond de taille du serveur (1000 pour Active Directory) ; au-delà : code 4 avec les entrées déjà trouvées. */
  limiteServeur?: number;
  /** Attributs comparés octet à octet (noms en minuscules). */
  binaires?: readonly string[];
  /** Attributs construits : rendus seulement s'ils sont demandés par leur nom. */
  construits?: readonly string[];
  /** Règle en chaîne : `supportee` (Active Directory), `ignoree` (aucune entrée, succès), `erreur` (code 53). */
  regleChaine?: "supportee" | "ignoree" | "erreur";
  /** Références de continuation rendues pour une recherche en sous-arbre à cette racine. */
  renvoisRacine?: { racine: string; uris: readonly string[]; avant?: boolean };
  /** Au-delà de ce nombre de valeurs, `member` est rendu en `member;range=0-(n-1)`. */
  plageMembres?: number;
  /** Entrée de la racine DSE rendue pour une base vide. */
  racineDse?: EntreeServeur;
  /** RFC 4517 §4.2.31 lu strictement : une valeur `DN#UID` ne correspond pas à une assertion sans UID. */
  uniqueMemberStrict?: boolean;
  /** Recherche de portée base sans correspondance : ce code de résultat au lieu de « succès, 0 entrée » (32 pour LLDAP). */
  baseSansCorrespondance?: number;
  /** Réponse imposée avant toute évaluation (droits, erreurs propres au produit). */
  interception?: (d: DemandeRecherche) => ReponseRecherche | null;
}

const ATTRIBUTS_DN = new Set(["member", "memberof", "uniquemember", "owner", "manager", "ismemberof"]);

export function dnPlie(dn: string): string {
  return dn
    .split(/(?<!\\),/u)
    .map((r) =>
      r
        .replace(/\s*=\s*/u, "=")
        .trim()
        .toLowerCase(),
    )
    .join(",");
}

const octets = (v: string | Buffer): Buffer => (typeof v === "string" ? Buffer.from(v, "utf8") : v);
const texte = (v: string | Buffer): string => (typeof v === "string" ? v : v.toString("utf8"));
const plie = (v: string): string => v.trim().replace(/\s+/gu, " ").toUpperCase().toLowerCase();

function valeursDe(e: EntreeServeur, nom: string): readonly (string | Buffer)[] {
  const n = nom.toLowerCase();
  for (const [k, v] of Object.entries(e.attrs)) if (k.toLowerCase() === n) return v;
  return [];
}

function dnDeValeur(v: string | Buffer): string {
  return dnPlie(texte(v).replace(/#'[01]+'B$/u, ""));
}

function egal(
  attribut: string,
  stocke: string | Buffer,
  demande: string | Buffer,
  o: OptionsRepertoire,
): boolean {
  const n = attribut.toLowerCase();
  if (o.binaires?.includes(n) === true) return octets(stocke).equals(octets(demande));
  // Active Directory résout `objectCategory=person` vers le DN de la classe.
  if (n === "objectcategory" && plie(texte(stocke)).startsWith(`cn=${plie(texte(demande))},`)) return true;
  if (n === "uniquemember") {
    const [sd, su] = texte(stocke).split("#");
    const [ad, au] = texte(demande).split("#");
    if (dnPlie(sd ?? "") !== dnPlie(ad ?? "")) return false;
    return o.uniqueMemberStrict === true ? su === au : au === undefined || su === au;
  }
  if (ATTRIBUTS_DN.has(n)) return dnDeValeur(stocke) === dnDeValeur(demande);
  return plie(texte(stocke)) === plie(texte(demande));
}

function groupesDirects(tous: readonly EntreeServeur[], dn: string): EntreeServeur[] {
  return tous.filter((g) => valeursDe(g, "member").some((m) => dnDeValeur(m) === dnPlie(dn)));
}

function dansChaine(tous: readonly EntreeServeur[], e: EntreeServeur, groupe: string): boolean {
  const vus = new Set<string>();
  const pile = [e.dn];
  while (pile.length > 0) {
    const dn = pile.pop() as string;
    for (const g of groupesDirects(tous, dn)) {
      const k = dnPlie(g.dn);
      if (k === dnPlie(groupe)) return true;
      if (!vus.has(k)) {
        vus.add(k);
        pile.push(g.dn);
      }
    }
  }
  return false;
}

function correspond(
  f: Filter,
  e: EntreeServeur,
  tous: readonly EntreeServeur[],
  o: OptionsRepertoire,
): boolean {
  if (f instanceof AndFilter) return f.filters.every((x) => correspond(x, e, tous, o));
  if (f instanceof OrFilter) return f.filters.some((x) => correspond(x, e, tous, o));
  if (f instanceof NotFilter) return !correspond(f.filter, e, tous, o);
  if (f instanceof PresenceFilter) return valeursDe(e, f.attribute).length > 0;
  if (f instanceof EqualityFilter)
    return valeursDe(e, f.attribute).some((v) => egal(f.attribute, v, f.value, o));
  if (f instanceof SubstringFilter)
    return valeursDe(e, f.attribute).some((v) => {
      const t = plie(texte(v));
      const debut = plie(f.initial ?? "");
      const fin = plie(f.final ?? "");
      if (!t.startsWith(debut) || !t.endsWith(fin)) return false;
      let reste = t.slice(debut.length, t.length - fin.length);
      for (const m of f.any ?? []) {
        const i = reste.indexOf(plie(m));
        if (i < 0) return false;
        reste = reste.slice(i + m.length);
      }
      return true;
    });
  if (f instanceof ExtensibleFilter) {
    if (f.rule === REGLE_CHAINE && o.regleChaine === "supportee")
      return f.matchType.toLowerCase() === "memberof" && dansChaine(tous, e, texte(f.value));
    return false;
  }
  return false;
}

function dansLaPortee(e: EntreeServeur, base: string, portee: number): boolean {
  const dn = dnPlie(e.dn);
  const b = dnPlie(base);
  if (portee === 0) return dn === b;
  const sous = dn.endsWith(`,${b}`);
  if (portee === 1) return sous && !dn.slice(0, dn.length - b.length - 1).includes(",");
  return dn === b || sous;
}

function projeter(e: EntreeServeur, demandes: readonly string[], o: OptionsRepertoire): EntreeServeur {
  const construits = new Set(o.construits ?? []);
  const attrs: Record<string, readonly (string | Buffer)[]> = {};
  const toutes = demandes.length === 0 || demandes.includes("*");
  const nommes = new Set(demandes.map((d) => d.toLowerCase()));
  for (const [nom, vals] of Object.entries(e.attrs)) {
    const n = nom.toLowerCase();
    const voulu = nommes.has(n) || (toutes && !construits.has(n) && n !== "1.1");
    if (!voulu || demandes.includes("1.1")) continue;
    if (n === "member" && o.plageMembres !== undefined && vals.length > o.plageMembres && nommes.has(n)) {
      attrs[`${nom};range=0-${o.plageMembres - 1}`] = vals.slice(0, o.plageMembres);
      continue;
    }
    attrs[nom] = vals;
  }
  return { dn: e.dn, attrs };
}

/** Évaluateur de recherche sur une liste d'entrées, à poser dans `comportement.rechercher`. */
export function creerRepertoire(
  entrees: readonly EntreeServeur[],
  o: OptionsRepertoire = {},
): (d: DemandeRecherche) => ReponseRecherche {
  return (d) => {
    const imposee = o.interception?.(d);
    if (imposee !== null && imposee !== undefined) return imposee;
    if (d.base === "")
      return {
        elements: o.racineDse === undefined ? [] : [{ entree: projeter(o.racineDse, d.attributs, o) }],
        code: 0,
      };
    if (!entrees.some((e) => dnPlie(e.dn) === dnPlie(d.base))) return { elements: [], code: 32 };
    if (d.filtreTexte.includes(REGLE_CHAINE) && o.regleChaine === "erreur") return { elements: [], code: 53 };
    const trouvees = entrees.filter(
      (e) => dansLaPortee(e, d.base, d.portee) && correspond(d.filtre, e, entrees, o),
    );
    if (d.portee === 0 && trouvees.length === 0 && o.baseSansCorrespondance !== undefined)
      return { elements: [], code: o.baseSansCorrespondance };
    const plafond = Math.min(d.limite > 0 ? d.limite : Infinity, o.limiteServeur ?? Infinity);
    const gardees = trouvees.slice(0, plafond);
    const elements: ElementRecherche[] = gardees.map((e) => ({ entree: projeter(e, d.attributs, o) }));
    const r = o.renvoisRacine;
    if (r !== undefined && d.portee === 2 && dnPlie(d.base) === dnPlie(r.racine)) {
      const renvois: ElementRecherche = { renvois: r.uris };
      if (r.avant === true) elements.unshift(renvois);
      else elements.push(renvois);
    }
    return { elements, code: trouvees.length > plafond ? 4 : 0 };
  };
}
