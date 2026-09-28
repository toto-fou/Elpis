# HTTPS via Caddy (LAN, sans domaine, « actionless » côté client)

Elpis est servi en HTTP direct par gunicorn (`:8001` main, `:8002` admin,
`:8000` RAG). Ce dossier fournit le frontal TLS : un Caddy local en
systemd + une PKI locale **stable** générée côté serveur. Aucun domaine,
aucun Let's Encrypt, et **rien à installer sur les postes clients**.

## Côté client : juste se connecter

L'utilisateur tape `https://<ip>` — ou même juste `<ip>` (le port 80
redirige). À la **première** connexion, le navigateur affiche
l'avertissement « connexion non sécurisée » (certificat local inconnu) :
**« Avancé » → « Accepter le risque et continuer »**. Un clic, une fois
par poste et par port (443, 8443 pour l'admin) — le certificat étant
stable 10 ans, l'avertissement ne revient jamais.

> Pourquoi cet unique avertissement est inévitable : sans domaine public,
> aucun navigateur ne peut faire confiance d'office à un certificat —
> c'est le modèle PKI lui-même, rien côté serveur ne peut le contourner.
> Le trafic est chiffré dans tous les cas.
>
> D'où le choix de certs openssl stables plutôt que `tls internal` de
> Caddy : ce dernier fait tourner ses certificats toutes les 12 h, ce qui
> ferait revenir l'avertissement à chaque rotation.

**Optionnel** — pour supprimer même ce premier avertissement (cadenas
propre) : importer `http://<ip>/ca.crt`. Firefox : Paramètres → Vie
privée et sécurité → Certificats → Afficher les certificats → Autorités →
Importer → cocher « Confirmer cette AC pour identifier des sites web ».

## Architecture

```
navigateur ──https──▶ Caddy (même hôte, catch-all) ──http 127.0.0.1──▶ services
   :443  ─────────────────────────────────────────▶ 127.0.0.1:8001  (main)
   :8443 ─────────────────────────────────────────▶ 127.0.0.1:8002  (admin)
   :8444 ─────────────────────────────────────────▶ 127.0.0.1:8000  (UI RAG)
   :80   ─ redirige 302 vers https + sert /ca.crt (import optionnel)
         └ EXCEPTION @bootstrap : installeurs servis EN CLAIR ─▶ :8001
```

Sites Caddy en **catch-all** : n'importe quelle IP/nom joignant la
machine fonctionne, sans reconfiguration. Main et admin partagent le même
hostname (ports différents) → le cookie de session host-scopé reste
partagé (un login sur l'app vaut pour la console admin).

Caddy tourne **en permanence** ; le passage HTTPS ↔ HTTP direct se pilote
depuis la console admin (Configuration → Accès HTTPS) qui bascule les
binds gunicorn `0.0.0.0` ↔ `127.0.0.1` puis redémarre l'app. Mode HTTPS
coupé : Caddy continue de marcher en parallèle, inoffensif.

## Installation (tout côté serveur)

```bash
sudo ./install_caddy.sh                       # détection auto des IP
sudo ./install_caddy.sh 10.0.0.7 elpis.lan    # SANs supplémentaires si besoin
```

Le script : installe caddy (voir « Bundle offline » ci-dessous), détecte
les IPv4 (`hostname -I`) + le hostname, génère la PKI dans
`/etc/caddy/elpis-pki/` (CA 10 ans jamais régénérée ; cert serveur 10 ans
ré-émis **uniquement** si la liste de SANs change), pose le Caddyfile,
valide, démarre. Idempotent : re-lancer ne casse jamais les exceptions
déjà acceptées par les navigateurs.

Nouvelle IP LAN : re-lancer simplement le script (la CA ne bouge pas ;
seuls les postes en mode « exception » reverront un avertissement, une
fois).

## Amorçage des installeurs (en clair, volontairement)

Les one-liners d'installation (OpenCode, agent desktop) tournent sur une
machine qui **ne connaît pas encore** la CA locale. Tant qu'ils partaient
en https, la commande devait neutraliser elle-même la vérification du
certificat : côté Windows, un préambule d'environ 400 caractères (TLS 1.2
forcé + callback C# compilé) dont l'échec — toujours le même message,
« The underlying connection was closed » — dépendait de la version de
.NET installée. Commandes illisibles, et instables.

Le site `:80` fait donc une **exception** (matcher `@bootstrap`) : les
routes d'installation, publiques et sans secret, sont relayées en clair
vers `:8001` au lieu d'être redirigées. Tout le reste redirige comme
avant. Les commandes redeviennent :

```bash
curl -fsSL http://<ip>/opencode | bash     # OpenCode (Linux/macOS)
curl -fsSL http://<ip>/agent    | bash     # agent desktop (Linux)
```
```powershell
iex(irm http://<ip>/opencode.ps1)          # OpenCode (Windows)
iex(irm http://<ip>/agent.ps1)             # agent desktop (Windows)
```

Le script téléchargé, lui, récupère la CA (`http://<ip>/ca.crt`) et
l'**épingle** dans la config du plugin `elpis-remote` : ce qui parlera
ensuite à l'app le fait en https **vérifié** — meilleur que l'ancien
repli `-k`. Le compromis se limite donc à l'amorçage : sur un LAN de
confiance, un binaire téléchargé en clair équivaut au `-k` d'avant (ni
l'un ni l'autre n'authentifie le serveur), pour une commande sans piège.

> Ne rien ajouter à `@bootstrap` qui exige une session ou expose un
> secret : c'est la seule porte non chiffrée du frontal. Le contrat est
> verrouillé par `tests/shared_infra/test_install_bootstrap_contract.py`.

## Bundle offline (.deb vendorisés)

Sur une machine connectée (la VM de dev convient), **une fois** :

```bash
deploy/caddy/fetch_caddy_debs.sh    # vendorise caddy + deps dans deploy/caddy/debs/
```

Les `.deb` voyagent ensuite avec le dossier de l'app (gitignorés, comme
les wheels Python — transférez par copie de dossier, pas par git clone).
`install_caddy.sh` les détecte et les installe **sans réseau**, en ne
posant que ce qui manque sur la cible (jamais de downgrade d'une lib de
base déjà présente) ; sans bundle, il retombe sur apt en ligne. openssl
est présent de base sur Debian — rien d'autre à prévoir.

Si le fetch affiche « dépendance non vendorisée » (index apt périmé →
404) : ces libs de base (libc6…) sont de toute façon présentes sur toute
Debian ; pour un bundle complet, `sudo apt-get update` puis relancez.

## Points de vigilance

- **Après déploiement de cette feature, relancer l'app une fois**
  (`./elpis stop && ./elpis start`) avant le premier toggle : le re-bind à chaud
  repose sur `reuse_port` + hook `on_reload` des confs gunicorn — un
  master encore lancé avec les anciennes confs (ou avec `BIND` en env)
  ne rebindera pas au SIGHUP.
- **Pas de HSTS, redirect :80 en 302** : voulu — le retour en HTTP direct
  via le toggle admin doit rester possible. Ne pas « durcir ».
- **Le bloc `@bootstrap` doit rester AVANT le `handle {}` catch-all** du
  site `:80` : les `handle` sont mutuellement exclusifs et évalués dans
  l'ordre d'écriture — placé après, le catch-all avalerait les
  installeurs et les commandes repartiraient en https (donc longues).
  Après mise à jour du Caddyfile : `sudo deploy/caddy/install_caddy.sh`.
- **Ne jamais régénérer la CA** (`/etc/caddy/elpis-pki/ca.*`) : les
  postes qui l'ont importée perdraient la confiance. Le script la
  préserve ; ne pas supprimer le dossier à la main.
- **Ports en double** : `443/8443/8444` existent dans le Caddyfile ET
  dans `config.json › security.https.{main_port,admin_port,rag_port}`
  (garde anti-lockout du toggle + synthèse d'URLs). Les garder alignés.
- **`security.https` appartient au toggle, à personne d'autre.** L'éditeur
  « Config principale » de la console renvoie config.json ENTIER : sans
  précaution, une sauvegarde faite depuis un formulaire chargé *avant* la
  bascule remettait `enabled: false`. Rien ne se voyait tant que l'app
  tournait (le bind vit en mémoire) ; au redémarrage suivant gunicorn
  rebindait `0.0.0.0` et l'app répondait en clair sur `:8001`/`:8002`
  pendant que Caddy servait toujours du https. `routes/admin/config.py ›
  _OWNED_PATHS` restaure désormais ces chemins depuis le disque, dans les
  deux sens : **activer le HTTPS par l'éditeur brut ne marche pas non plus**
  — il faut le toggle, qui sonde Caddy avant d'écrire.
- **Break-glass** (app injoignable, ex. Caddy mort alors que le mode
  HTTPS est actif → binds en loopback) :
  - soit relancer temporairement en bind ouvert :
    `BIND=0.0.0.0:8001 gunicorn -c server/gunicorn_conf.py server.app:app`
    (l'env `BIND` est prioritaire sur le toggle) ;
  - soit éditer `config.json` (racine du dépôt) → `security.https.enabled: false`
    (+ `security.session.https_only: false`) et relancer l'app.
- **Le RAG (`:8000`) ne suit le toggle qu'au (re)lancement** de
  `./elpis start` — c'est un uvicorn autonome, sans hook de reload.
  Après une bascule, relancez la pile, sinon son port reste ouvert en
  clair. Le script lit le MÊME fichier que les confs gunicorn
  (`APP_CONFIG_PATH` d'abord) : ne pas réintroduire de chemin en dur.
- **Cookies** : HTTP→HTTPS conserve la session ; HTTPS→HTTP force une
  reconnexion (le cookie `Secure` n'est plus envoyé en clair). Normal.
