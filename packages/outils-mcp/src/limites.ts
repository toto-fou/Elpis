// SPDX-License-Identifier: MIT
/** packages/outils-mcp/src/limites.ts — limite de débit par (compte, outil) et limite de concurrence des appels (llm_core/tools/_mcp_compliance_middleware.py). */
import { floatPy, intPy, stripPy } from "@elpis/commun";

function lireEnv<T>(nom: string, defaut: T, lire: (s: string) => T): T {
  try {
    const brut = stripPy(process.env[nom] ?? "");
    return brut ? lire(brut) : defaut;
  } catch {
    return defaut;
  }
}

export const RATE_RPS = lireEnv("MCP_TOOL_RATE_LIMIT_RPS", 20.0, floatPy);
export const RATE_BURST =
  lireEnv("MCP_TOOL_RATE_LIMIT_BURST", 0, intPy) || Math.trunc(Math.max(1.0, RATE_RPS) * 2);
export const CONC_MAX = lireEnv("MCP_TOOL_MAX_CONCURRENT", 48, intPy);
export const CONC_PER_USER = lireEnv("MCP_TOOL_MAX_CONCURRENT_PER_USER", 12, intPy);
export const CONC_WAIT_S = lireEnv("MCP_TOOL_QUEUE_WAIT_S", 30.0, floatPy);

/** Erreur de limite rendue en résultat `isError` (texte = message). */
export class ErreurOutil extends Error {
  override name = "ToolError";
}

/** `TokenBucketRateLimiter` de FastMCP : seau plein au départ, rempli au fil du temps écoulé. */
export class SeauJetons {
  readonly capacite: number;
  readonly debit: number;
  private jetons: number;
  private dernier = Date.now() / 1000;

  constructor(capacite: number, debit: number) {
    this.capacite = capacite;
    this.debit = debit;
    this.jetons = capacite;
  }

  consommer(n = 1): boolean {
    const maintenant = Date.now() / 1000;
    this.jetons = Math.min(this.capacite, this.jetons + (maintenant - this.dernier) * this.debit);
    this.dernier = maintenant;
    if (this.jetons >= n) {
      this.jetons -= n;
      return true;
    }
    return false;
  }
}

/** Seau par `<compte>::<outil>` (« * » sans identité) ; au-delà, `Rate limit exceeded for tool '<outil>'`. */
export class LimiteDebit {
  private readonly seaux = new Map<string, SeauJetons>();
  private readonly rps: number;
  private readonly rafale: number;

  constructor(rps: number = RATE_RPS, rafale: number = RATE_BURST) {
    this.rps = rps;
    this.rafale = Math.max(1, Math.trunc(rafale));
  }

  /** Lève `ErreurOutil` si le seau est vide ; désactivée si `rps <= 0`. */
  verifier(compte: string | null, outil: string): void {
    if (this.rps <= 0) return;
    const cle = `${compte || "*"}::${outil}`;
    let seau = this.seaux.get(cle);
    if (seau === undefined) {
      seau = new SeauJetons(this.rafale, this.rps);
      this.seaux.set(cle, seau);
    }
    if (!seau.consommer()) throw new ErreurOutil(`Rate limit exceeded for tool '${outil}'`);
  }
}

interface Attente {
  compte: string;
  reveiller: () => void;
}

/** Appels simultanés plafonnés au total et par compte ; attente bornée dans une file bornée, puis erreur lisible par le modèle. */
export class LimiteConcurrence {
  private enCours = 0;
  private readonly parCompte = new Map<string, number>();
  private attente = 0;
  private readonly attenteParCompte = new Map<string, number>();
  private readonly fileMax: number;
  private readonly attendus = new Set<Attente>();
  private readonly maxTotal: number;
  private readonly maxCompte: number;
  private readonly attenteS: number;

  constructor(
    maxTotal: number = CONC_MAX,
    maxCompte: number = CONC_PER_USER,
    attenteS: number = CONC_WAIT_S,
  ) {
    this.maxTotal = maxTotal;
    this.maxCompte = maxCompte;
    this.attenteS = Math.max(0, attenteS);
    this.fileMax = maxTotal > 0 ? 2 * maxTotal : 256;
  }

  get actifs(): number {
    return this.enCours;
  }

  private libre(compte: string): boolean {
    if (this.maxTotal > 0 && this.enCours >= this.maxTotal) return false;
    return !(compte && this.maxCompte > 0 && (this.parCompte.get(compte) ?? 0) >= this.maxCompte);
  }

  private occupe(compte: string): string {
    if (compte && this.maxCompte > 0 && (this.parCompte.get(compte) ?? 0) >= this.maxCompte)
      return (
        `Too many tool calls running for this account (${this.maxCompte} at once); ` +
        "wait for the running ones (e.g. a long execute_shell) to finish, then retry."
      );
    return `Tool host busy (${this.enCours} tool calls running for all users); retry in a moment.`;
  }

  private ajuster(carte: Map<string, number>, compte: string, delta: number): void {
    if (!compte) return;
    const n = (carte.get(compte) ?? 0) + delta;
    if (n > 0) carte.set(compte, n);
    else carte.delete(compte);
  }

  /** Attend une place (au plus `attenteS`) ; la place réservée se rend par `liberer`. */
  private async attendre(compte: string, signal: AbortSignal | undefined): Promise<void> {
    const enFile = compte ? (this.attenteParCompte.get(compte) ?? 0) : 0;
    if (this.attente >= this.fileMax || (compte && this.maxCompte > 0 && enFile >= this.maxCompte))
      throw new ErreurOutil(this.occupe(compte));
    this.attente++;
    this.ajuster(this.attenteParCompte, compte, 1);
    const limite = performance.now() + this.attenteS * 1000;
    try {
      while (!this.libre(compte)) {
        const reste = limite - performance.now();
        if (reste <= 0 || signal?.aborted) throw new ErreurOutil(this.occupe(compte));
        await new Promise<void>((fin) => {
          const a: Attente = { compte, reveiller: () => fin() };
          const minuterie = setTimeout(() => a.reveiller(), Math.min(reste, 50));
          a.reveiller = () => {
            clearTimeout(minuterie);
            this.attendus.delete(a);
            fin();
          };
          this.attendus.add(a);
        });
      }
    } finally {
      this.attente--;
      this.ajuster(this.attenteParCompte, compte, -1);
    }
  }

  /** `on_call_tool` : `fn` exécutée une fois une place prise ; `<= 0` désactive un plafond. */
  async executer<T>(compte: string | null, fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (this.maxTotal <= 0 && this.maxCompte <= 0) return fn();
    const c = compte ?? "";
    if (!this.libre(c)) await this.attendre(c, signal);
    this.enCours++;
    this.ajuster(this.parCompte, c, 1);
    try {
      return await fn();
    } finally {
      this.enCours--;
      this.ajuster(this.parCompte, c, -1);
      for (const a of [...this.attendus]) a.reveiller();
    }
  }
}
