// SPDX-License-Identifier: MIT
/** apps/toolhost/test/quota-alerte.test.ts — alerte et refus de remplissage du bac (harnais N-08, écart voulu au Python qui n'alertait pas) : quota effectif du compte en pourcentage, volume de /work, seuils de config.json, cache de l'usage gardé, jamais d'erreur. */
import { renameSync, rmSync, statfsSync, writeFileSync } from "node:fs";
import path from "node:path";

import { invalidateSandboxUsage } from "@elpis/bac";
import { surchargerConfig } from "@elpis/config";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { RAPPEL_ABSENT } from "../src/fichiers/commun";
import { alerteRemplissage, refusRemplissage, reglagesRemplissage } from "../src/fichiers/quota";
import { ATTENTE_DISQUE_MS, auPlus } from "../src/mcp/disque";
import { dossierTemporaire } from "../../../packages/fichiers/test/aides";

const MIO = 1024 * 1024;
const quota = (q: number | null | undefined) => ({ ...RAPPEL_ABSENT, quotaCompte: () => Promise.resolve(q) });

let racine = "";
let nettoyer: () => void = () => undefined;
let restaurer: () => void = () => undefined;
const FRAICHEUR = reglagesRemplissage.fraicheurRefusS;
const ATTENTE = reglagesRemplissage.attenteQuotaMs;

beforeEach(() => {
  [racine, nettoyer] = dossierTemporaire("elpis-quota-alerte-");
  restaurer = surchargerConfig({ CONFIG_JSON_PATH: path.join(racine, "config.json") });
});

afterEach(() => {
  restaurer();
  reglagesRemplissage.fraicheurRefusS = FRAICHEUR;
  reglagesRemplissage.attenteQuotaMs = ATTENTE;
  nettoyer();
});

/** Seuils posés dans config.json comme la console les écrit (fichier remplacé), relus sans redémarrage. */
function seuils(warn_pct: number, refuse_pct: number): void {
  const tmp = path.join(racine, "config.json.tmp");
  writeFileSync(tmp, JSON.stringify({ executors: { disk: { warn_pct, refuse_pct } } }));
  renameSync(tmp, path.join(racine, "config.json"));
}

describe("alerte de remplissage (harnais N-08)", () => {
  it("compte à 90 % ou plus de son quota effectif : pourcentage, quota et conseil ; au-dessous, rien", async () => {
    writeFileSync(path.join(racine, "gros.bin"), Buffer.alloc(Math.floor(0.95 * MIO)));
    const alerte = await alerteRemplissage(quota(1), 9101, racine, 90);
    expect(alerte).toMatch(/^Disk space low: your sandbox uses 9\d% of its 1 MB quota[;.]/u);
    expect(alerte).toContain("/work/.tool-output/");
    expect(alerte).toContain("manage_files");
    expect(String(await alerteRemplissage(quota(2), 9102, racine, 90))).not.toMatch(/quota/u);
  });

  it("usage lu dans le cache (pas de du à chaque appel) : la hausse n'apparaît qu'une fois la mesure invalidée", async () => {
    writeFileSync(path.join(racine, "a.bin"), Buffer.alloc(MIO));
    expect(String(await alerteRemplissage(quota(10), 9103, racine, 90))).not.toMatch(/quota/u);
    writeFileSync(path.join(racine, "b.bin"), Buffer.alloc(Math.floor(8.4 * MIO)));
    expect(String(await alerteRemplissage(quota(10), 9103, racine, 90))).not.toMatch(/quota/u);
    invalidateSandboxUsage(9103);
    expect(await alerteRemplissage(quota(10), 9103, racine, 90)).toMatch(/uses 9\d% of its 10 MB quota/u);
  });

  it("quota inconnu (core injoignable), illimité (0), sans rappel ou sans compte : pas d'alerte de quota, aucune erreur", async () => {
    writeFileSync(path.join(racine, "gros.bin"), Buffer.alloc(MIO));
    const panne = { ...RAPPEL_ABSENT, quotaCompte: () => Promise.reject(new Error("injoignable")) };
    const cas: [ReturnType<typeof quota> | null, number][] = [
      [quota(undefined), 9104],
      [quota(0), 9104],
      [null, 9104],
      [quota(1), 0],
      [panne, 9104],
    ];
    // seuil 0 : le volume alerte toujours, le quota n'alerte que s'il est connu et limité
    for (const [r, uid] of cas) {
      const alerte = String(await alerteRemplissage(r, uid, racine, 0));
      expect([uid, alerte]).toEqual([uid, expect.stringMatching(/the disk holding \/work is \d+% full/u)]);
      expect(alerte).not.toMatch(/quota/u);
    }
    expect(await alerteRemplissage(quota(5), 9104, racine, 0)).toMatch(/uses \d+% of its 5 MB quota/u);
  });

  it("volume de /work : (total − libre) / total, seuil en pourcentage ; volume illisible : rien", async () => {
    const st = statfsSync(racine);
    const pct = Math.floor(((st.blocks - st.bavail) * 100) / st.blocks);
    expect(await alerteRemplissage(null, 9105, racine, pct)).toContain(
      `the disk holding /work is ${pct}% full`,
    );
    expect(await alerteRemplissage(null, 9105, racine, pct + 1)).toBeNull();
    expect(await alerteRemplissage(null, 9105, path.join(racine, "absent"), 0)).toBeNull();
  });

  it("seuils par défaut de config.json (executors.disk) : alerte dès 85 %, phrase qui annonce le refus à 97 % ; relus à chaud", async () => {
    writeFileSync(path.join(racine, "gros.bin"), Buffer.alloc(Math.floor(0.87 * MIO)));
    const alerte = await alerteRemplissage(quota(1), 9106, racine);
    expect(alerte).toMatch(/your sandbox uses 8[5-9]% of its 1 MB quota/u);
    expect(alerte).toMatch(/Writes and new background jobs are refused from 97%\.$/u);
    seuils(90, 95);
    expect(String(await alerteRemplissage(quota(1), 9106, racine))).not.toMatch(/quota/u);
    seuils(50, 60);
    expect(await alerteRemplissage(quota(1), 9106, racine)).toMatch(/quota.*refused from 60%/u);
  });

  it("refus au seuil de refus : motif anglais en pourcentage ; sous le seuil, quota inconnu ou mesure en panne : rien", async () => {
    writeFileSync(path.join(racine, "gros.bin"), Buffer.alloc(Math.floor(0.98 * MIO)));
    const refus = await refusRemplissage(quota(1), 9107, racine);
    expect(refus).toMatch(/^Disk almost full: your sandbox uses 9[7-9]% of its 1 MB quota[;.]/u);
    expect(refus).toContain("refused from 97%");
    expect(refus).toContain("deleting files still works");
    expect(String(await refusRemplissage(quota(2), 9108, racine))).not.toMatch(/quota/u);
    const panne = { ...RAPPEL_ABSENT, quotaCompte: () => Promise.reject(new Error("injoignable")) };
    for (const r of [quota(undefined), quota(0), panne, null])
      expect(String(await refusRemplissage(r, 9107, racine, 0))).not.toMatch(/quota/u);
    expect(await refusRemplissage(null, 9107, path.join(racine, "absent"), 0)).toBeNull();
    const st = statfsSync(racine);
    const pct = Math.floor(((st.blocks - st.bavail) * 100) / st.blocks);
    expect(await refusRemplissage(null, 9107, racine, pct)).toContain(
      `the disk holding /work is ${pct}% full`,
    );
    expect(await refusRemplissage(null, 9107, racine, pct + 1)).toBeNull();
  });

  it("refus confirmé par un usage récent : place libérée vue dans la fraîcheur, sinon le cache fait foi (pas de du par appel)", async () => {
    writeFileSync(path.join(racine, "gros.bin"), Buffer.alloc(Math.floor(0.98 * MIO)));
    reglagesRemplissage.fraicheurRefusS = 3600;
    expect(await refusRemplissage(quota(1), 9109, racine)).toMatch(/of its 1 MB quota/u);
    rmSync(path.join(racine, "gros.bin"));
    expect(await refusRemplissage(quota(1), 9109, racine)).toMatch(/of its 1 MB quota/u);
    expect(await alerteRemplissage(quota(1), 9109, racine)).toMatch(/of its 1 MB quota/u);
    reglagesRemplissage.fraicheurRefusS = 0;
    expect(String(await refusRemplissage(quota(1), 9109, racine))).not.toMatch(/quota/u);
    expect(String(await alerteRemplissage(quota(1), 9109, racine))).not.toMatch(/quota/u);
  });

  it("quota lent (core ou du) : le volume plein est vu sans l'attendre, sous la borne de la garde", async () => {
    const lent = {
      ...RAPPEL_ABSENT,
      quotaCompte: () => new Promise<number>((ok) => setTimeout(() => ok(1), 3_000).unref()),
    };
    const st = statfsSync(racine);
    const pct = Math.floor(((st.blocks - st.bavail) * 100) / st.blocks) - 1;
    for (const f of [refusRemplissage, alerteRemplissage]) {
      const t0 = performance.now();
      expect(await auPlus(f(lent, 9110, racine, pct))).toMatch(/the disk holding \/work is \d+% full/u);
      expect(performance.now() - t0).toBeLessThan(ATTENTE_DISQUE_MS);
    }
  });

  it("refus : si l'usage frais tarde, l'usage en cache déjà au-dessus du seuil fait foi", async () => {
    writeFileSync(path.join(racine, "gros.bin"), Buffer.alloc(Math.floor(0.98 * MIO)));
    expect(await alerteRemplissage(quota(1), 9111, racine)).toMatch(/of its 1 MB quota/u);
    rmSync(path.join(racine, "gros.bin"));
    reglagesRemplissage.fraicheurRefusS = 0;
    reglagesRemplissage.attenteQuotaMs = 0;
    expect(await refusRemplissage(quota(1), 9111, racine)).toMatch(/of its 1 MB quota/u);
  });
});
