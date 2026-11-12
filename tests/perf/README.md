# Harnais de mesure perf frontend/backend

Mesure reproductible des lags d'animation et ralentissements, sans backend LLM :
le frontend est servi par `perf-server.mjs` (réplique `@include` + mocks API
même-origine, dont un **stream NDJSON cadencé** token-par-token — c'est le point
qui invalide tout mock `route.fulfill`, livré en un seul bloc). Comme le core,
il sert les entrées Vite construites (`<!-- @entree -->`) : lancer
`npm run build -w @elpis/web` avant une mesure, sinon il refuse la page.

## Lancer une campagne

```bash
node tests/perf/run.mjs --label baseline-20260612          # matrice complète (~15-20 min)
node tests/perf/run.mjs --label x --quick                  # smoke (7 cellules, dont 150 et 250 tok/s)
node tests/perf/run.mjs --label x --only a_stream_code     # un seul scénario
node tests/perf/run.mjs --label x --quick --runs 3         # N runs par cellule (médiane)
node tests/perf/run.mjs --label x --quick --versionner     # écrit dans baselines/<label> (suivi par git)
```

Chaque campagne écrit `_meta.json` : commit, frontend modifié ou non, version
de Chromium, machine (`nproc`, RAM, charge et `/proc/stat` au début et à la
fin), serveur, politique de cache et throttling CPU. `ELPIS_CHROMIUM` impose le
binaire du navigateur (même binaire pour baseline et candidat).

Baseline du chantier frontend TS (avant toute conversion) :
`baselines/frontend-ts-baseline/`. Candidat d'un lot, comparé à elle :

```bash
ELPIS_CHROMIUM=/opt/pw-browsers/chromium node tests/perf/run.mjs --label frontend-ts-candidat --quick --runs 3
node tests/perf/compare.mjs --base frontend-ts-baseline --cand frontend-ts-candidat
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

## Profiler et comparer à conditions égales

```bash
(cd frontend && npx vite build --sourcemap)                 # mesure seulement : .map voisines, jamais livrées
node tests/perf/run.mjs --label p --quick --runs 2 --only f_stream_tools --trace /tmp/profils
node tests/perf/profil.mjs /tmp/profils --filtre f_stream_tools --top 30   # self/total par fonction et par source
node tests/perf/ab.mjs --a /arbre/A --b /arbre/B --only a_stream_code --n 3 --label ab-x   # puis A et B permutés
```

- `--trace` ralentit la page (échantillonnage à 100 µs) : ses runs ne servent qu'à localiser, jamais à mesurer.
- Deux campagnes lancées à des heures différentes ne se comparent pas à ±30 % près : la VM partage son hôte (temps volé
  dans `/proc/stat`), l'ancien front relancé le 14/10 donnait +55 % de TBT sur sa propre baseline du 12/10. Pour juger un
  correctif, `ab.mjs` alterne A et B sur deux ports ; lancer les deux ordres (le second côté d'une paire paie quelques %).
- `cdp.ScriptDuration` ne compte que le JS lancé depuis une tâche (minuteries, événements, rAF), pas celui des
  microtâches, où tourne la lecture du flux (`for await`) : sur `f_stream_tools`, ≈ 0,8 s contre ≈ 5,5 à 7,7 s de JS en
  microtâches (trace `devtools.timeline`). `TaskDuration` (tout le thread principal) est le total à suivre.

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
| k_stream_fluidite | une réponse Markdown de 3,7 Ko (repère tous les ~120 car.) sur le **vrai cœur** et un faux moteur | image par image, lu après la peinture : cadence, délai reçu → affiché, suivi du bas, fin de tour (hors matrice : lancé par `tests/frontend/stream-fluidity-verify.mjs`) |

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

## Fluidité du flux (`k_stream_fluidite`)

Le faux serveur ne dit rien de ce que voit un lecteur : cadence du texte, retard sur le flux, tenue du bas du fil,
fin de réponse. Ce scénario lance le **vrai cœur** (`demarrerCoreReel`, faux moteur : seul le cœur envoie une fin de
tour complète) et mesure une réponse de 3,7 Ko de Markdown typique (paragraphes, titre, liste lâche avec sous-listes,
bloc Python de 39 lignes, tableau, citation, bloc sans langage) dont un repère unique (`zq001`, …) revient tous les
~120 caractères : il date l'arrivée du texte dans le flux et son affichage. Le front doit être construit
(`npm run build -w @elpis/web`) ; `ELPIS_NODE_MODULES` désigne le `node_modules` qui contient Playwright.

```bash
node tests/frontend/stream-fluidity-verify.mjs --label base --cpu 4 --runs 2          # deux passes, résumé par passe
node tests/frontend/stream-fluidity-verify.mjs --label lot --cpu 4 --runs 3 --ref /chemin/arbre-de-reference --verdict
node tests/frontend/stream-fluidity-verify.mjs --label cout --ref /chemin/ref --sans-echantillonneur --runs 4 --tache-max 0.7
```

| Option | Effet |
|---|---|
| `--cpu N` · `--toks N` · `--rm reduce\|no-preference` | ralentissement du processeur (4), jetons par seconde (60), mouvement réduit (`reduce`) |
| `--burst MS` | le flux est relâché toutes les MS par une enveloppe de `fetch` dans la page (proxy, fournisseur distant) |
| `--pensee` | une phase de réflexion précède la réponse |
| `--remonter` · `--frappe` | l'utilisateur remonte le fil au milieu du flux · tape dans le composeur pendant le flux |
| `--suite` | mesure le deuxième message d'une conversation (le premier, « Bonjour », sert d'amorce) |
| `--runs N` · `--label NOM` · `--skin NOM` · `--trace` | passes · dossier `results/NOM/` (un JSON par passe, une ligne de résumé par passe) · skin du compte · décompte des phases de rendu (ralentit la page) |
| `--arbre CHEMIN` · `--ref CHEMIN` | arbre mesuré (défaut : celui du lanceur) · arbre de référence : les passes alternent référence, candidat, référence… et une table de médianes les compare |
| `--sans-echantillonneur [--fenetre S]` | coût du fil principal sur S secondes du milieu du flux (CDP seul), sans lecture par image |
| `--verdict` · `--tache-max R` | code de sortie non nul si une cible du plan n'est pas tenue · avec `--ref`, tâches du fil principal du candidat ≤ R × référence |

Chaque ligne de résultat vient d'une lecture **après la peinture** de l'image (un message `MessageChannel` posté depuis
`requestAnimationFrame` : lire dans le rappel verrait l'état d'avant les `ResizeObserver`).

| Mesure | Cible (plan de fluidité, section 3) | Lecture |
|---|---|---|
| mises à jour par seconde ; caractères par mise à jour (p95) | ≥ 40 et ≤ 6 (≥ 30 et ≤ 12 à 150 jetons/s) | images où la longueur du texte affiché change pendant le flux |
| reçu → affiché | médiane ≤ 35 ms, p95 ≤ 70 ms | date de lecture d'un repère dans le flux (enveloppe de `fetch`) et première image peinte qui le contient |
| écart entre deux mises à jour tant que du texte attend | p95 ≤ 50 ms avec `--burst` | longueur rendue du texte reçu, interpolée entre les repères, moins le texte affiché (tolérance 8 car.) |
| images à plus de 4 px du bas ; reculs | 0 ; 0 | distance au bas du conteneur du fil (parent de `.elpis-chat-col`) lue après chaque peinture |
| images par seconde ; images de plus de 25 ms | ≥ 57 ; ≤ 2 % | échantillonneur du collecteur (`__perfStartFrames`) |
| balisage brut | 0 | images en flux dont un bloc hors code contient `**`, un accent grave, ou finit par un marqueur de bloc seul (`#`, `-`, `1.`, `\|`) |
| tâche longue après `final` | aucune de plus de 50 ms | `PerformanceObserver` `longtask`, de la réception de `final` à +2,5 s |
| décalage des blocs à la fin | 0 px (1 px d'arrondi) | position de chaque `pre`, titre, tableau et citation à la réception de `final` et 2,5 s après |
| structure identique avant et après | oui | suite des étiquettes de premier niveau (enveloppes `display: contents` traversées) : l'état d'avant doit être un préfixe de l'état final |
| frappe → peinture pendant le flux, p95 | ≤ 48 ms | Event Timing, seuil de 16 ms : seuls les événements plus lents sont comptés |
| tâches du fil principal | −30 % puis ≤ référence | `--ref` avec `--tache-max`, ou `--sans-echantillonneur` |

Le JSON de chaque passe garde aussi les jalons d'envoi (bulle de l'utilisateur, bulle de l'assistant, premier
indicateur, premier texte), `document.getAnimations()` au milieu du flux, et autour de `final` : tâches longues, pire
image, nombre de nœuds, étiquettes de premier niveau et position des blocs avant et après.

Référence (2026-11-12, code inchangé de `devs/main`, deux passes par colonne, machine partagée à ~3,5 de charge) :

| | CPU ×4 | CPU ×1 |
|---|---|---|
| mises à jour par seconde | 7,6 · 7,6 | 8,2 · 8,1 |
| caractères par mise à jour, médiane (p95) | 20 (32) · 20 (30) | 18 (29) · 18 (31) |
| reçu → affiché, médiane / p95 (ms) | 64 / 147 · 62 / 149 | 49 / 125 · 59 / 123 |
| images à plus de 4 px du bas | 0,6 % · 0,6 % | 0,2 % · 0,3 % |
| tâche longue après `final` (ms) | 368 · 414 | 101 · 95 |
| pire image à la fin (ms) | 420 · 473 | 114 · 109 |
| balisage brut (images, sur ~1 400) | 16 · 23 | 28 · 37 |
| corps à la fin | 87 → 160 nœuds, 20 → 14 blocs, `pre` +31 px chacun, dernier bloc +64 px | idem |

La seule animation en cours au milieu du flux est `elpis-run-dot` (`box-shadow`, sur le fil principal).

Pièges propres à ce scénario :

- **Pas de GPU sur la VM** : la composition et le flou ne se mesurent pas (voir plus bas) ; le coût d'une animation se
  lit sans échantillonneur (`--sans-echantillonneur`).
- **L'échantillonneur coûte du fil principal** (≈ 1,9 s sur 11,9 s de fil occupé à CPU ×4) : les temps absolus ne se
  comparent qu'entre passes du même banc.
- **Alterner référence et candidat** (`--ref`) : un autre processus de la machine décale les temps de 30 % et plus, d'une
  campagne à l'autre comme d'une passe à l'autre ; ne juger qu'une table de médianes de passes alternées, et relancer
  dans l'ordre inverse si l'écart est faible.
- Les cibles se lisent sur la réponse du banc à CPU ×4 et 60 jetons/s ; les cibles de la section 3 s'appliquent aussi à
  CPU ×1 (plus faciles à tenir).
- Les blocs sont repérés par leurs enveloppes `display: contents` **ou** directement : la forme du corps peut changer
  sans casser le banc. Le corps en flux est reconnu à `aria-busy="true"`.
- Le cœur et son faux moteur sont démarrés par `tests/frontend/lib/core-reel.mjs` de l'arbre mesuré, avec une clé de
  coffre jetable (`ELPIS_VAULT_KEY_PATH` de l'environnement si elle est donnée) et `ELPIS_AUDIT_KEY_PATH=/nonexistent` par
  défaut : jamais les clés de la machine.

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
7. **Le faux serveur termine ses tours.** Son événement `final` porte les champs
   obligatoires du contrat du flux (`chat_id`, `run_ids`, `persisted`) : le message
   quitte l'état de flux et passe par le rendu final. Une campagne faite avec un
   `final` incomplet (toutes les baselines versionnées de `baselines/` en datent) ne
   comptait ni la coloration, ni le rendu final, ni l'enrichissement du message dans
   les scénarios `a_stream_code`, `b_stream_longchat`, `f_stream_tools` et
   `g_compress_burst` : elle ne se compare plus à une campagne récente sur la fenêtre
   complète (TBT, tâches, `hljs`). Refaire la référence avec le même arbre avant
   de juger un correctif.
