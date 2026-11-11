// SPDX-License-Identifier: MIT
/** apps/core/test/bureau/outils-desktop.test.ts — outils desktop_* rejoués contre les vecteurs Python (vrai register(), faux agent) : résultats, requêtes à l'agent, notifications ; exposition et politique du tools/list Python. */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { ErreurPython, pyJsonDumps, pyJsonLoads } from "@elpis/commun";
import type { Dict } from "@elpis/commun";
import { config, invalidateConfigCache, reloadDesktopConfigFromDisk, surchargerConfig } from "@elpis/config";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  annotationsDesktop,
  CATEGORIE_DESKTOP,
  fermerAgentsBureau,
  installerComptesBureau,
  installerPrimitivesBureau,
  installerSocleBureau,
  listWindowsCore,
  outilDesktopExpose,
  outilsDesktopExposes,
  politiqueDesktop,
  PRIMITIVES_AGENT,
  REGLAGES_BUREAU,
  reinitialiserMemosBureau,
  runCommandCore,
  setActiveTarget,
  waitCore,
  windowActionCore,
} from "../../src/bureau";
import { FauxLan, portFerme } from "../faux-lan";
import type { ReponseScriptee, RequeteVue } from "../faux-lan";

type Service = ReponseScriptee & { ecran?: string; l?: number; h?: number };
type Etape = {
  config?: Dict;
  actif?: [string, string];
  raz?: boolean;
  outil?: string;
  primitive?: string;
  u?: string;
  cible?: string;
  args?: Dict;
  kw?: Dict;
  services?: Service[];
};
type OutilListe = { name: string; annotations?: Dict; _meta?: Dict };

const V = pyJsonLoads(readFileSync(new URL("../vecteurs/bureau-outils.json", import.meta.url), "utf-8")) as {
  ecrans: Record<string, string>;
  sandbox: Record<string, Record<string, string>>;
  etapes: Etape[];
  reponses: (Dict | null)[];
  exposition: { sans_shell: boolean; brut: boolean; outils: OutilListe[] }[];
};
const ENV = ["DESKTOP_SCREENS_DIR", "DESKTOP_ACTIVE_PATH"];
const COMPTES: Record<string, number> = { alice: 1, bob: 2, carol: 3 };

/** Écart déclaré : `targets` vide = la cible active (docstring de l'outil), là où Python ne lançait rien (« 0/0 »). */
const estMatriceSansCible = (e: Etape): boolean =>
  e.outil === "desktop_run_automation" &&
  !String(e.args?.["targets"] ?? "")
    .split(",")
    .some((t) => t.trim());

const PRIMITIVES: Record<string, (u: string, cible: string, kw: Dict) => Promise<Dict>> = {
  run_command_core: (u, cible, kw) => runCommandCore(u, cible, kw),
  wait_core: (u, cible, kw) => waitCore(u, cible, kw),
  list_windows_core: (u, cible) => listWindowsCore(u, cible),
  window_action_core: (u, cible, kw) => windowActionCore(u, cible, kw["action"], kw["window_id"]),
};

describe("outils desktop_* rejoués contre desktop_tools.register()", () => {
  let lan: FauxLan;
  let ferme: string;
  let dossier: string;
  const notifications: unknown[][] = [];
  const restaurer: (() => void)[] = [];
  const envAvant: Record<string, string | undefined> = {};
  const ttlAvant = { ...REGLAGES_BUREAU };

  beforeAll(async () => {
    dossier = mkdtempSync(path.join(tmpdir(), "elpis-bureau-outils-"));
    for (const k of ENV) envAvant[k] = process.env[k];
    process.env["DESKTOP_SCREENS_DIR"] = path.join(dossier, "ecrans");
    process.env["DESKTOP_ACTIVE_PATH"] = path.join(dossier, "actif.json");
    writeFileSync(path.join(dossier, "config.json"), "{}");
    const avant = {
      VISION_ENDPOINT_URL: config.VISION_ENDPOINT_URL,
      DESKTOP_TARGETS: config.DESKTOP_TARGETS,
      DESKTOP_MAX_ELEMENTS_CHAT: config.DESKTOP_MAX_ELEMENTS_CHAT,
    };
    restaurer.push(
      surchargerConfig({ CONFIG_JSON_PATH: path.join(dossier, "config.json") }),
      () => surchargerConfig(avant),
      surchargerConfig({ DESKTOP_DISABLE_SHELL: false, DESKTOP_EXPOSE_RAW_TOOLS: true }),
    );
    installerPrimitivesBureau(PRIMITIVES_AGENT);
    installerComptesBureau({ estAdmin: async (nom) => nom === "alice" });
    installerSocleBureau({
      services: {
        idCompte: async (nom) => COMPTES[nom] ?? null,
        lireSandbox: async (nom, chemin, max) => {
          const texte = V.sandbox[nom]?.[chemin];
          if (texte === undefined) throw new Error(`absent : ${chemin}`);
          return new TextDecoder("utf-8", { fatal: true }).decode(
            Buffer.from(texte, "utf-8").subarray(0, max),
          );
        },
        notifier: async ({ user_id: uid }, titre, corps) => {
          notifications.push([uid, "automation", titre, corps, "automation", null]);
        },
      },
    });
    Object.assign(REGLAGES_BUREAU, { a11yMemoTtlS: 3600, visionMemoTtlS: 3600, visionPromptMemoTtlS: 3600 });
    reinitialiserMemosBureau();
    lan = await FauxLan.demarrer();
    ferme = await portFerme();
  });

  afterAll(async () => {
    await lan.arreter();
    await fermerAgentsBureau();
    installerPrimitivesBureau(null);
    installerComptesBureau(null);
    installerSocleBureau({ services: null });
    Object.assign(REGLAGES_BUREAU, ttlAvant);
    for (const r of restaurer.reverse()) r();
    for (const k of ENV) {
      if (envAvant[k] === undefined) delete process.env[k];
      else process.env[k] = envAvant[k];
    }
    rmSync(dossier, { recursive: true, force: true });
  });

  it("exposition : mêmes outils, dans l'ordre d'inscription, selon DESKTOP_DISABLE_SHELL et DESKTOP_EXPOSE_RAW_TOOLS", () => {
    expect(V.exposition).toHaveLength(4);
    for (const x of V.exposition) {
      const retour = surchargerConfig({
        DESKTOP_DISABLE_SHELL: x.sans_shell,
        DESKTOP_EXPOSE_RAW_TOOLS: x.brut,
      });
      try {
        expect(outilsDesktopExposes().map((o) => o.nom)).toEqual(x.outils.map((o) => o.name));
        expect(outilDesktopExpose("desktop_shell") === null).toBe(x.sans_shell);
        expect(outilDesktopExpose("desktop_inspect") === null).toBe(!x.brut);
        expect(outilDesktopExpose("desktop_windows")?.nom).toBe("desktop_windows");
      } finally {
        retour();
      }
    }
  });

  it("politique : annotations et meta.policy du tools/list Python", () => {
    const complet = V.exposition.find((x) => !x.sans_shell && x.brut)?.outils ?? [];
    expect(complet.map((o) => o.name)).toEqual(outilsDesktopExposes().map((o) => o.nom));
    for (const o of outilsDesktopExposes()) {
      const py = complet.find((p) => p.name === o.nom);
      expect(py?.annotations, o.nom).toEqual(annotationsDesktop(o));
      expect(py?._meta?.["category"], o.nom).toEqual(CATEGORIE_DESKTOP);
      expect(pyJsonDumps(py?._meta?.["policy"]), o.nom).toBe(pyJsonDumps(politiqueDesktop(o)));
    }
  });

  it("chaque appel rend le même résultat, les mêmes requêtes à l'agent, les mêmes notifications", async () => {
    const neutre = (texte: string): string =>
      texte
        .replaceAll(lan.url, "<SERVICE>")
        .replaceAll(ferme, "<FERME>")
        .replace(/"frame_token": "[A-Za-z0-9_-]+"/g, '"frame_token": "<J>"')
        .replace(/"waited_ms": \d+/g, '"waited_ms": 0')
        .replace(/"duration_s": [0-9.e+-]+/g, '"duration_s": 0');
    const vue = (v: RequeteVue): Dict => {
      const { corps, ...reste } = v;
      return { ...reste, corps: neutre(Buffer.from(corps, "base64").toString("utf-8")) };
    };
    const service = (s: Service): ReponseScriptee =>
      s.ecran === undefined
        ? s
        : { statut: s.statut, json: { ok: true, image: V.ecrans[s.ecran], width: s.l, height: s.h } };
    const appeler = (e: Etape): Promise<Dict> | undefined =>
      e.outil !== undefined
        ? outilDesktopExpose(e.outil)?.gerer(e.u ?? "", e.args ?? {})
        : PRIMITIVES[e.primitive ?? ""]?.(e.u ?? "", e.cible ?? "", e.kw ?? {});
    let n = 0;
    let ecarts = 0;
    for (const [i, e] of V.etapes.entries()) {
      if (e.config !== undefined) {
        const texte = pyJsonDumps(e.config, { ensureAscii: false })
          .replaceAll("<SERVICE>", lan.url)
          .replaceAll("<FERME>", ferme);
        writeFileSync(path.join(dossier, "config.json"), texte);
        invalidateConfigCache();
        reloadDesktopConfigFromDisk(true);
        surchargerConfig({ VISION_ENDPOINT_URL: "" });
        continue;
      }
      if (e.actif !== undefined) {
        await setActiveTarget(...e.actif);
        continue;
      }
      if (e.raz) {
        reinitialiserMemosBureau();
        continue;
      }
      lan.reponses = (e.services ?? []).map(service);
      lan.vues.length = 0;
      notifications.length = 0;
      let vu: Dict;
      try {
        const appel = appeler(e);
        if (appel === undefined) throw new Error(`inconnu : ${e.outil ?? e.primitive}`);
        vu = { resultat: neutre(pyJsonDumps(await appel, { ensureAscii: false })) };
      } catch (x) {
        vu = {
          exception: x instanceof ErreurPython ? x.type : x instanceof Error ? x.name : "?",
          message: x instanceof Error ? x.message : String(x),
        };
      }
      Object.assign(vu, {
        vues: lan.vues.map(vue),
        restantes: lan.reponses.length,
        notifs: [...notifications],
      });
      const attendu = V.reponses[i] as Dict;
      const titre = `étape ${i} : ${e.outil ?? e.primitive} ${JSON.stringify(e.args ?? e.kw ?? {})}`;
      if (estMatriceSansCible(e) && /"targets": 0, /.test(String(attendu["resultat"]))) {
        ecarts++;
        const doc = pyJsonLoads(String(vu["resultat"])) as Dict;
        if ((e.services ?? []).length === 0) {
          expect(doc["error"], titre).toBe("no_target");
          expect(vu["notifs"], titre).toEqual([]);
        } else {
          const r0 = (doc["results"] as Dict[])[0] ?? {};
          const vues = vu["vues"] as Dict[];
          expect([doc["targets"], r0["target"], vu["restantes"]], titre).toEqual([1, "vm1", 0]);
          expect(
            vues.map((v) => v["p"]),
            titre,
          ).toEqual([
            "/agent1/put_file",
            "/agent1/run_script",
            `/agent1/run_status?run_id=${String(r0["run_id"])}&log_tail=80`,
          ]);
          const script = e.args?.["code"] ?? V.sandbox["alice"]?.["automations/demo-rapport.py"];
          expect((JSON.parse(String(vues[0]?.["corps"])) as Dict)["content"], titre).toBe(script);
          expect(vu["notifs"], titre).toEqual([
            [
              COMPTES[e.u ?? ""],
              "automation",
              `Automatisation « ${String(doc["name"])} » : ${String(doc["summary"])}`,
              `vm1 : ${r0["ok"] === true ? "OK" : "ÉCHEC"} — ${String(r0["summary"])}`,
              "automation",
              null,
            ],
          ]);
        }
      } else expect(vu, titre).toEqual(attendu);
      n++;
    }
    expect([n, ecarts]).toEqual([V.reponses.filter((x) => x !== null).length, 3]);
  });
});
