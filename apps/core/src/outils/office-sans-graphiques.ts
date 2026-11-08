// SPDX-License-Identifier: MIT
/** apps/core/src/outils/office-sans-graphiques.ts — définitions des outils Office sans les graphiques `!id` quand aucun outil `chart_*` n'est offert au tour. */
import type { Dict } from "../python";

const OFFICE: ReadonlySet<string> = new Set(["docx_create", "docx_edit", "pptx_create", "pptx_edit"]);
const RETIRES: readonly RegExp[] = [
  /^[ \t]*!a1b2c3d4e5f6 alone on a line:[^\n]*\n/gm,
  /^[ \t]*chart \{title, chart:[^\n]*\n/gm,
  /, or a chart_table ref '!id'/g,
  /, or a chart ref '!id'/g,
  / \(charts !id allowed\)/g,
  / or a chart !id/g,
];

function nettoyer(valeur: unknown, cle: string): unknown {
  if (typeof valeur === "string") return RETIRES.reduce((s, motif) => s.replace(motif, ""), valeur);
  if (Array.isArray(valeur))
    return (cle === "enum" ? valeur.filter((v) => v !== "chart") : valeur).map((v) => nettoyer(v, ""));
  if (valeur === null || typeof valeur !== "object") return valeur;
  const objet = valeur as Dict;
  const diapo = cle === "properties" && "layout" in objet;
  return Object.fromEntries(
    Object.entries(objet)
      .filter(([k]) => !(diapo && k === "chart"))
      .map(([k, v]) => [k, nettoyer(v, k)]),
  );
}

/** Sans outil `chart_*` dans le tour, les outils Office ne parlent plus de graphiques à référencer. */
export function retirerGraphiquesOffice(definitions: Dict[]): Dict[] {
  const nom = (d: Dict): string => String((d["function"] as Dict | undefined)?.["name"] ?? "");
  if (definitions.some((d) => nom(d).startsWith("chart_"))) return definitions;
  return definitions.map((d) => (OFFICE.has(nom(d)) ? (nettoyer(d, "") as Dict) : d));
}
