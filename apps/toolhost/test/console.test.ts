// SPDX-License-Identifier: MIT
/** apps/toolhost/test/console.test.ts — routes internes `/api/internal/sandboxes/*` de la console (faux docker) : santé, conteneurs, arrêt et destruction sous verrou, GC des inactifs, refus sans enveloppe. */
import {
  chmodSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import { resetUserSandboxCache } from "@elpis/bac";
import { creerFauxDocker } from "@elpis/bac/test";
import type { FauxDocker } from "@elpis/bac/test";
import { surchargerConfig } from "@elpis/config";
import { oublierConfigurationAudit } from "@elpis/securite";
import { avecVerrou } from "@elpis/verrous";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { delaisDocker } from "../src/bac/console";
import { dossierTemporaire, enveloppe, entetes, hoteTest, SVC } from "./aides";
import type { HoteTest } from "./aides";

/** Sur le faux docker à état : `ps`, `ps -a` et `inspect` des étiquettes lus dans `<etat>/<clé>.out` (`.rc`, `.dort`). */
const SURCOUCHE = `#!/bin/sh
d="$FAUX_DOCKER"
case "$1" in
  ps) case "$*" in *" -a "*) k=ps-a ;; *netcfg*) k=ps-netcfg ;; *) k=ps-noms ;; esac ;;
  inspect) for a; do n="$a"; done
           case "$*" in *user_id*) k="inspect-$n" ;; *username*) k="inspect-nom-$n" ;; *) exec "$(dirname "$0")/docker-base" "$@" ;; esac ;;
  *) exec "$(dirname "$0")/docker-base" "$@" ;;
esac
printf '%s\\n' "$*" >> "$d/appels.log"
[ -f "$d/$k.dort" ] && exec sleep "$(cat "$d/$k.dort")"
[ -f "$d/$k.out" ] && cat "$d/$k.out"
[ -f "$d/$k.err" ] && cat "$d/$k.err" >&2
[ -f "$d/$k.rc" ] && exit "$(cat "$d/$k.rc")"
exit 0
`;

let tmp = "";
let nettoyer: () => void = () => undefined;
let restaurer: () => void = () => undefined;
let h: HoteTest;
let docker: FauxDocker;
const DELAIS_AVANT = { ...delaisDocker };

function etat(nom: string, contenu: string): void {
  writeFileSync(path.join(docker.etat, nom), contenu);
}

beforeEach(async () => {
  [tmp, nettoyer] = dossierTemporaire("elpis-th-console-");
  docker = creerFauxDocker(path.join(tmp, "docker"));
  renameSync(path.join(docker.bin, "docker"), path.join(docker.bin, "docker-base"));
  writeFileSync(path.join(docker.bin, "docker"), SURCOUCHE);
  chmodSync(path.join(docker.bin, "docker"), 0o755);
  vi.stubEnv("PATH", `${docker.bin}${path.delimiter}${process.env["PATH"] ?? ""}`);
  vi.stubEnv("FAUX_DOCKER", docker.etat);
  vi.stubEnv("ELPIS_AUDIT_DIR", path.join(tmp, "audit"));
  oublierConfigurationAudit();
  mkdirSync(path.join(tmp, "sb"), { recursive: true });
  restaurer = surchargerConfig({ SANDBOX_DIR: path.join(tmp, "sb") });
  h = await hoteTest();
});

afterEach(async () => {
  await h.fermer();
  Object.assign(delaisDocker, DELAIS_AVANT);
  resetUserSandboxCache();
  oublierConfigurationAudit();
  restaurer();
  vi.unstubAllEnvs();
  nettoyer();
});

const appeler = (methode: "GET" | "POST", url: string, ident = entetes()) =>
  h.app.inject({ method: methode, url, headers: ident });

describe("/api/internal/sandboxes : porte", () => {
  it("sans jeton de service, sans enveloppe ou avec une enveloppe signée d'une autre clé : 401, docker jamais lancé", async () => {
    const sans = { authorization: `Bearer ${SVC}` };
    const faux = { authorization: `Bearer ${SVC}`, "x-elpis-identity": enveloppe(7, "hugo", "autre-cle") };
    for (const [methode, url] of [
      ["GET", "/api/internal/sandboxes/health?image=x"],
      ["GET", "/api/internal/sandboxes/running"],
      ["GET", "/api/internal/sandboxes/containers"],
      ["POST", "/api/internal/sandboxes/stop"],
      ["POST", "/api/internal/sandboxes/destroy"],
      ["POST", "/api/internal/sandboxes/gc?idle_kill_hours=1"],
    ] as const) {
      for (const ident of [{}, sans, faux])
        expect((await appeler(methode, url, ident)).statusCode, `${methode} ${url}`).toBe(401);
    }
    expect(docker.appels()).toEqual([]);
  });
});

describe("santé et relevés", () => {
  it("santé : version du démon, image absente avec son archive, démon muet ou en panne", async () => {
    const ok = await appeler("GET", "/api/internal/sandboxes/health?image=elpis%2Fsandbox%3A1");
    expect(ok.json()).toMatchObject({
      daemon_ok: true,
      server_version: "27.3.1",
      image: "elpis/sandbox:1",
      image_loaded: true,
      archive_available: false,
      archive_path: null,
    });
    docker.poser("sans-image");
    expect((await appeler("GET", "/api/internal/sandboxes/health?image=x")).json()).toMatchObject({
      daemon_ok: true,
      image_loaded: false,
    });
    docker.poser("demon-ko");
    expect((await appeler("GET", "/api/internal/sandboxes/health?image=x")).json()).toMatchObject({
      daemon_ok: false,
      error: "Cannot connect to the Docker daemon",
    });
    expect((await appeler("GET", "/api/internal/sandboxes/health")).statusCode).toBe(422);
  });

  it("en marche : lignes brutes complétées à sept champs, lignes trop courtes ignorées, erreur de docker : aucune", async () => {
    etat("ps-netcfg.out", "elpis-sb-a\t1\ta\tnet\tspec\t1\tres\nmal\tformée\nelpis-sb-b\t2\tb\t\tspec\n");
    const r = await appeler("GET", "/api/internal/sandboxes/running");
    expect(r.json()).toEqual({
      containers: [
        ["elpis-sb-a", "1", "a", "net", "spec", "1", "res"],
        ["elpis-sb-b", "2", "b", "", "spec", "", ""],
      ],
    });
    etat("ps-netcfg.rc", "1");
    expect((await appeler("GET", "/api/internal/sandboxes/running")).json()).toEqual({ containers: [] });
  });

  it("conteneurs : compte relu par inspect, 502 avec le message de docker, 502 au délai dépassé", async () => {
    etat(
      "ps-a.out",
      '{"id":"a1","name":"elpis-sb-bob","image":"i","state":"running","status":"Up","created":"c"}\n' +
        '{"id":"b2","name":"elpis-sb-anon","image":"i","state":"exited","status":"Exited","created":"c"}\n',
    );
    etat("inspect-elpis-sb-bob.out", "3|bob\n");
    const r = await appeler("GET", "/api/internal/sandboxes/containers");
    expect(r.json()).toEqual({
      containers: [
        {
          id: "a1",
          name: "elpis-sb-bob",
          image: "i",
          state: "running",
          status: "Up",
          created: "c",
          user_id: 3,
          username: "bob",
        },
        {
          id: "b2",
          name: "elpis-sb-anon",
          image: "i",
          state: "exited",
          status: "Exited",
          created: "c",
          user_id: null,
          username: null,
        },
      ],
      count: 2,
    });
    etat("ps-a.rc", "1");
    etat("ps-a.err", "  erreur docker  \n");
    const refus = await appeler("GET", "/api/internal/sandboxes/containers");
    expect([refus.statusCode, refus.json()]).toEqual([502, { detail: "erreur docker" }]);
    delaisDocker.ps = 200;
    etat("ps-a.dort", "5");
    const lent = await appeler("GET", "/api/internal/sandboxes/containers");
    expect([lent.statusCode, lent.json()]).toEqual([502, { detail: "docker ps timeout" }]);
  });

  it("conteneurs : l'inspect d'un conteneur a un délai (démon figé), compte laissé inconnu", async () => {
    etat(
      "ps-a.out",
      '{"id":"a1","name":"elpis-sb-bob","image":"i","state":"running","status":"Up","created":"c"}\n',
    );
    delaisDocker.inspect = 200;
    etat("inspect-elpis-sb-bob.dort", "5");
    const r = await appeler("GET", "/api/internal/sandboxes/containers");
    expect(r.json()).toMatchObject({ count: 1, containers: [{ user_id: null, username: null }] });
  });
});

describe("arrêt, destruction et GC", () => {
  it("arrêt et destruction : conteneur du compte de l'enveloppe, nom assaini, résultat de docker ignoré", async () => {
    const hugo = entetes(7, "Hugo.Martin");
    expect((await appeler("POST", "/api/internal/sandboxes/stop", hugo)).json()).toEqual({ ok: true });
    expect((await appeler("POST", "/api/internal/sandboxes/destroy", hugo)).json()).toEqual({ ok: true });
    expect(docker.appels()).toEqual(["stop -t 5 elpis-sb-HugoMartin", "rm -fv elpis-sb-HugoMartin"]);
    const audit = readdirSync(path.join(tmp, "audit"))
      .map((f) => readFileSync(path.join(tmp, "audit", f), "utf-8"))
      .join("");
    expect(audit).toContain('"action":"admin.sandbox.destroy"');
    expect(audit).not.toContain('"action":"user.sandbox.destroy"');
  });

  it("sans binaire docker : arrêt et destruction répondent ok sans rien lancer", async () => {
    vi.stubEnv("PATH", path.join(tmp, "vide"));
    expect((await appeler("POST", "/api/internal/sandboxes/stop")).json()).toEqual({ ok: true });
    expect((await appeler("POST", "/api/internal/sandboxes/destroy")).json()).toEqual({ ok: true });
    expect(docker.appels()).toEqual([]);
  });

  it("l'arrêt attend le verrou de cycle de vie du compte", async () => {
    mkdirSync(path.join(tmp, "sb", ".lifecycle_locks"), { recursive: true });
    let libere = false;
    const tenu = avecVerrou(path.join(tmp, "sb", ".lifecycle_locks", "u7.lock"), {}, async () => {
      await new Promise((ok) => setTimeout(ok, 300));
      libere = true;
    });
    await new Promise((ok) => setTimeout(ok, 50));
    const r = await appeler("POST", "/api/internal/sandboxes/stop");
    expect([r.statusCode, libere]).toEqual([200, true]);
    await tenu;
    expect(docker.appels()).toEqual(["stop -t 5 elpis-sb-hugo"]);
  });

  it("GC : seuls les conteneurs dont /work et .bg sont inactifs sont arrêtés ; seuil nul : rien", async () => {
    etat("ps-noms.out", "elpis-sb-bob\nelpis-sb-carol\n  \nelpis-sb-x\n");
    etat("inspect-nom-elpis-sb-bob.out", "bob\n");
    etat("inspect-nom-elpis-sb-carol.out", "carol");
    etat("inspect-nom-elpis-sb-x.rc", "1");
    for (const [compte, date] of [
      ["bob", 4_000_000_000],
      ["carol", 1_000_000_000],
    ] as const) {
      const travail = path.join(tmp, "sb", compte, "work");
      mkdirSync(travail, { recursive: true });
      utimesSync(travail, date, date);
    }
    const r = await appeler("POST", "/api/internal/sandboxes/gc?idle_kill_hours=1");
    expect(r.json()).toEqual({ stopped: ["elpis-sb-carol"] });
    expect(docker.appels()).toContain("stop -t 5 elpis-sb-carol");
    expect(docker.appels()).not.toContain("stop -t 5 elpis-sb-bob");
    const avant = docker.appels().length;
    expect((await appeler("POST", "/api/internal/sandboxes/gc?idle_kill_hours=0")).json()).toEqual({
      stopped: [],
    });
    expect(docker.appels().length).toBe(avant);
  });

  it("GC : budget épuisé, plus aucun arrêt commencé, ce qui est arrêté est rendu", async () => {
    etat("ps-noms.out", "elpis-sb-bob\nelpis-sb-carol\n");
    for (const compte of ["bob", "carol"]) {
      etat(`inspect-nom-elpis-sb-${compte}.out`, compte);
      const travail = path.join(tmp, "sb", compte, "work");
      mkdirSync(travail, { recursive: true });
      utimesSync(travail, 1_000_000_000, 1_000_000_000);
    }
    delaisDocker.budgetGc = 0;
    const r = await appeler("POST", "/api/internal/sandboxes/gc?idle_kill_hours=1");
    expect(r.json()).toEqual({ stopped: [] });
    expect(docker.appels().some((a) => a.startsWith("stop "))).toBe(false);
  });
});
