---
name: python-tests-pytest
description: Écrire et lancer des tests pytest — layout tests, fixtures (tmp_path, monkeypatch, factory), parametrize, mocking avec unittest.mock, sélection -k, relance des échecs --lf, couverture pytest-cov
tags: [python, pytest, tests, fixtures, parametrize, monkeypatch, mock, couverture, tdd]
---

# Écrire et lancer des tests pytest

Structure une suite pytest maintenable : tests courts en `assert` nus,
fixtures pour l'état, parametrize pour les jeux de données, mocks ciblés.

## Pré-requis
- Dans le venv du projet : `pip install pytest` (+ `pytest-cov` pour la
  couverture) — voir **python-env-deps**.
- Un `conftest.py` d'exemple (fixtures types, factory, autouse) est bundlé :

  ```
  skill_read_file(name="python/python-tests-pytest",
                  path="references/conftest.example.py")
  ```

## Étapes

1. **Layout standard** — découverte automatique sans configuration :
   ```
   projet/
     src/... ou module/...
     tests/
       conftest.py            # fixtures partagées (chargé automatiquement)
       test_facturation.py    # fichiers test_*.py, fonctions test_*
   ```

2. **Un test = un comportement**, en `assert` nus (pytest réécrit les asserts
   et affiche les valeurs en cas d'échec) :
   ```python
   def test_remise_plafonnee():
       assert calcule_remise(total=1000, pct=90) == 500   # plafond 50 %
   ```

3. **L'état passe par des fixtures**, pas par des globals ni des setUp :
   ```python
   import pytest

   @pytest.fixture()
   def facture(tmp_path):                 # tmp_path : dossier temp fourni par pytest
       f = Facture(dossier=tmp_path)
       yield f                            # ← le test s'exécute ici
       f.fermer()                         # teardown TOUJOURS exécuté
   ```
   Fixtures intégrées à connaître : `tmp_path`, `monkeypatch`, `capsys`
   (stdout capturé), `caplog` (logs).

4. **Jeux de données : `parametrize`** (chaque cas = un test indépendant) :
   ```python
   @pytest.mark.parametrize("brut,attendu", [(100, 80), (0, 0), (-5, 0)])
   def test_net(brut, attendu):
       assert net(brut) == attendu
   ```

5. **Isoler l'extérieur** — `monkeypatch` pour env/attributs,
   `unittest.mock` pour les collaborateurs :
   ```python
   def test_appel_api(monkeypatch):
       monkeypatch.setenv("API_URL", "http://localhost:9")
       with mock.patch("module.client.requests.get") as get:
           get.return_value.json.return_value = {"ok": True}
           assert sync() is True
   ```
   Règle : patcher LÀ OÙ C'EST UTILISÉ (`module.client.requests`), pas là où
   c'est défini (`requests`).

6. **Lancer efficacement** :
   ```bash
   pytest -q                          # toute la suite, sortie compacte
   pytest tests/test_facturation.py -k remise    # sélection par nom
   pytest -x --lf                     # stop au 1er échec, ne relance QUE les échecs
   pytest --cov=module --cov-report=term-missing # couverture + lignes manquantes
   ```

## Vérification
- La suite passe deux fois de suite ET en ordre aléatoire si `pytest-randomly`
  est posé — sinon il y a du couplage d'état entre tests.
- Les nouveaux tests ÉCHOUENT quand on retire le correctif qu'ils couvrent
  (un test qui ne peut pas échouer ne teste rien).

## Pièges
- État partagé entre tests (variable de module, singleton, DB) = suite verte
  seule et rouge en CI : remettre l'état dans des fixtures avec teardown.
- `@pytest.fixture(scope="session")` sur un objet MUTABLE partage les
  mutations entre tests — réserver aux ressources coûteuses immuables.
- Mock trop large (`mock.patch("requests.get")`) : masque de vrais bugs et
  casse au premier refactor — patcher le point d'usage précis.
- Tester l'implémentation (appels internes) plutôt que le comportement rend
  chaque refactor rouge : asserter sur les SORTIES, pas sur le chemin.
