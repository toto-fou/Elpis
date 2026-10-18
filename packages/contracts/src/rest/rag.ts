// SPDX-License-Identifier: MIT
/** packages/contracts/src/rest/rag.ts — collections vues par le service RAG (`/api/rag/collections`), liste vide sur toute panne. */
import { z } from "zod";

export const schemaReponseCollectionsRag = z.object({ collections: z.array(z.unknown()) });
