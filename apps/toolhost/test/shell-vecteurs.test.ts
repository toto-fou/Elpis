// SPDX-License-Identifier: MIT
/** apps/toolhost/test/shell-vecteurs.test.ts — famille shell rejouée sur les vecteurs du vrai Python (migration-kit/vecteurs/toolhost_shell.py) : codes d'erreur, coupes, résultat formaté, lignes, relevé, base64, flux live, pont et outil. */
import { readFileSync } from "node:fs";

import type { ExecResult, OptionsExec } from "@elpis/bac";
import type { Dict } from "@elpis/commun";
import { safeSandboxName } from "@elpis/config";
import { AgentError, TOO_BIG, UNKNOWN } from "@elpis/fichiers";
import type { ContexteAppel, OptionsJournal } from "@elpis/outils-mcp";
import { describe, expect, it } from "vitest";

import { contenuRendu, statsLignes } from "../src/mcp/changements";
import { enAnglaisProfond } from "./ecart-anglais-shell-git";
import { b64Valide, clipMarked, errShell, executeShell } from "../src/mcp/shell/outil";
import type { AppuisShell, ArgsShell } from "../src/mcp/shell/outil";
import { FluxShell, formatResult, PontExec } from "../src/mcp/shell/pont";
import type { BacShell } from "../src/mcp/shell/pont";

type Brut = Record<string, unknown>;
const V = JSON.parse(readFileSync(new URL("./vecteurs/shell.json", import.meta.url), "utf-8")) as Record<
  string,
  Brut[]
>;

const b = (s: string): Buffer => Buffer.from(s, "base64");
const b64 = (x: Uint8Array): string => Buffer.from(x).toString("base64");
/** Égalité ET ordre des clés (le modèle lit le JSON dans cet ordre). */
const meme = (obtenu: unknown, attendu: unknown): void => {
  expect(obtenu).toEqual(attendu);
  expect(JSON.stringify(obtenu)).toBe(JSON.stringify(attendu));
};

/** Contexte d'appel de test : notifications notées dans l'ordre, comme la doublure Python. */
export function ctxTest(meta: Dict | null, appels: unknown[] = []): ContexteAppel & { appels: unknown[] } {
  const log = async (message: string, o: OptionsJournal = {}): Promise<void> => {
    appels.push(["log", o.level ?? "info", o.loggerName ?? null, message, o.extra ?? null]);
  };
  return {
    appels,
    nomOutil: "execute_shell",
    meta,
    famille: "shell",
    signal: new AbortController().signal,
    log,
    debug: async (m) => void appels.push(["debug", m]),
    info: async (m) => void appels.push(["info", m]),
    warning: async (m) => void appels.push(["warning", m]),
    error: async (m) => void appels.push(["error", m]),
    reportProgress: async (p, t, m) => void appels.push(["progress", p, t ?? null, m ?? null]),
  };
}

/** Écarts voulus au Python (harnais B-07) : code d'erreur stable, sans la donnée que le slug du message y mettait ; ancien code du vecteur → nouveau. */
const CODES_B07: Readonly<Record<string, string>> = {
  // chemin du cwd retiré du code
  cwd_not_a_directory_work: "cwd_not_a_directory",
  cwd_not_a_directory_work_absent: "cwd_not_a_directory",
  cwd_not_a_directory_work_f_txt: "cwd_not_a_directory",
  // raison du refus de save_stdout laissée au message
  bad_save_stdout_path_outside_sandbox: "bad_save_stdout",
  // détail de la panne de l'exécuteur laissé au message (nom du conteneur compris)
  executor_unavailable_boom: "executor_unavailable",
  executor_unavailable_container_elpis_sb_: "executor_unavailable",
  // code de l'agent seul, sans son message
  agent_unavailable_agent_muet: "agent_unavailable",
  agent_unavailable_client_de_l_agent_non_: "agent_unavailable",
  permission_refus: "permission",
  // UnicodeEncodeError : caractère et position laissés au message
  utf_8_codec_can_t_encode_character_ud800: "invalid_text",
  utf_8_codec_can_t_encode_character_udbff: "invalid_text",
  utf_8_codec_can_t_encode_character_udc80: "invalid_text",
  utf_8_codec_can_t_encode_characters_in_p: "invalid_text",
};
const codesB07Vus = new Set<string>();

/** Attendu du Python avec les écarts B-07 appliqués (clés et ordre gardés). */
function avecCodesB07<T>(v: T): T {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return v;
  const code = (v as Dict)["error"];
  if (typeof code !== "string" || !Object.hasOwn(CODES_B07, code)) return v;
  codesB07Vus.add(code);
  return { ...(v as Dict), error: CODES_B07[code] } as T;
}

function sansDurees(appels: unknown[]): unknown[] {
  return appels.map((a) => {
    const x = a as unknown[];
    if (x[0] === "progress" || x[0] === "warning" || x[0] === "info")
      return x.map((v) => (typeof v === "string" ? v.replace(/\b\d+ ms\b/gu, "<ms> ms") : v));
    const extra = x[4] as Dict | null;
    if (x[0] === "log" && extra?.["done"]) return [...x.slice(0, 4), { ...extra, duration_ms: "<ms>" }];
    return x;
  });
}

describe("vecteurs shell : fonctions pures", () => {
  it("codes d'erreur (_err)", () => {
    for (const c of V["erreurs"] as { msg: string; hint: string; kw: Dict; sortie: Dict }[])
      meme(errShell(c.msg, c.hint, c.kw), avecCodesB07(c.sortie));
  });

  it("coupes marquées (_clip_marked)", () => {
    for (const c of V["coupes"] as { s: string | null; cap: number; sortie: string }[])
      expect(clipMarked(c.s, c.cap)).toBe(c.sortie);
  });

  it("résultat formaté (_format_result)", () => {
    for (const c of V["formats"] as Brut[]) {
      const r = {
        stdout: b(c["stdout"] as string),
        stderr: b(c["stderr"] as string),
        returncode: c["returncode"] as number,
        timed_out: c["timed_out"] as boolean,
        duration_s: c["duration_s"] as number,
        executor_tag: "docker.user.alice",
      };
      meme(formatResult(r, c["cmd"], c["max_output"] as number, c["cwd"] as string), c["sortie"]);
    }
  });

  it("lignes ajoutées et retirées (_line_stats, statsLignes de changements.ts)", () => {
    for (const c of V["lignes"] as { avant: string; apres: string; sortie: [number, number] | null }[])
      expect(statsLignes(b(c.avant), b(c.apres))).toEqual(c.sortie);
  });

  it("écart voulu au Python : pas de +/- au-delà de 4 000 lignes d'un côté (diff synchrone qui gelait l'hôte d'outils)", () => {
    const lignes = (n: number): Buffer =>
      Buffer.from(Array.from({ length: n }, (_, i) => `l${i}\n`).join(""));
    expect(statsLignes(lignes(4000), lignes(3999))).toEqual([0, 1]);
    expect(statsLignes(lignes(4001), lignes(4000))).toBeNull();
    expect(statsLignes(lignes(10), lignes(4001))).toBeNull();
  });

  it("contenus du relevé (_contenu, contenuRendu de changements.ts)", () => {
    for (const c of V["contenus"] as { entree: unknown; sortie: unknown }[]) {
      const v = contenuRendu(c.entree);
      const r = v === null ? null : v === TOO_BIG ? "TOO_BIG" : v === UNKNOWN ? "UNKNOWN" : { b64: b64(v) };
      expect([c.entree, r]).toEqual([c.entree, c.sortie]);
    }
  });

  it("base64 strict (b64decode validate=True)", () => {
    for (const c of V["b64"] as { entree: string; sortie: string | null }[]) {
      const v = b64Valide(c.entree);
      expect([c.entree, v === null ? null : b64(v)]).toEqual([c.entree, c.sortie]);
    }
  });
});

describe("vecteurs shell : flux live (_ShellStreamBatcher)", () => {
  for (const c of V["flux"] as Brut[])
    it(String(c["nom"]), async () => {
      const ctx = ctxTest(c["meta"] as Dict);
      const f = new FluxShell(ctx);
      for (const [flux, data] of c["morceaux"] as [string, string][])
        f.ajouter(flux as "stdout" | "stderr", b(data));
      const fin = c["fin"] as { returncode: number; duration_ms: number; timed_out: boolean };
      await f.fermer({ returncode: fin.returncode, durationMs: fin.duration_ms, timedOut: fin.timed_out });
      meme(ctx.appels, c["appels"]);
    });
});

function attendre(ms: number): Promise<void> {
  return new Promise((fin) => setTimeout(fin, ms));
}

/** Doublure du bac (comme `_Bac` du générateur) : exec rejoué depuis le scénario, écritures de l'agent notées. */
function bacDuScenario(sc: Brut, journal: unknown[]): BacShell {
  const agent = {
    hello: async () => ({}),
    archive: async () => {
      throw new Error("inutile");
    },
    extract: async () => ({}),
    stat: async () => [],
    changesBegin: async () => ({}),
    changesEnd: async () => [[], {}],
    write: async (rel: string, data: unknown, o: { parents?: boolean } = {}) => {
      const brut =
        data instanceof Uint8Array ? Buffer.from(data) : readFileSync((data as { chemin: string }).chemin);
      if (sc["echec_ecriture"]) throw new Error(String(sc["echec_ecriture"]));
      journal.push(["ecrit", rel, b64(brut), Boolean(o.parents)]);
      return { ok: true };
    },
  };
  return {
    containerName: "elpis-sb-alice",
    sandboxPath: "/sb/alice/work",
    networkProfileId: (sc["profil"] as string | undefined) ?? null,
    agent,
    async exec(cmd: readonly string[], o: OptionsExec = {}): Promise<ExecResult> {
      journal.push([
        "exec",
        [...cmd],
        o.workdirInContainer,
        o.env,
        o.stdin === undefined ? null : b64(o.stdin),
        o.timeoutS,
        o.onChunk !== undefined,
      ]);
      if (sc["panne"]) throw new Error(String(sc["panne"]));
      for (const m of sc["morceaux"] as [string, string | number][]) {
        if (m[0] === "pause") await attendre((m[1] as number) * 1000);
        else if (o.onChunk && !sc["sans_rappel"]) o.onChunk(m[0] as "stdout" | "stderr", b(m[1] as string));
      }
      const r = sc["resultat"] as {
        rc: number;
        stdout: string;
        stderr: string;
        duree: number;
        timed_out: boolean;
      };
      return {
        returncode: r.rc,
        stdout: b(r.stdout),
        stderr: b(r.stderr),
        duration_s: r.duree,
        timed_out: r.timed_out,
        executor_tag: "docker.user.alice",
        container_id: null,
      };
    },
  };
}

describe("vecteurs shell : pont d'exécution (run_shell_via_executor)", () => {
  for (const sc of V["ponts"] as Brut[])
    it(String(sc["nom"]), async () => {
      const journal: unknown[] = [];
      const pont = new PontExec({
        bac: async () => bacDuScenario(sc, journal),
        journal: { info: () => undefined, warn: () => undefined },
        audit: (e) =>
          journal.push([
            "audit",
            {
              user_id: e.userId,
              username: e.username,
              kind: e.kind,
              code: e.code,
              pipeline_id: e.pipelineId,
              run_id: e.runId,
              node_id: e.nodeId,
              executor: e.executor,
              extra: e.extra,
            },
          ]),
      });
      const ctx = sc["sans_ctx"] ? null : ctxTest({ username: "alice", ...((sc["meta"] as Dict) ?? {}) });
      let sortie: Dict | null = null;
      let erreur: string | null = null;
      try {
        sortie = await pont.runShell({
          tokens: sc["tokens"] as string[],
          sandboxRoot: "/sb/alice/work",
          workdirRel: (sc["workdir"] as string | undefined) ?? "",
          envExtra: (sc["env_extra"] as Record<string, string> | undefined) ?? { GIT_TERMINAL_PROMPT: "0" },
          timeoutS: (sc["timeout"] as number | undefined) ?? 120,
          maxOutput: (sc["max_output"] as number | undefined) ?? 20000,
          stdin: sc["stdin"] === undefined ? null : b(sc["stdin"] as string),
          userId: 7,
          username: "alice",
          ctx,
          saveStdoutRel: (sc["save"] as string | undefined) ?? null,
          autoSpillRel: (sc["spill"] as string | undefined) ?? null,
          spillOverChars: (sc["plancher"] as number | null | undefined) ?? null,
          streamLive: Boolean(sc["live"]),
        });
      } catch (e) {
        erreur = (e as Error).message;
      }
      meme([sortie, erreur], [enAnglaisProfond(sc["sortie"]), sc["erreur"]]);
      meme(journal, sc["journal"]);
      meme(sansDurees(ctx?.appels ?? []), sc["appels"]);
    });
});

const normaliser = (v: unknown): unknown =>
  JSON.parse(JSON.stringify(v).replace(/(shell|bg)-\d+-[0-9a-f]{6}\.log/gu, "$1-<T>.log"));

describe("vecteurs shell : outil execute_shell", () => {
  for (const sc of V["outils"] as Brut[])
    it(String(sc["nom"]), async () => {
      const appels: Dict[] = [];
      const releve: unknown[][] = [];
      const stats = (sc["stats"] as Record<string, Dict> | undefined) ?? {};
      const appuis: AppuisShell = {
        racine: async (u) => `<racine>/${safeSandboxName(u)}/work`,
        stats: async (_u, _r, rels) =>
          rels.map((rel) => {
            const e = stats[rel] ?? { path: rel, kind: "missing" };
            if ("erreur" in e) throw new AgentError(String(e["erreur"]), String(e["message"] ?? ""));
            return e;
          }),
        userIdFor: async () => 7,
        releve: (uid, username, _racine) => {
          releve.push(["releve", uid, username, "shell"]);
          const changes: Dict[] = [];
          return {
            debut: async () => void releve.push(["debut"]),
            fin: async () => {
              releve.push(["fin"]);
              changes.push(...((sc["fichiers"] as Dict[] | undefined) ?? []));
            },
            attacher: (r) => {
              if (changes.length > 0) {
                r["files_changed"] = changes;
                const total = (sc["total"] as number | undefined) ?? 0;
                if (total > changes.length) r["files_changed_total"] = total;
              }
              return r;
            },
          };
        },
        executer: async (o) => {
          appels.push({
            tokens: o.tokens,
            workdir_rel: o.workdirRel,
            sandbox_root: o.sandboxRoot,
            env_extra: o.envExtra,
            timeout_s: o.timeoutS,
            max_output: o.maxOutput,
            stdin_bytes: o.stdin === null ? null : b64(o.stdin),
            user_id: o.userId,
            username: o.username,
            ctx: null,
            stream_live: o.streamLive,
            save_stdout_rel: o.saveStdoutRel,
            auto_spill_rel: o.autoSpillRel,
            spill_over_chars: o.spillOverChars,
          });
          if (sc["pont_erreur"]) throw new Error(String(sc["pont_erreur"]));
          return { ...(sc["pont"] as Dict) };
        },
        plancherDebord: () => 7920,
      };
      const args = sc["args"] as Brut;
      const valeurs: ArgsShell = {
        command: args["command"] as string,
        cwd: (args["cwd"] as string | undefined) ?? null,
        timeout_sec: (args["timeout_sec"] as number | undefined) ?? null,
        stdin: (args["stdin"] as string | undefined) ?? "",
        stdin_b64: (args["stdin_b64"] as string | undefined) ?? "",
        env: (args["env"] as Record<string, string> | undefined) ?? {},
        save_stdout: (args["save_stdout"] as string | undefined) ?? "",
        background: (args["background"] as boolean | undefined) ?? false,
      };
      const sortie = await executeShell(valeurs, ctxTest(sc["meta"] as Dict), appuis);
      meme(normaliser(sortie), avecCodesB07(enAnglaisProfond(sc["sortie"])));
      expect(normaliser(appels)).toEqual(sc["appels"]);
      expect(releve).toEqual(sc["releve"]);
    });
});

describe("vecteurs shell : écarts B-07 déclarés", () => {
  it("chaque ancien code de la table sert à au moins un vecteur", () => {
    expect([...codesB07Vus].sort()).toEqual(Object.keys(CODES_B07).sort());
  });
});
