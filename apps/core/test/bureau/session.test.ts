// SPDX-License-Identifier: MIT
/** apps/core/test/bureau/session.test.ts — trames (propriété, compagnons, purge), bornes des caches d'observation, écritures concurrentes de la cible active. */
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, onTestFinished } from "vitest";

import {
  assignStableIds,
  desktopFramePath,
  extractDesktopFrame,
  getActiveTarget,
  getDesktopFrameOwner,
  getDesktopObservation,
  getScreenDims,
  pruneFrames,
  registerDesktopFrameOwner,
  registerDesktopObservation,
  setActiveTarget,
  setScreenDims,
} from "../../src/bureau";

const env = { ...process.env };
afterEach(() => {
  for (const k of ["DESKTOP_SCREENS_DIR", "DESKTOP_ACTIVE_PATH"]) {
    if (env[k] === undefined) delete process.env[k];
    else process.env[k] = env[k];
  }
});

function dossierTrames(): string {
  const d = mkdtempSync(join(tmpdir(), "elpis-trames-"));
  onTestFinished(() => rmSync(d, { recursive: true, force: true }));
  process.env["DESKTOP_SCREENS_DIR"] = d;
  return d;
}

describe("trames du bureau", () => {
  it("propriété : mémoire et fichier compagnon lisible par un autre processus", async () => {
    const d = dossierTrames();
    expect(desktopFramePath("tokenAAAA1234")).toBe(join(d, "frame_tokenAAAA1234.png"));
    await registerDesktopFrameOwner("tokenAAAA1234", "alice");
    expect(readFileSync(join(d, "frame_tokenAAAA1234.owner"), "utf-8")).toBe("alice");
    expect(await getDesktopFrameOwner("tokenAAAA1234")).toBe("alice");
    writeFileSync(join(d, "frame_autreBBBB5678.owner"), "  bob\n");
    expect(await getDesktopFrameOwner("autreBBBB5678")).toBe("bob");
    writeFileSync(join(d, "frame_videCCCC9012.owner"), " \n");
    expect(await getDesktopFrameOwner("videCCCC9012")).toBeNull();
    expect(await getDesktopFrameOwner("../../etc/passwd")).toBeNull();
    expect(await getDesktopFrameOwner("court")).toBeNull();
    expect(await getDesktopFrameOwner("")).toBeNull();
  });

  it("dossier absent : la propriété reste en mémoire, l'échec du compagnon ne lève pas", async () => {
    process.env["DESKTOP_SCREENS_DIR"] = join(tmpdir(), "elpis-inexistant-" + Date.now(), "x");
    await registerDesktopFrameOwner("tokenDDDD1234", "carol");
    expect(await getDesktopFrameOwner("tokenDDDD1234")).toBe("carol");
  });

  it("purge : trames et compagnons périmés supprimés, au plus un balayage par 30 s sauf forcé", async () => {
    const d = dossierTrames();
    const vieux = Date.now() / 1000 - 1000;
    for (const nom of ["frame_a.png", "frame_a.owner", "autre.png"]) {
      writeFileSync(join(d, nom), "x");
      utimesSync(join(d, nom), vieux, vieux);
    }
    writeFileSync(join(d, "frame_neuf.png"), "x");
    await pruneFrames(900, true);
    expect(
      ["frame_a.png", "frame_a.owner", "autre.png", "frame_neuf.png"].map((n) => existsSync(join(d, n))),
    ).toEqual([false, false, true, true]);
    writeFileSync(join(d, "frame_b.png"), "x");
    utimesSync(join(d, "frame_b.png"), vieux, vieux);
    await pruneFrames(900);
    expect(existsSync(join(d, "frame_b.png"))).toBe(true);
    await pruneFrames(900, true);
    expect(existsSync(join(d, "frame_b.png"))).toBe(false);
  });

  it("trame d'un résultat desktop_* horodatée à l'appel", () => {
    const avant = Date.now();
    const t = Number(
      /t=(\d+)$/.exec(
        String(extractDesktopFrame("desktop_observe", {}, '{"frame_token": "tokenAAAA1234"}')?.["url"]),
      )?.[1],
    );
    expect(t).toBeGreaterThanOrEqual(avant);
    expect(t).toBeLessThanOrEqual(Date.now());
  });
});

describe("caches d'observation", () => {
  it("200 cibles au plus : la plus ancienne sort avec ses dimensions et son compteur d'ids", () => {
    const els = (): Record<string, unknown>[] => [{ label: "a" }, { label: "b" }];
    registerDesktopObservation("u", "cible-0", assignStableIds("u", "cible-0", els()));
    setScreenDims("u", "cible-0", 800, 600);
    expect(getScreenDims("u", "cible-0")).toEqual([800, 600]);
    for (let i = 1; i <= 200; i++) registerDesktopObservation("u", `cible-${i}`, els());
    expect(getDesktopObservation("u", "cible-0")).toEqual([]);
    expect(getScreenDims("u", "cible-0")).toBeNull();
    const neufs = assignStableIds("u", "cible-0", els());
    expect(neufs.map((e) => (e as Record<string, unknown>)["id"])).toEqual(["el_1", "el_2"]);
    expect(getDesktopObservation("u", "cible-200")).toHaveLength(2);
  });
});

describe("cible active", () => {
  it("écritures concurrentes sérialisées : aucune ne perd l'autre", async () => {
    const d = mkdtempSync(join(tmpdir(), "elpis-actif-"));
    onTestFinished(() => rmSync(d, { recursive: true, force: true }));
    process.env["DESKTOP_ACTIVE_PATH"] = join(d, "desktop_active.json");
    await Promise.all(["a", "b", "c", "d"].map((u, i) => setActiveTarget(u, `vm${i}`)));
    expect(JSON.parse(readFileSync(join(d, "desktop_active.json"), "utf-8"))).toEqual({
      a: "vm0",
      b: "vm1",
      c: "vm2",
      d: "vm3",
    });
    await setActiveTarget("b", "");
    expect(await getActiveTarget("b")).toBe("");
    expect(await getActiveTarget("c")).toBe("vm2");
  });
});
