# Product

Fiche produit d'Elpis : à qui il s'adresse, ce qu'il promet, et les règles qui
en découlent pour l'interface. Toute décision d'écran (contributeur humain ou
agent de code) s'y réfère ; le système visuel qui l'applique est décrit dans
[DESIGN.md](DESIGN.md).

## Register

product

## Platform

web — application de bureau dans le navigateur (desktop d'abord ; une fenêtre
étroite à côté d'un chat doit rester utilisable, pas de cible mobile).

## Users

Équipes techniques qui hébergent elles-mêmes leur assistant LLM : développeurs,
opérateurs, utilisateurs avancés, et l'administrateur de l'instance.

- Ils dialoguent avec un **chat agentique** qui appelle des outils (fichiers,
  shell, Git, navigateur, graphiques, mémoire), délègue à des sous-agents et
  consulte leurs documents (RAG).
- Ils éditent du code dans l'**éditeur intégré**, sur une sandbox Docker
  personnelle avec terminal.
- Ils planifient des **routines** et branchent leurs propres serveurs MCP.
- L'administrateur règle l'instance depuis la **console d'administration** :
  moteurs d'inférence, comptes, sandbox, sauvegardes, supervision.

État d'esprit : concentré, orienté tâche, souvent en train de surveiller une
génération longue ou une commande qui tourne. Langue de travail : le français.

## Product Purpose

Un assistant LLM **entièrement auto-hébergé** : tout tourne sur le serveur de
l'équipe, avec `llama-server` (llama.cpp) ou tout moteur compatible OpenAI, sans
dépendance à un service tiers.

Le succès se mesure à deux choses :

- l'utilisateur comprend d'un coup d'œil l'état de son travail (modèle, contexte
  consommé, outils en cours, fichiers modifiés) et avance sans friction ;
- l'administrateur voit en arrivant ce qui demande son attention, règle une
  fonctionnalité sur un seul écran et ne perd jamais une modification.

## Brand Personality

Précis, calme, fiable. « L'outil s'efface derrière la tâche. » Une confiance
d'expert, sans effet de manche.

Trois mots : **précis, calme, lisible**.

## Voice & Tone

- **Français** partout dans l'interface, **vouvoiement**.
- **Libellés courts** : un ou deux mots. Pas de paragraphe d'aide à l'écran :
  le détail va dans l'infobulle (`title`), le texte indicatif du champ ou la
  documentation.
- **Aucun emoji** dans l'interface. Seuls les signes ✓ ✗ ⚠ sont tolérés.
- Vocabulaire constant : « Enregistrer » pour les réglages, « Sauvegarde » pour
  les archives ; « RAG » reste « RAG » ; statuts en français (« En cours »,
  « Arrêté »), jamais de code interne (`status=error`) à l'écran.
- Messages d'erreur actionnables : ce qui s'est passé, puis quoi faire.

## Anti-references

- Panneaux « admin IA » saturés : micro-majuscules espacées au-dessus de chaque
  section, cartes imbriquées, navigation fragmentée en écrans aux en-têtes
  redondants.
- Micro-typographie gris clair sur blanc (contraste à la limite).
- Tableaux de bord gamifiés ou multicolores ; couleur décorative.
- Complexité de graphe de nœuds façon Flowise.

## Design Principles

1. **Un seul espace de travail.** Une surface cohérente : pas de saut de
   contexte, pas d'en-tête répété.
2. **Lisibilité avant densité.** Chaque libellé est mérité ; la hiérarchie se
   joue par taille et graisse, pas par des gris plus clairs ni des
   micro-majuscules.
3. **Le contenu est le héros.** La conversation et son activité en direct
   (état, tokens, outils en cours) sont le contenu, pas le décor.
4. **Familiarité méritée.** Des affordances produit standard ; l'outil
   disparaît dans la tâche.
5. **Un accent, couleur sémantique seulement.** Bleu = action ou sélection ;
   les couleurs de statut signalent un état anormal ; rien de décoratif.
6. **Rien ne se perd en silence.** Un écran modifié ne se quitte pas sans
   choix explicite ; l'irréversible demande une confirmation nommée (ou
   saisie) ; ce qui n'agira qu'au redémarrage est annoncé.

## Accessibility & Inclusion

- WCAG 2.1 AA : texte courant ≥ 4,5:1, textes indicatifs compris ; la rampe de
  gris des jetons est calibrée pour.
- Navigation clavier complète ; focus visible ; les modales piègent la
  tabulation et rendent le focus à la fermeture ; Échap ferme la couche la
  plus haute.
- `prefers-reduced-motion` respecté : chaque animation a son alternative.
- Régions en direct (activité, statut) annoncées (`aria-live`) ; sélection et
  page courante exposées (`aria-selected`, `aria-current`) ; graphiques doublés
  d'un résumé texte.
