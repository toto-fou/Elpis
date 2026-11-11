# Vecteurs figés (retrait du Python du core, B1-36)

Ces vecteurs ont été produits par le Python du core, supprimé en B1-36 : ils sont **figés au tag python-final**.
Leur générateur n'existe plus, `tests/migration/test_vecteurs.py` ne les rejoue plus, et les tests TypeScript
continuent de les relire tels quels. Le comportement de référence est désormais celui du core TypeScript : un
changement voulu se fait dans le TS et dans le fichier JSON, en le signalant dans le message du commit.

Ceux de l'hôte d'outils Python, d'appmcp, des CLI du lanceur et des routes Python qu'ils servaient sont figés de
même depuis le retrait de ces retours arrière (0.1.0, commit précédent : front/integration 64c42cee).

Depuis le retrait d'elpis-tools et du Python qu'il appelait (lot audit OSS, octobre 2026),
`tests/migration/test_vecteurs.py` n'existe plus : **tous** les vecteurs sont figés. Leurs générateurs Python,
retirés de ce dossier le 3 novembre 2026, restent lisibles au commit `2a92d8fb` de la ligne de dev. Écarts
reportés depuis dans les JSON, chacun signalé dans le message de son commit :

| Fichier | Écart |
|---|---|
| `packages/db/test/vecteurs/dialecte.json` | `SELECT /* ? */ ?` → `SELECT /* ? */ $1` : les `?` des commentaires en bloc ne sont plus numérotés (pg8000 les numérotait) |
| `apps/toolhost/test/vecteurs/fs-code.json` | les fichiers Python disparus du corpus sont relus depuis une copie figée (`source`, `fs-code-corpus/`) |
| `apps/toolhost/test/vecteurs/fs-yaml.json` | idem pour les workflows modifiés depuis (`source`, `fs-yaml-corpus/`) |
| `apps/core/test/vecteurs/tour-image.json` | scénario `plafond_du_compte` retiré : plus de plafond de conversations par compte (`too_many_runs`), remplacé par `llm.max_requests_per_user` où le surplus attend |
| `packages/config/test/vecteurs/reglages.json` | `retired_backend_message` : la documentation citée est `docs/operations.md`, « Upgrading » (documentation passée en anglais) |
| `packages/contracts/test/vecteurs/emetteurs.json` | relevé `title` ajouté (`apps/core/src/tour/execution.ts`) : titre du modèle posé et diffusé dès son arrivée, plus seulement dans le `final` |

Les autres écarts sont déclarés dans les tests qui relisent les vecteurs, sans toucher aux JSON :
`apps/core/test/aides.ts` (`effacementUnifie`, cookie effacé), `apps/core/test/llm/fournisseurs/ecart-anthropic.ts`
(réflexion adaptative demandée aussi avec des outils), `apps/core/test/ecart-spdx-css.ts` (en-tête SPDX
des feuilles de style), `apps/core/test/code/ecart-empreinte-ca.ts` (empreinte de la CA des installeurs),
`packages/config/test/vecteurs.test.ts` (`mcp.server_cmd` et `llm.max_runs_per_user` retirés, `agent_token` des machines),
`packages/mcp/test/manifeste.test.ts` (repli stdio sur l'hôte TS), `apps/toolhost/test/shell-vecteurs.test.ts`
(pas de +/- au-delà de 4 000 lignes), `packages/bac/test/bac.test.ts` (« conteneur en marche » gardé 5 min), `packages/securite/test/{identite,mots-de-passe,audit}.test.ts`
(enveloppe typée et audience refusée, PBKDF2 versionné, clé d'audit sans blancs).

| Domaine | Fichier figé |
|---|---|
| `auth` | `packages/auth/test/vecteurs/auth.json` |
| `auth_comptes` | `packages/auth/test/vecteurs/comptes.json` |
| `auth_groupes` | `apps/core/test/vecteurs/groupes.json` |
| `bac` | `packages/bac/test/vecteurs/bac.json` |
| `boucle_analyse` | `apps/core/test/vecteurs/boucle-analyse.json` |
| `boucle_balises` | `apps/core/test/vecteurs/boucle-balises.json` |
| `boucle_chat_commun` | `apps/core/test/vecteurs/boucle-chat-commun.json` |
| `boucle_contrat` | `apps/core/test/vecteurs/contrat-resultat.json` |
| `boucle_dispatch` | `apps/core/test/vecteurs/boucle-dispatch.json` |
| `boucle_journal` | `apps/core/test/vecteurs/boucle-journal.json` |
| `boucle_metriques` | `apps/core/test/vecteurs/boucle-metriques.json` |
| `boucle_orchestrateur` | `apps/core/test/vecteurs/boucle-orchestrateur.json` |
| `boucle_raisonnement` | `apps/core/test/vecteurs/boucle-raisonnement.json` |
| `boucle_run` | `apps/core/test/vecteurs/boucle-run.json` |
| `boucle_surveillance` | `apps/core/test/vecteurs/boucle-surveillance.json` |
| `boucle_texte` | `apps/core/test/vecteurs/boucle-texte.json` |
| `boucle_tour` | `apps/core/test/vecteurs/boucle-tour.json` |
| `bureau_lan` | `apps/core/test/vecteurs/bureau-lan.json` |
| `capture_parite` | `apps/core/test/vecteurs/capture-parite.json` |
| `chat_compression` | `apps/core/test/vecteurs/chat-compression.json` |
| `code_cli` | `apps/core/test/vecteurs/code-cli.json` |
| `code_page` | `apps/core/test/vecteurs/code-page.json` |
| `contexte_assemblage` | `apps/core/test/vecteurs/contexte-assemblage.json` |
| `contexte_compresseur` | `apps/core/test/vecteurs/contexte-compresseur.json` |
| `contexte_compression` | `apps/core/test/vecteurs/contexte-compression.json` |
| `contexte_elagage` | `apps/core/test/vecteurs/contexte-elagage.json` |
| `contexte_ports` | `apps/core/test/vecteurs/contexte-ports.json` |
| `contracts_emetteurs` | `packages/contracts/test/vecteurs/emetteurs.json` |
| `core_admin_base` | `apps/core/test/vecteurs/admin-base.json` |
| `core_admin_comptes` | `apps/core/test/vecteurs/admin-comptes.json` |
| `core_admin_cycle` | `apps/core/test/vecteurs/admin-cycle.json` |
| `core_admin_executeurs` | `apps/core/test/vecteurs/admin-executeurs.json` |
| `core_admin_integrations` | `apps/core/test/vecteurs/admin-integrations.json` |
| `core_admin_llm` | `apps/core/test/vecteurs/admin-llm.json` |
| `core_admin_securite` | `apps/core/test/vecteurs/admin-securite.json` |
| `core_admin_skins_runs` | `apps/core/test/vecteurs/admin-skins-runs.json` |
| `core_admin_vue` | `apps/core/test/vecteurs/admin-vue.json` |
| `core_chats` | `apps/core/test/vecteurs/chats.json` |
| `core_cli_arguments` | `apps/core/test/vecteurs/cli-arguments.json` |
| `core_comptes` | `apps/core/test/vecteurs/comptes.json` |
| `core_config` | `apps/core/test/vecteurs/config-compte.json` |
| `core_entretien` | `apps/core/test/vecteurs/entretien.json` |
| `core_git_routes` | `apps/core/test/vecteurs/git-routes.json` |
| `core_graphiques` | `apps/core/test/vecteurs/graphiques.json` |
| `core_images` | `apps/core/test/vecteurs/images-routes.json` |
| `core_interne` | `apps/core/test/vecteurs/interne.json` |
| `core_memoire` | `apps/core/test/vecteurs/routes-memoire.json` |
| `core_notifications` | `apps/core/test/vecteurs/notifications.json` |
| `core_oauth` | `apps/core/test/vecteurs/oauth.json` |
| `core_openapi` | `apps/core/test/vecteurs/openapi.json` |
| `core_outils` | `apps/core/test/vecteurs/outils.json` |
| `core_pont_mcp` | `apps/core/test/vecteurs/pont-mcp.json` |
| `core_reglages` | `apps/core/test/vecteurs/reglages.json` |
| `core_routines` | `apps/core/test/vecteurs/routes-routines.json` |
| `core_sauvegarde` | `apps/core/test/vecteurs/sauvegarde.json` |
| `core_skills` | `apps/core/test/vecteurs/routes-skills.json` |
| `core_skins` | `apps/core/test/vecteurs/skins.json` |
| `core_webhooks` | `apps/core/test/vecteurs/routes-webhooks.json` |
| `evenements` | `apps/core/test/vecteurs/evenements.json` |
| `executions_chronologie` | `apps/core/test/vecteurs/executions-chronologie.json` |
| `http_routage` | `apps/core/test/vecteurs/http_routage.json` |
| `images` | `apps/core/test/vecteurs/images.json` |
| `images_magasin` | `apps/core/test/vecteurs/images-magasin.json` |
| `interface_pages` | `apps/core/test/vecteurs/pages.json` |
| `interface_urls` | `apps/core/test/vecteurs/urls-publiques.json` |
| `interface_voix_ecoute` | `apps/core/test/vecteurs/voix-ecoute.json` |
| `llm_connecteurs` | `apps/core/test/vecteurs/llm-connecteurs.json` |
| `llm_file` | `apps/core/test/vecteurs/llm-file.json` |
| `mcp_panneau` | `apps/core/test/vecteurs/mcp-panneau.json` |
| `mcp_paquet` | `packages/mcp/test/vecteurs/mcp-paquet.json` |
| `moteur_fournisseurs` | `apps/core/test/vecteurs/moteur-fournisseurs.json` |
| `navigateur` | `packages/navigateur/test/vecteurs/navigateur.json` |
| `observabilite_admin` | `apps/core/test/vecteurs/observabilite-admin.json` |
| `observabilite_metriques` | `apps/core/test/vecteurs/observabilite-metriques.json` |
| `observabilite_usage` | `apps/core/test/vecteurs/observabilite-usage.json` |
| `ordonnanceur_disjoncteur` | `apps/core/test/vecteurs/ordonnanceur_disjoncteur.json` |
| `ordonnanceur_etat` | `apps/core/test/vecteurs/ordonnanceur_etat.json` |
| `outils_categories` | `apps/core/test/vecteurs/outils-categories.json` |
| `outils_mcp` | `apps/core/test/vecteurs/outils-mcp.json` |
| `outils_taches` | `apps/core/test/vecteurs/outils-taches.json` |
| `rag_client` | `apps/core/test/vecteurs/rag.json` |
| `relais` | `apps/core/test/vecteurs/relais.json` |
| `routes_bureau` | `apps/core/test/vecteurs/routes-bureau.json` |
| `routines` | `apps/core/test/vecteurs/routines.json` |
| `routines_planificateur` | `apps/core/test/vecteurs/routines-planificateur.json` |
| `securite` | `packages/securite/test/vecteurs/securite.json` |
| `terminal` | `apps/toolhost/test/vecteurs/terminal.json` |
| `toolhost` | `apps/toolhost/test/vecteurs/toolhost.json` |
| `toolhost_apercu` | `apps/toolhost/test/vecteurs/apercu.json` |
| `toolhost_fichiers` | `apps/toolhost/test/vecteurs/fichiers.json` |
| `toolhost_git` | `apps/toolhost/test/vecteurs/git.json` |
| `toolhost_office` | `apps/toolhost/test/vecteurs/toolhost_office.json` |
| `tour_historique` | `apps/core/test/vecteurs/tour-historique.json` |
| `tour_image` | `apps/core/test/vecteurs/tour-image.json` |
| `tour_journal` | `apps/core/test/vecteurs/tour-journal.json` |
| `voix` | `apps/core/test/vecteurs/voix.json` |
