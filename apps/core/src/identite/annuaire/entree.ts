// SPDX-License-Identifier: MIT
/** apps/core/src/identite/annuaire/entree.ts — recherche de l'entrée d'un utilisateur, clé stable, état (actif, verrouillé, expiré) et profil affichable d'une entrée d'annuaire. */
import type { FournisseurLdap } from "../reglages";
import type { ConnexionAnnuaire, EntreeAnnuaire } from "./client";
import { ErreurAnnuaire } from "./erreur";
import { rendreFiltre } from "./filtre";
import { presetDe } from "./presets";

/** `desactivee` : fermée par un administrateur de l'annuaire (la personne est partie) ; `verrouillee` : verrou temporaire après des échecs. */
export type EtatEntree = "active" | "desactivee" | "verrouillee" | "expiree" | "inconnu";
export interface ProfilExterne {
  readonly identifiant: string;
  readonly nom: string;
  readonly email: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const CLE_LIBRE = /^[^\p{Cc}\s]{1,128}$/u;
const TEMPS_GENERALISE = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(?:[.,]\d+)?Z$/u;
const ENTIER = /^\d{1,10}$/u;
const CONTROLE = /\p{Cc}/gu;
const UAC_DESACTIVE = 0x2;
const UAC_VERROUILLE = 0x10;
const UAC_MOT_DE_PASSE_EXPIRE = 0x800000;
const IDENTIFIANT_PROFIL_MAX = 256;
const NOM_PROFIL_MAX = 256;
const EMAIL_PROFIL_MAX = 320;

function valeurs(entree: EntreeAnnuaire, nom: string): readonly (string | Buffer)[] {
  return entree.attrs[nom.toLowerCase()] ?? [];
}

/** Attributs à demander pour l'identité et l'état, sans doublon (casse ignorée). */
export function attributsUtilisateur(fournisseur: FournisseurLdap): string[] {
  const etat = presetDe(fournisseur.preset)?.attributsEtat ?? [];
  const tous = [
    fournisseur.attrs.id,
    fournisseur.attrs.username,
    fournisseur.attrs.email,
    fournisseur.attrs.name,
    ...etat,
  ];
  return tous.filter((a, i) => tous.findIndex((b) => b.toLowerCase() === a.toLowerCase()) === i);
}

/** Entrée de l'identifiant tapé (deux résultats au plus lus) : l'entrée, `"absent"` ou `"ambigu"` ; toute erreur d'annuaire est propagée. */
export async function chercherUtilisateur(
  cnx: ConnexionAnnuaire,
  fournisseur: FournisseurLdap,
  identifiant: string,
): Promise<EntreeAnnuaire | "absent" | "ambigu"> {
  const trouvees = await cnx.chercher(fournisseur.user_base_dn, {
    portee: "sub",
    filtre: rendreFiltre(fournisseur.user_filter, identifiant),
    attributs: attributsUtilisateur(fournisseur),
    limite: 2,
  });
  if (trouvees.length === 0) return "absent";
  const [premiere] = trouvees;
  return trouvees.length === 1 && premiere !== undefined ? premiere : "ambigu";
}

/** Clé stable canonique (UUID en minuscules, `objectGUID` en 16 octets hexadécimaux) ; absente, vide, multiple ou mal formée : erreur, jamais de repli sur le DN, l'e-mail ou le nom. */
export function cleStable(entree: EntreeAnnuaire, fournisseur: FournisseurLdap): string {
  const nom = fournisseur.attrs.id.toLowerCase();
  const v = valeurs(entree, nom);
  const brute = v[0];
  if (v.length !== 1 || brute === undefined) throw new ErreurAnnuaire("configuration");
  if (nom === "objectguid") {
    if (!Buffer.isBuffer(brute) || brute.length !== 16) throw new ErreurAnnuaire("configuration");
    return brute.toString("hex");
  }
  if (typeof brute !== "string") throw new ErreurAnnuaire("configuration");
  const cle = brute.toLowerCase();
  const valide = nom === "ipauniqueid" || nom === "entryuuid" ? UUID.test(cle) : CLE_LIBRE.test(cle);
  if (!valide) throw new ErreurAnnuaire("configuration");
  return cle;
}

type Lu<T> = { v: T } | "invalide";

function uneChaine(entree: EntreeAnnuaire, nom: string): Lu<string | null> {
  const v = valeurs(entree, nom);
  if (v.length === 0) return { v: null };
  const x = v[0];
  return v.length === 1 && typeof x === "string" ? { v: x } : "invalide";
}

function tempsGeneralise(texte: string): number | null {
  const m = TEMPS_GENERALISE.exec(texte);
  if (m === null) return null;
  const [a, mo, j, h, mi, s] = m.slice(1).map(Number) as [number, number, number, number, number, number];
  const ms = Date.UTC(a, mo - 1, j, h, mi, s);
  const d = new Date(ms);
  const coherent = d.getUTCFullYear() === a && d.getUTCMonth() === mo - 1 && d.getUTCDate() === j;
  return coherent && h < 24 && mi < 60 && s < 61 ? ms : null;
}

function etatFreeipa(entree: EntreeAnnuaire, maintenant: number): EtatEntree {
  const verrou = uneChaine(entree, "nsAccountLock");
  const expiration = uneChaine(entree, "krbPasswordExpiration");
  const verrouille = verrou !== "invalide" && verrou.v?.toLowerCase() === "true";
  if (verrouille) return "desactivee";
  const verrouOk = verrou !== "invalide" && (verrou.v === null || verrou.v.toLowerCase() === "false");
  if (!verrouOk || expiration === "invalide") return "inconnu";
  const fin = expiration.v === null ? null : tempsGeneralise(expiration.v);
  if (fin === null) return "inconnu";
  return fin <= maintenant ? "expiree" : "active";
}

function drapeaux(entree: EntreeAnnuaire, nom: string): number | null {
  const l = uneChaine(entree, nom);
  if (l === "invalide" || l.v === null || !ENTIER.test(l.v)) return null;
  const n = Number(l.v);
  return n <= 0xffff_ffff ? n : null;
}

function etatAd(entree: EntreeAnnuaire): EtatEntree {
  const uac = drapeaux(entree, "userAccountControl");
  const calcule = drapeaux(entree, "msDS-User-Account-Control-Computed");
  if (uac === null || calcule === null) return "inconnu";
  if ((uac & UAC_DESACTIVE) !== 0) return "desactivee";
  if ((calcule & UAC_VERROUILLE) !== 0) return "verrouillee";
  return (calcule & UAC_MOT_DE_PASSE_EXPIRE) !== 0 ? "expiree" : "active";
}

/** État de l'entrée selon le préréglage enregistré ; un attribut d'état illisible rend `"inconnu"`, jamais `"active"`. `maintenant` en millisecondes. */
export function etatEntree(
  entree: EntreeAnnuaire,
  fournisseur: FournisseurLdap,
  maintenant: number,
): EtatEntree {
  const famille = presetDe(fournisseur.preset)?.famille ?? "aucune";
  if (famille === "freeipa") return etatFreeipa(entree, maintenant);
  return famille === "active-directory" ? etatAd(entree) : "active";
}

function premiereChaine(entree: EntreeAnnuaire, nom: string, max: number): string {
  const v = valeurs(entree, nom)[0];
  return typeof v === "string" ? v.replace(CONTROLE, "").trim().slice(0, max) : "";
}

/** Identifiant, nom affiché et e-mail de l'entrée : premières valeurs, tailles bornées, caractères de contrôle retirés. */
export function profilExterne(entree: EntreeAnnuaire, fournisseur: FournisseurLdap): ProfilExterne {
  return {
    identifiant: premiereChaine(entree, fournisseur.attrs.username, IDENTIFIANT_PROFIL_MAX),
    nom: premiereChaine(entree, fournisseur.attrs.name, NOM_PROFIL_MAX),
    email: premiereChaine(entree, fournisseur.attrs.email, EMAIL_PROFIL_MAX),
  };
}
