// SPDX-License-Identifier: MIT
/** apps/toolhost/src/mcp/office/cadres.ts — cadres du canal du worker Office : en-tête JSON (écrit et lu comme `json` de Python, flottants `1.0` gardés) puis corps binaire, chacun précédé de sa longueur (4 octets, big-endian). */
import { pyJsonDumps, pyJsonLoads } from "@elpis/commun";
import type { Dict } from "@elpis/commun";

export interface Cadre {
  readonly entete: Dict;
  readonly corps: Buffer;
}

const MAX_ENTETE = 64 << 20;
const MAX_CORPS = 2 ** 31;
const VIDE = Buffer.alloc(0);

export class ErreurCadre extends Error {
  override name = "ErreurCadre";
}

export function encoderCadre(entete: Dict, corps: Uint8Array = VIDE): Buffer {
  const json = Buffer.from(pyJsonDumps(entete, { ensureAscii: false, separators: [",", ":"] }), "utf8");
  const longueurs = Buffer.allocUnsafe(8 + json.length);
  longueurs.writeUInt32BE(json.length, 0);
  json.copy(longueurs, 4);
  longueurs.writeUInt32BE(corps.length, 4 + json.length);
  return Buffer.concat([longueurs, corps]);
}

/** Découpe un flux d'octets en cadres, sans recopier un corps tant qu'il n'est pas complet. */
export class DecodeurCadres {
  private morceaux: Buffer[] = [];
  private taille = 0;
  private attendu: { total: number; entete: number } | null = null;

  pousser(morceau: Buffer): Cadre[] {
    this.morceaux.push(morceau);
    this.taille += morceau.length;
    const cadres: Cadre[] = [];
    for (;;) {
      const c = this.extraire();
      if (c === null) return cadres;
      cadres.push(c);
    }
  }

  private extraire(): Cadre | null {
    if (this.attendu === null) {
      if (this.taille < 4) return null;
      const n = this.debut(4).readUInt32BE(0);
      if (n > MAX_ENTETE) throw new ErreurCadre(`en-tête de ${n} octets refusé`);
      if (this.taille < 8 + n) return null;
      const m = this.debut(8 + n).readUInt32BE(4 + n);
      if (m > MAX_CORPS) throw new ErreurCadre(`corps de ${m} octets refusé`);
      this.attendu = { total: 8 + n + m, entete: n };
    }
    if (this.taille < this.attendu.total) return null;
    const { total, entete: n } = this.attendu;
    this.attendu = null;
    const brut = this.retirer(total);
    let entete: unknown;
    try {
      entete = pyJsonLoads(brut.subarray(4, 4 + n).toString("utf8"));
    } catch (e) {
      throw new ErreurCadre(`en-tête illisible : ${(e as Error).message}`);
    }
    if (entete === null || typeof entete !== "object" || Array.isArray(entete))
      throw new ErreurCadre("en-tête qui n'est pas un objet");
    return { entete: entete as Dict, corps: brut.subarray(8 + n) };
  }

  /** Copie des `n` premiers octets, sans les consommer. */
  private debut(n: number): Buffer {
    const sortie = Buffer.allocUnsafe(n);
    let copie = 0;
    for (const m of this.morceaux) {
      if (copie === n) break;
      copie += m.copy(sortie, copie, 0, Math.min(m.length, n - copie));
    }
    return sortie;
  }

  private retirer(n: number): Buffer {
    const prises: Buffer[] = [];
    let reste = n;
    while (reste > 0) {
      const m = this.morceaux[0] as Buffer;
      if (m.length <= reste) {
        prises.push(m);
        reste -= m.length;
        this.morceaux.shift();
      } else {
        prises.push(m.subarray(0, reste));
        this.morceaux[0] = m.subarray(reste);
        reste = 0;
      }
    }
    this.taille -= n;
    return prises.length === 1 ? (prises[0] as Buffer) : Buffer.concat(prises);
  }
}
