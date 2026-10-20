# Flux d'un tour de chat

`POST /api/chat-saved-stream3` (`apps/core/src/familles/chat.ts`) génère un tour en flux NDJSON. La route
n'enchaîne que des étapes :

1. admission (`admettreTour` de `apps/core/src/tour/ouverture.ts`, aides de `apps/core/src/tour/admission.ts`) :
   409 si une compression manuelle ou une génération tourne déjà sur la conversation, 429 au-delà du plafond
   d'exécutions du compte ;
2. préparation (`apps/core/src/tour/preparation.ts`) ;
3. verrou de présence, recalage de la base après une passation, réservation du verrou ;
4. le tour (`apps/core/src/tour/execution.ts`), pompé par `apps/core/src/tour/evenements.ts`.

Le réveilleur des tâches de fond (`apps/core/src/jobs/service.ts`) ouvre aussi des tours, par la même
`ouvrirTour` : message de réveil en rôle `user` (`origin: "job_wake"`), `data` construit côté serveur, run
reprenable consommé sans client, au plus `wake_concurrency` (1) à la fois par compte.

Un corps qui porte `image_gen` est un tour « Images » (`apps/core/src/tour/image.ts`), après les mêmes gardes. Les
autres routes du chat :

- `apps/core/src/familles/chat-controle.ts` : Stop, état, rattachement à un run par
  `apps/core/src/tour/suivi-run.ts` ;
- `apps/core/src/familles/chat-compression.ts` : compression manuelle.

## Invariants à garder dans toute refonte

- **Un tour à la fois par conversation** : verrou de présence en mémoire, un seul process main
  (`apps/core/src/tour/etat.ts`). Une compaction ou une génération déjà en cours rend 409, trop d'exécutions du
  compte 429.
- **Verrou de présence jamais perdu** : toute exception entre sa prise et l'ouverture du flux le relâche. Il est
  ensuite réservé jusqu'à ce que le tour le réclame, et un filet le relâche si personne ne le réclame. Perdu, il
  rendrait 409 sur ce chat jusqu'au redémarrage.
- **Adresses des serveurs MCP** : résolues côté serveur à la préparation, jamais reprises du client.
- **Annulation** : par l'AbortSignal du tour (Stop : drapeau, contrôleur abandonné, session du moteur arrêtée),
  jamais par les événements système (vérifié par les tests des mainteneurs). Le partiel est enregistré.
- **Client déconnecté** : le run se détache s'il est reprenable (`resumable`), si un outil a déjà tourné ou si
  `llm.detach_run_on_disconnect` est actif ; sinon il s'arrête en enregistrant le partiel. Un Stop l'arrête
  toujours. On s'y rattache par `GET /api/chat/{id}/run/events`, y compris après un redémarrage
  (`apps/core/src/tour/journal-run.ts`).
- **Enregistrement optimiste** sur `updated_at` (`apps/core/src/tour/persistance.ts`) : un conflit est signalé, rien
  n'est écrasé. La persistance précède `kv_cache` et `final`.
- **Types du flux NDJSON** : registre `packages/contracts/src/stream-events.gen.ts`.
- **RAG et cache du préfixe** (`apps/core/src/rag/chat.ts`, `apps/core/src/rag/outils-chat.ts`) : la tête système ne
  dépend jamais des collections actives (outils `rag_*` et `FRAGMENT_RAG` statiques ; seuls 0 → 1 et 1 → 0 collection
  changent la liste d'outils) ; le bloc `<rag_context>` est un suffixe de la question du tour où la sélection change,
  enregistré dans `llm_user_suffixes` et rejoué à l'identique ; les passages n'arrivent que par les résultats
  d'outils, numérotés une fois pour toutes ; les sources du message (`rag_sources`) ne repartent jamais au modèle.
- **Chemin outils seul** : le chemin classique sans outils de la version Python n'est pas repris.

## Ordre des événements d'un tour

Ordre figé par les scénarios `flux_route_outils_*` des tests des mainteneurs (dépôt de développement), qui relisent
aussi ce bloc : chaque scénario doit s'y conformer, étape après étape, sans retour en arrière. Une ligne donne une étape et ses
types ; `<boucle>` désigne les autres événements de la boucle
(`LOOP_EVENTS` du registre) : un type cité dans le bloc n'est permis qu'à ses étapes.

```ordre-du-flux
1 mode
2 queue_status thinking
3 queue_cleared
4 mode <boucle>
5 kv_cache error
6 final
```

1. **`mode`** : serveurs MCP actifs et/ou « Documents » (collections RAG actives dans le chat).
2. **Attente du moteur** :
   - `queue_status` si le moteur n'est pas prêt ;
   - `thinking` « En attente… » si la requête doit attendre un créneau du serveur ;
   - d'autres `queue_status` pendant l'attente.
3. **`queue_cleared`** : seulement si un `queue_status` est parti.
4. **Boucle** : `mode` « Outils prêts… », puis les événements de la boucle (`tool_call`, `tool_result`, jetons,
   compression, `rag_sources` après un outil `rag_*` qui a numéroté des passages…).
5. **Fin du travail** : `kv_cache` si l'occupation du contexte a pu être mesurée ; `error` en cas de panne.
6. **`final`** : réponse, métriques, `persisted` et `rag_sources` (sources du message, `cited` posé d'après la
   réponse), puis fin du flux.

Ce qui peut s'intercaler, et les variantes :

- **`ping`** : à tout moment, quand le flux est inactif.
- **Chargement d'un modèle** : le suivi (`evenements.ts`) republie `queue_status` à chaque pas, puis émet son propre
  `queue_cleared`, n'importe où tant que le chargement dure.
- **Panne** : `error`, puis un `final` partiel.
- **Stop pendant l'attente** : un `final` partiel (scénarios `flux_route_outils_stop_file*`).
- **Stop pendant la génération** : plus aucun événement, sauf le `final` partiel et le `task_step` `status=final`
  d'un sous-agent (état terminal de sa ligne).
