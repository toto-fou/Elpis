// SPDX-License-Identifier: MIT
/** apps/core/test/identite/annuaire/serveur-ldap.ts — mini serveur LDAPS de test (BER avec les briques de ldapts) : liaison simple, recherche scriptée, renvois, silence, journal des requêtes reçues. */
import { createHash } from "node:crypto";
import { createServer } from "node:tls";
import type { Server, TLSSocket } from "node:tls";

import {
  AndFilter,
  ApproximateFilter,
  BerReader,
  BerWriter,
  EqualityFilter,
  ExtensibleFilter,
  GreaterThanEqualsFilter,
  LessThanEqualsFilter,
  NotFilter,
  OrFilter,
  PresenceFilter,
  SubstringFilter,
} from "ldapts";
import type { Filter } from "ldapts";

export interface EntreeServeur {
  readonly dn: string;
  readonly attrs: Readonly<Record<string, readonly (string | Buffer)[]>>;
}

export interface RequeteRecue {
  readonly type: "bind" | "search" | "unbind" | "illisible";
  readonly dn?: string;
  readonly longueurMdp?: number;
  /** Étiquette BER de l'opération (type « illisible » : le reste de la requête n'a pas pu être lu). */
  readonly tag?: number;
  /** Empreinte SHA-256 du mot de passe reçu dans une liaison. */
  readonly empreinteMdp?: string;
  readonly base?: string;
  readonly portee?: number;
  readonly deref?: number;
  readonly limite?: number;
  readonly delai?: number;
  readonly filtre?: string;
  readonly attributs?: string[];
  /** Version annoncée dans la liaison. */
  readonly version?: number;
  /** Étiquette BER du choix d'authentification de la liaison (0x80 = simple). */
  readonly choix?: number;
  readonly typesSeuls?: boolean;
  /** OID des contrôles de requête reçus. */
  readonly controles?: string[];
}

export interface ControleReponse {
  readonly oid: string;
  readonly valeur?: Buffer;
}

export interface ReponseLiaison {
  readonly code: number;
  readonly diagnostic?: string;
  readonly controles?: readonly ControleReponse[];
  readonly renvois?: readonly string[];
}

export interface DemandeRecherche {
  readonly base: string;
  readonly portee: number;
  readonly deref: number;
  readonly limite: number;
  readonly delai: number;
  readonly typesSeuls: boolean;
  readonly filtre: Filter;
  readonly filtreTexte: string;
  readonly attributs: readonly string[];
}

export type ElementRecherche = { readonly entree: EntreeServeur } | { readonly renvois: readonly string[] };

export interface ReponseRecherche {
  readonly elements: readonly ElementRecherche[];
  readonly code: number;
  readonly diagnostic?: string;
  readonly renvois?: readonly string[];
}

export interface OptionsServeurLdap {
  readonly minVersion?: "TLSv1" | "TLSv1.1" | "TLSv1.2" | "TLSv1.3";
  readonly maxVersion?: "TLSv1" | "TLSv1.1" | "TLSv1.2" | "TLSv1.3";
  readonly ciphers?: string;
}

export interface PoigneeTls {
  readonly servername: string | null;
  readonly protocole: string | null;
}

export interface ComportementServeur {
  /** DN lié -> mot de passe attendu ; tout le reste : code 49. */
  comptes: Record<string, string>;
  entrees: EntreeServeur[];
  /** Code de résultat final de la recherche. */
  codeRecherche: number;
  renvoi: string | null;
  /** Ne répond à rien. */
  muet: boolean;
  /** Message texte placé dans les réponses d'erreur (le client ne doit jamais le relayer). */
  diagnostic: string;
  /** Profil de liaison : remplace la table `comptes` quand il est posé. */
  lier: ((dn: string, motDePasse: Buffer, version: number) => ReponseLiaison) | null;
  /** Profil de recherche : remplace `entrees`, `codeRecherche` et `renvoi` quand il est posé. */
  rechercher: ((d: DemandeRecherche) => ReponseRecherche) | null;
  /** Octets envoyés tels quels à la place de la réponse à la liaison. */
  brutLiaison: Buffer[] | null;
  /** Octets envoyés tels quels à la place de la réponse à la recherche. */
  brutRecherche: Buffer[] | null;
  /** Ferme la socket juste après l'envoi brut. */
  fermerApresBrut: boolean;
  /** Ferme la socket sans répondre à la première recherche reçue. */
  fermerSansReponse: boolean;
  /** Code d'un avis de déconnexion (RFC 4511 §4.4.1) envoyé à la place de la réponse à la recherche, puis fermeture. */
  avisDeconnexion: number | null;
  /** Taille des écritures : la réponse est découpée en morceaux de cette taille (0 : une écriture par message). */
  fragment: number;
}

export interface ServeurLdap {
  readonly port: number;
  /** Une entrée par poignée de main TLS réussie (nom demandé par SNI, version négociée). */
  readonly poignees: PoigneeTls[];
  /** Poignées de main TLS échouées. */
  tlsEchecs(): number;
  readonly requetes: RequeteRecue[];
  readonly comportement: ComportementServeur;
  /** Connexions acceptées depuis le démarrage. */
  connexions(): number;
  /** Requêtes dont la lecture a échoué depuis le démarrage (chacune est aussi notée « illisible »). */
  erreursLecture(): number;
  /** Ferme côté serveur toutes les connexions ouvertes. */
  couper(): void;
  fermer(): Promise<void>;
}

function ecrireControles(w: BerWriter, controles: readonly ControleReponse[] | undefined): void {
  if (controles === undefined || controles.length === 0) return;
  w.startSequence(0xa0);
  for (const c of controles) {
    w.startSequence();
    w.writeString(c.oid);
    if (c.valeur !== undefined) w.writeBuffer(c.valeur, 0x04);
    w.endSequence();
  }
  w.endSequence();
}

function reponse(
  id: number,
  tag: number,
  code: number,
  diagnostic: string,
  extra: { renvois?: readonly string[]; controles?: readonly ControleReponse[] } = {},
): Buffer {
  const w = new BerWriter();
  w.startSequence();
  w.writeInt(id);
  w.startSequence(tag);
  w.writeEnumeration(code);
  w.writeString("");
  w.writeString(diagnostic);
  if (extra.renvois !== undefined && extra.renvois.length > 0) {
    w.startSequence(0xa3);
    for (const u of extra.renvois) w.writeString(u);
    w.endSequence();
  }
  w.endSequence();
  ecrireControles(w, extra.controles);
  w.endSequence();
  return w.buffer;
}

/** Avis de déconnexion non sollicité (RFC 4511 §4.4.1) : identifiant 0, réponse étendue, OID 1.3.6.1.4.1.1466.20036. */
function avis(code: number): Buffer {
  const w = new BerWriter();
  w.startSequence();
  w.writeInt(0);
  w.startSequence(0x78);
  w.writeEnumeration(code);
  w.writeString("");
  w.writeString("");
  w.writeString("1.3.6.1.4.1.1466.20036", 0x8a);
  w.endSequence();
  w.endSequence();
  return w.buffer;
}

function entree(id: number, e: EntreeServeur, typesSeuls = false): Buffer {
  const w = new BerWriter();
  w.startSequence();
  w.writeInt(id);
  w.startSequence(0x64);
  w.writeString(e.dn);
  w.startSequence();
  for (const [nom, valeurs] of Object.entries(e.attrs)) {
    w.startSequence();
    w.writeString(nom);
    w.startSequence(0x31);
    for (const v of typesSeuls ? [] : valeurs) {
      if (typeof v === "string") w.writeString(v);
      else w.writeBuffer(v, 0x04);
    }
    w.endSequence();
    w.endSequence();
  }
  w.endSequence();
  w.endSequence();
  w.endSequence();
  return w.buffer;
}

function renvoi(id: number, ...uris: readonly string[]): Buffer {
  const w = new BerWriter();
  w.startSequence();
  w.writeInt(id);
  w.startSequence(0x73);
  for (const uri of uris) w.writeString(uri);
  w.endSequence();
  w.endSequence();
  return w.buffer;
}

/** Écrit les messages, en morceaux de `fragment` octets quand il est posé. */
function envoyer(s: TLSSocket, c: ComportementServeur, messages: readonly Buffer[]): void {
  for (const m of messages) {
    if (c.fragment <= 0) s.write(m);
    else for (let i = 0; i < m.length; i += c.fragment) s.write(m.subarray(i, i + c.fragment));
  }
}

/** Lit un filtre BER (le lecteur de filtre de présence de ldapts lit à partir de l'octet 0 du message). */
function lireFiltre(r: BerReader): Filter {
  const tag = r.readSequence();
  if (tag === 0xa0 || tag === 0xa1) {
    const fin = r.offset + r.length;
    const filters: Filter[] = [];
    while (r.offset < fin) filters.push(lireFiltre(r));
    return tag === 0xa0 ? new AndFilter({ filters }) : new OrFilter({ filters });
  }
  if (tag === 0xa2) return new NotFilter({ filter: lireFiltre(r) });
  if (tag === 0x87) {
    const attribute = r.buffer.subarray(r.offset, r.offset + r.length).toString("utf8");
    r.offset += r.length;
    return new PresenceFilter({ attribute });
  }
  const f =
    tag === 0xa3
      ? new EqualityFilter()
      : tag === 0xa4
        ? new SubstringFilter()
        : tag === 0xa5
          ? new GreaterThanEqualsFilter()
          : tag === 0xa6
            ? new LessThanEqualsFilter()
            : tag === 0xa8
              ? new ApproximateFilter()
              : new ExtensibleFilter();
  f.parse(r);
  return f;
}

function lireControles(r: BerReader): string[] {
  const oids: string[] = [];
  if (r.peek() !== 0xa0) return oids;
  r.readSequence(0xa0);
  const fin = r.offset + r.length;
  while (r.offset < fin) {
    r.readSequence();
    const finControle = r.offset + r.length;
    oids.push(r.readString() ?? "");
    r.offset = finControle;
  }
  return oids;
}

function traiter(
  r: BerReader,
  s: TLSSocket,
  requetes: RequeteRecue[],
  c: ComportementServeur,
  lue: { tag: number },
): void {
  r.readSequence();
  const id = r.readInt() ?? 0;
  const tag = r.readSequence() ?? 0;
  lue.tag = tag;
  if (tag === 0x42) {
    requetes.push({ type: "unbind" });
    s.end();
    return;
  }
  if (tag === 0x60) {
    const version = r.readInt() ?? 0;
    const dn = r.readString() ?? "";
    const choix = r.peek() ?? 0;
    const mdp = r.readString(0x80, true) ?? Buffer.alloc(0);
    const controles = lireControles(r);
    requetes.push({
      type: "bind",
      dn,
      longueurMdp: mdp.length,
      empreinteMdp: createHash("sha256").update(mdp).digest("hex"),
      version,
      choix,
      controles,
    });
    if (c.muet) return;
    if (c.brutLiaison !== null) {
      envoyer(s, c, c.brutLiaison);
      if (c.fermerApresBrut) s.destroy();
      return;
    }
    if (c.lier !== null) {
      const l = c.lier(dn, mdp, version);
      s.write(reponse(id, 0x61, l.code, l.diagnostic ?? "", l));
      return;
    }
    const bon = Object.hasOwn(c.comptes, dn) && c.comptes[dn] === mdp.toString() && mdp.length > 0;
    s.write(reponse(id, 0x61, bon ? 0 : 49, bon ? "" : c.diagnostic));
    return;
  }
  if (tag === 0x63) {
    const base = r.readString() ?? "";
    const portee = r.readEnumeration() ?? -1;
    const deref = r.readEnumeration() ?? -1;
    const limite = r.readInt() ?? -1;
    const delai = r.readInt() ?? -1;
    const typesSeuls = r.readBoolean() ?? false;
    const filtreObjet = lireFiltre(r);
    const filtre = filtreObjet.toString();
    r.readSequence();
    const fin = r.offset + r.length;
    const attributs: string[] = [];
    while (r.offset < fin) attributs.push(r.readString() ?? "");
    const controles = lireControles(r);
    requetes.push({
      type: "search",
      base,
      portee,
      deref,
      limite,
      delai,
      filtre,
      attributs,
      typesSeuls,
      controles,
    });
    if (c.muet) return;
    if (c.fermerSansReponse) {
      s.destroy();
      return;
    }
    if (c.avisDeconnexion !== null) {
      s.write(avis(c.avisDeconnexion));
      s.end();
      return;
    }
    if (c.brutRecherche !== null) {
      envoyer(s, c, c.brutRecherche);
      if (c.fermerApresBrut) s.destroy();
      return;
    }
    if (c.rechercher !== null) {
      const rep = c.rechercher({
        base,
        portee,
        deref,
        limite,
        delai,
        typesSeuls,
        filtre: filtreObjet,
        filtreTexte: filtre,
        attributs,
      });
      const messages = rep.elements.map((e) =>
        "entree" in e ? entree(id, e.entree, typesSeuls) : renvoi(id, ...e.renvois),
      );
      messages.push(reponse(id, 0x65, rep.code, rep.diagnostic ?? "", rep));
      envoyer(s, c, messages);
      return;
    }
    const messages: Buffer[] = c.entrees.map((e) => entree(id, e));
    if (c.renvoi !== null) messages.push(renvoi(id, c.renvoi));
    messages.push(reponse(id, 0x65, c.codeRecherche, c.codeRecherche === 0 ? "" : c.diagnostic));
    envoyer(s, c, messages);
  }
}

/** Écoute en LDAPS sur 127.0.0.1 avec ce certificat ; `comportement` se modifie entre deux requêtes. */
export async function demarrerServeurLdap(
  cert: string,
  cle: string,
  options: OptionsServeurLdap = {},
): Promise<ServeurLdap> {
  const requetes: RequeteRecue[] = [];
  const comportement: ComportementServeur = {
    comptes: {},
    entrees: [],
    codeRecherche: 0,
    renvoi: null,
    muet: false,
    diagnostic: "",
    lier: null,
    rechercher: null,
    brutLiaison: null,
    brutRecherche: null,
    fermerApresBrut: false,
    fermerSansReponse: false,
    avisDeconnexion: null,
    fragment: 0,
  };
  const sockets = new Set<TLSSocket>();
  const poignees: PoigneeTls[] = [];
  let echecsTls = 0;
  let acceptees = 0;
  let illisibles = 0;
  const serveur: Server = createServer({ cert, key: cle, ...options }, (s) => {
    sockets.add(s);
    acceptees++;
    poignees.push({
      servername: (s as TLSSocket & { servername?: string }).servername || null,
      protocole: s.getProtocol(),
    });
    s.on("close", () => sockets.delete(s));
    s.on("error", () => undefined);
    let tampon = Buffer.alloc(0);
    s.on("data", (d: Buffer) => {
      tampon = Buffer.concat([tampon, d]);
      for (;;) {
        let total: number;
        try {
          const t = new BerReader(tampon);
          if (t.readSequence() === null) return;
          total = t.offset + t.length;
        } catch {
          return;
        }
        if (tampon.length < total) return;
        const message = tampon.subarray(0, total);
        tampon = tampon.subarray(total);
        const lue = { tag: -1 };
        const avant = requetes.length;
        try {
          traiter(new BerReader(message), s, requetes, comportement, lue);
        } catch {
          illisibles++;
          if (requetes.length === avant) requetes.push({ type: "illisible", tag: lue.tag });
          s.destroy();
          return;
        }
      }
    });
  });
  serveur.on("tlsClientError", () => {
    echecsTls++;
  });
  await new Promise<void>((ok) => serveur.listen(0, "127.0.0.1", () => ok()));
  const adresse = serveur.address();
  return {
    port: typeof adresse === "object" && adresse !== null ? adresse.port : 0,
    poignees,
    tlsEchecs: () => echecsTls,
    requetes,
    comportement,
    connexions: () => acceptees,
    erreursLecture: () => illisibles,
    couper: () => {
      for (const s of sockets) s.destroy();
    },
    fermer: () =>
      new Promise<void>((ok) => {
        for (const s of sockets) s.destroy();
        serveur.close(() => ok());
      }),
  };
}
