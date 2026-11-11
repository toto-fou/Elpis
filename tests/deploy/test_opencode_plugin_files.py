# SPDX-License-Identifier: MIT
"""tests/deploy/test_opencode_plugin_files.py — artefacts du plugin elpis-remote.

Le plugin vit dans ``apps/core/greffon-opencode/`` : ``elpis-remote.ts``
(canonique, TypeScript chargé nativement par opencode/Bun) et
``elpis-remote-bootstrap.js`` (shim de migration servi à /api/code/plugin.js
pour le « /remote update » des anciens plugins ≤ v8). Ici : cohérence des
marqueurs/versions, validité JS du shim (node --check), et run RÉEL de
l'installeur bash (curl stubé) pour le choix y/N du plugin.

Le smoke COMPORTEMENTAL (faux serveur + faux client opencode, sous Bun) est à
part : ``tests/opencode_plugin/smoke.ts`` (voir son README — Bun absent des VM
offline, donc hors pytest).
"""
from __future__ import annotations

import contextlib
import json
import os
import re
import shutil
import subprocess
import time
from pathlib import Path
from unittest import mock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

REPO = Path(__file__).resolve().parents[2]
PLUGIN_DIR = REPO / "apps" / "core" / "greffon-opencode"
TS = (PLUGIN_DIR / "elpis-remote.ts").read_text(encoding="utf-8")
SHIM = (PLUGIN_DIR / "elpis-remote-bootstrap.js").read_text(encoding="utf-8")


def test_ts_is_erasable_typescript_only():
    # opencode/Bun strippe les types ; on s'interdit les syntaxes NON erasables
    # (enum/namespace/decorators/param properties) pour rester compatible avec
    # tout futur strip-types (Node 22+, esbuild…).
    for forbidden in ("\nenum ", "\nnamespace ", "\n@", "declare module"):
        assert forbidden not in TS, forbidden


def test_shim_downloads_canonical_and_self_deletes():
    assert "/api/code/plugin.ts" in SHIM
    assert "rmQuiet(JS_PATH)" in SHIM          # s'efface après migration
    assert "tsAlreadyThere" in SHIM            # jamais 2 instances dans un run
    assert "__APP_URL__" in SHIM               # substitué au service


# ── Store de conf : portée MACHINE vs INSTANCE, écriture concurrente-sûre ────
# elpis-remote.json est PARTAGÉ par tous les opencode d'un même utilisateur.
# Deux invariants à ne jamais reperdre :
#   • `enabled` est PAR PROJET (sinon /remote off dans un projet coupe les
#     autres, et une reprise auto en réveille qui ne devraient pas l'être) ;
#   • toute écriture est un read-modify-write (sinon un process écrase le jeton
#     qu'un voisin vient d'appairer, ou l'état d'un autre projet).

_CONF_REGION = re.search(
    r"// #region conf-store[^\n]*\n(.*?)// #endregion conf-store", TS, re.S)

# Annotations TS présentes dans la région, à effacer pour exécuter sous Node 20
# (pas de --experimental-strip-types avant Node 22, ni bun/tsc sur les VM
# offline). Si un nouveau type apparaît, `node --check` casse le test avec un
# message clair — étendre cette table plutôt que contourner.
_TS_STRIPS = (
    ("(): RemoteConf =>", "() =>"),
    ("(c: RemoteConf): void =>", "(c) =>"),
    ("(fn: (c: RemoteConf) => void): RemoteConf =>", "(fn) =>"),
    ("(c: RemoteConf, key: string): boolean =>", "(c, key) =>"),
    ("(directory: string): string =>", "(directory) =>"),
    ("(dir: string, n: number): string =>", "(dir, n) =>"),
    ("(key: string, patch: InstanceConf): void =>", "(key, patch) =>"),
    ("(key: string): void =>", "(key) =>"),
    ("(pid?: number): boolean =>", "(pid) =>"),
    (" as RemoteConf", ""),
)


def _conf_store_js() -> str:
    assert _CONF_REGION, "région conf-store absente de elpis-remote.ts"
    src = _CONF_REGION.group(1)
    for a, b in _TS_STRIPS:
        src = src.replace(a, b)
    return src


def test_conf_store_region_exists_and_is_self_contained():
    src = _conf_store_js()
    # la région doit rester PURE : rien du corps du plugin (client, toasts, état)
    for leak in ("client.", "toast(", "enabled =", "appBase("):
        assert leak not in src, f"fuite du corps du plugin dans conf-store : {leak}"
    assert "renameSync" in src            # remplacement atomique
    assert "process.pid" in src           # tmp par process : pas de collision
    assert "instances" in src


def test_ts_never_writes_conf_wholesale():
    # Régression v9 : `saveConf(conf)` réécrivait TOUT le fichier depuis un objet
    # en mémoire potentiellement périmé. Seul mutateConf a le droit d'écrire.
    # (Le mot peut subsister dans un commentaire d'historique — on interdit les
    # APPELS, pas la mention.)
    assert "saveConf(" not in TS
    assert TS.count("fs.writeFileSync(tmp") == 1
    # le flag global legacy est LU (repli de migration) mais jamais réécrit
    assert "c.enabled =" not in TS and "conf.enabled =" not in TS


@pytest.mark.skipif(shutil.which("node") is None, reason="node absent")
def _run_conf_store(tmp_path: Path, script: str) -> dict:
    """Exécute la VRAIE région conf-store sous Node, sur un HOME jetable."""
    home = tmp_path / "home"
    (home / ".config" / "opencode").mkdir(parents=True, exist_ok=True)
    harness = (
        'import fs from "node:fs";\n'
        'import os from "node:os";\n'
        'import path from "node:path";\n'
        f'const CONF_PATH = {json.dumps(str(home / ".config" / "opencode" / "elpis-remote.json"))};\n'
        + _conf_store_js()
        + "\n" + script + "\n"
    )
    p = tmp_path / "confstore.mjs"
    p.write_text(harness, encoding="utf-8")
    r = subprocess.run(["node", str(p)], capture_output=True, text=True, timeout=30)
    assert r.returncode == 0, r.stderr
    return json.loads(r.stdout or "{}")


@pytest.mark.skipif(shutil.which("node") is None, reason="node absent")
def test_conf_store_is_valid_js_after_strip(tmp_path):
    _run_conf_store(tmp_path, 'console.log(JSON.stringify({ok: true}));')


@pytest.mark.skipif(shutil.which("node") is None, reason="node absent")
def test_enabled_is_per_project(tmp_path):
    out = _run_conf_store(tmp_path, """
      mutateConf((c) => { c.token = "pcr_x"; });
      const A = claimInstanceSlot("/home/u/projA"), B = claimInstanceSlot("/home/u/projB");
      writeInstance(A, { enabled: true });
      writeInstance(B, { enabled: false });
      const c = loadConf();
      console.log(JSON.stringify({
        a: instanceEnabled(c, A), b: instanceEnabled(c, B), token: c.token, A, B,
      }));
    """)
    assert out["a"] is True and out["b"] is False and out["token"] == "pcr_x"
    # deux répertoires = deux slots « premiers », sans suffixe
    assert out["A"] == "/home/u/projA" and out["B"] == "/home/u/projB"


@pytest.mark.skipif(shutil.which("node") is None, reason="node absent")
def test_legacy_global_enabled_is_the_default_until_project_is_set(tmp_path):
    # Poste v9 qui marchait (enabled global true) : la MAJ du plugin ne doit pas
    # débrancher la reprise auto… mais un /remote off ciblé doit primer.
    out = _run_conf_store(tmp_path, """
      fs.writeFileSync(CONF_PATH, JSON.stringify({ token: "t", enabled: true }));
      const A = claimInstanceSlot("/projA"), B = claimInstanceSlot("/projB");
      const before = instanceEnabled(loadConf(), A);
      writeInstance(A, { enabled: false });
      const c = loadConf();
      console.log(JSON.stringify({
        before, a: instanceEnabled(c, A), b: instanceEnabled(c, B),
        legacyKept: c.enabled,
      }));
    """)
    assert out == {"before": True, "a": False, "b": True, "legacyKept": True}


@pytest.mark.skipif(shutil.which("node") is None, reason="node absent")
def test_concurrent_writers_do_not_clobber(tmp_path):
    # Le scénario exact du bug : le process B tient un `conf` chargé AVANT que le
    # process A n'appaire un jeton. Sans read-modify-write, l'écriture de B
    # (son propre enabled) effaçait le jeton tout juste posé par A.
    out = _run_conf_store(tmp_path, """
      const staleB = loadConf();                 // B a lu le fichier vide
      mutateConf((c) => { c.token = "pcr_appaire_par_A"; });   // A appaire
      const B = claimInstanceSlot("/projB");
      writeInstance(B, { enabled: true });                    // B écrit ensuite
      const c = loadConf();
      console.log(JSON.stringify({
        staleHadToken: !!staleB.token,
        token: c.token,
        b: instanceEnabled(c, B),
      }));
    """)
    assert out == {"staleHadToken": False, "token": "pcr_appaire_par_A", "b": True}


@pytest.mark.skipif(shutil.which("node") is None, reason="node absent")
def test_instances_map_is_bounded(tmp_path):
    out = _run_conf_store(tmp_path, """
      // pid: 0 = slot libéré (mort) — seuls ceux-là sont éligibles au bornage
      for (let i = 0; i < 60; i++) writeInstance("/p" + i, { enabled: true, pid: 0 });
      const c = loadConf();
      const keys = Object.keys(c.instances);
      console.log(JSON.stringify({ n: keys.length, hasLast: keys.includes("/p59") }));
    """)
    assert out["n"] == 50 and out["hasLast"] is True


@pytest.mark.skipif(shutil.which("node") is None, reason="node absent")
def test_shim_is_valid_esm_javascript(tmp_path):
    # le shim ATTERRIT dans elpis-remote.js chez les clients v8 : il doit rester
    # du JS pur (une annotation TS le casserait au chargement par Bun en .js)
    p = tmp_path / "shim.mjs"
    p.write_text(SHIM.replace("__APP_URL__", "http://lan.test:8000"), encoding="utf-8")
    subprocess.run(["node", "--check", str(p)], check=True, capture_output=True)


# ── Installeur bash : run RÉEL avec curl stubé (réseau/binaire simulés) ──────

_FAKE_CURL = r"""#!/usr/bin/env bash
# stub curl : sert les endpoints attendus par install.sh (offline, via fichiers)
out=""; url=""; head=""; hdr=""
args=("$@")
for ((i=0; i<${#args[@]}; i++)); do
  a="${args[$i]}"
  case "$a" in
    -o) out="${args[$((i+1))]}" ;;
    -H) hdr="$hdr ${args[$((i+1))]}" ;;
    --head|-I) head=1 ;;
    http*|https*) url="$a" ;;
  esac
done
# Sonde « ce poste reconnaît-il déjà le certificat de l'app ? » : par défaut NON
# (c'est le cas qui nous intéresse — CA pas encore installée). FAKE_TRUSTED=1
# rejoue le poste déjà configuré, où le script ne doit RIEN réinstaller.
case "$url" in
  *"/api/public-config"*)
    if [ -n "$head" ] && [ -z "${FAKE_TRUSTED:-}" ]; then exit 60; fi ;;
esac
case "$url" in
  *"/api/cli/bundle/"*)      printf 'FAKE-OPENCODE-BINARY' > "$out" ;;
  # Config : anonyme → {} ; AVEC le jeton du compte (x-elpis-token) et
  # FAKE_MCP=1 → le serveur y ajoute le bloc mcp des outils Elpis.
  *"/api/cli/opencode.json"*)
      printf '%s\n' "$hdr" >> "${FAKE_CFG_LOG:-/dev/null}"
      case "$hdr" in
        *x-elpis-token:*) if [ -n "${FAKE_MCP:-}" ]; then printf '{"mcp":{"elpis-tools":{"url":"x"}}}' > "$out"; else printf '{}' > "$out"; fi ;;
        *) printf '{}' > "$out" ;;
      esac ;;
  *"/api/code/plugin.ts"*)   printf '// elpis-remote\nconst PLUGIN_VERSION = 9;\n' > "$out" ;;
  # PEM RÉALISTE : l'installeur vérifie le marqueur « BEGIN CERTIFICATE » avant
  # d'épingler quoi que ce soit (un proxy captif renvoie du HTML en 200, et
  # l'épingler casserait tout le TLS ensuite). ``FAKE_CA_JUNK`` rejoue ce cas.
  *"/ca.crt"*)               [ -n "${FAKE_CA:-}" ] || exit 22
                             if [ -n "${FAKE_CA_JUNK:-}" ]; then
                               printf '<html>portail captif</html>' > "$out"
                             else
                               printf -- '-----BEGIN CERTIFICATE-----\nRkFLRQ==\n-----END CERTIFICATE-----\n' > "$out"
                             fi ;;
  # ── Connexion au compte (login-lite → cookie → jeton) ──
  # Le corps JSON arrive par STDIN (--data @-) : jamais en argument.
  *"/api/login-lite"*)
      body="$(cat)"
      printf '%s' "$body" >> "${FAKE_LOGIN_LOG:-/dev/null}"
      case "$body" in
        *'"username":"alice"'*'"password":"bonmdp"'*) exit 0 ;;
        *) exit 22 ;;                       # 401 → curl -f rend 22
      esac ;;
  # EXT.1 : la config ne rend plus de jeton ; le jeton du poste est CRÉÉ
  # (POST /api/code/token, nommé d'après la machine) et montré une fois.
  *"/api/code/config"*)      printf '{"app_url":"x","tokens":0}' ;;
  *"/api/code/token"*)       printf '%s\n' "$*" >> "${FAKE_TOKEN_LOG:-/dev/null}"
                             printf '{"token":"pcr_par_login"}' ;;
  *) [ -n "$out" ] && : > "$out" ;;
esac
exit 0
"""


# ── Amorçage en clair : la CA locale est épinglée pour le plugin ─────────────
# La commande copiée par l'utilisateur passe par http://<ip>/opencode (Caddy
# :80) — donc AUCUN TLS à contourner pour l'amorçage. Mais l'app, elle, écoute
# en https : le script doit récupérer la CA (servie en clair sur /ca.crt) et
# l'épingler dans elpis-remote.json, sinon le plugin retombe en non vérifié.

def _remote_conf(tmp_path: Path) -> dict:
    p = tmp_path / "home" / ".config" / "opencode" / "elpis-remote.json"
    return json.loads(p.read_text(encoding="utf-8"))


# ── Connexion au compte DEPUIS L'INSTALLEUR ─────────────────────────────────
# Pourquoi ici et pas dans /remote : l'API plugin d'opencode n'expose aucune
# primitive de saisie, donc un mot de passe passé à la commande slash serait
# affiché dans le TUI et conservé dans son historique. L'installeur, lui, a un
# vrai terminal → frappe masquée (stty -echo). Ces tests tournent donc sous PTY.


def _remote_json(tmp_path: Path) -> dict:
    return json.loads((tmp_path / "home" / ".config" / "opencode"
                       / "elpis-remote.json").read_text(encoding="utf-8"))


# ── Sémantique de /remote et des commandes visant la CLI ────────────────────
# Symptômes rapportés : (a) « /remote » sur une 2e instance répondait « Remote
# désactivé » alors que la session s'activait ; (b) /exit tuait le serveur sous
# un TUI vivant, et /new annonçait « ouverte ici » même quand le TUI n'avait pas
# basculé — d'où l'impression d'un opencode qui tourne en arrière-plan.

def test_remote_activates_and_never_toggles_off():
    # La reprise auto remet `enabled` à true SANS le dire : en bascule, /remote
    # coupait donc au moment où l'utilisateur voulait activer.
    assert 'if (enabled && !arg) { stop();' not in TS
    branch = TS.split('} else if (!arg || arg === "on") {', 1)[1].split("} else {", 1)[0]
    assert "déjà actif" in branch                  # message honnête
    assert "snapshot(input.sessionID)" in branch   # et la session est publiée
    assert "stop()" not in branch                  # /remote n'éteint plus jamais
    # couper reste possible, explicitement
    assert 'arg === "off"' in TS


def test_two_live_processes_in_the_same_dir_get_distinct_slots(tmp_path):
    out = _run_conf_store(tmp_path, """
      // process 1 (nous) prend le 1er slot et l'active
      const A = claimInstanceSlot("/w/proj");
      writeInstance(A, { enabled: true });
      // process 2 : on simule un VOISIN VIVANT en plaçant notre propre pid sur
      // le slot 1 (pidAlive(process.pid) === true), puis on re-réclame.
      const B = claimInstanceSlot("/w/proj");
      const c = loadConf();
      console.log(JSON.stringify({
        A, B,
        aEnabled: instanceEnabled(c, A),
        bEnabled: instanceEnabled(c, B),
      }));
    """)
    assert out["A"] == "/w/proj"
    assert out["B"] == "/w/proj#2", out          # slot distinct
    assert out["aEnabled"] is True
    # un slot supplémentaire démarre ÉTEINT : sinon on recrée le couplage
    assert out["bEnabled"] is False


def test_dead_slot_is_reclaimed_and_keeps_its_setting(tmp_path):
    # Redémarrage : le pid d'avant est mort → on REPREND le slot 1 (pas #2) et
    # son `enabled` est conservé (c'est la reprise auto attendue).
    out = _run_conf_store(tmp_path, """
      fs.writeFileSync(CONF_PATH, JSON.stringify({
        token: "t",
        instances: { "/w/proj": { enabled: true, pid: 999999, dir: "/w/proj" } },
      }));
      const K = claimInstanceSlot("/w/proj");
      const c = loadConf();
      console.log(JSON.stringify({
        K, enabled: instanceEnabled(c, K), pid: c.instances[K].pid, mine: process.pid,
      }));
    """)
    assert out["K"] == "/w/proj"                  # slot repris, pas un nouveau
    assert out["enabled"] is True                 # réglage conservé
    assert out["pid"] == out["mine"]              # occupé par nous


def test_released_slot_is_reusable_without_losing_its_setting(tmp_path):
    out = _run_conf_store(tmp_path, """
      const A = claimInstanceSlot("/w/proj");
      writeInstance(A, { enabled: true });
      releaseInstanceSlot(A);                     // sortie propre (dispose)
      const after = loadConf().instances[A];
      const B = claimInstanceSlot("/w/proj");     // relance : même slot
      console.log(JSON.stringify({
        freedPid: after.pid, keptEnabled: after.enabled,
        B, enabled: instanceEnabled(loadConf(), B),
      }));
    """)
    assert out["freedPid"] == 0 and out["keptEnabled"] is True
    assert out["B"] == "/w/proj" and out["enabled"] is True


def test_trim_never_evicts_a_live_slot(tmp_path):
    # Le bornage ne doit pas libérer le slot d'un process vivant.
    out = _run_conf_store(tmp_path, """
      const live = claimInstanceSlot("/w/live");
      for (let i = 0; i < 60; i++) writeInstance("/w/dead" + i, { pid: 0 });
      const c = loadConf();
      console.log(JSON.stringify({
        stillThere: !!c.instances[live],
        livePid: c.instances[live] ? c.instances[live].pid : null,
        mine: process.pid,
        total: Object.keys(c.instances).length,
      }));
    """)
    assert out["stillThere"] is True
    assert out["livePid"] == out["mine"]
    assert out["total"] <= 50


def test_snapshot_failure_does_not_blacklist_the_session():
    # Régression : sur échec transitoire la session restait marquée
    # « snapshottée » et n'était jamais republiée de tout le run.
    body = TS.split("const snapshot = ", 1)[1].split("const sessionHasMessages", 1)[0]
    catch_part = body.split("} catch {", 1)[1]
    assert "snapshotted.delete(sid)" in catch_part


def test_auto_resume_announces_the_new_client():
    # start() et la reprise auto doivent passer par la MÊME annonce : sans elle,
    # un opencode redémarré n'existait pour l'app qu'au premier long-poll.
    assert "const announce = (" in TS
    resume = TS.split("if (instanceEnabled(conf, instKey) && conf.token)", 1)[1].split("}", 1)[0]
    assert "announce()" in resume
    start_body = TS.split("const start = (", 1)[1].split("const activate", 1)[0]
    assert "announce()" in start_body
    # plus de duplication de l'ingest d'annonce
    assert TS.count('"/api/code/ingest", { method: "POST",') == 1


def test_remote_when_already_active_reannounces_and_is_honest():
    branch = TS.split('} else if (!arg || arg === "on") {', 1)[1].split("} else {", 1)[0]
    assert "announce()" in branch                       # l'action sert à quelque chose
    assert "sessionExists(input.sessionID)" in branch
    # message honnête quand opencode n'a pas encore de session à publier
    assert "premier message" in branch


def test_activation_message_does_not_promise_an_unpublished_session():
    act = TS.split("const activate = ", 1)[1].split("const stop = ", 1)[0]
    # on teste l'EXISTENCE de la session, pas ses messages : `input.sessionID`
    # est fourni même quand opencode n'a encore rien matérialisé
    assert "sessionExists" in act
    assert "premier message" in act                  # explique le cas irréductible
    # les 3 sites d'activation passent par le helper (plus de message figé)
    assert TS.count("await activate(") == 3
    assert "— session visible dans la page Remote code.\"; }" not in TS


def test_tui_is_driven_through_publish_not_execute_command():
    # ⚠ `selectSession` EXISTE (POST /tui/select-session {sessionID}, vérifié sur
    # l'OpenAPI de 1.17.7 ET 1.18.16) — l'affirmation inverse des versions ≤ v12
    # est ce qui rendait « Nouvelle session » inutilisable. Il est donc utilisé,
    # mais en appel FACULTATIF (un serve headless n'a aucun TUI au bout).
    assert "selectSession" in TS
    assert "client.tui.executeCommand" not in TS     # mesuré inerte
    body = TS.split("const tuiCommand = ", 1)[1].split("const toast = ", 1)[0]
    assert "client.tui.publish" in body
    assert '"tui.command.execute"' in body


def test_new_creates_the_session_then_switches_the_tui():
    """« Nouvelle session » doit produire quelque chose de VISIBLE.

    `session.new` du TUI ne matérialise rien (opencode crée la session au premier
    message, mesuré 1.17.7 et 1.18.16) : la page restait vide, d'où le « /new ne
    fait rien ». v13 crée la session par l'API — donc elle existe et se publie —
    puis bascule le TUI dessus via `tui.selectSession` (qui existe bel et bien).
    """
    new_branch = TS.split('action === "new"', 1)[1].split('action === "delete"', 1)[0]
    code = "\n".join(l for l in new_branch.splitlines() if not l.strip().startswith("//"))
    assert "client.session.create" in code
    assert "selectSession" in code
    assert "snapshot(created)" in code               # visible sans attendre l'event
    assert "session_new" not in code                 # clé de keybind, pas commande
    # le raccourci TUI reste le REPLI quand la création échoue — jamais les deux
    # (sinon deux sessions pour un seul clic)
    assert 'tuiCommand("session.new")' in code
    assert code.index("client.session.create") < code.index('tuiCommand("session.new")')


def test_exit_uses_a_signal_because_no_tui_exit_command_exists():
    exit_branch = TS.split('c.kind === "exit"', 1)[1].split("}\n        }", 1)[0]
    code = "\n".join(l for l in exit_branch.splitlines() if not l.strip().startswith("//"))
    assert "app_exit" not in code                    # n'existe pas dans l'enum
    assert "SIGTERM" in code
    assert code.index("SIGTERM") < code.rindex("process.exit(0)")


def test_empty_sessions_are_published_and_deduped_upstream():
    """v13 : le greffon publie AUSSI les sessions vides.

    La règle inverse (v≤12) évitait des entrées fantômes au redémarrage, mais
    produisait pire : une session fraîche restait invisible pendant que la page
    affichait « CLI connectée ». Le fantôme se traite désormais côté app.
    """
    body = TS.split("const snapshot = ", 1)[1].split("const sessionExists", 1)[0]
    assert "if (!msgs.length)" not in body            # plus de rétention
    assert "allowEmpty" not in TS                     # ni exception ponctuelle
    # un échec transitoire doit toujours rendre la session republiable
    assert "snapshotted.delete(sid)" in body


def test_question_kind_is_forwarded_and_answered_through_the_inner_client():
    # v14 : l'outil `question` BLOQUE le tour jusqu'à la réponse ; les 3 events
    # sont remontés et la page répond via le kind "question" (reply | reject).
    fwd = TS.split("const FORWARD = new Set<string>([", 1)[1].split("]);", 1)[0]
    for ev in ("question.asked", "question.replied", "question.rejected"):
        assert f'"{ev}"' in fwd, ev
    assert 'c.kind === "question"' in TS
    body = TS.split("const answerQuestion = ", 1)[1].split("// au démarrage, command.list()", 1)[0]
    # ⚠ le SDK v1 reçu par les plugins (1.17.7 ET 1.18.16) n'a PAS de ressource
    # `question` : le chemin réel est le client HTTP interne des méthodes
    # générées (fonctionne aussi sans port, via le fetch in-process) ; SDK
    # futur d'abord, fetch brut sur serverUrl en dernier recours.
    assert "client.question" in body
    assert "client._client" in body and 'raw.post({' in body
    assert "serverUrl" in body
    assert '"/question/{requestID}/" + verb' in body
    # un client hey-api ne throw PAS sur 4xx/5xx : {error} doit devenir un échec
    # (sinon la page croirait la réponse livrée et la CLI resterait bloquée)
    assert body.count("failedHttp(r)") >= 2
    # le refus part sans body (`/reject`), la réponse avec {answers}
    assert 'answers ? "reply" : "reject"' in body
    # la commande est refusée si ni réponses ni refus (jamais un appel à vide)
    guard = TS.split('c.kind === "question"', 1)[1].split("{", 1)[0]
    assert "Array.isArray(c.answers)" in guard and 'c.response === "reject"' in guard


def test_markers_and_versions_in_sync():
    # startsWith("// elpis-remote") + regex PLUGIN_VERSION : les DEUX flux
    # update (v8 → plugin.js, v9 → plugin.ts) valident la réponse ainsi.
    assert TS.startswith("// elpis-remote")
    assert SHIM.startswith("// elpis-remote")
    vts = re.search(r"const PLUGIN_VERSION = (\d+)", TS)
    vjs = re.search(r"const PLUGIN_VERSION = (\d+)", SHIM)
    assert vts and vjs and vts.group(1) == vjs.group(1)
