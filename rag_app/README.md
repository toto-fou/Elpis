# Console RAG

Service autonome (FastAPI, port 8000) qui gère la base documentaire du chatbot :
import de fichiers, découpage, indexation vectorielle (Qdrant), recherche, et
transcription OCR de documents scannés (onglet **Documents**).

## Lancer

```bash
./start.sh                 # depuis n'importe quel dossier
RAG_HOST=0.0.0.0 ./start.sh
```

Prérequis : Qdrant (`qdrant/`, port 6333) et un serveur d'embeddings compatible
OpenAI (`/v1/embeddings`, ex. llama.cpp avec bge-m3).

## Accès

- **Jeton de service** : `RAG_SERVICE_TOKEN`, sinon `service_token` de
  `rag_config.json`, sinon `../user_db/.rag_service_token` (généré par `./elpis configure`).
- Avec jeton : `/api/*` exige `Authorization: Bearer <jeton>` ou le cookie de
  console (bouton de connexion, 12 h, révoqué par « Déconnexion »).
- Sans jeton : seuls les appels directs de la machine locale passent.
- `/api/health` est public.

## Configuration (`rag_config.json`)

| Clé | Rôle |
|---|---|
| `qdrant_url`, `collection` | Base vectorielle et collection active (`DATA/<collection>/`) |
| `embed_base_url`, `embed_model` | Serveur et modèle d'embeddings |
| `allowed_ext` | Extensions indexées |
| `global_method`, `global_chunk_size`, `global_chunk_overlap`, `global_max_chunk_size` | Découpage par défaut |
| `file_rules`, `folder_rules`, `extension_rules` | Découpage par fichier, dossier, extension |
| `global_max_doc_length` | Plafond de lecture « document entier » par le chatbot |
| `index_max_chars`, `extract_timeout_s` | Garde-fous d'indexation (taille, temps d'extraction) |
| `search_budget_s` | Budget de temps d'une recherche (45 s) |
| `sparse`, `reranker`, `contextual` | Recherche hybride, reranking, Contextual Retrieval (désactivés) |
| `ocr` | Serveur OCR, plafonds, collection `ocr-documents` |
| `chatbot_url` | Adresse du chatbot (bouton « Interroger ») |

La console valide la configuration avant de l'écrire (422 si invalide).
Changer le modèle ou le découpage réindexe à la prochaine synchronisation ;
changer une règle ne réindexe que les fichiers concernés.

## Indexation

- **Synchroniser** (`POST /api/tasks/index {"kind":"ingest"}`) : indexe les
  fichiers nouveaux ou modifiés. **Tout réindexer** : `{"kind":"bulk_reindex"}`.
- La tâche tourne en fond : fermer l'onglet ne l'arrête pas. Suivi :
  `GET /api/tasks/index`, flux `GET /api/tasks/index/events?since=N`,
  arrêt `POST /api/tasks/index/cancel` (entre deux fichiers).
- Un fichier en échec garde son ancien index s'il en avait un, et sera retenté.
- `rag_state.json` (état d'indexation) est local à l'installation, hors dépôt.

## API des outils du chatbot (SSE)

`/api/tools/rag_search`, `rag_get_document`, `rag_list_sources`, `rag_cite`,
`rag_inline`, `rag_index_document`, `rag_deindex_document` : flux
`start → result | error → done`, ping toutes les 5 s. Les documents sont
désignés par leur **chemin relatif** dans la collection (le nom seul suffit
s'il est unique). Une panne de Qdrant ou des embeddings renvoie une erreur 503,
jamais « aucun résultat ».

## Exploitation

- `POST /api/restart` refuse (409) si une indexation ou un OCR tourne ; `{"force": true}` pour forcer.
- Journaux : `logs/app.log` (rotation 5 Mo) ; traces de recherche : `rag_traces.json` (100 dernières, extraits).
- Plafonds d'import : `RAG_UPLOAD_MAX_MB` (512 par fichier), `RAG_UNPACK_MAX_MB` (2048 décompressés),
  `RAG_UPLOAD_REQUEST_MAX_MB` (2048 par envoi).
- Tests : `venv/bin/pytest tests/rag_app`.
