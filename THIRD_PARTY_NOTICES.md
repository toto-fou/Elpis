# Third-party notices / Composants tiers

Elpis itself is licensed under the MIT License (see `LICENSE`).
This file lists the third-party components that are **bundled in this
repository** (vendored front-end files), then the dependencies that
`./install.sh` **downloads and installs** (not redistributed here), and
finally the **optional** dependencies under copyleft licenses.

Each bundled file keeps its original copyright header when the upstream
distribution ships one. The license texts of the bundled components, with
their copyright notices, are reproduced in [`LICENSES/`](LICENSES/) (one
file per component, named after the upstream package).

---

## 1. Bundled components (vendored)

### `frontend/vendor/`

| Component | Version | License | Files | Upstream |
|---|---|---|---|---|
| Vue.js | 3.5.27 | MIT | `vue.global.prod.js` | https://github.com/vuejs/core |
| marked | 15.0.12 | MIT | `marked.min.js` | https://github.com/markedjs/marked |
| DOMPurify | 3.1.6 | Apache-2.0 OR MPL-2.0 | `purify.min.js` | https://github.com/cure53/DOMPurify |
| highlight.js | 11.7.0 | BSD-3-Clause | `highlight.min.js`, `github-dark.min.css` | https://github.com/highlightjs/highlight.js |
| Mermaid | 11.13.0 | MIT | `mermaid.min.js` | https://github.com/mermaid-js/mermaid |
| Monaco Editor | 0.45.0 | MIT | `monaco/` | https://github.com/microsoft/monaco-editor |
| TypeScript (language service bundled in Monaco) | 5.0.2 | Apache-2.0 | `monaco/vs/language/typescript/` | https://github.com/microsoft/TypeScript — text in `LICENSES/monaco-editor-ThirdPartyNotices.txt` |
| Codicons (font in Monaco) | bundled with Monaco 0.45.0 | CC-BY-4.0 (font), MIT (code) | `monaco/vs/base/browser/ui/codicons/codicon/codicon.ttf` | https://github.com/microsoft/vscode-codicons |
| xterm.js | 5.x (version not stated in the minified file) | MIT | `xterm/xterm.js`, `xterm/xterm.css` | https://github.com/xtermjs/xterm.js |
| xterm-addon-fit | matching xterm.js 5.x | MIT | `xterm/xterm-addon-fit.js` | https://github.com/xtermjs/xterm.js |
| Phosphor Icons (web font, Regular) | 2.x (≈1 530 icons; version not stated in the files) | MIT | `src/regular/` | https://github.com/phosphor-icons/web |
| Tailwind CSS (standalone browser build, used by `tools/generate_tailwind_css.mjs` to precompile `frontend/css/style.tailwind.css`) | 3.4.17 | MIT | `tailwind.js` | https://github.com/tailwindlabs/tailwindcss |
| Chart.js | 4.4.1 | MIT | `chart.js` | https://github.com/chartjs/Chart.js |
| chartjs-adapter-date-fns (bundle, includes date-fns) | 3.0.0 | MIT | `chartjs-adapter-date-fns.bundle.min.js` | https://github.com/chartjs/chartjs-adapter-date-fns |
| chartjs-chart-boxplot (@sgratzl) | 4.x (version not stated in the minified file) | MIT | `chartjs-chart-boxplot.umd.min.js` | https://github.com/sgratzl/chartjs-chart-boxplot |
| chartjs-chart-financial | 0.2.1 | MIT | `chartjs-chart-financial.js` | https://github.com/chartjs/chartjs-chart-financial |
| chartjs-chart-matrix | 2.0.1 | MIT | `chartjs-chart-matrix.min.js` | https://github.com/kurkle/chartjs-chart-matrix |
| chartjs-chart-sankey | 0.14.0 | MIT | `chartjs-chart-sankey.min.js` | https://github.com/kurkle/chartjs-chart-sankey |
| chartjs-chart-treemap | 3.1.0 | MIT | `chartjs-chart-treemap.min.js` | https://github.com/kurkle/chartjs-chart-treemap |
| chartjs-plugin-annotation | 3.0.1 | MIT | `chartjs-plugin-annotation.min.js` | https://github.com/chartjs/chartjs-plugin-annotation |
| chartjs-plugin-datalabels | 2.2.0 | MIT | `chartjs-plugin-datalabels.min.js` | https://github.com/chartjs/chartjs-plugin-datalabels |

### `rag_app/static/lib/`

| Component | Version | License | Upstream |
|---|---|---|---|
| Alpine.js | 3.13.3 | MIT | https://github.com/alpinejs/alpine |
| marked | 15.0.12 | MIT | https://github.com/markedjs/marked |
| DOMPurify | 3.1.6 | Apache-2.0 OR MPL-2.0 | https://github.com/cure53/DOMPurify |
| highlight.js | 11.7.0 | BSD-3-Clause | https://github.com/highlightjs/highlight.js |
| Tailwind CSS (standalone browser build) | 3.4.17 | MIT | https://github.com/tailwindlabs/tailwindcss |

---

## 2. Installed dependencies (not redistributed)

`./install.sh` installs these from their official sources. The exact list
and pinned versions are in `requirements.txt`, `requirements-rag.txt`,
`desktop-agent/requirements-*.txt` and `browser-service/package.json`.

### Python — application

| Package | License |
|---|---|
| fastapi | MIT |
| starlette | BSD-3-Clause |
| pydantic | MIT |
| sse-starlette | BSD-3-Clause |
| uvicorn (+ uvloop, httptools, websockets, watchfiles) | BSD-3-Clause / MIT / Apache-2.0 |
| gunicorn | MIT |
| httpx | BSD-3-Clause |
| requests | Apache-2.0 |
| itsdangerous | BSD-3-Clause |
| fastmcp | Apache-2.0 |
| mcp (Model Context Protocol SDK) | MIT |
| redis (redis-py) | MIT |
| Pillow | MIT-CMU (HPND) |
| tree-sitter, tree-sitter-bash, tree-sitter-javascript, tree-sitter-typescript | MIT |
| tree-sitter-robot | ISC |
| python-multipart | Apache-2.0 |
| jsonschema | MIT |
| cryptography | Apache-2.0 OR BSD-3-Clause |
| PyYAML | MIT |
| dpkt | BSD-3-Clause |
| psutil | BSD-3-Clause |
| pg8000 (PostgreSQL driver) | BSD-3-Clause |
| scramp, asn1crypto, python-dateutil, six (pg8000 dependencies) | MIT-0 / MIT / Apache-2.0 OR BSD-3-Clause / MIT |
| PyMySQL (MariaDB / MySQL driver) | MIT |
| ruff | MIT |
| pytest, pytest-asyncio, pytest-xdist (tests) | MIT / Apache-2.0 / MIT |

### Python — RAG service

| Package | License |
|---|---|
| pandas | BSD-3-Clause |
| python-docx | MIT |
| pypdf | BSD-3-Clause |
| pdfplumber | MIT |
| pypdfium2 (includes PDFium) | Apache-2.0 OR BSD-3-Clause (PDFium: BSD-3-Clause / Apache-2.0) |
| charset-normalizer | MIT |
| openpyxl | MIT |
| tabulate | MIT |
| fpdf2 | **LGPL-3.0** — see § 3 |

### Python — desktop agent (optional, installed on the controlled machine)

| Package | License |
|---|---|
| mss | MIT |
| pyautogui (installed with `--no-deps`, without its optional GPL dependencies mouseinfo and pymsgbox) | BSD-3-Clause |
| pyscreeze, pytweening (pyautogui dependencies, installed explicitly) | MIT |
| pygetwindow, pyrect (Windows), pyperclip (pyautogui dependencies, installed explicitly) | BSD-3-Clause |
| pywin32 (Windows) | PSF |
| colorama (Windows) | BSD-3-Clause |
| pywinauto (Windows) | BSD-3-Clause |
| comtypes (Windows) | MIT |
| numpy | BSD-3-Clause |
| python-xlib (Linux, installed explicitly in place of python3-Xlib, GPL-2.0, declared by pyautogui) | **LGPL-2.1-or-later** — see § 3 |
| PyGObject (Linux, optional) | **LGPL-2.1-or-later** — see § 3 |

### Node.js — browser service

| Package | License |
|---|---|
| playwright (+ browser downloaded by `playwright install`) | Apache-2.0 |
| express | MIT |
| uuid | MIT |

### Services and tools downloaded by `install.sh`

| Component | License |
|---|---|
| Qdrant (vector database binary) | Apache-2.0 |
| Caddy (HTTPS front end, `--with-caddy`) | Apache-2.0 |
| LibreOffice (Office previews, `--with-office`) | MPL-2.0 |
| PostgreSQL server (`--db postgres-local`; installed from the OS repositories, never redistributed) | PostgreSQL License |
| MariaDB server (`--db mariadb-local`; installed from the OS repositories, never redistributed — a separate program Elpis talks to over the network protocol only) | GPL-2.0 |
| bubblewrap (`--with-office`) | LGPL-2.0-or-later |
| OpenCode CLI (optional, dropped in `cli_dist/` by the administrator) | MIT |
| Sandbox image (`deploy/docker/sandbox/Dockerfile`) | built from Debian packages, each under its own license, plus binaries fetched by `build_offline.sh`: Firefox ESR and geckodriver (MPL-2.0), yq, gh, duckdb, delta (MIT), shfmt (BSD-3-Clause), hadolint (GPL-3.0), upx (GPL-2.0-or-later), radare2 (LGPL-3.0) |
| Voice engine, speech-to-text (`deploy/voice/`) | whisper.cpp and Whisper ggml models: MIT |
| Voice engine, text-to-speech (`deploy/voice/tts/`) | piper-tts: **GPL-3.0-or-later** (see § 3); onnxruntime: MIT; Piper voices: license per voice, see each voice's `MODEL_CARD` |
| Python runtime for the Windows desktop-agent bundle (`desktop-agent/fetch_offline_deps.sh`) | python-build-standalone: PSF License, plus the licenses of the libraries it bundles |

The LLM **models** you connect to Elpis have their own licenses, distinct
from this project's; check them before use.

---

## 3. Copyleft dependencies

### Optional, not installed by default — AGPL-3.0

| Package | License | Used for |
|---|---|---|
| PyMuPDF (`fitz`) | AGPL-3.0 (or commercial license from Artifex) | Faster PDF rasterization / text extraction in the RAG OCR pipeline |
| pdf2docx | MIT, but requires PyMuPDF (AGPL-3.0) | PDF → DOCX conversion in the RAG service |

They are listed in `requirements-agpl-optional.txt` and only installed with
`./install.sh --with-agpl`. Without them, Elpis falls back to `pypdfium2`
(rasterization and text extraction) and reports PDF → DOCX conversion as
unavailable. **If you install them and make Elpis available to users over a
network, the AGPL obligations of those packages apply to your deployment.**

### Installed, used unmodified — LGPL

| Package | License |
|---|---|
| fpdf2 | LGPL-3.0 |
| python-xlib (desktop agent, Linux) | LGPL-2.1-or-later |
| PyGObject (optional) | LGPL-2.1-or-later |

These libraries are installed by pip as separate, unmodified packages and are
dynamically imported; they can be replaced by the user, which is compatible
with distributing Elpis under the MIT License.

### Separate programs under GPL — never part of the default install

| Component | License | Where |
|---|---|---|
| piper-tts | GPL-3.0-or-later | Text-to-speech service (`deploy/voice/tts/`), a separate process Elpis calls over HTTP |
| hadolint, upx, radare2 | GPL-3.0 / GPL-2.0-or-later / LGPL-3.0 | Tools inside the sandbox image |

These components are installed by opt-in scripts, run as separate
programs, and are never committed to this repository. **Offline bundles
built by `make_release.sh` or `deploy/voice/fetch_offline.sh` contain
them (the desktop-agent bundle from `desktop-agent/fetch_offline_deps.sh`
contains no GPL component): if you redistribute
such a bundle, you must comply with the GPL for those components (license
text and corresponding source, or a written offer).**
