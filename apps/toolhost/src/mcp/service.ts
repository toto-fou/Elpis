// SPDX-License-Identifier: MIT
/** apps/toolhost/src/mcp/service.ts — service MCP amont (elpis-tools) vu par l'hôte : protection et familles vérifiées avant tout relais, outils par famille (`TOOL_FAMILY_OF`) pour /health et /manifest. */
import { FAMILY_NAMES } from "@elpis/mcp";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { request } from "undici";
import type { Dispatcher } from "undici";

import type { Journal } from "../journal";
import { HTTP_MOUNT_PATH, SSE_MOUNT_PATH } from "../porte";

export type TransportMcp = "http" | "sse";

/** `protege` : refus d'un appel sans jeton (401) ; `ouvert` : appel sans jeton accepté (2xx) alors que l'hôte en exige un ; `non-conforme` : familles hors de `toolhost.json › families` ; `injoignable` : pas de réponse attendue. */
export type EtatAmont = "inconnu" | "protege" | "ouvert" | "non-conforme" | "injoignable";

/** Refus de l'amont à un appel sans jeton, rejoué tel quel par l'hôte. */
export interface Refus401 {
  readonly entetes: Readonly<Record<string, string>>;
  readonly corps: Buffer;
}

export interface OptionsServiceMcp {
  readonly amont: string;
  readonly amontSse: string;
  readonly jeton: string;
  readonly familles: readonly string[];
  /** Familles servies par l'hôte lui-même : un amont qui les sert encore est refusé (non conforme). */
  readonly natives?: readonly string[];
  readonly transports: readonly string[];
  readonly journal: Journal;
  readonly agent: Dispatcher;
  readonly delaiMs?: number;
  /** Durée pendant laquelle une protection vérifiée n'est pas resondée. */
  readonly validiteProtectionMs?: number;
}

const INITIALISATION = JSON.stringify({
  jsonrpc: "2.0",
  id: 0,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "elpis-toolhost-sonde", version: "1" },
  },
});
const CORPS_REFUS_MAX = 4096;

/** Message d'une erreur réseau sans URL ni en-tête (jamais de jeton dans un journal). */
export function decrire(e: unknown): string {
  if (e instanceof Error) {
    const code = (e as { code?: unknown }).code ?? (e.cause as { code?: unknown } | undefined)?.code;
    return `${e.name}${typeof code === "string" ? ` ${code}` : ""}`;
  }
  return typeof e;
}

/** Promesse bornée : au-delà du délai, rend `undefined` sans attendre. */
async function borne<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
  let t: NodeJS.Timeout | undefined;
  const delai = new Promise<undefined>((fin) => {
    t = setTimeout(() => fin(undefined), ms);
  });
  try {
    return await Promise.race([p, delai]);
  } finally {
    clearTimeout(t);
  }
}

export class ServiceMcp {
  readonly amont: string;
  readonly amontSse: string;
  private readonly jeton: string;
  private readonly familles: readonly string[];
  private readonly natives: readonly string[];
  private readonly configures: readonly string[];
  private readonly journal: Journal;
  private readonly agent: Dispatcher;
  private readonly delaiMs: number;
  private readonly validiteMs: number;
  private etats: Record<TransportMcp, EtatAmont> = { http: "inconnu", sse: "inconnu" };
  private protegeJusqua: Record<TransportMcp, number> = { http: 0, sse: 0 };
  private refus: Partial<Record<TransportMcp, Refus401>> = {};
  private conformes: Record<TransportMcp, boolean | null> = { http: null, sse: null };
  private sondes: Partial<Record<TransportMcp, Promise<EtatAmont>>> = {};
  private listes: Partial<Record<TransportMcp, Promise<boolean>>> = {};
  private carte = new Map<string, string>();

  constructor(o: OptionsServiceMcp) {
    this.amont = o.amont;
    this.amontSse = o.amontSse;
    this.jeton = o.jeton;
    this.familles = o.familles;
    this.natives = o.natives ?? [];
    this.configures = o.transports;
    this.journal = o.journal;
    this.agent = o.agent;
    this.delaiMs = o.delaiMs ?? 10_000;
    this.validiteMs = o.validiteProtectionMs ?? 10_000;
  }

  /** `/sse` est servi seulement si `sse` est un transport configuré et qu'un amont SSE est déclaré. */
  get sseServi(): boolean {
    return Boolean(this.amontSse) && this.configures.includes("sse");
  }

  /** Transports réellement relayés, dans l'ordre de la configuration. */
  transports(): string[] {
    return this.configures.filter((t) => (t === "http" ? Boolean(this.amont) : t === "sse" && this.sseServi));
  }

  /** `TOOL_FAMILY_OF` de l'amont (outils visibles), dans l'ordre d'enregistrement des familles. */
  outils(): ReadonlyMap<string, string> {
    return this.carte;
  }

  /** `_families_live` : familles qui ont au moins un outil, ordre canonique. */
  famillesVivantes(): string[] {
    const vivantes = new Set(this.carte.values());
    return FAMILY_NAMES.filter((f) => vivantes.has(f));
  }

  etat(transport: TransportMcp): EtatAmont {
    return this.etats[transport];
  }

  get jetonExige(): boolean {
    return Boolean(this.jeton);
  }

  /** Refus mémorisé à la dernière sonde (rejoué pour un appel sans jeton). */
  refus401(transport: TransportMcp): Refus401 | undefined {
    return this.refus[transport];
  }

  /** Connexion perdue (amont redémarré ?) : protection et familles revérifiées avant le prochain relais. */
  oublierEtat(transport: TransportMcp): void {
    this.protegeJusqua[transport] = 0;
    this.conformes[transport] = null;
  }

  /** Réponse 2xx de l'amont à un appel sans jeton : l'amont n'est pas protégé. */
  signalerOuvert(transport: TransportMcp): void {
    if (this.etats[transport] !== "ouvert")
      this.journal.error(
        `amont MCP ${transport} sans authentification alors que l'hôte exige un jeton : relais refusé (poser LOCAL_MCP_TOKEN sur elpis-tools)`,
      );
    this.etats[transport] = "ouvert";
    this.protegeJusqua[transport] = 0;
  }

  /** Relais permis : protection vérifiée depuis moins de `validiteProtectionMs` (si l'hôte a un jeton), familles de l'amont incluses dans celles de l'hôte. */
  async relaisPermis(transport: TransportMcp): Promise<EtatAmont> {
    if (this.jeton && performance.now() >= this.protegeJusqua[transport]) {
      const e = await this.sonder(transport);
      if (e !== "protege") return e;
    }
    if (this.conformes[transport] !== true && !(await this.lister(transport))) {
      return this.conformes[transport] === false ? "non-conforme" : "injoignable";
    }
    return "protege";
  }

  /** Une sonde à la fois par transport : appel sans jeton, 401 attendu (mémorisé pour être rejoué). */
  sonder(transport: TransportMcp): Promise<EtatAmont> {
    const enCours = this.sondes[transport];
    if (enCours !== undefined) return enCours;
    const sonde = this.sonderUneFois(transport).finally(() => {
      delete this.sondes[transport];
    });
    this.sondes[transport] = sonde;
    return sonde;
  }

  private async sonderUneFois(transport: TransportMcp): Promise<EtatAmont> {
    const base = transport === "http" ? this.amont : this.amontSse;
    if (!base) return "injoignable";
    const signal = AbortSignal.timeout(Math.min(this.delaiMs, 5_000));
    let etat: EtatAmont;
    try {
      const r =
        transport === "http"
          ? await request(base + HTTP_MOUNT_PATH, {
              dispatcher: this.agent,
              method: "POST",
              headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
              body: INITIALISATION,
              signal,
              responseHeaders: "raw",
            })
          : await request(base + SSE_MOUNT_PATH, {
              dispatcher: this.agent,
              method: "GET",
              signal,
              responseHeaders: "raw",
            });
      r.body.on("error", () => undefined);
      if (r.statusCode === 401) {
        this.refus[transport] = {
          entetes: entetesDeRefus(r.headers as unknown as string[]),
          corps: await lireBorne(r.body),
        };
        etat = "protege";
      } else {
        r.body.destroy();
        etat = r.statusCode >= 200 && r.statusCode < 300 ? "ouvert" : "injoignable";
        if (etat === "injoignable")
          this.journal.warn(`amont MCP ${transport} : réponse ${r.statusCode} inattendue à la sonde`);
      }
    } catch (e) {
      this.journal.warn(`amont MCP ${transport} injoignable : ${decrire(e)}`);
      etat = "injoignable";
    }
    if (etat === "ouvert") this.signalerOuvert(transport);
    else this.etats[transport] = etat;
    if (etat === "protege") this.protegeJusqua[transport] = performance.now() + this.validiteMs;
    return etat;
  }

  /** Outils de l'amont listés famille par famille ; vrai si toutes les familles répondent et qu'aucune hors de l'hôte n'a d'outil. */
  lister(transport: TransportMcp, signal?: AbortSignal): Promise<boolean> {
    const enCours = this.listes[transport];
    if (enCours !== undefined) return enCours;
    const liste = this.listerUneFois(transport, signal).finally(() => {
      delete this.listes[transport];
    });
    this.listes[transport] = liste;
    return liste;
  }

  private async listerUneFois(transport: TransportMcp, signal?: AbortSignal): Promise<boolean> {
    if (!(transport === "http" ? this.amont : this.amontSse)) return false;
    const carte = new Map<string, string>();
    const hors: string[] = [];
    for (const fam of FAMILY_NAMES) {
      if (signal?.aborted) return false;
      let noms: string[];
      try {
        noms = await this.outilsDe(transport, fam, signal);
      } catch (e) {
        this.journal.warn(`outils MCP (${transport}) de la famille ${fam} non listés : ${decrire(e)}`);
        this.conformes[transport] = null;
        return false;
      }
      if (!this.familles.includes(fam) || this.natives.includes(fam)) {
        if (noms.length > 0) hors.push(fam);
        continue;
      }
      for (const nom of noms) if (!carte.has(nom)) carte.set(nom, fam);
    }
    if (hors.length > 0) {
      if (this.conformes[transport] !== false)
        this.journal.error(
          `amont MCP ${transport} : familles ${hors.join(", ")} hors de toolhost.json › families ou servies nativement par l'hôte : relais refusé (LOCAL_MCP_TOOL_FAMILIES d'elpis-tools = families − familles_natives)`,
        );
      this.conformes[transport] = false;
      return false;
    }
    this.conformes[transport] = true;
    if (transport === "http") this.carte = carte;
    return true;
  }

  /** Liste sur l'amont HTTP (outils de /health et /manifest). */
  rafraichir(signal?: AbortSignal): Promise<boolean> {
    return this.lister("http", signal);
  }

  private async outilsDe(transport: TransportMcp, fam: string, signal?: AbortSignal): Promise<string[]> {
    const requestInit = { headers: this.jeton ? { authorization: `Bearer ${this.jeton}` } : {} };
    const cible =
      transport === "http"
        ? new StreamableHTTPClientTransport(new URL(`${this.amont}${HTTP_MOUNT_PATH}/${fam}`), {
            requestInit,
          })
        : new SSEClientTransport(new URL(`${this.amontSse}${SSE_MOUNT_PATH}/${fam}`), { requestInit });
    const client = new Client({ name: "elpis-toolhost", version: "1" });
    const options = { timeout: this.delaiMs, ...(signal ? { signal } : {}) };
    try {
      await client.connect(cible, options);
      if (!client.getServerCapabilities()?.tools) return [];
      const noms: string[] = [];
      let curseur: string | undefined;
      do {
        const page = await client.listTools(curseur ? { cursor: curseur } : {}, options);
        noms.push(...page.tools.map((t) => t.name));
        curseur = page.nextCursor;
      } while (curseur);
      return noms;
    } finally {
      if (cible instanceof StreamableHTTPClientTransport)
        await borne(
          cible.terminateSession().catch(() => undefined),
          3_000,
        );
      await borne(
        client.close().catch(() => undefined),
        3_000,
      );
    }
  }

  /** Boucle de fond : protection sondée toutes les 60 s ; outils listés au démarrage, toutes les 15 s tant que l'amont manque, puis toutes les 10 min. */
  async boucle(
    signal: AbortSignal,
    periodes = { sonde: 60_000, echec: 15_000, succes: 600_000 },
  ): Promise<void> {
    let prochaineListe = 0;
    while (!signal.aborted) {
      let pause = periodes.sonde;
      for (const t of ["http", "sse"] as const) {
        if (t === "http" ? !this.amont : !this.sseServi) continue;
        if (this.jeton && (await this.sonder(t)) === "injoignable") pause = Math.min(pause, periodes.echec);
      }
      if (performance.now() >= prochaineListe && (this.amont || this.sseServi)) {
        let ok = true;
        if (this.amont) ok = (await this.lister("http", signal)) && ok;
        if (this.sseServi) ok = (await this.lister("sse", signal)) && ok;
        prochaineListe = performance.now() + (ok ? periodes.succes : periodes.echec);
        if (!ok) pause = Math.min(pause, periodes.echec);
      }
      await attendre(pause, signal);
    }
  }
}

/** En-têtes utiles d'un refus (type, `WWW-Authenticate`), noms en minuscules. */
function entetesDeRefus(brut: readonly string[]): Record<string, string> {
  const garde: Record<string, string> = {};
  for (let i = 0; i + 1 < brut.length; i += 2) {
    const nom = (brut[i] ?? "").toLowerCase();
    if (["content-type", "www-authenticate"].includes(nom) && !(nom in garde)) garde[nom] = brut[i + 1] ?? "";
  }
  return garde;
}

/** Corps d'un refus, borné. */
async function lireBorne(corps: AsyncIterable<unknown> & { destroy(): unknown }): Promise<Buffer> {
  const morceaux: Buffer[] = [];
  let taille = 0;
  for await (const m of corps) {
    const b = Buffer.from(m as Uint8Array);
    morceaux.push(b);
    taille += b.length;
    if (taille > CORPS_REFUS_MAX) {
      corps.destroy();
      break;
    }
  }
  return Buffer.concat(morceaux).subarray(0, CORPS_REFUS_MAX);
}

function attendre(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((fin) => {
    const t = setTimeout(fin, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        fin();
      },
      { once: true },
    );
  });
}
