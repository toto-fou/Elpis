# desktop-agent

A tiny cross-platform **control-agent** the chatbot drives over HTTP to *see* and
*act* on a desktop or VM. Pair it with a detection endpoint (the "annotation
model") and the chatbot's **Desktop** (`desktop_*`) tools + **Annotation Studio**.

- **Windows** — element tree via `pywinauto` (UI Automation), input via `pyautogui`.
- **Linux** — element tree via **AT-SPI** (`pyatspi`/PyGObject), input via `pyautogui`
  (X11) or `ydotool` (Wayland), screenshots via `mss`/`grim`.

It runs **on the target machine** and binds `0.0.0.0`. It is a full remote-control
surface (commands, files, input), so it is protected by a **shared token** and meant
for a trusted **local network** only: don't expose it to untrusted networks.

## Token (authentication)
Every request except `GET /health` must carry `Authorization: Bearer <token>`
(compared in constant time → `401` otherwise). The agent also refuses any request
with an `Origin` header (`403`, i.e. a web page in a browser) and any `POST`/`PUT`
whose `Content-Type` is not `application/json` (`415`).

- The token is read from `DESKTOP_AGENT_TOKEN`, else from `agent_token.txt` next to
  `server.py`. `install_agent.sh` and `run.ps1` generate that file on first run if
  both are missing, and print the token (`install_agent.ps1` prints it again).
- A `DESKTOP_AGENT_TOKEN` set at install time is written to `agent_token.txt` (the
  systemd unit and the Windows task do not forward the environment).
- **Updating without reinstalling.** If no token is configured and `agent_token.txt`
  does not exist, the agent generates it (mode 0600, next to `server.py`), logs the
  token once (`journalctl --user -u desktop-agent`) and starts requiring it: enter
  it on the Elpis side. Re-running `install_agent.sh` / `install_agent.ps1` prints it too.
- `DESKTOP_AGENT_INSECURE=1` starts without authentication (a warning is logged; any
  host of the network can then control the machine). Discouraged. Set at install
  time, it is written into the systemd unit (`Environment=`) or the Windows task.
- Elpis side: give the same token to the toolhost, either per machine (`agent_token`
  next to `agent_url` in `desktop.targets`, when supported) or through the
  `DESKTOP_AGENT_TOKEN` environment variable of the toolhost process.

## Install

### Linux
```bash
cd desktop-agent
bash install_agent.sh        # venv + deps (OFFLINE if wheels are bundled) + auto-start choice
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
| `DESKTOP_AGENT_TOKEN` | — (or `agent_token.txt`) | shared bearer token, required unless insecure mode |
| `DESKTOP_AGENT_INSECURE` | unset | `1` = start without a token (trusted network only) |
| `DESKTOP_AGENT_QUEUE_MAX` | `4` | UIA worker queue depth; beyond it, new UIA calls get `503` (agent busy) instead of piling up |
| `DESKTOP_AGENT_HUNG_AFTER_SEC` | `60` | if the current UIA op has run longer than this, new UIA calls fail fast with `503` |
| `DESKTOP_AGENT_OP_TIMEOUT_SEC` | `120` | server-side wait cap per UIA op (`/wait_*` and `/launch` use `timeout_ms + 10s`) |
| `DESKTOP_AGENT_EXIT_ON_HANG_SEC` | `0` (off) | if set, the agent process `exit(1)`s when an op stays stuck this long — see the warning below |

**UIA worker & hangs.** All UI Automation endpoints run on a single dedicated
worker thread (serialized, MTA-safe). This keeps `/health`, `/screenshot`,
`/monitors`, `/windows` responsive **even if a UIA op hangs** (an unresponsive
target app can block a UIA call for a long time). While an op is stuck, further
UIA calls return `503 agent occupé` ("agent busy", the message as the agent prints it); `GET /health` reports
`worker: {busy, op, busy_for_s, queue}` so you can see what's wedged.
A Python thread stuck inside a COM call **cannot be killed** — the fix is to
**restart the agent** (`run.bat` on Windows). The auto-start task only launches
the agent *at log on*, so it will **not** revive a process that died mid-session;
that is why `DESKTOP_AGENT_EXIT_ON_HANG_SEC` is **off by default** (enabling it
without a supervisor that relaunches would leave the VM with no agent).

Then in the chatbot: **Admin → Models & services → Vision & machines** (control agents, VM) add a
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
- **Windows** = scheduled task "at log on" (`schtasks /SC ONLOGON`).
- **Linux** = systemd **user** service (`~/.config/systemd/user/`, + lingering).
Non-interactive (piped) install: pass `DESKTOP_SERVICE=1` to enable it.
A *Windows service* / *systemd system service* can't drive the GUI (session-0 / no display).

## Notes
- Windows: must run in the **interactive** session — a Session-0 service sees a black screen.
- Wayland: synthetic input is often restricted; `/health` reports the live input impl. If it's `none`, the chatbot can still *observe* (screenshot + detection) but not *act*.

## Automation scripts (`elpis_auto`)

Elpis's **Studio** produces Python scripts that run **here, on the target
machine**, with no server and no network: they import `elpis_auto` (this folder)
and talk to the UIA/AT-SPI backends in process.

```
run-script.bat  mon_script.py --numero=42        # Windows (run.bat's venv)
./run-script.sh mon_script.py --numero=42        # Linux
```

* exit code: `0` ok, `1` a check failed, `2` execution error;
* report: `rapports/<script>-<timestamp>/rapport.json` + `rapport.html`,
  with the **anchoring method** used at each step and one PNG screenshot
  per failure;
* parameters: `--key=value`, or `ELPIS_PARAM_KEY` in the environment;
* a script that reads text on screen (vision/OCR) declares
  `Session(needs=["vision"])` and **refuses to start** without `ELPIS_URL` —
  these steps require Elpis's model.

```python
from elpis_auto import Session
s = Session(monitor=0)
s.launch("calc.exe", wait_window="Calculatrice")
s.click(auto_id="num7Button", name="Sept", role="button", at=(812, 640))
s.click(path="window:Calculatrice/group[2]/button[1]")   # control WITHOUT a name: path from a named ancestor
s.expect.value(auto_id="CalculatorResults", contains="7")
raise SystemExit(s.finish())
```

From the Studio, **Download** offers three forms: the **script alone**
(`.py`, when the agent — and so the runtime — is already on the machine), the
**script + runtime** (`.zip`: the `.py`, `elpis_auto/`, `backends/`,
`normalize.py`, `requirements.txt` without the HTTP server packages, `run.bat`
/ `run.sh` which create a local venv and install the dependencies on first
launch, `README.txt`) — for a standalone project or a machine without the agent —
and the **script + runtime + offline wheels** (`wheels/<os>`, cp311: Python
3.11 or the agent's `python-win\`) for a machine without internet. The script
runs **from the desktop** of the machine (an SSH session has no accessibility
tree); on Windows, full pywinauto requires the Visual C++
Redistributable (`mfc140u.dll`), otherwise the runtime clicks at the coordinates read
from the UIA tree.

Targeting, from most to least robust: `auto_id` → `path` (structural path
`#anchor` or `role:Name`, then `role[rank]`, strict then relaxed) → `name`
(+ `role`) → `near="Label"` (+ `side=`) → `image="assets/x.png"`
(thumbnail correlation, numpy) → `describe="…"` (Elpis vision, `ELPIS_URL`)
→ `window="#Win"` + `rel=(fx, fy)` → `at=(x, y)`. A target carries all its
identities at once; the report notes which one was used and, if it is not the
first, the line to fix ("repairs").

Default timeout: the Studio writes a variable at the top of the script, picked up by
everything that waits (`s.wait.*`, `s.expect.*`, `s.launch`) — and by the session, so
by a click that waits for its target:

```python
TIMEOUT = 30   # default timeout (s) for everything that waits; timeout=… on a line to change it
s = Session(monitor=1, timeout=TIMEOUT)
s.wait.window("project_test", timeout=TIMEOUT)
s.wait.window("QGIS", timeout=180)          # this step only: its own timeout
```

The Studio's "Timeout" field reads and rewrites `TIMEOUT`. A script that predates the variable
gets it as soon as an inserted line uses it (no `NameError`).

Waits: `Session(timeout=30, patience=120)` — `timeout` is a delay **with no
activity on screen**: as long as something moves (an application launching,
a project loading), the deadline moves back, up to `patience` s (`ELPIS_PATIENCE`).
A screen that stays still for `timeout` s is a real failure. Each wait,
check or action accepts its own `timeout=` (seconds) — the Studio
writes it on each inserted line (the palette's "Timeout" field); a
heavy application is tuned like this: `s.wait.window("QGIS", timeout=120)` or, for the whole
script, `Session(timeout=90, patience=300)`. `s.wait.seconds(20)` is a fixed
pause (reserve it for cases where nothing observable signals the end). A target
not found after the full wait raises `TargetNotFound` (a subclass of
`StepError`) with no implicit retry: the delay is no longer doubled; `retry=N` written
on the line is still honored, `retry=0` disables the session's retry. A gesture
partly sent (`PartialInput`) is never replayed. `s.launch(app,
wait_window="Title", timeout=T)` gives the launch only 5 s to see a
new window: it is the named wait that waits `T` (a single-instance app no longer costs
an extra `T`). Inside `with s.step(on_error="continue")`, only step
failures are swallowed; a script fault (`nam=`, invalid regex) is raised.

Window titles (`window=`, `wait.window`, `focus`, `close`, `require`): text
contained in the title, case ignored — parentheses and dots in a title
("Document (1).txt - Bloc-notes") are plain text; a real regex ("Calc.*")
is still accepted, inline flags included (`(?i)calc`). An empty title is refused
(`StepError`). `close` and `require(gone=…)` read the title as a regex only if it
contains one (`* + ? ^ $ | \ [ ] { }`): an absent "Document (1).txt" does not close
"Document 1.txt". Any space in the written title matches any whitespace (Notepad
titles "a - Bloc-notes" with a non-breaking space). As long as the target window is not open, a named
target is searched elsewhere only by its EXACT name (the wait continues instead of
clicking a partial namesake). An `auto_id` shared by several elements is
disambiguated by the recorded name and role. `window="Title"` on
an action brings the window to the foreground **if possible** (the "Program
Manager" desktop included) and is never a failure: the target is searched across the whole
screen. Without full pywinauto (`mfc140u.dll` missing), the agent still plays
Toggle / Select / Invoke through comtypes. Menu items go through a real
click (under Qt, Invoke does not open a menu); a double / triple click, a
right or middle click are always real gestures (never a Select or an Invoke in
their place), sent by SendInput to the CURRENT center of the re-resolved control — not
by pywinauto's `click_input`, which normalizes on the primary screen. Each click:
move, 30 ms hover, then press/release (40 ms between the two clicks of a
double). A single click on an element that exposes both a toggle and a
selection (checkable item) SELECTS it; only a checkbox or a toggle button is
toggled. A tree / list element that does NOT expose selection (a layer in
QGIS's Layers panel: Toggle only, and with no effect) gets a real
click at its center. `check`/`uncheck` re-read the state: if the toggle changed
nothing, a real click on the box (left edge of the row), then an explicit
"no effect" failure rather than a false success. Under Qt, a context menu is a
window of `menuitem` (no `menu` element): wait for an entry by its name.

Options: `python -m elpis_auto --dry-run | --trace | --repeat N | --data jeu.csv script.py`
(dry run, step-by-step trace in `rapport.html`, stability report `stabilite.html`,
one run per CSV row). `run.bat` launched by double-click keeps its
console open long enough to read the result. `s.require(window=…, launch=…)`,
`require(gone=…)`, `require(checked=…, …)` = preconditions. `lib/` next to the
script is importable (`from lib.x import …`).

From Elpis (agent launched by `run.bat`, hence in the interactive session):
`POST /put_file`, `GET /get_file`, `GET /list_files`, `POST /run_script`,
`GET /run_status`, `POST /run_stop` — bounded to `automations/`. This is what the
Studio's **Run** button and the `desktop_run_automation` tool use.
