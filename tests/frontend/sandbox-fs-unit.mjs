// SPDX-License-Identifier: MIT
// ============================================================
//  tests/frontend/sandbox-fs-unit.mjs
//  Lancer : node tests/frontend/sandbox-fs-unit.mjs
//
//  Cible : frontend/js/editor/_sandbox_fs.js — renommage/déplacement
//  de fichiers dans l'éditeur, et lecture du flux de progression des
//  snapshots.
//
//  POURQUOI CE TEST
//  ================
//
//  1. RENOMMER UN DOSSIER TOUCHE QUATRE ÉTATS À LA FOIS (``:313-335``)
//     — les modèles Monaco, les instantanés ``originalFileContent``
//     (détection dirty et diff), les chemins des onglets ouverts, et
//     ``activeTabPath``. Oublier UN SEUL des quatre laisse un état
//     DUAL : l'onglet affiche l'ancien chemin, le modèle vit sous le
//     nouveau, et la prochaine sauvegarde écrit à côté. Les quatre
//     sont vérifiés séparément ici, pour qu'un oubli soit nommé.
//
//     Ce bloc est DUPLIQUÉ quasi à l'identique entre ``moveItem``
//     (``:208-229``) et ``renameItem`` (``:313-335``). Les deux
//     chemins sont donc testés symétriquement : c'est la seule façon
//     qu'une correction appliquée d'un seul côté rougisse.
//
//  2. LE PRÉFIXE PARTIEL — le filtre est
//     ``p === oldPath || p.startsWith(oldPath + '/')``. Le ``+ '/'``
//     est tout : sans lui, renommer ``src`` migrerait aussi ``src2``,
//     ``srcbackup`` et ``src.old``. L'utilisateur perdrait des onglets
//     sur des fichiers auxquels il n'a pas touché. Cas dédié.
//
//  3. LE FLUX NDJSON (``:587``) — ``buf.split('\n')`` puis
//     ``lines.pop()`` : la dernière ligne, potentiellement incomplète,
//     est gardée pour le morceau suivant. Les cas ci-dessous coupent
//     VOLONTAIREMENT au milieu d'une ligne, y compris au milieu d'un
//     caractère multi-octets — une liste de morceaux tous terminés par
//     un saut de ligne ne testerait rien.
//
//  4. L'ASYMÉTRIE DE ``_applyProgressEvent`` (``:627-637``) —
//     ``current_file`` est ÉCRASÉ par '' quand l'événement ne le porte
//     pas, tandis que ``phase`` est CONSERVÉE. C'est voulu (le fichier
//     courant est instantané, la phase dure) mais parfaitement
//     invisible à la lecture : une « harmonisation » des deux casserait
//     l'affichage dans un sens ou dans l'autre.
//
//  NOTE SUR LE MONTAGE — ``snapshotProgress`` et ``snapshotBusy`` sont
//  créés DANS l'usine et rendus par elle : on les lit sur l'API, pas
//  sur ``sharedRefs`` (contrairement à ``openTabs`` ou ``models``, qui
//  sont partagés avec le reste de l'éditeur). La distinction n'a rien
//  d'évident de l'extérieur.
//
//  Ce module lit par ailleurs ``Vue.computed`` sur la GLOBALE
//  ``Vue`` (``:422``) et non sur le ``vue`` qu'on lui injecte, pour son
//  seul ``filteredFilesList``. Il faut donc poser ``Vue`` dans le bac
//  en plus de passer ``vue`` en argument. Ce n'est pas un détail de
//  test : ça veut dire que le module ne peut pas être monté sans une
//  globale Vue, contrairement à tous ses voisins.
// ============================================================

import { t, ta, fin, assert } from './lib/harnais.js';
import { charger, depuisBac } from './lib/charger.js';
import { vueMini, refsDeclares, ctxMuet, depsMuets, reponseJson, reponseNdjson } from './lib/stubs.js';

/**
 * Monte le module avec un espace de travail contrôlé.
 *
 * `onglets` : liste de chemins ouverts. `actif` : chemin de l'onglet actif.
 */
function monter(options) {
    const o = options || {};
    const vue = vueMini();
    // Voir la NOTE SUR LE MONTAGE en tête de fichier.
    const C = charger('editor/_sandbox_fs.js', { bac: { Vue: vue } });

    const chemins = o.onglets || [];
    const refs = refsDeclares({
        sandboxFiles: o.arbre || [],
        sandboxSearch: '',
        sandboxSearchMode: 'name',
        sandboxSearchResults: [],
        openTabs: chemins.map((p) => ({ path: p, name: p.split('/').pop() })),
        activeTabPath: o.actif !== undefined ? o.actif : (chemins[0] || null),
        editorFilePath: '',
        showHiddenFiles: false,
    });
    // `models` et `originalFileContent` sont des objets NUS dans sharedRefs
    // (le module fait `Object.keys(models)`), pas des refs. On contourne
    // donc l'enveloppement automatique de refsDeclares.
    const models = {};
    const contenusOrigine = {};
    for (const p of chemins) { models[p] = { id: p }; contenusOrigine[p] = 'contenu de ' + p; }
    refs.models = models;
    refs.originalFileContent = contenusOrigine;
    refs.monacoRef = { instance: null };

    const journal = [];
    const ctx = ctxMuet({
        showToast: (msg, type) => journal.push({ toast: msg, type: type || 'info' }),
        openPrompt: async () => (o.nouveauNom !== undefined ? o.nouveauNom : 'neuf'),
        openConfirm: async () => true,
        fetchAuth: async (url, init) => {
            journal.push({ url, body: init && init.body });
            if (o.fetchAuth) return o.fetchAuth(url, init);
            if (url.includes('snapshots/create') || url.includes('snapshots/restore')) {
                return reponseNdjson(o.morceaux || []);
            }
            if (o.echecRename && url.includes('rename')) {
                return reponseJson({ detail: 'nom déjà utilisé' }, { ok: false, status: 409 });
            }
            return reponseJson({ files: [], items: [] });
        },
    });

    const migrations = [];
    const callbacks = depsMuets({
        _sbUrl: (e) => '/api/sandbox/' + e,
        _migrateModel: (avant, apres) => {
            migrations.push([avant, apres]);
            if (models[avant] !== undefined) { models[apres] = models[avant]; delete models[avant]; }
        },
        isSpecialPath: () => false,
        ...(o.callbacks || {}),
    });

    const api = C.fabrique('setupEditorSandboxFs', [vue, refs, ctx, callbacks]);
    return {
        api, refs, ctx, vue, journal, migrations, models, contenusOrigine,
        /** Chemins des onglets ouverts, dans l'ordre. */
        onglets: () => depuisBac(refs.openTabs.value).map((x) => x.path),
        /** Noms affichés des onglets. */
        nomsOnglets: () => depuisBac(refs.openTabs.value).map((x) => x.name),
        toasts: () => journal.filter((j) => j.toast).map((j) => j.toast),
    };
}

// ── Renommage : les quatre états migrés ──────────────────────

await ta('RENOMMER un fichier migre son modèle Monaco', async () => {
    const v = monter({ onglets: ['a.txt'], nouveauNom: 'b.txt' });
    await v.api.renameItem('a.txt');
    assert.deepStrictEqual(v.migrations, [['a.txt', 'b.txt']]);
    assert.ok(v.models['b.txt'], 'le modèle doit exister sous le nouveau chemin');
    assert.equal(v.models['a.txt'], undefined, 'et plus sous l\'ancien');
});

await ta('RENOMMER migre l\'instantané de contenu (détection dirty et diff)', async () => {
    const v = monter({ onglets: ['a.txt'], nouveauNom: 'b.txt' });
    await v.api.renameItem('a.txt');
    assert.equal(v.contenusOrigine['b.txt'], 'contenu de a.txt');
    assert.equal(v.contenusOrigine['a.txt'], undefined,
        'sans la suppression, l\'ancien instantané fantôme fausse le dirty');
});

await ta('RENOMMER met à jour le chemin ET le nom de l\'onglet', async () => {
    const v = monter({ onglets: ['dossier/a.txt'], nouveauNom: 'b.txt' });
    await v.api.renameItem('dossier/a.txt');
    assert.deepStrictEqual(v.onglets(), ['dossier/b.txt']);
    assert.deepStrictEqual(v.nomsOnglets(), ['b.txt']);
});

await ta('RENOMMER suit l\'onglet ACTIF', async () => {
    const v = monter({ onglets: ['a.txt', 'c.txt'], actif: 'a.txt', nouveauNom: 'b.txt' });
    await v.api.renameItem('a.txt');
    assert.equal(v.refs.activeTabPath.value, 'b.txt');
});

await ta('RENOMMER un DOSSIER migre les quatre états de TOUS ses fichiers', async () => {
    const v = monter({
        onglets: ['src/a.js', 'src/sous/b.js', 'autre/c.js'],
        actif: 'src/sous/b.js',
        nouveauNom: 'lib',
    });
    await v.api.renameItem('src');

    // 1. modèles Monaco
    assert.ok(v.models['lib/a.js'] && v.models['lib/sous/b.js']);
    assert.ok(!v.models['src/a.js'] && !v.models['src/sous/b.js']);
    // 2. instantanés
    assert.equal(v.contenusOrigine['lib/sous/b.js'], 'contenu de src/sous/b.js');
    assert.equal(v.contenusOrigine['src/sous/b.js'], undefined);
    // 3. chemins d'onglets
    assert.deepStrictEqual(v.onglets().sort(), ['autre/c.js', 'lib/a.js', 'lib/sous/b.js']);
    // 4. onglet actif
    assert.equal(v.refs.activeTabPath.value, 'lib/sous/b.js');
});

await ta('RENOMMER un dossier ne touche PAS les fichiers hors de lui', async () => {
    const v = monter({ onglets: ['src/a.js', 'autre/c.js'], actif: 'autre/c.js', nouveauNom: 'lib' });
    await v.api.renameItem('src');
    assert.ok(v.models['autre/c.js'], 'un fichier hors du dossier ne doit pas bouger');
    assert.equal(v.contenusOrigine['autre/c.js'], 'contenu de autre/c.js');
    assert.equal(v.refs.activeTabPath.value, 'autre/c.js');
});

// ── LE PRÉFIXE PARTIEL ───────────────────────────────────────

await ta('PRÉFIXE : renommer « src » NE migre PAS « src2 », « srcbackup » ni « src.old »', async () => {
    // Le `+ '/'` du filtre est tout : sans lui, l'utilisateur perd des
    // onglets sur des fichiers auxquels il n'a pas touché.
    const v = monter({
        onglets: ['src/a.js', 'src2/b.js', 'srcbackup/c.js', 'src.old'],
        actif: 'src2/b.js',
        nouveauNom: 'lib',
    });
    await v.api.renameItem('src');

    assert.deepStrictEqual(v.onglets().sort(), ['lib/a.js', 'src.old', 'src2/b.js', 'srcbackup/c.js']);
    assert.deepStrictEqual(v.migrations, [['src/a.js', 'lib/a.js']],
        'une seule migration attendue, reçu : ' + JSON.stringify(v.migrations));
    assert.equal(v.refs.activeTabPath.value, 'src2/b.js', 'l\'onglet actif voisin ne doit pas bouger');
});

await ta('PRÉFIXE : la même garde vaut pour le DÉPLACEMENT', async () => {
    const v = monter({ onglets: ['src/a.js', 'src2/b.js'], actif: 'src2/b.js' });
    await v.api.moveItem('src', 'archives');
    assert.deepStrictEqual(v.onglets().sort(), ['archives/src/a.js', 'src2/b.js']);
    assert.equal(v.refs.activeTabPath.value, 'src2/b.js');
});

// ── Déplacement : symétrie avec le renommage ─────────────────

await ta('DÉPLACER un fichier migre les quatre états', async () => {
    const v = monter({ onglets: ['a.txt'], actif: 'a.txt' });
    await v.api.moveItem('a.txt', 'archives');
    assert.deepStrictEqual(v.migrations, [['a.txt', 'archives/a.txt']]);
    assert.equal(v.contenusOrigine['archives/a.txt'], 'contenu de a.txt');
    assert.deepStrictEqual(v.onglets(), ['archives/a.txt']);
    assert.equal(v.refs.activeTabPath.value, 'archives/a.txt');
});

await ta('DÉPLACER vers la racine retire le préfixe de dossier', async () => {
    const v = monter({ onglets: ['dossier/a.txt'], actif: 'dossier/a.txt' });
    await v.api.moveItem('dossier/a.txt', '');
    assert.deepStrictEqual(v.onglets(), ['a.txt']);
    assert.equal(v.refs.activeTabPath.value, 'a.txt');
});

await ta('DÉPLACER un dossier migre toute sa descendance', async () => {
    const v = monter({ onglets: ['src/a.js', 'src/sous/b.js'], actif: 'src/sous/b.js' });
    await v.api.moveItem('src', 'archives');
    assert.deepStrictEqual(v.onglets().sort(), ['archives/src/a.js', 'archives/src/sous/b.js']);
    assert.equal(v.refs.activeTabPath.value, 'archives/src/sous/b.js');
});

await ta('DÉPLACER au même endroit est un no-op (aucun aller-retour)', async () => {
    const v = monter({ onglets: ['dossier/a.txt'] });
    await v.api.moveItem('dossier/a.txt', 'dossier');
    assert.equal(v.journal.filter((j) => j.url).length, 0, 'aucune requête ne doit partir');
});

await ta('DÉPLACER sans chemin est un no-op', async () => {
    const v = monter({ onglets: [] });
    await v.api.moveItem('', 'ailleurs');
    await v.api.moveItem(null, 'ailleurs');
    assert.equal(v.journal.filter((j) => j.url).length, 0);
});

// ── Garde-fou sur le nom ─────────────────────────────────────

await ta('un basename contenant « / » est REFUSÉ (ce serait un déplacement déguisé)', async () => {
    const v = monter({ onglets: ['a.txt'], nouveauNom: 'sous/b.txt' });
    await v.api.renameItem('a.txt');
    assert.equal(v.journal.filter((j) => j.url).length, 0, 'aucun rename ne doit partir');
    assert.ok(v.toasts().some((m) => m.includes('/')), 'un message doit expliquer le refus');
    assert.deepStrictEqual(v.onglets(), ['a.txt']);
});

await ta('un basename contenant un antislash est refusé aussi', async () => {
    const v = monter({ onglets: ['a.txt'], nouveauNom: 'sous\\b.txt' });
    await v.api.renameItem('a.txt');
    assert.equal(v.journal.filter((j) => j.url).length, 0);
});

await ta('renommer à l\'identique ou vers un nom vide est un no-op', async () => {
    for (const nom of ['a.txt', '', '   ', null]) {
        const v = monter({ onglets: ['a.txt'], nouveauNom: nom });
        await v.api.renameItem('a.txt');
        assert.equal(v.journal.filter((j) => j.url).length, 0, 'nom : ' + JSON.stringify(nom));
    }
});

await ta('le nouveau nom est détouré des espaces', async () => {
    const v = monter({ onglets: ['a.txt'], nouveauNom: '  b.txt  ' });
    await v.api.renameItem('a.txt');
    assert.deepStrictEqual(v.onglets(), ['b.txt']);
});

// ── Échec backend : pas de migration muette ──────────────────

await ta('un rename REFUSÉ par le serveur ne migre RIEN et explique la cause', async () => {
    const v = monter({ onglets: ['a.txt'], actif: 'a.txt', nouveauNom: 'b.txt', echecRename: true });
    await v.api.renameItem('a.txt');
    assert.deepStrictEqual(v.onglets(), ['a.txt'], 'aucun onglet ne doit avoir bougé');
    assert.deepStrictEqual(v.migrations, []);
    assert.equal(v.refs.activeTabPath.value, 'a.txt');
    assert.ok(v.toasts().some((m) => m.includes('nom déjà utilisé')),
        'le detail du serveur doit remonter — reçu : ' + v.toasts().join(' | '));
});

await ta('un déplacement REFUSÉ ne migre rien non plus (pas d\'échec silencieux)', async () => {
    // Sans branche else, l'item re-snappait à sa place et l'utilisateur
    // croyait simplement que « le fichier ne bouge pas ».
    const v = monter({ onglets: ['a.txt'], actif: 'a.txt', echecRename: true });
    await v.api.moveItem('a.txt', 'archives');
    assert.deepStrictEqual(v.onglets(), ['a.txt']);
    assert.ok(v.toasts().some((m) => m.includes('nom déjà utilisé')),
        'reçu : ' + v.toasts().join(' | '));
});

// ── Le flux NDJSON ───────────────────────────────────────────

/** Lit un flux de snapshot livré en `morceaux` et rend la progression finale. */
async function fluxSnapshot(morceaux) {
    const v = monter({ morceaux });
    await v.api.createSnapshot();
    return { progression: depuisBac(v.api.snapshotProgress.value), v };
}

await ta('NDJSON : une ligne COUPÉE entre deux morceaux est recollée', async () => {
    // Le `progress` est coupé en plein milieu de son JSON.
    const { progression } = await fluxSnapshot([
        '{"event":"start","total_files":10,"total_bytes":1000}\n{"event":"progr',
        'ess","pct":50,"files_done":5}\n',
    ]);
    assert.equal(progression.pct, 50, 'la ligne recollée n\'a pas été lue');
    assert.equal(progression.files_done, 5);
    assert.equal(progression.total_files, 10, 'le start doit avoir été lu aussi');
});

await ta('NDJSON : une ligne coupée au milieu d\'un caractère accentué est recollée', async () => {
    // « é » fait deux octets en UTF-8 : le TextDecoder en mode stream
    // doit garder l'octet orphelin pour le morceau suivant.
    const enc = new TextEncoder();
    const complet = enc.encode('{"event":"progress","pct":7,"current_file":"café.txt"}\n');
    const coupe = complet.indexOf(0xC3);      // premier octet du « é »
    const { progression } = await fluxSnapshot([
        complet.slice(0, coupe + 1),
        complet.slice(coupe + 1),
    ]);
    assert.equal(progression.pct, 7);
    assert.equal(progression.current_file, 'café.txt');
});

await ta('NDJSON : le résidu SANS saut de ligne final est tout de même traité', async () => {
    const { progression } = await fluxSnapshot([
        '{"event":"start","total_files":3}\n',
        '{"event":"progress","pct":99}',        // pas de \n : c'est le résidu
    ]);
    assert.equal(progression.pct, 99);
});

await ta('NDJSON : une ligne CORROMPUE est sautée sans interrompre le flux', async () => {
    const { progression } = await fluxSnapshot([
        '{"event":"start","total_files":3}\n',
        'pas du tout du json\n',
        '{"event":"progress","pct":42}\n',
    ]);
    assert.equal(progression.pct, 42, 'le flux doit continuer après une ligne illisible');
    assert.equal(progression.total_files, 3);
});

await ta('NDJSON : les lignes vides sont ignorées', async () => {
    const { progression } = await fluxSnapshot([
        '{"event":"start","total_files":3}\n\n\n   \n{"event":"progress","pct":11}\n',
    ]);
    assert.equal(progression.pct, 11);
});

await ta('NDJSON : un flux vide ne fait rien tomber', async () => {
    const { progression } = await fluxSnapshot([]);
    assert.equal(progression.pct, 0);
});

await ta('NDJSON : le lecteur est annulé à la fin du flux', async () => {
    const reponse = reponseNdjson(['{"event":"done"}\n']);
    const v = monter({ fetchAuth: async () => reponse });
    await v.api.createSnapshot();
    assert.equal(reponse.annule, true, 'le reader doit être libéré');
});

await ta('NDJSON : un découpage octet par octet donne le même résultat', async () => {
    const enc = new TextEncoder();
    const texte = '{"event":"start","total_files":4}\n{"event":"progress","pct":73,"files_done":3}\n';
    const octets = enc.encode(texte);
    const morceaux = Array.from(octets, (o) => Uint8Array.of(o));
    const { progression } = await fluxSnapshot(morceaux);
    assert.equal(progression.pct, 73);
    assert.equal(progression.files_done, 3);
    assert.equal(progression.total_files, 4);
});

// ── _applyProgressEvent : l'asymétrie ────────────────────────

await ta('start remet TOUS les compteurs à zéro et pose les totaux', async () => {
    const { progression } = await fluxSnapshot([
        '{"event":"progress","pct":90,"files_done":9}\n',
        '{"event":"start","total_files":5,"total_bytes":500,"phase":"copie"}\n',
    ]);
    assert.deepStrictEqual(progression, {
        pct: 0, files_done: 0, total_files: 5, bytes_done: 0,
        total_bytes: 500, current_file: '', phase: 'copie',
    });
});

await ta('phase ne touche QUE la phase', async () => {
    const { progression } = await fluxSnapshot([
        '{"event":"start","total_files":5,"total_bytes":500}\n',
        '{"event":"progress","pct":40,"files_done":2,"current_file":"x.txt"}\n',
        '{"event":"phase","phase":"compression"}\n',
    ]);
    assert.equal(progression.phase, 'compression');
    assert.equal(progression.pct, 40, 'la progression ne doit pas être remise à zéro');
    assert.equal(progression.files_done, 2);
    assert.equal(progression.current_file, 'x.txt');
});

await ta('ASYMÉTRIE : current_file est EFFACÉ quand l\'événement ne le porte pas', async () => {
    // Le fichier courant est instantané : le garder afficherait un
    // fichier qu'on ne traite plus.
    const { progression } = await fluxSnapshot([
        '{"event":"progress","pct":10,"current_file":"a.txt"}\n',
        '{"event":"progress","pct":20}\n',
    ]);
    assert.equal(progression.current_file, '');
});

await ta('ASYMÉTRIE : phase est CONSERVÉE quand l\'événement ne la porte pas', async () => {
    // La phase dure : l'effacer ferait clignoter le libellé.
    const { progression } = await fluxSnapshot([
        '{"event":"progress","pct":10,"phase":"copie"}\n',
        '{"event":"progress","pct":20}\n',
    ]);
    assert.equal(progression.phase, 'copie');
    assert.equal(progression.pct, 20);
});

await ta('un compteur absent d\'un progress garde sa valeur précédente', async () => {
    const { progression } = await fluxSnapshot([
        '{"event":"progress","pct":10,"files_done":3,"bytes_done":300,"total_files":9}\n',
        '{"event":"progress","pct":20}\n',
    ]);
    assert.equal(progression.files_done, 3);
    assert.equal(progression.bytes_done, 300);
    assert.equal(progression.total_files, 9);
});

await ta('un compteur à ZÉRO est bien appliqué (ce n\'est pas une absence)', async () => {
    const { progression } = await fluxSnapshot([
        '{"event":"progress","pct":50,"files_done":7}\n',
        '{"event":"progress","pct":0,"files_done":0}\n',
    ]);
    assert.equal(progression.pct, 0);
    assert.equal(progression.files_done, 0);
});

await ta('un pct non numérique est ignoré au profit du précédent', async () => {
    const { progression } = await fluxSnapshot([
        '{"event":"progress","pct":33}\n',
        '{"event":"progress","pct":"beaucoup"}\n',
    ]);
    assert.equal(progression.pct, 33);
});

await ta('un événement inconnu ne perturbe pas la progression', async () => {
    const { progression } = await fluxSnapshot([
        '{"event":"progress","pct":55}\n',
        '{"event":"quelque_chose_de_neuf","x":1}\n',
    ]);
    assert.equal(progression.pct, 55);
});

// ── État de l'opération ──────────────────────────────────────

await ta('l\'occupation retombe à « idle » à la fin, même après une erreur', async () => {
    const ok = monter({ morceaux: ['{"event":"done"}\n'] });
    await ok.api.createSnapshot();
    assert.equal(ok.api.snapshotBusy.value, 'idle');

    const ko = monter({ morceaux: ['{"event":"error","message":"disque plein"}\n'] });
    await ko.api.createSnapshot();
    assert.equal(ko.api.snapshotBusy.value, 'idle');
    assert.ok(ko.toasts().includes('disque plein'), 'reçu : ' + ko.toasts().join(' | '));
});

await ta('une seconde création est refusée tant que la première tourne', async () => {
    const v = monter({ morceaux: ['{"event":"done"}\n'] });
    v.api.snapshotBusy.value = 'create';
    await v.api.createSnapshot();
    assert.equal(v.journal.filter((j) => j.url).length, 0);
});

fin();
