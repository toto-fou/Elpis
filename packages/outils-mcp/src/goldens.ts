// SPDX-License-Identifier: MIT
/** packages/outils-mcp/src/goldens.ts — goldens `tools/list` des familles (relevés sur local_mcp_server.py) : définitions publiées figées et signatures Python. */
import { estDict } from "@elpis/commun";
import type { Dict } from "@elpis/commun";
import { py } from "@elpis/http";
import type { SchemaPy } from "@elpis/http";

import type { DefinitionOutil } from "./serveur";

export interface ParametrePython {
  readonly nom: string;
  readonly annotation: string;
  readonly requis: boolean;
  readonly defaut?: unknown;
}

/** Fichier `packages/outils-mcp/goldens/<famille>.json`. */
export interface Golden {
  readonly source: string;
  readonly famille: string;
  readonly outils: readonly Dict[];
  readonly fonctions: Readonly<
    Record<string, { readonly fonction: string; readonly parametres: readonly ParametrePython[] }>
  >;
}

/** Écarts entre la signature TS d'un outil et la signature Python du golden : noms, ordre, paramètres requis. */
export function ecartsSignature(
  golden: Golden,
  nom: string,
  signature: DefinitionOutil["signature"],
): string[] {
  const fonction = golden.fonctions[nom];
  if (fonction === undefined) return [`outil absent du golden ${golden.famille} : ${nom}`];
  const ts = Object.entries(signature).map(([k, s]) => ({
    nom: s.options.alias ?? k,
    requis: !s.options.defaut,
  }));
  const ecarts: string[] = [];
  const nomsPy = fonction.parametres.map((p) => p.nom);
  if (ts.map((p) => p.nom).join(",") !== nomsPy.join(","))
    ecarts.push(`${nom} : paramètres ${ts.map((p) => p.nom).join(",")} ≠ ${nomsPy.join(",")}`);
  for (const p of fonction.parametres) {
    const t = ts.find((x) => x.nom === p.nom);
    if (t !== undefined && t.requis !== p.requis)
      ecarts.push(`${nom}.${p.nom} : ${p.requis ? "requis" : "facultatif"} en Python`);
  }
  return ecarts;
}

/** Outil d'une famille portée : définition publiée telle que le golden la fige, fonction Python des erreurs de validation. */
export function outilDuGolden(
  golden: Golden,
  nom: string,
  o: Pick<DefinitionOutil, "signature" | "traiter" | "motsClesSeuls">,
): DefinitionOutil {
  const definition = golden.outils.find((d) => d["name"] === nom);
  if (definition === undefined) throw new Error(`outil absent du golden ${golden.famille} : ${nom}`);
  const ecarts = ecartsSignature(golden, nom, o.signature);
  if (ecarts.length > 0) throw new Error(`signature différente du Python : ${ecarts.join(" ; ")}`);
  return {
    nom,
    famille: golden.famille,
    fonction: golden.fonctions[nom]?.fonction ?? nom,
    definition,
    signature: o.signature,
    ...(o.motsClesSeuls ? { motsClesSeuls: true } : {}),
    traiter: o.traiter,
  };
}

/** Type pydantic d'une annotation Python des goldens (`str`, `int`, `float`, `bool`, `Any`, `list`, `Optional[…]`, `List[…]`, `Dict[str, …]`). */
export function schemaDAnnotation(annotation: string): SchemaPy<unknown> {
  const generique = /^(Optional|List|Dict)\[(.*)\]$/u.exec(annotation);
  if (generique?.[1] === "Optional") return py.optional(schemaDAnnotation(generique[2] ?? ""));
  if (generique?.[1] === "List") return py.list(schemaDAnnotation(generique[2] ?? ""));
  if (generique?.[1] === "Dict" && generique[2]?.startsWith("str, "))
    return py.dict(py.str(), schemaDAnnotation(generique[2].slice("str, ".length)));
  const simples: Record<string, () => SchemaPy<unknown>> = {
    str: () => py.str(),
    int: () => py.int(),
    float: () => py.float(),
    bool: () => py.bool(),
    Any: () => py.any(),
    list: () => py.list(py.any()),
  };
  const simple = simples[annotation];
  if (simple === undefined) throw new Error(`annotation Python non prise en charge : ${annotation}`);
  return simple();
}

/** `repr(float)` Python relu (`inf`, `-inf`, `nan` compris). */
function flottantDuRepr(repr: string): number {
  const speciaux: Readonly<Record<string, number>> = { inf: Infinity, "-inf": -Infinity, nan: NaN };
  return speciaux[repr] ?? Number(repr);
}

/** Signature validée comme FastMCP d'après le golden : paramètres, types et défauts (`{"$f": "0.0"}` = flottant) de la fonction Python. */
export function signatureDuGolden(golden: Golden, nom: string): DefinitionOutil["signature"] {
  const fonction = golden.fonctions[nom];
  if (fonction === undefined) throw new Error(`outil absent du golden ${golden.famille} : ${nom}`);
  return Object.fromEntries(
    fonction.parametres.map((p) => {
      const schema = schemaDAnnotation(p.annotation);
      if (p.requis) return [p.nom, schema];
      const repr = estDict(p.defaut) ? p.defaut["$f"] : undefined;
      return [p.nom, schema.defaut(typeof repr === "string" ? flottantDuRepr(repr) : (p.defaut ?? null))];
    }),
  );
}
