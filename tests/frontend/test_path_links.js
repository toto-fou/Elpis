// SPDX-License-Identifier: MIT
// ============================================================
//  tests/frontend/test_path_links.js
//  Lancer : node tests/frontend/test_path_links.js
//
//  Cible : frontend/js/utils.js — ``elpisParsePath`` /
//  ``elpisLooksLikePath`` (2026-09-19), qui décident quels bouts de texte
//  deviennent des liens vers l'éditeur : code en ligne des messages du
//  chat (`src/app.py:12`) et sortie du terminal (traces, chemins).
//
//  Deux erreurs coûtent : un vrai chemin NON cliquable (on perd la
//  fonction) et un faux positif (« os.path », « v1.2 », une URL) qui
//  s'affiche comme un lien et ouvre « fichier introuvable ».
//  Et ``tree`` : l'état partagé de l'arbre (sélection multiple,
//  cibles d'une action de groupe, pastilles Git des dossiers).
//  Cf. docs/editeur-ux-design-2026-09-19.md.
// ============================================================
const { t, fin, assert } = require('./lib/harnais.js');
const { charger, depuisBac } = require('./lib/charger.js');

const U = charger('utils.js');
const parse = (s) => depuisBac(U.bac.elpisParsePath(s));
const looks = U.bac.elpisLooksLikePath;

t('chemins avec ligne et colonne', () => {
    assert.deepStrictEqual(parse('src/app.py:12'), { path: 'src/app.py', line: 12, col: 0 });
    assert.deepStrictEqual(parse('src/app.py:12:7'), { path: 'src/app.py', line: 12, col: 7 });
    assert.deepStrictEqual(parse('src/app.py'), { path: 'src/app.py', line: 0, col: 0 });
});

t('préfixes ./ et /work/ ramenés au chemin de la sandbox', () => {
    assert.strictEqual(parse('./src/a.js').path, 'src/a.js');
    assert.strictEqual(parse('/work/proj/main.go:3').path, 'proj/main.go');
    assert.strictEqual(parse('/work/proj/main.go:3').line, 3);
});

t('nom seul accepté si l\'extension est connue', () => {
    assert.ok(looks('main.py'));
    assert.ok(looks('README.md'));
    assert.ok(looks('Dockerfile'));
    assert.ok(looks('config.yaml:4'));
    // extensions « faibles » : liens seulement avec un chemin
    assert.ok(looks('logs/app.log'));
    assert.ok(looks('./.env'));
    assert.ok(looks('.env'));
    assert.ok(looks('.github/workflows/ci.yml'));
    assert.ok(!looks('.gitignore'), 'sans chemin, un fichier caché inconnu n\'est pas lié');
    assert.ok(looks('./.gitignore'));
    assert.ok(looks('server-2026.log'));
});

t('faux positifs écartés', () => {
    // (« a.b.c » reste un nom de fichier C plausible : pas dans cette liste —
    // le clic vérifie de toute façon que le fichier existe.)
    for (const s of ['os.path', 'v1.2', 'self.value', 'http://x.io/a.py',
                     'https://github.com/a/b.js', 'src/utils', 'deux mots.py', '', '   ',
                     'x'.repeat(301) + '.py', 'console.log', 'process.env', 'logger.log']) {
        assert.ok(!looks(s), 'ne devrait pas être un lien : ' + JSON.stringify(s));
    }
});

t('chemins avec tirets, points et arobase', () => {
    assert.strictEqual(parse('node_modules/@scope/pkg/index.d.ts').path, 'node_modules/@scope/pkg/index.d.ts');
    assert.strictEqual(parse('.github/workflows/ci.yml').path, '.github/workflows/ci.yml');
    assert.strictEqual(parse('my-app/src/App.vue:10').line, 10);
});

// ── État partagé de l'arbre ─────────────────────────────────────
// Vue.reactive n'existe pas dans le bac : un objet simple suffit à la
// logique (sélection, cibles, pastilles).
U.bac.Vue = { reactive: (o) => o };
const T = U.bac.elpisTree;

t('sélection : simple, ajout, plage', () => {
    T.select('a.py', 'single');
    assert.deepStrictEqual(depuisBac(Array.from(T.state.selected)), ['a.py']);
    T.select('b.py', 'toggle');
    assert.deepStrictEqual(depuisBac(Array.from(T.state.selected)).sort(), ['a.py', 'b.py']);
    T.select('a.py', 'single');
    T.select('d.py', 'range', ['a.py', 'b.py', 'c.py', 'd.py', 'e.py']);
    assert.deepStrictEqual(depuisBac(Array.from(T.state.selected)), ['a.py', 'b.py', 'c.py', 'd.py']);
});

t('cibles d\'une action : la sélection si la ligne en fait partie, sinon la ligne seule', () => {
    T.select('src', 'single');
    T.select('src/a.py', 'toggle');
    T.select('lib/b.py', 'toggle');
    // « src/a.py » est DANS « src » : supprimer le dossier suffit.
    assert.deepStrictEqual(depuisBac(T.targetsFor('lib/b.py')).sort(), ['lib/b.py', 'src']);
    assert.deepStrictEqual(depuisBac(T.targetsFor('autre.py')), ['autre.py']);
    T.clearSelection();
    assert.deepStrictEqual(depuisBac(T.targetsFor('src')), ['src']);
});

t('pastilles Git : les dossiers ancêtres sont marqués', () => {
    T.setGit({ 'src/deep/a.py': 'M', 'notes.md': 'U' });
    assert.ok(T.state.gitDirs.has('src'));
    assert.ok(T.state.gitDirs.has('src/deep'));
    assert.ok(!T.state.gitDirs.has('notes.md'));
});

t('dossiers ouverts : ancêtres dépliés par « Localiser »', () => {
    T.collapseAll();
    T.reveal('src/deep/inner/b.py');
    assert.ok(T.isOpen('src') && T.isOpen('src/deep') && T.isOpen('src/deep/inner'));
    assert.ok(!T.isOpen('src/deep/inner/b.py'));
    T.reveal('docs', { folder: true });
    assert.ok(T.isOpen('docs'));
});

fin();
