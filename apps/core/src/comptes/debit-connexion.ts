// SPDX-License-Identifier: MIT
/** apps/core/src/comptes/debit-connexion.ts — essais de connexion par (nom, adresse) et par adresse : seaux à jetons en mémoire du process, pris avant tout PBKDF2. */
import { createHash } from "node:crypto";

interface Regle {
  readonly capacite: number;
  readonly rechargeS: number;
}

interface Seau {
  jetons: number;
  temps: number;
}

export const PAR_NOM_ET_ADRESSE: Regle = { capacite: 8, rechargeS: 300 };
export const PAR_ADRESSE: Regle = { capacite: 50, rechargeS: 15 };
export const SEAUX_MAX = 10_000;
const MENAGE_S = 60;

/** Un essai en cours : jetons pris, à rendre s'il réussit ou s'il n'a rien vérifié. */
export interface Essai {
  readonly cleNom: string;
  readonly cleAdresse: string;
  /** Attente avant de répondre à un échec. */
  readonly delaiMs: number;
  /** Plus de jeton pour l'essai suivant. */
  readonly epuise: boolean;
}

function empreinte(texte: string): string {
  return createHash("sha256").update(texte).digest("base64");
}

function delaiEchecMs(part: number): number {
  if (part < 3 / 8) return 0;
  if (part < 1 / 2) return 500;
  return part < 5 / 8 ? 1000 : 2000;
}

class Seaux {
  private readonly lignes = new Map<string, Seau>();
  private readonly regle: Regle;
  private dernierMenage = 0;

  constructor(regle: Regle) {
    this.regle = regle;
  }

  get taille(): number {
    return this.lignes.size;
  }

  private niveau(seau: Seau | undefined, t: number): number {
    if (seau === undefined) return this.regle.capacite;
    const recharge = Math.max(0, t - seau.temps) / this.regle.rechargeS;
    return Math.min(this.regle.capacite, seau.jetons + recharge);
  }

  /** Secondes avant le prochain jeton ; 0 s'il y en a un. */
  attenteS(cle: string, t: number): number {
    const niveau = this.niveau(this.lignes.get(cle), t);
    return niveau >= 1 ? 0 : (1 - niveau) * this.regle.rechargeS;
  }

  /** Prend un jeton ; rend les jetons restants. */
  prendre(cle: string, t: number): number {
    const jetons = this.niveau(this.lignes.get(cle), t) - 1;
    this.lignes.delete(cle);
    this.lignes.set(cle, { jetons, temps: t });
    this.borner(t);
    return jetons;
  }

  rendre(cle: string, t: number): void {
    const seau = this.lignes.get(cle);
    if (seau === undefined) return;
    seau.jetons = Math.min(this.regle.capacite, this.niveau(seau, t) + 1);
    seau.temps = t;
  }

  oublier(cle: string): void {
    this.lignes.delete(cle);
  }

  /** Seaux redevenus pleins oubliés chaque minute ; au-delà du plafond, le moins récent part. */
  private borner(t: number): void {
    if (t - this.dernierMenage >= MENAGE_S) {
      this.dernierMenage = t;
      for (const [cle, seau] of this.lignes)
        if (this.niveau(seau, t) >= this.regle.capacite) this.lignes.delete(cle);
    }
    for (const cle of this.lignes.keys()) {
      if (this.lignes.size <= SEAUX_MAX) break;
      this.lignes.delete(cle);
    }
  }
}

export class DebitConnexion {
  private readonly noms = new Seaux(PAR_NOM_ET_ADRESSE);
  private readonly adresses = new Seaux(PAR_ADRESSE);

  /** Seaux gardés, pour contrôle. */
  get taille(): number {
    return this.noms.taille + this.adresses.taille;
  }

  /** Secondes d'attente avant un nouvel essai ; 0 s'il est permis (aucun jeton pris). */
  attenteS(nom: string, adresse: string, t: number): number {
    return Math.max(
      this.noms.attenteS(empreinte(`${adresse}\0${nom}`), t),
      this.adresses.attenteS(empreinte(adresse), t),
    );
  }

  /** Compte l'essai dès son arrivée : des requêtes simultanées voient chacune le jeton de la précédente. */
  prendre(nom: string, adresse: string, t: number): Essai {
    const cleNom = empreinte(`${adresse}\0${nom}`);
    const cleAdresse = empreinte(adresse);
    const resteNom = this.noms.prendre(cleNom, t);
    const resteAdresse = this.adresses.prendre(cleAdresse, t);
    const part = Math.max(
      1 - resteNom / PAR_NOM_ET_ADRESSE.capacite,
      1 - resteAdresse / PAR_ADRESSE.capacite,
    );
    return { cleNom, cleAdresse, delaiMs: delaiEchecMs(part), epuise: resteNom < 1 || resteAdresse < 1 };
  }

  /** Remet le couple (nom, adresse) à neuf ; l'adresse ne récupère que ce jeton : un compte valide n'efface pas les échecs sur les autres noms. */
  reussite(essai: Essai, t: number): void {
    this.noms.oublier(essai.cleNom);
    this.adresses.rendre(essai.cleAdresse, t);
  }

  /** Essai interrompu par une panne : rien n'a été vérifié, rien n'est compté. */
  annulation(essai: Essai, t: number): void {
    this.noms.rendre(essai.cleNom, t);
    this.adresses.rendre(essai.cleAdresse, t);
  }
}
