// SPDX-License-Identifier: MIT
/** apps/toolhost/src/fichiers/calcul-execution.ts — remplacements et texte des .docx calculés dans un thread propre à chaque requête (calcul-fil.ts), tué à l'échéance sans toucher aux autres ; sur place si le thread ne peut pas démarrer. */
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";

import { HttpError } from "@elpis/commun";

import { traiter } from "./calcul-fil";
import type { RequeteFil, ReponseFil, ResultatFil } from "./calcul-fil";
import type { SpecRemplacement } from "./remplacement";

/** Marge laissée au thread au-delà de l'échéance d'un lot avant de le tuer. */
const GRACE_MS = 2_000;
/** Délai d'un fichier à l'application (le Python n'en a pas : son thread reste occupé). */
export const DELAI_UN_MS = 30_000;
/** Délai du texte d'un .docx (10 Mo au plus ; le Python n'en a pas). */
export const DELAI_DOCX_MS = 60_000;

/** Échéance dépassée ou thread arrêté : la requête n'a pas abouti. */
export class DelaiCalcul extends Error {
  override name = "DelaiCalcul";
}

/** `calcul-fil.mjs` à côté du bundle, sinon `calcul-fil.ts` (sources, chargé par tsx) ; `null` si aucun n'est là. */
function urlDuFil(): URL | null {
  return (
    ["./calcul-fil.mjs", "./calcul-fil.ts"]
      .map((nom) => new URL(nom, import.meta.url))
      .find((u) => u.protocol === "file:" && existsSync(fileURLToPath(u))) ?? null
  );
}

const vivantes = new Set<SessionCalcul>();

type SansId<T> = T extends unknown ? Omit<T, "id"> : never;

/** Thread d'UNE requête : ses lots et ses fichiers passent dans l'ordre ; une échéance dépassée ne tue que lui. */
export class SessionCalcul {
  private w: Worker | null = null;
  private suivant = 0;
  private readonly attentes = new Map<number, { ok: (r: ReponseFil) => void; ko: (e: Error) => void }>();

  private demarrer(): Worker | null {
    const url = urlDuFil();
    if (url === null) return null;
    const w = new Worker(url, {
      workerData: { elpis: "calcul" },
      ...(url.pathname.endsWith(".ts") ? { execArgv: ["--import", "tsx"] } : {}),
    });
    w.on("message", (m: ReponseFil) => {
      if ("pret" in m) return;
      const a = this.attentes.get(m.id);
      if (a === undefined) return;
      this.attentes.delete(m.id);
      a.ok(m);
    });
    const fin = (): void => {
      if (this.w === w) this.w = null;
      const enCours = [...this.attentes.values()];
      this.attentes.clear();
      for (const a of enCours) a.ko(new DelaiCalcul("thread de calcul arrêté"));
    };
    w.on("error", fin);
    w.on("exit", fin);
    return w;
  }

  /** Requête au thread (démarré à la demande), tué si elle dépasse `delaiMs`. */
  private executer(r: SansId<RequeteFil>, delaiMs: number): Promise<ReponseFil> {
    const requete = { ...r, id: (this.suivant += 1) } as RequeteFil;
    this.w ??= this.demarrer();
    const w = this.w;
    if (w === null) return Promise.resolve(traiter(requete));
    vivantes.add(this);
    return new Promise<ReponseFil>((ok, ko) => {
      const minuterie = setTimeout(() => void this.fermer(), Math.max(0, delaiMs));
      this.attentes.set(requete.id, {
        ok: (m) => {
          clearTimeout(minuterie);
          ok(m);
        },
        ko: (e) => {
          clearTimeout(minuterie);
          ko(e);
        },
      });
      w.postMessage(requete);
    });
  }

  /** Aperçu d'un lot : `[chemin, résultat]` dans l'ordre (arrêt à `place` ou à l'échéance) ; `null` si le thread a dû être tué. */
  async lot(
    spec: SpecRemplacement,
    chemins: string[],
    contenus: (Uint8Array | null)[],
    place: number,
    echeance: number,
  ): Promise<[string, ResultatFil][] | null> {
    try {
      const m = await this.executer(
        { op: "lot", spec, chemins, contenus, place, echeance },
        echeance - Date.now() + GRACE_MS,
      );
      return resultat(m, "lot");
    } catch (e) {
      if (e instanceof DelaiCalcul) return null;
      throw e;
    }
  }

  /** Application à un fichier relu : nouveau texte, raison ou rien ; `DelaiCalcul` au-delà de `delaiMs`. */
  async un(
    spec: SpecRemplacement,
    entree: { kind: unknown; link?: unknown },
    brut: Uint8Array | null,
    delaiMs = DELAI_UN_MS,
  ): Promise<ResultatFil> {
    return resultat(await this.executer({ op: "un", spec, entree, brut }, delaiMs), "un");
  }

  /** `_texte_docx` : texte brut d'un .docx ; `DelaiCalcul` au-delà de `delaiMs`. */
  async docx(donnees: Uint8Array, delaiMs = DELAI_DOCX_MS): Promise<string> {
    return resultat(await this.executer({ op: "docx", donnees }, delaiMs), "docx");
  }

  /** Thread tué (requêtes en cours : `DelaiCalcul`). */
  async fermer(): Promise<void> {
    vivantes.delete(this);
    const w = this.w;
    this.w = null;
    if (w !== null) await w.terminate();
  }
}

function resultat<T>(m: ReponseFil, cle: "lot" | "un" | "docx"): T {
  if ("erreur" in m) {
    const e = m.erreur;
    if (e.statut !== undefined) throw new HttpError(e.statut, e.detail);
    throw Object.assign(new Error(e.message), { name: e.nom });
  }
  return (m as Record<string, unknown>)[cle] as T;
}

/** `f` avec un thread propre à la requête, tué à la fin. */
export async function avecFilCalcul<T>(f: (s: SessionCalcul) => Promise<T>): Promise<T> {
  const s = new SessionCalcul();
  try {
    return await f(s);
  } finally {
    await s.fermer();
  }
}

/** Arrêt de l'hôte : threads encore vivants tués. */
export async function arreterFilsCalcul(): Promise<void> {
  await Promise.all([...vivantes].map((s) => s.fermer()));
}
