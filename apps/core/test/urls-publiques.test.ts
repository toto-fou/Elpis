// SPDX-License-Identifier: MIT
/** apps/core/test/urls-publiques.test.ts — résolution des URL publiques : vecteurs de routes/system.py, frontal HTTPS d'un core en boucle locale. */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  decouperHotePort,
  reecrireUrlLocale,
  resoudreUrlPublique,
  schemaRequete,
  synthetiserUrlPublique,
} from "../src/interface/urls-publiques";
import type { Https, Process, RequetePublique } from "../src/interface/urls-publiques";

interface SpecRequete {
  entetes: Record<string, string>;
  client: string | null;
  schema: string;
}

interface Cas {
  fonction: "synthese" | "resolution" | "schema" | "reecriture" | "decoupe";
  https?: string;
  requete?: string;
  kind?: Process;
  env?: string;
  hote?: string;
  sortie: string | [string, string];
}

const vecteurs = JSON.parse(
  readFileSync(new URL("./vecteurs/urls-publiques.json", import.meta.url), "utf-8"),
) as {
  requetes: Record<string, SpecRequete>;
  https: Record<string, Https>;
  cas: Cas[];
};

function requete(nom: string | undefined): RequetePublique {
  const spec = vecteurs.requetes[nom ?? ""];
  if (!spec) throw new Error(`requête inconnue : ${nom}`);
  return { entete: (n) => spec.entetes[n], hoteClient: spec.client ?? undefined, schema: spec.schema };
}

function https(nom: string | undefined): Https {
  const h = vecteurs.https[nom ?? ""];
  if (!h) throw new Error(`https inconnu : ${nom}`);
  return h;
}

describe("vecteurs des URL publiques", () => {
  for (const [i, c] of vecteurs.cas.entries()) {
    it(`${i} ${c.fonction} ${c.requete ?? c.hote ?? ""} ${c.kind ?? ""} ${c.env ?? ""}`, () => {
      switch (c.fonction) {
        case "synthese":
          expect(synthetiserUrlPublique(requete(c.requete), c.kind ?? "main", https(c.https))).toBe(c.sortie);
          break;
        case "resolution":
          expect(resoudreUrlPublique(c.env ?? "", requete(c.requete), c.kind ?? "main", https(c.https))).toBe(
            c.sortie,
          );
          break;
        case "schema":
          expect(schemaRequete(requete(c.requete))).toBe(c.sortie);
          break;
        case "reecriture":
          expect(reecrireUrlLocale(c.env ?? "", requete(c.requete))).toBe(c.sortie);
          break;
        case "decoupe":
          expect(decouperHotePort(c.hote ?? "")).toEqual(c.sortie);
          break;
      }
    });
  }
});

describe("frontal HTTPS d'un core en boucle locale (écart voulu au Python)", () => {
  const viaCaddy = (hote: string): RequetePublique => ({
    entete: (n) => ({ host: hote, "x-forwarded-proto": "https" })[n],
    hoteClient: "192.0.2.20",
    schema: "http",
  });
  const sansHttps = (bouclage: boolean): Https => ({
    actif: false,
    ports: { main: 443, admin: 8443 },
    bouclage,
  });
  const ENV_ADMIN = "http://localhost:8002/admin";

  it("lien de la console : ports du frontal, pas le port direct injoignable", () => {
    expect(resoudreUrlPublique(ENV_ADMIN, viaCaddy("192.0.2.40"), "admin", sansHttps(true))).toBe(
      "https://192.0.2.40:8443/admin",
    );
    expect(resoudreUrlPublique("", viaCaddy("192.0.2.40"), "admin", sansHttps(true))).toBe(
      "https://192.0.2.40:8443/admin",
    );
    expect(
      resoudreUrlPublique("http://localhost:8001/", viaCaddy("192.0.2.40:8443"), "main", sansHttps(true)),
    ).toBe("https://192.0.2.40/");
  });

  it("comportement Python gardé : écoute sur le réseau, requête en clair, ou URL publique explicite", () => {
    expect(resoudreUrlPublique(ENV_ADMIN, viaCaddy("192.0.2.40"), "admin", sansHttps(false))).toBe(
      "http://192.0.2.40:8002/admin",
    );
    const clair: RequetePublique = {
      entete: (n) => ({ host: "elpis.lan:8001" })[n],
      hoteClient: "10.0.0.2",
      schema: "http",
    };
    expect(resoudreUrlPublique(ENV_ADMIN, clair, "admin", sansHttps(true))).toBe(
      "http://elpis.lan:8002/admin",
    );
    expect(
      resoudreUrlPublique("https://elpis.corp/admin", viaCaddy("192.0.2.40"), "admin", sansHttps(true)),
    ).toBe("https://elpis.corp/admin");
  });
});
