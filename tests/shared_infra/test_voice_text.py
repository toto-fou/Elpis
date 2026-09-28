# SPDX-License-Identifier: MIT
"""tests/shared_infra/test_voice_text.py — markdown vers texte prononçable.

Une synthèse vocale lit ce qu'on lui donne, astérisques comprises. Le modèle
produit du markdown quoi qu'on lui demande : ce nettoyage est la garantie
d'exécution, et il est côté serveur pour valoir aussi pour un appelant qui ne
serait pas le navigateur.
"""
from __future__ import annotations

import pytest

from shared_infra.voice.text import ANNONCE_CODE, ANNONCE_TABLEAU, est_prononcable, pour_la_voix


class TestNettoyage:
    def test_retire_les_marques_de_gras_et_d_italique(self):
        assert pour_la_voix("Un **mot** et un *autre*") == "Un mot et un autre"

    def test_garde_le_contenu_du_code_en_ligne(self):
        assert pour_la_voix("Lance `git status` maintenant") == "Lance git status maintenant"

    def test_annonce_un_bloc_de_code_au_lieu_de_le_lire(self):
        """Annoncé, pas supprimé : sauter un bloc en silence laisse croire que
        la réponse a été tronquée."""
        dit = pour_la_voix("Voici :\n```python\nprint('x')\n```\nVoilà.")
        assert "print" not in dit
        assert ANNONCE_CODE in dit
        assert dit.startswith("Voici :") and dit.endswith("Voilà.")

    def test_annonce_une_fence_jamais_refermee(self):
        """Réponse coupée en plein bloc : sans ce cas, tout le code partait
        à la synthèse."""
        dit = pour_la_voix("Regarde :\n```js\nconst x = 1;")
        assert "const" not in dit and ANNONCE_CODE in dit

    def test_dedoublonne_les_annonces_par_type(self):
        dit = pour_la_voix("```a\n1\n```\n```b\n2\n```\n```c\n3\n```")
        assert dit.count(ANNONCE_CODE) == 1

    def test_ne_fond_pas_tableau_et_code_en_une_seule_annonce(self):
        dit = pour_la_voix("| a | b |\n|---|---|\n| 1 | 2 |\n\n```py\nx=1\n```")
        assert ANNONCE_TABLEAU in dit and ANNONCE_CODE in dit

    def test_lien_reduit_a_son_libelle(self):
        assert pour_la_voix("Voir [la doc](https://exemple.fr/a/b)") == "Voir la doc"

    def test_url_nue_remplacee(self):
        """Une URL lue caractère par caractère dure vingt secondes."""
        dit = pour_la_voix("Va sur https://exemple.fr/tres/long?x=1 pour voir")
        assert "exemple.fr" not in dit and "lien" in dit

    def test_retire_le_raisonnement(self):
        assert pour_la_voix("<think>hmm, voyons</think>La réponse.") == "La réponse."

    def test_retire_titres_puces_et_numerotation(self):
        dit = pour_la_voix("## Titre\n\n- un\n- deux\n\n1. trois\n2. quatre")
        assert dit == "Titre un deux trois quatre"

    def test_traduit_les_symboles_qui_se_lisent_mal(self):
        assert "degrés" in pour_la_voix("Il fait 21 °C")
        assert "pour cent" in pour_la_voix("Soit 50 %")
        assert "euros" in pour_la_voix("Prix : 30 €")

    def test_garde_l_espace_avant_les_deux_points(self):
        """Typographie française : on ne colle pas « Prix: ». Inaudible, mais
        le texte nettoyé sert aussi au diagnostic."""
        assert pour_la_voix("Prix : 30 euros.") == "Prix : 30 euros."

    def test_entree_vide_ou_none(self):
        assert pour_la_voix("") == ""
        assert pour_la_voix(None) == ""


class TestTroncature:
    def test_coupe_a_une_fin_de_phrase(self):
        dit = pour_la_voix("Une phrase. Deux phrases. Trois phrases.", max_chars=30)
        assert dit == "Une phrase. Deux phrases."

    def test_coupe_brutalement_si_aucune_phrase_ne_tient(self):
        dit = pour_la_voix("a" * 100, max_chars=20)
        assert len(dit) == 20

    def test_ne_tronque_pas_sous_le_plafond(self):
        assert pour_la_voix("Court.", max_chars=500) == "Court."


class TestPrononcable:
    @pytest.mark.parametrize("texte", ["", "   ", "…", "***", "-"])
    def test_rien_a_dire(self, texte):
        assert est_prononcable(texte) is False

    def test_une_annonce_seule_reste_prononcable(self):
        """Une réponse qui n'était qu'un bloc de code se réduit à son annonce :
        il y a bien quelque chose à dire."""
        assert est_prononcable(pour_la_voix("```py\nx=1\n```")) is True


class TestAudit20260923:
    def test_les_comparaisons_ne_sont_pas_des_balises(self):
        assert pour_la_voix("x < 3 et y > 5") == "x < 3 et y > 5"

    def test_les_vraies_balises_partent(self):
        assert pour_la_voix('<b>gras</b> puis <br/> et <span class="a">fin</span>') == "gras puis et fin"

    def test_double_tiret_n_est_pas_une_fleche(self):
        assert pour_la_voix("lancez --help") == "lancez --help"
        assert "vers" not in pour_la_voix("a -- b")

    @pytest.mark.parametrize("fleche", ["->", "-->", "=>"])
    def test_les_fleches_se_lisent(self, fleche):
        assert pour_la_voix(f"a {fleche} b") == "a vers b"

    def test_emojis_retires(self):
        assert pour_la_voix("Bravo 🎉 c'est fait ✅ 👍🏽") == "Bravo c'est fait"
