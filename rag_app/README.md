# Built-in RAG extractor

Stateless Python service (FastAPI, port 8000, `elpis-rag` service). The TypeScript core does everything else in RAG
(collections, permissions, chunking, embeddings, Qdrant, search, chat tools); this service only reads the
documents the core points it to. It has no console, no database, no collection, and no on-disk state beyond its cache.

## Running

`./elpis start` (or the systemd units from `sudo ./elpis service install`) launches it with the right variables. By
hand, from this folder:

```bash
./start.sh
```

| Variable | Role | Default |
|---|---|---|
| `RAG_STORE_DIR` | The core's store, read-only: the paths received are relative to it | `../user_db/rag` |
| `RAG_CACHE_DIR` | The only folder written to: PDFs converted by LibreOffice (`conv/`), temporary files | `<store>-cache` |
| `RAG_SERVICE_TOKEN` | Service token expected in `Authorization: Bearer` | content of `RAG_SERVICE_TOKEN_FILE` |
| `RAG_SERVICE_TOKEN_FILE` | Token file (written by `./elpis configure`, also read by the core) | `../user_db/.rag_service_token` |
| `RAG_HOST`, `RAG_PORT` | Listen address | `127.0.0.1`, `8000` |

The core and the extractor must see the same store: `./elpis` gives each of them the `RAG_STORE_DIR` the core
computes (`rag.store_dir` in `config.json`, otherwise `user_db/rag`). With no token configured, only a direct call from the
local machine gets through (no relay header).

## Routes

All require the token, except `/api/health`.

- `GET /api/health`: `{ok, service, version, soffice, isolated, ocr}` (LibreOffice present; analyses inside the bubblewrap
  jail; OCR supported). Nothing sensitive.
- `POST /api/extract {source, ext, ocr?, max_chars?, ocr_service?}`: NDJSON stream, `progress` lines then `result`
  (`meta {pages, title, text_layer, mime}`, `blocks`, `warnings`) or `error` (`no_text`, `encrypted`, `unsupported`,
  `too_large`, `timeout`, `corrupt`, `ocr_unavailable`). Block: `{kind, text, level?, page?, boxes?, sheet?,
  slide?}`, boxes `[x0, y0, x1, y1]` in PDF points, origin at top left.
- `POST /api/render {source, ext, page, dpi?}`: `image/webp` of one page (PDF directly; docx, pptx, xlsx converted by
  LibreOffice then cached by sha256). Headers `X-Rag-Pages`, `X-Rag-Page-Width`, `X-Rag-Page-Height`.
- `POST /api/locate {source, ext, text, page_hint?}`: `{page, boxes, score, page_width, page_height}` (`page` is null if
  the passage is not found).

Paths are **relative** to the store: an absolute path, `..`, a symbolic link, a non-regular file and an extension
not on the list are refused (400 `bad_path`, 404 `not_found`, `unsupported`).

## OCR

Pages without text in a PDF are read by an OpenAI-compatible vision model (`/v1/chat/completions`, DeepSeek-OCR family
"grounding" format). The service has no configuration of its own: the core sends
`ocr_service {url, model, api_key, timeout_s, max_side_px, max_tokens}` with each extraction of a collection where
OCR is enabled, taken from `config.json › rag.ocr` (Admin console › Models & services › RAG › Reranking and OCR). Without `ocr_service`, a
PDF with no text at all ends in `ocr_unavailable` and a mixed PDF keeps its native text with a warning.

## Isolation and limits

Each analysis runs in a child interpreter (`python -I`, minimal environment, `setrlimit` on memory, CPU and
write size, own session), killed at the timeout or when the stream closes. This child and LibreOffice run in
a bubblewrap jail, the one used for Office previews: no network, nothing from the disk outside `/usr`, the interpreter and the
extractor code, except the single file being analyzed (read-only) or the conversion's working folder.
LibreOffice converts Word, Excel and PowerPoint there with a fresh profile that turns off macros and document
links. `RAG_ISOLATION` is `auto` (default: jail as soon as `bwrap` works here), `bwrap` (required, otherwise 503
`isolation_unavailable`) or `none`. `/api/health` reports it (`isolated`) and `./elpis doctor` flags it (`bubblewrap`
package, user namespaces allowed). Settings: `RAG_EXTRACT_TIMEOUT_S` (300,
also read by the core for its own timeout), `RAG_EXTRACT_MEM_MB` (3072), `RAG_EXTRACT_MAX_BYTES` (200 MB),
`RAG_EXTRACT_MAX_CHARS` (20 M), `RAG_EXTRACT_ZIP_MAX_MB` (1024, uncompressed size of Office archives),
`RAG_EXTRACT_CONCURRENCY` (2), `RAG_RENDER_TIMEOUT_S` (60), `RAG_RENDER_MAX_PIXELS` (60 M), `RAG_SOFFICE_TIMEOUT_S`
(180), `RAG_CACHE_MAX_MB` (2048), `RAG_SOFFICE_BIN` (path of `soffice` outside PATH).

Dependencies: `requirements-rag.txt` (pdfplumber, pypdfium2, pypdf, openpyxl…) and, to render Word, Excel and
PowerPoint, LibreOffice (apt packages of the `apercus-office` group). Without LibreOffice, extraction works; only the rendered
pages of these formats are missing (503 `soffice_unavailable`).

## Tests

`venv/bin/python -m pytest tests/rag_app` (no network; tests that need LibreOffice are skipped without it).
