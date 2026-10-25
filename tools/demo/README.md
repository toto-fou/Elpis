# Démo du README

Enregistre la présentation de `docs/media/elpis-demo.gif` sans GPU ni données réelles : une instance
isolée (racine `.instance/`, ports 38001, 38765 et 38080) répond par un faux moteur qui rejoue le
scénario de `scenes/presentation.mts`, Chromium tourne dans un écran Xvfb et ffmpeg filme sans perte.

```sh
npm run build                              # à la racine : core, hôte d'outils et interface
cd tools/demo && npm ci
npx playwright-core install chromium       # si le Chromium de Playwright 1.64 manque
node record.mts                            # → out/presentation.gif, .mp4 et .png
cp out/presentation.gif ../../docs/media/elpis-demo.gif
```

Prérequis : Docker et l'image `elpis/sandbox`, `Xvfb`, `ffmpeg`. La sandbox de démo appartient au seul
compte `alex` (id 4242, conteneur `elpis-sb-alex`), supprimé à la fin ; aucun autre conteneur n'est touché.
Un poste chargé donne une capture saccadée : enregistrer sur une machine au repos.
