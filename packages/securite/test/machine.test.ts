// SPDX-License-Identifier: MIT
/** packages/securite/test/machine.test.ts — relevé des adresses de la machine : adresses, réseaux des interfaces de conteneurs et adresses de diffusion de ses sous-réseaux, depuis des /proc et des interfaces simulés. */
import { texteIp } from "@elpis/commun";
import { afterEach, describe, expect, it, vi } from "vitest";

import { hostAddresses, hostAddressesRecent } from "../src/machine";

const faux = vi.hoisted(() => ({
  fichiers: {} as Record<string, string>,
  interfaces: {} as Record<string, { address: string; cidr: string | null }[]>,
}));

vi.mock("node:fs/promises", () => ({
  readFile: async (chemin: string): Promise<string> => {
    const v = faux.fichiers[chemin];
    if (v === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    return v;
  },
}));
vi.mock("node:os", () => ({ networkInterfaces: () => faux.interfaces }));

const FIB_TRIE = [
  "Main:",
  "  +-- 0.0.0.0/0 3 0 5",
  "     |-- 0.0.0.0",
  "        /0 universe UNICAST",
  "     +-- 192.0.2.0/24 2 0 2",
  "        |-- 192.0.2.0",
  "           /32 link BROADCAST",
  "           /24 link UNICAST",
  "        |-- 192.0.2.7",
  "           /32 host LOCAL",
  "        |-- 192.0.2.255",
  "           /32 link BROADCAST",
  "     +-- 198.51.100.0/24 2 0 2",
  "        |-- 198.51.100.0",
  "           /32 link BROADCAST",
  "        |-- 198.51.100.255",
  "           /32 link BROADCAST",
  "  +-- 127.0.0.0/8 2 0 2",
  "     |-- 127.0.0.1",
  "        /32 host LOCAL",
  "     |-- 127.255.255.255",
  "        /32 link BROADCAST",
].join("\n");

afterEach(() => {
  faux.fichiers = {};
  faux.interfaces = {};
});

describe("hostAddressesRecent : relevé gardé", () => {
  it("même relevé dans le délai, relu au-delà", async () => {
    const a = hostAddressesRecent(60_000);
    expect(hostAddressesRecent(60_000)).toBe(a);
    const b = hostAddressesRecent(0);
    expect(b).not.toBe(a);
    await Promise.all([a, b]);
  });
});

describe("hostAddresses : adresses de diffusion", () => {
  it("lues dans la table de routage locale : celles de chaque sous-réseau, adresses de réseau comprises", async () => {
    faux.fichiers["/proc/net/fib_trie"] = FIB_TRIE;
    const h = await hostAddresses();
    expect((h.diffusions ?? []).map(texteIp).sort()).toEqual([
      "127.255.255.255",
      "192.0.2.0",
      "192.0.2.255",
      "198.51.100.0",
      "198.51.100.255",
    ]);
    expect(h.adresses.map(texteIp).sort()).toEqual(["127.0.0.1", "192.0.2.7"]);
  });

  it("aucune table lisible : relevé vide, pas d'erreur", async () => {
    const h = await hostAddresses();
    expect(h.diffusions).toEqual([]);
    expect(h.adresses).toEqual([]);
  });

  it("lignes de diffusion sans adresse devant elles, ou d'une adresse illisible : ignorées", async () => {
    faux.fichiers["/proc/net/fib_trie"] = [
      "           /32 link BROADCAST",
      "        |-- pas-une-ip",
      "           /32 link BROADCAST",
    ].join("\n");
    expect((await hostAddresses()).diffusions).toEqual([]);
  });

  it("interfaces du système et /proc : les adresses des deux sont relevées, les diffusions viennent de /proc seul", async () => {
    faux.interfaces = { eth0: [{ address: "203.0.113.9", cidr: "203.0.113.9/24" }] };
    faux.fichiers["/proc/net/fib_trie"] = FIB_TRIE;
    const h = await hostAddresses();
    expect(h.adresses.map(texteIp)).toContain("203.0.113.9");
    expect((h.diffusions ?? []).map(texteIp)).not.toContain("203.0.113.255");
  });
});
