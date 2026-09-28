# Harnais de mesure perf frontend/backend

Mesure reproductible des lags d'animation et ralentissements, sans backend LLM :
le frontend est servi par `perf-server.mjs` (réplique `@include` + mocks API
même-origine, dont un **stream NDJSON cadencé** token-par-token — c'est le point
qui invalide tout mock `route.fulfill`, livré en un seul bloc).

## Lancer une campagne

```bash
node tests/perf/run.mjs --label baseline-20260612          # matrice complète (~15-20 min)
node tests/perf/run.mjs --label x --quick                  # smoke (3 cellules)
node tests/perf/run.mjs --label x --only a_stream_code     # un seul scénario
```

Comparer deux campagnes (médiane des runs par cellule, code retour 1 si
régression > 15 % sur TBT ou re-parses markdown) :

```bash
node tests/perf/compare.mjs --base baseline-20260612 --cand fix-render
```

Backend (app démarrée sur :8001, idéalement `PYTHONASYNCIODEBUG=1` pour les
slow callbacks asyncio dans les logs) :

```bash
venv/bin/python tests/perf/backend/measure_endpoints.py --label baseline-20260612
# endpoints authentifiés : --cookie "session=..."
```

## Scénarios

| | Quoi | Fenêtre mesurée |
|---|---|---|
| a_stream_code | stream ~9 Ko avec bloc python 200 lignes, 30/60/80 tok/s | envoi → fin du stream |
| b_stream_longchat | même stream dans un chat de 40 messages (virtualisation) | envoi → fin |
| c_open_longchat | ouverture d'un chat de 100 messages | clic → 1,2 s sans long task |
| d_ui_anim | sidebar, modale settings, scroll+copy-btn, barre de queue | sous-fenêtre par interaction |
| e_idle | repos 30 s (+ variante admin.html) | objectif 0 long task |
| i_boot | démarrage à froid : navigation → montage de Vue | FCP, DCL, montage, requêtes, octets, CPU par fichier, arrivée de la police |
| h_leak_cycles | N cycles d'un geste qui doit revenir au même état | pente par cycle du tas, des nœuds, des écouteurs, des timers |
| j_stream_scale | même flux dans des conversations de 40 et 400 messages | lignes rendues + ratios layout/script/tâches (hors matrice : lancé par `tests/frontend/stream-scale-verify.mjs`) |

Matrice : `reducedMotion ∈ {reduce, no-preference}` × `CPU ×1/×4` (l'OS de
l'utilisateur est en `reduce` ; les animations CSS ne s'expriment qu'en
`no-preference`). 3 runs sur la cellule primaire, médiane retenue.

## Métriques par run (JSON dans `results/<label>/`)

- `longTasks` : count / p50 / p95 / max / `tbtMs` (Σ max(0, durée−50)) — l'indicateur principal ;
- `fps` : deltas rAF (jamais échantillonné en idle) — mean, droppedPct (>25 ms), frozen (>700 ms) ;
- `markdown` : compteurs `marked.parse` / `hljs.highlight(Auto)` wrappés — 1 parse = 1 miss du cache LRU de renderMarkdown ;
- `cdp` : deltas `Performance.getMetrics` (ScriptDuration, LayoutDuration, RecalcStyleDuration, TaskDuration) — vérité terrain indépendante du GPU ;
- `intervals` : inventaire des `setInterval` créés (période + site d'appel) ;
- `requests` : requêtes réseau dans la fenêtre (détection des polls).

## Détection de fuites (`h_leak_cycles`)

Le principe : répéter N fois un geste qui doit revenir au **même état**, et
regarder si quelque chose reste. Le verdict se lit sur la pente de la
**seconde moitié** des relevés — le début de session alloue légitimement
(caches de rendu, langages hljs), et une lecture de bout en bout
diagnostiquerait une fuite à chaque campagne.

Trois modes de CONTRÔLE tournent avec les gestes réels, et c'est ce qui rend
le verdict lisible :

| mode | ce qu'il fait | relevé attendu |
|---|---|---|
| `temoin` | fuit exprès : 99 nœuds détachés + 1 écouteur + 1 intervalle par cycle | +99 / +1 / +1 — sinon l'instrument est aveugle |
| `repos` | rien | 0 partout : plancher de l'instrument |
| `saisie` | écrit dans le composeur, sans envoyer | **+1 nœud** par cycle |

Le troisième existe parce qu'il a failli produire un faux verdict. Le mode
`stream` montre +1 nœud par génération, parfaitement régulier sur 60 cycles :
c'est la comptabilité du navigateur autour du shadow DOM du placeholder d'un
`<textarea>`, pas l'application. **Tout geste passant par le composeur hérite
de cette pente sans en être responsable** — il faut la soustraire.

⚠ `tasMo` est la grandeur la moins fiable : le collecteur alimente lui-même
le tas (les PerformanceObserver retiennent leurs entrées, ~2,9 Ko par cycle
de génération) et V8 continue de compiler. Une pente de tas sans pente de
nœuds ni d'écouteurs ne prouve rien. Ce sont les compteurs entiers qui
tranchent.

## Le streaming ne doit pas dépendre de la longueur de la conversation

C'est la promesse que la virtualisation existe pour tenir, et rien ne la
vérifiait. `node tests/frontend/stream-scale-verify.mjs` (≈ 5 min, serveur de
harnais lancé à côté) streame la même réponse dans 40 puis 400 messages, en
entrelaçant les runs, et fait verdict sur :

1. le **nombre de lignes rendues**, borné quelle que soit la taille du chat —
   assertion déterministe, insensible à la charge machine ;
2. les totaux CDP (layout, script, tâches), avec des seuils larges : ils
   servent à attraper un ordre de grandeur, pas à mesurer finement.

Référence (2026-08-15, machine au repos, CPU ×4) : 30 lignes rendues dans les
deux cas, ratios 400/40 de 0,93 à 0,97 — le coût est plat. Vérifié en cassant
la virtualisation (`VS_THRESHOLD` porté à 100000) : 402 lignes, layout 4,16 s
contre 1,94, **23 fps contre 57** — les deux assertions échouent.

⚠ **Le TBT est hors verdict, et ne doit pas servir à comparer.** Sur ces
courses il varie de 363 à 2307 ms pour une charge identique. Ce sont les
totaux CDP et le nombre de lignes qui sont stables.

## Pièges connus

1. **Pas de GPU sur la VM** (SwiftShader) : comparer baseline/candidat en
   relatif, jamais conclure en absolu sur le coût compositing/blur.
2. Le sampler rAF n'est JAMAIS actif en idle (il créerait lui-même de
   l'activité, et sans frames les deltas géants seraient du faux jank).
3. `reducedMotion` est TOUJOURS forcé par `newContext`, jamais hérité de l'OS.
4. Les mesures se font sur la VM partagée : 3 runs, médiane, commit + ts
   stockés dans chaque JSON. ⚠ **Vérifier la charge AVANT de conclure** :
   `uptime` plus un delta de `/proc/stat`. Une campagne lancée pendant qu'un
   worker applicatif brûlait un cœur a donné 42-45 fps et 14-22 % de frames
   perdues sur le streaming ; les mêmes courses au repos donnent **56-57 fps
   et 3 %**. Un chiffre pris sur une machine chargée ne dit rien de l'appli.
5. Le serveur écoute sur **8901** (le harnais fonctionnel historique de
   /tmp/fe-harness occupe 8899).
6. `wrapLibs` doit être appelé après le chargement (les vendors sont des
   `<script>` classiques ; `marked.use()` mute l'instance sans remplacer `parse`).
