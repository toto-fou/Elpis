# Skills — Mémoire procédurale

Ce dossier contient les **skills** : des procédures markdown décrivant *comment*
réaliser une action concrète sur une solution logicielle (déployer via Ansible,
réinitialiser Qdrant, builder le serveur MCP, …).

C'est la troisième mémoire de l'agent, complémentaire des deux autres :

| Mémoire | Où | Quoi |
|---|---|---|
| Factuelle / long-terme | `llm_core/memory/` (Markdown auto-curé + FTS5) | faits, profil utilisateur |
| De travail | `llm_core/tools/memory_tools.py` (todos) | étapes de la tâche en cours |
| **Procédurale (skills)** | **ici** | **comment faire X** |

Inspiré du pattern Agent Skills (Claude), appliqué aux *procédures*.

## Organisation : un skill = un dossier (modèle Agent Skill)

Le format de référence est le **dossier-skill** : `[<domaine>/]<name>/SKILL.md`
(+ ressources bundlées `scripts/`, `references/`, `assets/`). Un dossier-skill
peut contenir des **sous-skills** imbriqués (package) : leur id devient
`parent/enfant` et seuls les skills de niveau 0 figurent dans l'index injecté —
les corps des sous-skills se chargent à la demande via `skill_get("parent/enfant")`.

```
skills/
  README.md                ← ce fichier
  _TEMPLATE.md             ← gabarit (ignoré par le loader)
  ansible/                 ← PACKAGE (dossier-skill, id "ansible")
    SKILL.md               ← aperçu du domaine + table d'orientation
    ansible-debug-runs/    ← sous-skill (id "ansible/ansible-debug-runs")
      SKILL.md
      scripts/safe_run.sh  ← script exécutable, stagé en sandbox
    ansible-write-playbook/
      SKILL.md
      references/playbook.example.yml
    …
  python/ robotframework/  ← autres packages, même modèle
  learned/                 ← SAS de curation admin (brouillons)
```

Le **legacy mono-fichier** `[<domaine>/]<name>.md` reste lu (rétro-compat),
mais toute NOUVELLE création (UI, API, outil `skill_save`) écrit le format
dossier. Un legacy édité reste legacy (pas de migration silencieuse).

Le `domain` d'un skill = premier sous-dossier (`skills/<domain>/…`),
surchargeable par le frontmatter `domain:`. Cas du package posé à la racine
d'un domaine (ex. `skills/ansible/SKILL.md`) : le chemin ne donne PAS de
domaine (le dossier du skill est lui-même au premier niveau) → poser
explicitement `domain: ansible` dans son frontmatter pour garder le
regroupement de l'index.

## Comment ça marche (routage = injection déterministe)

On n'injecte **jamais** tous les corps dans le contexte. À chaque requête :

1. `llm_core/skills.py:discover_skills()` scanne récursivement les sources et
   fusionne. L'injection passe `include_learned=False` : `learned/` est un SAS
   admin, jamais injecté.
2. `llm_core/_system_prompts.py:_build_skills_block()` injecte un **index
   léger** des skills de niveau 0 (user+global), **groupé par domaine**
   (`name — description`), borné par `SKILLS_INDEX_MAX`, avec marqueurs :
   `· sub-skills` (package) et `· files/scripts` (bundle).
3. Le modèle charge un corps à la demande via l'outil **`skill_get(name)`**
   (id qualifié `parent/enfant` pour un sous-skill). Les skills **épinglés**
   (`/skill` dans le chat, par name) sont injectés en entier.

Les fichiers bundlés d'un skill (global ou perso) ne sont **pas montés** dans la
sandbox : l'agent les lit via **`skill_read_file(name, path)`** et exécute les
scripts via **`skill_run_script(name, script, args, env)`**. À l'exécution, le
bundle est stagé dans un répertoire éphémère hors `/work` (`$SKILL_DIR`) et le
script tourne **depuis `/work`** : les chemins d'`args` sont relatifs au dossier
de travail et les sorties y atterrissent. Le code des scripts n'entre pas en contexte.

## Sources (fusionnées, priorité décroissante)

```
user    ← <sandbox_utilisateur>/skills/   (perso ; écrit par l'agent via skill_save)
learned ← skills/learned/                 (SAS de curation admin — NON injecté avant promotion)
global  ← skills/                         (curé, versionné — ce dossier, hors learned/)
```

En cas de collision de `name`, le plus spécifique gagne (`user` > `learned` > `global`).
`learned` n'est fusionné que pour la gestion (UI/API) — **jamais** dans le prompt.
`learned` est un nom réservé (refusé comme name/domaine d'un skill global).

## Format d'un SKILL.md

```markdown
---
name: ansible-write-playbook    # == nom du dossier (règle du spec)
description: Écrire un playbook Ansible idempotent
tags: [ansible, playbook, idempotence]
# domain: …                     # optionnel : surcharge le domaine dérivé du chemin
# license / compatibility / allowed-tools / metadata: …   # optionnels (spec)
---

# Écrire un playbook Ansible idempotent

## Pré-requis
…

## Étapes
1. …
```

| Champ | Rôle |
|---|---|
| `name` | Identifiant **unique globalement** (== nom du dossier pour un dossier-skill). |
| `description` | Une phrase : sert au matching ET à l'index. **Soigne les mots-clés.** |
| `tags` | Mots-clés additionnels pour le matching (liste). |
| `domain` | (optionnel) Surcharge le domaine dérivé du chemin. |

Le **corps markdown** est la procédure elle-même. Pas d'emoji. Si le skill
embarque des scripts, le corps les référence via l'outil d'exécution
(`skill_run_script(name="<pkg>/<name>", script="scripts/x.sh", args=[…])`) —
voir le package `ansible/` en exemple.

## Ajouter / éditer un skill

1. Créer `skills/[<domaine>/]<mon-skill>/SKILL.md` (ou l'UI Skills : création,
   import `.zip` d'un package, édition — le CRUD est folder-aware).
2. Aucun redémarrage : `discover_skills` relit le disque à chaque requête (hot-reload).

L'édition via l'UI/API met à jour le `SKILL.md` **en place** (frontmatter non
géré par le formulaire préservé, dossier jamais déplacé — un changement de
domaine pose la surcharge frontmatter). Supprimer un package supprime ses
sous-skills et son bundle.

## Skills perso (`skill_save`) et SAS admin (`learned/`)

- **Agent → perso.** L'agent enregistre une procédure inédite via l'outil
  `skill_save(…, domain="ansible")`. Le skill atterrit dans **sa sandbox**
  (`<sandbox_utilisateur>/skills/[<domain>/]<slug>/SKILL.md`, source `user`) :
  routable pour SES prochaines sessions uniquement, jamais injecté chez un
  autre utilisateur (isolation — audit CRIT-1).
- **Admin → learned → global.** Un admin peut déposer un brouillon dans le SAS
  `learned/` (UI Skills, scope *learned*), puis le **promouvoir** vers la
  bibliothèque curée : `POST /api/skills/promote {"name": "<slug>"}` — le
  déplacement préserve le sous-dossier de domaine et fonctionne aussi pour un
  dossier-skill complet (bundle + sous-skills). Tant qu'il n'est pas promu, un
  `learned` n'est PAS injecté dans le prompt.

## Configuration

Variables (env / `config.json` › `skills.*`) :

| Clé | Défaut | Rôle |
|---|---|---|
| `APP_SKILLS_DIR` / `skills.dir` | `skills` | Dossier global. |
| `APP_SKILLS_TOP_N` / `skills.top_n` | `3` | Nb de corps injectés (pins). |
| `APP_SKILLS_MIN_SCORE` / `skills.min_score` | `1.0` | Score lexical min. |
| `APP_SKILLS_CHAR_BUDGET` / `skills.char_budget` | `12000` | Budget caractères des corps. |
| `APP_SKILLS_INDEX_MAX` / `skills.index_max` | `100` | Entrées max dans l'index (0 = illimité). |
