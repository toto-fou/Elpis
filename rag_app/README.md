# Extracteur du RAG intégré

Service Python sans état (FastAPI, port 8000, service `elpis-rag`). Le core TypeScript fait tout le reste du RAG
(collections, droits, découpage, embeddings, Qdrant, recherche, outils du chat) ; ce service ne fait que lire les
documents que le core lui désigne. Il n'a ni console, ni base, ni collection, ni état sur disque hors de son cache.

## Lancer

`./elpis start` (ou les unités systemd de `sudo ./elpis service install`) le lance avec les bonnes variables. À la
main, depuis ce dossier :

```bash
./start.sh
```

| Variable | Rôle | Défaut |
|---|---|---|
| `RAG_STORE_DIR` | Magasin du core, lu seulement : les chemins reçus lui sont relatifs | `../user_db/rag` |
| `RAG_CACHE_DIR` | Seul dossier écrit : PDF convertis par LibreOffice (`conv/`), temporaires | `<magasin>-cache` |
| `RAG_SERVICE_TOKEN` | Jeton de service attendu en `Authorization: Bearer` | contenu de `RAG_SERVICE_TOKEN_FILE` |
| `RAG_SERVICE_TOKEN_FILE` | Fichier du jeton (écrit par `./elpis configure`, lu aussi par le core) | `../user_db/.rag_service_token` |
| `RAG_HOST`, `RAG_PORT` | Adresse d'écoute | `127.0.0.1`, `8000` |

Le core et l'extracteur doivent voir le même magasin : `./elpis` donne à chacun le `RAG_STORE_DIR` que le core
calcule (`rag.store_dir` de `config.json`, sinon `user_db/rag`). Sans jeton configuré, seul un appel direct de la
machine locale passe (aucun en-tête de relais).

## Routes

Toutes exigent le jeton, sauf `/api/health`.

- `GET /api/health` : `{ok, service, version, soffice, isolated, ocr}` (LibreOffice présent ; analyses dans la prison
  bubblewrap ; OCR pris en charge). Rien de sensible.
- `POST /api/extract {source, ext, ocr?, max_chars?, ocr_service?}` : flux NDJSON, lignes `progress` puis `result`
  (`meta {pages, title, text_layer, mime}`, `blocks`, `warnings`) ou `error` (`no_text`, `encrypted`, `unsupported`,
  `too_large`, `timeout`, `corrupt`, `ocr_unavailable`). Bloc : `{kind, text, level?, page?, boxes?, sheet?,
  slide?}`, boîtes `[x0, y0, x1, y1]` en points PDF, origine en haut à gauche.
- `POST /api/render {source, ext, page, dpi?}` : `image/webp` d'une page (PDF direct ; docx, pptx, xlsx convertis par
  LibreOffice puis mis en cache par sha256). En-têtes `X-Rag-Pages`, `X-Rag-Page-Width`, `X-Rag-Page-Height`.
- `POST /api/locate {source, ext, text, page_hint?}` : `{page, boxes, score, page_width, page_height}` (`page` nul si
  le passage est introuvable).

Les chemins sont **relatifs** au magasin : chemin absolu, `..`, lien symbolique, fichier non ordinaire et extension
hors liste sont refusés (400 `bad_path`, 404 `not_found`, `unsupported`).

## OCR

Les pages sans texte d'un PDF sont lues par un modèle de vision compatible OpenAI (`/v1/chat/completions`, format
« grounding » de la famille DeepSeek-OCR). Le service n'a pas de configuration propre : le core envoie
`ocr_service {url, model, api_key, timeout_s, max_side_px, max_tokens}` à chaque extraction d'une collection où
l'OCR est activé, à partir de `config.json › rag.ocr` (console › RAG › Reclassement et OCR). Sans `ocr_service`, un
PDF sans aucun texte finit en `ocr_unavailable` et un PDF mixte garde son texte natif avec un avertissement.

## Isolation et limites

Chaque analyse tourne dans un interpréteur enfant (`python -I`, environnement minimal, `setrlimit` mémoire, CPU et
taille d'écriture, session propre), tué au délai ou à la fermeture du flux. Cet enfant et LibreOffice tournent dans
une prison bubblewrap, celle des aperçus Office : aucun réseau, rien du disque hors `/usr`, de l'interpréteur et du
code de l'extracteur, sinon le seul fichier analysé (en lecture) ou le dossier de travail de la conversion.
LibreOffice y convertit les Word, Excel et PowerPoint avec un profil neuf qui coupe les macros et les liens des
documents. `RAG_ISOLATION` vaut `auto` (défaut : prison dès que `bwrap` marche ici), `bwrap` (exigée, sinon 503
`isolation_unavailable`) ou `none`. `/api/health` le dit (`isolated`) et `./elpis doctor` le signale (paquet
`bubblewrap`, user namespaces autorisés). Réglages : `RAG_EXTRACT_TIMEOUT_S` (300,
lu aussi par le core pour son propre délai), `RAG_EXTRACT_MEM_MB` (3072), `RAG_EXTRACT_MAX_BYTES` (200 Mo),
`RAG_EXTRACT_MAX_CHARS` (20 M), `RAG_EXTRACT_ZIP_MAX_MB` (1024, taille décompressée des archives Office),
`RAG_EXTRACT_CONCURRENCY` (2), `RAG_RENDER_TIMEOUT_S` (60), `RAG_RENDER_MAX_PIXELS` (60 M), `RAG_SOFFICE_TIMEOUT_S`
(180), `RAG_CACHE_MAX_MB` (2048), `RAG_SOFFICE_BIN` (chemin de `soffice` hors PATH).

Dépendances : `requirements-rag.txt` (pdfplumber, pypdfium2, pypdf, openpyxl…) et, pour le rendu des Word, Excel et
PowerPoint, LibreOffice (paquets apt du groupe `apercus-office`). Sans LibreOffice, l'extraction marche ; seules les
pages rendues de ces formats manquent (503 `soffice_unavailable`).

## Tests

`venv/bin/python -m pytest tests/rag_app` (sans réseau ; les tests qui demandent LibreOffice sont sautés sans lui).
