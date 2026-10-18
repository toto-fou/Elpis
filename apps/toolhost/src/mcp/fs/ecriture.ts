// SPDX-License-Identifier: MIT
/** apps/toolhost/src/mcp/fs/ecriture.ts — `write_file` et `edit_file` (fs_tools.py) : écriture atomique gardée par l'agent (sha, mtime), conventions du fichier (BOM, CRLF, encodage) conservées, éditions chirurgicales et formateurs de l'hôte. */
import { spawn } from "node:child_process";

import { estErreurAgent, which } from "@elpis/bac";
import { estDict, ErreurPython, longueurPy, lowerPy, nomTypePy, stripPy, strPy } from "@elpis/commun";
import type { Dict } from "@elpis/commun";
import { TOO_BIG } from "@elpis/fichiers";
import { asList, err, estContenuElide, getUsername, ok } from "@elpis/outils-mcp";
import type { ContexteAppel } from "@elpis/outils-mcp";
import { toContainer } from "@elpis/securite";

import { Espace } from "../espace";
import {
  actuel,
  ecrireGarde,
  errAgent,
  grand,
  refusDansGitReel,
  refusShaMalForme,
  relDe,
  sauvegarde,
  sha256,
  strErreur,
} from "./acces";
import { suffixe } from "./code";
import { decoderPy, encoderPy, ErreurCodec } from "./codecs";
import {
  appliquerEdition,
  errEdition,
  errFs,
  estValueError,
  HASH_PERIME,
  normEditionCrlf,
  ordonnerMulti,
} from "./edition";
import { MAX_FILE_BIN, porteLigneCoupee } from "./lecture";
import { b64Strict, crlfDominant, ErreurB64, faireDiff, nombreLignes, statsDiff } from "./texte";

export const MAX_WRITE_CHARS = 2_000_000;
export const MAX_EDIT_BYTES = 5_000_000;
export const MAX_MULTI_EDITS = 50;
const BOM_UTF8 = Buffer.from([0xef, 0xbb, 0xbf]);

const CHAMPS_ECRITS = ["content", "new_str", "replacement", "b64"] as const;

/** Écarts voulus au Python : refus, avant toute écriture, d'un champ écrit qui est le marqueur de contenu condensé (H-04) ou qui recopie une ligne coupée par read_file. */
function refusContenuElide(p: string, args: object, edits: readonly unknown[] = []): Dict | null {
  for (const [i, source] of [args, ...edits].entries()) {
    if (!estDict(source)) continue;
    const ou = (k: string): string => (i ? `edits[${i - 1}].${k}` : k);
    const elide = CHAMPS_ECRITS.find((k) => estContenuElide(source[k]));
    if (elide !== undefined)
      return err(
        "elided_content",
        "this text is a placeholder from an elided earlier write, not real file content",
        { fix: "re-read the file with read_file before writing", path: p, field: ou(elide) },
      );
    const coupe = CHAMPS_ECRITS.find((k) => k !== "b64" && porteLigneCoupee(source[k]));
    if (coupe !== undefined)
      return err(
        "cut_line_marker",
        "this text contains a line cut by read_file (it ends with the marker …[+N chars]), not the real line",
        {
          fix: "re-read the whole line (read_file with max_chars above its length, or grep), then write it in full",
          path: p,
          field: ou(coupe),
        },
      );
  }
  return null;
}

/** Arguments validés de `write_file`. */
export interface ArgsEcriture {
  readonly path: string;
  readonly content: string;
  readonly mode: string;
  readonly b64: string;
  readonly encoding: string;
  readonly expected_sha256: string;
  readonly backup: boolean;
  readonly dry_run: boolean;
}

/** Arguments validés de `edit_file`. */
export interface ArgsEdition {
  readonly path: string;
  readonly action: string;
  readonly old_str: string;
  readonly new_str: string;
  readonly start_line: number;
  readonly end_line: number;
  readonly content: string;
  readonly count: number | null;
  readonly pattern: string;
  readonly replacement: string;
  readonly flags: string;
  readonly edits: unknown;
  readonly dry_run: boolean;
  readonly expected_sha256: string;
  readonly anchor_str: string;
  readonly anchor_re: string;
  readonly position: string;
  readonly occurrence: number;
  readonly indent_delta: number;
  readonly auto_format: boolean;
  readonly before_context: unknown;
  readonly after_context: unknown;
}

/** Formateur lancé sur l'entrée standard ; sortie brute, `null` : échec, délai ou absence. */
function formater(argv: readonly string[], entree: Buffer, cwd?: string): Promise<Buffer | null> {
  return new Promise((fin) => {
    const p = spawn(argv[0] as string, argv.slice(1), {
      cwd: cwd ?? process.cwd(),
      stdio: ["pipe", "pipe", "pipe"],
    });
    const sortie: Buffer[] = [];
    const t = setTimeout(() => p.kill("SIGKILL"), 10_000);
    p.stdout.on("data", (d: Buffer) => sortie.push(d));
    p.stderr.on("data", () => undefined);
    p.on("error", () => {
      clearTimeout(t);
      fin(null);
    });
    p.on("close", (code) => {
      clearTimeout(t);
      fin(code === 0 ? Buffer.concat(sortie) : null);
    });
    p.stdin.on("error", () => undefined);
    p.stdin.end(entree);
  });
}

/** Bilan du formatage demandé : outil visé, issue et explication. */
export type BilanFormat = { tool: string; status: "applied" | "failed" | "unavailable"; message: string };

/** `_try_format` : black, prettier, shfmt ou yamlfmt de l'hôte selon l'extension ; contenu inchangé et bilan `null` si l'extension n'a pas de formateur. */
export async function essayerFormat(
  nom: string,
  contenu: string,
): Promise<[string, string, BilanFormat | null]> {
  const ext = lowerPy(suffixe(nom));
  const entree = (): Buffer => encoderPy(contenu, "utf-8");
  const choix: readonly [string, readonly string[], string | undefined][] = [
    ["black", ["black", "--quiet", "--stdin-filename", nom, "-"], "/"],
    ["prettier", ["prettier", "--no-config", "--no-editorconfig", `--stdin-filepath=${nom}`], "/"],
    ["shfmt", ["shfmt", "-i", "4"], undefined],
    ["yamlfmt", ["yamlfmt", "-"], undefined],
  ];
  const exts: Readonly<Record<string, readonly string[]>> = {
    black: [".py"],
    prettier: [".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs", ".json", ".md"],
    shfmt: [".sh", ".bash"],
    yamlfmt: [".yaml", ".yml"],
  };
  const trouve = choix.find(([outil]) => (exts[outil] as readonly string[]).includes(ext));
  if (trouve === undefined) return [contenu, "", null];
  const [outil, argv, cwd] = trouve;
  if (!which(outil))
    return [
      contenu,
      "",
      {
        tool: outil,
        status: "unavailable",
        message: `${outil} is not installed on the tool host; the file was left unformatted.`,
      },
    ];
  const r = await formater(argv, entree(), cwd);
  if (!r?.length)
    return [
      contenu,
      "",
      {
        tool: outil,
        status: "failed",
        message: `${outil} failed (invalid syntax or timeout); the file was left unformatted.`,
      },
    ];
  const texte = decoderPy(r, "utf-8", "strict").replaceAll("\r\n", "\n").replaceAll("\r", "\n");
  return [texte, outil, { tool: outil, status: "applied", message: `Formatted with ${outil}.` }];
}

/** Message d'`encoding_mismatch` : position de l'octet ou du caractère fautif quand Python la connaît. */
function position(e: ErreurCodec): number | null {
  return e.name === "LookupError" ? null : e.start;
}

/** `write_file` : écriture atomique (write, append, b64), conventions gardées, verrou optimiste. */
export async function writeFile(a: ArgsEcriture, ctx: ContexteAppel): Promise<Dict> {
  const username = getUsername(ctx);
  let rel = "";
  try {
    const esp = await Espace.pour(username);
    rel = relDe(esp.racine, a.path);
    const p = toContainer(rel);
    const gitRefus = await refusDansGitReel(esp, rel, true);
    if (gitRefus !== null) return gitRefus;
    const shaRefus = refusShaMalForme(a.expected_sha256);
    if (shaRefus !== null) return shaRefus;
    const elide = refusContenuElide(p, a);
    if (elide !== null) return elide;
    const mode = lowerPy(stripPy(a.mode || "write"));
    const jumeau = await esp.jumeauUnicode(rel);
    const jumeauKw: Dict = jumeau ? { warning: jumeau } : {};
    if (mode === "mkdir")
      return errFs(
        "mkdir_moved",
        "Use manage_files(action='mkdir', path=…). write_file creates parent directories anyway.",
      );
    const etat = await actuel(esp, rel);
    const [e, ancienBrut, ancienSha] = etat;
    const gros = ancienBrut === TOO_BIG;
    const avantN = ancienBrut !== null ? Number(grand(e["size"])) : 0;
    if (ancienSha && a.expected_sha256 && a.expected_sha256 !== ancienSha)
      return errFs("hash_mismatch", HASH_PERIME, {
        expected: a.expected_sha256,
        actual: ancienSha,
      });

    if (mode === "b64") {
      if (!a.b64) return errFs("b64_required", "Provide base64-encoded bytes.");
      let data: Buffer;
      try {
        data = b64Strict(a.b64);
      } catch (x) {
        if (!(x instanceof ErreurB64)) throw x;
        return errFs(`bad_b64: ${x.message}`, "Ensure valid base64 (no line breaks, padding OK).");
      }
      if (data.length > MAX_FILE_BIN)
        return errFs("too_large", `Max ${MAX_FILE_BIN} bytes.`, { bytes: data.length, max: MAX_FILE_BIN });
      const nouveauSha = sha256(data);
      if (a.dry_run)
        return ok({
          path: p,
          action: "b64_write",
          dry_run: true,
          bytes_before: avantN,
          bytes_after: data.length,
          old_sha256: ancienSha,
          new_sha256: nouveauSha,
        });
      if (a.backup && ancienBrut !== null) {
        const bk = await sauvegarde(esp, rel);
        if (bk) return bk;
      }
      const [r, refus] = await ecrireGarde(esp, rel, data, { etat, expectedSha256: a.expected_sha256 });
      if (refus !== null) return refus;
      return ok({
        path: p,
        bytes: (r as Dict)["size"],
        action: "b64_write",
        old_sha256: ancienSha,
        new_sha256: nouveauSha,
        next_expected_sha256: nouveauSha,
        ...jumeauKw,
      });
    }

    if (mode !== "write" && mode !== "append")
      return errFs("invalid_mode", "Use: write|append|b64 (mkdir → manage_files).");
    const limite = MAX_WRITE_CHARS;
    const n = longueurPy(a.content);
    if (n > limite)
      return errFs("too_large", `Max ${limite} chars. Split into multiple writes or use edit_file.`, {
        chars: n,
        max: limite,
      });

    let content = a.content;
    let encSortie = a.encoding;
    const conv: Dict = {};
    let baseStricte = false;
    let ancienTexte = "";
    let nouveau: string;
    if (mode === "append" && gros)
      return errFs(
        "too_large",
        "File too large to append in place: use execute_shell (>>) instead. Nothing was written.",
        { bytes: avantN },
      );
    if (mode === "append" && ancienBrut !== null) {
      let ancien: string;
      try {
        ancien = decoderPy(ancienBrut as Buffer, a.encoding, "strict");
      } catch (x) {
        if (!(x instanceof ErreurCodec)) throw x;
        const off = position(x);
        return errFs(
          "encoding_mismatch",
          `The existing file is not '${a.encoding}'${off !== null ? ` (invalid byte at offset ${off})` : ""}. Re-run with the right encoding= (e.g. 'latin-1'), or mode='b64' for binary. Nothing was written.`,
          { encoding: a.encoding, offset: off ?? -1 },
        );
      }
      baseStricte = true;
      if (crlfDominant(ancien) && content.includes("\n") && !content.includes("\r\n")) {
        content = content.replaceAll("\n", "\r\n");
        conv["line_endings"] = "crlf";
      }
      nouveau = ancien + content;
      ancienTexte = ancien;
    } else if (mode === "write" && ancienBrut !== null && !gros) {
      const brut = ancienBrut as Buffer;
      const utf8 = ["utf-8", "utf8"].includes(lowerPy(a.encoding).replaceAll("_", "-"));
      const bom = utf8 && brut.subarray(0, 3).equals(BOM_UTF8);
      try {
        ancienTexte = decoderPy(brut, bom ? "utf-8-sig" : a.encoding, "strict");
      } catch (x) {
        if (!(x instanceof ErreurCodec)) throw x;
        const off = position(x);
        return errFs(
          "encoding_mismatch",
          `The existing file is not valid '${a.encoding}'${off !== null ? ` (invalid byte at offset ${off})` : ""}: overwriting it would silently change its encoding. Check the encoding (read_file reports lossy=true), then re-run with encoding='latin-1' (or 'cp1252') to keep it, or delete the file first (manage_files action='delete') to recreate it in UTF-8. Nothing was written.`,
          { encoding: a.encoding, offset: off ?? -1 },
        );
      }
      nouveau = content;
      if (bom && !nouveau.startsWith("﻿")) {
        encSortie = "utf-8-sig";
        conv["bom"] = true;
      }
      if (crlfDominant(ancienTexte) && nouveau.includes("\n") && !nouveau.includes("\r\n")) {
        nouveau = nouveau.replaceAll("\n", "\r\n");
        conv["line_endings"] = "crlf";
      }
    } else nouveau = content;
    if (Object.keys(conv).length)
      conv["note"] = `The file's existing conventions were kept (${Object.keys(conv)
        .map((k) => (k === "bom" ? "UTF-8 BOM" : "CRLF line endings"))
        .join(", ")}).`;

    let octets: Buffer;
    try {
      octets = encoderPy(nouveau, encSortie);
    } catch (x) {
      if (!(x instanceof ErreurCodec)) throw x;
      const pos = position(x);
      return errFs(
        "encoding_mismatch",
        `The content contains characters not representable in '${a.encoding}'${pos !== null ? ` (position ${pos})` : ""}. Use encoding='utf-8' (default) or mode='b64' for binary.`,
        { encoding: a.encoding },
      );
    }
    const nouveauSha = sha256(octets);
    if (a.dry_run) {
      const [la, lr] = statsDiff(ancienTexte, nouveau);
      return ok({
        path: p,
        action: mode,
        dry_run: true,
        bytes_before: avantN,
        bytes_after: octets.length,
        old_sha256: ancienSha,
        new_sha256: nouveauSha,
        lines_added: la,
        lines_removed: lr,
        ...conv,
      });
    }
    if (mode === "write" && ancienBrut !== null && nouveauSha === ancienSha)
      return ok({
        path: p,
        action: "noop",
        unchanged: true,
        bytes: avantN,
        old_sha256: ancienSha,
        new_sha256: nouveauSha,
        next_expected_sha256: nouveauSha,
        lines_added: 0,
        lines_removed: 0,
        note: "NO-OP: the file already contains EXACTLY this content. Nothing was written, nothing changed — this is a success. Do NOT call write_file again with the same content: move on to the next step.",
      });
    if (a.backup && ancienBrut !== null) {
      const bk = await sauvegarde(esp, rel);
      if (bk) return bk;
    }
    const [r, refus] = await ecrireGarde(esp, rel, octets, {
      etat,
      expectedSha256: a.expected_sha256,
      strict: baseStricte,
    });
    if (refus !== null) return refus;
    const [ajoutees, retirees] = statsDiff(ancienTexte, nouveau);
    return ok({
      path: p,
      bytes: (r as Dict)["size"],
      action: mode,
      old_sha256: ancienSha,
      new_sha256: nouveauSha,
      next_expected_sha256: nouveauSha,
      lines_added: ajoutees,
      lines_removed: retirees,
      ...conv,
      ...jumeauKw,
    });
  } catch (e) {
    if (estErreurAgent(e)) return errAgent(e, rel);
    if (estValueError(e)) return errFs(e.message);
    return errFs(`unexpected: ${strErreur(e)}`);
  }
}

/** `str(x)` des lignes de contexte. */
function textes(v: unknown): string[] {
  return asList(v).map((x) => strPy(x));
}

/** `_apply_one_edit` sur un élément de lot : un non-dict lève l'AttributeError de `edit.get`. */
function appliquer(texte: string, ed: unknown): [string, Dict] {
  if (!estDict(ed))
    throw new ErreurPython("AttributeError", `'${nomTypePy(ed)}' object has no attribute 'get'`);
  return appliquerEdition(texte, ed);
}

const UNITAIRES = [
  "str_replace",
  "str_replace_ctx",
  "regex",
  "insert",
  "delete",
  "replace",
  "anchor",
  "indent",
];

/** `edit_file` : édition chirurgicale (une action ou un lot `multi`), conventions CRLF/BOM restaurées, écriture stricte. */
export async function editFile(a: ArgsEdition, ctx: ContexteAppel): Promise<Dict> {
  const username = getUsername(ctx);
  let rel = "";
  try {
    const esp = await Espace.pour(username);
    rel = relDe(esp.racine, a.path);
    const p = toContainer(rel);
    const gitRefus = await refusDansGitReel(esp, rel, true);
    if (gitRefus !== null) return gitRefus;
    const shaRefus = refusShaMalForme(a.expected_sha256);
    if (shaRefus !== null) return shaRefus;
    const elide = refusContenuElide(p, a, asList(a.edits));
    if (elide !== null) return elide;
    const st = await esp.stat(rel);
    if (st["kind"] === "missing") return errFs("not_found", "Create with write_file first.", { path: p });
    if (st["kind"] === "dir") return errFs("is_directory", "", { path: p });
    if (grand(st["size"]) > BigInt(MAX_EDIT_BYTES))
      return errFs("too_large", "Split the edit or use write_file to replace whole file.", {
        size: Number(grand(st["size"])),
        max: MAX_EDIT_BYTES,
      });
    const etat = await actuel(esp, rel, st, MAX_EDIT_BYTES);
    const [, contenu, ancienSha] = etat;
    if (contenu === null) return errFs("not_found", "Create with write_file first.", { path: p });
    const brut = contenu as Buffer;
    if (a.expected_sha256 && a.expected_sha256 !== ancienSha)
      return errFs("hash_mismatch", HASH_PERIME, {
        expected: a.expected_sha256,
        actual: ancienSha,
      });
    const bom = brut.subarray(0, 3).equals(BOM_UTF8);
    let brutTexte: string;
    try {
      brutTexte = decoderPy(brut, bom ? "utf-8-sig" : "utf-8", "strict");
    } catch (x) {
      if (!(x instanceof ErreurCodec)) throw x;
      return errFs("not_utf8", "edit_file requires UTF-8. Use write_file(mode='b64') for binaries.");
    }
    const crlf = brutTexte.includes("\r\n");
    const nCrlf = brutTexte.split("\r\n").length - 1;
    const lfSeuls = brutTexte.split("\n").length - 1 - nCrlf;
    const fichierCrlf = crlf && lfSeuls === 0;
    const ancien = crlf ? brutTexte.replaceAll("\r\n", "\n") : brutTexte;
    const act = lowerPy(stripPy(a.action || ""));
    let edits = asList(a.edits);
    let avant = textes(a.before_context);
    let apres = textes(a.after_context);
    let { old_str: oldStr, new_str: newStr, content, replacement, anchor_str: ancre } = a;
    if (crlf) {
      const lf = (s: string): string => s.replaceAll("\r\n", "\n");
      [oldStr, newStr, content, replacement, ancre] = [oldStr, newStr, content, replacement, ancre].map(
        lf,
      ) as [string, string, string, string, string];
      avant = avant.map(lf);
      apres = apres.map(lf);
    }

    let nouveau: string;
    let appliquees: Dict[];
    if (act === "multi") {
      if (!edits.length) return errFs("edits_required", "Pass edits=[{action:...}, ...]");
      if (edits.length > MAX_MULTI_EDITS) return errFs("too_many_edits", `Max ${MAX_MULTI_EDITS} per call.`);
      if (crlf) edits = edits.map(normEditionCrlf);
      let ordre: [number, unknown][];
      try {
        ordre = ordonnerMulti(edits);
      } catch (x) {
        if (!estValueError(x)) throw x;
        return errEdition(x, {
          prefixe: "multi: ",
          hint: "Line numbers in one batch refer to the file as read; make the line ranges disjoint.",
        });
      }
      let courant = ancien;
      appliquees = [];
      for (const [i, ed] of ordre) {
        try {
          const [t, info] = appliquer(courant, ed);
          courant = t;
          appliquees.push({ index: i, ...info });
        } catch (x) {
          if (!estValueError(x)) throw x;
          return errEdition(x, {
            prefixe: `edit #${i + 1} (index ${i}) failed: `,
            hint: "All edits aborted; file unchanged. Fix the failing edit and retry.",
            kw: { failed_index: i, applied_so_far: appliquees },
          });
        }
      }
      nouveau = courant;
    } else if (UNITAIRES.includes(act)) {
      const ed: Dict = { action: act };
      if (act === "str_replace") Object.assign(ed, { old_str: oldStr, new_str: newStr, count: a.count ?? 1 });
      else if (act === "str_replace_ctx")
        Object.assign(ed, { old_str: oldStr, new_str: newStr, before_context: avant, after_context: apres });
      else if (act === "regex")
        Object.assign(ed, {
          pattern: a.pattern,
          replacement,
          count: a.count === null || a.count < 0 ? 0 : a.count,
          flags: a.flags,
        });
      else if (act === "insert") Object.assign(ed, { start_line: a.start_line, content: content || newStr });
      else if (act === "delete") Object.assign(ed, { start_line: a.start_line, end_line: a.end_line });
      else if (act === "replace")
        Object.assign(ed, { start_line: a.start_line, end_line: a.end_line, content: content || newStr });
      else if (act === "anchor")
        Object.assign(ed, {
          anchor_str: ancre,
          anchor_re: a.anchor_re,
          position: a.position,
          occurrence: a.occurrence,
          content: content || newStr,
        });
      else
        Object.assign(ed, { start_line: a.start_line, end_line: a.end_line, indent_delta: a.indent_delta });
      try {
        const [t, info] = appliquerEdition(ancien, ed);
        nouveau = t;
        appliquees = [info];
      } catch (x) {
        if (!estValueError(x)) throw x;
        return errEdition(x);
      }
    } else
      return errFs(
        "invalid_action",
        "Use: str_replace|str_replace_ctx|regex|insert|delete|replace|anchor|indent|multi",
      );

    if (nouveau === ancien)
      return ok({
        path: p,
        action: act,
        dry_run: a.dry_run,
        diff: "",
        old_sha256: ancienSha,
        new_sha256: ancienSha,
        next_expected_sha256: ancienSha,
        bytes_before: brut.length,
        bytes_after: brut.length,
        lines_before: nombreLignes(ancien),
        lines_after: nombreLignes(ancien),
        applied: appliquees,
        unchanged: true,
        note: "NO-OP: the edit yields content IDENTICAL to the current file — nothing changed. Do not retry the same edit: move on to the next step.",
      });

    let formateur = "";
    let bilanFormat: BilanFormat | null = null;
    if (a.auto_format && !a.dry_run)
      [nouveau, formateur, bilanFormat] = await essayerFormat(rel.split("/").pop() ?? "", nouveau);
    const diff = faireDiff(ancien, nouveau, rel);
    const sortie = fichierCrlf ? nouveau.replaceAll("\n", "\r\n") : nouveau;
    const octets = encoderPy(sortie, bom ? "utf-8-sig" : "utf-8");
    if (octets.length > MAX_EDIT_BYTES)
      return errFs("too_large_after_edit", "Edit would make file too large.", {
        size: octets.length,
        max: MAX_EDIT_BYTES,
      });
    const nouveauSha = sha256(octets);
    const [ajoutees, retirees] = statsDiff(ancien, nouveau);
    const resultat: Dict = {
      path: p,
      action: act,
      dry_run: a.dry_run,
      diff,
      old_sha256: ancienSha,
      new_sha256: nouveauSha,
      next_expected_sha256: nouveauSha,
      bytes_before: brut.length,
      bytes_after: octets.length,
      lines_before: nombreLignes(ancien),
      lines_after: nombreLignes(nouveau),
      lines_added: ajoutees,
      lines_removed: retirees,
      applied: appliquees,
    };
    if (formateur) resultat["formatter"] = formateur;
    if (bilanFormat !== null) resultat["format"] = bilanFormat;
    if (fichierCrlf) resultat["line_endings"] = "crlf";
    else if (crlf) {
      resultat["line_endings"] = "lf";
      resultat["normalized_line_endings"] = true;
      resultat["note"] =
        `Line endings were normalized to LF: the file mixed CRLF (${nCrlf} lines) and LF (${lfSeuls} lines). The diff above does not show this whole-file end-of-line change.`;
    }
    if (!a.dry_run) {
      const [, refus] = await ecrireGarde(esp, rel, octets, {
        etat,
        expectedSha256: a.expected_sha256,
        strict: true,
      });
      if (refus !== null) return refus;
    }
    return ok(resultat);
  } catch (e) {
    if (estErreurAgent(e)) return errAgent(e, rel);
    if (estValueError(e)) return errFs(e.message);
    return errFs(`unexpected: ${strErreur(e)}`);
  }
}
