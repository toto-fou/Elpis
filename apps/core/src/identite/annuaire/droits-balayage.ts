// SPDX-License-Identifier: MIT
/** apps/core/src/identite/annuaire/droits-balayage.ts — fin d'une passe aboutie : les comptes vus présents sont relus, rétrogradation et retrait de groupe seulement sur une appartenance lue, jamais une montée ni un ajout. */
import { droitsActifs } from "../correspondance";
import { appliquerDroits } from "../droits";
import { ancreIdentite } from "../ancre";
import type { FournisseurLdap } from "../reglages";
import type { DependancesBalayage } from "./balayage";
import type { EntreeAnnuaire } from "./client";
import { ouvrirService } from "./connexion";
import { groupesSansMembreVisible, lireDroitsAnnuaire } from "./droits-annuaire";
import type { CacheGroupes } from "./droits-annuaire";
import { attributsUtilisateur, cleStable } from "./entree";
import { ErreurAnnuaire } from "./erreur";
import { filtreEgal } from "./filtre";

export const DELAI_DROITS_MS = 120_000;

export interface IdentitePresente {
  readonly user_id: number;
  readonly subject: string;
  readonly issuer: string;
}

export interface BilanDroitsBalayage {
  readonly roles: number;
  readonly groupes: number;
}

async function entreeDeLaCle(
  cnx: Parameters<typeof lireDroitsAnnuaire>[0],
  f: FournisseurLdap,
  sujet: string,
): Promise<EntreeAnnuaire | null> {
  const binaire = f.attrs.id.toLowerCase() === "objectguid";
  const trouvees = await cnx.chercher(f.user_base_dn, {
    portee: "sub",
    filtre: filtreEgal(f.attrs.id, binaire ? Buffer.from(sujet, "hex") : sujet),
    attributs: attributsUtilisateur(f),
    limite: 2,
    sansLimiteServeur: true,
  });
  const [premiere] = trouvees;
  if (trouvees.length !== 1 || premiere === undefined) return null;
  try {
    return cleStable(premiere, f) === sujet ? premiere : null;
  } catch (e) {
    if (e instanceof ErreurAnnuaire) return null;
    throw e;
  }
}

/** Relit l'appartenance de chaque identité présente par le compte de service et rétrograde ou retire ce que l'annuaire ne donne plus ; tout échec est journalisé et laisse les comptes tels quels. */
export async function synchroniserDroitsBalayage(
  dep: Pick<DependancesBalayage, "base" | "fabrique" | "maintenant" | "journal" | "etat">,
  f: FournisseurLdap,
  identites: readonly IdentitePresente[],
  secret: string,
): Promise<BilanDroitsBalayage> {
  const bilan = { roles: 0, groupes: 0 };
  if (!droitsActifs(f) || identites.length === 0) return bilan;
  const ancre = ancreIdentite(f);
  const fin = performance.now() + DELAI_DROITS_MS;
  let service: Awaited<ReturnType<typeof ouvrirService>> | null = null;
  try {
    service = await ouvrirService(dep, f, secret);
    const privilegies = new Set(
      (await dep.base.valeurs<[unknown]>("SELECT id FROM users WHERE is_admin IN (1, 2)")).map(([i]) =>
        Number(i),
      ),
    );
    const ordre = identites
      .filter((l) => l.issuer === ancre)
      .sort(
        (x, y) => Number(privilegies.has(Number(y.user_id))) - Number(privilegies.has(Number(x.user_id))),
      );
    const cache: CacheGroupes = new Map();
    let relus = 0;
    for (const l of ordre) {
      if (performance.now() > fin) {
        dep.journal.warn(
          `annuaire ${f.id} : rôles et groupes non relus en entier, délai dépassé, ${ordre.length - relus} compte(s) non relu(s)`,
        );
        break;
      }
      relus++;
      try {
        const entree = await entreeDeLaCle(service.cnx, f, l.subject);
        if (entree === null) continue;
        const lecture = await lireDroitsAnnuaire(service.cnx, f, entree, cache);
        const r = await appliquerDroits(
          { ...dep, revoquer: (uid) => dep.etat.publierSuspension(uid) },
          { fournisseur: f, uid: Number(l.user_id), lecture, mode: "passe" },
        );
        if (r.role !== null) bilan.roles++;
        if (r.retires.length > 0) bilan.groupes++;
      } catch (e) {
        if (!(e instanceof ErreurAnnuaire)) throw e;
        dep.journal.warn(`annuaire ${f.id} : appartenance d'un compte illisible, compte laissé tel quel`);
        if (e.nature === "injoignable") break;
      }
    }
    for (const g of await groupesSansMembreVisible(cache))
      dep.journal.warn(
        `annuaire ${f.id} : aucun membre visible dans un groupe de rôles ou de correspondance, rôles et groupes non modifiés (${g.replace(/[\p{Cc}\p{Cf}]/gu, "")})`,
      );
  } catch (e) {
    dep.journal.warn({ err: e }, `annuaire ${f.id} : synchronisation des rôles et groupes interrompue`);
  } finally {
    await service?.cnx.fermer();
  }
  return bilan;
}
