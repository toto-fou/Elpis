// SPDX-License-Identifier: MIT
/** packages/navigateur/test/url.test.ts — garde des destinations du navigateur : vecteurs Python (résolveur, hôte et liste blanche fixés), écarts E40, interfaces de l'hôte. */
import { existsSync, readFileSync } from "node:fs";
import { networkInterfaces } from "node:os";

import { adresseIpOuNul, reseauPy } from "@elpis/commun";
import type { AdresseIp, Reseau } from "@elpis/commun";
import type * as Config from "@elpis/config";
import { urlNonAmbigue } from "@elpis/securite";
import { describe, expect, it, vi } from "vitest";

import { browserUrlBlockReason, hostAddresses, refusMessage } from "../src/url";
import type { HoteNavigateur } from "../src/url";

const vive = vi.hoisted(() => ({ valeur: [] as unknown }));
vi.mock("@elpis/config", async (original) => ({
  ...(await original<typeof Config>()),
  liveConfigValue: (chemin: string, defaut: unknown) =>
    chemin === "browser.url_allowlist" ? vive.valeur : defaut,
}));

const v = JSON.parse(readFileSync(new URL("./vecteurs/navigateur_url.json", import.meta.url), "utf-8")) as {
  table: Record<string, string[]>;
  hote: { adresses: string[]; reseaux: string[] };
  listes: unknown[];
  cas: { url: string | null; liste: number; motif: string | null }[];
  messages: { url: string | null; motif: string; valeur: string }[];
};

const AMBIGUE = "adresse ambiguë : le navigateur n'y lirait pas le même hôte ou le même port";
// URL que le Python laisse passer mais que WHATWG lit autrement : refusées (E40) ; `10.1` (10.0.0.1 pour WHATWG) est déjà refusée par les listes 1 et 2.
const ECARTS_E40 = [
  "http://[v1.x]/",
  "http://1.2.3.4.5/",
  "http://example.com\\@intranet.lan/",
  "http://exa mple.com/",
  "http://ex%61mple.com/",
];
const ECARTS_PAR_LISTE: readonly (readonly string[])[] = [
  ["http://10.1/", ...ECARTS_E40],
  ECARTS_E40,
  ECARTS_E40,
];

const hote: HoteNavigateur = {
  adresses: v.hote.adresses.map((a) => adresseIpOuNul(a)).filter((a): a is AdresseIp => a !== null),
  reseaux: v.hote.reseaux.map((r) => reseauPy(r)).filter((r): r is Reseau => r !== null),
};
const resoudre = async (nom: string): Promise<string[]> => {
  const adresses = Object.hasOwn(v.table, nom) ? v.table[nom] : undefined;
  if (adresses === undefined) throw new Error(`getaddrinfo ENOTFOUND ${nom}`);
  return adresses;
};

describe("vecteurs Python de browser_url_block_reason", () => {
  it.each(v.listes.map((l, i) => [i, JSON.stringify(l)] as const))(
    "liste blanche n°%i (%s) : même motif que le Python, refus E40 en plus",
    async (i) => {
      const ecarts: string[] = [];
      for (const c of v.cas.filter((x) => x.liste === i)) {
        const motif = await browserUrlBlockReason(c.url, { allowlist: v.listes[i], hote, resoudre });
        if (c.motif === null && motif !== null) {
          expect(motif, String(c.url)).toBe(AMBIGUE);
          expect(urlNonAmbigue(String(c.url).trim()), String(c.url)).toBe(false);
          ecarts.push(String(c.url));
        } else expect(motif, String(c.url)).toBe(c.motif);
      }
      expect(ecarts.sort()).toEqual([...(ECARTS_PAR_LISTE[i] ?? [])].sort());
    },
  );

  it("refus_message : URL tronquée à 200 points de code", () => {
    for (const c of v.messages) expect(refusMessage(c.url, c.motif)).toBe(c.valeur);
  });
});

describe("liste blanche relue à chaud", () => {
  it("sans liste passée : browser.url_allowlist lue à chaque appel ; une valeur non itérable lève comme list()", async () => {
    vive.valeur = [];
    expect(await browserUrlBlockReason("http://lan.example/", { hote, resoudre })).toBeNull();
    vive.valeur = "intranet.lan";
    expect(await browserUrlBlockReason("http://lan.example/", { hote, resoudre })).toBe(
      "hôte du réseau local absent de la liste autorisée (lan.example)",
    );
    expect(
      await browserUrlBlockReason("http://intranet.lan/", { allowlist: null, hote, resoudre }),
    ).toBeNull();
    vive.valeur = 5;
    await expect(browserUrlBlockReason("http://lan.example/", { hote, resoudre })).rejects.toThrow(
      "'int' object is not iterable",
    );
    vive.valeur = [];
  });
});

describe("adresses de l'hôte", () => {
  it("toutes celles d'os.networkInterfaces(), la boucle locale, et les réseaux des ponts déclarés dans /proc/net/route", async () => {
    const { adresses, reseaux } = await hostAddresses();
    const textes = new Set(adresses.map((a) => `${a.version}:${a.valeur}`));
    const attendues = Object.values(networkInterfaces())
      .flatMap((l) => l ?? [])
      .map((a) => adresseIpOuNul(a.address.split("%")[0] ?? ""))
      .filter((a): a is AdresseIp => a !== null);
    for (const a of attendues) expect(textes.has(`${a.version}:${a.valeur}`)).toBe(true);
    expect(textes.has(`4:${0x7f000001n}`)).toBe(true);
    if (!existsSync("/proc/net/route")) return;
    const route = readFileSync("/proc/net/route", "utf-8");
    const ponts = route
      .split("\n")
      .slice(1)
      .map((l) => l.trim().split(/\s+/u))
      .filter(
        ([nom, , gw, , , , , mq]) =>
          /^(docker|br-)/u.test(nom ?? "") && gw === "00000000" && mq !== "00000000",
      );
    expect(reseaux.filter((r) => r.version === 4).length).toBeGreaterThanOrEqual(ponts.length);
  });
});
