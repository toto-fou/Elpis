# Mascottes

Les personnages de l'écran d'accueil et des avatars, en pixel art.

| Dossier | Personnage |
|---|---|
| `elpis/` | le buste couronné de laurier, mascotte par défaut |
| `boite_or/` | un coffre |
| `flamme/`, `flamme_bleue/` | une flamme |
| `fantome/` | un fantôme |
| `kiki/`, `kiki_face/`, `kiki_dodo/`, `kiki_guerriere/` | la scène d'accueil du skin `kiki` |

## Fichiers servis au navigateur

- `socle-mascottes.css` : une planche CSS animée par personnage et par état.
  Usage : `<span class="socle-mascotte" data-perso="elpis" data-etat="repos"></span>`.
  États : `repos`, `reflexion`, `parole`, `sommeil`, `salut`, `erreur`,
  `chantier`, `reveil`.
- `socle-mascottes.json` : la même description, en données (fenêtre, états,
  animations de chaque personnage).
- `<perso>/source.json` : les images et les points d'ancrage que lit le moteur
  de l'écran d'accueil (`accueil.js`).
- `<perso>/*.png`, `<perso>/atlas.webp` : les planches. Chaque planche porte une
  copie de sa première image à la fin, ce qui rend l'animation indépendante de
  la taille d'affichage.
- `kiki/marionnette.json` : les membres articulés de la scène Kiki.
- `accueil.js`, `accueil.css`, `motifs.js` : l'écran d'accueil animé (le mot
  ELPIS et la mascotte qui vit dedans).

## Contrainte d'usage

Le dessin tient dans une fenêtre de 24 ou 48 pixels. Il reste net aux
**multiples entiers** (48, 96, 144, 192). Entre deux, le navigateur invente des
pixels et le rendu devient irrégulier.

## Registre

`mascottes.json` est la liste UNIQUE des mascottes proposées à l'accueil
(`id`, `label`, dans l'ordre d'affichage ; `"apercu": false` l'écarte des
personnages de l'aperçu de la console). Le serveur l'utilise pour valider le
réglage `welcome_mascot` (`shared_infra/appearance/skins.py`) et la sert à
l'interface (`mascottes_catalogue` dans `GET /api/settings`) ; la console la
lit en statique. Les mascottes propres à un skin (`kiki`) n'y figurent pas :
elles viennent du champ `mascot` du registre des skins
(`frontend/css/skins/skins.json`).

## Ajouter un personnage

1. Déposer son dossier ici (`<id>/`, planches et `source.json`).
2. Ajouter ses règles à `socle-mascottes.css` et son entrée à
   `socle-mascottes.json`.
3. Ajouter `{"id": "<id>", "label": "<Nom>"}` à `mascottes.json`.

Le serveur refuse tout identifiant absent de `mascottes.json`
(`tests/shared_infra/test_skins_plugins_2026_09_28.py` vérifie que chaque
entrée a son dossier, sa planche CSS et son entrée dans `socle-mascottes.json`).

## Origine et licence

Dessins créés pour Elpis par l'auteur du projet (pixel art généré par script ;
illustrations d'Elpis et du skin Kiki produites par génération d'images puis
découpées avec les outils du dossier). Distribués sous la licence du projet
(MIT).
