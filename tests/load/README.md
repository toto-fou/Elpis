# Harnais de tests de charge

Met l'application sous pression **avant** que les utilisateurs ne le fassent, et
transforme ce qu'on y voit en garde-fou. Une campagne lance une instance
jetable (config, base et bacs à sable dans un dossier temporaire), y envoie des
utilisateurs simulés, puis confronte le résultat à des budgets.

```bash
venv/bin/python tests/load/run.py                          # tous les scénarios
venv/bin/python tests/load/run.py --scenario connexion
venv/bin/python tests/load/run.py --utilisateurs 24 --duree 40 --workers 3
venv/bin/python tests/load/run.py --scenario fichiers --fichiers-sandbox 500
venv/bin/python tests/load/run.py --comparer avant apres   # deux campagnes
```

Code de retour **1** si un budget est dépassé : le harnais peut donc servir de
garde-fou de non-régression, pas seulement d'outil d'observation.

## Isolation

Rien de ce qui tourne ici ne touche les données réelles. `instance.py` pose
explicitement `APP_CONFIG_PATH`, `APP_DB_PATH`, `APP_SANDBOX_DIR` et un secret
de session neuf ; `LLAMA_PORT=1` fait échouer vite toute tentative de joindre un
moteur LLM. L'instance vit dans `.load-instance/` et est recréée à chaque
campagne.

Le serveur est un **vrai gunicorn multi-worker**, avec la configuration du
dépôt. C'est le seul moyen de voir ce qui ne se voit qu'entre process :
contention du verrou d'écriture SQLite, verrous de présence, bus d'événements
sur fichier.

## Scénarios

| scénario | mécanisme partagé mis sous tension |
|---|---|
| `connexion` | la boucle d'événements du worker (CPU dans un handler `async`) |
| `connexion-refusee` | idem, mais sans limitation de débit devant (le rate-limit du login a été retiré volontairement) |
| `lecture` | cache de config, pool SQLite, assemblage des pages |
| `ecriture` | le verrou d'écriture SQLite — **unique pour tous les workers** |
| `fichiers` | le disque local : arborescence, grep, mémoire (routes synchrones) |
| `evenements` | le bus d'événements sur fichier et ses abonnés SSE |
| `mixte` | tout à la fois, dans des proportions plausibles |

## Le témoin — la mesure qui compte

Tous les scénarios font tourner en parallèle un **témoin** : un client déjà
authentifié qui appelle `/api/me-lite` toutes les 50 ms. Il ne mesure pas « le
geste sous charge est-il lent » mais « **les autres utilisateurs ont-ils subi la
charge de celui-là** ».

C'est lui qui a rendu visible le défaut le plus grave trouvé par ce harnais :
pendant une rafale de connexions, le témoin n'obtenait que **7 réponses en
10 secondes, avec une médiane à 1392 ms**. Le hachage PBKDF2 (87 ms) s'exécutait
sur la boucle d'événements. Après correction : 92 réponses, médiane 20 ms.

## Lire un rapport

```
  geste                             n  éch.   req/s     p50      p95      p99      max
  GET / (page)                   4610     0   109.2   114.1    167.8    207.6    497.2
  témoin /api/me-lite             434     0    10.3    26.5     55.7     71.9    176.9
  montée en régime (1re moitié) : rss_mo +84.7  fds +40  threads +16
  dérive en régime établi (2e moitié) : rss_mo +8.3  fds +15  threads +6
  CPU du serveur : médiane 58.5 % | pic 65.1 % (100 % = machine entière)
```

- **Les échecs sont classés par famille**, jamais comptés en bloc : « 3 %
  d'erreurs » ne se corrige pas, « 14 × database is locked » se corrige.
- **La dérive de ressources est lue sur la seconde moitié**, pas de bout en
  bout. La montée en charge produit toujours un gros chiffre — sur une course
  de 150 s en lecture, le RSS monte de 439 à 507 Mo en 12 s puis se fige à
  541 Mo. Prendre l'écart total, c'est annoncer une fuite à chaque campagne.
- **Le CPU est indispensable pour lire le reste.** Sans lui, une latence qui
  monte ressemble toujours à une file d'attente qu'on pourrait élargir. Une
  file limitée par le CPU, élargie, **empire**.

## Pièges appris à l'usage

1. **Attendre le régime avant de mesurer.** Répondre à `/api/health` ne veut pas
   dire « prêt » : le préchauffage du pool MCP lance ensuite un sous-process
   d'environ 80 Mo **par worker**. Sans `attendre_stabilisation()`, la première
   sonde tombe avant eux et la campagne annonce 200 Mo de fuite imaginaire.
2. **Ne comparer qu'à l'intérieur d'une même campagne.** Une instance fraîche
   rend ~120 req/s là où la même instance chaude en rend ~165. L'écart entre
   deux instances peut dépasser l'effet qu'on cherche à mesurer.
3. **Un client de charge ne rejoue rien.** `httpx` remonte les requêtes perdues
   sur une connexion keep-alive coupée ; les navigateurs, eux, en rejouent une
   partie (RFC 7230 §6.3.1). Le harnais est donc plus sévère que la réalité —
   c'est voulu, mais il faut le savoir avant de conclure.
4. **`--utilisateurs 60` sur `fichiers` est une sonde de SATURATION**, pas un
   régime nominal : à ce niveau le budget du témoin est dépassé par
   construction. La campagne par défaut tourne à 12.

## Budgets

`budgets.py` porte des propriétés **structurelles**, pas des chronos absolus :
la machine de mesure varie, la propriété non.

- le témoin ne doit pas subir la charge des autres (p99 < 400 ms) ;
- aucun geste ne doit échouer au-delà de 0,5 % ;
- certaines familles d'échec invalident la campagne quoi qu'il arrive
  (`database is locked`, délai dépassé, connexion coupée) ;
- pas de dérive de descripteurs, de threads ni de mémoire **en régime établi**.

## Ce que ce harnais a trouvé

| trouvaille | symptôme | correctif |
|---|---|---|
| PBKDF2 sur la boucle d'événements | témoin à 1392 ms de médiane pendant les connexions | pool de threads dédié (`shared_infra/accounts/passwd.py`) |
| `max_requests=2000` | 9 requêtes perdues, −21 % de débit, `GET /` jusqu'à 5 s | seuil porté à 50 000, jitter garde-fou |
| `resolve()` par entrée dans l'arbre des fichiers | 43,5 ms pour 520 entrées, ×18 sous charge | borne par récurrence : 3,4 ms |
| débit décroissant au-delà de 16 utilisateurs à 58 % de CPU | le GIL, pas le processeur | `APP_WORKERS` (+26 à +33 % de débit à 6 workers) |
