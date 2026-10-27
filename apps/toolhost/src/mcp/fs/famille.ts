// SPDX-License-Identifier: MIT
/** apps/toolhost/src/mcp/fs/famille.ts — famille `fs` servie par l'hôte (llm_core/tools/fs_tools.py) : read_file, write_file, edit_file, list_files, manage_files et code, définitions figées par le golden Python. */
import type { PortProfilRappel } from "@elpis/bac";
import type { Dict } from "@elpis/commun";
import { py } from "@elpis/http";
import { getUsername, outilDuGolden } from "@elpis/outils-mcp";
import type { ContexteAppel, DefinitionOutil, Golden } from "@elpis/outils-mcp";
import goldenFs from "@elpis/outils-mcp/goldens/fs.json" with { type: "json" };
import { cheminsEcrits, restaurerMarqueursArgs } from "@elpis/securite";

import { gardeDisque, politiqueFs, sousGardeDisque } from "../disque";
import type { GardeDisque } from "../disque";
import { refusFichiersResolus } from "../ecriture-sous-agent";
import { brancherRappelProfil, Espace } from "../espace";
import { enrichirErreur } from "./edition";
import { editFile, writeFile } from "./ecriture";
import type { ArgsEcriture, ArgsEdition } from "./ecriture";
import { manageFiles } from "./gestion";
import type { ArgsGestion } from "./gestion";
import { readFile } from "./lecture";
import type { ArgsLecture } from "./lecture";
import { listFiles } from "./liste";
import type { ArgsListe } from "./liste";
import { codeOutil } from "./navigation";
import type { ArgsCode } from "./navigation";

type Signature = DefinitionOutil["signature"];

const textes = (): ReturnType<typeof py.list> => py.list(py.str()).fabrique(() => []);

const LECTURE: Signature = {
  path: py.str().defaut(""),
  paths: textes(),
  max_chars: py.int().defaut(20_000),
  start_line: py.int().defaut(0),
  end_line: py.int().defaut(0),
  head: py.int().defaut(0),
  tail: py.int().defaut(0),
  grep: py.str().defaut(""),
  grep_context: py.int().defaut(0),
  ignore_case: py.bool().defaut(true),
  with_line_numbers: py.bool().defaut(true),
  line_ranges: py.list(py.list(py.int())).fabrique(() => []),
  offset: py.int().defaut(0),
  length: py.int().defaut(0),
  encoding: py.str().defaut(""),
  format: py.literal("", "json", "yaml").defaut(""),
  as_base64: py.bool().defaut(false),
};

const ECRITURE: Signature = {
  path: py.str(),
  content: py.str().defaut(""),
  mode: py.literal("write", "append", "b64").defaut("write"),
  b64: py.str().defaut(""),
  encoding: py.str().defaut("utf-8"),
  expected_sha256: py.str().defaut(""),
  backup: py.bool().defaut(false),
  dry_run: py.bool().defaut(false),
};

const EDITION: Signature = {
  path: py.str(),
  action: py.literal(
    "str_replace",
    "str_replace_ctx",
    "regex",
    "insert",
    "delete",
    "replace",
    "anchor",
    "indent",
    "multi",
  ),
  old_str: py.str().defaut(""),
  new_str: py.str().defaut(""),
  start_line: py.int().defaut(0),
  end_line: py.int().defaut(0),
  content: py.str().defaut(""),
  count: py.optional(py.int()).defaut(null),
  pattern: py.str().defaut(""),
  replacement: py.str().defaut(""),
  flags: py.str().defaut(""),
  edits: py.list(py.dict(py.str(), py.any())).fabrique(() => []),
  dry_run: py.bool().defaut(false),
  expected_sha256: py.str().defaut(""),
  anchor_str: py.str().defaut(""),
  anchor_re: py.str().defaut(""),
  position: py.literal("before", "after").defaut("after"),
  occurrence: py.int().defaut(1),
  indent_delta: py.int().defaut(0),
  auto_format: py.bool().defaut(false),
  before_context: textes(),
  after_context: textes(),
};

const LISTE: Signature = {
  path: py.str().defaut("."),
  pattern: py.str().defaut(""),
  search_text: py.str().defaut(""),
  recursive: py.bool().defaut(false),
  ignore_case: py.bool().defaut(true),
  max_results: py.int().defaut(200),
  details: py.bool().defaut(false),
  exclude: textes(),
  sort_by: py.literal("name", "size", "mtime").defaut("name"),
  include_hidden: py.bool().defaut(false),
  summary: py.bool().defaut(false),
  cursor: py.str().defaut(""),
  since: py.str().defaut(""),
  include_git_status: py.bool().defaut(false),
};

const GESTION: Signature = {
  action: py.literal("copy", "move", "delete", "chmod", "mkdir", "batch_delete"),
  path: py.str().defaut(""),
  dest: py.str().defaut(""),
  recursive: py.bool().defaut(false),
  paths: textes(),
  overwrite: py.bool().defaut(true),
  dry_run: py.bool().defaut(false),
};

const CODE: Signature = {
  action: py.literal("outline", "symbols", "definition", "references"),
  path: py.str().defaut(""),
  paths: textes(),
  symbol: py.str().defaut(""),
  scope: py.str().defaut(""),
  include_glob: py.str().defaut(""),
  exclude: textes(),
  max_depth: py.int().defaut(4),
  max_results: py.int().defaut(200),
  recursive: py.bool().defaut(true),
};

/** Outils de la famille `fs`, dans l'ordre de `register` (fs_tools.py) ; `disque` : garde de remplissage des écritures (harnais N-08). */
export function outilsFs(disque: GardeDisque | null = null): DefinitionOutil[] {
  const g = goldenFs as Golden;
  const garde = async (outil: string, v: Dict, ctx: ContexteAppel, f: () => Promise<Dict>): Promise<Dict> =>
    (await refusFichiersResolus(ctx, cheminsEcrits(outil, v), () => Espace.pour(getUsername(ctx)))) ??
    sousGardeDisque(disque, ctx, politiqueFs(outil, v), f);
  return [
    outilDuGolden(g, "read_file", {
      signature: LECTURE,
      traiter: async (v, ctx) => enrichirErreur(await readFile(v as unknown as ArgsLecture, ctx)),
    }),
    outilDuGolden(g, "write_file", {
      signature: ECRITURE,
      traiter: async (brut, ctx) => {
        const v = restaurerMarqueursArgs(brut);
        return enrichirErreur(
          await garde("write_file", v, ctx, () => writeFile(v as unknown as ArgsEcriture, ctx)),
        );
      },
    }),
    outilDuGolden(g, "edit_file", {
      signature: EDITION,
      traiter: async (brut, ctx) => {
        const v = restaurerMarqueursArgs(brut);
        return enrichirErreur(
          await garde("edit_file", v, ctx, () => editFile(v as unknown as ArgsEdition, ctx)),
        );
      },
    }),
    outilDuGolden(g, "list_files", {
      signature: LISTE,
      traiter: async (v, ctx) => enrichirErreur(await listFiles(v as unknown as ArgsListe, ctx)),
    }),
    outilDuGolden(g, "manage_files", {
      signature: GESTION,
      traiter: async (v, ctx) =>
        enrichirErreur(
          await garde("manage_files", v, ctx, () => manageFiles(v as unknown as ArgsGestion, ctx)),
        ),
    }),
    outilDuGolden(g, "code", {
      signature: CODE,
      traiter: async (v, ctx) => enrichirErreur(await codeOutil(v as unknown as ArgsCode, ctx)),
    }),
  ];
}

/** Famille `fs` de l'hôte (forme `FabriqueNative` de B3-10b) : espace de chaque appel = bac du compte sous le profil effectif (rappel au core). */
export function familleFs(o: { readonly rappel?: PortProfilRappel | null } = {}): {
  famille: string;
  outils: readonly DefinitionOutil[];
} {
  if (o.rappel) brancherRappelProfil(o.rappel);
  return { famille: "fs", outils: outilsFs(gardeDisque(o.rappel ?? null)) };
}
