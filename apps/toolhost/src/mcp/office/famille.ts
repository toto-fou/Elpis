// SPDX-License-Identifier: MIT
/** apps/toolhost/src/mcp/office/famille.ts — famille `office` servie par l'hôte : 7 outils Word et PowerPoint sur les définitions du golden, moteur Python (`office/elpis_office`) en worker, fichiers, graphiques et conversions faits par l'hôte. */
import { existsSync } from "node:fs";
import path from "node:path";

import type { Dict } from "@elpis/commun";
import { racineDepot } from "@elpis/config";
import { py } from "@elpis/http";
import { err, getChatId, getUsername, outilDuGolden } from "@elpis/outils-mcp";
import type { ContexteAppel, DefinitionOutil, Golden } from "@elpis/outils-mcp";
import goldenOffice from "@elpis/outils-mcp/goldens/office.json" with { type: "json" };
import { userIdFor } from "@elpis/securite";

import type { Journal } from "../../journal";
import { convertBytes } from "../../office/apercu";
import { sofficeBin } from "../../office/conversion";
import { Espace } from "../espace";
import type { FabriqueNative } from "../natives";
import { dossierGraphiquesParDefaut, creerRappels, rendreEchartsParNode } from "./rappels";
import type { DepsRappels } from "./rappels";
import { CanalOffice, ErreurWorker } from "./worker";
import type { LanceurWorker } from "./worker";

const GOLDEN = goldenOffice as Golden;

let canalPartage: CanalOffice | null = null;
let lanceurImpose: LanceurWorker | null = null;
let depsImposees: Partial<DepsRappels> | null = null;

/** Tests : lanceur du worker et dépendances des rappels imposés (`null` : les vrais). */
export function installerOffice(o: { lanceur?: LanceurWorker; deps?: Partial<DepsRappels> } | null): void {
  lanceurImpose = o?.lanceur ?? null;
  depsImposees = o?.deps ?? null;
}

/** Arrêt de l'hôte : le worker Python est prié de finir, puis tué après un délai. */
export async function arreterWorkerOffice(): Promise<void> {
  const canal = canalPartage;
  canalPartage = null;
  await canal?.fermer();
}

function scriptRendu(): string {
  return path.join(racineDepot(), "office", "elpis_office", "echarts_ssr.cjs");
}

/** Paramètres `Annotated[Any, …]` du Python : facultatifs à `None` par défaut, tels que le golden les fige. */
function signatureDe(nom: string): DefinitionOutil["signature"] {
  const fonction = GOLDEN.fonctions[nom];
  if (fonction === undefined) throw new Error(`outil absent du golden office : ${nom}`);
  return Object.fromEntries(
    fonction.parametres.map((p) => [p.nom, p.requis ? py.any() : py.any().defaut(p.defaut ?? null)]),
  );
}

function traiterOffice(nom: string, journal: Journal) {
  return async (_args: Dict, ctx: ContexteAppel, brut: Dict): Promise<Dict> => {
    const username = getUsername(ctx);
    const args = Object.fromEntries(Object.entries(brut).filter(([, v]) => v !== null && v !== undefined));
    const soffice = sofficeBin() !== "";
    const deps: DepsRappels = {
      espace: (u) => Espace.pour(u),
      userId: userIdFor,
      convertir: convertBytes,
      rendreEcharts: rendreEchartsParNode(scriptRendu()),
      dossierGraphiques: dossierGraphiquesParDefaut,
      journal,
      ...depsImposees,
    };
    try {
      canalPartage ??= new CanalOffice({ journal, ...(lanceurImpose ? { lanceur: lanceurImpose } : {}) });
      return await canalPartage.appeler({
        outil: nom,
        args,
        contexte: {
          session: `${username}:${getChatId(ctx)}`,
          convertir: soffice,
          svg_png: soffice,
          echarts_svg: existsSync(scriptRendu()),
        },
        signal: ctx.signal,
        rappels: creerRappels({ username, signal: ctx.signal }, deps),
      });
    } catch (e) {
      if (ctx.signal.aborted) throw e;
      journal.warn(`[office] ${nom} a échoué : ${e instanceof Error ? e.message : String(e)}`);
      const detail =
        e instanceof ErreurWorker
          ? "the Office engine could not be started, or stopped during the call (the file may or may not have been modified)"
          : `${e instanceof Error ? e.name : "Error"}: ${String(e instanceof Error ? e.message : e)}`;
      return err("internal_error", `${nom} failed: ${detail}`, {
        fix: "Tell the user the file could not be processed; do not retry the same call unchanged.",
      });
    }
  };
}

/** Famille `office` de l'hôte : définitions et signatures des goldens, un worker Python partagé par tous les comptes. */
export const familleOffice: FabriqueNative = ({ journal }) => {
  const outils = GOLDEN.outils.map((d) => {
    const nom = String(d["name"]);
    return outilDuGolden(GOLDEN, nom, {
      signature: signatureDe(nom),
      motsClesSeuls: true,
      traiter: traiterOffice(nom, journal),
    });
  });
  return { famille: "office", outils };
};
