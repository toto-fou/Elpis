// SPDX-License-Identifier: MIT
/** packages/outils-mcp/src/jetons.ts — vérification Bearer du service d'outils : jeton de service (`trusted_meta`), jetons clients, jetons personnels `pcr_`/`ept_` (base puis introspection), délégation `dlg_`. */
import { createHash, timingSafeEqual } from "node:crypto";

import { intPy, journalDe, strPy, stripPy, veritePy } from "@elpis/commun";
import type { Dict } from "@elpis/commun";
import { config } from "@elpis/config";
import { DELEGATION_TOKEN_PREFIX, verifyDelegation } from "@elpis/mcp";

import type { JetonAcces } from "./contexte";

export const SCOPE_LOCAL_TOOLS = "local-tools";
export const OPENCODE_TOKEN_PREFIX = "pcr_";
export const TOOLS_TOKEN_PREFIX = "ept_";
export const OPENCODE_CLIENT_PREFIX = "opencode:";
export const TOOLS_CLIENT_PREFIX = "tools:";
const PREFIXES_PERSONNELS = [OPENCODE_TOKEN_PREFIX, TOOLS_TOKEN_PREFIX];
export const TTL_JETON_S = 15.0;
export const TTL_JETON_NEGATIF_S = 5.0;

/** Compte lié à un jeton personnel : nom, type (`opencode`, `tools`), familles cochées. */
export interface IdentiteJeton {
  username: string;
  kind: string;
  families: string[];
}

/** `tokens.resolve(jeton, kinds=("opencode","tools"))` : la base de l'app (core), absente sur un hôte distant. */
export type ResolveurJetonPersonnel = (jeton: string) => Promise<IdentiteJeton | null>;

/** `toolhost.client.introspect_token` : rappel vers `/api/internal/tokens/introspect` (hôte distant). */
export interface PortIntrospection {
  readonly actif: boolean;
  introspectToken(jeton: string): Promise<{ username: unknown; kind?: unknown; families?: unknown } | null>;
}

/** `build_token_table` : jeton de service (`trusted_meta`) et jetons clients liés à un compte (familles éventuelles). */
export function construireTable(
  jetonService: string,
  jetonsClients: Readonly<Record<string, string>>,
  famillesParJeton: Readonly<Record<string, readonly string[]>> = {},
): Map<string, Dict> {
  const table = new Map<string, Dict>();
  if (jetonService)
    table.set(jetonService, { client_id: "elpis-app", scopes: [SCOPE_LOCAL_TOOLS], trusted_meta: true });
  for (const [jeton, compte] of Object.entries(jetonsClients)) {
    if (!jeton || !compte || jeton === jetonService) continue;
    const claims: Dict = {
      client_id: `ext:${compte}`,
      scopes: [SCOPE_LOCAL_TOOLS],
      username: compte,
      trusted_meta: false,
    };
    const fams = famillesParJeton[jeton];
    if (fams && fams.length > 0) claims["families"] = [...fams];
    table.set(jeton, claims);
  }
  return table;
}

/** `token_config_error` : des jetons clients sans jeton de service feraient refuser l'app elle-même (401). */
export function erreurConfigJetons(
  jetonService: string,
  jetonsClients: Readonly<Record<string, string>>,
): string | null {
  if (Object.keys(jetonsClients).length > 0 && !jetonService)
    return (
      "LOCAL_MCP_CLIENT_TOKENS est posé sans LOCAL_MCP_TOKEN : l'app " +
      "elle-même serait rejetée (401). Posez aussi le jeton de service."
    );
  return null;
}

/** `_load_tokens` : jeton de service et jetons clients de la configuration (environnement compris). */
export function chargerJetons(): {
  service: string;
  clients: Record<string, string>;
  familles: Record<string, string[]>;
} {
  return {
    service: stripPy(strPy(config.LOCAL_MCP_TOKEN ?? "")),
    clients: { ...(config.LOCAL_MCP_CLIENT_TOKENS as Record<string, string>) },
    familles: { ...(config.LOCAL_MCP_CLIENT_TOKEN_FAMILIES as Record<string, string[]>) },
  };
}

const empreinte = (s: string): Buffer => createHash("sha256").update(s, "utf8").digest();

/** `delegated_access_token` : revendications qu'aurait eues le jeton du client, plus son id et `delegated`. */
export function jetonDelegue(jeton: string, deleg: Dict): JetonAcces {
  const compte = strPy(veritePy(deleg["sub"]) ? deleg["sub"] : "");
  const type = strPy(veritePy(deleg["kind"]) ? deleg["kind"] : "");
  const prefixe =
    type === "tools" ? TOOLS_CLIENT_PREFIX : type === "opencode" ? OPENCODE_CLIENT_PREFIX : `${type}:`;
  const claims: Dict = {
    username: compte,
    trusted_meta: false,
    client_kind: type,
    delegated: true,
    scopes: [SCOPE_LOCAL_TOOLS],
  };
  try {
    claims["user_id"] = intPy(veritePy(deleg["uid"]) ? deleg["uid"] : 0);
  } catch {
    claims["user_id"] = 0;
  }
  if (type !== "opencode")
    claims["families"] = (Array.isArray(deleg["families"]) ? deleg["families"] : []).map((f) => strPy(f));
  return {
    token: jeton,
    client_id: `${prefixe}${compte}`,
    scopes: [SCOPE_LOCAL_TOOLS],
    expires_at: null,
    claims,
  };
}

export interface OptionsVerificateur {
  readonly table: Map<string, Dict>;
  readonly resoudre?: ResolveurJetonPersonnel | null;
  readonly introspection?: PortIntrospection | null;
  /** Horloge des délégations (secondes), pour les tests. */
  readonly maintenant?: () => number;
}

/** `AppTokenVerifier` : délégation, table statique (comparée en temps constant), puis jetons personnels (cache 15 s, 5 s si inconnu). */
export class VerificateurJetons {
  private readonly entrees: { empreinte: Buffer; claims: Dict }[];
  private readonly jetonService: string;
  private readonly resoudre: ResolveurJetonPersonnel | null;
  private readonly introspection: PortIntrospection | null;
  private readonly maintenant: (() => number) | null;
  private readonly cache = new Map<string, { ident: IdentiteJeton | null; expire: number }>();

  constructor(o: OptionsVerificateur) {
    this.entrees = [...o.table].map(([jeton, claims]) => ({ empreinte: empreinte(jeton), claims }));
    this.jetonService = [...o.table].find(([, c]) => veritePy(c["trusted_meta"]))?.[0] ?? "";
    this.resoudre = o.resoudre ?? null;
    this.introspection = o.introspection ?? null;
    this.maintenant = o.maintenant ?? null;
  }

  /** Revendications de la table pour `jeton`, toutes les entrées comparées (aucune fuite de position ni de longueur). */
  private dansTable(jeton: string): Dict | null {
    const e = empreinte(jeton);
    let trouve: Dict | null = null;
    for (const entree of this.entrees) if (timingSafeEqual(entree.empreinte, e)) trouve = entree.claims;
    return trouve;
  }

  private async personnel(jeton: string): Promise<IdentiteJeton | null> {
    const t = performance.now() / 1000;
    const ent = this.cache.get(jeton);
    if (ent !== undefined && ent.expire > t) return ent.ident;
    let ident: IdentiteJeton | null;
    try {
      ident = this.resoudre ? await this.resoudre(jeton) : null;
    } catch (e) {
      journalDe("outils-mcp").warn(`vérification du jeton personnel impossible : ${String(e)}`);
      ident = null;
    }
    if (ident !== null && !veritePy(ident.username)) ident = null;
    this.cache.set(jeton, { ident, expire: t + (ident ? TTL_JETON_S : TTL_JETON_NEGATIF_S) });
    if (this.cache.size > 512)
      for (const [k] of [...this.cache].filter(([, v]) => v.expire <= t).slice(0, 256)) this.cache.delete(k);
    return ident;
  }

  /** `verify_token` : jeton d'accès, ou `null` (401). */
  async verifier(jeton: string): Promise<JetonAcces | null> {
    if (jeton.startsWith(DELEGATION_TOKEN_PREFIX)) {
      const deleg = verifyDelegation(
        jeton,
        this.jetonService,
        this.maintenant ? { now: this.maintenant() } : {},
      );
      return deleg ? jetonDelegue(jeton, deleg) : null;
    }
    const claims = this.dansTable(jeton);
    if (claims !== null)
      return {
        token: jeton,
        client_id: strPy(claims["client_id"]),
        scopes: Array.isArray(claims["scopes"]) ? claims["scopes"].map((s) => strPy(s)) : [],
        expires_at: null,
        claims,
      };
    if (!jeton || !PREFIXES_PERSONNELS.some((p) => jeton.startsWith(p))) return null;
    let ident = await this.personnel(jeton);
    if (ident === null && this.introspection?.actif) {
      try {
        const d = await this.introspection.introspectToken(jeton);
        ident =
          d && typeof d.username === "string" && stripPy(d.username) !== ""
            ? {
                username: d.username,
                kind: strPy(veritePy(d.kind) ? d.kind : "opencode"),
                families: (Array.isArray(d.families) ? d.families : []).map((f) => strPy(f)),
              }
            : null;
      } catch {
        ident = null;
      }
    }
    if (ident === null) return null;
    const compte = ident.username;
    if (ident.kind === "tools")
      return {
        token: jeton,
        client_id: `${TOOLS_CLIENT_PREFIX}${compte}`,
        scopes: [SCOPE_LOCAL_TOOLS],
        expires_at: null,
        claims: {
          username: compte,
          trusted_meta: false,
          client_kind: "tools",
          families: ident.families.map((f) => strPy(f)),
          scopes: [SCOPE_LOCAL_TOOLS],
        },
      };
    return {
      token: jeton,
      client_id: `${OPENCODE_CLIENT_PREFIX}${compte}`,
      scopes: [SCOPE_LOCAL_TOOLS],
      expires_at: null,
      claims: { username: compte, trusted_meta: false, client_kind: "opencode", scopes: [SCOPE_LOCAL_TOOLS] },
    };
  }
}

/** `_auth_provider` : vérificateur dès qu'un jeton est configuré, `null` sans aucun (boucle locale seule) ; configuration incohérente refusée. */
export function creerVerificateur(
  o: {
    jetons?: ReturnType<typeof chargerJetons>;
    resoudre?: ResolveurJetonPersonnel | null;
    introspection?: PortIntrospection | null;
  } = {},
): VerificateurJetons | null {
  const j = o.jetons ?? chargerJetons();
  const erreur = erreurConfigJetons(j.service, j.clients);
  if (erreur !== null) throw new Error(erreur);
  const table = construireTable(j.service, j.clients, j.familles);
  if (table.size === 0) return null;
  return new VerificateurJetons({
    table,
    resoudre: o.resoudre ?? null,
    introspection: o.introspection ?? null,
  });
}

/** `bind_allowed` : sans jeton, seul le bouclage local est une frontière acceptable. */
export function liaisonPermise(hote: string, avecJetons: boolean): boolean {
  return avecJetons || ["127.0.0.1", "localhost", "::1"].includes(stripPy(hote || "").toLowerCase());
}
