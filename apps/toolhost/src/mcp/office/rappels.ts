// SPDX-License-Identifier: MIT
/** apps/toolhost/src/mcp/office/rappels.ts — ce que l'hôte fait pour le moteur Office : fichiers du bac par l'agent (écriture gardée, historique, verrou de l'éditeur), graphiques du cache du core, conversions LibreOffice et rendu ECharts. */
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { estErreurAgent } from "@elpis/bac";
import type { ErreurAgent } from "@elpis/bac";
import { intPy, pyJsonDumps, pyJsonLoads, stripPy } from "@elpis/commun";
import type { Dict } from "@elpis/commun";
import { MAX_FILE } from "@elpis/fichiers";
import { ErreurCheminBac, lexicalRel, toContainer } from "@elpis/securite";

import type { Journal } from "../../journal";
import type { convertBytes } from "../../office/apercu";
import { ErreurOffice, PDF_EXPORT_FILTERS } from "../../office/conversion";
import type { Espace } from "../espace";
import { actuel, ecrireGarde, INJOIGNABLE, sha256 } from "../fs/acces";
import { RefusRappel } from "./worker";
import type { Rappels, ReponseRappel } from "./worker";

const DELAI_RENDU_MS = 60_000;

/** Extension d'un fichier exporté → famille LibreOffice (filtres d'import et d'export). */
const KIND_EXPORT: Readonly<Record<string, string>> = {
  ".docx": "docx",
  ".dotx": "docx",
  ".docm": "docx",
  ".pptx": "pptx",
  ".potx": "pptx",
  ".pptm": "pptx",
  ".ppsx": "pptx",
  ".xlsx": "xlsx",
  ".xlsm": "xlsx",
  ".odt": "odt",
  ".odp": "odp",
  ".ods": "ods",
};

export interface DepsRappels {
  readonly espace: (username: string) => Promise<Espace>;
  readonly userId: (username: string) => Promise<number>;
  readonly convertir: typeof convertBytes;
  readonly rendreEcharts: (options: readonly Dict[]) => Promise<Dict[]>;
  readonly dossierGraphiques: (username: string) => string;
  readonly journal: Journal;
}

export interface ContexteRappels {
  readonly username: string;
  readonly signal: AbortSignal;
}

const journalise = new Map<string, number>();

/** Un même échec n'est journalisé qu'une fois par 10 minutes. */
function journalLimite(journal: Journal, cle: string, message: string): void {
  const maintenant = Date.now();
  if (maintenant - (journalise.get(cle) ?? -Infinity) < 600_000) return;
  journalise.set(cle, maintenant);
  journal.warn(message);
}

function indisponible(e: ErreurAgent): RefusRappel {
  return new RefusRappel("office", `the sandbox did not answer (${e.code})`, {
    code: "sandbox_unavailable",
    fix: "retry in a moment; if it persists, the sandbox must be restarted",
    retryable: true,
  });
}

function erreurLecture(e: ErreurAgent, rel: string): RefusRappel {
  if (e.code === "not_found" || e.code === "missing") return new RefusRappel("introuvable", rel);
  if (e.code === "is_dir") return new RefusRappel("dossier", rel);
  if (INJOIGNABLE.has(e.code)) return indisponible(e);
  return new RefusRappel("valeur", `cannot read ${toContainer(rel)}: ${e.message || e.code}`);
}

function erreurEcriture(e: ErreurAgent, rel: string): RefusRappel {
  if (INJOIGNABLE.has(e.code)) return indisponible(e);
  const chemin = toContainer(rel);
  if (e.code === "no_space")
    return new RefusRappel("office", `cannot write ${chemin}: the sandbox disk is full`, {
      code: "no_space",
      fix: "tell the user; files must be deleted before writing again",
    });
  if (e.code === "timeout")
    return new RefusRappel(
      "office",
      `writing ${chemin} timed out: the file may or may not have been written`,
      {
        code: "write_uncertain",
        fix: "read the file before retrying (docx_read / pptx_read)",
      },
    );
  return new RefusRappel("office", `cannot write ${chemin}: ${e.message || e.code}`, {
    code: "write_failed",
    fix: "choose another path (a folder of /work you can write to)",
  });
}

function relatif(esp: Espace, chemin: unknown): string {
  try {
    return lexicalRel(esp.racine, String(chemin ?? ""));
  } catch (e) {
    if (!(e instanceof ErreurCheminBac)) throw e;
    throw new RefusRappel("office", `'${String(chemin)}' is outside the sandbox`, {
      code: "bad_path",
      fix: "give a path inside /work, e.g. 'rapports/bilan.docx'",
    });
  }
}

/** Cache des options ECharts du compte, écrit par le core (`CHART_CACHE_DIR` ou `<tmp>/elpis_charts`). */
export function dossierGraphiquesParDefaut(username: string): string {
  const base = process.env["CHART_CACHE_DIR"] || path.join(os.tmpdir(), "elpis_charts");
  const sur = [...username].filter((c) => /[\p{L}\p{N}_-]/u.test(c)).join("");
  return path.join(base, sur || "guest");
}

/** Rendu ECharts côté serveur : le script Node du moteur, sans aucun secret de l'hôte dans son environnement. */
export function rendreEchartsParNode(script: string): DepsRappels["rendreEcharts"] {
  return (options) =>
    new Promise<Dict[]>((ok, ko) => {
      let entree: string;
      try {
        entree = pyJsonDumps(options.map((option) => ({ option })));
      } catch (e) {
        ko(e);
        return;
      }
      const enfant = spawn(process.execPath, [script], {
        env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" },
        stdio: ["pipe", "pipe", "pipe"],
      });
      const sortie: Buffer[] = [];
      const erreurs: Buffer[] = [];
      const delai = setTimeout(() => enfant.kill("SIGKILL"), DELAI_RENDU_MS);
      enfant.stdout.on("data", (m: Buffer) => sortie.push(m));
      enfant.stderr.on("data", (m: Buffer) => erreurs.push(m));
      enfant.stdin.on("error", () => undefined);
      enfant.once("error", (e) => {
        clearTimeout(delai);
        ko(e);
      });
      enfant.once("close", (code, signal) => {
        clearTimeout(delai);
        if (code !== 0) {
          const fin = Buffer.concat(erreurs).toString("utf8").slice(-300);
          ko(new Error(fin || `node exited with ${code ?? signal}`));
          return;
        }
        try {
          const lu: unknown = JSON.parse(Buffer.concat(sortie).toString("utf8"));
          if (!Array.isArray(lu)) throw new Error("sortie du rendu inattendue");
          ok(lu as Dict[]);
        } catch (e) {
          ko(e);
        }
      });
      enfant.stdin.end(entree);
    });
}

export function creerRappels(c: ContexteRappels, d: DepsRappels): Rappels {
  const espace = async (): Promise<Espace> => {
    try {
      return await d.espace(c.username);
    } catch (e) {
      if (estErreurAgent(e)) throw indisponible(e);
      throw e;
    }
  };

  const lire = async (args: Dict): Promise<ReponseRappel> => {
    const esp = await espace();
    const rel = relatif(esp, args["chemin"]);
    const maxOctets = intPy(args["max_octets"] ?? 0);
    try {
      const e = await esp.stat(rel);
      if (e["kind"] === "missing") throw new RefusRappel("introuvable", rel);
      if (e["kind"] === "dir") throw new RefusRappel("dossier", rel);
      const taille = intPy(e["size"] || 0);
      if (taille > maxOctets)
        throw new RefusRappel(
          "valeur",
          `'${toContainer(rel)}' is too large (${Math.floor(taille / (1024 * 1024))} MB, limit ${Math.floor(maxOctets / (1024 * 1024))} MB)`,
        );
      return { corps: (await esp.lire(rel, { maxBytes: maxOctets })).data };
    } catch (e) {
      if (estErreurAgent(e)) throw erreurLecture(e, rel);
      throw e;
    }
  };

  const ecrire = async (args: Dict, corps: Buffer): Promise<ReponseRappel> => {
    const esp = await espace();
    const rel = relatif(esp, args["chemin"]);
    const attendu =
      args["attendu"] === null || args["attendu"] === undefined ? null : String(args["attendu"]);
    try {
      const etat = await actuel(esp, rel);
      if (attendu !== null && etat[2] !== attendu)
        throw new RefusRappel(
          "office",
          `${toContainer(rel)} changed since it was read (editor, shell or another agent): nothing was written`,
          {
            code: "concurrent_modification",
            fix: "read the file again, then redo the changes on the new version",
          },
        );
      const [, refus] = await ecrireGarde(esp, rel, corps, { etat, strict: attendu !== null });
      if (refus !== null)
        throw new RefusRappel("office", String(refus["message"] || refus["error"]), {
          code: String(refus["error"] || "write_failed"),
          fix: String(refus["fix"] || "read the file again, then retry"),
        });
      const [eAvant, avant, shaAvant] = etat;
      return {
        valeur: {
          path: toContainer(rel),
          old_sha256: avant !== null ? shaAvant : "",
          new_sha256: sha256(corps),
          size: corps.length,
          history_kept: avant === null || intPy(eAvant["size"] || 0) <= MAX_FILE,
        },
      };
    } catch (e) {
      if (estErreurAgent(e)) throw erreurEcriture(e, rel);
      throw e;
    }
  };

  const graphique = async (args: Dict): Promise<ReponseRappel> => {
    const sid = [...String(args["id"] ?? "")].filter((ch) => /[\p{L}\p{N}]/u.test(ch)).join("");
    let texte: string;
    try {
      texte = await readFile(path.join(d.dossierGraphiques(c.username), `${sid}.json`), "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return { valeur: { option: null } };
      return illisible(sid, e);
    }
    try {
      return { valeur: { option: pyJsonLoads(texte) } };
    } catch (e) {
      return illisible(sid, e);
    }
  };

  const illisible = (sid: string, e: unknown): never => {
    d.journal.warn(`[office] graphique ${sid} illisible : ${e instanceof Error ? e.message : String(e)}`);
    throw new RefusRappel("office", `chart !${sid} exists but cannot be read`, {
      code: "chart_unreadable",
      fix: "tell the user; the chart can be drawn again with different data or title",
    });
  };

  const convertir = async (args: Dict, corps: Buffer): Promise<ReponseRappel> => {
    const ext = String(args["ext"] ?? "").toLowerCase();
    const kind = KIND_EXPORT[ext];
    if (kind === undefined) throw new RefusRappel("execution", `unsupported extension: ${ext}`);
    const nom = `source.${kind}`;
    try {
      const sorties = await d.convertir({
        uid: await d.userId(c.username),
        kind,
        files: { [nom]: corps },
        convertTo: `pdf:${PDF_EXPORT_FILTERS[kind] ?? ""}`,
        outExt: ".pdf",
        signal: c.signal,
      });
      return { corps: sorties[nom] as Buffer };
    } catch (e) {
      if (!(e instanceof ErreurOffice)) throw e;
      d.journal.warn(`[office] export PDF en échec : ${e.message} (${e.code})`);
      if (e.code === "invalid" || e.code === "encrypted")
        throw new RefusRappel(
          "office",
          "the file is damaged, password-protected or not of the type its extension says",
          {
            code: "bad_file",
            fix: "open and re-save it with an office suite",
          },
        );
      if (e.code === "busy" || e.code === "timeout")
        throw new RefusRappel("office", "the PDF converter is busy or the conversion took too long", {
          code: "busy",
          fix: "retry in a moment",
        });
      throw new RefusRappel("office", `PDF conversion failed (${e.code})`, {
        code: "conversion_failed",
        fix: "check that the file opens (docx_read / pptx_read)",
      });
    }
  };

  const svgPng = async (args: Dict): Promise<ReponseRappel> => {
    const svgs = (Array.isArray(args["svgs"]) ? args["svgs"] : []).map(String);
    try {
      const sorties = await d.convertir({
        uid: await d.userId(c.username),
        kind: "svg",
        files: Object.fromEntries(svgs.map((s, i) => [`g${i}.svg`, Buffer.from(s, "utf8")])),
        convertTo: "png",
        outExt: ".png",
        signal: c.signal,
      });
      const pngs = svgs.map((_, i) => sorties[`g${i}.svg`] ?? Buffer.alloc(0));
      return { valeur: { tailles: pngs.map((p) => p.length) }, corps: Buffer.concat(pngs) };
    } catch (e) {
      if (!(e instanceof ErreurOffice)) throw e;
      journalLimite(d.journal, "svgpng", `[office] PNG des graphiques en échec : ${e.message} (${e.code})`);
      throw new RefusRappel("execution", `PNG conversion unavailable (${e.code})`);
    }
  };

  const echartsSvg = async (args: Dict): Promise<ReponseRappel> => {
    const options = (Array.isArray(args["options"]) ? args["options"] : []) as Dict[];
    try {
      const sorties = await d.rendreEcharts(options);
      for (const s of sorties) {
        const erreur = stripPy(String(s["error"] ?? ""));
        if (erreur)
          journalLimite(d.journal, `svg:${erreur.slice(0, 60)}`, `[office] graphique non rendu : ${erreur}`);
      }
      return { valeur: { sorties } };
    } catch (e) {
      journalLimite(
        d.journal,
        "node",
        `[office] rendu ECharts (Node) en échec : ${e instanceof Error ? e.message : String(e)}`,
      );
      throw new RefusRappel("execution", "server-side chart rendering unavailable");
    }
  };

  return (op, args, corps) => {
    switch (op) {
      case "lire":
        return lire(args);
      case "ecrire":
        return ecrire(args, corps);
      case "graphique":
        return graphique(args);
      case "convertir":
        return convertir(args, corps);
      case "svg_png":
        return svgPng(args);
      case "echarts_svg":
        return echartsSvg(args);
      default:
        return Promise.reject(new RefusRappel("execution", `rappel inconnu : ${op}`));
    }
  };
}
