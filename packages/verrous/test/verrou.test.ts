// SPDX-License-Identifier: MIT
/** packages/verrous/test/verrou.test.ts — protocole elpis.verrou.v1.1 : exclusion, péremption, reprise, rendu, battement, annulation (tests de shared_infra/runtime/verrou_fichier.py portés). */
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  constants,
  existsSync,
  lstatSync,
  lutimesSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as dormir } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { pyJsonDumps, strPy } from "@elpis/commun";

import {
  avecVerrou,
  avecVerrouSync,
  brancherJournal,
  cheminVerrou,
  definirProcessus,
  identiteMachine,
  nomProcessus,
  pidVivant,
  SUFFIXE_PERIME,
  SUFFIXE_REPRISE,
  VerrouFichier,
  VerrouOccupe,
} from "../src/index";
import { executer, systeme, systemeSync } from "../src/es";
import type { Proc } from "../src/es";
import {
  creerVerrou,
  decoderContenu,
  ligneVerrou,
  lireVerrou,
  PEREMPTION_DEFAUT_MS,
  Reprise,
  surchargerReglages,
} from "../src/verrou";
import type { EtatFichier } from "../src/verrou";

interface Vecteurs {
  lignes: {
    machine: [string, string, string];
    pid: number;
    debut: number;
    proc: string;
    peremption_s: number;
    ligne: string;
  }[];
  contenus: { hex: string; contenu: Record<string, unknown> | null }[];
  constantes: Record<string, unknown>;
}

const VECTEURS = JSON.parse(
  readFileSync(new URL("./vecteurs/verrous.json", import.meta.url), "utf8"),
) as Vecteurs;
const RACINE_ROOT = process.getuid?.() === 0;

let dossier = "";
let p = "";
let messages: string[] = [];
const restaurations: (() => void)[] = [];

function reglerPourCeTest(partiel: Parameters<typeof surchargerReglages>[0]): void {
  restaurations.push(surchargerReglages(partiel));
}

function poser(
  chemin: string,
  o: { pid: number; ageS?: number; hote?: string; proc?: string; champs?: Record<string, unknown> },
): void {
  const [h, boot, nspid] = identiteMachine();
  const contenu = {
    v: 1,
    pid: o.pid,
    hote: o.hote ?? h,
    debut: Date.now(),
    proc: o.proc ?? "autre",
    boot,
    nspid,
  };
  writeFileSync(chemin, pyJsonDumps({ ...contenu, ...o.champs }) + "\n");
  const t = Date.now() / 1000 - (o.ageS ?? 0);
  utimesSync(chemin, t, t);
}

function pidMort(): number {
  for (let i = 0; i < 5; i++) {
    const r = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], {
      encoding: "utf8",
    });
    const pid = Number(r.stdout);
    if (!pidVivant(pid)) return pid;
  }
  throw new Error("aucun PID libre trouvé");
}

function restes(d: string): string[] {
  return readdirSync(d)
    .filter((n) => n.includes(SUFFIXE_PERIME) || n.includes(SUFFIXE_REPRISE))
    .sort();
}

function contenu(chemin: string): Record<string, unknown> {
  return JSON.parse(readFileSync(chemin, "utf8")) as Record<string, unknown>;
}

function erreurSysteme(code: string): Error {
  return Object.assign(new Error(`${code}: panne simulée`), { code });
}

// eslint-disable-next-line require-yield
function* jamaisTenue(): Proc<boolean> {
  return false;
}

beforeEach(() => {
  dossier = mkdtempSync(path.join(tmpdir(), "elpis-verrous-"));
  p = path.join(dossier, "r.lock");
  messages = [];
  const noter =
    (niveau: string) =>
    (...a: unknown[]) =>
      messages.push(`${niveau} ${a.map(String).join(" ")}`);
  brancherJournal(() => ({
    debug: noter("DEBUG"),
    info: noter("INFO"),
    warn: noter("WARNING"),
    error: noter("ERROR"),
  }));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  while (restaurations.length > 0) restaurations.pop()?.();
  brancherJournal(null);
  definirProcessus("");
  try {
    chmodSync(p, 0o600);
  } catch {
    /* absent */
  }
  rmSync(dossier, { recursive: true, force: true });
});

describe("format (vecteurs Python)", () => {
  it("écrit à l'octet la ligne de _ligne pour chaque identité de machine", () => {
    for (const v of VECTEURS.lignes) {
      const ligne = ligneVerrou(v.pid, v.debut, v.proc, v.peremption_s * 1000, v.machine);
      expect(ligne.toString("utf8"), JSON.stringify(v)).toBe(v.ligne);
    }
  });

  it("lit chaque contenu comme _decoder (champs facultatifs mal typés = inconnus)", () => {
    for (const v of VECTEURS.contenus) {
      const c = decoderContenu(Buffer.from(v.hex, "hex"));
      const attendu = v.contenu;
      if (attendu === null) {
        expect(c, v.hex).toBeNull();
        continue;
      }
      expect(c, v.hex).not.toBeNull();
      const absent = (x: unknown): unknown => (x === undefined ? "$absent" : x);
      expect(
        {
          pid: c?.pid,
          hote: c?.hote,
          debut: c?.debut,
          proc: c?.proc === undefined ? "None" : strPy(c.proc),
          boot: absent(c?.boot),
          nspid: absent(c?.nspid),
          peremption: absent(c?.peremption),
        },
        Buffer.from(v.hex, "hex").toString("latin1"),
      ).toEqual(attendu);
    }
  });

  it("garde les constantes du protocole", () => {
    expect(VECTEURS.constantes).toMatchObject({
      version: 1,
      peremption_defaut_s: PEREMPTION_DEFAUT_MS / 1000,
      suffixe_reprise: SUFFIXE_REPRISE,
      suffixe_perime: SUFFIXE_PERIME,
      reprise_peremption_s: 10,
      illisible_s: 5,
    });
  });
});

describe("prise et rendu", () => {
  it("écrit une ligne JSON (clés dans l'ordre de la spec, 0600) et la supprime au rendu", async () => {
    definirProcessus("essai");
    const v = new VerrouFichier(p);
    await v.acquerir();
    expect(v.tenu).toBe(true);
    const brut = readFileSync(p, "utf8");
    expect(brut.endsWith("\n") && brut.split("\n").length === 2).toBe(true);
    const c = contenu(p);
    expect(Object.keys(c)).toEqual(["v", "pid", "hote", "debut", "proc", "boot", "nspid", "peremption"]);
    expect(c).toMatchObject({ v: 1, pid: process.pid, hote: hostname(), proc: "essai", peremption: 120_000 });
    expect(Math.abs(Number(c["debut"]) - Date.now())).toBeLessThan(5000);
    expect(statSync(p).mode & 0o777).toBe(0o600);
    await v.rendre();
    expect(v.tenu).toBe(false);
    expect(existsSync(p)).toBe(false);
    expect(restes(dossier)).toEqual([]);
  });

  it("chemins et nom de processus", () => {
    expect(cheminVerrou(path.join(dossier, "MEMORY.md"))).toBe(path.join(dossier, "MEMORY.md.lock"));
    expect(cheminVerrou(path.join(dossier, "hist"), { repertoire: true })).toBe(
      path.join(dossier, "hist", ".lock"),
    );
    vi.stubEnv("APP_SERVICE", "admin");
    expect(nomProcessus()).toBe("admin");
    definirProcessus("toolhost");
    expect(nomProcessus()).toBe("toolhost");
    definirProcessus("  ");
    vi.stubEnv("APP_SERVICE", "");
    vi.stubEnv("APP_MODE", "main");
    expect(nomProcessus()).toBe("main");
    expect(new VerrouOccupe("x")).toBeInstanceOf(Error);
  });

  it("tâches concurrentes du même processus : aucune perte", async () => {
    const compteur = path.join(dossier, "c.txt");
    writeFileSync(compteur, "0");
    const travail = async (): Promise<void> => {
      for (let i = 0; i < 8; i++) {
        await avecVerrou(p, { delaiMs: 30_000 }, async () => {
          const n = Number(readFileSync(compteur, "utf8"));
          await dormir(1);
          writeFileSync(compteur, String(n + 1));
        });
      }
    };
    await Promise.all([travail(), travail(), travail(), travail()]);
    expect(Number(readFileSync(compteur, "utf8"))).toBe(32);
    expect(existsSync(p)).toBe(false);
  });

  it("un détenteur vivant fait attendre jusqu'au délai", async () => {
    poser(p, { pid: process.ppid });
    const t0 = performance.now();
    await expect(new VerrouFichier(p, { delaiMs: 300 }).acquerir()).rejects.toBeInstanceOf(VerrouOccupe);
    expect(performance.now() - t0).toBeGreaterThanOrEqual(290);
    expect(contenu(p)["proc"]).toBe("autre");
  });

  it("délai nul : un seul essai ; sans délai : attend le rendu", async () => {
    const tenant = new VerrouFichier(p);
    await tenant.acquerir();
    const t0 = performance.now();
    await expect(new VerrouFichier(p, { delaiMs: 0 }).acquerir()).rejects.toThrow(/occupé depuis 0\.0 s/);
    expect(performance.now() - t0).toBeLessThan(200);
    setTimeout(() => void tenant.rendre(), 300);
    const attendant = new VerrouFichier(p);
    await attendant.acquerir();
    expect(performance.now() - t0).toBeGreaterThanOrEqual(290);
    expect(attendant.tenu).toBe(true);
    await attendant.rendre();
    expect(existsSync(p)).toBe(false);
  });

  it("non réentrant ; double rendu sans effet", async () => {
    const v = new VerrouFichier(p);
    await v.acquerir();
    await expect(v.essayer()).rejects.toThrow(/déjà tenu/);
    expect(await new VerrouFichier(p).essayer()).toBe(false);
    await v.rendre();
    await v.rendre();
    expect(existsSync(p)).toBe(false);
  });

  it("crée le dossier parent", async () => {
    const q = path.join(dossier, "a", "b", "r.lock");
    await avecVerrou(q, { delaiMs: 0 }, async () => expect(existsSync(q)).toBe(true));
    expect(statSync(path.dirname(q)).isDirectory()).toBe(true);
    expect(existsSync(q)).toBe(false);
  });

  it("debut strictement croissant dans le processus", async () => {
    const vus: number[] = [];
    for (let i = 0; i < 20; i++) {
      const q = path.join(dossier, `r${i % 2}.lock`);
      await avecVerrou(q, { delaiMs: 0 }, async () => {
        vus.push(Number(contenu(q)["debut"]));
      });
    }
    expect(vus).toEqual([...new Set(vus)].sort((a, b) => a - b));
    expect(vus).toHaveLength(20);
  });
});

describe("péremption", () => {
  it("PID mort sur cette machine : repris", async () => {
    poser(p, { pid: pidMort() });
    const v = new VerrouFichier(p, { delaiMs: 0 });
    await v.acquerir();
    expect(contenu(p)["pid"]).toBe(process.pid);
    await v.rendre();
    expect(restes(dossier)).toEqual([]);
    expect(messages.some((m) => m.startsWith("INFO") && m.includes("périmé repris : pid"))).toBe(true);
  });

  it("PID mort d'un autre hôte : jugé par l'âge seul", async () => {
    poser(p, { pid: pidMort(), hote: "autre-machine" });
    await expect(new VerrouFichier(p, { delaiMs: 0 }).acquerir()).rejects.toBeInstanceOf(VerrouOccupe);
    poser(p, { pid: pidMort(), ageS: 121, hote: "autre-machine" });
    await avecVerrou(p, { delaiMs: 0 }, async () => expect(contenu(p)["hote"]).toBe(hostname()));
  });

  it("âge dépassé : repris même détenteur vivant", async () => {
    poser(p, { pid: process.ppid, ageS: 10 });
    await expect(new VerrouFichier(p, { delaiMs: 0 }).acquerir()).rejects.toBeInstanceOf(VerrouOccupe);
    await avecVerrou(p, { delaiMs: 0, peremptionMs: 5000 }, async () =>
      expect(contenu(p)["proc"]).not.toBe("autre"),
    );
    expect(existsSync(p)).toBe(false);
  });

  it.each([
    ["vide", ""],
    ["tronqué", '{"v":1,"pid":'],
    ["texte", "pas du json"],
    ["version", '{"v":2,"pid":1,"hote":"h","debut":1}'],
    ["pid nul", '{"v":1,"pid":0,"hote":"h","debut":1}'],
    ["version booléenne", '{"v":true,"pid":5,"hote":"h","debut":1}'],
    ["pid énorme", '{"v":1,"pid":1099511627776,"hote":"h","debut":1}'],
    ["debut NaN", '{"v":1,"pid":5,"hote":"h","debut":NaN}'],
  ])("contenu illisible (%s) : repris après 5 s", async (_nom, texte) => {
    writeFileSync(p, texte);
    await expect(new VerrouFichier(p, { delaiMs: 50 }).acquerir()).rejects.toBeInstanceOf(VerrouOccupe);
    const ancien = Date.now() / 1000 - 6;
    utimesSync(p, ancien, ancien);
    await avecVerrou(p, { delaiMs: 0 }, async () => expect(contenu(p)["pid"]).toBe(process.pid));
    expect(restes(dossier)).toEqual([]);
  });

  it("contenu illisible observé pendant 5 s par ce processus (mtime dans le futur)", async () => {
    reglerPourCeTest({ illisibleMs: 200 });
    writeFileSync(p, "");
    const futur = Date.now() / 1000 + 3600;
    utimesSync(p, futur, futur);
    const t0 = performance.now();
    await avecVerrou(p, { delaiMs: 5000 }, async () => {
      const ecoule = performance.now() - t0;
      expect(ecoule).toBeGreaterThanOrEqual(190);
      expect(ecoule).toBeLessThan(4000);
    });
  });

  it("observation d'un illisible cumulée d'une prise à l'autre", async () => {
    reglerPourCeTest({ illisibleMs: 300 });
    writeFileSync(p, "");
    const futur = Date.now() / 1000 + 3600;
    utimesSync(p, futur, futur);
    await expect(new VerrouFichier(p, { delaiMs: 200 }).acquerir()).rejects.toBeInstanceOf(VerrouOccupe);
    await dormir(200);
    await avecVerrou(p, { delaiMs: 0 }, async () => undefined);
    expect(existsSync(p)).toBe(false);
  });

  it.skipIf(RACINE_ROOT)("illisible pour ce compte (EACCES) : seul l'âge compte", async () => {
    poser(p, { pid: process.ppid });
    chmodSync(p, 0);
    const ancien = Date.now() / 1000 - 6;
    utimesSync(p, ancien, ancien);
    await expect(new VerrouFichier(p, { delaiMs: 0 }).acquerir()).rejects.toBeInstanceOf(VerrouOccupe);
    await avecVerrou(p, { delaiMs: 0, peremptionMs: 5000 }, async () =>
      expect(contenu(p)["pid"]).toBe(process.pid),
    );
    expect(existsSync(p)).toBe(false);
    expect(restes(dossier)).toEqual([]);
  });

  it("ancien verrou flock vide : repris sans attendre", async () => {
    writeFileSync(p, "", { mode: 0o644 });
    const ancien = Date.now() / 1000 - 86400;
    utimesSync(p, ancien, ancien);
    const t0 = performance.now();
    await avecVerrou(p, { delaiMs: 5000 }, async () => undefined);
    expect(performance.now() - t0).toBeLessThan(1000);
    expect(existsSync(p)).toBe(false);
  });

  it("même PID sans prise dans ce processus (processus précédent) : repris", async () => {
    poser(p, { pid: process.pid });
    await avecVerrou(p, { delaiMs: 0 }, async () => expect(contenu(p)["proc"]).not.toBe("autre"));
  });

  it("la péremption du détenteur s'applique au lecteur (max des deux)", async () => {
    poser(p, { pid: process.ppid, ageS: 200, champs: { peremption: 3_600_000 } });
    await expect(
      new VerrouFichier(p, { delaiMs: 0, peremptionMs: 120_000 }).acquerir(),
    ).rejects.toBeInstanceOf(VerrouOccupe);
  });

  it("redémarrage de la machine (boot) et autre espace de PID", async () => {
    poser(p, { pid: process.ppid, champs: { boot: "autre-demarrage" } });
    await avecVerrou(p, { delaiMs: 0 }, async () => undefined);
    poser(p, { pid: pidMort(), champs: { nspid: "pid:[1]" } });
    await expect(new VerrouFichier(p, { delaiMs: 0 }).acquerir()).rejects.toBeInstanceOf(VerrouOccupe);
    poser(p, { pid: pidMort(), champs: { boot: "", nspid: "" } });
    const [, boot, nspid] = identiteMachine();
    if (boot !== "" || nspid !== "")
      await expect(new VerrouFichier(p, { delaiMs: 0 }).acquerir()).rejects.toBeInstanceOf(VerrouOccupe);
  });

  it("fichier v1 sans boot ni nspid : jugé comme en v1", async () => {
    writeFileSync(
      p,
      JSON.stringify({ v: 1, pid: pidMort(), hote: hostname(), debut: 0, proc: "ancien" }) + "\n",
    );
    await avecVerrou(p, { delaiMs: 0 }, async () => expect("boot" in contenu(p)).toBe(true));
    writeFileSync(p, JSON.stringify({ v: 1, pid: process.pid, hote: hostname(), debut: 0 }) + "\n");
    await avecVerrou(p, { delaiMs: 0 }, async () => undefined);
  });

  it.each([
    ["boot null", { boot: null }],
    ["nspid nombre", { nspid: 5 }],
    ["peremption texte", { peremption: "120000" }],
    ["peremption booléen", { peremption: true }],
  ])("champ facultatif mal typé (%s) : inconnu, le détenteur vivant n'est pas repris", async (_n, champs) => {
    poser(p, { pid: process.ppid, ageS: 6, champs });
    expect((await lireVerrou(p))?.contenu).not.toBeNull();
    await expect(new VerrouFichier(p, { delaiMs: 0 }).acquerir()).rejects.toBeInstanceOf(VerrouOccupe);
  });

  it("lien symbolique à la place du verrou : illisible, cible intacte", async () => {
    const cible = path.join(dossier, "cible");
    writeFileSync(cible, "intact");
    symlinkSync(cible, p);
    const ancien = Date.now() / 1000 - 6;
    lutimesSync(p, ancien, ancien);
    const e = await lireVerrou(p);
    expect(e?.contenu).toBeNull();
    expect(e?.interdit).toBe(false);
    await avecVerrou(p, { delaiMs: 0 }, async () => expect(lstatSync(p).isSymbolicLink()).toBe(false));
    expect(readFileSync(cible, "utf8")).toBe("intact");
  });

  it("une erreur d'E/S à la lecture (EMFILE, EIO) ne reprend jamais un verrou vivant", async () => {
    poser(p, { pid: process.ppid, ageS: 10 });
    const ouvrir = systeme.open;
    const lecture = (c: string, d: number): boolean =>
      path.basename(c) === "r.lock" && (d & constants.O_CREAT) === 0;
    vi.spyOn(systeme, "open").mockImplementation(async (c, d, m) => {
      if (lecture(c, d)) throw erreurSysteme("EMFILE");
      return ouvrir(c, d, m);
    });
    await expect(new VerrouFichier(p, { delaiMs: 0 }).acquerir()).rejects.toMatchObject({ code: "EMFILE" });
    vi.restoreAllMocks();
    vi.spyOn(systeme, "read").mockRejectedValue(erreurSysteme("EIO"));
    await expect(new VerrouFichier(p, { delaiMs: 0 }).acquerir()).rejects.toMatchObject({ code: "EIO" });
    vi.restoreAllMocks();
    expect(contenu(p)["pid"]).toBe(process.ppid);
    expect(restes(dossier)).toEqual([]);
  });
});

describe("reprise et rendu sous R.lock.reprise", () => {
  it("rendu après reprise : le verrou du repreneur reste, avertissement", async () => {
    const premier = new VerrouFichier(p, { peremptionMs: 50 });
    await premier.acquerir();
    await dormir(100);
    const second = new VerrouFichier(p, { delaiMs: 2000, peremptionMs: 50 });
    await second.acquerir();
    const octetsSecond = readFileSync(p);
    await premier.rendre();
    expect(readFileSync(p).equals(octetsSecond)).toBe(true);
    expect(messages.some((m) => m.includes("repris par un autre processus"))).toBe(true);
    await second.rendre();
    expect(existsSync(p)).toBe(false);
    expect(restes(dossier)).toEqual([]);
  });

  it("verrou périmé remplacé par un vivant avant la reprise : le vivant reste", async () => {
    writeFileSync(p, "");
    const ancien = Date.now() / 1000 - 60;
    utimesSync(p, ancien, ancien);
    const perime = (await lireVerrou(p)) as EtatFichier;
    unlinkSync(p);
    const vivant = new VerrouFichier(p);
    await vivant.acquerir();
    const octets = readFileSync(p);
    await new VerrouFichier(p).reprendre(perime, "essai");
    expect(readFileSync(p).equals(octets)).toBe(true);
    expect(restes(dossier)).toEqual([]);
    await vivant.rendre();
    expect(existsSync(p)).toBe(false);
  });

  it("R.lock n'est jamais renommé", async () => {
    poser(p, { pid: pidMort() });
    const renommer = systeme.rename;
    vi.spyOn(systeme, "rename").mockImplementation(async (de, vers) => {
      expect(path.basename(de)).not.toBe("r.lock");
      return renommer(de, vers);
    });
    await avecVerrou(p, { delaiMs: 0 }, async () => undefined);
    expect(existsSync(p)).toBe(false);
  });

  it("deux repreneurs simultanés d'un même périmé : un seul effacement, le verrou neuf reste", async () => {
    poser(p, { pid: pidMort() });
    const perime = (await lireVerrou(p)) as EtatFichier;
    const effaces: string[] = [];
    const effacer = systemeSync.unlink;
    vi.spyOn(systemeSync, "unlink").mockImplementation((c) => {
      effacer(c);
      if (path.basename(c) === "r.lock") {
        effaces.push(c);
        poser(p, { pid: process.ppid });
      }
    });
    await Promise.all([
      new VerrouFichier(p).reprendre(perime, "a"),
      new VerrouFichier(p).reprendre(perime, "b"),
    ]);
    expect(effaces).toHaveLength(1);
    expect(contenu(p)["pid"]).toBe(process.ppid);
    expect(restes(dossier)).toEqual([]);
  });

  it("reprise abandonnée par un mort : reprise", async () => {
    poser(p + SUFFIXE_REPRISE, { pid: pidMort() });
    poser(p, { pid: pidMort() });
    await avecVerrou(p, { delaiMs: 1000 }, async () => expect(contenu(p)["pid"]).toBe(process.pid));
    expect(readdirSync(dossier)).toEqual([]);
  });

  it("reprise tenue par un vivant bloqué : reprise après 10 s FIXES (péremption du fichier ignorée)", async () => {
    reglerPourCeTest({ reprisePeremptionMs: 500 });
    poser(p, { pid: pidMort() });
    poser(p + SUFFIXE_REPRISE, { pid: process.ppid, champs: { peremption: 3_600_000 } });
    const t0 = performance.now();
    await avecVerrou(p, { delaiMs: 5000 }, async () => {
      const ecoule = performance.now() - t0;
      expect(ecoule).toBeGreaterThanOrEqual(400);
      expect(ecoule).toBeLessThan(3000);
    });
    expect(readdirSync(dossier)).toEqual([]);
  });

  it("sans la reprise, rien n'est supprimé (rendu ni reprise)", async () => {
    const v = new VerrouFichier(p);
    await v.acquerir();
    const octets = readFileSync(p);
    const tenue = vi.spyOn(Reprise.prototype, "tenue").mockImplementation(jamaisTenue);
    await v.rendre();
    expect(readFileSync(p).equals(octets)).toBe(true);
    expect(messages.some((m) => m.includes("reprise cassée"))).toBe(true);
    poser(p, { pid: pidMort() });
    await new VerrouFichier(p).reprendre((await lireVerrou(p)) as EtatFichier, "essai");
    expect(existsSync(p)).toBe(true);
    tenue.mockRestore();
    await avecVerrou(p, { delaiMs: 0 }, async () => undefined);
    expect(existsSync(p)).toBe(false);
    expect(restes(dossier)).toEqual([]);
  });

  it("rendu dont la reprise échoue (EMFILE) : la prise est libérée, le fichier reste", async () => {
    const v = new VerrouFichier(p);
    await v.acquerir();
    const entrer = vi.spyOn(Reprise.prototype, "entrer").mockImplementation(() => {
      throw erreurSysteme("EMFILE");
    });
    await v.rendre();
    expect(v.tenu).toBe(false);
    expect(existsSync(p)).toBe(true);
    expect(messages.some((m) => m.includes("non rendu"))).toBe(true);
    entrer.mockRestore();
    await avecVerrou(p, { delaiMs: 0 }, async () => undefined);
    expect(existsSync(p)).toBe(false);
  });

  it("fichier repris pendant l'écriture de sa création : pas de prise", async () => {
    const ecrire = systeme.write;
    vi.spyOn(systeme, "write").mockImplementation(async (fd, d) => {
      unlinkSync(p);
      poser(p, { pid: process.ppid });
      return ecrire(fd, d);
    });
    expect(await creerVerrou(p, Buffer.from("x\n"))).toBe(false);
    expect(contenu(p)["pid"]).toBe(process.ppid);
    vi.restoreAllMocks();
    unlinkSync(p);
    vi.spyOn(systeme, "write").mockImplementation(async (fd, d) => {
      unlinkSync(p);
      return ecrire(fd, d);
    });
    expect(await creerVerrou(p, Buffer.from("x\n"))).toBe(false);
    expect(existsSync(p)).toBe(false);
  });

  it("créateur arrêté avant d'écrire, repreneur à E/S lentes : jamais deux détenteurs (décision synchrone)", async () => {
    reglerPourCeTest({ illisibleMs: 100 });
    const [ecrire, effacer] = [systeme.write, systeme.unlink];
    let premiere = true;
    vi.spyOn(systeme, "write").mockImplementation(async (fd, d) => {
      if (premiere) {
        premiere = false;
        await dormir(400);
      }
      return ecrire(fd, d);
    });
    vi.spyOn(systeme, "unlink").mockImplementation(async (c) => {
      if (c === p) await dormir(300);
      return effacer(c);
    });
    const a = new VerrouFichier(p, { delaiMs: 0 });
    const b = new VerrouFichier(p, { delaiMs: 2000 });
    const priseA = a.essayer();
    await dormir(150);
    await b.acquerir();
    expect(await priseA).toBe(false);
    expect([a.tenu, b.tenu]).toEqual([false, true]);
    await b.rendre();
    expect(existsSync(p)).toBe(false);
  });

  it("fichier délié entre l'écriture et le contrôle (nlink nul) : pas de prise", async () => {
    const etat = systeme.fstat;
    let appels = 0;
    vi.spyOn(systeme, "fstat").mockImplementation(async (fd) => {
      const st = await etat(fd);
      return ++appels === 2
        ? Object.assign(Object.create(Object.getPrototypeOf(st) as object), st, { nlink: 0n })
        : st;
    });
    expect(await creerVerrou(p, Buffer.from("x\n"))).toBe(false);
    expect(appels).toBe(2);
  });

  it("état relu au mtime différent (réécrit entre-temps) : rien n'est repris", async () => {
    poser(p, { pid: pidMort() });
    const perime = (await lireVerrou(p)) as EtatFichier;
    const t = Date.now() / 1000 + 3;
    utimesSync(p, t, t);
    await new VerrouFichier(p).reprendre(perime, "test");
    expect(existsSync(p)).toBe(true);
    expect(restes(dossier)).toEqual([]);
  });

  it("écriture en échec : fichier effacé sous la reprise, erreur remontée", async () => {
    const ecrire = systeme.write;
    let appels = 0;
    vi.spyOn(systeme, "write").mockImplementation(async (fd, d) => {
      appels++;
      if (appels === 1) throw erreurSysteme("ENOSPC");
      return ecrire(fd, d);
    });
    await expect(new VerrouFichier(p).essayer()).rejects.toMatchObject({ code: "ENOSPC" });
    expect(appels).toBe(2);
    expect(existsSync(p)).toBe(false);
    expect(restes(dossier)).toEqual([]);
  });

  it("rendu asynchrone : la boucle n'est jamais gelée pendant l'attente de la reprise", async () => {
    reglerPourCeTest({ reprisePeremptionMs: 500 });
    const v = new VerrouFichier(p);
    await v.acquerir();
    poser(p + SUFFIXE_REPRISE, { pid: process.ppid });
    const ecarts: number[] = [];
    let fin = false;
    const battre = (async (): Promise<void> => {
      let t = performance.now();
      while (!fin) {
        await dormir(10);
        ecarts.push(performance.now() - t);
        t = performance.now();
      }
    })();
    const t0 = performance.now();
    await v.rendre();
    fin = true;
    await battre;
    expect(performance.now() - t0).toBeGreaterThanOrEqual(400);
    expect(Math.max(...ecarts)).toBeLessThan(200);
    expect(existsSync(p)).toBe(false);
    expect(restes(dossier)).toEqual([]);
  });

  async function repriseCasseeEt(lien: (de: string, vers: string) => Promise<void>): Promise<string> {
    const chemin = p + SUFFIXE_REPRISE;
    poser(chemin, { pid: pidMort() });
    const perime = (await lireVerrou(chemin)) as EtatFichier;
    unlinkSync(chemin);
    poser(chemin, { pid: process.ppid, proc: "vivant" });
    vi.spyOn(systeme, "link").mockImplementation(lien);
    await executer(new Reprise(p, null).casser(perime));
    return chemin;
  }

  it("reprise vivante déplacée par erreur : remise en place par lien", async () => {
    const lier = systeme.link;
    const chemin = await repriseCasseeEt((de, vers) => lier(de, vers));
    expect(contenu(chemin)["proc"]).toBe("vivant");
    expect(restes(dossier)).toEqual([path.basename(chemin)]);
  });

  it("reprise vivante déplacée par erreur : remise par renommage sans liens durs", async () => {
    const chemin = await repriseCasseeEt(() => Promise.reject(erreurSysteme("EPERM")));
    expect(contenu(chemin)["proc"]).toBe("vivant");
    expect(restes(dossier)).toEqual([path.basename(chemin)]);
  });

  it("reprise vivante déplacée par erreur : place prise entre-temps, avertissement", async () => {
    const chemin = await repriseCasseeEt(async (_de, vers) => {
      poser(vers, { pid: process.ppid, proc: "tiers" });
      throw erreurSysteme("EEXIST");
    });
    expect(contenu(chemin)["proc"]).toBe("tiers");
    expect(restes(dossier)).toEqual([path.basename(chemin)]);
    expect(messages.some((m) => m.includes("non remise"))).toBe(true);
  });
});

describe("attente et annulation", () => {
  it("annulée pendant l'attente : rejet immédiat, aucun verrou pris", async () => {
    const tenant = new VerrouFichier(p);
    await tenant.acquerir();
    const attendant = new VerrouFichier(p);
    const ctrl = new AbortController();
    const promesse = attendant.acquerir({ signal: ctrl.signal });
    await dormir(100);
    ctrl.abort(new Error("annulé"));
    await expect(promesse).rejects.toThrow("annulé");
    await tenant.rendre();
    await dormir(300);
    expect(attendant.tenu).toBe(false);
    expect(existsSync(p)).toBe(false);
  });

  it("annulée pendant une tentative : la tentative s'achève et rend le verrou pris", async () => {
    const ouvrir = systeme.open;
    vi.spyOn(systeme, "open").mockImplementation(async (c, d, m) => {
      await dormir(300);
      return ouvrir(c, d, m);
    });
    const v = new VerrouFichier(p);
    const ctrl = new AbortController();
    const promesse = v.acquerir({ signal: ctrl.signal });
    await dormir(100);
    ctrl.abort(new Error("annulé"));
    await expect(promesse).rejects.toThrow("annulé");
    vi.restoreAllMocks();
    await dormir(1200);
    expect(v.tenu).toBe(false);
    expect(existsSync(p)).toBe(false);
    await v.acquerir();
    await v.rendre();
  });

  it("signal déjà annulé : rien n'est tenté", async () => {
    const ctrl = new AbortController();
    ctrl.abort(new Error("déjà"));
    await expect(new VerrouFichier(p).acquerir({ signal: ctrl.signal })).rejects.toThrow("déjà");
    expect(existsSync(p)).toBe(false);
  });

  it("délai d'attente asynchrone", async () => {
    await avecVerrou(p, {}, async () => {
      const t0 = performance.now();
      await expect(new VerrouFichier(p, { delaiMs: 200 }).acquerir()).rejects.toBeInstanceOf(VerrouOccupe);
      expect(performance.now() - t0).toBeGreaterThanOrEqual(190);
    });
  });

  it("une attente longue est journalisée une fois, avec le détenteur", async () => {
    reglerPourCeTest({ attenteSignaleeMs: 50 });
    poser(p, { pid: process.ppid, proc: "toolhost" });
    await expect(new VerrouFichier(p, { delaiMs: 500 }).acquerir()).rejects.toBeInstanceOf(VerrouOccupe);
    const attentes = messages.filter((m) => m.includes("attendu depuis"));
    expect(attentes).toHaveLength(1);
    expect(attentes[0]).toContain("toolhost");
    expect(attentes[0]).toContain(String(process.ppid));
  });

  it("avecVerrou rend le verrou même si l'opération lève", async () => {
    await expect(
      avecVerrou(p, { delaiMs: 0 }, async () => {
        throw new Error("échec métier");
      }),
    ).rejects.toThrow("échec métier");
    expect(existsSync(p)).toBe(false);
  });
});

describe("battement", () => {
  it("une opération plus longue que la péremption n'est pas reprise ; sans battement, elle l'est", async () => {
    const v = new VerrouFichier(p, { peremptionMs: 600, battement: true });
    await v.acquerir();
    await dormir(1500);
    await expect(new VerrouFichier(p, { delaiMs: 0, peremptionMs: 600 }).acquerir()).rejects.toBeInstanceOf(
      VerrouOccupe,
    );
    await v.rendre();
    expect(existsSync(p)).toBe(false);
    const w = new VerrouFichier(p, { peremptionMs: 300 });
    await w.acquerir();
    await dormir(600);
    await avecVerrou(p, { delaiMs: 0, peremptionMs: 300 }, async () => undefined);
    await w.rendre();
    expect(messages.some((m) => m.includes("repris par un autre processus"))).toBe(true);
  });

  it("bat même quand la boucle principale est bloquée (fil dédié)", async () => {
    const v = new VerrouFichier(p, { peremptionMs: 600, battement: true });
    await v.acquerir();
    await dormir(300);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500);
    const ageMs = Date.now() - Number(statSync(p, { bigint: true }).mtimeNs) / 1e6;
    expect(ageMs).toBeLessThan(600);
    await v.rendre();
    expect(existsSync(p)).toBe(false);
  });

  it.skipIf(RACINE_ROOT)(
    "erreur passagère : signalée une fois, réessayée à la période suivante",
    async () => {
      const v = new VerrouFichier(p, { peremptionMs: 600, battement: true });
      await v.acquerir();
      chmodSync(p, 0);
      await dormir(500);
      chmodSync(p, 0o600);
      await dormir(1000);
      await expect(new VerrouFichier(p, { delaiMs: 0, peremptionMs: 600 }).acquerir()).rejects.toBeInstanceOf(
        VerrouOccupe,
      );
      await v.rendre();
      expect(messages.filter((m) => m.includes("battement en échec"))).toHaveLength(1);
    },
  );

  it("ne touche jamais le mtime d'un verrou étranger", async () => {
    const v = new VerrouFichier(p, { peremptionMs: 150, battement: true });
    await v.acquerir();
    unlinkSync(p);
    poser(p, { pid: process.ppid, ageS: 30 });
    const mtime = statSync(p, { bigint: true }).mtimeNs;
    await dormir(300);
    expect(statSync(p, { bigint: true }).mtimeNs).toBe(mtime);
    await v.rendre();
    expect(statSync(p, { bigint: true }).mtimeNs).toBe(mtime);
    expect(contenu(p)["pid"]).toBe(process.ppid);
    expect(messages.some((m) => m.includes("repris par un autre processus"))).toBe(true);
  });
});

describe("prise synchrone (code synchrone d'initialisation)", () => {
  it("prend, écrit la même ligne et rend sous la reprise", () => {
    definirProcessus("synchrone");
    const v = new VerrouFichier(p);
    v.acquerirSync();
    expect(contenu(p)).toMatchObject({ v: 1, pid: process.pid, proc: "synchrone", peremption: 120_000 });
    v.rendreSync();
    expect(v.tenu).toBe(false);
    expect(existsSync(p)).toBe(false);
    expect(restes(dossier)).toEqual([]);
  });

  it("reprend un PID mort", () => {
    poser(p, { pid: pidMort() });
    expect(avecVerrouSync(p, { delaiMs: 0 }, () => contenu(p)["pid"])).toBe(process.pid);
    expect(existsSync(p)).toBe(false);
    expect(restes(dossier)).toEqual([]);
  });

  it("attend un détenteur vivant jusqu'au délai, puis VerrouOccupe", () => {
    poser(p, { pid: process.ppid });
    const t0 = performance.now();
    expect(() => avecVerrouSync(p, { delaiMs: 300 }, () => 1)).toThrow(VerrouOccupe);
    expect(performance.now() - t0).toBeGreaterThanOrEqual(290);
    expect(contenu(p)["proc"]).toBe("autre");
  });

  it("exclut une prise asynchrone du même processus ; refuse le battement", async () => {
    const v = new VerrouFichier(p);
    await v.acquerir();
    expect(() => avecVerrouSync(p, { delaiMs: 0 }, () => 1)).toThrow(VerrouOccupe);
    await v.rendre();
    expect(() => new VerrouFichier(p, { battement: true }).acquerirSync()).toThrow(/battement/);
    expect(existsSync(p)).toBe(false);
  });
});
