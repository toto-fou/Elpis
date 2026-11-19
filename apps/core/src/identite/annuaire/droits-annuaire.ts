// SPDX-License-Identifier: MIT
/** apps/core/src/identite/annuaire/droits-annuaire.ts — lecture ciblée de l'appartenance d'une entrée aux groupes des rôles et de la correspondance (DN exact, jamais d'énumération) et étapes du test de l'annuaire qui s'y rapportent. */
import type { Appartenance } from "../provisionnement";
import { decider, droitsActifs, groupesALire, rolesActifs } from "../correspondance";
import type { Lecture, RoleElpis } from "../correspondance";
import type { FournisseurLdap } from "../reglages";
import { appartient, groupeAMembreVisible, groupeExiste } from "./appartenance";
import type { ConnexionAnnuaire, EntreeAnnuaire } from "./client";
import { ErreurAnnuaire } from "./erreur";

const LIBELLE_ROLE: Readonly<Record<RoleElpis, string>> = {
  user: "utilisateur",
  moderator: "modérateur",
  admin: "administrateur",
};

/** État d'un groupe pour le compte de service ; seul « visible » (au moins un membre visible) permet de conclure à un « non ». */
export type EtatGroupe = "visible" | "sans_membre" | "absent" | "illisible";

/** Par groupe, l'état lu une seule fois par connexion de service (une recherche par groupe et par passe, pas par compte). */
export type CacheGroupes = Map<string, Promise<EtatGroupe>>;

function etatDuGroupe(
  cnx: ConnexionAnnuaire,
  f: FournisseurLdap,
  g: string,
  cache: CacheGroupes,
): Promise<EtatGroupe> {
  let r = cache.get(g);
  if (r === undefined) {
    r = (async (): Promise<EtatGroupe> => {
      try {
        if (!(await groupeExiste(cnx, g))) return "absent";
        return (await groupeAMembreVisible(cnx, f, g)) ? "visible" : "sans_membre";
      } catch (e) {
        if (!(e instanceof ErreurAnnuaire)) throw e;
        return "illisible";
      }
    })();
    cache.set(g, r);
  }
  return r;
}

/** Groupes de rôles ou de correspondance dont le compte de service ne voit aucun membre, d'après le cache d'une passe. */
export async function groupesSansMembreVisible(cache: CacheGroupes): Promise<string[]> {
  const r: string[] = [];
  for (const [g, etat] of cache) if ((await etat) === "sans_membre") r.push(g);
  return r;
}

/** Appartenance de l'entrée à chaque groupe à lire : une erreur d'annuaire, un groupe introuvable ou sans membre visible ne valent jamais « non » mais « inconnu ». */
export async function lireDroitsAnnuaire(
  cnx: ConnexionAnnuaire,
  f: FournisseurLdap,
  entree: EntreeAnnuaire,
  cache: CacheGroupes = new Map(),
): Promise<Lecture> {
  const lecture = new Map<string, Appartenance>();
  for (const g of groupesALire(f)) {
    try {
      if (await appartient(cnx, f, entree, g)) lecture.set(g, "oui");
      else lecture.set(g, (await etatDuGroupe(cnx, f, g, cache)) === "visible" ? "non" : "inconnu");
    } catch (e) {
      if (!(e instanceof ErreurAnnuaire)) throw e;
      lecture.set(g, "inconnu");
    }
  }
  return lecture;
}

type Verdict = { level: "ok" | "warn" | "fail"; detail: string };

const propre = (v: string): string => v.replace(/[\p{Cc}\p{Cf}]/gu, "");

/** Étape du test : chaque groupe des rôles et de la correspondance existe (comme les groupes requis) ; `null` si aucune option n'agit. */
export async function verdictGroupesDroits(
  cnx: ConnexionAnnuaire,
  f: FournisseurLdap,
): Promise<Verdict | null> {
  if (!droitsActifs(f)) return null;
  const lus = groupesALire(f);
  const absents: string[] = [];
  for (const g of lus) if (!(await groupeExiste(cnx, g))) absents.push(propre(g));
  if (absents.length > 0)
    return {
      level: "fail",
      detail: `Groupe de rôles ou de correspondance introuvable : ${absents.join(" ; ")}.`,
    };
  const masques: string[] = [];
  for (const g of lus) if (!(await groupeAMembreVisible(cnx, f, g))) masques.push(propre(g));
  if (masques.length > 0)
    return {
      level: "warn",
      detail: `Aucun membre visible dans ce groupe : les rôles ne seront pas modifiés. ${masques.join(" ; ")}.`,
    };
  const admin = rolesActifs(f) && f.roles.admin_groups.length > 0;
  return {
    level: "ok",
    detail: `${lus.length} groupe(s) de rôles ou de correspondance trouvé(s).${admin ? " Les membres des groupes d'administrateurs deviendraient administrateurs d'Elpis." : ""}`,
  };
}

/** Étape du test : rôle et groupes Elpis que l'utilisateur d'essai obtiendrait ; `null` si aucune option n'agit. */
export async function verdictDroitsUtilisateur(
  cnx: ConnexionAnnuaire,
  f: FournisseurLdap,
  entree: EntreeAnnuaire,
): Promise<Verdict | null> {
  if (!droitsActifs(f)) return null;
  const d = decider(f, await lireDroitsAnnuaire(cnx, f, entree));
  if (d === null)
    return {
      level: "warn",
      detail:
        "L'appartenance à un groupe n'a pas pu être lue : aucun rôle ni groupe ne serait modifié à la connexion.",
    };
  const groupes = [...(d.groupes ?? new Map<number, boolean>())]
    .filter(([, membre]) => membre)
    .map(([g]) => g);
  const role = d.role === null ? "inchangé" : LIBELLE_ROLE[d.role];
  const liste = d.groupes === null ? "inchangés" : groupes.length > 0 ? groupes.join(", ") : "aucun";
  return { level: "ok", detail: `Rôle obtenu : ${role}. Groupes Elpis (identifiants) : ${liste}.` };
}
