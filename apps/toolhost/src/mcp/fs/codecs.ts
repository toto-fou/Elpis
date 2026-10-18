// SPDX-License-Identifier: MIT
/** apps/toolhost/src/mcp/fs/codecs.ts — codecs Python de read_file et write_file : noms et alias (`codecs.lookup`), décodage strict (position de l'octet fautif) ou avec remplacement, encodage strict (position du caractère). */

/** `UnicodeDecodeError`, `UnicodeEncodeError` (`start`) ou `LookupError` (codec inconnu ou non textuel). */
export class ErreurCodec extends Error {
  override readonly name: "UnicodeDecodeError" | "UnicodeEncodeError" | "LookupError";
  readonly start: number | null;

  constructor(name: ErreurCodec["name"], message: string, start: number | null = null) {
    super(message);
    this.name = name;
    this.start = start;
  }
}

// Octets 0x80 à 0xFF des codecs à un octet (CPython 3.13, encodings/<codec>.py) ; ￿ : octet non défini.
const HAUTS: Readonly<Record<string, string>> = {
  cp1252:
    "\u20ac\uffff\u201a\u0192\u201e\u2026\u2020\u2021\u02c6\u2030\u0160\u2039\u0152\uffff\u017d\uffff\uffff\u2018\u2019\u201c\u201d\u2022\u2013\u2014\u02dc\u2122\u0161\u203a\u0153\uffff\u017e\u0178\u00a0\u00a1\u00a2\u00a3\u00a4\u00a5\u00a6\u00a7\u00a8\u00a9\u00aa\u00ab\u00ac\u00ad\u00ae\u00af\u00b0\u00b1\u00b2\u00b3\u00b4\u00b5\u00b6\u00b7\u00b8\u00b9\u00ba\u00bb\u00bc\u00bd\u00be\u00bf\u00c0\u00c1\u00c2\u00c3\u00c4\u00c5\u00c6\u00c7\u00c8\u00c9\u00ca\u00cb\u00cc\u00cd\u00ce\u00cf\u00d0\u00d1\u00d2\u00d3\u00d4\u00d5\u00d6\u00d7\u00d8\u00d9\u00da\u00db\u00dc\u00dd\u00de\u00df\u00e0\u00e1\u00e2\u00e3\u00e4\u00e5\u00e6\u00e7\u00e8\u00e9\u00ea\u00eb\u00ec\u00ed\u00ee\u00ef\u00f0\u00f1\u00f2\u00f3\u00f4\u00f5\u00f6\u00f7\u00f8\u00f9\u00fa\u00fb\u00fc\u00fd\u00fe\u00ff",
  iso8859_15:
    "\u0080\u0081\u0082\u0083\u0084\u0085\u0086\u0087\u0088\u0089\u008a\u008b\u008c\u008d\u008e\u008f\u0090\u0091\u0092\u0093\u0094\u0095\u0096\u0097\u0098\u0099\u009a\u009b\u009c\u009d\u009e\u009f\u00a0\u00a1\u00a2\u00a3\u20ac\u00a5\u0160\u00a7\u0161\u00a9\u00aa\u00ab\u00ac\u00ad\u00ae\u00af\u00b0\u00b1\u00b2\u00b3\u017d\u00b5\u00b6\u00b7\u017e\u00b9\u00ba\u00bb\u0152\u0153\u0178\u00bf\u00c0\u00c1\u00c2\u00c3\u00c4\u00c5\u00c6\u00c7\u00c8\u00c9\u00ca\u00cb\u00cc\u00cd\u00ce\u00cf\u00d0\u00d1\u00d2\u00d3\u00d4\u00d5\u00d6\u00d7\u00d8\u00d9\u00da\u00db\u00dc\u00dd\u00de\u00df\u00e0\u00e1\u00e2\u00e3\u00e4\u00e5\u00e6\u00e7\u00e8\u00e9\u00ea\u00eb\u00ec\u00ed\u00ee\u00ef\u00f0\u00f1\u00f2\u00f3\u00f4\u00f5\u00f6\u00f7\u00f8\u00f9\u00fa\u00fb\u00fc\u00fd\u00fe\u00ff",
  cp1251:
    "\u0402\u0403\u201a\u0453\u201e\u2026\u2020\u2021\u20ac\u2030\u0409\u2039\u040a\u040c\u040b\u040f\u0452\u2018\u2019\u201c\u201d\u2022\u2013\u2014\uffff\u2122\u0459\u203a\u045a\u045c\u045b\u045f\u00a0\u040e\u045e\u0408\u00a4\u0490\u00a6\u00a7\u0401\u00a9\u0404\u00ab\u00ac\u00ad\u00ae\u0407\u00b0\u00b1\u0406\u0456\u0491\u00b5\u00b6\u00b7\u0451\u2116\u0454\u00bb\u0458\u0405\u0455\u0457\u0410\u0411\u0412\u0413\u0414\u0415\u0416\u0417\u0418\u0419\u041a\u041b\u041c\u041d\u041e\u041f\u0420\u0421\u0422\u0423\u0424\u0425\u0426\u0427\u0428\u0429\u042a\u042b\u042c\u042d\u042e\u042f\u0430\u0431\u0432\u0433\u0434\u0435\u0436\u0437\u0438\u0439\u043a\u043b\u043c\u043d\u043e\u043f\u0440\u0441\u0442\u0443\u0444\u0445\u0446\u0447\u0448\u0449\u044a\u044b\u044c\u044d\u044e\u044f",
  cp1250:
    "\u20ac\uffff\u201a\uffff\u201e\u2026\u2020\u2021\uffff\u2030\u0160\u2039\u015a\u0164\u017d\u0179\uffff\u2018\u2019\u201c\u201d\u2022\u2013\u2014\uffff\u2122\u0161\u203a\u015b\u0165\u017e\u017a\u00a0\u02c7\u02d8\u0141\u00a4\u0104\u00a6\u00a7\u00a8\u00a9\u015e\u00ab\u00ac\u00ad\u00ae\u017b\u00b0\u00b1\u02db\u0142\u00b4\u00b5\u00b6\u00b7\u00b8\u0105\u015f\u00bb\u013d\u02dd\u013e\u017c\u0154\u00c1\u00c2\u0102\u00c4\u0139\u0106\u00c7\u010c\u00c9\u0118\u00cb\u011a\u00cd\u00ce\u010e\u0110\u0143\u0147\u00d3\u00d4\u0150\u00d6\u00d7\u0158\u016e\u00da\u0170\u00dc\u00dd\u0162\u00df\u0155\u00e1\u00e2\u0103\u00e4\u013a\u0107\u00e7\u010d\u00e9\u0119\u00eb\u011b\u00ed\u00ee\u010f\u0111\u0144\u0148\u00f3\u00f4\u0151\u00f6\u00f7\u0159\u016f\u00fa\u0171\u00fc\u00fd\u0163\u02d9",
  koi8_r:
    "\u2500\u2502\u250c\u2510\u2514\u2518\u251c\u2524\u252c\u2534\u253c\u2580\u2584\u2588\u258c\u2590\u2591\u2592\u2593\u2320\u25a0\u2219\u221a\u2248\u2264\u2265\u00a0\u2321\u00b0\u00b2\u00b7\u00f7\u2550\u2551\u2552\u0451\u2553\u2554\u2555\u2556\u2557\u2558\u2559\u255a\u255b\u255c\u255d\u255e\u255f\u2560\u2561\u0401\u2562\u2563\u2564\u2565\u2566\u2567\u2568\u2569\u256a\u256b\u256c\u00a9\u044e\u0430\u0431\u0446\u0434\u0435\u0444\u0433\u0445\u0438\u0439\u043a\u043b\u043c\u043d\u043e\u043f\u044f\u0440\u0441\u0442\u0443\u0436\u0432\u044c\u044b\u0437\u0448\u044d\u0449\u0447\u044a\u042e\u0410\u0411\u0426\u0414\u0415\u0424\u0413\u0425\u0418\u0419\u041a\u041b\u041c\u041d\u041e\u041f\u042f\u0420\u0421\u0422\u0423\u0416\u0412\u042c\u042b\u0417\u0428\u042d\u0429\u0427\u042a",
  mac_roman:
    "\u00c4\u00c5\u00c7\u00c9\u00d1\u00d6\u00dc\u00e1\u00e0\u00e2\u00e4\u00e3\u00e5\u00e7\u00e9\u00e8\u00ea\u00eb\u00ed\u00ec\u00ee\u00ef\u00f1\u00f3\u00f2\u00f4\u00f6\u00f5\u00fa\u00f9\u00fb\u00fc\u2020\u00b0\u00a2\u00a3\u00a7\u2022\u00b6\u00df\u00ae\u00a9\u2122\u00b4\u00a8\u2260\u00c6\u00d8\u221e\u00b1\u2264\u2265\u00a5\u00b5\u2202\u2211\u220f\u03c0\u222b\u00aa\u00ba\u03a9\u00e6\u00f8\u00bf\u00a1\u00ac\u221a\u0192\u2248\u2206\u00ab\u00bb\u2026\u00a0\u00c0\u00c3\u00d5\u0152\u0153\u2013\u2014\u201c\u201d\u2018\u2019\u00f7\u25ca\u00ff\u0178\u2044\u20ac\u2039\u203a\ufb01\ufb02\u2021\u00b7\u201a\u201e\u2030\u00c2\u00ca\u00c1\u00cb\u00c8\u00cd\u00ce\u00cf\u00cc\u00d3\u00d4\uf8ff\u00d2\u00da\u00db\u00d9\u0131\u02c6\u02dc\u00af\u02d8\u02d9\u02da\u00b8\u02dd\u02db\u02c7",
  cp437:
    "\u00c7\u00fc\u00e9\u00e2\u00e4\u00e0\u00e5\u00e7\u00ea\u00eb\u00e8\u00ef\u00ee\u00ec\u00c4\u00c5\u00c9\u00e6\u00c6\u00f4\u00f6\u00f2\u00fb\u00f9\u00ff\u00d6\u00dc\u00a2\u00a3\u00a5\u20a7\u0192\u00e1\u00ed\u00f3\u00fa\u00f1\u00d1\u00aa\u00ba\u00bf\u2310\u00ac\u00bd\u00bc\u00a1\u00ab\u00bb\u2591\u2592\u2593\u2502\u2524\u2561\u2562\u2556\u2555\u2563\u2551\u2557\u255d\u255c\u255b\u2510\u2514\u2534\u252c\u251c\u2500\u253c\u255e\u255f\u255a\u2554\u2569\u2566\u2560\u2550\u256c\u2567\u2568\u2564\u2565\u2559\u2558\u2552\u2553\u256b\u256a\u2518\u250c\u2588\u2584\u258c\u2590\u2580\u03b1\u00df\u0393\u03c0\u03a3\u03c3\u00b5\u03c4\u03a6\u0398\u03a9\u03b4\u221e\u03c6\u03b5\u2229\u2261\u00b1\u2265\u2264\u2320\u2321\u00f7\u2248\u00b0\u2219\u00b7\u221a\u207f\u00b2\u25a0\u00a0",
  cp850:
    "\u00c7\u00fc\u00e9\u00e2\u00e4\u00e0\u00e5\u00e7\u00ea\u00eb\u00e8\u00ef\u00ee\u00ec\u00c4\u00c5\u00c9\u00e6\u00c6\u00f4\u00f6\u00f2\u00fb\u00f9\u00ff\u00d6\u00dc\u00f8\u00a3\u00d8\u00d7\u0192\u00e1\u00ed\u00f3\u00fa\u00f1\u00d1\u00aa\u00ba\u00bf\u00ae\u00ac\u00bd\u00bc\u00a1\u00ab\u00bb\u2591\u2592\u2593\u2502\u2524\u00c1\u00c2\u00c0\u00a9\u2563\u2551\u2557\u255d\u00a2\u00a5\u2510\u2514\u2534\u252c\u251c\u2500\u253c\u00e3\u00c3\u255a\u2554\u2569\u2566\u2560\u2550\u256c\u00a4\u00f0\u00d0\u00ca\u00cb\u00c8\u0131\u00cd\u00ce\u00cf\u2518\u250c\u2588\u2584\u00a6\u00cc\u2580\u00d3\u00df\u00d4\u00d2\u00f5\u00d5\u00b5\u00fe\u00de\u00da\u00db\u00d9\u00fd\u00dd\u00af\u00b4\u00ad\u00b1\u2017\u00be\u00b6\u00a7\u00f7\u00b8\u00b0\u00a8\u00b7\u00b9\u00b3\u00b2\u25a0\u00a0",
  iso8859_2:
    "\u0080\u0081\u0082\u0083\u0084\u0085\u0086\u0087\u0088\u0089\u008a\u008b\u008c\u008d\u008e\u008f\u0090\u0091\u0092\u0093\u0094\u0095\u0096\u0097\u0098\u0099\u009a\u009b\u009c\u009d\u009e\u009f\u00a0\u0104\u02d8\u0141\u00a4\u013d\u015a\u00a7\u00a8\u0160\u015e\u0164\u0179\u00ad\u017d\u017b\u00b0\u0105\u02db\u0142\u00b4\u013e\u015b\u02c7\u00b8\u0161\u015f\u0165\u017a\u02dd\u017e\u017c\u0154\u00c1\u00c2\u0102\u00c4\u0139\u0106\u00c7\u010c\u00c9\u0118\u00cb\u011a\u00cd\u00ce\u010e\u0110\u0143\u0147\u00d3\u00d4\u0150\u00d6\u00d7\u0158\u016e\u00da\u0170\u00dc\u00dd\u0162\u00df\u0155\u00e1\u00e2\u0103\u00e4\u013a\u0107\u00e7\u010d\u00e9\u0119\u00eb\u011b\u00ed\u00ee\u010f\u0111\u0144\u0148\u00f3\u00f4\u0151\u00f6\u00f7\u0159\u016f\u00fa\u0171\u00fc\u00fd\u0163\u02d9",
};

const ALIAS: Readonly<Record<string, string>> = { "1250": "cp1250", "1251": "cp1251", "1252": "cp1252", "437": "cp437", "646": "ascii", "850": "cp850", "8859": "latin_1", "936": "gbk", "ansi_x3.4_1968": "ascii", "ansi_x3.4_1986": "ascii", "ansi_x3_4_1968": "ascii", "big5_tw": "big5", "chinese": "gb2312", "cp367": "ascii", "cp65001": "utf_8", "cp819": "latin_1", "cp936": "gbk", "csascii": "ascii", "csbig5": "big5", "csiso58gb231280": "gb2312", "csisolatin1": "latin_1", "csisolatin2": "iso8859_2", "cskoi8r": "koi8_r", "cspc850multilingual": "cp850", "cspc8codepage437": "cp437", "csshiftjis": "shift_jis", "euc_cn": "gb2312", "euccn": "gb2312", "eucgb2312_cn": "gb2312", "eucjp": "euc_jp", "euckr": "euc_kr", "gb18030_2000": "gb18030", "gb2312_1980": "gb2312", "gb2312_80": "gb2312", "ibm367": "ascii", "ibm437": "cp437", "ibm819": "latin_1", "ibm850": "cp850", "iso646_us": "ascii", "iso8859": "latin_1", "iso8859_1": "latin_1", "iso_646.irv_1991": "ascii", "iso_8859_1": "latin_1", "iso_8859_15": "iso8859_15", "iso_8859_1_1987": "latin_1", "iso_8859_2": "iso8859_2", "iso_8859_2_1987": "iso8859_2", "iso_ir_100": "latin_1", "iso_ir_101": "iso8859_2", "iso_ir_58": "gb2312", "iso_ir_6": "ascii", "korean": "euc_kr", "ks_c_5601": "euc_kr", "ks_c_5601_1987": "euc_kr", "ks_x_1001": "euc_kr", "ksc5601": "euc_kr", "ksx1001": "euc_kr", "l1": "latin_1", "l2": "iso8859_2", "l9": "iso8859_15", "latin": "latin_1", "latin1": "latin_1", "latin2": "iso8859_2", "latin9": "iso8859_15", "macintosh": "mac_roman", "macroman": "mac_roman", "ms936": "gbk", "s_jis": "shift_jis", "shiftjis": "shift_jis", "sjis": "shift_jis", "u16": "utf_16", "u32": "utf_32", "u8": "utf_8", "u_jis": "euc_jp", "ujis": "euc_jp", "unicodebigunmarked": "utf_16_be", "unicodelittleunmarked": "utf_16_le", "us": "ascii", "us_ascii": "ascii", "utf": "utf_8", "utf16": "utf_16", "utf32": "utf_32", "utf8": "utf_8", "utf8_ucs2": "utf_8", "utf8_ucs4": "utf_8", "utf_16be": "utf_16_be", "utf_16le": "utf_16_le", "utf_32be": "utf_32_be", "utf_32le": "utf_32_le", "windows_1250": "cp1250", "windows_1251": "cp1251", "windows_1252": "cp1252", "x_mac_japanese": "shift_jis", "x_mac_korean": "euc_kr", "x_mac_simp_chinese": "gb2312", "x_mac_trad_chinese": "big5", base64: "base64_codec", base_64: "base64_codec", bz2: "bz2_codec", hex: "hex_codec", quopri: "quopri_codec", quoted_printable: "quopri_codec", quotedprintable: "quopri_codec", uu: "uu_codec", zip: "zlib_codec", zlib: "zlib_codec", rot13: "rot_13" }; // prettier-ignore
const NON_TEXTE = new Set([
  "base64_codec",
  "bz2_codec",
  "hex_codec",
  "quopri_codec",
  "uu_codec",
  "zlib_codec",
  "rot_13",
]);
/** Codecs multi-octets décodés par le TextDecoder (WHATWG) : encodage non pris en charge (écart). */
const WHATWG: Readonly<Record<string, string>> = { shift_jis: "shift_jis", euc_jp: "euc-jp", gbk: "gbk", gb2312: "gbk", gb18030: "gb18030", big5: "big5", euc_kr: "euc-kr" }; // prettier-ignore
const UNICODE = new Set([
  "utf_8",
  "utf_8_sig",
  "utf_16",
  "utf_16_le",
  "utf_16_be",
  "utf_32",
  "utf_32_le",
  "utf_32_be",
]);

/** `encodings.normalize_encoding` après la mise en minuscules de `codecs.lookup`. */
function normaliser(nom: string): string {
  let sortie = "";
  let ponctuation = false;
  for (const c of nom.toLowerCase().replace(/[ -]/gu, "_")) {
    if (/^[\p{L}\p{N}.]$/u.test(c)) {
      if (ponctuation && sortie) sortie += "_";
      if (c.charCodeAt(0) < 128) sortie += c;
      ponctuation = false;
    } else ponctuation = true;
  }
  return sortie;
}

/** Nom du module de codec (`latin_1`, `utf_8`…) ; `LookupError` comme Python (inconnu, ou non textuel : `sens` = decode/encode). */
export function codecPy(nom: string, sens: "decode" | "encode" = "decode"): string {
  const n = normaliser(nom);
  const module = ALIAS[n] ?? ALIAS[n.replace(/\./gu, "_")] ?? n;
  if (NON_TEXTE.has(module))
    throw new ErreurCodec(
      "LookupError",
      `'${nom}' is not a text encoding; use codecs.${sens}() to handle arbitrary codecs`,
    );
  if (UNICODE.has(module) || module === "latin_1" || module === "ascii" || HAUTS[module] !== undefined)
    return module;
  if (WHATWG[module] !== undefined) return module;
  throw new ErreurCodec("LookupError", `unknown encoding: ${nom}`);
}

const REMPLACEMENT = "�";

/** Première erreur UTF-8 (début de la sous-partie maximale invalide) et son étendue, comme le décodeur de CPython. */
function erreurUtf8(b: Uint8Array, i: number): number {
  const c = b[i] as number;
  const suite = (k: number, lo = 0x80, hi = 0xbf): boolean => {
    const x = b[i + k];
    return x !== undefined && x >= lo && x <= hi;
  };
  if (c < 0x80) return 0;
  if (c >= 0xc2 && c <= 0xdf) return suite(1) ? 0 : 1;
  if (c >= 0xe0 && c <= 0xef) {
    const lo = c === 0xe0 ? 0xa0 : 0x80;
    const hi = c === 0xed ? 0x9f : 0xbf;
    if (!suite(1, lo, hi)) return 1;
    return suite(2) ? 0 : 2;
  }
  if (c >= 0xf0 && c <= 0xf4) {
    const lo = c === 0xf0 ? 0x90 : 0x80;
    const hi = c === 0xf4 ? 0x8f : 0xbf;
    if (!suite(1, lo, hi)) return 1;
    if (!suite(2)) return 2;
    return suite(3) ? 0 : 3;
  }
  return 1;
}

function longueurUtf8(c: number): number {
  return c < 0x80 ? 1 : c < 0xe0 ? 2 : c < 0xf0 ? 3 : 4;
}

/** Position du premier octet invalide en UTF-8, `null` si tout est valide. */
export function positionErreurUtf8(b: Uint8Array): number | null {
  for (let i = 0; i < b.length;) {
    const e = erreurUtf8(b, i);
    if (e) return i;
    i += longueurUtf8(b[i] as number);
  }
  return null;
}

const UTF8 = new TextDecoder("utf-8", { ignoreBOM: true });
const UTF8_SIG = new TextDecoder("utf-8");
const UTF8_STRICT = new TextDecoder("utf-8", { ignoreBOM: true, fatal: true });
const UTF8_SIG_STRICT = new TextDecoder("utf-8", { fatal: true });

function decoderUtf16(b: Uint8Array, petit: boolean, strict: boolean, decalage: number): string {
  if (b.length % 2 === 0) {
    const copie = Buffer.from(b);
    const t = (petit ? copie : copie.swap16()).toString("utf16le");
    if (t.isWellFormed()) return t;
  }
  let sortie = "";
  const n = b.length - (b.length % 2);
  for (let i = 0; i < n; i += 2) {
    const u = petit
      ? (b[i] as number) | ((b[i + 1] as number) << 8)
      : ((b[i] as number) << 8) | (b[i + 1] as number);
    if (u >= 0xd800 && u <= 0xdbff) {
      if (i + 3 < n + (b.length % 2) && i + 2 < n) {
        const v = petit
          ? (b[i + 2] as number) | ((b[i + 3] as number) << 8)
          : ((b[i + 2] as number) << 8) | (b[i + 3] as number);
        if (v >= 0xdc00 && v <= 0xdfff) {
          sortie += String.fromCharCode(u, v);
          i += 2;
          continue;
        }
      }
      if (strict) throw new ErreurCodec("UnicodeDecodeError", "illegal encoding", decalage + i);
      sortie += REMPLACEMENT;
    } else if (u >= 0xdc00 && u <= 0xdfff) {
      if (strict) throw new ErreurCodec("UnicodeDecodeError", "illegal encoding", decalage + i);
      sortie += REMPLACEMENT;
    } else sortie += String.fromCharCode(u);
  }
  if (b.length % 2) {
    if (strict) throw new ErreurCodec("UnicodeDecodeError", "truncated data", decalage + n);
    sortie += REMPLACEMENT;
  }
  return sortie;
}

function decoderUtf32(b: Uint8Array, petit: boolean, strict: boolean, decalage: number): string {
  let sortie = "";
  const n = b.length - (b.length % 4);
  for (let i = 0; i < n; i += 4) {
    const x = petit
      ? ((b[i] as number) |
          ((b[i + 1] as number) << 8) |
          ((b[i + 2] as number) << 16) |
          ((b[i + 3] as number) << 24)) >>>
        0
      : (((b[i] as number) << 24) |
          ((b[i + 1] as number) << 16) |
          ((b[i + 2] as number) << 8) |
          (b[i + 3] as number)) >>>
        0;
    if (x > 0x10ffff || (x >= 0xd800 && x <= 0xdfff)) {
      if (strict)
        throw new ErreurCodec("UnicodeDecodeError", "code point not in range(0x110000)", decalage + i);
      sortie += REMPLACEMENT;
    } else sortie += String.fromCodePoint(x);
  }
  if (b.length % 4) {
    if (strict) throw new ErreurCodec("UnicodeDecodeError", "truncated data", decalage + n);
    sortie += REMPLACEMENT;
  }
  return sortie;
}

const tables = new Map<string, Uint16Array>();

/** Unité UTF-16 de chaque octet d'un codec à un octet (0xFFFF : non défini). */
function tableOctets(module: string): Uint16Array {
  let t = tables.get(module);
  if (t === undefined) {
    t = new Uint16Array(256).fill(0xffff);
    for (let o = 0; o < 0x80; o++) t[o] = o;
    const hauts = module === "ascii" ? "" : (HAUTS[module] as string);
    for (let k = 0; k < hauts.length; k++) t[0x80 + k] = hauts.charCodeAt(k);
    tables.set(module, t);
  }
  return t;
}

/** `octets.decode(encodage, errors)` : `strict` lève `UnicodeDecodeError` (`start`), `replace` met U+FFFD. */
export function decoderPy(b: Uint8Array, encodage: string, errors: "strict" | "replace" = "strict"): string {
  const module = codecPy(encodage, "decode");
  const strict = errors === "strict";
  switch (module) {
    case "utf_8":
    case "utf_8_sig": {
      if (strict) {
        try {
          return (module === "utf_8" ? UTF8_STRICT : UTF8_SIG_STRICT).decode(b);
        } catch {
          throw new ErreurCodec("UnicodeDecodeError", "invalid utf-8", positionErreurUtf8(b) ?? 0);
        }
      }
      return (module === "utf_8" ? UTF8 : UTF8_SIG).decode(b);
    }
    case "utf_16":
    case "utf_32": {
      const t = module === "utf_16" ? 2 : 4;
      const bom = t === 2 ? [b[0], b[1]] : [b[0], b[1], b[2], b[3]];
      const le = t === 2 ? bom[0] === 0xff && bom[1] === 0xfe : bom.join() === [0xff, 0xfe, 0, 0].join();
      const be = t === 2 ? bom[0] === 0xfe && bom[1] === 0xff : bom.join() === [0, 0, 0xfe, 0xff].join();
      const corps = le || be ? b.subarray(t) : b;
      const f = t === 2 ? decoderUtf16 : decoderUtf32;
      return f(corps, !be, strict, le || be ? t : 0);
    }
    case "utf_16_le":
    case "utf_16_be":
      return decoderUtf16(b, module === "utf_16_le", strict, 0);
    case "utf_32_le":
    case "utf_32_be":
      return decoderUtf32(b, module === "utf_32_le", strict, 0);
    case "latin_1":
      return Buffer.from(b).toString("latin1");
    default: {
      const w = WHATWG[module];
      if (w !== undefined) {
        try {
          return new TextDecoder(w, { fatal: strict }).decode(b);
        } catch {
          throw new ErreurCodec("UnicodeDecodeError", "illegal multibyte sequence", 0);
        }
      }
      const table = tableOctets(module);
      const unites = new Uint16Array(b.length);
      for (let i = 0; i < b.length; i++) {
        const c = table[b[i] as number] as number;
        if (c === 0xffff) {
          if (strict) throw new ErreurCodec("UnicodeDecodeError", "character maps to <undefined>", i);
          unites[i] = 0xfffd;
        } else unites[i] = c;
      }
      return Buffer.from(unites.buffer, unites.byteOffset, unites.byteLength).toString("utf16le");
    }
  }
}

const inverses = new Map<string, Map<number, number>>();

function inverse(module: string): Map<number, number> {
  let m = inverses.get(module);
  if (m === undefined) {
    m = new Map();
    const hauts = HAUTS[module] ?? "";
    for (let i = 0; i < hauts.length; i++) if (hauts[i] !== "￿") m.set(hauts.charCodeAt(i), 0x80 + i);
    inverses.set(module, m);
  }
  return m;
}

const NOM_ERREUR: Readonly<Record<string, string>> = { utf_8: "utf-8", utf_8_sig: "utf-8", utf_16: "utf-16", utf_16_le: "utf-16-le", utf_16_be: "utf-16-be", utf_32: "utf-32", utf_32_le: "utf-32-le", utf_32_be: "utf-32-be", ascii: "ascii", latin_1: "latin-1" }; // prettier-ignore

/** `str(UnicodeEncodeError)` : codec, caractère ou étendue (suite de caractères refusés), raison, comme CPython 3.13. */
function erreurEncodage(module: string, points: readonly string[], debut: number): ErreurCodec {
  const code = (k: number): number => (points[k] as string).codePointAt(0) as number;
  const surrogat = (k: number): boolean => code(k) >= 0xd800 && code(k) <= 0xdfff;
  const nom = NOM_ERREUR[module] ?? "charmap";
  let fin = debut + 1;
  let raison = "character maps to <undefined>";
  if (module.startsWith("utf_8")) {
    raison = "surrogates not allowed";
    while (fin < points.length && surrogat(fin)) fin++;
  } else if (module.startsWith("utf_")) raison = "surrogates not allowed";
  else if (module === "ascii" || module === "latin_1") {
    const limite = module === "ascii" ? 0x80 : 0x100;
    raison = `ordinal not in range(${limite})`;
    while (fin < points.length && code(fin) >= limite) fin++;
  } else {
    const inv = inverse(module);
    while (fin < points.length && code(fin) >= 0x80 && !inv.has(code(fin))) fin++;
  }
  if (fin - debut > 1)
    return new ErreurCodec(
      "UnicodeEncodeError",
      `'${nom}' codec can't encode characters in position ${debut}-${fin - 1}: ${raison}`,
      debut,
    );
  const c = code(debut);
  const repr =
    c <= 0xff
      ? `\\x${c.toString(16).padStart(2, "0")}`
      : c <= 0xffff
        ? `\\u${c.toString(16).padStart(4, "0")}`
        : `\\U${c.toString(16).padStart(8, "0")}`;
  return new ErreurCodec(
    "UnicodeEncodeError",
    `'${nom}' codec can't encode character '${repr}' in position ${debut}: ${raison}`,
    debut,
  );
}

/** `texte.encode(encodage)` strict : `UnicodeEncodeError` (`start` en points de code) au premier caractère non représentable. */
export function encoderPy(texte: string, encodage: string): Buffer {
  const module = codecPy(encodage, "encode");
  const refus = (i: number): never => {
    throw erreurEncodage(module, Array.from(texte), i);
  };
  if (UNICODE.has(module) && !texte.isWellFormed()) {
    let i = 0;
    for (const c of texte) {
      const x = c.codePointAt(0) as number;
      if (x >= 0xd800 && x <= 0xdfff) refus(i);
      i++;
    }
  }
  switch (module) {
    case "utf_8":
      return Buffer.from(texte, "utf8");
    case "utf_8_sig":
      return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(texte, "utf8")]);
    case "utf_16":
    case "utf_16_le":
    case "utf_16_be": {
      const le = Buffer.from(texte, "utf16le");
      if (module === "utf_16_be") return le.swap16();
      return module === "utf_16" ? Buffer.concat([Buffer.from([0xff, 0xfe]), le]) : le;
    }
    case "utf_32":
    case "utf_32_le":
    case "utf_32_be": {
      const bom = module === "utf_32" ? 4 : 0;
      const sortie = Buffer.alloc(4 * texte.length + bom);
      if (bom) sortie.writeUInt32LE(0xfeff, 0);
      let k = bom;
      for (const c of texte) {
        const x = c.codePointAt(0) as number;
        if (module === "utf_32_be") sortie.writeUInt32BE(x, k);
        else sortie.writeUInt32LE(x, k);
        k += 4;
      }
      return sortie.subarray(0, k);
    }
    default: {
      if (WHATWG[module] !== undefined) throw new ErreurCodec("LookupError", `unknown encoding: ${encodage}`);
      if (module === "latin_1" && !/[\u0100-\u{10ffff}]/u.test(texte)) return Buffer.from(texte, "latin1");
      if (module === "ascii" && !/[\u0080-\u{10ffff}]/u.test(texte)) return Buffer.from(texte, "latin1");
      const sortie = Buffer.alloc(texte.length);
      const inv = module === "latin_1" || module === "ascii" ? null : inverse(module);
      let i = 0;
      for (const c of texte) {
        const x = c.codePointAt(0) as number;
        if (x < 0x80) sortie[i] = x;
        else if (module === "latin_1" && x < 0x100) sortie[i] = x;
        else {
          const o = inv?.get(x);
          if (o === undefined) refus(i);
          sortie[i] = o as number;
        }
        i++;
      }
      return sortie.subarray(0, i);
    }
  }
}
