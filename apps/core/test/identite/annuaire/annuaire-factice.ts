// SPDX-License-Identifier: MIT
/** apps/core/test/identite/annuaire/annuaire-factice.ts — annuaire en mémoire derrière une `FabriqueConnexion` : liaisons à usage unique, recherche sans casse, groupes, connexions tracées (aucun réseau). */
import type {
  ConnexionAnnuaire,
  EntreeAnnuaire,
  FabriqueConnexion,
  OptionsRecherche,
} from "../../../src/identite/annuaire/client";
import { ErreurAnnuaire } from "../../../src/identite/annuaire/erreur";

export const BASE = "cn=users,dc=exemple,dc=lan";
export const DN_SERVICE = "uid=svc,cn=users,dc=exemple,dc=lan";
export const MDP_SERVICE = "mot-de-passe-de-service";
export const GROUPE = "cn=elpis,cn=groups,dc=exemple,dc=lan";

export interface Personne {
  uid: string;
  cle: string;
  mdp: string;
  groupes: string[];
  attrs?: Record<string, (string | Buffer)[]>;
}

export interface Trace {
  readonly url: string;
  readonly liaisons: string[];
  ferme: boolean;
}

export class AnnuaireFactice {
  personnes: Personne[] = [];
  groupesLisibles = true;
  injoignable = false;
  urlsInjoignables = new Set<string>();
  /** DN d'utilisateurs dont la liaison n'aboutit pas (délai dépassé). */
  liaisonsSansReponse = new Set<string>();
  pause: Promise<void> | null = null;
  /** Groupes qui existent dans l'annuaire (la recherche d'un autre répond « objet inexistant »). */
  groupesExistants = new Set<string>([GROUPE]);
  /** Clés dont la recherche par clé échoue (erreur de protocole). */
  clesEnErreur = new Set<string>();
  readonly traces: Trace[] = [];
  readonly recherches: string[] = [];

  ajouter(p: Personne): Personne {
    this.personnes.push(p);
    return p;
  }

  dn(p: Personne): string {
    return `uid=${p.uid},${BASE}`;
  }

  /** Liaisons d'utilisateur (autres que le compte de service) reçues. */
  get liaisonsUtilisateur(): string[] {
    return this.traces.flatMap((t) => t.liaisons).filter((dn) => dn !== DN_SERVICE);
  }

  readonly fabrique: FabriqueConnexion = (_f, url) => {
    if (this.injoignable || this.urlsInjoignables.has(url))
      return Promise.reject(new ErreurAnnuaire("injoignable"));
    const trace: Trace = { url, liaisons: [], ferme: false };
    this.traces.push(trace);
    return Promise.resolve(this.connexion(trace));
  };

  private connexion(trace: Trace): ConnexionAnnuaire {
    let lie = false;
    return {
      lier: async (dn, mdp) => {
        if (lie) throw new ErreurAnnuaire("configuration");
        lie = true;
        trace.liaisons.push(dn);
        if (this.pause) await this.pause;
        if (this.injoignable || this.urlsInjoignables.has(trace.url)) throw new ErreurAnnuaire("injoignable");
        if (dn === DN_SERVICE) {
          if (mdp === MDP_SERVICE) return;
          throw new ErreurAnnuaire("identifiants");
        }
        if (this.liaisonsSansReponse.has(dn)) throw new ErreurAnnuaire("injoignable");
        const p = this.personnes.find((x) => this.dn(x) === dn);
        if (p === undefined || p.mdp !== mdp || mdp === "") throw new ErreurAnnuaire("identifiants");
      },
      chercher: (base, o) => Promise.resolve(this.chercher(base, o)),
      fermer: () => {
        trace.ferme = true;
        return Promise.resolve();
      },
    };
  }

  private chercher(base: string, o: OptionsRecherche): EntreeAnnuaire[] {
    this.recherches.push(`${base} ${o.filtre}`);
    const membre = /^\(\|\(member=(.*)\)\(uniqueMember=.*\)\)$/u.exec(o.filtre);
    if (membre !== null) {
      if (!this.groupesLisibles) throw new ErreurAnnuaire("protocole", { code: 50 });
      const p = this.personnes.find((x) => this.dn(x) === membre[1]);
      return p?.groupes.includes(base) ? [{ dn: base, attrs: {} }] : [];
    }
    if (o.filtre === "(objectClass=*)") {
      if (!this.groupesExistants.has(base)) throw new ErreurAnnuaire("protocole", { code: 32 });
      return [{ dn: base, attrs: {} }];
    }
    const cle = /^\((entryUUID|ipaUniqueID|objectGUID)=(.*)\)$/iu.exec(o.filtre);
    if (cle !== null) return base === BASE ? this.parCle((cle[1] ?? "").toLowerCase(), cle[2] ?? "") : [];
    const uid = /^\(uid=(.*)\)$/u.exec(o.filtre);
    if (uid === null || base !== BASE) return [];
    return this.personnes
      .filter((p) => p.uid.toLowerCase() === (uid[1] ?? "").toLowerCase())
      .map((p) => this.entree(p));
  }

  private entree(p: Personne): EntreeAnnuaire {
    return {
      dn: this.dn(p),
      attrs: {
        uid: [p.uid],
        entryuuid: [p.cle],
        ipauniqueid: [p.cle],
        mail: [`${p.uid}@exemple.lan`],
        cn: [`Nom ${p.uid}`],
        ...(p.attrs ?? {}),
      },
    };
  }

  private parCle(attribut: string, valeur: string): EntreeAnnuaire[] {
    const voulu = valeur.replace(/\\([0-9a-f]{2})/giu, "$1").toLowerCase();
    const trouvees = this.personnes
      .map((p) => ({ p, e: this.entree(p) }))
      .filter(({ e }) =>
        (e.attrs[attribut] ?? []).some(
          (v) => (Buffer.isBuffer(v) ? v.toString("hex") : v.toLowerCase()) === voulu,
        ),
      );
    if (trouvees.some(({ p }) => this.clesEnErreur.has(p.cle)))
      throw new ErreurAnnuaire("protocole", { code: 1 });
    return trouvees.map(({ e }) => e);
  }
}

export const UUID = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
