// SPDX-License-Identifier: MIT
// tools/demo/scenes/projet.mts — projet d'exemple de la sandbox (search-service) et son historique Git : la régression de jeudi que l'agent corrige.
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const TOKENIZER = `import re
import unicodedata

WORD = re.compile(r"[a-z0-9]+")


def normalize(text: str) -> str:
    return unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode().lower()


def tokenize(text: str) -> list[str]:
    return WORD.findall(normalize(text))
`;

const INDEX_LUNDI = `from collections import Counter, defaultdict

from .tokenizer import tokenize


class Index:
    def __init__(self, docs: dict[str, str]):
        self.docs = dict(docs)
        self.postings = self._build()

    def _build(self) -> dict[str, set[str]]:
        postings: dict[str, set[str]] = defaultdict(set)
        for doc_id, text in self.docs.items():
            for term in tokenize(text):
                postings[term].add(doc_id)
        return postings

    def search(self, query: str, limit: int = 10) -> list[str]:
        hits: Counter[str] = Counter()
        for term in tokenize(query):
            for doc_id in self.postings.get(term, ()):
                hits[doc_id] += 1
        return [doc_id for doc_id, _ in hits.most_common(limit)]
`;

// Jeudi : « prendre en compte les documents ajoutés » en reconstruisant l'index à chaque requête.
export const INDEX_JEUDI_AVANT = `    def __init__(self, docs: dict[str, str]):
        self.docs = dict(docs)

    def add(self, doc_id: str, text: str) -> None:
        self.docs[doc_id] = text
`;
export const INDEX_JEUDI_APRES_RECHERCHE = `        hits: Counter[str] = Counter()
        postings = self._build()
        for term in tokenize(query):
            for doc_id in postings.get(term, ()):
`;

// Correctif attendu de l'agent : index construit une fois, mis à jour par add().
export const CORRECTIF_INIT = `    def __init__(self, docs: dict[str, str]):
        self.docs = dict(docs)
        self.postings = self._build()

    def add(self, doc_id: str, text: str) -> None:
        self.docs[doc_id] = text
        for term in tokenize(text):
            self.postings[term].add(doc_id)
`;
export const CORRECTIF_RECHERCHE = `        hits: Counter[str] = Counter()
        for term in tokenize(query):
            for doc_id in self.postings.get(term, ()):
`;

const INDEX_JEUDI = INDEX_LUNDI.replace(
  `    def __init__(self, docs: dict[str, str]):
        self.docs = dict(docs)
        self.postings = self._build()
`,
  INDEX_JEUDI_AVANT,
).replace(
  `        hits: Counter[str] = Counter()
        for term in tokenize(query):
            for doc_id in self.postings.get(term, ()):
`,
  INDEX_JEUDI_APRES_RECHERCHE,
);

const TESTS_LUNDI = `import time

from search_service.index import Index

DOCS = {f"doc{i}": f"release notes {i} " + ("search latency" if i % 20 == 0 else "cache warmup") for i in range(4000)}


def test_finds_matching_documents():
    index = Index({"a": "Fast search", "b": "Slow disk", "c": "Search cache"})
    assert set(index.search("search")) == {"a", "c"}


def test_search_stays_fast():
    index = Index(DOCS)
    start = time.perf_counter()
    for _ in range(50):
        index.search("search latency")
    assert time.perf_counter() - start < 0.25
`;

const TESTS_JEUDI = `import time

from search_service.index import Index

DOCS = {f"doc{i}": f"release notes {i} " + ("search latency" if i % 20 == 0 else "cache warmup") for i in range(4000)}


def test_finds_matching_documents():
    index = Index({"a": "Fast search", "b": "Slow disk", "c": "Search cache"})
    assert set(index.search("search")) == {"a", "c"}


def test_picks_up_new_documents():
    index = Index({"a": "alpha"})
    index.add("b", "beta release")
    assert index.search("beta") == ["b"]


def test_search_stays_fast():
    index = Index(DOCS)
    start = time.perf_counter()
    for _ in range(50):
        index.search("search latency")
    assert time.perf_counter() - start < 0.25
`;

const README = `# search-service

Full-text search behind \`/api/search\`: an inverted index over the docs, ranked by matching terms.

\`\`\`sh
python3 -m pytest -q
\`\`\`
`;

/** Un commit daté de la semaine de démo (auteur fictif). */
function commit(
  dossier: string,
  fichiers: Record<string, string>,
  message: string,
  date: string,
  auteur: string,
): void {
  for (const [f, contenu] of Object.entries(fichiers)) {
    mkdirSync(path.dirname(path.join(dossier, f)), { recursive: true });
    writeFileSync(path.join(dossier, f), contenu);
  }
  const env = {
    ...process.env,
    GIT_AUTHOR_DATE: date,
    GIT_COMMITTER_DATE: date,
    GIT_AUTHOR_NAME: auteur,
    GIT_COMMITTER_NAME: auteur,
    GIT_AUTHOR_EMAIL: `${auteur.toLowerCase()}@example.com`,
    GIT_COMMITTER_EMAIL: `${auteur.toLowerCase()}@example.com`,
  };
  execFileSync("git", ["-C", dossier, "add", "-A"], { env });
  execFileSync("git", ["-C", dossier, "commit", "-q", "-m", message], { env });
}

/** Écrit search-service sous `work` : lundi l'index, mardi la doc, jeudi la régression (index reconstruit à chaque requête). */
export function semer(work: string): void {
  const dossier = path.join(work, "search-service");
  mkdirSync(dossier, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main", dossier]);
  commit(
    dossier,
    {
      "search_service/__init__.py": "",
      "search_service/tokenizer.py": TOKENIZER,
      "search_service/index.py": INDEX_LUNDI,
      "tests/test_index.py": TESTS_LUNDI,
    },
    "Add inverted index for /api/search",
    "2026-10-19T09:12:00Z",
    "Sam",
  );
  commit(dossier, { "README.md": README }, "Document how to run the tests", "2026-10-20T14:40:00Z", "Priya");
  commit(
    dossier,
    { "search_service/index.py": INDEX_JEUDI, "tests/test_index.py": TESTS_JEUDI },
    "Pick up documents added after startup",
    "2026-10-22T08:57:00Z",
    "Jordan",
  );
}
