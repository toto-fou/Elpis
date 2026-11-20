// SPDX-License-Identifier: MIT
/** packages/navigateur/test/url.test.ts — politique du navigateur jugée par le relais d'un bac au profil ouvert : adresses réservées, machine d'Elpis et ses réseaux de conteneurs, liste blanche du réseau local relue à chaud, interfaces de l'hôte. */
import { existsSync, readFileSync } from "node:fs";
import { networkInterfaces } from "node:os";

import { adresseIpOuNul, reseauPy } from "@elpis/commun";
import type { AdresseIp, Reseau } from "@elpis/commun";
import type * as Config from "@elpis/config";
import { describe, expect, it, vi } from "vitest";

import { hostAddresses, jugeRelaisBac } from "../src/url";
import type { HoteNavigateur } from "../src/url";

const vive = vi.hoisted(() => ({ valeur: [] as unknown }));
vi.mock("@elpis/config", async (original) => ({
  ...(await original<typeof Config>()),
  liveConfigValue: (chemin: string, defaut: unknown) =>
    chemin === "browser.url_allowlist" ? vive.valeur : defaut,
}));

const hote: HoteNavigateur = {
  adresses: ["192.168.50.5", "2001:db8::5"]
    .map((a) => adresseIpOuNul(a))
    .filter((a): a is AdresseIp => a !== null),
  reseaux: ["172.17.0.0/16"].map((r) => reseauPy(r)).filter((r): r is Reseau => r !== null),
};
const TABLE: Record<string, string[]> = {
  "example.org": ["93.184.216.34"],
  "lan.example": ["10.0.0.7"],
  "intranet.lan": ["10.0.0.8"],
  "piege.example": ["93.184.216.34", "127.0.0.1"],
};
const resoudre = async (nom: string): Promise<string[]> => {
  const adresses = TABLE[nom];
  if (adresses === undefined) throw new Error(`getaddrinfo ENOTFOUND ${nom}`);
  return adresses;
};
const ouvert = (): { id: string; mode: string; ips: never[]; domains: never[]; ports: never[] } => ({
  id: "web",
  mode: "bridge",
  ips: [],
  domains: [],
  ports: [],
});
const motif = async (nom: string, allowlist: unknown = []): Promise<string | null> => {
  const v = await jugeRelaisBac(ouvert, { allowlist, hote, resoudre })(nom, 443);
  return v.ok ? null : v.motif;
};

describe("politique du navigateur (relais d'un bac au profil ouvert)", () => {
  it("boucle locale, lien-local, non spécifiée, multidiffusion et réservées : refusées, en anglais", async () => {
    for (const ip of ["127.0.0.1", "::1", "169.254.169.254", "0.0.0.0", "224.0.0.1", "240.0.0.1", "fe80::1"])
      expect(await motif(ip), ip).toMatch(/^address reserved to the host or its local network \(/u);
    expect(await motif("piege.example")).toBe(
      "address reserved to the host or its local network (127.0.0.1)",
    );
    expect(await motif("introuvable.example")).toBe("name not found (introuvable.example)");
  });

  it("adresses de la machine d'Elpis et réseaux de ses conteneurs : refusés", async () => {
    expect(await motif("192.168.50.5")).toBe("address of the machine hosting Elpis (192.168.50.5)");
    expect(await motif("2001:db8::5")).toBe("address of the machine hosting Elpis (2001:db8::5)");
    expect(await motif("172.17.0.3")).toBe("internal network of the machine hosting Elpis (172.17.0.3)");
  });

  it("réseau local permis sans liste blanche ; avec elle, par nom exact, suffixe ou réseau seulement", async () => {
    expect(await motif("lan.example")).toBeNull();
    expect(await motif("example.org", ["intranet.lan"])).toBeNull();
    expect(await motif("lan.example", ["intranet.lan"])).toBe(
      "local network host not in the allowlist (lan.example)",
    );
    expect(await motif("intranet.lan", ["intranet.lan"])).toBeNull();
    expect(await motif("intranet.lan", "*.lan")).toBeNull();
    expect(await motif("lan.example", "10.0.0.0/24, autre.lan")).toBeNull();
    expect(await motif("10.0.0.9", ["10.0.0.9"])).toBeNull();
  });

  it("sans liste passée : browser.url_allowlist relue à chaque verdict", async () => {
    const juge = (): ReturnType<typeof jugeRelaisBac> => jugeRelaisBac(ouvert, { hote, resoudre });
    vive.valeur = [];
    expect(await juge()("lan.example", 443)).toMatchObject({ ok: true, adresse: "10.0.0.7" });
    vive.valeur = "intranet.lan";
    expect(await juge()("lan.example", 443)).toEqual({
      ok: false,
      motif: "local network host not in the allowlist (lan.example)",
    });
    expect(await juge()("intranet.lan", 443)).toMatchObject({ ok: true });
    vive.valeur = [];
  });
});

describe("profil ouvert protégé (cases « Refuser » du profil)", () => {
  const TABLE_P: Record<string, string[]> = {
    ...TABLE,
    "meta.example": ["169.254.169.254"],
    "azure.example": ["168.63.129.16"],
    "alibaba.example": ["100.100.100.200"],
    "prive.example": ["10.1.2.3"],
    "partage.example": ["100.64.0.9"],
    "docs.example": ["192.0.2.50"],
    "double.example": ["93.184.216.34", "2001:db8::50"],
    "v6seul.example": ["2001:db8::51"],
    "mixte-prive.example": ["93.184.216.34", "10.1.2.3"],
  };
  const resoudreP = async (nom: string): Promise<string[]> => {
    const a = TABLE_P[nom];
    if (a === undefined) throw new Error(`getaddrinfo ENOTFOUND ${nom}`);
    return a;
  };
  const hoteP: HoteNavigateur = { adresses: [adresseIpOuNul("192.0.2.5") as AdresseIp], reseaux: [] };
  const profil =
    (extra: Record<string, unknown> = {}) =>
    (): never =>
      ({ id: "web", mode: "bridge", ips: [], domains: [], ports: [], ...extra }) as never;
  const verdict = async (extra: Record<string, unknown>, nom: string): Promise<string | null> => {
    const v = await jugeRelaisBac(profil(extra), { allowlist: [], hote: hoteP, resoudre: resoudreP })(
      nom,
      443,
    );
    return v.ok ? null : v.motif;
  };
  const METADONNEES = "is a cloud metadata address, refused by the sandbox network profile 'web'";
  const LOCAL = "is on the local network, refused by the sandbox network profile 'web'";

  it("sans protection cochée : rien de plus refusé que pour un profil sans case (métadonnées de lien local déjà réservées)", async () => {
    for (const extra of [{}, { block_metadata: false, block_lan: false, block_host: false }])
      for (const nom of [
        "prive.example",
        "partage.example",
        "azure.example",
        "alibaba.example",
        "docs.example",
      ])
        expect(await verdict(extra, nom), nom).toBeNull();
    expect(await verdict({}, "meta.example")).toBe(
      "address reserved to the host or its local network (169.254.169.254)",
    );
  });

  it("métadonnées : adresses des principaux clouds refusées, nommées sans valeur de secret", async () => {
    for (const nom of ["azure.example", "alibaba.example", "168.63.129.16", "100.100.100.200"])
      expect(await verdict({ block_metadata: true }, nom), nom).toBe(`${nom} ${METADONNEES}`);
    expect(await verdict({ block_metadata: true }, "prive.example")).toBeNull();
    expect(await verdict({ block_metadata: true }, "example.org")).toBeNull();
  });

  it("réseau local : privées, partagées et réservées refusées, une adresse publique ou de documentation permise", async () => {
    for (const nom of [
      "prive.example",
      "partage.example",
      "10.0.0.1",
      "172.16.5.5",
      "192.168.200.1",
      "100.64.0.1",
    ])
      expect(await verdict({ block_lan: true }, nom), nom).toBe(`${nom} ${LOCAL}`);
    for (const nom of ["224.0.0.9", "240.0.0.1"])
      expect(await verdict({ block_lan: true }, nom), nom).toBe(
        `address reserved to the host or its local network (${nom})`,
      );
    expect(await verdict({ block_lan: true }, "example.org")).toBeNull();
    expect(await verdict({ block_lan: true }, "docs.example")).toBeNull();
    expect(await verdict({ block_lan: true }, "azure.example")).toBeNull();
  });

  it("une adresse refusée parmi celles d'un nom suffit à le refuser", async () => {
    expect(await verdict({ block_lan: true }, "mixte-prive.example")).toBe(`mixte-prive.example ${LOCAL}`);
    expect(await verdict({}, "mixte-prive.example")).toBeNull();
  });

  it("profil protégé : adresses IPv6 écartées du verdict, nom seulement IPv6 refusé", async () => {
    for (const extra of [{ block_metadata: true }, { block_lan: true }, { block_host: true }]) {
      const v = await jugeRelaisBac(profil(extra), { allowlist: [], hote: hoteP, resoudre: resoudreP })(
        "double.example",
        443,
      );
      expect(v, JSON.stringify(extra)).toEqual({
        ok: true,
        adresse: "93.184.216.34",
        adresses: ["93.184.216.34"],
      });
      expect(await verdict(extra, "v6seul.example")).toBe(
        "v6seul.example has IPv6 addresses only, refused by the sandbox network profile 'web'",
      );
      expect(await verdict(extra, "2001:db8::99")).toContain("has IPv6 addresses only");
    }
  });

  it("profil sans protection : les adresses IPv6 sont gardées comme avant", async () => {
    const v = await jugeRelaisBac(profil(), { allowlist: [], hote: hoteP, resoudre: resoudreP })(
      "double.example",
      443,
    );
    expect(v).toEqual({ ok: true, adresse: "93.184.216.34", adresses: ["93.184.216.34", "2001:db8::50"] });
    expect(await verdict({}, "v6seul.example")).toBeNull();
  });

  it("la machine d'Elpis reste refusée, avec ou sans la case « hôte »", async () => {
    for (const extra of [{}, { block_host: true }])
      expect(await verdict(extra, "192.0.2.5")).toBe("address of the machine hosting Elpis (192.0.2.5)");
  });

  it("verdicts gardés par profil et par cases cochées : décocher une case change le verdict", async () => {
    const etat: Record<string, unknown> = {};
    const juge = jugeRelaisBac(profil(etat), { allowlist: [], hote: hoteP, resoudre: resoudreP });
    expect((await juge("prive.example", 443)).ok).toBe(true);
    etat["block_lan"] = true;
    expect(await juge("prive.example", 443)).toEqual({ ok: false, motif: `prive.example ${LOCAL}` });
    etat["block_lan"] = false;
    expect((await juge("prive.example", 443)).ok).toBe(true);
    etat["block_metadata"] = true;
    expect((await juge("prive.example", 443)).ok).toBe(true);
    expect((await juge("azure.example", 443)).ok).toBe(false);
  });

  it("modes autres que ouvert : cases sans effet", async () => {
    for (const mode of ["allowlist_ip", "none"]) {
      const v = await jugeRelaisBac(
        profil({
          mode,
          block_metadata: true,
          block_lan: true,
          block_host: true,
          ips: ["10.0.0.0/8"],
          domains: [],
        }),
        { allowlist: [], hote: hoteP, resoudre: resoudreP },
      )("prive.example", 443);
      expect(v.ok, mode).toBe(mode === "allowlist_ip");
    }
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
