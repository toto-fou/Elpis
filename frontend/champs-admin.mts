// SPDX-License-Identifier: MIT
/** frontend/champs-admin.mts — index des champs de la console (Ctrl+K), généré depuis les gabarits `components/admin/Page*.vue`. */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface ChampAdmin {
  page: string;
  store: string;
  path: string;
  label: string;
  hint: string;
  control: string;
}

interface Rangee {
  label: string;
  hint: string;
}
interface Cadre {
  tag: string;
  page: string | null;
  row: Rangee | null;
}

const ICI = dirname(fileURLToPath(import.meta.url));
const SOURCES = join(ICI, "src", "components", "admin");
const SORTIE = join(ICI, "src", "features", "admin", "champs.gen.ts");

const VIDES = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "source",
  "track",
  "wbr",
]);
const RE_PAGE = /(?:adm\.)?adminTab\s*===?\s*'([a-z0-9-]+)'/g;
const RE_NOM = /<([a-zA-Z][^\t\n\r\f />\0]*)(?:\s|\/(?!>))*/y;
const RE_ATTR = /((?<=['"\s/])[^\s/>][^\s/=>]*)(\s*=+\s*('[^']*'|"[^"]*"|(?!['"])[^>\s]*))?(?:\s|\/(?!>))*/y;
const RE_FIN = /\s*(\/?)>/y;
const RE_FERMANTE = /<\/([a-zA-Z][^\t\n\r\f />\0]*)[^>]*>/y;
const ENTITES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

function desechapper(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (tout, n: string) => {
    if (n.startsWith("#x")) return String.fromCodePoint(parseInt(n.slice(2), 16));
    if (n.startsWith("#")) return String.fromCodePoint(parseInt(n.slice(1), 10));
    return ENTITES[n] ?? tout;
  });
}

function compacter(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

class Indexeur {
  pile: Cadre[] = [];
  champs: ChampAdmin[] = [];
  private rangeeLue: Rangee | null = null;
  private rangLu = -1;
  private morceaux: string[] = [];

  private contexte<K extends "page" | "row">(cle: K): Cadre[K] {
    for (let i = this.pile.length - 1; i >= 0; i--) {
      const v = this.pile[i]![cle];
      if (v !== null) return v;
    }
    return null as Cadre[K];
  }

  ouvrir(tag: string, a: Map<string, string>): void {
    const cadre: Cadre = { tag, page: null, row: null };
    const vif = a.get("v-if") || a.get("v-else-if") || "";
    const pages = [...vif.matchAll(RE_PAGE)].map((m) => m[1]!);
    if (pages.length === 1 && !vif.includes("includes(")) cadre.page = pages[0]!;
    const classes = (a.get("class") ?? "").split(/\s+/).filter(Boolean);
    if (classes.includes("adm-row")) cadre.row = { label: "", hint: "" };
    const row = this.contexte("row");
    if (
      classes.includes("adm-row__label") &&
      row !== null &&
      !row.label &&
      this.rangeeLue === null &&
      !VIDES.has(tag)
    ) {
      row.hint = (a.get("title") ?? "").trim();
      this.rangeeLue = row;
      this.rangLu = this.pile.length;
      this.morceaux = [];
    }
    const df = a.get("data-field");
    if (df?.includes(":")) {
      const i = df.indexOf(":");
      const label = (row?.label ?? "").trim() || (a.get("aria-label") ?? "").trim();
      const page = this.contexte("page");
      if (page && label) {
        this.champs.push({
          page,
          store: df.slice(0, i),
          path: df.slice(i + 1),
          label,
          hint: (row?.hint || (a.get("title") ?? "")).trim(),
          control: (a.get("aria-label") ?? "").trim(),
        });
      }
    }
    if (!VIDES.has(tag)) this.pile.push(cadre);
  }

  fermer(tag: string): void {
    if (VIDES.has(tag)) return;
    for (let i = this.pile.length - 1; i >= 0; i--) {
      if (this.pile[i]!.tag === tag) {
        if (this.rangeeLue !== null && i <= this.rangLu) {
          this.rangeeLue.label = compacter(this.morceaux.join(""));
          this.rangeeLue = null;
          this.rangLu = -1;
        }
        this.pile.length = i;
        break;
      }
    }
  }

  donnees(texte: string): void {
    if (this.rangeeLue !== null) this.morceaux.push(texte);
  }

  alimenter(html: string): void {
    let i = 0;
    while (i < html.length) {
      const lt = html.indexOf("<", i);
      if (lt < 0) {
        this.donnees(desechapper(html.slice(i)));
        return;
      }
      if (lt > i) this.donnees(desechapper(html.slice(i, lt)));
      RE_NOM.lastIndex = lt;
      const nom = RE_NOM.exec(html);
      if (nom) {
        const tag = nom[1]!.toLowerCase();
        const attrs = new Map<string, string>();
        let pos = RE_NOM.lastIndex;
        for (;;) {
          RE_ATTR.lastIndex = pos;
          const m = RE_ATTR.exec(html);
          if (!m || RE_ATTR.lastIndex === pos) break;
          pos = RE_ATTR.lastIndex;
          let v = m[3] ?? "";
          if (m[2] === undefined) v = "";
          else if (/^(['"])[\s\S]*\1$/.test(v)) v = v.slice(1, -1);
          attrs.set(m[1]!.toLowerCase(), desechapper(v));
        }
        RE_FIN.lastIndex = pos;
        const fin = RE_FIN.exec(html);
        const finPos = fin ? RE_FIN.lastIndex : html.indexOf(">", pos) + 1 || html.length;
        this.ouvrir(tag, attrs);
        if (fin?.[1] === "/") this.fermer(tag);
        i = finPos;
        continue;
      }
      RE_FERMANTE.lastIndex = lt;
      const ferme = RE_FERMANTE.exec(html);
      if (ferme) {
        this.fermer(ferme[1]!.toLowerCase());
        i = RE_FERMANTE.lastIndex;
        continue;
      }
      this.donnees("<");
      i = lt + 1;
    }
  }
}

export function construire(dossier: string = SOURCES): ChampAdmin[] {
  const champs: ChampAdmin[] = [];
  const vus = new Set<string>();
  const fichiers = readdirSync(dossier)
    .filter((f) => /^Page.*\.vue$/.test(f))
    .sort();
  for (const f of fichiers) {
    const texte = readFileSync(join(dossier, f), "utf8").replace(/<!--[\s\S]*?-->/g, "");
    const ix = new Indexeur();
    ix.alimenter(texte);
    for (const fd of ix.champs) {
      const cle = JSON.stringify([fd.page, fd.store, fd.path]);
      if (vus.has(cle)) continue;
      vus.add(cle);
      fd.label = compacter(fd.label);
      champs.push(fd);
    }
  }
  const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
  champs.sort(
    (a, b) => cmp(a.page, b.page) || cmp(a.label.toLowerCase(), b.label.toLowerCase()) || cmp(a.path, b.path),
  );
  return champs;
}

function ligne(f: ChampAdmin): string {
  const j = JSON.stringify;
  return `    {"control": ${j(f.control)}, "hint": ${j(f.hint)}, "label": ${j(f.label)}, "page": ${j(f.page)}, "path": ${j(f.path)}, "store": ${j(f.store)}}`;
}

export function rendre(champs: ChampAdmin[]): string {
  return (
    // REUSE-IgnoreStart
    "// SPDX-License-Identifier: MIT\n" +
    // REUSE-IgnoreEnd
    "/** frontend/src/features/admin/champs.gen.ts — GÉNÉRÉ par frontend/champs-admin.mts (node frontend/champs-admin.mts ; test : frontend/test/champs-admin.test.ts) : index des réglages de la recherche Ctrl+K, page, bloc:chemin et libellé. */\n" +
    "\n" +
    "export interface ChampAdmin {\n" +
    "  control: string;\n" +
    "  hint: string;\n" +
    "  label: string;\n" +
    "  page: string;\n" +
    "  path: string;\n" +
    "  store: string;\n" +
    "}\n" +
    "\n" +
    "export const CHAMPS_ADMIN: readonly ChampAdmin[] = Object.freeze([\n" +
    champs.map(ligne).join(",\n") +
    "\n]);\n"
  );
}

export function lireIndex(): string {
  return readFileSync(SORTIE, "utf8");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const sortie = rendre(construire());
  if (process.argv.includes("--check")) {
    if (lireIndex() !== sortie) {
      process.stderr.write(
        "frontend/src/features/admin/champs.gen.ts n'est plus à jour : node frontend/champs-admin.mts\n",
      );
      process.exit(1);
    }
  } else {
    writeFileSync(SORTIE, sortie, "utf8");
    process.stdout.write(
      `écrit frontend/src/features/admin/champs.gen.ts : ${sortie.split("\n    {").length - 1} champs\n`,
    );
  }
}
