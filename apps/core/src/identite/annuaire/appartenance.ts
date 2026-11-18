// SPDX-License-Identifier: MIT
/** apps/core/src/identite/annuaire/appartenance.ts — appartenance à un groupe par une recherche de portée base (jamais d'énumération) ; une erreur d'annuaire n'est jamais un « non ». */
import type { FournisseurLdap } from "../reglages";
import type { ConnexionAnnuaire, EntreeAnnuaire } from "./client";
import { DN_MAX } from "./client";
import { ErreurAnnuaire } from "./erreur";
import { filtreEgal } from "./filtre";

const REGLE_CHAINE = "memberOf:1.2.840.113556.1.4.1941:";
const SANS_ATTRIBUT = ["1.1"] as const;
const NO_SUCH_OBJECT = 32;

function dnValide(dn: string): string {
  if (typeof dn !== "string" || dn === "" || dn.length > DN_MAX || dn.includes("\0"))
    throw new ErreurAnnuaire("configuration");
  return dn;
}

/** `true` si l'entrée est membre du groupe (DN exact), `false` si l'annuaire répond « non » ; toute erreur est propagée. */
export async function appartient(
  cnx: ConnexionAnnuaire,
  fournisseur: FournisseurLdap,
  entree: EntreeAnnuaire,
  groupeDn: string,
): Promise<boolean> {
  const groupe = dnValide(groupeDn);
  const utilisateur = dnValide(entree.dn);
  const mode = fournisseur.groups.mode;
  const [base, filtre] =
    mode === "member"
      ? [groupe, `(|${filtreEgal("member", utilisateur)}${filtreEgal("uniqueMember", utilisateur)})`]
      : [utilisateur, filtreEgal(mode === "chain" ? REGLE_CHAINE : "memberOf", groupe)];
  const trouvees = await cnx.chercher(base, { portee: "base", filtre, attributs: SANS_ATTRIBUT, limite: 1 });
  return trouvees.length > 0;
}

/** `true` si l'entrée du groupe existe ; seule la réponse « objet inexistant » vaut `false`, toute autre erreur est propagée. */
export async function groupeExiste(cnx: ConnexionAnnuaire, groupeDn: string): Promise<boolean> {
  try {
    const trouvees = await cnx.chercher(dnValide(groupeDn), {
      portee: "base",
      filtre: "(objectClass=*)",
      attributs: SANS_ATTRIBUT,
      limite: 1,
    });
    return trouvees.length > 0;
  } catch (e) {
    if (e instanceof ErreurAnnuaire && e.nature === "protocole" && e.code === NO_SUCH_OBJECT) return false;
    throw e;
  }
}
