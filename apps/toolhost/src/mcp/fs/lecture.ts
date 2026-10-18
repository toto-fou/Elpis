// SPDX-License-Identifier: MIT
/** apps/toolhost/src/mcp/fs/lecture.ts — `read_file` (fs_tools.py) : un fichier ou un lot, texte (modes, auto-troncature, JSON/YAML) ou binaire, gros texte lu en flux par plages de l'agent. */
import { estErreurAgent } from "@elpis/bac";
import {
  chercher,
  compilerPy,
  ErreurJsonPy,
  ErreurRe,
  intPy,
  longueurPy,
  poserCle,
  prefixePy,
  pyJsonDumps,
  pyJsonLoads,
  RE_IGNORECASE,
  splitlinesPy,
  strPy,
  suffixePy,
  veritePy,
} from "@elpis/commun";
import type { Dict } from "@elpis/commun";
import { asList, getUsername, ok } from "@elpis/outils-mcp";
import type { ContexteAppel } from "@elpis/outils-mcp";
import { toContainer } from "@elpis/securite";

import { Espace } from "../espace";
import { errAgentLien, HASH_MAX, mime, relDe, sha256, statEntree, strErreur } from "./acces";
import { decoderPy } from "./codecs";
import { errFs, estValueError, verifierRegexSure } from "./edition";
import { conventions, encodageBom, estTexte, formaterLignes, tronquer, tronquerSur } from "./texte";
import { charger, dumpPy, ErreurYaml } from "./yaml-py";

export const MAX_READ_CHARS = 2_000_000;
export const MAX_FILE_TEXT = 10_000_000;
export const MAX_FILE_BIN = 10_000_000;
export const MAX_GREP = 2000;
export const MAX_BATCH_PATHS = 20;
const PREVIEW_HEAD_LINES = 50;
const PREVIEW_TAIL_LINES = 20;
const MINIFIED_LINE_MIN = 5_000;
const BIN_PREVIEW_BYTES = 512;
const BIN_BASE64_MAX = 4096;
const LIGNE_MAX = 2000;
const MAX_CHARS_DEFAUT = 20_000;
const MARQUEUR_COUPE = /…\[\+\d+ chars\]/gu;

/** Ligne affichée coupée à `limite` caractères, le reste compté dans le marqueur `…[+N chars]`. */
function coupeLigne(l: string, limite: number): string {
  const n = longueurPy(l);
  return n <= limite ? l : `${prefixePy(l, limite)}…[+${n - limite} chars]`;
}

/** Vrai si une ligne de `v` porte le marqueur de coupe tel que `read_file` le pose (au moins `LIGNE_MAX` caractères puis `…[+N chars]` en fin de ligne). */
export function porteLigneCoupee(v: unknown): boolean {
  if (typeof v !== "string" || !v.includes("…[+")) return false;
  return v.split(/\r?\n|\r/u).some((l) => {
    const m = /…\[\+[1-9]\d* chars\]$/u.exec(l);
    return m !== null && longueurPy(l.slice(0, m.index)) >= LIGNE_MAX;
  });
}

/** Ajoute le hint de lecture complète si des lignes affichées ont été coupées. */
function noterCoupes(r: Dict): Dict {
  const n = String(r["content"] ?? "").match(MARQUEUR_COUPE)?.length ?? 0;
  if (n) {
    const h = typeof r["hint"] === "string" ? `${r["hint"]} ` : "";
    r["hint"] =
      `${h}${n} line(s) were cut at ${LIGNE_MAX} chars (marker …[+N chars]); to read a whole line pass max_chars above ${MAX_CHARS_DEFAUT} (at least the line length).`;
  }
  return r;
}
/** Au-delà, un fichier texte n'est jamais chargé en entier : lu en flux. */
export const STREAM_READ_OVER = 16 * 1024 * 1024;
const BLOC_FLUX = 4 << 20;

/** Arguments validés de `read_file` (signature du golden). */
export interface ArgsLecture {
  readonly path: string;
  readonly paths: unknown;
  readonly max_chars: number;
  readonly start_line: number;
  readonly end_line: number;
  readonly head: number;
  readonly tail: number;
  readonly grep: string;
  readonly grep_context: number;
  readonly ignore_case: boolean;
  readonly with_line_numbers: boolean;
  readonly line_ranges: unknown;
  readonly offset: number;
  readonly length: number;
  readonly encoding: string;
  readonly format: string;
  readonly as_base64: boolean;
}

/** `{n:,}`. */
export function milliers(n: number): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/gu, ",");
}

/** `octets[a:b]` (bornes négatives comptées depuis la fin). */
function tranche(b: Buffer, a: number, z: number): Buffer {
  const n = b.length;
  const borne = (x: number): number => (x < 0 ? Math.max(0, n + x) : Math.min(x, n));
  const [d, f] = [borne(a), borne(z)];
  return f > d ? b.subarray(d, f) : Buffer.alloc(0);
}

/** `_FluxAgent` + `BufferedReader` : lecture séquentielle par plages de l'agent, jamais le fichier entier. */
class Flux {
  private readonly esp: Espace;
  private readonly rel: string;
  private pos = 0;
  private tampon: Buffer = Buffer.alloc(0);
  private i = 0;
  private fini = false;

  private readonly taille: number;

  constructor(esp: Espace, rel: string, debut = 0, bloc = BLOC_FLUX) {
    this.esp = esp;
    this.rel = rel;
    this.pos = debut;
    this.taille = bloc;
  }

  /** Décalage (octets) du prochain octet rendu. */
  get position(): number {
    return this.pos - (this.tampon.length - this.i);
  }

  private async remplir(): Promise<boolean> {
    if (this.fini) return false;
    const d = (
      await this.esp.lire(this.rel, { offset: this.pos, length: this.taille, maxBytes: this.taille })
    ).data;
    if (!d.length) {
      this.fini = true;
      return false;
    }
    this.pos += d.length;
    this.tampon = d;
    this.i = 0;
    return true;
  }

  /** Bloc suivant (vide à la fin). */
  async bloc(): Promise<Buffer> {
    if (this.i >= this.tampon.length && !(await this.remplir())) return Buffer.alloc(0);
    const b = this.tampon.subarray(this.i);
    this.i = this.tampon.length;
    return b;
  }

  /** `readline(limite)` : jusqu'au premier `\n` compris, au plus `limite` octets. */
  async ligne(limite: number): Promise<Buffer> {
    const morceaux: Buffer[] = [];
    let n = 0;
    while (n < limite) {
      if (this.i >= this.tampon.length && !(await this.remplir())) break;
      const dispo = this.tampon.subarray(this.i, this.i + (limite - n));
      const nl = dispo.indexOf(10);
      const pris = nl >= 0 ? dispo.subarray(0, nl + 1) : dispo;
      morceaux.push(pris);
      n += pris.length;
      this.i += pris.length;
      if (nl >= 0) break;
    }
    return morceaux.length === 1 ? (morceaux[0] as Buffer) : Buffer.concat(morceaux);
  }
}

/** File bornée (`deque(maxlen)`) sans décalage quadratique. */
class FileBornee<T> {
  private items: T[] = [];
  private debut = 0;
  private readonly max: number;

  constructor(max: number) {
    this.max = max;
  }

  get taille(): number {
    return this.items.length - this.debut;
  }

  ajouter(x: T): void {
    if (this.max <= 0) return;
    this.items.push(x);
    if (this.taille > this.max) this.retirerTete();
  }

  tete(): T | undefined {
    return this.items[this.debut];
  }

  retirerTete(): void {
    this.debut++;
    if (this.debut > 4096 && this.debut * 2 > this.items.length) {
      this.items = this.items.slice(this.debut);
      this.debut = 0;
    }
  }

  vider(): void {
    this.items = [];
    this.debut = 0;
  }

  liste(): T[] {
    return this.items.slice(this.debut);
  }
}

type Rang = [number, string];

/** `_read_large_text` : gros fichier texte en flux, mémoire bornée par ce qui est rendu (queue gardée dans le budget, contexte avant relu à son décalage). */
async function lireGrosTexte(
  esp: Espace,
  rel: string,
  infoAppelant: Dict,
  a: ArgsLecture,
  enc: string,
): Promise<Dict> {
  const info: Dict = { ...infoAppelant, streamed: true };
  let total = 0;
  let dernier = -1;
  const h = (await import("node:crypto")).createHash("sha256");
  const f0 = new Flux(esp, rel);
  for (let b = await f0.bloc(); b.length; b = await f0.bloc()) {
    h.update(b);
    for (let k = b.indexOf(10); k >= 0; k = b.indexOf(10, k + 1)) total++;
    dernier = b[b.length - 1] as number;
  }
  if (dernier >= 0 && dernier !== 10) total++;
  info["sha256"] = h.digest("hex");
  info["total_lines"] = total;
  const maxChars = Math.max(1, Math.min(a.max_chars, MAX_READ_CHARS));
  const plafond = maxChars + 4;

  /** Une ligne lue au seul `\n`, coupée au plafond (le reste compté), décodée avec remplacement ; `null` à la fin. */
  const lireLigne = async (fb: Flux): Promise<string | null> => {
    const brut = await fb.ligne(plafond);
    if (!brut.length) return null;
    let reste = 0;
    if (brut[brut.length - 1] !== 10) {
      for (;;) {
        const plus = await fb.ligne(1 << 20);
        if (!plus.length) break;
        reste += plus.length;
        if (plus[plus.length - 1] === 10) {
          reste -= 1;
          break;
        }
      }
    }
    let fin = brut.length;
    while (fin > 0 && brut[fin - 1] === 10) fin--;
    while (fin > 0 && brut[fin - 1] === 13) fin--;
    const txt = decoderPy(brut.subarray(0, fin), enc, "replace");
    return reste > 0 ? `${txt} …[line cut: ${reste} more bytes]` : txt;
  };

  async function* lignesAvecDecalage(): AsyncGenerator<[number, string, number]> {
    const fb = new Flux(esp, rel);
    for (let i = 1; ; i++) {
      const debut = fb.position;
      const txt = await lireLigne(fb);
      if (txt === null) return;
      yield [i, txt, debut];
    }
  }

  async function* lignes(): AsyncGenerator<Rang> {
    for await (const [i, t] of lignesAvecDecalage()) yield [i, t];
  }

  const rendre = (rangs: readonly Rang[]): string => {
    if (!rangs.length) return "";
    const vue = (t: string): string => coupeLigne(t, maxChars > MAX_CHARS_DEFAUT ? maxChars : LIGNE_MAX);
    if (!a.with_line_numbers) return rangs.map(([, t]) => vue(t)).join("\n");
    const largeur = String((rangs[rangs.length - 1] as Rang)[0]).length;
    return rangs.map(([i, t]) => `${String(i).padStart(largeur)}\t${vue(t)}`).join("\n");
  };

  let ligneCoupee = false;
  const prendre = async (
    it: AsyncIterable<Rang>,
    arret: number | null = null,
  ): Promise<[Rang[], boolean]> => {
    const rangs: Rang[] = [];
    let utilise = 0;
    for await (const [i, t] of it) {
      if (arret !== null && i > arret) break;
      utilise += longueurPy(t) + 1;
      if (utilise > maxChars) {
        if (rangs.length) return [rangs, true];
        ligneCoupee = true;
        return [[[i, `${prefixePy(t, maxChars)} …[line cut]`]], true];
      }
      rangs.push([i, t]);
    }
    return [rangs, false];
  };

  if (a.grep) {
    verifierRegexSure(a.grep);
    const motif = compilerPy(a.grep, a.ignore_case ? RE_IGNORECASE : 0);
    const ctxN = Math.max(0, intPy(a.grep_context || 0));
    const avant = new FileBornee<[number, number, string | null]>(Number.MAX_SAFE_INTEGER);
    let garde = 0;
    const sortie: string[] = [];
    let utilise = 0;
    let prec = 0;
    const ajouter = (i: number, sep: string, t: string | null): void => {
      if (prec && i - prec > 1) {
        sortie.push("--");
        utilise += 3;
      }
      const place = maxChars - utilise;
      let ln = place > 0 && t !== null ? `${i}${sep}${t}` : "";
      if (place <= 0 || longueurPy(ln) > place) ln = `${prefixePy(ln, Math.max(0, place))} …[line cut]`;
      sortie.push(ln);
      utilise += longueurPy(ln) + 1;
      prec = i;
    };
    const relire = (debut: number): Promise<string | null> =>
      lireLigne(new Flux(esp, rel, debut, Math.min(BLOC_FLUX, plafond + 1)));
    let trouvees = 0;
    let apres = 0;
    let coupe = false;
    for await (const [i, t, debut] of lignesAvecDecalage()) {
      if (chercher(motif, t) !== null) {
        trouvees++;
        for (const [bi, bdebut, bt] of avant.liste())
          if (bi > prec) ajouter(bi, "-", bt ?? (maxChars - utilise > 0 ? await relire(bdebut) : null));
        avant.vider();
        garde = 0;
        ajouter(i, ":", t);
        apres = ctxN;
      } else if (apres > 0) {
        ajouter(i, "-", t);
        apres--;
      } else if (ctxN) {
        const n = longueurPy(t);
        const gardee = garde + n <= maxChars - utilise;
        if (gardee) garde += n;
        avant.ajouter([i, debut, gardee ? t : null]);
        if (avant.taille > ctxN) {
          const vieille = (avant.tete() as [number, number, string | null])[2];
          if (vieille !== null) garde -= longueurPy(vieille);
          avant.retirerTete();
        }
      }
      if (utilise > maxChars || trouvees >= MAX_GREP) {
        coupe = true;
        break;
      }
    }
    if (!trouvees) return ok({ ...info, format: "grep", matches: 0, content: "", hint: "no matches" });
    return ok({ ...info, format: "grep", matches: trouvees, content: sortie.join("\n"), truncated: coupe });
  }
  if (a.head > 0) {
    const [rangs, coupe] = await prendre(lignes(), a.head);
    return ok({
      ...info,
      format: "head",
      shown_lines: rangs.length,
      content: rendre(rangs),
      truncated: coupe,
    });
  }
  if (a.tail > 0) {
    const k = Math.min(a.tail, 100_000);
    const queue = new FileBornee<[number, string, number]>(Number.MAX_SAFE_INTEGER);
    let somme = 0;
    let vues = 0;
    const retirer = (): void => {
      somme -= ((queue.tete() as [number, string, number])[2] as number) + 1;
      queue.retirerTete();
    };
    for await (const [i, t] of lignes()) {
      vues++;
      const n = longueurPy(t);
      queue.ajouter([i, t, n]);
      somme += n + 1;
      if (queue.taille > k) retirer();
      while (queue.taille > 1 && somme > maxChars) retirer();
    }
    const gardees = queue.liste();
    const seule = gardees.length === 1 && somme > maxChars;
    const rangs: Rang[] = seule
      ? [
          [
            (gardees[0] as [number, string, number])[0],
            ` …[line cut] ${suffixePy((gardees[0] as [number, string, number])[1], maxChars)}`,
          ],
        ]
      : gardees.map(([i, t]) => [i, t] as Rang);
    const debut = rangs.length ? (rangs[0] as Rang)[0] : Math.max(1, total);
    return ok({
      ...info,
      format: "tail",
      shown_lines: rangs.length,
      start_line: debut,
      content: rendre(rangs),
      truncated: seule || gardees.length < Math.min(k, vues),
    });
  }
  if (a.start_line > 0 || a.end_line > 0) {
    const s = Math.max(1, a.start_line);
    const e = a.end_line > 0 ? a.end_line : null;
    async function* depuis(): AsyncGenerator<Rang> {
      for await (const r of lignes()) if (r[0] >= s) yield r;
    }
    const [rangs, coupe] = await prendre(depuis(), e);
    return ok({
      ...info,
      format: "range",
      start: s,
      end: rangs.length ? (rangs[rangs.length - 1] as Rang)[0] : s,
      shown_lines: rangs.length,
      content: rendre(rangs),
      truncated: coupe,
    });
  }
  const moitie = Math.max(1, Math.floor(maxChars / 2));
  const [tete] = await prendre(lignes());
  let utilise = 0;
  const garde: Rang[] = [];
  for (const r of tete) {
    utilise += longueurPy(r[1]) + 1;
    if (utilise > moitie && garde.length) break;
    garde.push(r);
  }
  const queue = new FileBornee<Rang>(Number.MAX_SAFE_INTEGER);
  let utiliseQueue = 0;
  const derniereGardee = garde.length ? (garde[garde.length - 1] as Rang)[0] : 0;
  for await (const r of lignes()) {
    if (r[0] <= derniereGardee) continue;
    queue.ajouter(r);
    utiliseQueue += longueurPy(r[1]) + 1;
    while (queue.taille && utiliseQueue > moitie) {
      utiliseQueue -= longueurPy((queue.tete() as Rang)[1]) + 1;
      queue.retirerTete();
    }
  }
  const rangsQueue = queue.liste();
  const omises = Math.max(0, total - garde.length - rangsQueue.length);
  let corps = rendre(garde);
  if (omises) corps += `\n...[${omises} lines omitted — file is ${strPy(info["size"] ?? 0)} bytes]...\n`;
  corps += rendre(rangsQueue);
  return ok({
    ...info,
    format: "auto_truncated",
    content: corps,
    truncated: Boolean(omises) || ligneCoupee,
    hint: "Large file read in streaming mode: use start_line/end_line, head/tail or grep to see the omitted part.",
  });
}

/** Union des lignes `[a, b)` (comptée sans les énumérer). */
function tailleUnion(plages: readonly [number, number][]): number {
  const triees = plages.filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  let n = 0;
  let fin = -Infinity;
  for (const [a, b] of triees) {
    if (b <= fin) continue;
    n += b - Math.max(a, fin);
    fin = b;
  }
  return n;
}

/** `_trunc("\n".join(parts))` des plages sans tout construire : longueur totale calculée, seuls les `maxChars` premiers caractères assemblés. */
function plagesRendues(
  lignes: readonly string[],
  morceaux: readonly ([number, number] | string)[],
  numeros: boolean,
  maxChars: number,
): [string, boolean] {
  const cumul = new Float64Array(lignes.length + 1);
  lignes.forEach((l, k) => (cumul[k + 1] = (cumul[k] as number) + longueurPy(l)));
  const longueur = (m: [number, number] | string): number => {
    if (typeof m === "string") return m.length;
    const [s, e] = m;
    const k = e - s;
    if (k <= 0) return 0;
    return (cumul[e] as number) - (cumul[s] as number) + (k - 1) + (numeros ? k * (String(e).length + 1) : 0);
  };
  let total = Math.max(0, morceaux.length - 1);
  for (const m of morceaux) total += longueur(m);
  const bouts: string[] = [];
  let n = 0;
  const pousser = (t: string): void => {
    bouts.push(t);
    n += longueurPy(t);
  };
  for (let i = 0; i < morceaux.length && n <= maxChars; i++) {
    if (i) pousser("\n");
    const m = morceaux[i] as [number, number] | string;
    if (typeof m === "string") {
      pousser(m);
      continue;
    }
    const [s, e] = m;
    const w = String(e).length;
    for (let j = s; j < e && n <= maxChars; j++) {
      if (j > s) pousser("\n");
      pousser(numeros ? `${String(j + 1).padStart(w)}\t${lignes[j] as string}` : (lignes[j] as string));
    }
  }
  return tronquerSur(bouts.join(""), maxChars, total);
}

/** `_read_one_file` : un chemin ; un `ValueError` du chemin remonte à l'appelant. */
async function lireUn(chemin: string, a: ArgsLecture, plages: unknown[], esp: Espace): Promise<Dict> {
  const rel = relDe(esp.racine, chemin);
  const p = toContainer(rel);
  let info: Dict;
  let brut: Buffer | null;
  let enc: string;
  try {
    const e = await esp.stat(rel);
    if (e["kind"] === "missing") {
      const parent = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "";
      const existe = !parent || (await esp.stat(parent))["kind"] === "dir";
      return errFs("not_found", `Check path; nearest existing parent: ${toContainer(existe ? parent : "")}`, {
        path: p,
      });
    }
    if (e["kind"] === "dir") return errFs("is_directory", "Use list_files for directories.", { path: p });
    if (e["kind"] !== "file")
      return errFs(
        "not_a_regular_file",
        "FIFOs, sockets, device files and symlinks leaving /work are not read.",
        { path: p },
      );
    info = statEntree(esp, rel, e);
    info["mime"] = mime(esp, rel, e);
    const taille = info["size"] as number;
    brut = taille <= STREAM_READ_OVER ? (await esp.lire(rel, { maxBytes: STREAM_READ_OVER })).data : null;
    const tete =
      brut !== null ? brut.subarray(0, 8192) : (await esp.lire(rel, { length: 8192, maxBytes: 8192 })).data;
    const texte = estTexte(tete);
    info["type"] = texte ? "text" : "binary";

    if (!texte && !a.as_base64) {
      if (brut !== null) info["sha256"] = sha256(brut);
      else {
        const h = await esp.stat(rel, { hash: true, hashMax: HASH_MAX });
        info["sha256"] = Object.hasOwn(h, "sha256") ? h["sha256"] : "";
      }
      if (a.offset || a.length) {
        const n = Math.min(a.length || MAX_FILE_BIN, MAX_FILE_BIN);
        const debut = Math.max(0, a.offset);
        const data =
          brut !== null
            ? tranche(brut, debut, debut + n)
            : (await esp.lire(rel, { offset: debut, length: n, maxBytes: n })).data;
        return ok({
          ...info,
          format: "bytes_range",
          offset: a.offset,
          length: data.length,
          b64: data.toString("base64"),
        });
      }
      if (brut !== null && brut.length <= BIN_BASE64_MAX)
        return ok({ ...info, format: "base64", b64: brut.toString("base64") });
      const apercu = tete.subarray(0, BIN_PREVIEW_BYTES);
      return ok({
        ...info,
        format: "preview",
        hint: `Binary file (${taille} B, ${info["mime"]}): hexdump of the first ${BIN_PREVIEW_BYTES} bytes only. Use offset/length for a byte range (base64), or as_base64=true for the whole file.`,
        preview_bytes: apercu.length,
        preview_hex: Buffer.from(apercu).toString("hex"),
      });
    }

    enc = a.encoding || encodageBom(tete);
    info["encoding"] = enc;
    if (brut === null) {
      if (a.as_base64 || a.format || plages.length)
        return errFs(
          "too_large_for_mode",
          `File is ${taille} bytes: as_base64/format/line_ranges need the whole file. Use head, tail, start_line/end_line or grep (streamed).`,
          info,
        );
      try {
        return await lireGrosTexte(esp, rel, info, a, enc);
      } catch (x) {
        if (x instanceof ErreurRe)
          return errFs(`bad_regex: ${x.message}`, "Escape special chars with \\ .", info);
        throw x;
      }
    }
  } catch (x) {
    if (estErreurAgent(x)) return await errAgentLien(esp, x, rel);
    throw x;
  }
  let text: string;
  try {
    text = decoderPy(brut, enc, "replace");
  } catch (x) {
    return errFs(`decode_failed: ${strErreur(x)}`, "Try as_base64=True, or specify encoding=...", info);
  }
  info["sha256"] = sha256(brut);
  Object.assign(info, conventions(brut, text, enc, Boolean(a.encoding)));
  if (a.as_base64) return ok({ ...info, format: "base64", b64: brut.toString("base64") });
  if (text.startsWith("﻿")) text = text.slice(1);
  const lignes = splitlinesPy(text);
  const total = lignes.length;
  info["total_lines"] = total;
  const longueur = longueurPy(text);
  const minifie = total <= 3 && longueur > MINIFIED_LINE_MIN;
  if (minifie) info["minified"] = true;
  const maxChars = Math.max(1, Math.min(a.max_chars, MAX_READ_CHARS));
  const numeros = a.with_line_numbers;
  const limiteLigne = maxChars > MAX_CHARS_DEFAUT ? maxChars : LIGNE_MAX;
  const vue = (l: string): string => coupeLigne(l, limiteLigne);

  if (a.format === "json") {
    let joli: string;
    try {
      joli = pyJsonDumps(pyJsonLoads(text), { indent: 2, ensureAscii: false });
    } catch (x) {
      if (!(x instanceof ErreurJsonPy)) throw x;
      return errFs(
        `invalid_json: ${x.msgPy} at line ${x.lineno} col ${x.colno}`,
        `Error at line ${x.lineno}. Read that range first.`,
        info,
      );
    }
    const [contenu, coupe] = tronquer(joli, maxChars);
    return ok({ ...info, format: "json", valid: true, content: contenu, truncated: coupe });
  }
  if (a.format === "yaml") {
    let joli: string;
    try {
      joli = dumpPy(charger(text));
    } catch (x) {
      if (!(x instanceof ErreurYaml)) throw x;
      return errFs(`invalid_yaml: ${x.message}`, "Check indentation and special chars.", info);
    }
    const [contenu, coupe] = tronquer(joli, maxChars);
    return ok({ ...info, format: "yaml", valid: true, content: contenu, truncated: coupe });
  }

  if (plages.length) {
    const brutes: [number, number][] = [];
    const ajustements: string[] = [];
    for (const rng of plages) {
      let s: number;
      let e: number;
      try {
        if (!Array.isArray(rng) || rng.length < 1) throw new TypeError("plage");
        s = Math.max(intPy(rng[0]) - 1, 0);
        e = rng.length > 1 && intPy(rng[1]) > 0 ? intPy(rng[1]) : total;
      } catch {
        return errFs("bad_line_range", "line_ranges=[[start,end],...] (1-based inclusive)");
      }
      const demande = JSON.stringify(rng);
      if (s >= total) {
        ajustements.push(`${demande} dropped: starts after the last line (${total})`);
        continue;
      }
      if (e > total) ajustements.push(`${demande} end clamped to ${total}`);
      brutes.push([s, Math.min(e, total)]);
    }
    brutes.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
    const fusion: [number, number][] = [];
    for (const [s, e] of brutes) {
      const prec = fusion[fusion.length - 1];
      if (prec !== undefined && s <= prec[1]) {
        ajustements.push(`[${prec[0] + 1},${prec[1]}] and [${s + 1},${e}] merged`);
        prec[1] = Math.max(prec[1], e);
      } else fusion.push([s, e]);
    }
    const spans: Dict[] = [];
    const morceaux: ([number, number] | string)[] = [];
    let derniere = -1;
    for (const [s, e] of fusion) {
      if (derniere >= 0 && s > derniere) morceaux.push(`...[lines ${derniere + 1}-${s} omitted]...`);
      morceaux.push([s, Math.max(s, e)]);
      spans.push({ start: s + 1, end: e, lines: Math.max(0, Math.min(e, total) - s) });
      derniere = Math.max(derniere, e);
    }
    const [contenu, coupe] = plagesRendues(lignes.map(vue), morceaux, numeros, maxChars);
    return noterCoupes(
      ok({
        ...info,
        format: "ranges",
        spans,
        shown_lines: tailleUnion(fusion),
        content: contenu,
        truncated: coupe,
        ...(ajustements.length ? { adjusted: ajustements } : {}),
      }),
    );
  }

  if (a.grep) {
    let motif;
    try {
      verifierRegexSure(a.grep);
      motif = compilerPy(a.grep, a.ignore_case ? RE_IGNORECASE : 0);
    } catch (x) {
      if (x instanceof ErreurRe)
        return errFs(`bad_regex: ${x.message}`, "Escape special chars with \\ .", info);
      throw x;
    }
    const touches: number[] = [];
    lignes.forEach((ln, k) => {
      if (chercher(motif, ln) !== null) touches.push(k + 1);
    });
    if (!touches.length) return ok({ ...info, format: "grep", matches: 0, content: "", hint: "no matches" });
    const estTouche = new Set(touches);
    let affichees: number[] = touches;
    if (a.grep_context > 0) {
      affichees = [];
      let fin = 0;
      for (const i of touches) {
        const lo = Math.max(1, i - a.grep_context, fin + 1);
        const hi = Math.min(total, i + a.grep_context);
        for (let k = lo; k <= hi; k++) affichees.push(k);
        fin = Math.max(fin, hi);
      }
    }
    const sortie: string[] = [];
    let prec = 0;
    for (const i of affichees) {
      if (prec && i - prec > 1) sortie.push("--");
      sortie.push(`${i}${estTouche.has(i) ? ":" : "-"}${vue(lignes[i - 1] as string)}`);
      prec = i;
    }
    const [contenu, coupe] = tronquer(sortie.join("\n"), maxChars);
    return noterCoupes(
      ok({
        ...info,
        format: "grep",
        matches: touches.length,
        shown_lines: affichees.length,
        content: contenu,
        truncated: coupe,
      }),
    );
  }

  if (a.head > 0) {
    const tranchees = lignes.slice(0, Math.min(a.head, total)).map(vue);
    const [contenu, coupe] = tronquer(formaterLignes(tranchees, 1, numeros), maxChars);
    return noterCoupes(
      ok({ ...info, format: "head", shown_lines: tranchees.length, content: contenu, truncated: coupe }),
    );
  }
  if (a.tail > 0) {
    const n = Math.min(a.tail, total);
    const tranchees = (n ? lignes.slice(-n) : []).map(vue);
    const debut = n ? total - n + 1 : 1;
    const [contenu, coupe] = tronquer(formaterLignes(tranchees, debut, numeros), maxChars);
    return noterCoupes(
      ok({
        ...info,
        format: "tail",
        shown_lines: tranchees.length,
        start_line: debut,
        content: contenu,
        truncated: coupe,
      }),
    );
  }
  if (a.start_line > 0 || a.end_line > 0) {
    const s = Math.max(a.start_line - 1, 0);
    const e = a.end_line > 0 ? a.end_line : total;
    const tranchees = (e > s ? lignes.slice(s, e) : []).map(vue);
    const [contenu, coupe] = tronquer(formaterLignes(tranchees, s + 1, numeros), maxChars);
    return noterCoupes(
      ok({
        ...info,
        format: "range",
        start: s + 1,
        end: Math.min(e, total),
        shown_lines: tranchees.length,
        content: contenu,
        truncated: coupe,
      }),
    );
  }

  if (minifie)
    return ok({
      ...info,
      format: "preview",
      hint: "Minified file. Use grep or start_line/end_line ranges.",
      content: `${prefixePy(text, 2000)}\n...[MINIFIED OMITTED]...\n${suffixePy(text, 1000)}`,
    });
  if (longueur > maxChars || (info["size"] as number) > MAX_FILE_TEXT) {
    let contenu: string;
    if (total <= PREVIEW_HEAD_LINES + PREVIEW_TAIL_LINES) contenu = formaterLignes(lignes, 1, numeros);
    else {
      const t1 = formaterLignes(lignes.slice(0, PREVIEW_HEAD_LINES), 1, numeros);
      const t2 = formaterLignes(lignes.slice(-PREVIEW_TAIL_LINES), total - PREVIEW_TAIL_LINES + 1, numeros);
      const omises = total - PREVIEW_HEAD_LINES - PREVIEW_TAIL_LINES;
      contenu = `${t1}\n... [${omises} lines omitted — file is ${milliers(longueur)} chars / ${total} lines total] ...\n${t2}`;
    }
    return ok({
      ...info,
      format: "auto_truncated",
      head_lines: Math.min(PREVIEW_HEAD_LINES, total),
      tail_lines: Math.min(PREVIEW_TAIL_LINES, total),
      omitted_lines: Math.max(0, total - PREVIEW_HEAD_LINES - PREVIEW_TAIL_LINES),
      content: contenu,
      hint: `File exceeds max_chars=${maxChars}. To get specifics: head=N, tail=N, start_line/end_line, grep='...', or line_ranges=[[s,e]]. To force full content: max_chars=${longueur + 1}.`,
    });
  }
  return ok({
    ...info,
    format: "text",
    content: numeros ? formaterLignes(lignes, 1, true) : text,
    truncated: false,
  });
}

/** `read_file` : un chemin ou un lot (`paths`), échecs indépendants dans un lot. */
export async function readFile(a: ArgsLecture, ctx: ContexteAppel): Promise<Dict> {
  const username = getUsername(ctx);
  try {
    const esp = await Espace.pour(username);
    const plages = asList(a.line_ranges);
    const chemins = asList(a.paths);
    if (chemins.length) {
      if (a.path) return errFs("conflict", "Pass either path=<single> OR paths=[...], not both.");
      if (chemins.length > MAX_BATCH_PATHS)
        return errFs(
          "too_many_paths",
          `Max ${MAX_BATCH_PATHS} paths per call. Split across multiple calls if needed.`,
        );
      const fichiers: Dict = {};
      let reussis = 0;
      for (const c of chemins) {
        if (typeof c !== "string" || !c) {
          poserCle(fichiers, strPy(c), errFs("bad_path", "Each entry must be a non-empty string."));
          continue;
        }
        const r = await lireUn(c, a, plages, esp).catch((e: unknown) => {
          if (!estValueError(e)) throw e;
          return errFs(e.message, "", { path: c });
        });
        poserCle(fichiers, c, r);
        if (veritePy(r["ok"])) reussis++;
      }
      return ok({
        action: "batch_read",
        count: chemins.length,
        succeeded: reussis,
        failed: chemins.length - reussis,
        files: fichiers,
      });
    }
    if (!a.path) return errFs("path_required", "Pass path=<file> or paths=[<file1>, <file2>, ...].");
    return await lireUn(a.path, a, plages, esp);
  } catch (e) {
    if (estValueError(e)) return errFs(e.message);
    return errFs(`unexpected: ${strErreur(e)}`);
  }
}
