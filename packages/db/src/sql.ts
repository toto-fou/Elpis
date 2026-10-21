// SPDX-License-Identifier: MIT
/** packages/db/src/sql.ts — découpage de scripts, premier mot-clé et `?` → `$n` (comme pg8000). */
import { stripPy } from "@elpis/commun";

const BLANC_PY = "\\t-\\r\\x1c-\\x20\\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";

export { stripPy };

/** Découpe sur les « ; » hors littéraux ('…', "…", `…`) et commentaires `--`. */
export function splitStatements(script: string): string[] {
  const out: string[] = [];
  let buf = "";
  let quote: string | null = null;
  const n = script.length;
  for (let i = 0; i < n; i++) {
    const ch = script[i] as string;
    if (quote !== null) {
      buf += ch;
      if (ch === quote) {
        if (script[i + 1] === quote) {
          buf += quote;
          i++;
        } else {
          quote = null;
        }
      }
    } else if (ch === "'" || ch === '"' || ch === "`") {
      quote = ch;
      buf += ch;
    } else if (ch === "-" && script.startsWith("--", i)) {
      const j = script.indexOf("\n", i);
      const fin = j < 0 ? n : j;
      buf += script.slice(i, fin);
      i = fin - 1;
    } else if (ch === ";") {
      const instr = stripPy(buf);
      if (instr) out.push(instr);
      buf = "";
    } else {
      buf += ch;
    }
  }
  const instr = stripPy(buf);
  if (instr) out.push(instr);
  return out;
}

const PREMIER_MOT = new RegExp(
  `^[${BLANC_PY}]*(?:--[^\\n]*\\n[${BLANC_PY}]*|/\\*[\\s\\S]*?\\*/[${BLANC_PY}]*)*([A-Za-z]+)`,
  "u",
);

export function firstWord(sql: string): string {
  return PREMIER_MOT.exec(sql)?.[1]?.toUpperCase() ?? "";
}

/** Placeholders `?` → `$1…$n` hors littéraux, identifiants cités, E'…', $$…$$, commentaires `--` et commentaires en bloc (imbriqués comme PostgreSQL). */
export function qmarkVersDollar(sql: string): string {
  let etat: "dehors" | "sq" | "qi" | "es" | "co" | "dq" | "bloc" = "dehors";
  let profondeur = 0;
  let echappe = false;
  let n = 0;
  let out = "";
  let prec: string | null = null;
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i] as string;
    const suiv = sql[i + 1];
    if (etat === "dehors") {
      if (c === "'") {
        out += c;
        etat = prec === "E" ? "es" : "sq";
      } else if (c === '"') {
        out += c;
        etat = "qi";
      } else if (c === "/" && suiv === "*") {
        out += "/*";
        i += 1;
        etat = "bloc";
        profondeur = 1;
        prec = null;
        continue;
      } else if (c === "-") {
        out += c;
        if (prec === "-") etat = "co";
      } else if (c === "$") {
        out += c;
        if (prec === "$") etat = "dq";
      } else if (c === "?") {
        n += 1;
        out += `$${n}`;
      } else {
        out += c;
      }
    } else if (etat === "sq") {
      if (c === "'") {
        if (echappe) echappe = false;
        else if (suiv === "'") echappe = true;
        else etat = "dehors";
      }
      out += c;
    } else if (etat === "qi") {
      if (c === '"') etat = "dehors";
      out += c;
    } else if (etat === "es") {
      if (c === "'" && prec !== "\\") etat = "dehors";
      out += c;
    } else if (etat === "dq") {
      if (c === "$" && prec === "$") etat = "dehors";
      out += c;
    } else if (etat === "bloc") {
      if (c === "/" && suiv === "*") {
        out += "/*";
        i += 1;
        profondeur += 1;
        prec = null;
        continue;
      }
      if (c === "*" && suiv === "/") {
        out += "*/";
        i += 1;
        profondeur -= 1;
        if (profondeur === 0) etat = "dehors";
        prec = null;
        continue;
      }
      out += c;
    } else {
      out += c;
      if (c === "\n") etat = "dehors";
    }
    prec = c;
  }
  return out;
}
