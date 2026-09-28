# Smoke comportemental du plugin elpis-remote (sous Bun)

`smoke.ts` exécute le plugin **dans son vrai runtime** (Bun, comme opencode) :
faux serveur app (`Bun.serve` : ingest/pull/hello/plugin.ts) + faux client
opencode, et vérifie les invariants v9 — aucun patch stdout/stderr au repos,
filtre armé/restauré autour de `/remote`, hook `event` non-bloquant, coalescing
du streaming, commandes du pull, bye, et la migration du shim `.js → .ts`
(y compris « pas de 2e instance si le `.ts` est déjà chargé »).

Hors pytest : Bun n'est pas présent sur les VM offline. À lancer à la main
après toute modification du plugin :

```bash
npm i --no-save bun          # ou installation bun locale
HOME=$(mktemp -d) ./node_modules/.bin/bun tests/opencode_plugin/smoke.ts
```

Le `HOME` jetable est OBLIGATOIRE (le script refuse sinon) : le plugin écrit
`~/.config/opencode/elpis-remote.json` et le scénario bootstrap manipule
`~/.config/opencode/plugin/`.
