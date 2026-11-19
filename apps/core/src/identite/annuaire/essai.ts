// SPDX-License-Identifier: MIT
/** apps/core/src/identite/annuaire/essai.ts — étapes du test d'un annuaire (liaison de service, base, groupes, utilisateur d'essai cherché sans jamais être lié, horloge) rendues en phrases fixes, jamais un message du serveur. */
import { etape, PHRASES_SORTANT } from "../etapes";
import type { EtapeEssai } from "../etapes";
import { cleIdentifiant } from "../cle-identifiant";
import { nomDerive } from "../nom";
import { BORNES_AUTH, hotePortLdaps } from "../reglages";
import type { FournisseurLdap } from "../reglages";
import { appartient, groupeExiste } from "./appartenance";
import { MOT_DE_PASSE_MAX_OCTETS } from "./client";
import type { ConnexionAnnuaire, EntreeAnnuaire, FabriqueConnexion } from "./client";
import { chercherUtilisateur, cleStable, etatEntree, profilExterne, tempsGeneralise } from "./entree";
import { ErreurAnnuaire } from "./erreur";
import { IDENTIFIANT_MAX } from "./filtre";
import { presetDe } from "./presets";

const ECART_HORLOGE_MAX_S = 60;
const TOUS_LES_OBJETS = "(objectClass=*)";
const SANS_ATTRIBUT = ["1.1"] as const;
const JETON_GROUPE = /^\d{1,10}$/u;
const CODE_OBJET_INEXISTANT = 32;
const CODE_DROITS_INSUFFISANTS = 50;

export interface DemandeEssaiAnnuaire {
  /** Fabrique de connexions soumise à l'échéance et au juge d'adresses du test. */
  readonly fabrique: FabriqueConnexion;
  /** Secret enregistré, `null` s'il est absent ou hors de la portée des adresses de ces réglages. */
  readonly secretEnregistre: (f: FournisseurLdap) => Promise<string | null>;
  /** Identifiant de l'utilisateur d'essai tel que reçu (absent, vide ou invalide : voir l'étape). */
  readonly utilisateur: unknown;
  /** Secret saisi pour ce test seul, tel que reçu. */
  readonly secret: unknown;
  /** Limite des échecs de liaison du compte de service, par DN visé. */
  readonly limiteur: LimiteurLiaison;
  /** Appelée avec le secret réellement employé (saisi ou enregistré), juste avant la liaison. */
  readonly secretEmploye?: (origine: "typed" | "stored", valeur: string) => void;
  /** Secondes. */
  readonly maintenant: () => number;
  readonly signal: AbortSignal;
}

export interface LimiteurLiaison {
  /** Vrai si ce DN a trop échoué récemment : aucune connexion n'est alors tentée. */
  refuse(dn: string): Promise<boolean>;
  echec(dn: string): Promise<void>;
  succes(dn: string): Promise<void>;
}

type Verdict = { level: EtapeEssai["level"]; detail: string };

/** Phrase fixe d'une erreur d'annuaire ; une autre erreur est propagée. */
function phrase(e: unknown, bind = false): string {
  if (!(e instanceof ErreurAnnuaire)) throw e;
  if (e.nature === "identifiants")
    return bind
      ? "L'annuaire refuse le compte de service : vérifiez l'identifiant de liaison et le secret."
      : "L'annuaire refuse cette demande.";
  if (e.nature === "injoignable")
    return e.sortant === null ? "L'annuaire ne répond pas." : PHRASES_SORTANT[e.sortant];
  if (e.nature === "configuration")
    return "Un réglage est inutilisable pour cette recherche : vérifiez les DN, le filtre et les attributs.";
  if (e.code === CODE_OBJET_INEXISTANT) return "Cet objet n'existe pas dans l'annuaire.";
  if (e.code === CODE_DROITS_INSUFFISANTS) return "Le compte de service n'a pas le droit de le lire.";
  return e.code === null
    ? "La réponse de l'annuaire est illisible."
    : `L'annuaire refuse la recherche (code ${e.code}).`;
}

function secretSaisiValide(v: unknown): v is string {
  return (
    typeof v === "string" &&
    v.length <= BORNES_AUTH.secret_max &&
    v.isWellFormed() &&
    !v.includes("\0") &&
    Buffer.byteLength(v) <= MOT_DE_PASSE_MAX_OCTETS
  );
}

function identifiantValide(v: unknown): v is string {
  return typeof v === "string" && v.length <= IDENTIFIANT_MAX && v.isWellFormed() && !/\p{Cc}/u.test(v);
}

/** Valeur venue de l'annuaire sans caractère de contrôle (Cc) ni de format (Cf : marques de direction, largeur nulle). */
function dnTexte(dn: string): string {
  return dn.replace(/[\p{Cc}\p{Cf}]/gu, "");
}

async function existe(cnx: ConnexionAnnuaire, base: string): Promise<boolean> {
  const r = await cnx.chercher(base, {
    portee: "base",
    filtre: TOUS_LES_OBJETS,
    attributs: SANS_ATTRIBUT,
    limite: 1,
  });
  return r.length > 0;
}

/** Jeton de groupe principal lisible sur le groupe (`primaryGroupToken`), `null` s'il ne l'est pas. */
async function jetonDeGroupe(cnx: ConnexionAnnuaire, groupe: string): Promise<string | null> {
  const [e] = await cnx.chercher(groupe, {
    portee: "base",
    filtre: TOUS_LES_OBJETS,
    attributs: ["primaryGroupToken"],
    limite: 1,
  });
  const v = e?.attrs["primarygrouptoken"]?.[0];
  return typeof v === "string" && JETON_GROUPE.test(v) ? v : null;
}

/** Groupes requis : existence puis, pour Active Directory, refus d'un groupe principal d'utilisateurs. */
async function verifierGroupes(cnx: ConnexionAnnuaire, f: FournisseurLdap): Promise<Verdict> {
  if (f.required_groups.length === 0)
    return { level: "fail", detail: "Aucun groupe requis : renseignez au moins un groupe." };
  const absents: string[] = [];
  for (const g of f.required_groups) if (!(await groupeExiste(cnx, g))) absents.push(dnTexte(g));
  if (absents.length > 0)
    return { level: "fail", detail: `Groupe requis introuvable : ${absents.join(" ; ")}.` };
  if (presetDe(f.preset)?.famille !== "active-directory")
    return { level: "ok", detail: `${f.required_groups.length} groupe(s) requis trouvé(s).` };
  const principaux: string[] = [];
  let illisibles = 0;
  for (const g of f.required_groups) {
    const jeton = await jetonDeGroupe(cnx, g);
    if (jeton === null) {
      illisibles += 1;
      continue;
    }
    const r = await cnx.chercher(f.user_base_dn, {
      portee: "sub",
      filtre: `(primaryGroupID=${jeton})`,
      attributs: SANS_ATTRIBUT,
      limite: 1,
    });
    if (r.length > 0) principaux.push(dnTexte(g));
  }
  if (principaux.length > 0)
    return {
      level: "fail",
      detail: `Groupe principal d'utilisateurs : l'appartenance par groupe principal n'apparaît pas dans l'annuaire, ce groupe n'admettrait personne ou tout le monde : ${principaux.join(" ; ")}.`,
    };
  if (illisibles > 0)
    return {
      level: "warn",
      detail: "Groupes trouvés, mais le groupe principal n'a pas pu être vérifié (jeton illisible).",
    };
  return { level: "ok", detail: `${f.required_groups.length} groupe(s) requis trouvé(s).` };
}

/** Appartenance de l'entrée aux groupes requis : une seule suffit ; hors de tous, avertissement. */
async function verifierAppartenance(
  cnx: ConnexionAnnuaire,
  f: FournisseurLdap,
  entree: EntreeAnnuaire,
): Promise<Verdict> {
  const oui: string[] = [];
  const non: string[] = [];
  for (const g of f.required_groups) ((await appartient(cnx, f, entree, g)) ? oui : non).push(dnTexte(g));
  const detail = `Membre : ${oui.join(" ; ") || "aucun"}. Non membre : ${non.join(" ; ") || "aucun"}.`;
  return oui.length > 0
    ? { level: "ok", detail }
    : {
        level: "warn",
        detail: `Cet utilisateur n'est dans aucun groupe requis : il ne pourrait pas se connecter. ${detail}`,
      };
}

function verifierProfil(entree: EntreeAnnuaire, f: FournisseurLdap): Verdict {
  const p = profilExterne(entree, f);
  const identifiant = dnTexte(p.identifiant);
  const nom = nomDerive(p.identifiant);
  if (nom === null)
    return {
      level: "fail",
      detail: `Aucun nom Elpis ne peut être dérivé de l'identifiant « ${identifiant} » (attribut ${f.attrs.username}) : il est vide, invalide ou réservé.`,
    };
  return {
    level: "ok",
    detail: `Identifiant d'annuaire : ${identifiant}. Nom Elpis : ${dnTexte(nom)}. Nom affiché : ${dnTexte(p.nom) || "(aucun)"}. E-mail : ${dnTexte(p.email) || "(aucun)"}.`,
  };
}

/** Entrée de l'utilisateur d'essai (recherche seule) : unique, clé stable lisible, état lisible. */
async function verifierEntree(
  cnx: ConnexionAnnuaire,
  f: FournisseurLdap,
  identifiant: string,
  maintenantMs: number,
): Promise<{ verdict: Verdict; entree: EntreeAnnuaire | null }> {
  const trouve = await chercherUtilisateur(cnx, f, identifiant);
  if (trouve === "absent")
    return {
      verdict: { level: "fail", detail: "Aucun utilisateur ne correspond à cet identifiant dans la base." },
      entree: null,
    };
  if (trouve === "ambigu")
    return {
      verdict: {
        level: "fail",
        detail: "Plusieurs utilisateurs correspondent à cet identifiant : affinez le filtre.",
      },
      entree: null,
    };
  try {
    cleStable(trouve, f);
  } catch (e) {
    if (!(e instanceof ErreurAnnuaire)) throw e;
    return {
      verdict: {
        level: "fail",
        detail: `La clé stable de l'entrée (attribut ${f.attrs.id}) est absente, multiple ou illisible : le compte de service doit pouvoir la lire.`,
      },
      entree: null,
    };
  }
  const etat = etatEntree(trouve, f, maintenantMs);
  if (etat === "inconnu") {
    const attributs = presetDe(f.preset)?.attributsEtat.join(", ") ?? "";
    const sansDate =
      presetDe(f.preset)?.famille === "freeipa" &&
      (trouve.attrs["krbpasswordexpiration"] ?? []).length === 0 &&
      (trouve.attrs["krblastpwdchange"] ?? []).length === 0;
    return {
      verdict: {
        level: "fail",
        detail: sansDate
          ? "L'expiration du mot de passe n'est pas lisible pour cet utilisateur : le compte de service doit pouvoir lire krbPasswordExpiration et krbLastPwdChange."
          : `L'état du compte n'est pas lisible : le compte de service doit pouvoir lire ${attributs}.`,
      },
      entree: null,
    };
  }
  const detail = `Entrée unique trouvée : ${dnTexte(trouve.dn)}. Clé stable lisible.`;
  const libelle = {
    active: "actif",
    desactivee: "désactivé",
    verrouillee: "verrouillé",
    expiree: "mot de passe expiré",
  };
  const admis =
    cleIdentifiant(identifiant) !== null && cleIdentifiant(profilExterne(trouve, f).identifiant) !== null;
  return {
    verdict: {
      level: etat === "active" && admis ? "ok" : "warn",
      detail: `${detail} Compte ${libelle[etat]}.${admis ? "" : " Cet identifiant contient des caractères qu'Elpis n'accepte pas à la connexion."}`,
    },
    entree: trouve,
  };
}

/** Écart d'horloge d'après le rootDSE ; `null` si l'annuaire n'expose pas son heure ou refuse la lecture. */
async function horlogeAnnuaire(cnx: ConnexionAnnuaire, maintenantMs: number): Promise<Verdict | null> {
  let e: EntreeAnnuaire | undefined;
  try {
    [e] = await cnx.chercher("", {
      portee: "base",
      filtre: TOUS_LES_OBJETS,
      attributs: ["currentTime"],
      limite: 1,
    });
  } catch (err) {
    if (!(err instanceof ErreurAnnuaire)) throw err;
    return null;
  }
  const v = e?.attrs["currenttime"]?.[0];
  if (v === undefined) return null;
  const t = typeof v === "string" ? tempsGeneralise(v) : null;
  if (t === null)
    return { level: "warn", detail: "L'heure annoncée par l'annuaire est illisible : écart non mesuré." };
  const ecart = Math.round((t - maintenantMs) / 1000);
  return {
    level: Math.abs(ecart) > ECART_HORLOGE_MAX_S ? "warn" : "ok",
    detail: `Écart de ${ecart} s avec l'annuaire (au-delà de ${ECART_HORLOGE_MAX_S} s, les certificats et les mots de passe expirés se jugent mal).`,
  };
}

/** Étapes LDAP sur l'adresse `url` ; vrai seulement si aucune n'a échoué et qu'un utilisateur d'essai a été vérifié. */
export async function etapesAnnuaire(
  etapes: EtapeEssai[],
  f: FournisseurLdap,
  url: string,
  d: DemandeEssaiAnnuaire,
): Promise<boolean> {
  const cible = hotePortLdaps(url);
  let echec = false;
  const poser = (id: string, label: string, v: Verdict): void => {
    if (v.level === "fail") echec = true;
    etapes.push(etape(id, label, v.level, v.detail, cible));
  };
  const saisi = d.secret;
  let secret: string | null;
  let origine = "enregistré";
  let provenance: "typed" | "stored" = "stored";
  if (saisi !== undefined && saisi !== null && saisi !== "") {
    secret = secretSaisiValide(saisi) ? saisi : null;
    origine = "saisi";
    provenance = "typed";
    if (secret === null) {
      poser("service_bind", "Compte de service", {
        level: "fail",
        detail: "Le secret saisi est invalide : ressaisissez-le.",
      });
      return false;
    }
  } else {
    secret = await d.secretEnregistre(f);
    if (secret === null) {
      poser("service_bind", "Compte de service", {
        level: "fail",
        detail:
          "Le secret du compte de service est absent ou ne couvre pas ces réglages : ressaisissez le secret.",
      });
      return false;
    }
  }
  d.signal.throwIfAborted();
  if (await d.limiteur.refuse(f.bind_dn)) {
    poser("service_bind", "Compte de service", {
      level: "fail",
      detail: "Trop d'échecs de liaison pour ce compte de service : réessayez dans quelques minutes.",
    });
    return false;
  }
  d.secretEmploye?.(provenance, secret);
  let cnx: ConnexionAnnuaire | null = null;
  const fermer = (): void => void cnx?.fermer();
  d.signal.addEventListener("abort", fermer, { once: true });
  try {
    try {
      cnx = await d.fabrique(f, url);
      if (d.signal.aborted) fermer();
      await cnx.lier(f.bind_dn, secret);
    } catch (e) {
      if (e instanceof ErreurAnnuaire && e.nature === "identifiants") await d.limiteur.echec(f.bind_dn);
      d.signal.throwIfAborted();
      poser("service_bind", "Compte de service", { level: "fail", detail: phrase(e, true) });
      return false;
    }
    await d.limiteur.succes(f.bind_dn);
    poser("service_bind", "Compte de service", {
      level: "ok",
      detail: `Liaison du compte de service acceptée (secret ${origine}).`,
    });
    const jouer = async (id: string, label: string, fn: () => Promise<Verdict | null>): Promise<boolean> => {
      d.signal.throwIfAborted();
      try {
        const v = await fn();
        if (v !== null) poser(id, label, v);
        return true;
      } catch (e) {
        d.signal.throwIfAborted();
        poser(id, label, { level: "fail", detail: phrase(e) });
        return !(e instanceof ErreurAnnuaire && e.nature === "injoignable");
      }
    };
    const connexion = cnx;
    const maintenantMs = (): number => d.maintenant() * 1000;
    const suite = await jouer("user_base", "Base des utilisateurs", async () =>
      (await existe(connexion, f.user_base_dn))
        ? { level: "ok", detail: `Base des utilisateurs trouvée : ${dnTexte(f.user_base_dn)}.` }
        : {
            level: "fail",
            detail: "La base des utilisateurs n'existe pas ou n'est pas lisible par le compte de service.",
          },
    );
    if (suite && (await jouer("groups", "Groupes requis", () => verifierGroupes(connexion, f)))) {
      let complet = false;
      const identifiant = d.utilisateur;
      if (identifiant === undefined || identifiant === null || identifiant === "")
        poser("test_user", "Utilisateur d'essai", {
          level: "warn",
          detail:
            "Indiquez un utilisateur d'essai : sans lui, le test reste incomplet et l'annuaire ne peut pas être activé.",
        });
      else if (!identifiantValide(identifiant))
        poser("test_user", "Utilisateur d'essai", { level: "fail", detail: "Identifiant d'essai invalide." });
      else {
        const lue: { entree: EntreeAnnuaire | null } = { entree: null };
        const encore = await jouer("test_user", "Utilisateur d'essai", async () => {
          const r = await verifierEntree(connexion, f, identifiant, maintenantMs());
          lue.entree = r.entree;
          return r.verdict;
        });
        const trouvee = lue.entree;
        if (trouvee !== null && encore) {
          const lu = await jouer("test_user_groups", "Groupes de l'utilisateur d'essai", () =>
            verifierAppartenance(connexion, f, trouvee),
          );
          if (lu)
            await jouer("test_user_profile", "Profil de l'utilisateur d'essai", () =>
              Promise.resolve(verifierProfil(trouvee, f)),
            );
        }
        complet = true;
      }
      await jouer("clock", "Horloge de l'annuaire", () => horlogeAnnuaire(connexion, maintenantMs()));
      return !echec && complet;
    }
    return false;
  } finally {
    d.signal.removeEventListener("abort", fermer);
    await cnx?.fermer();
  }
}
