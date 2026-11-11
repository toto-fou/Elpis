// SPDX-License-Identifier: MIT
/** apps/toolhost/test/office-cadres.test.ts — cadres du canal du worker Office : aller-retour, flottants Python gardés, corps binaire, découpage arbitraire du flux, en-têtes refusés. */
import { FlottantPy, pyJsonDumps } from "@elpis/commun";
import type { Dict } from "@elpis/commun";
import { describe, expect, it } from "vitest";

import { DecodeurCadres, encoderCadre, ErreurCadre } from "../src/mcp/office/cadres";

/** Cadre écrit à la main comme `Sortie.envoyer` du Python : longueur, en-tête JSON, longueur, corps. */
function cadrePython(json: string, corps: Buffer = Buffer.alloc(0)): Buffer {
  const entete = Buffer.from(json, "utf8");
  const n = Buffer.alloc(4);
  n.writeUInt32BE(entete.length);
  const m = Buffer.alloc(4);
  m.writeUInt32BE(corps.length);
  return Buffer.concat([n, entete, m, corps]);
}

describe("cadres du worker Office", () => {
  it("aller-retour : en-tête compact comme `json.dumps(separators=(',', ':'), ensure_ascii=False)`, corps binaire intact", () => {
    const corps = Buffer.from([0, 255, 1, 254, 0x0a, 0x0d]);
    const cadre = encoderCadre(
      { type: "appel", id: 3, outil: "docx_read", args: { path: "é/x.docx" } },
      corps,
    );
    const n = cadre.readUInt32BE(0);
    expect(cadre.subarray(4, 4 + n).toString("utf8")).toBe(
      '{"type":"appel","id":3,"outil":"docx_read","args":{"path":"é/x.docx"}}',
    );
    expect(cadre.readUInt32BE(4 + n)).toBe(corps.length);
    const [lu, ...reste] = new DecodeurCadres().pousser(cadre);
    expect(reste).toEqual([]);
    expect(lu?.entete).toEqual({ type: "appel", id: 3, outil: "docx_read", args: { path: "é/x.docx" } });
    expect(Buffer.compare(lu?.corps ?? Buffer.alloc(1), corps)).toBe(0);
  });

  it("flottants : `1234.0` lu comme FlottantPy et réécrit `1234.0`, entier `7` resté entier", () => {
    const [lu] = new DecodeurCadres().pousser(
      cadrePython('{"type":"reponse","valeur":{"option":{"data":[1234.0,7,0.5,-2.0]}}}'),
    );
    const data = ((lu?.entete["valeur"] as Dict)["option"] as Dict)["data"] as unknown[];
    expect(data[0]).toBeInstanceOf(FlottantPy);
    expect(Number(data[0])).toBe(1234);
    expect(data[1]).toBe(7);
    expect(data[3]).toBeInstanceOf(FlottantPy);
    const reecrit = encoderCadre(lu?.entete ?? {});
    const n = reecrit.readUInt32BE(0);
    expect(reecrit.subarray(4, 4 + n).toString("utf8")).toBe(
      '{"type":"reponse","valeur":{"option":{"data":[1234.0,7,0.5,-2.0]}}}',
    );
    expect(pyJsonDumps({ x: new FlottantPy(1234) })).toBe('{"x": 1234.0}');
  });

  it("flux découpé octet par octet, plusieurs cadres dans un morceau, corps vide : chaque cadre rendu une fois, dans l'ordre", () => {
    const flux = Buffer.concat([
      encoderCadre({ type: "pret", version: 1 }),
      encoderCadre({ type: "resultat", id: 1, valeur: { ok: true } }, Buffer.from("abc")),
      encoderCadre({ type: "rappel", id: 2, rid: 1, op: "lire" }, Buffer.alloc(70_000, 7)),
    ]);
    const d = new DecodeurCadres();
    const lus = [];
    for (let i = 0; i < flux.length; i += 1) lus.push(...d.pousser(flux.subarray(i, i + 1)));
    expect(lus.map((c) => c.entete["type"])).toEqual(["pret", "resultat", "rappel"]);
    expect(lus.map((c) => c.corps.length)).toEqual([0, 3, 70_000]);
    expect(lus[2]?.corps.every((o) => o === 7)).toBe(true);
    const ensemble = new DecodeurCadres().pousser(flux);
    expect(ensemble.map((c) => c.entete["type"])).toEqual(["pret", "resultat", "rappel"]);
    const d2 = new DecodeurCadres();
    expect(d2.pousser(flux.subarray(0, 10))).toEqual([]);
    expect(d2.pousser(flux.subarray(10)).length).toBe(3);
  });

  it("en-tête ou corps trop longs, en-tête illisible ou qui n'est pas un objet : ErreurCadre", () => {
    const enorme = Buffer.alloc(8);
    enorme.writeUInt32BE((64 << 20) + 1);
    expect(() => new DecodeurCadres().pousser(enorme)).toThrow(ErreurCadre);
    const corpsEnorme = Buffer.concat([cadrePython("{}").subarray(0, 6), Buffer.alloc(4)]);
    corpsEnorme.writeUInt32BE(2 ** 31 + 1, 6);
    expect(() => new DecodeurCadres().pousser(corpsEnorme)).toThrow(/corps de 2147483649 octets refusé/u);
    expect(() => new DecodeurCadres().pousser(cadrePython("{pas du json"))).toThrow(/en-tête illisible/u);
    expect(() => new DecodeurCadres().pousser(cadrePython("[1,2]"))).toThrow(/n'est pas un objet/u);
    expect(() => new DecodeurCadres().pousser(cadrePython("null"))).toThrow(/n'est pas un objet/u);
  });
});
