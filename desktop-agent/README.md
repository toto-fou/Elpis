# desktop-agent

A tiny cross-platform **control-agent** the chatbot drives over HTTP to *see* and
*act* on a desktop or VM. Pair it with a detection endpoint (the "annotation
model") and the chatbot's **Bureau** (`desktop_*`) tools + **Annotation Studio**.

- **Windows** — element tree via `pywinauto` (UI Automation), input via `pyautogui`.
- **Linux** — element tree via **AT-SPI** (`pyatspi`/PyGObject), input via `pyautogui`
  (X11) or `ydotool` (Wayland), screenshots via `mss`/`grim`.

It runs **on the target machine**, binds `0.0.0.0`, and has **no auth** — intended
for a trusted **local network** only. It is a full remote-control surface, so
don't expose it to untrusted networks.

## Install

### Linux
```bash
cd desktop-agent
bash install_agent.sh        # venv + deps (HORS-LIGNE si wheels embarquées) + choix auto-démarrage
# accessibility tree (recommended): system packages
sudo apt install -y python3-gi gir1.2-atspi-2.0 at-spi2-core   # Debian/Ubuntu
gsettings set org.gnome.desktop.interface toolkit-accessibility true
# Wayland only: sudo apt install -y grim ydotool && sudo systemctl enable --now ydotoold
```

### Windows (in the logged-in interactive session)
**Fully offline & self-contained** when the bundle was produced with `fetch_offline_deps.sh`
(embeds a relocatable Python + all wheels). Just:
```
double-clic  run.bat
```
First launch (no internet): extracts the embedded Python (`python-win\`), creates a **real
venv** (`.venv`), installs the bundled wheels (`wheels\windows\`) — then runs. Next launches
relaunch instantly. For auto-start at logon, run `install_agent.ps1` once (registers a
scheduled task → `run.ps1 -Background`).

## Env
| var | default | meaning |
|-----|---------|---------|
| `DESKTOP_AGENT_HOST` | `0.0.0.0` | bind host |
| `DESKTOP_AGENT_PORT` | `8765`    | bind port |
| `DESKTOP_AGENT_QUEUE_MAX` | `4` | UIA worker queue depth; beyond it, new UIA calls get `503` (agent busy) instead of piling up |
| `DESKTOP_AGENT_HUNG_AFTER_SEC` | `60` | if the current UIA op has run longer than this, new UIA calls fail fast with `503` |
| `DESKTOP_AGENT_OP_TIMEOUT_SEC` | `120` | server-side wait cap per UIA op (`/wait_*` and `/launch` use `timeout_ms + 10s`) |
| `DESKTOP_AGENT_EXIT_ON_HANG_SEC` | `0` (off) | if set, the agent process `exit(1)`s when an op stays stuck this long — see the warning below |

**UIA worker & hangs.** All UI Automation endpoints run on a single dedicated
worker thread (serialized, MTA-safe). This keeps `/health`, `/screenshot`,
`/monitors`, `/windows` responsive **even if a UIA op hangs** (an unresponsive
target app can block a UIA call for a long time). While an op is stuck, further
UIA calls return `503 agent occupé`; `GET /health` reports
`worker: {busy, op, busy_for_s, queue}` so you can see what's wedged.
A Python thread stuck inside a COM call **cannot be killed** — the fix is to
**restart the agent** (`run.bat` on Windows). The auto-start task only launches
the agent *at log on*, so it will **not** revive a process that died mid-session;
that is why `DESKTOP_AGENT_EXIT_ON_HANG_SEC` is **off by default** (enabling it
without a supervisor that relaunches would leave the VM with no agent).

Then in the chatbot: **Admin → Vision & Desktop → Agents de contrôle (VM)** add a
target `{ name, os, agent_url: http://<vm-ip>:8765 }`. Verify with
`desktop_session(action="ping", target="<name>")` and watch the **Studio**.

## HTTP API
`GET /health` · `POST /screenshot` · `POST /ui_tree {max_nodes}` (nodes carry
`auto_id`; a window node carries its interaction state) ·
`POST /click {x,y,button,clicks}` · `POST /type {text}` · `POST /key {keys}` ·
`POST /scroll {x,y,dy}` · `POST /move {x,y}` · `POST /drag {x1,y1,x2,y2}`.

**Semantic (UI Automation, more reliable — Windows):**
`POST /invoke {auto_id,name,control_type,x,y}` (InvokePattern → click_input →
coords fallback) · `POST /set_value {auto_id,text}` (ValuePattern) ·
`POST /launch {target,args,timeout_ms}` (ShellExecute + **WaitForInputIdle**) ·
`POST /wait_window {title_re|auto_id|class_name,ready,timeout_ms}` (waits for
**ReadyForUserInteraction**) · `POST /wait_element {auto_id|name,state,timeout_ms}`.

Coordinates are native screen pixels. Unsupported ops (e.g. Wayland input
blocked, or AT-SPI lacking a pattern) return `501`.

## Offline (air-gapped) install
Run **once, on the SERVER (with internet)**: `bash fetch_offline_deps.sh` → it bundles into
the agent:
- **Windows**: a **relocatable full CPython** (`python-build-standalone`, with `venv`+`pip`)
  in `python-win/`, and **all** `cp311/win_amd64` wheels in `wheels/windows/` — including
  `pyautogui` & its permissive dependencies (no published wheels → built here as universal
  `py3-none-any`). `pyautogui` is installed with `--no-deps` (`requirements-*-nodeps.txt`):
  its GPL-3.0 dependencies `mouseinfo` and `pymsgbox` are optional imports (only
  `alert/confirm/prompt/password` and `mouseInfo()` need them, the agent uses none) and are
  never built nor installed. On Linux, `python-xlib` (LGPL) replaces `python3-Xlib` (GPL-2.0).
  The script **verifies the transitive closure** (Windows markers) and fails if anything is
  missing, so the shipped bundle is guaranteed to install with **NO internet**.
- **Linux** (best-effort): `cp311` manylinux wheels in `wheels/linux/`; AT-SPI stays a system
  package and `python3` is the host's.

On the target, **`run.bat`** does everything offline at first launch (extract Python → create
`.venv` → `pip install --no-index --find-links wheels\windows`) then runs; later launches are
instant. Overrides: `DESKTOP_PYVER`, `DESKTOP_PBS_TAG`, `DESKTOP_PBS_PYFULL`, `DESKTOP_PBS_URL`.

> The bundled venv is created **on the target** at first run (correct paths). If you later
> **move** the agent folder, delete `.venv` and run `run.bat` again to rebuild it.

## Auto-start (proposed by `install_agent.*`)
Runs in the **graphical session** (the only place GUI control works):
- **Windows** = scheduled task « at log on » (`schtasks /SC ONLOGON`).
- **Linux** = systemd **user** service (`~/.config/systemd/user/`, + lingering).
Non-interactive (piped) install: pass `DESKTOP_SERVICE=1` to enable it.
A *Windows service* / *systemd system service* can't drive the GUI (session-0 / no display).

## Notes
- Windows: must run in the **interactive** session — a Session-0 service sees a black screen.
- Wayland: synthetic input is often restricted; `/health` reports the live input impl. If it's `none`, the chatbot can still *observe* (screenshot + detection) but not *act*.

## Scripts d'automatisation (`elpis_auto`)

Le **Studio** d'Elpis produit des scripts Python qui s'exécutent **ici, sur la
machine cible**, sans serveur ni réseau : ils importent `elpis_auto` (ce dossier)
et parlent aux backends UIA/AT-SPI en process.

```
run-script.bat  mon_script.py --numero=42        # Windows (venv de run.bat)
./run-script.sh mon_script.py --numero=42        # Linux
```

* code de sortie : `0` ok, `1` une vérification a échoué, `2` erreur d'exécution ;
* rapport : `rapports/<script>-<horodatage>/rapport.json` + `rapport.html`,
  avec la **méthode d'ancrage** employée à chaque étape et une capture PNG
  par échec ;
* paramètres : `--cle=valeur`, ou `ELPIS_PARAM_CLE` en environnement ;
* un script qui lit du texte à l'écran (vision/OCR) déclare
  `Session(needs=["vision"])` et **refuse de démarrer** sans `ELPIS_URL` —
  ces étapes exigent le modèle d'Elpis.

```python
from elpis_auto import Session
s = Session(monitor=0)
s.launch("calc.exe", wait_window="Calculatrice")
s.click(auto_id="num7Button", name="Sept", role="button", at=(812, 640))
s.click(path="window:Calculatrice/group[2]/button[1]")   # contrôle SANS nom : chemin depuis un ancêtre nommé
s.expect.value(auto_id="CalculatorResults", contains="7")
raise SystemExit(s.finish())
```

Depuis le Studio, **Télécharger** propose trois formes : le **script seul**
(`.py`, quand l'agent — donc le runtime — est déjà sur la machine), le
**script + runtime** (`.zip` : le `.py`, `elpis_auto/`, `backends/`,
`normalize.py`, `requirements.txt` sans les paquets du serveur HTTP, `run.bat`
/ `run.sh` qui créent un venv local et installent les dépendances au premier
lancement, `README.txt`) — pour un projet à part ou une machine sans l'agent —
et le **script + runtime + wheels hors ligne** (`wheels/<os>`, cp311 : Python
3.11 ou `python-win\` de l'agent) pour une machine sans internet. Le script
se lance **depuis le bureau** de la machine (une session SSH n'a pas d'arbre
d'accessibilité) ; sous Windows, pywinauto complet demande le Visual C++
Redistributable (`mfc140u.dll`), sinon le runtime clique aux coordonnées lues
dans l'arbre UIA.

Ciblage, du plus robuste au moins : `auto_id` → `path` (chemin structurel
`#ancre` ou `role:Nom`, puis `rôle[rang]`, strict puis relâché) → `name`
(+ `role`) → `near="Libellé"` (+ `side=`) → `image="assets/x.png"`
(corrélation de vignette, numpy) → `describe="…"` (vision d'Elpis, `ELPIS_URL`)
→ `window="#Win"` + `rel=(fx, fy)` → `at=(x, y)`. Une cible porte toutes ses
identités à la fois ; le rapport note laquelle a servi et, si ce n'est pas la
première, la ligne à corriger (« réparations »).

Délai par défaut : le Studio écrit une variable en tête du script, reprise par
tout ce qui attend (`s.wait.*`, `s.expect.*`, `s.launch`) — et par la séance, donc
par un clic qui attend sa cible :

```python
TIMEOUT = 30   # délai par défaut (s) de tout ce qui attend ; timeout=… sur une ligne pour la changer
s = Session(monitor=1, timeout=TIMEOUT)
s.wait.window("project_test", timeout=TIMEOUT)
s.wait.window("QGIS", timeout=180)          # cette étape seulement : un délai propre
```

Le champ « Délai » du Studio lit et réécrit `TIMEOUT`. Un script d'avant la variable
la reçoit dès qu'une ligne insérée l'utilise (pas de `NameError`).

Attentes : `Session(timeout=30, patience=120)` — `timeout` est un délai **sans
activité à l'écran** : tant que quelque chose bouge (application qui se lance,
projet qui se charge), l'échéance recule, jusqu'à `patience` s (`ELPIS_PATIENCE`).
Un écran immobile pendant `timeout` s est un vrai échec. Chaque attente,
vérification ou action accepte son propre `timeout=` (secondes) — le Studio
l'écrit sur chaque ligne insérée (champ « Délai » de la palette) ; une appli
lourde se règle ainsi : `s.wait.window("QGIS", timeout=120)` ou, pour tout le
script, `Session(timeout=90, patience=300)`. `s.wait.seconds(20)` est une pause
fixe (à réserver aux cas où rien d'observable ne signale la fin). Une cible
introuvable après l'attente complète lève `TargetNotFound` (sous-classe de
`StepError`) sans réessai implicite : le délai n'est plus doublé ; `retry=N` écrit
sur la ligne reste honoré, `retry=0` désactive le réessai de la séance. Un geste
envoyé en partie (`PartialInput`) n'est jamais rejoué. `s.launch(app,
wait_window="Titre", timeout=T)` ne laisse au lancement que 5 s pour voir une
nouvelle fenêtre : c'est l'attente nommée qui patiente `T` (une appli à instance
unique ne coûte plus `T` de plus). Dans `with s.step(on_error="continue")`, seuls
les échecs d'étape sont avalés ; une faute du script (`nam=`, regex invalide) est levée.

Titres de fenêtre (`window=`, `wait.window`, `focus`, `close`, `require`) : texte
contenu dans le titre, casse ignorée — les parenthèses et les points d'un titre
(« Document (1).txt - Bloc-notes ») sont du texte ; une vraie regex (« Calc.* »)
reste acceptée, drapeaux en ligne compris (`(?i)calc`). Un titre vide est refusé
(`StepError`). `close` et `require(gone=…)` ne lisent le titre comme regex que s'il
en contient une (`* + ? ^ $ | \ [ ] { }`) : « Document (1).txt » absent ne ferme
pas « Document 1.txt ». Toute espace du titre écrit reconnaît n'importe quel blanc (le
Bloc-notes titre « a\u00a0- Bloc-notes » avec une espace insécable). Tant que la fenêtre visée n'est pas ouverte, une cible nommée
n'est cherchée ailleurs que par son nom EXACT (l'attente continue au lieu de
cliquer un homonyme partiel). Un `auto_id` partagé par plusieurs éléments est
départagé par le nom et le rôle enregistrés. `window="Titre"` sur
une action met la fenêtre au premier plan **si possible** (le bureau « Program
Manager » compris) et n'est jamais une panne : la cible est cherchée sur tout
l'écran. Sans pywinauto complet (`mfc140u.dll` absent), l'agent joue quand même
Toggle / Select / Invoke par comtypes. Les éléments de menu passent par un vrai
clic (sous Qt, Invoke n'ouvre pas un menu) ; un double / triple clic, un clic
droit ou milieu sont toujours de vrais gestes (jamais un Select ou un Invoke à
leur place), envoyés par SendInput au centre COURANT du contrôle re-résolu — pas
par `click_input` de pywinauto, qui normalise sur l'écran principal. Chaque clic :
déplacement, 30 ms de survol, puis appui/relâche (40 ms entre deux clics d'un
double). Un clic simple sur un élément qui expose à la fois une bascule et une
sélection (item cochable) le SÉLECTIONNE ; seule une case à cocher ou un bouton
bascule est basculé. Un élément d'arbre / de liste qui n'expose PAS la sélection
(couche du panneau Couches de QGIS : Toggle seul, et sans effet) reçoit un vrai
clic à son centre. `check`/`uncheck` relisent l'état : si la bascule n'a rien
changé, vrai clic sur la case (bord gauche de la ligne), puis échec explicite
« sans effet » plutôt qu'un faux succès. Sous Qt, un menu contextuel est une
fenêtre de `menuitem` (aucun élément `menu`) : attendre une entrée par son nom.

Options : `python -m elpis_auto --dry-run | --trace | --repeat N | --data jeu.csv script.py`
(vol à blanc, trace pas à pas dans `rapport.html`, stabilité `stabilite.html`,
une exécution par ligne de CSV). `run.bat` lancé par double-clic garde sa
console ouverte le temps de lire le résultat. `s.require(window=…, launch=…)`,
`require(gone=…)`, `require(checked=…, …)` = préconditions. `lib/` à côté du
script est importable (`from lib.x import …`).

Depuis Elpis (agent lancé par `run.bat`, donc dans la session interactive) :
`POST /put_file`, `GET /get_file`, `GET /list_files`, `POST /run_script`,
`GET /run_status`, `POST /run_stop` — bornés à `automations/`. C'est ce que le
bouton **Exécuter** du Studio et l'outil `desktop_run_automation` utilisent.

