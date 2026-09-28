# Design

Le système visuel d'Elpis : jetons, thèmes, typographie, composants et règles.
Les intentions (public, ton, principes) sont dans [PRODUCT.md](PRODUCT.md) ; ce
document décrit comment l'interface les applique, d'après le code
(`frontend/css/style.css`, `frontend/css/skins/`, `frontend/js/app-settings.js`).

## En bref

- **Pas d'étape de build** : Vue 3 (build global vendoré), gabarits dans le DOM,
  feuilles servies telles quelles.
- **Tout passe par des jetons** (variables CSS) définis dans `style.css`. Un
  thème ne fait que redéfinir des jetons ; le mode sombre aussi.
- **Tailwind précompilé** (`frontend/css/style.tailwind.css`, généré) ; les
  utilitaires de couleur courants sont **re-mappés sur les jetons** : écrire
  `bg-white` ou `text-slate-700` suit le thème et le mode sombre.
- **Un seul accent** (bleu en thème Ardoise) ; les couleurs de statut ne
  signalent qu'un état ; icônes monochromes.

## Jetons

Déclarés sur `:root` (mode clair), redéfinis sous `body.elpis-app-dark` (mode
sombre) et `body.elpis-dark-surface` (familles sémantiques claires-sur-sombre),
puis par chaque thème.

| Famille | Jetons | Usage |
|---|---|---|
| Fond | `--app-bg` | fond de page |
| Surfaces | `--surface`, `--surface-2` … `--surface-5` | cartes et panneaux, du plus clair au plus dense |
| Bordures | `--border`, `--border-soft`, `--table-cell-border` | contours, séparateurs |
| Texte | `--text-900` … `--text-300`, `--text-max` | rampe du plus fort au plus discret |
| Accent | `--accent`, `--accent-strong`, `--accent-500/400/300`, `--accent-fg`, `--accent-text(-strong)`, `--accent-surface(-2)`, `--accent-border`, `--accent-ring` | action principale, sélection, focus |
| Succès | `--ok*` | état actif, réussite |
| Attention | `--warn*` | en attente, à surveiller |
| Danger | `--danger-surface`, `--danger-border(-soft)`, `--danger-text`, `--danger-strong`, `--danger-icon-bg/fg` | erreur, action destructrice |
| Rôle admin | `--role-admin-text/surface/border` | badge de rôle uniquement |
| Rail | `--rail-bg`, `--rail-bg-2`, `--rail-border`, `--rail-text(-strong)`, `--rail-muted`, `--rail-hover`, `--rail-active-bg`… | barres latérales (chat et console), sombres par défaut |
| Code | `--code-bg`, `--code-fg`, `--code-border`, `--code-header-bg/fg`, `--code-inline-*` | blocs de code (sombres dans les deux modes) et code en ligne |
| Prose | `--prose-body`, `--prose-heading`, `--prose-strong`, `--prose-link(-hover)` | rendu Markdown des messages |
| Divers | `--toast-*`, `--hl-bg/fg`, `--scrollbar-*` | toasts (surface inversée stable), surlignage de recherche, barres de défilement |
| Rayons | `--radius` et `--radius-sm/md/lg/xl` (dérivés) | un thème change `--radius`, l'échelle suit |

**Contraste.** La rampe de texte est recalibrée pour l'AA : `--text-400`
(#64748b) et `--text-500` (#5b6a80) sont plus sombres que les gris Tailwind
natifs sur surface claire (≥ 4,5:1). Sur le rail sombre, utiliser
`--rail-muted`, pas la rampe de texte.

## Thèmes et mode sombre

Trois classes sur `<body>`, posées par `app-settings.js` :

| Classe | Rôle |
|---|---|
| `elpis-skin-<id>` | le thème choisi (`frontend/css/skins/<id>.css`) |
| `elpis-app-dark` | le mode sombre (bloc de jetons neutres + variantes sombres des thèmes) |
| `elpis-dark-surface` | marqueur « la surface de base est sombre » : mode sombre **ou** thème à base sombre (`darkBase`, ex. Émeraude) ; tous les re-mappages clair-sur-sombre en dépendent |

Thème et mode se composent : `body.elpis-app-dark` (0,2,0) bat `:root` ; un
thème (0,2,0, chargé après) bat `:root` ; sa variante sombre (0,3,0) bat le
sombre par défaut.

Thèmes livrés : **Ardoise** (défaut, sans classe de thème), **Elpis**,
**llama.cpp**, **Émeraude** (base sombre), **Parchemin**, **Pingouins**, **Kiki**.
Le réglage est par utilisateur : `skin`, et le mode Système / Clair / Sombre
(`dark_mode`, `dark_mode_auto`), dans les Paramètres comme dans le menu du
compte de la console.

Ajouter un thème : un fichier `frontend/css/skins/<id>.css` qui redéfinit les
jetons sous `body.elpis-skin-<id>` (et `.elpis-app-dark` pour le sombre), une
entrée dans `APP_SKINS` (`app-settings.js`), le `<link>` dans `index.html` et
`admin.html` après `style.css`. Les polices restent locales (pas de
téléchargement : l'application doit fonctionner hors ligne).

## Typographie

- Texte : pile système (`-apple-system, BlinkMacSystemFont, "Segoe UI",
  Roboto, Helvetica, Arial, sans-serif`).
- Code : `"JetBrains Mono"` puis polices monospace système.
- Un thème peut donner des titres serif (Georgia, présente partout) ; aucune
  police n'est téléchargée.
- Hiérarchie par **taille et graisse**, pas par des gris plus clairs ni des
  micro-majuscules espacées ; en-têtes de tableau en casse normale.

## Calques (z-index)

Échelle de fait, à respecter pour qu'une couche nouvelle trouve sa place :

| Valeur | Couche |
|---|---|
| 40–100 | menus déroulants, panneaux flottants de page |
| 5000 | grandes modales (Paramètres, clonage Git) |
| 6000 | modales au-dessus d'une modale (transcriptions, gabarits, skills) |
| 7000 | confirmation générique (confirmer, saisir, choisir) |
| 7500 | modales de groupes |
| 8000 | menu contextuel |
| 9000+ | toasts et alertes système |

## Mouvement

- Transitions de 150 à 260 ms ; entrées en `ease-out`, panneaux coulissants en
  `cubic-bezier(0.4, 0, 0.2, 1)` (`.elpis-slide-panel`, 260 ms).
- Animer `opacity` et `transform` ; éviter les propriétés de mise en page
  (exception assumée : la largeur des panneaux coulissants).
- `prefers-reduced-motion: reduce` coupe les animations non essentielles
  (bloc dédié dans `style.css`) ; toute animation nouvelle prévoit son
  alternative (fondu ou changement instantané).

## Iconographie

Phosphor (police vendorée, `ph ph-<nom>`), monochrome, `aria-hidden="true"`
sur l'icône ; le nom accessible est porté par le bouton (`aria-label`) quand
il n'a pas de texte.

## Composants

| Préfixe | Où | Exemples |
|---|---|---|
| `set-*` | réglages (Paramètres, console) | `set-input`, `set-select`, `set-textarea`, `set-switch-track`, `set-row` |
| `adm-*` | console d'administration | `adm-card`, `adm-rows`/`adm-row`, `adm-btn` (+ `--primary`, `--quiet`, `--icon`, `--danger`, `--warn`), `adm-seg`, `adm-pill`, `adm-table`, `adm-details` (et `--rows` pour « Avancé »), `adm-savebar`, `adm-drawer`, `adm-zone`, `adm-kpi`, `adm-palette` |
| `elpis-*` | chat, éditeur, bandeaux | `elpis-editor-tab`, `elpis-code-diff`, `elpis-effect`, `elpis-banner-btn`, `elpis-slide-panel` |
| `markdown`, `code-*`, `diff-*` | rendu des messages | prose, blocs de code, diffs |
| `toast`, `modal`, `popover` | couches | notifications, dialogues, menus |

Règles de composition :

- **Pas de carte dans une carte** : une section = une surface ; les objets
  d'une liste sont des rangées, un objet complexe s'ouvre dans un tiroir ou
  un éditeur en ligne.
- **Rangée de réglage** : libellé court à gauche (détail en `title`), contrôle
  dimensionné à la donnée à droite, unité en suffixe.
- **Boutons** : une famille ; un seul bouton principal (accent) par écran ;
  les actions destructrices en variante danger, confirmées.
- **Actions sensibles** en fin de page, dans une « Zone sensible »
  (`adm-zone`) ; l'irréversible demande de recopier un mot
  (`openTypedConfirm`).
- **Réglages rares** repliés sous « Avancé » (`adm-details--rows`) ; un objet
  (connecteur…) s'édite dans un tiroir (`adm-drawer`) avec son propre
  Enregistrer.
- **Couleur de statut seulement sur anomalie** : « 0 erreur » reste neutre.

## Règles

- Jamais de couleur en dur dans un composant : un jeton, ou un utilitaire
  Tailwind re-mappé sur un jeton.
- Jamais de classe de couleur sur `<body>` : le fond et le texte viennent de
  la règle `body` de `style.css`.
- Après avoir ajouté des classes utilitaires dans un gabarit :
  `node tools/generate_tailwind_css.mjs` (parité vérifiée par
  `tests/frontend/tailwind-verify.mjs`).
- Vérifier chaque écran en clair et en sombre, et sur au moins un thème à base
  sombre (Émeraude) : `tests/frontend/skins-verify.mjs` et
  `tests/frontend/darkmode-verify.mjs`.
