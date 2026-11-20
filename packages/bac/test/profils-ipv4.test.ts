// SPDX-License-Identifier: MIT
/** packages/bac/test/profils-ipv4.test.ts — profils réseau IPv4 seulement : formes canoniques, résolveurs, entrées invalides ignorées avec un avertissement, empreinte stable. */
import { describe, expect, it } from "vitest";

import { ipv4Canonique, netcfgHash, profilReseauDepuis, resolveurValide } from "../src/index";

describe("ipv4Canonique", () => {
  it.each([
    ["10.0.0.5", "10.0.0.5"],
    ["  10.0.0.1  ", "10.0.0.1"],
    ["10.0.0.7/24", "10.0.0.0/24"],
    ["10.0.0.1/24 ", "10.0.0.0/24"],
    ["1.2.3.4/32", "1.2.3.4"],
    ["0.0.0.0/0", "0.0.0.0/0"],
    ["10.0.0.0/255.255.255.0", "10.0.0.0/24"],
    ["10.0.0.0/0.0.0.255", "10.0.0.0/24"],
  ])("%j → %j", (entree, attendu) => {
    expect(ipv4Canonique(entree)).toBe(attendu);
  });

  it.each([
    "::1",
    "fe80::1/64",
    "::ffff:10.0.0.1",
    "::ffff:10.0.0.1/128",
    "fe80::1%eth0",
    "github.com",
    "",
    " ",
    "1.2.3",
    "010.0.0.1",
    "1.2.3.4/33",
    "1.2.3.4/",
    "1.2.3.4/-1",
    "1.2.3.4/a",
    "1.2.3.4/32/1",
    "2130706433",
    "-j",
  ])("%j refusé", (entree) => {
    expect(ipv4Canonique(entree)).toBeNull();
  });
});

describe("resolveurValide", () => {
  it.each([
    ["9.9.9.9", "9.9.9.9"],
    ["  10.168.1.1 ", "10.168.1.1"],
  ])("%j → %j", (entree, attendu) => {
    expect(resolveurValide(entree)).toBe(attendu);
  });

  it.each(["10.0.0.0/24", "::1", "::ffff:10.0.0.1", "fe80::1%eth0", "dns.local", "", " ", "1.2.3", "-j"])(
    "%j refusé",
    (entree) => {
      expect(resolveurValide(entree)).toBeNull();
    },
  );
});

describe("profilReseauDepuis : entrées invalides", () => {
  it("ips et résolveurs invalides ignorés, un avertissement chacun ; ports hors plage retirés ; sortie canonique", () => {
    const avis: string[] = [];
    const p = profilReseauDepuis(
      {
        id: "web",
        name: "Web",
        mode: "allowlist_ip",
        ips: ["10.0.0.7/24", "fe80::1", "-j", "1.2.3.4/32"],
        dns: ["9.9.9.9", "dns.local", "::1", "10.0.0.0/24"],
        ports: [443, 0, 70000, 80, -1, 65535],
      },
      (m) => avis.push(m),
    );
    expect([p.ips, p.dns, p.ports]).toEqual([["10.0.0.0/24", "1.2.3.4"], ["9.9.9.9"], [443, 80, 65535]]);
    expect(avis).toEqual([
      "profil réseau 'web' : ips 'fe80::1' ignoré (IPv4 attendue)",
      "profil réseau 'web' : ips '-j' ignoré (IPv4 attendue)",
      "profil réseau 'web' : dns 'dns.local' ignoré (IPv4 attendue)",
      "profil réseau 'web' : dns '::1' ignoré (IPv4 attendue)",
      "profil réseau 'web' : dns '10.0.0.0/24' ignoré (IPv4 attendue)",
    ]);
  });

  it("deux écritures du même réseau : même empreinte netcfg", () => {
    const hash = (ips: string[]): string =>
      netcfgHash(profilReseauDepuis({ id: "a", name: "A", mode: "allowlist_ip", ips }, () => undefined));
    expect(hash(["10.0.0.7/24"])).toBe(hash(["10.0.0.0/24"]));
    expect(hash(["10.0.0.0/255.255.255.0"])).toBe(hash(["10.0.0.0/24"]));
    expect(hash(["1.2.3.4/32"])).toBe(hash(["1.2.3.4"]));
    expect(hash(["1.2.3.4"])).not.toBe(hash(["1.2.3.5"]));
  });
});
