// SPDX-License-Identifier: MIT
/** packages/rag/src/decoupage-fil.ts — découpage avec regex dans un thread propre à chaque appel, tué à l'échéance : un motif d'utilisateur n'occupe jamais la boucle d'événements ; sans regex, sur place. */
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parentPort, Worker, workerData } from "node:worker_threads";

import { decouperAvecRedecoupes } from "./decoupage";
import type { Bloc, OptionsDecoupage, ParamsDecoupage, Redecoupe } from "./decoupage";
import { ErreurRag } from "./erreurs";
import type { CodeErreurRag } from "./erreurs";

type ResultatDecoupage = ReturnType<typeof decouperAvecRedecoupes>;

interface TravailFil {
  elpis: "decoupage";
  blocs: readonly Bloc[];
  params: Partial<ParamsDecoupage> | undefined;
  redecoupes: readonly Redecoupe[];
  options: OptionsDecoupage;
}

type ReponseFil = { resultat: ResultatDecoupage } | { code: CodeErreurRag; message: string };

/** `delaiMs` : limite du document entier, au-delà de laquelle le thread est tué ; `signal` : abandon par l'appelant. */
export interface OptionsHorsBoucle extends Pick<OptionsDecoupage, "regexStricte" | "regexLenteFatale"> {
  delaiMs: number;
  signal?: AbortSignal | undefined;
}

/** `decoupage-fil.mjs` à côté du bundle, sinon `decoupage-fil.ts` (sources, chargé par tsx) ; `null` si aucun n'est là. */
function urlDuFil(): URL | null {
  return (
    ["./decoupage-fil.mjs", "./decoupage-fil.ts"]
      .map((nom) => new URL(nom, import.meta.url))
      .find((u) => u.protocol === "file:" && existsSync(fileURLToPath(u))) ?? null
  );
}

/** `decouperAvecRedecoupes` hors de la boucle dès qu'une regex peut tourner : `delai` au-delà de `delaiMs`, `fil_decoupage` si le thread manque ou meurt, jamais de repli sur place pour une regex. */
export async function decouperHorsBoucle(
  blocs: readonly Bloc[],
  params: Partial<ParamsDecoupage> | undefined,
  redecoupes: readonly Redecoupe[],
  o: OptionsHorsBoucle,
): Promise<ResultatDecoupage> {
  const options: OptionsDecoupage = {
    regexStricte: o.regexStricte,
    regexLenteFatale: o.regexLenteFatale,
    echeance: Date.now() + o.delaiMs,
  };
  if (![params, ...redecoupes.map((r) => r.params)].some((p) => p?.methode === "regex"))
    return decouperAvecRedecoupes(blocs, params, redecoupes, options);
  o.signal?.throwIfAborted();
  const url = urlDuFil();
  if (url === null) throw new ErreurRag("fil_decoupage", "thread de découpage absent");
  return new Promise<ResultatDecoupage>((ok, ko) => {
    const travail: TravailFil = { elpis: "decoupage", blocs, params, redecoupes, options };
    const w = new Worker(url, {
      name: "elpis-rag-decoupage",
      workerData: travail,
      ...(url.pathname.endsWith(".ts") ? { execArgv: ["--import", "tsx"] } : {}),
    });
    const finir = (issue: () => void): void => {
      clearTimeout(minuterie);
      o.signal?.removeEventListener("abort", surAbandon);
      void w.terminate();
      issue();
    };
    const surAbandon = (): void => finir(() => ko(o.signal?.reason as unknown));
    const minuterie = setTimeout(
      () => finir(() => ko(new ErreurRag("delai", "découpage trop long"))),
      o.delaiMs,
    );
    o.signal?.addEventListener("abort", surAbandon, { once: true });
    w.on("message", (m: ReponseFil) =>
      finir(() => ("resultat" in m ? ok(m.resultat) : ko(new ErreurRag(m.code, m.message)))),
    );
    w.on("error", (e) => finir(() => ko(new ErreurRag("fil_decoupage", e.message, undefined, e))));
    w.on("exit", (code) =>
      finir(() => ko(new ErreurRag("fil_decoupage", `thread de découpage arrêté (code ${code})`))),
    );
  });
}

/** Côté thread : le travail reçu au démarrage, sa réponse, puis fin. */
function servir(t: TravailFil): void {
  let reponse: ReponseFil;
  try {
    reponse = { resultat: decouperAvecRedecoupes(t.blocs, t.params, t.redecoupes, t.options) };
  } catch (e) {
    reponse =
      e instanceof ErreurRag
        ? { code: e.code, message: e.message }
        : { code: "fil_decoupage", message: e instanceof Error ? e.message : String(e) };
  }
  parentPort?.postMessage(reponse);
}

const travailRecu = workerData as TravailFil | null;
if (travailRecu?.elpis === "decoupage") servir(travailRecu);
