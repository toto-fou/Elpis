// SPDX-License-Identifier: MIT
/** apps/toolhost/src/mcp/changements.ts — fichiers modifiés par une commande (shell, script de skill, action git) : relevé avant/après par l'agent, historique de session et `files_changed` (llm_core/tools/_work_changes.py). */
import { estDict, journalDe, longueurPy, splitlinesPy, unifiedDiff } from "@elpis/commun";
import type { Dict } from "@elpis/commun";
import { safeSandboxName } from "@elpis/config";
import {
  AgentError,
  base64Strict,
  currentSession,
  MAX_FILE,
  recordWrite,
  shaOf,
  TOO_BIG,
  UNKNOWN,
} from "@elpis/fichiers";
import type { ContenuHistorique } from "@elpis/fichiers";
import { userIdFor } from "@elpis/securite";

import { Espace } from "./espace";
import { typeAffiche } from "./fs/acces";

export const SKIP_DIRS: ReadonlySet<string> = new Set([
  ".git", ".hg", ".svn", "node_modules", ".venv", "venv", "env", "__pycache__",
  ".mypy_cache", ".pytest_cache", ".ruff_cache", ".tox", ".cache", ".npm",
  ".yarn", ".gradle", ".m2", "target", "dist", "build", ".next", ".nuxt",
  ".tool-output", ".bg", ".trash", ".Trash",
]); // prettier-ignore
export const MAX_ENTRIES = 20_000;
export const SCAN_BUDGET_S = 1.5;
export const MAX_RETURNED = 32 * 1024 * 1024;
export const MAX_RECORDED = 200;
export const MAX_REPORTED = 50;
/** Fenêtre jamais close oubliée au bout d'une heure (comme un relevé de l'agent). */
export const FENETRE_MAX_MS = 3_600_000;
/** `files_changed` d'une fenêtre qu'un autre relevé du même compte a chevauchée (harnais N-10). */
export const NOTE_CONCURRENTE =
  "Other commands of this account ran at the same time: files_changed may include their changes and miss some of this one's.";

/** Relevés ouverts par bac (ce processus) : seul moyen de savoir qu'une différence avant/après peut venir d'un autre appel. */
const ouverts = new Map<string, Map<WorkChanges, number>>();

/** État rendu par l'agent → octets, `null` (absent) ou marqueur de l'historique (`UNKNOWN`, `TOO_BIG`). */
export function contenuRendu(d: unknown): ContenuHistorique {
  if (d !== null && typeof d === "object" && typeof (d as Dict)["b64"] === "string") {
    return base64Strict((d as Dict)["b64"] as string) ?? UNKNOWN;
  }
  const etat = d !== null && typeof d === "object" ? (d as Dict)["state"] : null;
  if (etat === "absent") return null;
  return etat === "too_big" ? TOO_BIG : UNKNOWN;
}

function connu(c: ContenuHistorique): c is Uint8Array {
  return c instanceof Uint8Array;
}

const DECODEUR = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** Lignes ajoutées et retirées (`unified_diff` sans contexte), `null` hors UTF-8 ou au-delà de 4 Mio de texte. */
export function statsLignes(avant: Uint8Array, apres: Uint8Array): [number, number] | null {
  let a: string;
  let b: string;
  try {
    a = DECODEUR.decode(avant);
    b = DECODEUR.decode(apres);
  } catch {
    return null;
  }
  if (longueurPy(a) + longueurPy(b) > 4 * 1024 * 1024) return null;
  return compterDiff(splitlinesPy(a), splitlinesPy(b));
}

/** `+X/-Y` d'un `unified_diff(n=0)` : les en-têtes `+++`/`---` (et les lignes qui leur ressemblent) ne comptent pas. */
export function compterDiff(a: readonly string[], b: readonly string[]): [number, number] {
  let ajout = 0;
  let retrait = 0;
  for (const ligne of unifiedDiff(a, b, { n: 0 })) {
    if (ligne.startsWith("+") && !ligne.startsWith("+++")) ajout++;
    else if (ligne.startsWith("-") && !ligne.startsWith("---")) retrait++;
  }
  return [ajout, retrait];
}

/** Entrée `files_changed` d'un lien ou d'un fichier spécial (harnais B-10) : type, cible, et ce qui a changé (`old_type`, `old_target`). */
export function entreeAutre(chemin: string, change: string, ent: Dict): Dict {
  const etat = (cle: string): Dict | null => {
    const v = ent[cle];
    return estDict(v) && typeof v["kind"] === "string" ? v : null;
  };
  const avant = change === "created" ? null : etat("before");
  const apres = change === "deleted" ? null : etat("after");
  const vu = apres ?? avant;
  const e: Dict = { path: chemin, change, type: typeAffiche(vu?.["kind"] ?? ent["kind"]) };
  if (typeof vu?.["target"] === "string") e["target"] = vu["target"];
  if (apres !== null && avant !== null) {
    const typeAvant = typeAffiche(avant["kind"]);
    if (typeAvant !== e["type"]) e["old_type"] = typeAvant;
    if (typeof avant["target"] === "string" && avant["target"] !== e["target"])
      e["old_target"] = avant["target"];
  }
  return e;
}

/** `async with WorkChanges(uid, username, root, source)` : `entrer()`, la commande, `sortir()`, puis `changes` et `total`. */
export class WorkChanges {
  readonly changes: Dict[] = [];
  total = 0;
  private espace: Espace | null = null;
  private ident: string | null = null;
  private readonly prefixe: string;
  private chevauche = false;
  private readonly bac: string;
  readonly uid: number | null;
  readonly username: string;
  readonly source: string;

  constructor(uid: number | null, username: string, source = "shell", containerPrefix = "/work") {
    this.uid = uid;
    this.username = username;
    this.source = source;
    this.prefixe = containerPrefix.replace(/\/+$/u, "");
    this.bac = safeSandboxName(username);
  }

  /** Vrai si un autre relevé du même compte était ouvert pendant celui-ci. */
  get concurrent(): boolean {
    return this.chevauche;
  }

  /** Fenêtre ouverte AVANT le relevé de début : elle et celles déjà ouvertes du bac se marquent l'une l'autre. */
  private ouvrir(): void {
    const fenetres = ouverts.get(this.bac) ?? new Map<WorkChanges, number>();
    const maintenant = Date.now();
    for (const [w, debut] of fenetres) {
      if (maintenant - debut > FENETRE_MAX_MS) {
        fenetres.delete(w);
        continue;
      }
      w.chevauche = true;
      this.chevauche = true;
    }
    fenetres.set(this, maintenant);
    ouverts.set(this.bac, fenetres);
  }

  private fermer(): void {
    const fenetres = ouverts.get(this.bac);
    fenetres?.delete(this);
    if (fenetres?.size === 0) ouverts.delete(this.bac);
  }

  /** Relevé avant la commande ; jamais d'erreur (relevé raté : pas de `files_changed`). */
  async entrer(): Promise<this> {
    this.ouvrir();
    try {
      this.espace = await Espace.pour(this.username);
      const r = await this.espace.releveDebut([...SKIP_DIRS].sort(), {
        maxEntries: MAX_ENTRIES,
        deadlineS: SCAN_BUDGET_S,
        allKinds: true,
      });
      this.ident =
        Array.from(String(r["id"] || ""))
          .slice(0, 64)
          .join("") || null;
    } catch {
      this.ident = null;
    }
    return this;
  }

  async sortir(): Promise<void> {
    try {
      await this.collecter();
    } catch {
      // relevé raté : la commande ne doit pas échouer
    } finally {
      this.fermer();
    }
  }

  private async collecter(): Promise<void> {
    if (this.ident === null || this.espace === null) return;
    let entrees: Dict[];
    let bilan: Dict;
    try {
      [entrees, bilan] = await this.espace.releveFin(this.ident, {
        maxFiles: MAX_RECORDED,
        maxBytes: MAX_RETURNED,
        maxFile: MAX_FILE,
      });
    } catch (e) {
      if (!(e instanceof AgentError)) throw e;
      journalDe("work_changes").info(
        `[work_changes] relevé ${this.source} non clos (${e.code}) : pas de files_changed`,
      );
      return;
    }
    this.total = Number(bilan["total"] || 0);
    if (!entrees.length) return;
    if (this.uid !== null) {
      try {
        await currentSession(this.uid);
      } catch {
        // session créée au premier enregistrement
      }
    }
    for (const ent of entrees) {
      const rel = String(ent["path"]);
      const kind = ent["change"];
      if (kind !== "created" && kind !== "modified" && kind !== "deleted") continue;
      if (typeof ent["kind"] === "string" && ent["kind"] !== "file") {
        if (this.changes.length < MAX_REPORTED)
          this.changes.push(entreeAutre(`${this.prefixe}/${rel}`, kind, ent));
        continue;
      }
      const avant = kind === "created" ? null : contenuRendu(ent["before"]);
      const apres = kind === "deleted" ? null : contenuRendu(ent["after"]);
      if (kind !== "deleted" && apres === null) continue;
      if (this.uid !== null) await recordWrite(this.uid, rel, avant, apres, this.source);
      if (this.changes.length < MAX_REPORTED) {
        const e: Dict = {
          path: `${this.prefixe}/${rel}`,
          change: kind,
          old_sha256: shaOf(avant),
          new_sha256: shaOf(apres),
        };
        if ((avant === null || connu(avant)) && connu(apres)) {
          const st = statsLignes(avant ?? new Uint8Array(), apres);
          if (st !== null) [e["lines_added"], e["lines_removed"]] = st;
        }
        this.changes.push(e);
      }
    }
  }

  /** Ajoute `files_changed` (le total si tronqué ; chevauché par un autre relevé : la note et `files_changed_attribution: "uncertain"`) à un résultat. */
  attach<T>(resultat: T): T {
    if (
      this.changes.length &&
      resultat !== null &&
      typeof resultat === "object" &&
      !Array.isArray(resultat)
    ) {
      const r = resultat as Dict;
      r["files_changed"] = this.changes;
      if (this.total > this.changes.length) r["files_changed_total"] = this.total;
      if (this.chevauche) {
        r["files_changed_note"] = NOTE_CONCURRENTE;
        r["files_changed_attribution"] = "uncertain";
      }
    }
    return resultat;
  }
}

/** `uid_for` : id du compte (enveloppe, sinon base), `null` si inconnu. */
export async function uidFor(username: string): Promise<number | null> {
  try {
    return (await userIdFor(username)) || null;
  } catch {
    return null;
  }
}

/** `tracked(source, root_for)` : relevé autour de `fn` si `spec` rend `(uid, compte)`, `files_changed` ajouté au résultat. */
export async function avecChangements<T>(
  source: string,
  spec: (() => Promise<readonly [number | null, string] | null>) | null,
  fn: () => Promise<T>,
): Promise<T> {
  let cible: readonly [number | null, string] | null;
  try {
    cible = spec === null ? null : await spec();
  } catch {
    cible = null;
  }
  if (cible === null) return fn();
  const wc = await new WorkChanges(cible[0], cible[1], source).entrer();
  let res: T;
  try {
    res = await fn();
  } finally {
    await wc.sortir();
  }
  return wc.attach(res);
}
