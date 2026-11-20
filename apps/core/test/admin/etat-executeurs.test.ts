// SPDX-License-Identifier: MIT
/** apps/core/test/admin/etat-executeurs.test.ts — console › Sandbox : protections d'un profil ouvert (vue, enregistrement) et état des domaines des profils en liste blanche (résolutions gardées, plafonnées, délai, erreurs). */
import { profilReseauDepuis } from "@elpis/bac";
import type { ProfilReseau } from "@elpis/bac";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  etatDomaines,
  oublierEtatDomaines,
  profilsAssainis,
  reglagesEtatDomaines,
  vueExecuteurs,
} from "../../src/administration/executeurs";

type Dict = Record<string, unknown>;

const liste = (id: string, domains: string[], mode = "allowlist_ip"): ProfilReseau =>
  profilReseauDepuis({ id, name: id, mode, ips: ["192.0.2.0/24"], domains }, () => undefined);
const erreur = (code: string): Error => Object.assign(new Error(code), { code });

beforeEach(() => oublierEtatDomaines());
afterEach(() => {
  oublierEtatDomaines();
  Object.assign(reglagesEtatDomaines, { ttlMs: 60_000, simultanees: 2 });
  vi.useRealTimers();
});

describe("vue des profils : protections rendues booléennes", () => {
  const vue = (profils: unknown[]): Dict[] =>
    (vueExecuteurs({ executors: { network_profiles: profils } })["config"] as { network_profiles: Dict[] })
      .network_profiles;

  it("valeurs lues telles quelles en booléens, champs absents laissés absents", () => {
    const [p, q, r] = vue([
      { id: "a", mode: "bridge", block_metadata: "oui", block_lan: 0, block_host: true },
      { id: "b", mode: "bridge" },
      { id: "c", mode: "bridge", block_lan: [], block_host: null, block_metadata: false },
    ]) as [Dict, Dict, Dict];
    expect([p["block_metadata"], p["block_lan"], p["block_host"]]).toEqual([true, false, true]);
    expect(Object.keys(q)).toEqual(["id", "mode"]);
    expect([r["block_metadata"], r["block_lan"], r["block_host"]]).toEqual([false, false, false]);
  });

  it("entrée qui n'est pas un profil : rendue telle quelle", () => {
    expect(vue(["x", 5, null, ["y"]])).toEqual(["x", 5, null, ["y"]]);
  });
});

describe("enregistrement des profils : protections d'un profil ouvert", () => {
  const assainis = (profils: Dict[]): Dict[] => profilsAssainis({ network_profiles: profils }, []);

  it("profil ouvert : trois booléens, décochés par défaut", () => {
    const [a, b] = assainis([
      { id: "a", name: "A", mode: "bridge" },
      { id: "b", name: "B", mode: "bridge", block_metadata: true, block_lan: "x", block_host: 0 },
    ]) as [Dict, Dict];
    expect([a["block_metadata"], a["block_lan"], a["block_host"]]).toEqual([false, false, false]);
    expect([b["block_metadata"], b["block_lan"], b["block_host"]]).toEqual([true, true, false]);
  });

  it("autres modes : aucune protection enregistrée", () => {
    for (const p of assainis([
      { id: "a", name: "A", mode: "none", block_lan: true },
      { id: "b", name: "B", mode: "allowlist_ip", ips: ["192.0.2.1"], block_host: true },
    ])) {
      expect("block_metadata" in p || "block_lan" in p || "block_host" in p).toBe(false);
    }
  });

  it("profil « isolated » forcé en « none » : sans protection", () => {
    const [p] = assainis([{ id: "isolated", name: "I", mode: "bridge", block_host: true }]) as [Dict];
    expect([p["mode"], "block_host" in p]).toEqual(["none", false]);
  });
});

describe("état des domaines", () => {
  it("seuls les profils en liste blanche avec domaines figurent, par profil puis par domaine", async () => {
    const r = await etatDomaines(
      [
        liste("a", ["a.example", "b.example"]),
        liste("b", []),
        liste("c", ["c.example"], "bridge"),
        liste("d", ["d.example"]),
      ],
      1000,
      async (dom) => (dom === "b.example" ? ["198.51.100.2"] : ["198.51.100.1"]),
    );
    expect(r).toEqual({
      a: { "a.example": ["198.51.100.1"], "b.example": ["198.51.100.2"] },
      d: { "d.example": ["198.51.100.1"] },
    });
  });

  it("adresses qu'une sandbox n'épinglerait pas (locales, de la machine, de métadonnées) : retirées, sauf couvertes par les adresses du profil ; machine illisible : seules les couvertes", async () => {
    const machine = async () => ({ adresses: [], reseaux: [] });
    const resoudre = async (dom: string): Promise<string[]> =>
      dom === "a.example"
        ? ["127.0.0.1", "169.254.169.254", "198.51.100.1"]
        : ["192.0.2.9", "100.100.100.200"];
    const profils = [liste("p", ["a.example", "b.example"])];
    expect(await etatDomaines(profils, 1000, resoudre, machine)).toEqual({
      p: { "a.example": ["198.51.100.1"], "b.example": ["192.0.2.9"] },
    });
    oublierEtatDomaines();
    expect(await etatDomaines(profils, 1000, resoudre, () => Promise.reject(new Error("illisible")))).toEqual(
      {
        p: { "a.example": [], "b.example": ["192.0.2.9"] },
      },
    );
  });

  it("nom introuvable (ENOTFOUND, ENODATA) : liste vide, gardée ; autre erreur : null, non gardée", async () => {
    const appels: string[] = [];
    const resoudre = async (dom: string): Promise<string[]> => {
      appels.push(dom);
      if (dom === "a.example") throw erreur("ENOTFOUND");
      if (dom === "b.example") throw erreur("ENODATA");
      if (dom === "c.example") throw erreur("EAI_AGAIN");
      throw new Error("sans code");
    };
    const profils = [liste("p", ["a.example", "b.example", "c.example", "d.example"])];
    expect(await etatDomaines(profils, 1000, resoudre)).toEqual({
      p: { "a.example": [], "b.example": [], "c.example": null, "d.example": null },
    });
    expect(appels.sort()).toEqual(["a.example", "b.example", "c.example", "d.example"]);
    await etatDomaines(profils, 1000, resoudre);
    expect(appels.filter((d) => d === "a.example" || d === "b.example")).toHaveLength(2);
    expect(appels.filter((d) => d === "c.example" || d === "d.example")).toHaveLength(4);
  });

  it("résolutions gardées pendant ttlMs, puis relues", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(1_000_000);
    const resoudre = vi.fn(async () => ["198.51.100.1"]);
    const profils = [liste("p", ["a.example"])];
    await etatDomaines(profils, 1000, resoudre);
    vi.setSystemTime(1_000_000 + reglagesEtatDomaines.ttlMs - 1);
    await etatDomaines(profils, 1000, resoudre);
    expect(resoudre).toHaveBeenCalledTimes(1);
    vi.setSystemTime(1_000_000 + reglagesEtatDomaines.ttlMs);
    await etatDomaines(profils, 1000, resoudre);
    expect(resoudre).toHaveBeenCalledTimes(2);
  });

  it("une seule résolution par nom en cours, même demandée par plusieurs profils ou appels", async () => {
    let fin: (v: string[]) => void = () => undefined;
    const resoudre = vi.fn(() => new Promise<string[]>((ok) => (fin = ok)));
    const profils = [liste("p", ["a.example"]), liste("q", ["a.example"])];
    const [x, y] = [etatDomaines(profils, 1000, resoudre), etatDomaines(profils, 1000, resoudre)];
    await vi.waitFor(() => expect(resoudre).toHaveBeenCalledTimes(1));
    fin(["198.51.100.1"]);
    const attendu = { p: { "a.example": ["198.51.100.1"] }, q: { "a.example": ["198.51.100.1"] } };
    expect([await x, await y]).toEqual([attendu, attendu]);
    expect(resoudre).toHaveBeenCalledTimes(1);
  });

  it("deux résolutions à la fois au plus", async () => {
    let en = 0;
    let max = 0;
    const resoudre = async (): Promise<string[]> => {
      en++;
      max = Math.max(max, en);
      await new Promise((ok) => setTimeout(ok, 10));
      en--;
      return ["198.51.100.1"];
    };
    const domaines = Array.from({ length: 7 }, (_, i) => `d${i}.example`);
    const r = await etatDomaines([liste("p", domaines)], 5000, resoudre);
    expect(Object.values(r["p"] ?? {}).every((v) => v?.[0] === "198.51.100.1")).toBe(true);
    expect(max).toBe(2);
    oublierEtatDomaines();
    reglagesEtatDomaines.simultanees = 4;
    max = 0;
    await etatDomaines([liste("p", domaines)], 5000, resoudre);
    expect(max).toBe(4);
  });

  it("sans réponse à temps : null, attendu au plus le délai ; la réponse tardive est gardée pour l'appel suivant", async () => {
    let fin: (v: string[]) => void = () => undefined;
    const resoudre = vi.fn(() => new Promise<string[]>((ok) => (fin = ok)));
    const profils = [liste("p", ["lent.example"])];
    const debut = Date.now();
    expect(await etatDomaines(profils, 30, resoudre)).toEqual({ p: { "lent.example": null } });
    expect(Date.now() - debut).toBeLessThan(1000);
    fin(["198.51.100.4"]);
    expect(await etatDomaines(profils, 1000, resoudre)).toEqual({ p: { "lent.example": ["198.51.100.4"] } });
    expect(resoudre).toHaveBeenCalledTimes(1);
  });

  it("aucun profil à suivre : état vide, aucune résolution", async () => {
    const resoudre = vi.fn(async () => ["198.51.100.1"]);
    expect(await etatDomaines([], 100, resoudre)).toEqual({});
    expect(await etatDomaines([liste("a", [])], 100, resoudre)).toEqual({});
    expect(resoudre).not.toHaveBeenCalled();
  });
});
