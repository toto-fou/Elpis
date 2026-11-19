// SPDX-License-Identifier: MIT
/** apps/core/test/identite/annuaire/serveur-ldap.ts — mini serveur LDAPS de test (BER avec les briques de ldapts) : liaison simple, recherche scriptée, renvois, silence, journal des requêtes reçues. */
import { createServer } from "node:tls";
import type { Server, TLSSocket } from "node:tls";

import { BerReader, BerWriter, FilterParser } from "ldapts";

export interface EntreeServeur {
  readonly dn: string;
  readonly attrs: Readonly<Record<string, readonly (string | Buffer)[]>>;
}

export interface RequeteRecue {
  readonly type: "bind" | "search" | "unbind";
  readonly dn?: string;
  readonly longueurMdp?: number;
  readonly base?: string;
  readonly portee?: number;
  readonly deref?: number;
  readonly limite?: number;
  readonly delai?: number;
  readonly filtre?: string;
  readonly attributs?: string[];
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
}

export interface ServeurLdap {
  readonly port: number;
  readonly requetes: RequeteRecue[];
  readonly comportement: ComportementServeur;
  /** Connexions acceptées depuis le démarrage. */
  connexions(): number;
  /** Ferme côté serveur toutes les connexions ouvertes. */
  couper(): void;
  fermer(): Promise<void>;
}

function reponse(id: number, tag: number, code: number, diagnostic: string): Buffer {
  const w = new BerWriter();
  w.startSequence();
  w.writeInt(id);
  w.startSequence(tag);
  w.writeEnumeration(code);
  w.writeString("");
  w.writeString(diagnostic);
  w.endSequence();
  w.endSequence();
  return w.buffer;
}

function entree(id: number, e: EntreeServeur): Buffer {
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
    for (const v of valeurs) {
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

function renvoi(id: number, uri: string): Buffer {
  const w = new BerWriter();
  w.startSequence();
  w.writeInt(id);
  w.startSequence(0x73);
  w.writeString(uri);
  w.endSequence();
  w.endSequence();
  return w.buffer;
}

function traiter(r: BerReader, s: TLSSocket, requetes: RequeteRecue[], c: ComportementServeur): void {
  r.readSequence();
  const id = r.readInt() ?? 0;
  const tag = r.readSequence() ?? 0;
  if (tag === 0x42) {
    requetes.push({ type: "unbind" });
    s.end();
    return;
  }
  if (tag === 0x60) {
    r.readInt();
    const dn = r.readString() ?? "";
    const mdp = r.readString(0x80, true) ?? Buffer.alloc(0);
    requetes.push({ type: "bind", dn, longueurMdp: mdp.length });
    if (c.muet) return;
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
    r.readBoolean();
    const filtre = FilterParser.parse(r).toString();
    r.readSequence();
    const fin = r.offset + r.length;
    const attributs: string[] = [];
    while (r.offset < fin) attributs.push(r.readString() ?? "");
    requetes.push({ type: "search", base, portee, deref, limite, delai, filtre, attributs });
    if (c.muet) return;
    for (const e of c.entrees) s.write(entree(id, e));
    if (c.renvoi !== null) s.write(renvoi(id, c.renvoi));
    s.write(reponse(id, 0x65, c.codeRecherche, c.codeRecherche === 0 ? "" : c.diagnostic));
  }
}

/** Écoute en LDAPS sur 127.0.0.1 avec ce certificat ; `comportement` se modifie entre deux requêtes. */
export async function demarrerServeurLdap(cert: string, cle: string): Promise<ServeurLdap> {
  const requetes: RequeteRecue[] = [];
  const comportement: ComportementServeur = {
    comptes: {},
    entrees: [],
    codeRecherche: 0,
    renvoi: null,
    muet: false,
    diagnostic: "",
  };
  const sockets = new Set<TLSSocket>();
  let acceptees = 0;
  const serveur: Server = createServer({ cert, key: cle }, (s) => {
    sockets.add(s);
    acceptees++;
    s.on("close", () => sockets.delete(s));
    s.on("error", () => undefined);
    let tampon = Buffer.alloc(0);
    s.on("data", (d: Buffer) => {
      tampon = Buffer.concat([tampon, d]);
      for (;;) {
        const t = new BerReader(tampon);
        if (t.readSequence() === null) return;
        const total = t.offset + t.length;
        if (tampon.length < total) return;
        const message = tampon.subarray(0, total);
        tampon = tampon.subarray(total);
        traiter(new BerReader(message), s, requetes, comportement);
      }
    });
  });
  await new Promise<void>((ok) => serveur.listen(0, "127.0.0.1", () => ok()));
  const adresse = serveur.address();
  return {
    port: typeof adresse === "object" && adresse !== null ? adresse.port : 0,
    requetes,
    comportement,
    connexions: () => acceptees,
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
