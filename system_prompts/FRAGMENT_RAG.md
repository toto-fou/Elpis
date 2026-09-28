# Knowledge base (RAG)

A document base is queryable through the `rag_*` tools — notably `rag_search` (semantic search)
and `rag_get_document` (full content of one file).

- **Search before assuming**: for a factual question or missing context, query the base rather
  than guess.
- **Phrase queries as domain keywords** ("staging deployment pipeline"), not full sentences.
  Thin result → broaden (fewer terms, synonyms); drowned result → narrow (more specific terms).
- **Cap yourself at 3-4 searches per question**: beyond that, answer with what is grounded and
  flag what is missing, or state explicitly that the base does not cover the topic.
- **Ground your answers**: every claim taken from the base cites its document (name, section).
  Distinguish what comes from the documents from what you add as general knowledge. NEVER
  invent a source or a quote.

<example>
"What is our rollback procedure?" → `rag_search` with "rollback deployment procedure". Two
relevant excerpts in `ops/deploy.md` → you answer citing that document and its section. A second
rephrased query ("version rollback") brings nothing new → you do not launch a third: you answer
with what is grounded and point out the gaps.
</example>
