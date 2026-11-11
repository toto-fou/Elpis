// SPDX-License-Identifier: MIT
/** apps/core/test/git/garde.test.ts — garde SSRF des appels git : boucle et lien local refusés même pour un hôte enregistré, LAN permis s'il est enregistré ou en `critical_only`, une seule résolution retenue, hôte non résolu refusé. */
import { adresseIpOuNul } from "@elpis/commun";
import { describe, expect, it } from "vitest";

import { gardeGit } from "../../src/git/garde";
import { adresseCritique } from "@elpis/securite";

const resolveur =
  (adresses: string[], appels: string[] = []) =>
  (h: string) => {
    appels.push(h);
    return Promise.resolve(adresses);
  };

describe("gardeGit", () => {
  it("hôte enregistré en IP littérale : boucle, lien local, non spécifiée et IPv4 encapsulée refusées ; LAN permis", async () => {
    const cas: [string, string, string | null][] = [
      ["http://127.0.0.1:3000/x", "127.0.0.1:3000", "blocked_ip (127.0.0.1)"],
      ["http://127.8.9.10/x", "127.8.9.10", "blocked_ip (127.8.9.10)"],
      ["http://[::1]:3000/x", "::1", "blocked_ip (::1)"],
      ["http://169.254.169.254/x", "169.254.169.254", "blocked_ip (169.254.169.254)"],
      ["http://[fe80::1]/x", "fe80::1", "blocked_ip (fe80::1)"],
      ["http://[::ffff:127.0.0.1]/x", "::ffff:127.0.0.1", "blocked_ip (::ffff:127.0.0.1)"],
      ["http://0.0.0.0/x", "0.0.0.0", "blocked_ip (0.0.0.0)"],
      ["http://10.0.0.5/x", "10.0.0.5", null],
      ["http://192.168.0.10:3000/x", "192.168.0.10:3000", null],
      ["http://[fd00::5]/x", "fd00::5", null],
    ];
    for (const [url, hote, motif] of cas)
      expect((await gardeGit(url, { allowSchemes: ["https"], allowHosts: [hote] })).motif, url).toBe(motif);
  });

  it("hôte enregistré par son nom : résolu une fois, adresses retenues, boucle ou lien local refusés", async () => {
    const appels: string[] = [];
    const ok = await gardeGit("http://gitea.lan:3000/api", {
      allowSchemes: ["https"],
      allowHosts: ["gitea.lan:3000"],
      resoudre: resolveur(["10.0.0.7"], appels),
    });
    expect(ok).toEqual({ motif: null, adresses: ["10.0.0.7"] });
    expect(appels).toEqual(["gitea.lan"]);
    const refus = await gardeGit("http://gitea.lan/api", {
      allowSchemes: ["https"],
      allowHosts: ["gitea.lan"],
      resoudre: resolveur(["10.0.0.7", "127.0.0.1"]),
    });
    expect(refus).toEqual({ motif: "resolves_to_blocked (127.0.0.1)", adresses: null });
  });

  it("hôte qui ne se résout pas (enregistré ou non), ou sans adresse lisible : unresolvable_host, comme check_remote_url", async () => {
    const echec = (): Promise<string[]> =>
      Promise.reject(Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" }));
    for (const [hotes, resoudre] of [
      [["git.exemple.org"], echec],
      [[], echec],
      [["git.exemple.org"], resolveur([])],
      [[], resolveur([])],
      [["git.exemple.org"], resolveur(["pas-une-ip"])],
      [["git.exemple.org"], () => Promise.reject(new TypeError("nom illisible"))],
    ] as const)
      expect(
        await gardeGit("https://git.exemple.org/api", {
          allowSchemes: ["https"],
          allowHosts: hotes,
          resoudre,
        }),
        JSON.stringify(hotes),
      ).toEqual({ motif: "unresolvable_host", adresses: null });
    for (const hotes of [["git.exemple.org"], []])
      expect(
        await gardeGit("https://git.exemple.org/api", {
          allowSchemes: ["https"],
          allowHosts: hotes,
          resoudre: resolveur(["pas-une-ip", "93.184.216.34", "93.184.216.34", "93.184.216.35"]),
        }),
      ).toEqual({ motif: null, adresses: ["93.184.216.34", "93.184.216.35"] });
  });

  it("hôte non enregistré : règles de git/ssrf.py, la résolution de la garde est celle retenue", async () => {
    const appels: string[] = [];
    expect(
      await gardeGit("https://api.example/x", {
        allowSchemes: ["https"],
        allowHosts: [],
        resoudre: resolveur(["93.184.216.34"], appels),
      }),
    ).toEqual({ motif: null, adresses: ["93.184.216.34"] });
    expect(appels).toEqual(["api.example"]);
    expect(
      (
        await gardeGit("https://api.example/x", {
          allowSchemes: ["https"],
          allowHosts: [],
          resoudre: resolveur(["10.0.0.1"]),
        })
      ).motif,
    ).toBe("resolves_to_blocked (10.0.0.1)");
    expect((await gardeGit("http://api.example/x", { allowSchemes: ["https"], allowHosts: [] })).motif).toBe(
      "scheme_not_allowed (http)",
    );
  });

  it("`critical_only` (api_base d'un connecteur) : LAN non enregistré permis, boucle et lien local toujours refusés", async () => {
    const lan = { allowSchemes: ["https", "http"], allowHosts: [], resoudre: resolveur(["10.0.0.5"]) };
    expect((await gardeGit("http://forge.lan.example/api/v1", lan)).motif).toBe(
      "resolves_to_blocked (10.0.0.5)",
    );
    expect(await gardeGit("http://forge.lan.example/api/v1", { ...lan, criticalOnly: true })).toEqual({
      motif: null,
      adresses: ["10.0.0.5"],
    });
    expect(
      (
        await gardeGit("http://forge.lan.example/api/v1", {
          ...lan,
          criticalOnly: true,
          resoudre: resolveur(["169.254.169.254"]),
        })
      ).motif,
    ).toBe("resolves_to_blocked (169.254.169.254)");
    expect((await gardeGit("http://127.0.0.1:3000/api/v1", { ...lan, criticalOnly: true })).motif).toBe(
      "blocked_ip (127.0.0.1)",
    );
  });

  it("adresses critiques", () => {
    const critique = (t: string): boolean => {
      const ip = adresseIpOuNul(t);
      if (ip === null) throw new Error(t);
      return adresseCritique(ip);
    };
    for (const t of [
      "127.0.0.1",
      "::1",
      "169.254.1.1",
      "fe80::2",
      "0.0.0.0",
      "::",
      "224.0.0.1",
      "::ffff:169.254.1.1",
    ])
      expect(critique(t), t).toBe(true);
    for (const t of ["10.1.2.3", "172.16.0.1", "192.168.0.1", "fd12::1", "8.8.8.8", "::ffff:10.0.0.1"])
      expect(critique(t), t).toBe(false);
  });
});
