// SPDX-License-Identifier: MIT
/** frontend/src/features/editor/ia.ts — complétion au curseur (FIM) et actions IA sur la sélection (commenter, refactoriser, expliquer, tests…) par `/api/llm/infill`, proposées en diff avant application (porté de `editor/_fim_ai.js`). */
import type { Ref } from "vue";
import type * as M from "monaco-editor";
import { z } from "zod";

type FetchAuth = (url: string, init?: RequestInit, soft?: boolean) => Promise<Response | null>;

export interface MenuContexteEditeur {
  show: boolean;
  x: number;
  y: number;
  hasSelection: boolean;
  selectionText: string;
  lineCount: number;
}

export interface PropositionIa {
  model: M.editor.ITextModel;
  versionId: number;
  range: M.IRange;
  text: string;
  label: string;
}

export interface RefsIa {
  readonly monacoRef: { instance: M.editor.ICodeEditor | null };
  fimLoading: Ref<boolean>;
  fimGhostText: Ref<string>;
  editorCtxMenu: Ref<MenuContexteEditeur>;
  activeTabPath: Ref<string | null>;
  editorFilePath: Ref<string>;
}

export interface CtxIa {
  showToast(message: string, type?: string): void;
  fetchAuth: FetchAuth;
  readonly availableModels?: Ref<string[]> | null | undefined;
  readonly activeModelIds?: Ref<string[]> | null | undefined;
}

export interface RappelsIa {
  closeEditorCtxMenu(): void;
  _getLang(chemin: string): string;
  proposeEdit(p: PropositionIa): boolean;
}

export interface StyleCommentaire {
  line: string | null;
  block: [string, string] | null;
}

const schemaRemplissage = z.looseObject({
  ok: z.boolean().optional(),
  content: z.string().optional(),
  error: z.string().optional(),
  hint: z.string().optional(),
});
type Remplissage = z.infer<typeof schemaRemplissage>;

const LANGUES_DIESE = [
  "python",
  "ruby",
  "shell",
  "bash",
  "r",
  "perl",
  "yaml",
  "dockerfile",
  "makefile",
  "toml",
  "ini",
  "powershell",
  "coffeescript",
  "julia",
  "robotframework",
];

/** Style de commentaire d'un langage Monaco (ligne, bloc). */
export function styleCommentaire(lang: string): StyleCommentaire {
  if (LANGUES_DIESE.includes(lang)) return { line: "# ", block: null };
  if (lang === "sql") return { line: "-- ", block: ["/* ", " */"] };
  if (lang === "lua") return { line: "-- ", block: ["--[[ ", " ]]"] };
  if (["html", "xml", "svg", "markdown", "vue", "razor", "handlebars"].includes(lang))
    return { line: null, block: ["<!-- ", " -->"] };
  if (["css", "scss", "less"].includes(lang)) return { line: null, block: ["/* ", " */"] };
  if (lang === "plaintext") return { line: "", block: null };
  return { line: "// ", block: ["/* ", " */"] };
}

/** Consigne glissée en commentaire avant le préfixe : la tâche se déduit des dernières lignes avant le curseur. */
export function consigneFim(prefixe: string, lang: string, nomFichier: string): string {
  const cmt = ["python", "ruby", "shell", "bash", "r", "perl", "yaml"].includes(lang)
    ? "# "
    : ["html", "xml", "svg"].includes(lang)
      ? "<!-- "
      : ["css", "scss", "less"].includes(lang)
        ? "/* "
        : lang === "lua" || lang === "sql"
          ? "-- "
          : "// ";
  const fin: Readonly<Record<string, string>> = {
    html: "-->",
    xml: "-->",
    svg: "-->",
    css: "*/",
    scss: "*/",
    less: "*/",
  };
  const cmtFin = fin[lang] ?? "";
  const dernieres = prefixe
    .split("\n")
    .slice(-8)
    .map((x) => x.trimEnd());
  const derniere = (dernieres[dernieres.length - 1] || "").trim();
  const avant = (dernieres[dernieres.length - 2] || "").trim();
  let tache = "Continue writing the code naturally from cursor.";
  if (/:\s*$/.test(derniere) && ["python", "ruby"].includes(lang)) {
    tache = "Write the body of this block/function. Use proper indentation.";
  } else if (/\{\s*$/.test(derniere)) {
    tache = "Write the body of this block/function.";
  } else if (/^\s*$/.test(derniere) && /^(#|\/\/|\/\*|--)/.test(avant)) {
    tache = "Write the code described by the comment above.";
  } else if (
    /^\s*(def |function |async function|class |const |let |var |public |private )/.test(derniere) &&
    /:\s*$|{\s*$/.test(derniere)
  ) {
    tache = "Implement this function/class completely.";
  } else if (/^\s*(import|from|require|use |using )/.test(derniere)) {
    tache = "Continue the imports, then write the code.";
  } else if (/return\s*$/.test(derniere)) {
    tache = "Complete the return statement with the appropriate value.";
  }
  return (
    cmt +
    "[" +
    nomFichier +
    " | " +
    lang +
    "] " +
    tache +
    " Only output raw code, no markdown, no explanation." +
    (cmtFin ? " " + cmtFin : "") +
    "\n"
  );
}

/** Nettoie une complétion (barrières de code, consigne recopiée, préambule) ; `null` si le modèle a bouclé. */
export function nettoyerCompletion(brut: string): string | null {
  let r = brut
    .trimEnd()
    .replace(/^```[\w]*\n?/gm, "")
    .replace(/\n?```$/gm, "");
  r = r
    .split("\n")
    .filter((ligne) => {
      const t = ligne.trim();
      if (!t) return true;
      if (
        /^\s*(\/\/|#|--|\/\*)\s*\[.*\|\s*(python|javascript|html|css|typescript|shell|ruby|go|rust|java|c\b|cpp|php|sql)/i.test(
          ligne,
        )
      )
        return false;
      return !/^(Here|Voici|Note:|Explanation:|This (code|function)|The (code|function)|I ('ll|will)|Let me)/i.test(
        t,
      );
    })
    .join("\n");
  const lignes = r.split("\n");
  if (lignes.length > 4) {
    const freq = new Map<string, number>();
    for (const x of lignes) {
      const k = x.trim();
      if (k) freq.set(k, (freq.get(k) ?? 0) + 1);
    }
    if (Math.max(...freq.values()) >= 4) return null;
  }
  return r.trimEnd();
}

async function lireRemplissage(res: Response): Promise<Remplissage> {
  const r = schemaRemplissage.safeParse(await res.json());
  return r.success ? r.data : {};
}

export function setupEditorFimAi(refs: RefsIa, ctx: CtxIa, r: RappelsIa) {
  const { monacoRef, fimLoading, fimGhostText, editorCtxMenu, activeTabPath, editorFilePath } = refs;
  const { showToast, fetchAuth } = ctx;

  function modeleChoisi(): string | null {
    const tous = ctx.availableModels?.value ?? [];
    const charges = ctx.activeModelIds?.value ?? [];
    return charges.find((id) => tous.includes(id)) || tous[0] || null;
  }

  /** Le résultat (2 à 10 s) ne s'applique qu'au modèle d'origine, non modifié entre-temps ; vrai si la cible est périmée. */
  function ciblePerimee(modele: M.editor.ITextModel, version: number, annule: string): boolean {
    if (monacoRef.instance?.getModel() !== modele) {
      showToast(`Fichier changé pendant la génération — ${annule}.`, "warning");
      return true;
    }
    if (modele.getVersionId() !== version) {
      showToast(`Document modifié pendant la génération — ${annule}.`, "warning");
      return true;
    }
    return false;
  }

  function remplir(prefixe: string, suffixe: string, modele: string): Promise<Response | null> {
    return fetchAuth("/api/llm/infill", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input_prefix: prefixe, input_suffix: suffixe, model: modele }),
    });
  }

  async function editorCtxComplete(): Promise<void> {
    r.closeEditorCtxMenu();
    if (fimLoading.value) return;
    const modele = modeleChoisi();
    if (!modele) {
      showToast("Aucun modèle chargé", "warning");
      return;
    }
    await completer(modele);
  }

  async function completer(modeleId: string): Promise<void> {
    const ed = monacoRef.instance;
    const monaco = window.monaco;
    if (!ed || !monaco) return;
    const modele = ed.getModel();
    const pos = ed.getPosition();
    if (!modele || !pos) return;
    const chemin = activeTabPath.value || editorFilePath.value || "";
    const lang = r._getLang(chemin);
    const nom = chemin.split("/").pop() || "untitled";
    const CONTEXTE = 200;
    const debut = Math.max(1, pos.lineNumber - CONTEXTE);
    const fin = Math.min(modele.getLineCount(), pos.lineNumber + CONTEXTE);
    const decalage = modele.getOffsetAt(pos);
    const version = modele.getVersionId();
    const prefixeBrut = modele.getValueInRange(new monaco.Range(debut, 1, pos.lineNumber, pos.column));
    const suffixe = modele.getValueInRange(
      new monaco.Range(pos.lineNumber, pos.column, fin, modele.getLineLength(fin) + 1),
    );
    const prefixe = consigneFim(prefixeBrut, lang, nom) + prefixeBrut;

    fimLoading.value = true;
    fimGhostText.value = "";
    showToast("Complétion en cours...", "info");
    try {
      const res = await remplir(prefixe, suffixe, modeleId);
      if (!res || !res.ok) {
        showToast("Erreur serveur", "error");
        return;
      }
      const data = await lireRemplissage(res);
      if (!data.ok || !data.content) {
        showToast(data.error || data.hint || "Pas de suggestion", "warning");
        return;
      }
      const resultat = nettoyerCompletion(data.content);
      if (resultat === null) {
        showToast("Le modèle a bouclé -- aucune complétion insérée.", "warning");
        return;
      }
      if (!resultat) {
        showToast("Pas de suggestion", "warning");
        return;
      }
      if (ciblePerimee(modele, version, "complétion annulée")) return;
      const p = modele.getPositionAt(decalage);
      ed.executeEdits("fim-insert", [
        { range: new monaco.Range(p.lineNumber, p.column, p.lineNumber, p.column), text: resultat },
      ]);
      const apres = modele.getPositionAt(decalage + resultat.length);
      ed.setPosition(apres);
      ed.revealPositionInCenter(apres);
      showToast("Complétion insérée ✓");
    } catch {
      showToast("Erreur réseau", "error");
    } finally {
      fimLoading.value = false;
      monacoRef.instance?.focus();
    }
  }

  const LIBELLES: Readonly<Record<string, string>> = {
    comment: "Code commenté",
    refactor: "Refactorisation",
    optimize: "Optimisation",
    explain: "Explication",
    bugs: "Analyse de bugs",
    docstring: "Documentation",
    tests: "Tests",
  };

  async function editorCtxRunAI(action: string): Promise<void> {
    const ed = monacoRef.instance;
    const monaco = window.monaco;
    if (!ed || !monaco) return;
    const modele = ed.getModel();
    if (!modele) return;
    const code = editorCtxMenu.value.selectionText;
    const sel = ed.getSelection();
    r.closeEditorCtxMenu();
    if (!code || !sel) return;
    const version = modele.getVersionId();
    const modeleId = modeleChoisi();
    if (!modeleId) {
      showToast("Aucun modèle disponible", "warning");
      return;
    }
    const CONTEXTE = 150;
    const debut = Math.max(1, sel.startLineNumber - CONTEXTE);
    const fin = Math.min(modele.getLineCount(), sel.endLineNumber + CONTEXTE);
    const avant = modele.getValueInRange(new monaco.Range(debut, 1, sel.startLineNumber, sel.startColumn));
    const apres = modele.getValueInRange(
      new monaco.Range(sel.endLineNumber, sel.endColumn, fin, modele.getLineLength(fin) + 1),
    );
    const lang = r._getLang(activeTabPath.value || editorFilePath.value || "");
    const cs = styleCommentaire(lang);
    const bloc = cs.block ?? ["", ""];
    const C = (txt: string): string => (cs.line != null ? cs.line + txt : bloc[0] + txt + bloc[1]);
    const enCommentaire = (src: string): string =>
      cs.line != null
        ? src
            .split("\n")
            .map((x) => cs.line + x)
            .join("\n")
        : bloc[0] + "\n" + src + "\n" + bloc[1];
    const retrait = (/^[ \t]*/.exec(code) ?? [""])[0];
    const prefixeLigne = cs.line != null ? cs.line : "";
    function blocCommentaire(titre: string, corps: string): string {
      const lignes = String(corps || "")
        .replace(/\s+$/, "")
        .split("\n");
      if (cs.line != null) {
        const m = cs.line;
        return (
          retrait +
          m +
          titre +
          "\n" +
          lignes.map((x) => retrait + (x.startsWith(m.trim()) ? x : m + x)).join("\n") +
          "\n"
        );
      }
      const [a, b] = bloc;
      if (a.trim() === "/*") {
        return (
          retrait +
          "/*\n" +
          retrait +
          " * " +
          titre +
          "\n" +
          lignes.map((x) => retrait + " * " + x.replace(/^\s*\*\s?/, "")).join("\n") +
          "\n" +
          retrait +
          " */\n"
        );
      }
      return (
        retrait +
        a.trim() +
        "\n" +
        retrait +
        titre +
        "\n" +
        lignes.map((x) => retrait + x).join("\n") +
        "\n" +
        retrait +
        b.trim() +
        "\n"
      );
    }
    const a = (p: M.IPosition): M.IRange => new monaco.Range(p.lineNumber, p.column, p.lineNumber, p.column);
    const finSel = { lineNumber: sel.endLineNumber, column: sel.endColumn };
    const debutLigne = { lineNumber: sel.startLineNumber, column: 1 };

    let prefixe: string;
    let suffixe: string;
    let appliquer: (resultat: string) => { range: M.IRange; text: string };
    switch (action) {
      case "comment":
      case "refactor":
      case "optimize": {
        const quoi: readonly [string, string] = (
          {
            comment: ["à commenter", "Version commentée (commentaires explicatifs ajoutés) :"],
            refactor: ["à refactoriser", "Version refactorisée (plus propre, lisible, maintenable) :"],
            optimize: ["à optimiser", "Version optimisée (meilleures performances) :"],
          } as const
        )[action];
        prefixe =
          avant +
          "\n" +
          C("Code original " + quoi[0] + " :") +
          "\n" +
          enCommentaire(code) +
          "\n" +
          C(quoi[1]) +
          "\n";
        suffixe = apres;
        appliquer = (x) => ({ range: sel, text: x });
        break;
      }
      case "explain":
        prefixe = avant + "\n" + C("EXPLICATION du code ci-dessous :") + "\n" + prefixeLigne;
        suffixe = "\n" + code + apres;
        appliquer = (x) => ({ range: a(debutLigne), text: blocCommentaire("EXPLICATION :", x) });
        break;
      case "bugs":
        prefixe = avant + code + "\n" + C("ANALYSE DE BUGS du code ci-dessus :") + "\n" + prefixeLigne;
        suffixe = "\n" + apres;
        appliquer = (x) => ({
          range: a(finSel),
          text: "\n" + blocCommentaire("ANALYSE DE BUGS :", x).replace(/\n$/, ""),
        });
        break;
      case "docstring":
        if (lang === "python") {
          const premiere = modele.getLineContent(sel.startLineNumber);
          const ind = (/^\s*/.exec(premiere) ?? [""])[0] + "    ";
          const finLigne = { lineNumber: sel.startLineNumber, column: premiere.length + 1 };
          prefixe = avant + premiere + "\n" + ind + '"""\n' + ind;
          suffixe = "\n" + ind + '"""\n' + code.split("\n").slice(1).join("\n") + apres;
          appliquer = (x) => ({
            range: a(finLigne),
            text:
              "\n" +
              ind +
              '"""\n' +
              String(x)
                .replace(/\s+$/, "")
                .split("\n")
                .map((y) => ind + y.trim())
                .join("\n") +
              "\n" +
              ind +
              '"""',
          });
        } else if (cs.block && cs.block[0].trim() === "/*") {
          prefixe = avant + retrait + "/**\n" + retrait + " * ";
          suffixe = "\n" + retrait + " */\n" + code + apres;
          appliquer = (x) => ({
            range: a(debutLigne),
            text:
              retrait +
              "/**\n" +
              String(x)
                .replace(/\s+$/, "")
                .split("\n")
                .map((y) => retrait + " * " + y.replace(/^\s*\*\s?/, ""))
                .join("\n") +
              "\n" +
              retrait +
              " */\n",
          });
        } else {
          prefixe = avant + "\n" + C("Documentation du code ci-dessous :") + "\n" + prefixeLigne;
          suffixe = "\n" + code + apres;
          appliquer = (x) => ({ range: a(debutLigne), text: blocCommentaire("Documentation :", x) });
        }
        break;
      case "tests":
        prefixe = avant + code + "\n\n\n" + C("Tests unitaires du code ci-dessus :") + "\n";
        suffixe = apres;
        appliquer = (x) => ({
          range: a(finSel),
          text: "\n\n\n" + C("Tests unitaires :") + "\n" + String(x).replace(/\s+$/, "") + "\n",
        });
        break;
      default:
        return;
    }

    fimLoading.value = true;
    showToast("IA en cours...", "info");
    try {
      const res = await remplir(prefixe, suffixe, modeleId);
      if (!res || !res.ok) {
        showToast("Erreur serveur", "error");
        return;
      }
      const data = await lireRemplissage(res);
      if (!data.ok || !data.content) {
        showToast(data.error || "Pas de résultat", "warning");
        return;
      }
      const resultat = data.content.replace(/^```[\w-]*\n?/, "").replace(/\n?```\s*$/, "");
      if (ciblePerimee(modele, version, "action IA annulée")) return;
      const edition = appliquer(resultat);
      const montre = r.proposeEdit({
        model: modele,
        versionId: version,
        range: edition.range,
        text: edition.text,
        label: LIBELLES[action] || "Proposition de l'IA",
      });
      if (montre) {
        showToast("Proposition prête : Accepter ou Rejeter");
        return;
      }
      ed.executeEdits("ai-infill", [{ range: edition.range, text: edition.text }]);
      showToast("Modification appliquée");
    } catch {
      showToast("Erreur réseau", "error");
    } finally {
      fimLoading.value = false;
      monacoRef.instance?.focus();
    }
  }

  return { editorCtxComplete, editorCtxRunAI };
}
