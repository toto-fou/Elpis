// SPDX-License-Identifier: MIT
/** packages/securite/test/ssrf.test.ts — ipaddress de CPython 3.13 et garde SSRF rejoués contre les vecteurs Python. */
import { readFileSync } from "node:fs";

import {
  adresseIpPy,
  ErreurPython,
  estBoucleIp,
  estGlobaleIp,
  estLienLocalIp,
  estMulticastIp,
  estNonSpecifieeIp,
  estPriveeIp,
  estReserveeIp,
  ipv4Mappee,
  texteIp,
} from "@elpis/commun";
import { describe, expect, it } from "vitest";

import { blockRemoteUrlReason } from "../src/ssrf";

type Options = { allow_schemes?: string[]; allow_hosts?: string[]; critical_only?: boolean };
type Garde = { url: string; options: Options; motif?: string | null; erreur?: string };

const V = JSON.parse(readFileSync(new URL("./vecteurs/ssrf.json", import.meta.url), "utf-8")) as {
  adresses: (
    | { texte: string; erreur: string }
    | ({ texte: string; str: string; version: number } & Record<string, unknown>)
  )[];
  resolutions: Record<string, string[]>;
  gardes: Garde[];
  reelles: Garde[];
};

async function garde(c: Garde, figee: boolean): Promise<{ motif?: string | null; erreur?: string }> {
  try {
    const motif = await blockRemoteUrlReason(c.url, {
      ...(c.options.allow_schemes ? { allowSchemes: c.options.allow_schemes } : {}),
      ...(c.options.allow_hosts ? { allowHosts: c.options.allow_hosts } : {}),
      ...(c.options.critical_only !== undefined ? { criticalOnly: c.options.critical_only } : {}),
      ...(figee
        ? {
            resoudre: async (hote: string) => {
              const ips = V.resolutions[hote];
              if (!ips) throw new Error("Name or service not known");
              return ips;
            },
          }
        : {}),
    });
    return { motif };
  } catch {
    return { erreur: "ValueError" };
  }
}

describe("ipaddress (vecteurs)", () => {
  it("analyse, str et prédicats de CPython 3.13, IPv4 encapsulée comprise", () => {
    for (const c of V.adresses) {
      if ("erreur" in c) {
        expect(() => adresseIpPy(c.texte), c.texte).toThrow(ErreurPython);
        expect(() => adresseIpPy(c.texte), c.texte).toThrow(c.erreur);
        continue;
      }
      const a = adresseIpPy(c.texte);
      const m = ipv4Mappee(a);
      expect(
        {
          texte: c.texte,
          str: texteIp(a),
          version: a.version,
          is_private: estPriveeIp(a),
          is_global: estGlobaleIp(a),
          is_loopback: estBoucleIp(a),
          is_link_local: estLienLocalIp(a),
          is_unspecified: estNonSpecifieeIp(a),
          is_multicast: estMulticastIp(a),
          is_reserved: estReserveeIp(a),
          ipv4_mapped: m === null ? null : texteIp(m),
        },
        c.texte,
      ).toEqual(c);
    }
  });
});

describe("block_remote_url_reason (vecteurs)", () => {
  it("schémas, identifiants, hôtes internes, adresses littérales et résolues, hôtes permis, mode critique", async () => {
    for (const c of V.gardes) {
      const obtenu = await garde(c, true);
      expect(obtenu, `${c.url} ${JSON.stringify(c.options)}`).toEqual(
        c.erreur !== undefined ? { erreur: c.erreur } : { motif: c.motif },
      );
    }
  });

  it("formes numériques résolues par la libc (décimal, hexadécimal, octal, abrégé)", async () => {
    for (const c of V.reelles) expect(await garde(c, false), c.url).toEqual({ motif: c.motif });
  });
});
