// SPDX-License-Identifier: MIT
/** apps/toolhost/src/mcp/browser/procedures/chaine.ts — étapes `pw_chain` réussies converties en `{seq:[act…]}` (cas simple de procédure, base de l'apprentissage). */
import { estDict } from "@elpis/commun";
import type { Dict } from "@elpis/commun";
import { refusCible, refusUrl } from "@elpis/contracts";
import type { Act, Noeud } from "@elpis/contracts";
import { mergeTarget } from "@elpis/navigateur";

const VERBES: Readonly<Record<string, Act["act"]>> = {
  goto: "goto",
  click: "click",
  fill: "fill",
  type: "fill",
  press: "press",
  select: "select",
  select_option: "select",
  check: "check",
  uncheck: "uncheck",
  hover: "hover",
};

export interface ConversionChaine {
  /** `null` si une étape ne se convertit pas (voir `erreurs`). */
  readonly root: Noeud | null;
  /** Paramètres `string` déclarés par `options.parametres`, à reprendre dans `Procedure.params`. */
  readonly params: Record<string, "string">;
  readonly erreurs: string[];
}

/**
 * Convertit des étapes déjà jouées avec succès par `pw_chain` (même forme : `do`/`type`/`action`, `target`, `value`/`v`, `url`) en `{seq:[act…]}`.
 * Seules les cibles sémantiques passent (css=, xpath=, ref= et `selector` brut sont refusés) ; `goto` doit rester sur `origin`.
 * `options.parametres` (`{nom: valeur}`) remplace chaque occurrence de la valeur dans `v`, `url` et les cibles par `{nom}` ; l'appelant valide ensuite l'ensemble avec `validerProcedure`.
 */
export function chaineVersSeq(
  etapes: readonly unknown[],
  origin: string,
  options: { parametres?: Readonly<Record<string, string>> } = {},
): ConversionChaine {
  const erreurs: string[] = [];
  const params: Record<string, "string"> = {};
  const gabarit = (s: string): string => {
    let sortie = s;
    for (const [nom, valeur] of Object.entries(options.parametres ?? {}))
      if (valeur !== "" && sortie.includes(valeur)) {
        sortie = sortie.split(valeur).join(`{${nom}}`);
        params[nom] = "string";
      }
    return sortie;
  };
  const seq: Act[] = [];
  etapes.forEach((brute, i) => {
    if (!estDict(brute)) {
      erreurs.push(`étape ${i} : objet attendu`);
      return;
    }
    const e: Dict = brute;
    const verbe = String(e["do"] || e["type"] || e["action"] || "");
    const act = VERBES[verbe];
    if (act === undefined) {
      erreurs.push(`étape ${i} : geste ${verbe || "(absent)"} non convertible`);
      return;
    }
    if (e["secret"]) {
      erreurs.push(`étape ${i} : secret refusé`);
      return;
    }
    const noeud: Act = { act };
    if (act === "goto") {
      const brut = String(e["url"] ?? "");
      let relatif = brut;
      if (!brut.startsWith("/")) {
        try {
          const u = new URL(brut);
          relatif = u.origin === origin ? `${u.pathname}${u.search}` : brut;
        } catch {
          relatif = brut;
        }
      }
      const r = refusUrl(relatif, origin);
      if (r !== null) erreurs.push(`étape ${i} : ${r}`);
      else noeud.url = gabarit(relatif);
    } else {
      const cible = mergeTarget(String(e["target"] ?? ""), String(e["selector"] ?? ""));
      if (act !== "press" || cible !== "") {
        const r = refusCible(cible);
        if (r !== null) {
          erreurs.push(`étape ${i} : ${r}`);
          return;
        }
        noeud.t = [gabarit(cible)];
      }
      const valeur = String(e["v"] ?? e["value"] ?? e["key"] ?? e["text"] ?? "");
      if (valeur !== "") noeud.v = gabarit(valeur);
    }
    seq.push(noeud);
  });
  if (seq.length === 0 && erreurs.length === 0) erreurs.push("aucune étape");
  return { root: erreurs.length === 0 ? { seq } : null, params, erreurs };
}
