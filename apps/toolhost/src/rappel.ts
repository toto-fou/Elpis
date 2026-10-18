// SPDX-License-Identifier: MIT
/** apps/toolhost/src/rappel.ts — rappels de l'hôte vers l'API interne du core (`/api/internal/*`, shared_infra/toolhost/client.py) : jeton de service, cache court, jamais d'exception. */
import { estDict, getPy, intPy, pyJsonLoads, strPy, veritePy } from "@elpis/commun";
import type { Dict } from "@elpis/commun";
import { IMPORT_GARDE } from "@elpis/fichiers";
import { creerIdentite, IDENTITY_HEADER, sign } from "@elpis/securite";
import { request } from "undici";
import type { Dispatcher } from "undici";

import type { Journal } from "./journal";
import type { IdentifiantEnregistre } from "./mcp/git/clone";
import type { IssuePr } from "./mcp/git/travail";
import { decrire } from "./mcp/service";

export const TTL_MS = 15_000;
export const TTL_NEGATIF_MS = 5_000;
export const DELAI_MS = 4_000;
/** Ouverture d'une PR par le core : deux appels à l'API du fournisseur (existante, création). */
const DELAI_PR_MS = 60_000;
const CACHE_MAX = 1024;

export interface JetonIntrospecte {
  user_id: number;
  username: string;
  kind: string;
  families: string[];
}

export interface IdentiteDistante {
  user_id: number;
  username: string;
  network_profile_id: string;
  is_admin: boolean;
}

export interface OptionsRappel {
  /** URL du core (`TOOLHOST_APP_URL` / `toolhost.json › app_url`), barre finale retirée. */
  readonly appUrl: string;
  readonly jeton: string;
  readonly journal: Journal;
  readonly agent?: Dispatcher;
  readonly delaiMs?: number;
}

export class ClientRappel {
  private readonly appUrl: string;
  private readonly jeton: string;
  private readonly journal: Journal;
  private readonly agent: Dispatcher | undefined;
  private readonly delaiMs: number;
  private readonly cache = new Map<string, { valeur: unknown; expire: number }>();
  private readonly quotasConnus = new Map<number, number | null>();

  constructor(o: OptionsRappel) {
    this.appUrl = o.appUrl.replace(/\/+$/u, "");
    this.jeton = o.jeton;
    this.journal = o.journal;
    this.agent = o.agent;
    this.delaiMs = o.delaiMs ?? DELAI_MS;
  }

  /** Actif seulement avec une URL du core et un jeton de service. */
  get actif(): boolean {
    return Boolean(this.appUrl) && Boolean(this.jeton);
  }

  viderCache(): void {
    this.cache.clear();
  }

  private lu(cle: string): { trouve: boolean; valeur: unknown } {
    const e = this.cache.get(cle);
    return e !== undefined && e.expire > performance.now()
      ? { trouve: true, valeur: e.valeur }
      : { trouve: false, valeur: null };
  }

  /** Valeur retenue 15 s (5 s si vide) ; au-delà de 1024 entrées, jusqu'à 256 entrées expirées sont oubliées. */
  private retenir<T>(cle: string, valeur: T): T {
    const maintenant = performance.now();
    this.cache.set(cle, { valeur, expire: maintenant + (veritePy(valeur) ? TTL_MS : TTL_NEGATIF_MS) });
    if (this.cache.size > CACHE_MAX) {
      const expirees = [...this.cache].filter(([, e]) => e.expire <= maintenant).slice(0, 256);
      for (const [k] of expirees) this.cache.delete(k);
    }
    return valeur;
  }

  /** Réponse 200 dont `ok` est vrai (tout objet si `exigerOk` est faux), sinon `null` (journalisé, chemin seul : jamais la requête ni le jeton) ; `statut` reçoit le code HTTP rendu. */
  private async appeler(
    methode: "GET" | "POST",
    chemin: string,
    params?: Dict,
    corps?: Dict,
    compte?: CompteSigne,
    delaiMs = this.delaiMs,
    statut?: { code: number },
    exigerOk = true,
  ): Promise<Dict | null> {
    if (!this.actif) return null;
    try {
      const url = new URL(this.appUrl + chemin);
      for (const [k, v] of Object.entries(params ?? {})) url.searchParams.set(k, strPy(v));
      const r = await request(url, {
        method: methode,
        headers: {
          authorization: `Bearer ${this.jeton}`,
          ...(compte ? { [IDENTITY_HEADER]: sign(creerIdentite(compte), this.jeton) } : {}),
          ...(corps ? { "content-type": "application/json" } : {}),
        },
        body: corps ? JSON.stringify(corps, sansGrandsEntiers) : null,
        signal: AbortSignal.timeout(delaiMs),
        ...(this.agent ? { dispatcher: this.agent } : {}),
      });
      const texte = await r.body.text();
      if (statut) statut.code = r.statusCode;
      if (r.statusCode !== 200) {
        this.journal.warn(`[toolhost.client] ${methode} ${chemin} → ${r.statusCode}`);
        return null;
      }
      const donnees = pyJsonLoads(texte, { mode: "natif" });
      return estDict(donnees) && (!exigerOk || veritePy(getPy(donnees, "ok"))) ? donnees : null;
    } catch (e) {
      this.journal.warn(`[toolhost.client] ${methode} ${chemin} injoignable : ${decrire(e)}`);
      return null;
    }
  }

  /** Compte lié à un jeton personnel (`pcr_…`, `ept_…`). */
  async introspectToken(jeton: string): Promise<JetonIntrospecte | null> {
    if (!jeton) return null;
    const cle = "tok:" + jeton;
    const c = this.lu(cle);
    if (c.trouve) return c.valeur as JetonIntrospecte | null;
    const d = await this.appeler("POST", "/api/internal/tokens/introspect", undefined, { token: jeton });
    return this.retenir(
      cle,
      lireOuNul(d, (x) => ({
        user_id: intPy(exiger(x, "user_id")),
        username: strPy(exiger(x, "username")),
        kind: strPy(getPy(x, "kind") || ""),
        families: liste(getPy(x, "families")).map(strPy),
      })),
    );
  }

  async identityForUsername(username: string): Promise<IdentiteDistante | null> {
    if (!username) return null;
    const cle = "id:" + username;
    const c = this.lu(cle);
    if (c.trouve) return c.valeur as IdentiteDistante | null;
    const d = await this.appeler("GET", "/api/internal/identity", { username });
    return this.retenir(
      cle,
      lireOuNul(d, (x) => ({
        user_id: intPy(exiger(x, "user_id")),
        username: strPy(exiger(x, "username")),
        network_profile_id: strPy(getPy(x, "network_profile_id") || ""),
        is_admin: veritePy(getPy(x, "is_admin")),
      })),
    );
  }

  /** `{username, token, host}` : SECRET, jamais journalisé ni gardé au-delà du TTL court. */
  async gitCredential(uid: number, remoteUrl: string): Promise<Dict | null> {
    if (!uid || !remoteUrl) return null;
    const cle = `git:${Math.trunc(uid)}:${remoteUrl}`;
    const c = this.lu(cle);
    if (c.trouve) return c.valeur as Dict | null;
    const d = await this.appeler("GET", "/api/internal/git/credential", {
      user_id: Math.trunc(uid),
      remote_url: remoteUrl,
    });
    const cred = d === null ? null : getPy(d, "credential");
    return this.retenir(cle, estDict(cred) && veritePy(cred) ? { ...cred } : null);
  }

  async connectorHosts(uid: number): Promise<string[]> {
    if (!uid) return [];
    const cle = `hosts:${Math.trunc(uid)}`;
    const c = this.lu(cle);
    if (c.trouve) return [...((c.valeur as string[] | null) ?? [])];
    const d = await this.appeler("GET", "/api/internal/git/connector-hosts", { user_id: Math.trunc(uid) });
    const hotes = d === null ? null : liste(getPy(d, "hosts")).map(strPy);
    return [...(this.retenir(cle, hotes) ?? [])];
  }

  /** `sandbox_quota_mb` du compte : `null` sans surcharge (ou sans core) ; core muet : dernière valeur connue, sinon `undefined`. */
  async quotaCompte(uid: number): Promise<number | null | undefined> {
    if (!uid || !this.actif) return null;
    const id = Math.trunc(uid);
    const cle = `quota:${id}`;
    const c = this.lu(cle);
    if (c.trouve) return c.valeur as number | null;
    const d = await this.appeler("GET", "/api/internal/sandbox/quota", { user_id: id });
    let q: number | null;
    try {
      if (d === null) throw new Error("core muet");
      const brut = getPy(d, "quota_mb");
      q = brut === null ? null : intPy(brut);
    } catch {
      return this.quotasConnus.has(id) ? this.quotasConnus.get(id) : undefined;
    }
    this.quotasConnus.delete(id);
    this.quotasConnus.set(id, q);
    if (this.quotasConnus.size > CACHE_MAX)
      this.quotasConnus.delete(this.quotasConnus.keys().next().value as number);
    return this.retenir(cle, q);
  }

  /** `save_git_credential` par le core pour `compte` (enveloppe signée) : identifiant saisi au clone de l'éditeur, enregistré pour l'hôte du dépôt (jamais gardé ni journalisé). */
  async enregistrerIdentifiantGit(
    compte: CompteSigne,
    cible: string,
    utilisateur: string,
    jeton: string,
    typeFournisseur: string,
  ): Promise<boolean> {
    const r = await this.enregistrerIdentifiantGitDetaille(
      compte,
      cible,
      utilisateur,
      jeton,
      typeFournisseur,
      "editeur",
    );
    return r !== null && r.connector_id !== null;
  }

  /** Même enregistrement (outils de l'agent par défaut : hôte déjà connu seulement), avec l'id du connecteur (`null` : refusé, `refus` dit pourquoi) et l'hôte ; `null` : core injoignable. */
  async enregistrerIdentifiantGitDetaille(
    compte: CompteSigne,
    cible: string,
    utilisateur: string,
    jeton: string,
    typeFournisseur: string,
    origine: "agent" | "editeur" = "agent",
  ): Promise<IdentifiantEnregistre | null> {
    if (compte.user_id <= 0 || !compte.username || !jeton)
      return { connector_id: null, host: "", refus: null };
    const d = await this.appeler(
      "POST",
      "/api/internal/git/credential",
      undefined,
      { target: cible, username: utilisateur, token: jeton, provider_type: typeFournisseur, origine },
      compte,
    );
    if (d === null) return null;
    const id = getPy(d, "connector_id");
    const hote = getPy(d, "host");
    const refus = getPy(d, "refus");
    return {
      connector_id: veritePy(getPy(d, "saved")) && typeof id === "number" && id > 0 ? id : null,
      host: typeof hote === "string" ? hote : "",
      refus: typeof refus === "string" && refus ? refus : null,
    };
  }

  /** `import_legacy_git_credentials` par le core pour `compte` (enveloppe signée) : connecteurs créés, `-1` si l'import a échoué, `IMPORT_GARDE` si des hôtes ont été refusés (fichier gardé dans les deux cas). */
  async importAncien(compte: CompteSigne, donnees: Buffer): Promise<number> {
    if (compte.user_id <= 0 || !compte.username) return -1;
    const d = await this.appeler(
      "POST",
      "/api/internal/git/legacy-credentials",
      undefined,
      { data_b64: donnees.toString("base64") },
      compte,
    );
    const n = lireOuNul(d, (x) => intPy(exiger(x, "created"))) ?? -1;
    return n >= 0 && veritePy(getPy(d ?? {}, "refused")) ? IMPORT_GARDE : n;
  }

  /** Notification de fin d'automatisation du bureau pour `compte` (enveloppe signée : le core n'accepte pas d'autre destinataire). */
  async creerNotification(compte: CompteSigne, titre: string, corps: string): Promise<boolean> {
    return (
      (await this.appeler(
        "POST",
        "/api/internal/notifications",
        undefined,
        { title: titre, body: corps },
        compte,
      )) !== null
    );
  }

  /** PR ouverte par le core pour `compte` (`/api/internal/git/pr`) : issue `{outcome, …}`, `rejected` si le core refuse la demande (4xx) ; `null` : core injoignable. Le jeton de l'API de PR ne quitte jamais main. */
  async ouvrirPr(
    compte: CompteSigne,
    demande: { remote_url: string; head: string; base: string; title: string; body: string; draft: boolean },
  ): Promise<IssuePr | null> {
    const statut = { code: 0 };
    const d = await this.appeler(
      "POST",
      "/api/internal/git/pr",
      undefined,
      { ...demande },
      compte,
      DELAI_PR_MS,
      statut,
    );
    if (d === null && statut.code >= 400 && statut.code < 500)
      return { outcome: "rejected", status: statut.code };
    const issue = d === null ? null : getPy(d, "result");
    return estDict(issue) && typeof issue["outcome"] === "string" ? (issue as unknown as IssuePr) : null;
  }

  /** `POST /api/internal/jobs` pour `compte` (avant le lancement) : enregistrement, ou refus `{ok:false, error, …}` rendu tel quel ; `null` : core injoignable ou en erreur (`statut` : code HTTP). */
  enregistrerJob(compte: CompteSigne, corps: Dict, statut?: { code: number }): Promise<Dict | null> {
    return this.appeler("POST", "/api/internal/jobs", undefined, corps, compte, this.delaiMs, statut, false);
  }

  /** `POST /api/internal/jobs/state` : lancement confirmé (`running`, pid) ou refusé (`failed`) ; réponse rendue telle quelle, `null` : core injoignable. */
  etatJob(
    compte: CompteSigne,
    corps: { job_id: string; state: "running" | "failed"; pid?: number | null; error?: string },
  ): Promise<Dict | null> {
    return this.appeler(
      "POST",
      "/api/internal/jobs/state",
      undefined,
      { ...corps },
      compte,
      this.delaiMs,
      undefined,
      false,
    );
  }

  /** `POST /api/internal/jobs/delivered` : les événements du job sont portés par le résultat de l'outil (pas de réveil) ; `null` : core injoignable. */
  jobLivre(compte: CompteSigne, jobId: string): Promise<Dict | null> {
    return this.appeler(
      "POST",
      "/api/internal/jobs/delivered",
      undefined,
      { job_id: jobId },
      compte,
      this.delaiMs,
      undefined,
      false,
    );
  }

  /** `POST /api/internal/jobs/events` : lot relayé par la veille ; acquittement `{acked_seq, accepted, rejected}`, `null` : non acquitté (`statut` : code HTTP). */
  evenementsJobs(
    compte: CompteSigne,
    events: readonly Dict[],
    lastSeq: number,
    statut?: { code: number },
  ): Promise<Dict | null> {
    return this.appeler(
      "POST",
      "/api/internal/jobs/events",
      undefined,
      { events: [...events], last_seq: lastSeq },
      compte,
      this.delaiMs,
      statut,
    );
  }

  /** `GET /api/internal/jobs?chat_id=` : jobs de la conversation de `compte` (tout le compte sans `chatId`) ; `null` : core injoignable. */
  async jobsDuCompte(compte: CompteSigne, chatId: string | null): Promise<Dict | null> {
    const d = await this.appeler(
      "GET",
      "/api/internal/jobs",
      chatId === null ? undefined : { chat_id: chatId },
      undefined,
      compte,
      this.delaiMs,
      undefined,
      false,
    );
    return d !== null && Array.isArray(d["jobs"]) ? d : null;
  }

  /** Ancre épinglée `{auto_id, role, center}` de `compte` pour (cible, requête), `null` sinon ; jamais gardée en cache. */
  async ancre(compte: CompteSigne, cible: string, requete: string): Promise<Dict | null> {
    const d = await this.appeler(
      "GET",
      "/api/internal/desktop/anchor",
      { target: cible, query: requete },
      undefined,
      compte,
    );
    const a = d === null ? null : getPy(d, "anchor");
    return estDict(a) ? a : null;
  }

  async noterAncre(compte: CompteSigne, cible: string, requete: string, ancre: Dict): Promise<boolean> {
    const corps = { target: cible, query: requete, ...ancre };
    return (await this.appeler("POST", "/api/internal/desktop/anchor", undefined, corps, compte)) !== null;
  }
}

/** Entiers lus en `bigint` (JSON de l'agent) envoyés comme nombres. */
function sansGrandsEntiers(_cle: string, v: unknown): unknown {
  return typeof v === "bigint" ? Number(v) : v;
}

/** Compte d'une enveloppe signée par l'hôte pour un rappel au nom d'un utilisateur. */
export interface CompteSigne {
  readonly user_id: number;
  readonly username: string;
}

/** `d[cle]` : une clé absente lève (KeyError). */
function exiger(d: Dict, cle: string): unknown {
  if (!Object.hasOwn(d, cle)) throw new Error(`KeyError: ${cle}`);
  return d[cle];
}

function liste(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

/** Réponse mal formée (champ manquant, entier illisible) : `null` (le Python levait vers l'appelant). */
function lireOuNul<T>(d: Dict | null, lire: (d: Dict) => T): T | null {
  if (d === null) return null;
  try {
    return lire(d);
  } catch {
    return null;
  }
}
