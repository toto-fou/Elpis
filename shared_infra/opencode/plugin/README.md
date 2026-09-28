# Plugin opencode « elpis-remote » (TypeScript natif)

Source canonique du plugin qui remonte/pilote les sessions opencode depuis la
page « Remote code » de l'app. **Aucune étape de build** : opencode tourne sur
Bun et charge les plugins `*.{ts,js}` nativement (glob vérifié dans le binaire
1.17.x) — le `.ts` est servi et installé tel quel.

| Fichier | Rôle |
|---|---|
| `elpis-remote.ts` | Plugin canonique (v9+), servi par `GET /api/code/plugin.ts`, installé en `~/.config/opencode/plugin/elpis-remote.ts` |
| `elpis-remote-bootstrap.js` | Shim de migration servi par `GET /api/code/plugin.js` : les anciens plugins `.js` (≤ v8) qui font `/remote update` l'écrivent à la place de leur `elpis-remote.js` ; au démarrage suivant il installe le `.ts`, délègue les hooks, puis **s'efface** |

`shared_infra/opencode/routes_code.py` lit ces fichiers à l'import, en PARSE la version
(`const PLUGIN_VERSION = N` — source unique de `_PLUGIN_CURRENT`) et refuse de
démarrer si le shim est désynchronisé du `.ts`.

## Règles à respecter en modifiant `elpis-remote.ts`

1. **Bump `PLUGIN_VERSION`** à chaque changement de comportement (c'est ce qui
   déclenche la proposition `/remote update` côté CLI, et les gates min-version
   de `code.py`).
2. Garder la **1re ligne** `// elpis-remote` et le littéral
   `const PLUGIN_VERSION = N` : les flux update (v8 sur plugin.js, v9+ sur
   plugin.ts) valident la réponse avec `startsWith` + regex avant d'écraser le
   fichier local.
3. **TypeScript « erasable » uniquement** (pas d'enum/namespace/décorateurs) et
   **aucun import** hors `node:*` — le fichier est autonome, sans node_modules.
4. **Budget perf** (la raison d'être de la v9 — testé par
   `tests/shared_infra/test_opencode_plugin_files.py` et le smoke) :
   - jamais de patch permanent de `process.stdout/stderr` ou `console.*` — le
     filtre anti-dump de `/remote` est armé ~4 s puis **restauré** ;
   - le hook `event` ne fait **jamais** d'`await` réseau (le bus d'events
     d'opencode attendrait) — les pushes passent par la chaîne sérialisée ;
   - remote inactif ⇒ zéro timer, zéro fetch, sorties immédiates.
5. HTTPS : l'app peut être derrière le frontal Caddy (cert LAN auto-signé,
   `deploy/caddy`) — `fetch` passe l'option `tls` de Bun (CA épinglée via
   `conf.ca_file`, posée par l'installeur, sinon repli `insecure` mémorisé).

## Vérifier

```bash
# types (dev, réseau requis pour npm) :
npx -y -p typescript tsc --noEmit --strict --target es2022 --module esnext \
    --moduleResolution bundler --skipLibCheck shared_infra/opencode/plugin/elpis-remote.ts
# structure + installeur (offline, dans la suite) :
pytest tests/shared_infra/test_opencode_plugin_files.py
# comportement sous Bun (runtime réel d'opencode) :
HOME=$(mktemp -d) bun tests/opencode_plugin/smoke.ts
```
