// SPDX-License-Identifier: MIT
/** apps/core/test/identite/oidc-factice.ts — fournisseur OIDC factice en processus : serveur HTTPS local sous une autorité de test, jetons signés avec jose, défauts et pièges réglables (algorithme, émetteur, public, nonce, validité, clés, taille, redirection, userinfo), requêtes tracées. */
import { createHash, randomBytes } from "node:crypto";
import type { webcrypto } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer } from "node:https";
import type { Server } from "node:https";
import type { AddressInfo, Socket } from "node:net";

import { exportJWK, generateKeyPair, SignJWT } from "jose";
import type { CryptoKey, JWK } from "jose";

import { creerAutorite, creerFeuille, effacer } from "./pki-openssl";
import type { Autorite } from "./pki-openssl";

export const NOM_FOURNISSEUR = "elpis-test.invalid";
export const VERS_BOUCLE = async (): Promise<{ motif: null; adresses: string[] }> => ({
  motif: null,
  adresses: ["127.0.0.1"],
});

export interface Utilisateur {
  readonly sub: string;
  readonly claims?: Readonly<Record<string, unknown>>;
}

export interface TraceRequete {
  readonly methode: string;
  readonly chemin: string;
  readonly autorisation: string | null;
  readonly corps: URLSearchParams;
}

interface Code {
  readonly utilisateur: Utilisateur;
  readonly nonce: string;
  readonly challenge: string;
  readonly redirectUri: string;
  readonly clientId: string;
}

/** Réglages du jeton émis au point de jetons ; chaque champ remplace sa valeur honnête. */
export interface PiegesJeton {
  /** Algorithme de l'en-tête et de la signature (`none` : jeton non signé ; `HS256` : signé avec le secret client). */
  alg?: string;
  /** Clé qui signe réellement (autre que celle publiée) : signature fausse. */
  signerAvecAutreCle?: boolean;
  /** Identifiant de clé de l'en-tête. */
  kid?: string;
  claims?: Record<string, unknown>;
  /** Claims retirés. */
  sans?: string[];
  /** Ne rend pas de jeton d'identité. */
  sansJeton?: boolean;
  /** En-tête sans `kid`. */
  sansKid?: boolean;
  /** Paramètres ajoutés à l'en-tête protégé (`typ`, `crit`, `jku`…) ; `undefined` retire le paramètre. */
  entete?: Record<string, unknown>;
  /** Clé qui signe réellement, à la place de la clé publiée. */
  cleDeSignature?: CryptoKey;
  /** Chaîne rendue telle quelle comme jeton d'identité. */
  jetonBrut?: string;
  /** Signature faite à la main (sans les contrôles de l'en-tête de la bibliothèque) : permet `crit` inconnu, `b64`, etc. */
  signatureManuelle?: boolean;
}

/** Chemins servis par le fournisseur (absolus) ; chacun remplace son défaut sous la racine de l'émetteur. */
export interface CheminsFactice {
  auth?: string;
  token?: string;
  certs?: string;
  userinfo?: string;
  logout?: string;
  par?: string;
}

/** Réponse HTTP brute d'un chemin surchargé. */
export interface ReponseBrute {
  statut: number;
  entetes?: Record<string, string>;
  corps?: string;
}

export interface OptionsFactice {
  clientId?: string;
  clientSecret?: string;
  /** Algorithme annoncé, publié et utilisé par défaut. */
  alg?: string;
  /** Authentification du client attendue au point de jetons. */
  authClient?: "basic" | "post";
  /** Document de découverte : champs remplacés ou retirés (`undefined`). */
  decouverte?: Record<string, unknown>;
  /** Chemin de l'émetteur sous l'origine (`/realms/elpis` par défaut ; `""` : émetteur à la racine). */
  racine?: string;
  /** L'émetteur se termine par une barre. */
  barreFinale?: boolean;
  chemins?: CheminsFactice;
  /** Taille du module RSA des clés générées. */
  modulusLength?: number;
  /** Le retour d'autorisation porte `iss` (`true` : l'émetteur ; une chaîne : cette valeur). */
  issDansReponse?: boolean | string;
  /** Le point d'autorisation refuse toute requête non poussée. */
  exigerPar?: boolean;
}

const base64url = (b: Buffer | string): string => Buffer.from(b).toString("base64url");
const sha256 = (t: string): string => createHash("sha256").update(t).digest("base64url");

/** Fournisseur factice démarré ; `fermer` l'arrête et efface son autorité. */
export class OidcFactice {
  readonly traces: TraceRequete[] = [];
  readonly clientId: string;
  readonly clientSecret: string;
  readonly authClient: "basic" | "post";
  readonly alg: string;
  readonly ca: Autorite;
  readonly cleHs = "secret-hs-de-test";
  readonly racine: string;
  readonly barreFinale: boolean;
  readonly chemins: Required<CheminsFactice>;
  readonly modulusLength: number | undefined;
  issDansReponse: boolean | string;
  exigerPar: boolean;
  /** Réponses brutes par chemin (avant tout traitement), pour les pièges de transport. */
  readonly surcharges = new Map<string, () => ReponseBrute>();
  /** Champs ajoutés (ou retirés avec `undefined`) à la réponse du point de jetons. */
  extraJetons: Record<string, unknown> = {};
  /** Pièges du prochain jeton (remis à zéro à chaque émission). */
  pieges: PiegesJeton = {};

  /** Jeu de clés publié à la place de la clé honnête ; `null` : la clé honnête. */
  jeuDeCles: unknown = null;
  /** Corps rendu par le point d'information (`null` : 404). */
  userinfo: ((u: Utilisateur) => Record<string, unknown> | null) | null = null;
  /** Remplace la réponse du point de jetons (statut, entêtes, corps) ; `null` : réponse normale. */
  reponseJetons: (() => { statut: number; entetes?: Record<string, string>; corps?: string }) | null = null;
  /** Document de découverte : champs remplacés ou retirés (`undefined`). */
  decouverte: Record<string, unknown>;
  /** Nombre de lectures du jeu de clés. */
  lecturesCles = 0;
  /** Jetons d'identité et d'accès émis, pour vérifier qu'aucun ne fuit. */
  readonly emis: string[] = [];
  /** Erreurs internes du fournisseur factice (jeton impossible à fabriquer…) : toujours vide dans un test honnête. */
  readonly erreurs: string[] = [];
  private serveur!: Server;
  private readonly sockets = new Set<Socket>();
  private port = 0;
  private cle!: { privee: CryptoKey; jwk: JWK; kid: string };
  private autreCle!: { privee: CryptoKey };
  private readonly codes = new Map<string, Code>();
  private readonly requetesPoussees = new Map<string, URLSearchParams>();
  /** Si vrai, le point de jetons ne répond jamais. */
  muet = false;
  private nombreCles = 0;

  private constructor(o: OptionsFactice) {
    this.clientId = o.clientId ?? "elpis";
    this.clientSecret = o.clientSecret ?? "secret-client-de-test";
    this.authClient = o.authClient ?? "basic";
    this.alg = o.alg ?? "ES256";
    this.decouverte = { ...o.decouverte };
    this.racine = o.racine ?? "/realms/elpis";
    this.barreFinale = o.barreFinale ?? false;
    this.modulusLength = o.modulusLength;
    this.issDansReponse = o.issDansReponse ?? false;
    this.exigerPar = o.exigerPar ?? false;
    const r = this.racine;
    this.chemins = {
      auth: `${r}/auth`,
      token: `${r}/token`,
      certs: `${r}/certs`,
      userinfo: `${r}/userinfo`,
      logout: `${r}/logout`,
      par: `${r}/par`,
      ...o.chemins,
    };
    this.ca = creerAutorite("Fournisseur factice");
  }

  static async demarrer(o: OptionsFactice = {}): Promise<OidcFactice> {
    const f = new OidcFactice(o);
    await f.initialiser();
    return f;
  }

  get issuer(): string {
    return `https://${NOM_FOURNISSEUR}:${this.port}${this.racine}${this.barreFinale ? "/" : ""}`;
  }

  /** Adresse du document de découverte de l'émetteur. */
  get adresseDecouverte(): string {
    return `${this.origine}${this.racine}/.well-known/openid-configuration`;
  }

  /** Clé publique honnête, telle que publiée. */
  get jwkPublic(): JWK {
    return this.cle.jwk;
  }

  /** Paire de clés neuve d'un algorithme (`jwk` avec `kid`, `use` et `alg`). */
  async genererCle(
    alg: string,
    kid: string,
    modulusLength?: number,
  ): Promise<{ privee: CryptoKey; jwk: JWK }> {
    const { publicKey, privateKey } = await generateKeyPair(alg, {
      extractable: true,
      ...(modulusLength === undefined ? {} : { modulusLength }),
    });
    return { privee: privateKey, jwk: { ...(await exportJWK(publicKey)), kid, use: "sig", alg } };
  }

  get origine(): string {
    return `https://${NOM_FOURNISSEUR}:${this.port}`;
  }

  /** Adresse d'un chemin du fournisseur. */
  url(chemin: string): string {
    return `${this.origine}${chemin}`;
  }

  private async nouvelleCle(): Promise<{ privee: CryptoKey; jwk: JWK; kid: string }> {
    const { publicKey, privateKey } = await generateKeyPair(this.alg, {
      extractable: true,
      ...(this.modulusLength === undefined ? {} : { modulusLength: this.modulusLength }),
    });
    this.nombreCles += 1;
    const kid = `cle-${this.nombreCles}`;
    return {
      privee: privateKey,
      jwk: { ...(await exportJWK(publicKey)), kid, use: "sig", alg: this.alg },
      kid,
    };
  }

  private async initialiser(): Promise<void> {
    this.cle = await this.nouvelleCle();
    this.autreCle = { privee: (await generateKeyPair(this.alg, { extractable: true })).privateKey };
    const feuille = creerFeuille(this.ca, { noms: [NOM_FOURNISSEUR], ips: ["127.0.0.1"] });
    this.serveur = createServer({ cert: feuille.cert, key: feuille.cle }, (q, r) => {
      void this.traiter(q, r).catch((e: unknown) => {
        this.erreurs.push(e instanceof Error ? e.message : String(e));
        r.statusCode = 500;
        r.end();
      });
    });
    this.serveur.on("connection", (s: Socket) => {
      this.sockets.add(s);
      s.on("close", () => this.sockets.delete(s));
    });
    await new Promise<void>((ok) => this.serveur.listen(0, "127.0.0.1", () => ok()));
    this.port = (this.serveur.address() as AddressInfo).port;
  }

  /** Remplace la clé de signature publiée (rotation) ; l'ancienne n'est plus publiée. */
  async rotation(): Promise<void> {
    this.cle = await this.nouvelleCle();
  }

  async fermer(): Promise<void> {
    for (const s of this.sockets) s.destroy();
    await new Promise<void>((ok) => this.serveur.close(() => ok()));
    effacer(this.ca);
  }

  private documentDecouverte(): Record<string, unknown> {
    const o = this.origine;
    const c = this.chemins;
    const base: Record<string, unknown> = {
      issuer: this.issuer,
      authorization_endpoint: `${o}${c.auth}`,
      token_endpoint: `${o}${c.token}`,
      jwks_uri: `${o}${c.certs}`,
      userinfo_endpoint: `${o}${c.userinfo}`,
      end_session_endpoint: `${o}${c.logout}`,
      backchannel_logout_supported: true,
      id_token_signing_alg_values_supported: [this.alg],
      token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post"],
      code_challenge_methods_supported: ["S256"],
      response_types_supported: ["code"],
    };
    const sortie: Record<string, unknown> = { ...base, ...this.decouverte };
    for (const [k, v] of Object.entries(this.decouverte)) if (v === undefined) delete sortie[k];
    return sortie;
  }

  /** Simule l'authentification d'une personne chez le fournisseur : vérifie la requête d'autorisation et rend l'adresse de retour (code et state). */
  autoriser(
    urlAutorisation: string,
    utilisateur: Utilisateur,
  ): { retour: string; code: string; state: string } {
    const u = new URL(urlAutorisation);
    const poussee = this.requetesPoussees.get(u.searchParams.get("request_uri") ?? "");
    if (poussee !== undefined) {
      if (u.searchParams.get("client_id") !== this.clientId)
        throw new Error("client_id absent de l'adresse poussée");
      for (const k of ["state", "nonce", "code_challenge", "redirect_uri"])
        if (u.searchParams.has(k))
          throw new Error(`${k} ne doit pas figurer en clair dans l'adresse poussée`);
      for (const [k, v] of poussee) u.searchParams.set(k, v);
    }
    if (this.exigerPar && poussee === undefined) throw new Error("requête non poussée refusée (PAR exigé)");
    if (u.origin !== this.origine || u.pathname !== this.chemins.auth)
      throw new Error(`adresse d'autorisation inattendue : ${u.origin}${u.pathname}`);
    const p = u.searchParams;
    const attendu: Record<string, string> = {
      response_type: "code",
      client_id: this.clientId,
      code_challenge_method: "S256",
    };
    for (const [k, v] of Object.entries(attendu))
      if (p.get(k) !== v) throw new Error(`paramètre ${k} inattendu : ${p.get(k)}`);
    for (const k of ["redirect_uri", "state", "nonce", "code_challenge", "scope"])
      if ((p.get(k) ?? "") === "") throw new Error(`paramètre ${k} absent`);
    const code = randomBytes(16).toString("base64url");
    this.codes.set(code, {
      utilisateur,
      nonce: p.get("nonce") ?? "",
      challenge: p.get("code_challenge") ?? "",
      redirectUri: p.get("redirect_uri") ?? "",
      clientId: this.clientId,
    });
    const retour = new URL(p.get("redirect_uri") ?? "");
    retour.searchParams.set("code", code);
    retour.searchParams.set("state", p.get("state") ?? "");
    if (this.issDansReponse !== false)
      retour.searchParams.set("iss", this.issDansReponse === true ? this.issuer : this.issDansReponse);
    return { retour: retour.href, code, state: p.get("state") ?? "" };
  }

  /** Annonce le point d'autorisation poussée (PAR) dans la découverte. */
  activerPar(): void {
    this.decouverte = {
      ...this.decouverte,
      pushed_authorization_request_endpoint: `${this.origine}${this.chemins.par}`,
    };
  }

  private async corps(q: IncomingMessage): Promise<URLSearchParams> {
    const morceaux: Buffer[] = [];
    for await (const m of q) morceaux.push(m as Buffer);
    return new URLSearchParams(Buffer.concat(morceaux).toString("utf8"));
  }

  private json(
    r: ServerResponse,
    statut: number,
    corps: unknown,
    entetes: Record<string, string> = {},
  ): void {
    r.writeHead(statut, { "content-type": "application/json", ...entetes });
    r.end(JSON.stringify(corps));
  }

  private async traiter(q: IncomingMessage, r: ServerResponse): Promise<void> {
    const chemin = (q.url ?? "").split("?")[0] ?? "";
    const corps = q.method === "POST" ? await this.corps(q) : new URLSearchParams();
    this.traces.push({
      methode: q.method ?? "",
      chemin,
      autorisation: q.headers.authorization ?? null,
      corps,
    });
    const surcharge = this.surcharges.get(chemin)?.();
    if (surcharge !== undefined) {
      r.writeHead(surcharge.statut, surcharge.entetes ?? {});
      r.end(surcharge.corps ?? "");
      return;
    }
    if (chemin === `${this.racine}/.well-known/openid-configuration`)
      return this.json(r, 200, this.documentDecouverte(), { date: new Date().toUTCString() });
    if (chemin === this.chemins.certs) {
      this.lecturesCles += 1;
      return this.json(r, 200, this.jeuDeCles ?? { keys: [this.cle.jwk] });
    }
    if (chemin === this.chemins.par && q.method === "POST") {
      const uri = `urn:ietf:params:oauth:request_uri:${randomBytes(8).toString("hex")}`;
      this.requetesPoussees.set(uri, corps);
      return this.json(r, 201, { request_uri: uri, expires_in: 60 });
    }
    if (chemin === this.chemins.token && q.method === "POST") {
      if (this.muet) return;
      return this.jetons(q, r, corps);
    }
    if (chemin === this.chemins.userinfo) return this.informations(q, r);
    if (chemin === `${this.racine}/trop-gros`) {
      r.writeHead(200, { "content-type": "application/json" });
      r.end(Buffer.alloc(1024 * 1024 + 10, 0x20));
      return;
    }
    r.statusCode = 404;
    r.end();
  }

  private async jetons(q: IncomingMessage, r: ServerResponse, corps: URLSearchParams): Promise<void> {
    const remplacement = this.reponseJetons?.();
    if (remplacement !== undefined && remplacement !== null) {
      r.writeHead(remplacement.statut, { "content-type": "application/json", ...remplacement.entetes });
      r.end(remplacement.corps ?? "");
      return;
    }
    const erreur = (e: string): void =>
      this.json(r, 400, { error: e, error_description: "SECRET-DU-FOURNISSEUR" });
    let secret: string | null;
    if (this.authClient === "basic") {
      const a = q.headers.authorization ?? "";
      if (!a.startsWith("Basic ")) return erreur("invalid_client");
      const [id, ...reste] = Buffer.from(a.slice(6), "base64").toString("utf8").split(":");
      const decoder = (t: string): string => decodeURIComponent(t.replace(/\+/gu, " "));
      if (decoder(id ?? "") !== this.clientId) return erreur("invalid_client");
      secret = decoder(reste.join(":"));
    } else {
      if (corps.get("client_id") !== this.clientId) return erreur("invalid_client");
      secret = corps.get("client_secret");
    }
    if (secret !== this.clientSecret) return erreur("invalid_client");
    if (corps.get("grant_type") !== "authorization_code") return erreur("unsupported_grant_type");
    const code = this.codes.get(corps.get("code") ?? "");
    this.codes.delete(corps.get("code") ?? "");
    if (code === undefined) return erreur("invalid_grant");
    if (corps.get("redirect_uri") !== code.redirectUri) return erreur("invalid_grant");
    if (sha256(corps.get("code_verifier") ?? "") !== code.challenge) return erreur("invalid_grant");
    this.dernier = code.utilisateur;
    const p = this.pieges;
    this.pieges = {};
    const jeton = await this.fabriquerJeton(code, p);
    const acces = `acces-${randomBytes(8).toString("hex")}`;
    this.emis.push(acces, jeton);
    const corpsJetons: Record<string, unknown> = {
      access_token: acces,
      token_type: "Bearer",
      expires_in: 300,
      ...(p.sansJeton ? {} : { id_token: jeton }),
      ...this.extraJetons,
    };
    for (const [k, v] of Object.entries(this.extraJetons)) if (v === undefined) delete corpsJetons[k];
    this.json(r, 200, corpsJetons);
  }

  /** Jeton d'identité honnête pour ce code, modifié par les pièges. */
  async fabriquerJeton(code: Code, p: PiegesJeton): Promise<string> {
    const t = Math.floor(Date.now() / 1000);
    const claims: Record<string, unknown> = {
      iss: this.issuer,
      sub: code.utilisateur.sub,
      aud: code.clientId,
      iat: t,
      exp: t + 300,
      auth_time: t,
      nonce: code.nonce,
      ...code.utilisateur.claims,
      ...p.claims,
    };
    return this.signer(claims, p);
  }

  /** Jeton de déconnexion par canal arrière honnête (`sid` et `sub` donnés), modifié par les pièges (`claims`, `sans`, `alg`, `kid`, `signerAvecAutreCle`). */
  async jetonDeconnexion(u: { sid?: string; sub?: string }, p: PiegesJeton = {}): Promise<string> {
    const t = Math.floor(Date.now() / 1000);
    const claims: Record<string, unknown> = {
      iss: this.issuer,
      aud: this.clientId,
      iat: t,
      exp: t + 120,
      jti: randomBytes(8).toString("hex"),
      events: { "http://schemas.openid.net/event/backchannel-logout": {} },
      ...(u.sid === undefined ? {} : { sid: u.sid }),
      ...(u.sub === undefined ? {} : { sub: u.sub }),
      ...p.claims,
    };
    return this.signer(claims, p);
  }

  private async signer(claims: Record<string, unknown>, p: PiegesJeton): Promise<string> {
    for (const nom of p.sans ?? []) delete claims[nom];
    if (p.jetonBrut !== undefined) return p.jetonBrut;
    const alg = p.alg ?? this.alg;
    if (alg === "none") {
      const entete = base64url(JSON.stringify({ alg: "none", typ: "JWT" }));
      return `${entete}.${base64url(JSON.stringify(claims))}.`;
    }
    const entete: Record<string, unknown> = {
      alg,
      typ: "JWT",
      ...(p.sansKid ? {} : { kid: p.kid ?? this.cle.kid }),
      ...p.entete,
    };
    for (const [k, v] of Object.entries(entete)) if (v === undefined) delete entete[k];
    if (p.signatureManuelle) return this.signerAMain(entete, claims, p.cleDeSignature ?? this.cle.privee);
    const jwt = new SignJWT(claims).setProtectedHeader(entete as { alg: string });
    if (alg.startsWith("HS"))
      return jwt.sign(new TextEncoder().encode(p.signerAvecAutreCle ? "autre" : this.clientSecret));
    return jwt.sign(p.cleDeSignature ?? (p.signerAvecAutreCle ? this.autreCle.privee : this.cle.privee));
  }

  private async signerAMain(
    entete: Record<string, unknown>,
    claims: Record<string, unknown>,
    cle: CryptoKey,
  ): Promise<string> {
    const alg = String(entete["alg"]);
    const algo: webcrypto.Algorithm | webcrypto.RsaPssParams | webcrypto.EcdsaParams = alg.startsWith("ES")
      ? { name: "ECDSA", hash: `SHA-${alg.slice(2)}` }
      : alg.startsWith("PS")
        ? { name: "RSA-PSS", saltLength: Number(alg.slice(2)) / 8 }
        : { name: "RSASSA-PKCS1-v1_5" };
    const entree = `${base64url(JSON.stringify(entete))}.${base64url(JSON.stringify(claims))}`;
    const signature = await crypto.subtle.sign(algo, cle, Buffer.from(entree));
    return `${entree}.${base64url(Buffer.from(signature))}`;
  }

  private informations(_q: IncomingMessage, r: ServerResponse): void {
    const rendu = this.userinfo === null || this.dernier === null ? null : this.userinfo(this.dernier);
    if (rendu === null) {
      r.statusCode = 404;
      r.end();
      return;
    }
    this.json(r, 200, rendu);
  }

  private dernier: Utilisateur | null = null;
}
