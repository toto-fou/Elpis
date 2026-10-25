# Third-party notices / Composants tiers

Elpis itself is licensed under the MIT License (see `LICENSE`).
This file lists the third-party components that are **bundled in this
repository** (vendored front-end files) or **built into the TypeScript core
bundle** shipped by the offline package, then the dependencies that
`./install.sh` **downloads and installs** (not redistributed here), and
finally the **optional** dependencies under copyleft licenses.

Each bundled file keeps its original copyright header when the upstream
distribution ships one. The license texts of the bundled components, with
their copyright notices, are reproduced in [`THIRD_PARTY_LICENSES/`](THIRD_PARTY_LICENSES/) (one
file per component, named after the upstream package). [`LICENSES/`](LICENSES/)
holds the SPDX texts of the licenses used by the project itself (REUSE).

---

## 1. Bundled components (vendored)

### `frontend/vendor/`

| Component | Version | License | Files | Upstream |
|---|---|---|---|---|
| Phosphor Icons (web font, Regular) | 2.x (≈1 530 icons; version not stated in the files) | MIT | `src/regular/` | https://github.com/phosphor-icons/web |
| Tailwind CSS (standalone browser build, used by `tools/generate_tailwind_css.mjs` to precompile `frontend/css/style.tailwind.css`) | 3.4.17 | MIT | `tailwind.js` | https://github.com/tailwindlabs/tailwindcss |

### `frontend/assets/mascotte/` and `frontend/*.png` (project artwork)

Not third-party code. The pixel-art mascots are drawn by script from the grids
in their `source.json` and distributed under the project license (MIT). The
Elpis logo (`frontend/*.png`) and the Kiki skin illustrations
(`frontend/assets/mascotte/kiki*/`) were produced with an image-generation tool;
their copyright protection is uncertain, so no rights are claimed and they are
dedicated under CC0-1.0 (`LICENSES/CC0-1.0.txt`). Origin and caveats:
[`frontend/assets/mascotte/README.md`](frontend/assets/mascotte/README.md).

### `frontend/dist/` (web bundle, built by Vite)

`npm run build -w @elpis/web` (and `make_release.sh`) builds the two entries of
the web interface into `frontend/dist/` from the exact npm versions of
`frontend/package.json` (lock file at the root). The bundle is not versioned in
this repository; it is redistributed in the offline package (`web/`). Vue,
marked, DOMPurify and Zod (through `@elpis/contracts`) are bundled into the
entry chunks; the other libraries are
their upstream distribution files, copied unmodified (hashed file names) and
loaded on demand. Monaco Editor is bundled from its ESM build into separate
chunks (editor, language workers) imported only when the editor opens. License texts: [`THIRD_PARTY_LICENSES/`](THIRD_PARTY_LICENSES/) (one file per component).

| Component | Version | License | Files (npm package) | Upstream |
|---|---|---|---|---|
| Vue.js (esm-bundler build with the template compiler; `@vue/*` packages) | 3.5.44 | MIT | entry chunk (`vue`) | https://github.com/vuejs/core |
| marked | 15.0.12 | MIT | entry chunk (`marked`) | https://github.com/markedjs/marked |
| DOMPurify | 3.4.17 | Apache-2.0 OR MPL-2.0 (Apache-2.0 retained) | entry chunk (`dompurify`) | https://github.com/cure53/DOMPurify |
| Zod (schemas of `@elpis/contracts`, network validation) | 4.6.7 | MIT | entry chunks (`zod`) | https://github.com/colinhacks/zod — text in `THIRD_PARTY_LICENSES/npm-web.txt` |
| highlight.js (browser build and `github-dark` theme) | 11.7.0 | BSD-3-Clause | `highlight.min.js`, `styles/github-dark.min.css` (`@highlightjs/cdn-assets`) | https://github.com/highlightjs/highlight.js |
| Mermaid | 11.17.2 | MIT | `dist/mermaid.min.js` (`mermaid`) | https://github.com/mermaid-js/mermaid |
| Apache ECharts (chat charts) | 6.1.0 | Apache-2.0 (NOTICE and embedded d3.js BSD-3-Clause parts in `THIRD_PARTY_LICENSES/echarts.txt`) | `dist/echarts.min.js`, `i18n/langFR.js` (`echarts`) | https://github.com/apache/echarts |
| ZRender (bundled in `echarts.min.js`) | 6.1.0 | BSD-3-Clause | `dist/echarts.min.js` (`echarts`) | https://github.com/ecomfe/zrender |
| Chart.js (admin dashboard) | 4.5.1 | MIT | `dist/chart.umd.js` (`chart.js`) | https://github.com/chartjs/Chart.js |
| chartjs-adapter-date-fns (bundle, includes date-fns) | 3.0.0 | MIT | `dist/chartjs-adapter-date-fns.bundle.min.js` | https://github.com/chartjs/chartjs-adapter-date-fns |
| chartjs-chart-boxplot (@sgratzl) | 4.4.4 | MIT | `build/index.umd.min.js` (`@sgratzl/chartjs-chart-boxplot`) | https://github.com/sgratzl/chartjs-chart-boxplot |
| chartjs-chart-financial | 0.2.1 | MIT | `dist/chartjs-chart-financial.js` | https://github.com/chartjs/chartjs-chart-financial |
| chartjs-chart-matrix | 3.1.0 | MIT | `dist/chartjs-chart-matrix.min.js` | https://github.com/kurkle/chartjs-chart-matrix |
| chartjs-chart-sankey | 0.14.0 | MIT | `dist/chartjs-chart-sankey.min.js` | https://github.com/kurkle/chartjs-chart-sankey |
| chartjs-chart-treemap | 4.2.2 | MIT | `dist/chartjs-chart-treemap.min.js` | https://github.com/kurkle/chartjs-chart-treemap |
| chartjs-plugin-annotation | 3.0.1 | MIT | `dist/chartjs-plugin-annotation.min.js` | https://github.com/chartjs/chartjs-plugin-annotation |
| chartjs-plugin-datalabels | 2.2.0 | MIT | `dist/chartjs-plugin-datalabels.min.js` | https://github.com/chartjs/chartjs-plugin-datalabels |
| xterm.js | 5.4.0 | MIT | `lib/xterm.js`, `css/xterm.css` (`@xterm/xterm`) | https://github.com/xtermjs/xterm.js |
| xterm addon-fit | 0.11.0 | MIT | `lib/addon-fit.js` (`@xterm/addon-fit`) | https://github.com/xtermjs/xterm.js |
| Monaco Editor (ESM build, its workers and CSS; loaded on demand when the editor opens) | 0.45.0 | MIT | `esm/vs/` (`monaco-editor`): chunks `monaco-*.js`, `editor.api-*.js`, `*.worker-*.js`, `monaco-*.css` | https://github.com/microsoft/monaco-editor |
| TypeScript (language service bundled in Monaco) | 5.0.2 | Apache-2.0 | `esm/vs/language/typescript/` (`monaco-editor`), chunk `ts.worker-*.js` | https://github.com/microsoft/TypeScript — text in `THIRD_PARTY_LICENSES/monaco-editor-ThirdPartyNotices.txt` |
| Codicons (font in Monaco) | bundled with Monaco 0.45.0 | CC-BY-4.0 (font), MIT (code) | `codicon-*.ttf` (`monaco-editor`) | https://github.com/microsoft/vscode-codicons |

The upstream distribution files above, copied unmodified, embed their own
dependencies at the versions their upstream build resolved: the versions below
are those of the license banner of the file when it prints one, otherwise the
range declared by the host package. License texts:
[`THIRD_PARTY_LICENSES/npm-web.txt`](THIRD_PARTY_LICENSES/npm-web.txt) (copied from the packages
installed by the lock file; same licenses and copyright holders).

| Embedded in | Component | Version | License |
|---|---|---|---|
| `echarts.min.js` | tslib (TypeScript helpers) | 2.3.0 | **0BSD** (BSD family, public-domain equivalent; admitted by `migration-kit/deps.map.json`) |
| `echarts-ssr.cjs` (server-side chart rendering of the docx/pptx tools, built by `frontend/build-ssr.mjs` from the npm packages) | Apache ECharts, ZRender, tslib | 6.1.0, 6.1.0, 2.3.0 | Apache-2.0, BSD-3-Clause, **0BSD** — texts in `THIRD_PARTY_LICENSES/echarts.txt`, `THIRD_PARTY_LICENSES/zrender.txt`, `THIRD_PARTY_LICENSES/npm-web.txt` |
| `chart.umd.js` | @kurkle/color | ^0.3.0 | MIT |
| `index.umd.min.js` (boxplot) | @sgratzl/boxplots | ^2.0.0 | MIT |
| `chartjs-adapter-date-fns.bundle.min.js` | date-fns | bundled by the adapter 3.0.0 | MIT — text in `THIRD_PARTY_LICENSES/date-fns.txt` |
| `mermaid.min.js` | DOMPurify | 3.4.12 (banner) | Apache-2.0 OR MPL-2.0 (Apache-2.0 retained) — text in `THIRD_PARTY_LICENSES/dompurify.txt` |
| `mermaid.min.js` | js-yaml | 4.x (no version banner) | MIT — text in `THIRD_PARTY_LICENSES/js-yaml.txt` (copied from https://github.com/nodeca/js-yaml; not shipped by an installed package) |
| `mermaid.min.js` | marked | ^16.3.0 | MIT — text in `THIRD_PARTY_LICENSES/marked.txt` |
| `mermaid.min.js` | @mermaid-js/parser, with Langium (4.2.1) and Chevrotain (~11.1.2) bundled | ^1.2.1 | MIT; Langium MIT (https://github.com/eclipse-langium/langium); Chevrotain Apache-2.0 |
| `mermaid.min.js` | d3 (the d3-* modules used by the diagrams), internmap | ^7.9.0 | ISC |
| `mermaid.min.js` | d3-sankey, with d3-array 2, d3-shape 1, d3-path 1 | ^0.12.3 | BSD-3-Clause |
| `mermaid.min.js` | dagre-d3-es | 7.0.14 | MIT |
| `mermaid.min.js` | cytoscape, cytoscape-cose-bilkent, cytoscape-fcose, cose-base, layout-base | ^3.34.0, ^4.1.0, ^2.2.0 | MIT |
| `mermaid.min.js` | KaTeX | ^0.16.47 | MIT |
| `mermaid.min.js` | khroma | 2.1.0 | MIT (license file of the package, text in `THIRD_PARTY_LICENSES/npm-web.txt`; its `package.json` has no `license` field, so the license is declared in `migration-kit/deps.map.json`, `politique.surcharges`) |
| `mermaid.min.js` | lodash-es (through dagre-d3-es) | 4.18.1 (banner) | MIT |
| `mermaid.min.js` | es-toolkit, fastdom | ^1.45.1, 1.0.12 | MIT — texts in `THIRD_PARTY_LICENSES/npm-web.txt` |
| `mermaid.min.js` | roughjs, with hachure-fill, path-data-parser, points-on-curve, points-on-path | ^4.6.6 | MIT |
| `mermaid.min.js` | stylis, dayjs, uuid, ts-dedent, @braintree/sanitize-url, @upsetjs/venn.js, @iconify/utils | ^4.3.6, ^1.11.21, ^11.1.0 to ^14.0.0, ^2.2.0, ^7.1.2, ^2.0.0, ^3.0.2 | MIT |

Present in the lock file under these packages but **not** embedded (checked
in `mermaid.min.js`): d3-delaunay, delaunator, robust-predicates (Unlicense),
strictdom (MIT, used only by the strict mode of fastdom),
and the Node-only dependencies of @iconify/utils, KaTeX and d3-dsv (CLI tools,
package manager helpers).

### `apps/core/dist/` (TypeScript core bundle)

`npm run build` (and `make_release.sh`) bundles the core and the npm packages it
uses into `dist/main.mjs`, `dist/exploitation.mjs` and the image worker
`dist/pixels.mjs` (esbuild). The bundle is not versioned in this repository; it
is redistributed in the offline package. better-sqlite3 is shipped beside it in
`dist/node_modules/`, with its prebuilt binary for the target (it embeds
SQLite, public domain). The WebAssembly codecs of libwebp 1.6.0 (BSD-3-Clause,
with its patent grant), built from the signed source release by
`deploy/codecs/webp/construire.sh` (pinned Emscripten, checksums in
`deploy/codecs/webp/SHA256SUMS`), are shipped in
`dist/webp/`; they also embed what Emscripten compiles into them (its system
libraries, MIT; musl, MIT; compiler-rt, Apache-2.0 WITH LLVM-exception;
dlmalloc, public domain), all cited under `libwebp`. The license texts are
in [`THIRD_PARTY_LICENSES/npm-core.txt`](THIRD_PARTY_LICENSES/npm-core.txt), also shipped as
`dist/LICENCES-TIERS.txt`. Only the licenses of
`migration-kit/deps.map.json` (MIT, Apache-2.0, ISC, BSD-2-Clause,
BSD-3-Clause, 0BSD, Unlicense) are accepted: the build stops on any other.

<!-- npm-core : table écrite par `npm run licences`, ne pas modifier à la main -->

| Package | Version | License |
|---|---|---|
| @fastify/ajv-compiler | 4.0.6 | MIT |
| @fastify/busboy | 3.2.2 | MIT |
| @fastify/deepmerge | 3.2.2 | MIT |
| @fastify/error | 4.2.0 | MIT |
| @fastify/fast-json-stringify-compiler | 5.1.0 | MIT |
| @fastify/forwarded | 3.0.2 | MIT |
| @fastify/merge-json-schemas | 0.2.1 | MIT |
| @fastify/multipart | 10.1.2 | MIT |
| @fastify/proxy-addr | 5.1.1 | MIT |
| @fastify/send | 4.1.1 | MIT |
| @fastify/websocket | 11.3.3 | MIT |
| @lukeed/ms | 2.0.2 | MIT |
| @modelcontextprotocol/sdk | 1.32.1 | MIT |
| @pinojs/redact | 0.4.0 | MIT |
| abstract-logging | 2.0.1 | MIT |
| ajv | 8.20.0 | MIT |
| ajv-formats | 3.0.1 | MIT |
| atomic-sleep | 1.0.0 | MIT |
| avvio | 9.3.0 | MIT |
| better-sqlite3 | 13.0.3 | MIT |
| content-type | 1.0.5 | MIT |
| cookie | 1.1.1 | MIT |
| depd | 2.0.0 | MIT |
| dequal | 2.0.3 | MIT |
| duplexify | 4.1.3 | MIT |
| end-of-stream | 1.4.5 | MIT |
| escape-html | 1.0.3 | MIT |
| eventsource | 3.0.7 | MIT |
| eventsource-parser | 3.1.1 | MIT |
| fast-decode-uri-component | 1.0.1 | MIT |
| fast-deep-equal | 3.1.3 | MIT |
| fast-json-stringify | 7.0.1 | MIT |
| fast-querystring | 1.1.2 | MIT |
| fast-uri | 3.1.9 | BSD-3-Clause |
| fast-uri | 4.2.3 | BSD-3-Clause |
| fastify | 5.12.7 | MIT |
| fastify-plugin | 6.0.0 | MIT |
| fastq | 1.20.3 | ISC |
| find-my-way | 9.9.0 | MIT |
| http-errors | 2.0.1 | MIT |
| inherits | 2.0.4 | ISC |
| ipaddr.js | 2.5.0 | MIT |
| jpeg-js | 0.4.4 | BSD-3-Clause AND Apache-2.0 |
| json-schema-ref-resolver | 3.0.0 | MIT |
| json-schema-traverse | 1.0.0 | MIT |
| libwebp | 1.6.0 | BSD-3-Clause AND MIT AND Apache-2.0 WITH LLVM-exception |
| light-my-request | 6.6.0 | BSD-3-Clause |
| mime | 3.0.0 | MIT |
| node-addon-api | 8.9.2 | MIT |
| on-exit-leak-free | 2.1.2 | MIT |
| once | 1.4.0 | ISC |
| pg | 8.23.1 | MIT |
| pg-cloudflare | 1.4.1 | MIT |
| pg-connection-string | 2.14.1 | MIT |
| pg-int8 | 1.0.1 | ISC |
| pg-pool | 3.14.0 | MIT |
| pg-protocol | 1.16.1 | MIT |
| pg-types | 2.2.0 | MIT |
| pgpass | 1.0.5 | MIT |
| pino | 10.4.0 | MIT |
| pino-std-serializers | 7.1.0 | MIT |
| pkce-challenge | 5.0.1 | MIT |
| pngjs | 7.0.0 | MIT |
| postgres-array | 2.0.0 | MIT |
| postgres-bytea | 1.0.1 | MIT |
| postgres-date | 1.0.7 | MIT |
| postgres-interval | 1.2.0 | MIT |
| process-warning | 5.1.0 | MIT |
| process-warning | 4.0.1 | MIT |
| quick-format-unescaped | 4.0.4 | MIT |
| readable-stream | 3.6.2 | MIT |
| ret | 0.5.0 | MIT |
| reusify | 1.1.0 | MIT |
| rfdc | 1.4.1 | MIT |
| safe-buffer | 5.2.1 | MIT |
| safe-regex2 | 5.1.1 | MIT |
| safe-stable-stringify | 2.5.0 | MIT |
| secure-json-parse | 4.1.0 | BSD-3-Clause |
| semver | 7.8.5 | ISC |
| set-cookie-parser | 2.7.2 | MIT |
| setprototypeof | 1.2.0 | ISC |
| sonic-boom | 4.2.1 | MIT |
| split2 | 4.2.0 | ISC |
| statuses | 2.0.2 | MIT |
| stream-shift | 1.0.3 | MIT |
| string_decoder | 1.3.0 | MIT |
| thread-stream | 4.2.0 | MIT |
| toad-cache | 3.7.4 | MIT |
| toidentifier | 1.0.1 | MIT |
| undici | 8.12.3 | MIT |
| util-deprecate | 1.0.2 | MIT |
| wrappy | 1.0.2 | ISC |
| ws | 8.22.0 | MIT |
| xtend | 4.0.2 | MIT |
| zod | 4.6.7 | MIT |
| zod-to-json-schema | 3.25.2 | ISC |

<!-- /npm-core -->

### `apps/toolhost/dist/` (TypeScript tool host bundle)

`npm run build -w @elpis/toolhost` bundles the tool host and the npm packages
it uses into `dist/main.mjs` (esbuild). The bundle is not versioned in this
repository; it is redistributed in the offline package. better-sqlite3 and
node-pty are shipped beside it in `dist/node_modules/`, with their binary for
the target: better-sqlite3's prebuilt one, and node-pty's compiled by `npm ci`
on a build machine of the target (node-addon-api headers compiled in). The
license texts are in [`THIRD_PARTY_LICENSES/npm-toolhost.txt`](THIRD_PARTY_LICENSES/npm-toolhost.txt),
also shipped as `dist/LICENCES-TIERS.txt`, under the same license policy as
the core bundle.

<!-- npm-toolhost : table écrite par `npm run licences`, ne pas modifier à la main -->

| Package | Version | License |
|---|---|---|
| @fastify/ajv-compiler | 4.0.6 | MIT |
| @fastify/busboy | 3.2.2 | MIT |
| @fastify/deepmerge | 3.2.2 | MIT |
| @fastify/error | 4.2.0 | MIT |
| @fastify/fast-json-stringify-compiler | 5.1.0 | MIT |
| @fastify/forwarded | 3.0.2 | MIT |
| @fastify/merge-json-schemas | 0.2.1 | MIT |
| @fastify/multipart | 10.1.2 | MIT |
| @fastify/proxy-addr | 5.1.1 | MIT |
| @fastify/websocket | 11.3.3 | MIT |
| @modelcontextprotocol/sdk | 1.32.1 | MIT |
| @pinojs/redact | 0.4.0 | MIT |
| abstract-logging | 2.0.1 | MIT |
| ajv | 8.20.0 | MIT |
| ajv-formats | 3.0.1 | MIT |
| atomic-sleep | 1.0.0 | MIT |
| avvio | 9.3.0 | MIT |
| better-sqlite3 | 13.0.3 | MIT |
| cookie | 1.1.1 | MIT |
| dequal | 2.0.3 | MIT |
| duplexify | 4.1.3 | MIT |
| end-of-stream | 1.4.5 | MIT |
| fast-decode-uri-component | 1.0.1 | MIT |
| fast-deep-equal | 3.1.3 | MIT |
| fast-json-stringify | 7.0.1 | MIT |
| fast-querystring | 1.1.2 | MIT |
| fast-uri | 3.1.9 | BSD-3-Clause |
| fast-uri | 4.2.3 | BSD-3-Clause |
| fastify | 5.12.7 | MIT |
| fastify-plugin | 6.0.0 | MIT |
| fastq | 1.20.3 | ISC |
| find-my-way | 9.9.0 | MIT |
| inherits | 2.0.4 | ISC |
| ipaddr.js | 2.5.0 | MIT |
| jpeg-js | 0.4.4 | BSD-3-Clause AND Apache-2.0 |
| json-schema-ref-resolver | 3.0.0 | MIT |
| json-schema-traverse | 1.0.0 | MIT |
| light-my-request | 6.6.0 | BSD-3-Clause |
| node-addon-api | 8.9.2 | MIT |
| node-addon-api | 7.1.1 | MIT |
| node-pty | 1.1.0 | MIT |
| on-exit-leak-free | 2.1.2 | MIT |
| once | 1.4.0 | ISC |
| pg | 8.23.1 | MIT |
| pg-cloudflare | 1.4.1 | MIT |
| pg-connection-string | 2.14.1 | MIT |
| pg-int8 | 1.0.1 | ISC |
| pg-pool | 3.14.0 | MIT |
| pg-protocol | 1.16.1 | MIT |
| pg-types | 2.2.0 | MIT |
| pgpass | 1.0.5 | MIT |
| pino | 10.4.0 | MIT |
| pino-std-serializers | 7.1.0 | MIT |
| pngjs | 7.0.0 | MIT |
| postgres-array | 2.0.0 | MIT |
| postgres-bytea | 1.0.1 | MIT |
| postgres-date | 1.0.7 | MIT |
| postgres-interval | 1.2.0 | MIT |
| process-warning | 5.1.0 | MIT |
| process-warning | 4.0.1 | MIT |
| quick-format-unescaped | 4.0.4 | MIT |
| readable-stream | 3.6.2 | MIT |
| ret | 0.5.0 | MIT |
| reusify | 1.1.0 | MIT |
| rfdc | 1.4.1 | MIT |
| safe-buffer | 5.2.1 | MIT |
| safe-regex2 | 5.1.1 | MIT |
| safe-stable-stringify | 2.5.0 | MIT |
| secure-json-parse | 4.1.0 | BSD-3-Clause |
| semver | 7.8.5 | ISC |
| set-cookie-parser | 2.7.2 | MIT |
| sonic-boom | 4.2.1 | MIT |
| split2 | 4.2.0 | ISC |
| stream-shift | 1.0.3 | MIT |
| string_decoder | 1.3.0 | MIT |
| thread-stream | 4.2.0 | MIT |
| toad-cache | 3.7.4 | MIT |
| undici | 8.12.3 | MIT |
| util-deprecate | 1.0.2 | MIT |
| wrappy | 1.0.2 | ISC |
| ws | 8.22.0 | MIT |
| xtend | 4.0.2 | MIT |
| yaml | 2.9.1 | ISC |
| zod | 4.6.7 | MIT |
| zod-to-json-schema | 3.25.2 | ISC |
| libwebp | 1.6.0 | BSD-3-Clause AND MIT AND Apache-2.0 WITH LLVM-exception |

<!-- /npm-toolhost -->

---

## 2. Installed dependencies

`./install.sh` installs these from their official sources. The offline package
built by `make_release.sh` redistributes the Python packages of
`requirements-rag.txt` as wheels (`wheels/`); each wheel carries its license
files in its `*.dist-info`, and `wheels/LICENCES-PYTHON.txt` (generated) sums
up their names, versions and license texts. The exact list
and pinned versions are in `requirements.txt`, `office/requirements.txt`, `requirements-rag.txt`,
`desktop-agent/requirements-*.txt` and `browser-service/package.json`.

### Python — application

| Package | License |
|---|---|
| fastapi | MIT |
| starlette | BSD-3-Clause |
| pydantic | MIT |
| uvicorn (+ uvloop, httptools, websockets, watchfiles, python-dotenv) | BSD-3-Clause / MIT / Apache-2.0 |
| PyYAML | MIT |
| httpx | BSD-3-Clause |
| Pillow | MIT-CMU (HPND) |
| python-docx | MIT |
| python-pptx | MIT |
| XlsxWriter | BSD-2-Clause |
| lxml | BSD-3-Clause |
| markdown-it-py | MIT |
| cryptography | Apache-2.0 OR BSD-3-Clause |
| pg8000 (PostgreSQL driver) | BSD-3-Clause |
| scramp, asn1crypto, python-dateutil, six (pg8000 dependencies) | MIT-0 / MIT / Apache-2.0 OR BSD-3-Clause / MIT |
| ruff | MIT |
| pytest, pytest-asyncio, pytest-xdist (tests) | MIT / Apache-2.0 / MIT |
| mypy, mypy-extensions, librt, ast-serialize, typing-extensions, pathspec (typage, développement) | MIT / MIT / MIT / MIT / PSF-2.0 / MPL-2.0 |

### Python — RAG extractor (rag_app)

| Package | License |
|---|---|
| python-docx | MIT |
| pypdf | BSD-3-Clause |
| pdfplumber | MIT |
| pypdfium2 (includes PDFium) | Apache-2.0 OR BSD-3-Clause (PDFium: BSD-3-Clause / Apache-2.0) |
| charset-normalizer | MIT |
| openpyxl | MIT |
| fpdf2 | **LGPL-3.0** — redistributed as a wheel in the offline package, see § 3 |

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

### Node.js — TypeScript workspace (development tools, not redistributed)

| Package | License |
|---|---|
| typescript | Apache-2.0 |
| eslint, @eslint/js, typescript-eslint | MIT |
| prettier | MIT |
| vitest, vite (with rolldown), tsx, esbuild, @types/node, @types/ws, @types/better-sqlite3, @types/pg, find-my-way (core tests) | MIT |
| @vitejs/plugin-vue, vue-tsc (with @volar/*, @vue/language-core), happy-dom | MIT |
| eslint-plugin-vue, vue-eslint-parser | MIT |
| lightningcss (dependency of vite) | MPL-2.0 |
| minimatch (dependency of the lint tooling) | BlueOak-1.0.0 |

### Services and tools downloaded by `install.sh`

| Component | License |
|---|---|
| Qdrant (vector database binary) | Apache-2.0 |
| Node.js runtime of the TypeScript core and of the browser service (`node/`): the official archive from nodejs.org (SHA-256 from the signed `SHASUMS256.txt`, pinned in `deploy/node/node.env`) **without npm, npx and corepack**, pinned in turn by its own fingerprint (`NODE_RUNTIME_SHA256_*`, `deploy/node/runtime.sh`); shipped in the offline package as a platform component, like the Python interpreter. Online installs borrow npm from the official archive for the build only; it is never installed | MIT for Node.js itself. The `node` binary also contains V8 and others under BSD-style licenses, OpenSSL, LIEF and swc under Apache-2.0, libuv, undici and amaro under MIT, HdrHistogram under BSD-2-Clause (its BSD option), and four components outside the MIT/ISC/Apache/BSD policy, **accepted as an exception for this runtime only**: ICU (Unicode-3.0), minimatch (BlueOak-1.0.0), zlib (Zlib) and SipHash, inside V8 (dedicated to the public domain by its authors). Texts: [`THIRD_PARTY_LICENSES/node-runtime.txt`](THIRD_PARTY_LICENSES/node-runtime.txt), which is also the runtime's `LICENSE`. |
| Caddy (HTTPS front end, `--with-caddy`; installed from the OS repositories as a prerequisite, configured by `install.sh`, never redistributed) | Apache-2.0 |
| LibreOffice (Office previews, `--with-office`; installed from the OS repositories as a prerequisite, never redistributed) | MPL-2.0 |
| PostgreSQL server (`--db postgres-local`; installed from the OS repositories, never redistributed) | PostgreSQL License |
| bubblewrap (isolation of Office previews; installed from the OS repositories, never redistributed) | LGPL-2.0-or-later |
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
with distributing Elpis under the MIT License. fpdf2 is pure Python and
unmodified: its wheel, redistributed in `wheels/` of the offline package,
contains its source and its LGPL-3.0 license text, which satisfies the
obligation to provide them.

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
text and corresponding source, or a written offer).** `make_release.sh` helps:
it writes `sandbox/SOURCES.txt` (package list of the image, version and exact
source URL of hadolint, upx and radare2) and `sandbox/OFFRE-SOURCES.txt`
(written offer), and `--with-sources` downloads the source archives of those
three programs; `deploy/voice/fetch_offline.sh --with-sources` does the same
for piper-tts. The Debian packages of the image have their sources on
https://snapshot.debian.org (see `docs/exploitation.md`).
