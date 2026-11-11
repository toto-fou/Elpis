// SPDX-License-Identifier: MIT
/** apps/toolhost/test/office-worker-reel.test.ts — vrai worker Python (`python -m elpis_office`, ELPIS_OFFICE_PYTHON, sinon ELPIS_PYTHON ou le venv du dépôt) : docx et pptx créés puis relus par le canal, fichiers tenus par des rappels en mémoire ; sauté sans interpréteur muni des dépendances. */
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";

import type { Dict } from "@elpis/commun";
import { Journal } from "@elpis/http";
import { interpreteurPython } from "@elpis/mcp";
import { afterAll, describe, expect, it } from "vitest";

import { CanalOffice, RefusRappel } from "../src/mcp/office/worker";
import type { Rappels } from "../src/mcp/office/worker";

const PYTHON = process.env["ELPIS_OFFICE_PYTHON"] || interpreteurPython();
const OFFICE = path.resolve(import.meta.dirname, "..", "..", "..", "office");
const PRET =
  spawnSync(PYTHON, ["-c", "import docx, pptx, lxml, markdown_it, PIL, pydantic"], { timeout: 30_000 })
    .status === 0;

const journal = new Journal({ niveau: "warn", sortie: () => undefined });
const fichiers = new Map<string, Buffer>();
const sha = (b: Buffer): string => createHash("sha256").update(b).digest("hex");

/** Bac en mémoire : `lire` et `ecrire` comme l'hôte les rend au moteur, le reste refusé. */
const rappels: Rappels = async (op, args, corps) => {
  const chemin = String(args["chemin"] ?? "");
  if (op === "lire") {
    const f = fichiers.get(chemin);
    if (f === undefined) throw new RefusRappel("introuvable", chemin);
    return { corps: f };
  }
  if (op === "ecrire") {
    const ancien = fichiers.get(chemin);
    fichiers.set(chemin, Buffer.from(corps));
    return {
      valeur: {
        path: `/work/${chemin}`,
        old_sha256: ancien ? sha(ancien) : "",
        new_sha256: sha(corps),
        size: corps.length,
        history_kept: false,
      },
    };
  }
  if (op === "graphique") return { valeur: {} };
  throw new RefusRappel("valeur", `rappel ${op} non pris en charge par l'essai`);
};

const canal = new CanalOffice({
  journal,
  lanceur: () =>
    spawn(PYTHON, ["-X", "utf8", "-m", "elpis_office"], {
      cwd: OFFICE,
      stdio: ["pipe", "pipe", "pipe", "pipe"],
      env: {
        PATH: process.env["PATH"] ?? "/usr/bin:/bin",
        LANG: "C.UTF-8",
        PYTHONPATH: OFFICE,
        PYTHONUNBUFFERED: "1",
      },
    }),
});

function appeler(outil: string, args: Dict): Promise<Dict> {
  return canal.appeler({
    outil,
    args,
    contexte: { session: "hugo:1", convertir: false, svg_png: false, echarts_svg: false },
    signal: new AbortController().signal,
    rappels,
  });
}

afterAll(async () => {
  await canal.fermer();
});

describe.skipIf(!PRET)("worker Office réel (python -m elpis_office)", () => {
  it("docx_create puis docx_read : fichier écrit par rappel (zip OOXML), texte relu", async () => {
    const cree = await appeler("docx_create", {
      path: "rapports/bilan.docx",
      title: "Bilan trimestriel",
      content: "# Résultats\n\nLe chiffre d'affaires progresse de **12 %**.\n\n- Nord\n- Sud\n",
    });
    expect(cree, JSON.stringify(cree)).toMatchObject({ ok: true });
    const octets = fichiers.get("rapports/bilan.docx");
    expect(octets?.subarray(0, 2).toString()).toBe("PK");
    const lu = await appeler("docx_read", { path: "rapports/bilan.docx" });
    expect(lu, JSON.stringify(lu)).toMatchObject({ ok: true });
    const texte = JSON.stringify(lu);
    expect(texte).toContain("Résultats");
    expect(texte).toContain("chiffre d'affaires progresse");
  }, 60_000);

  it("pptx_create puis pptx_read, en parallèle d'un docx_read ; fichier absent : refus du moteur, worker toujours vivant", async () => {
    const [cree, absent] = await Promise.all([
      appeler("pptx_create", {
        path: "deck.pptx",
        title: "Revue",
        slides: [
          { layout: "title", title: "Revue de projet", subtitle: "Octobre" },
          {
            layout: "bullets",
            title: "Points clés",
            bullets: ["Livraison à l'heure", "  sous-point", "Budget tenu"],
          },
        ],
      }),
      appeler("docx_read", { path: "absent.docx" }),
    ]);
    expect(cree, JSON.stringify(cree)).toMatchObject({ ok: true });
    expect(absent).toMatchObject({ ok: false });
    expect(fichiers.get("deck.pptx")?.subarray(0, 2).toString()).toBe("PK");
    const lu = await appeler("pptx_read", { path: "deck.pptx" });
    expect(lu, JSON.stringify(lu)).toMatchObject({ ok: true });
    const texte = JSON.stringify(lu);
    expect(texte).toContain("Revue de projet");
    expect(texte).toContain("Budget tenu");
  }, 60_000);
});
