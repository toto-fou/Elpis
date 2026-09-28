// SPDX-License-Identifier: MIT
// ============================================================
//  tests/frontend/test_voice_segments.js
//
//  Le découpage en phrases de la lecture vocale. Il vit dans le
//  navigateur parce qu'il travaille sur un flux EN COURS de génération :
//  il doit rendre un morceau dès qu'il est prononçable, sans jamais
//  couper au milieu d'un groupe de souffle ni laisser passer du code.
//
//  ⚠ ``depuisBac()`` avant tout deepStrictEqual : les valeurs nées dans
//  le bac vm n'ont pas les intrinsèques de l'hôte.
// ============================================================
'use strict';

const { t, fin, assert } = require('./lib/harnais.js');
const { charger, depuisBac } = require('./lib/charger.js');

const creeSegmenteur = charger('chat/_voice.js').g('voiceSegmenter');

/** Pousse un texte par petits fragments, comme un flux de tokens. */
function enFlux(seg, texte, taille) {
    const morceaux = [];
    const pas = taille || 7;
    for (let i = 0; i < texte.length; i += pas) {
        morceaux.push.apply(morceaux, depuisBac(seg.push(texte.slice(i, i + pas))));
    }
    morceaux.push.apply(morceaux, depuisBac(seg.flush()));
    return morceaux;
}

t('une phrase complète sort entière', () => {
    const seg = creeSegmenteur({ premier: 40, suivant: 160 });
    assert.deepStrictEqual(depuisBac(seg.push('Bonjour tout le monde. ')),
        ['Bonjour tout le monde.']);
});

t('rien ne sort tant que la phrase est incomplète', () => {
    const seg = creeSegmenteur({ premier: 400, suivant: 400 });
    assert.deepStrictEqual(depuisBac(seg.push('Bonjour tout')), []);
});

t('le premier morceau part plus tôt que les suivants', () => {
    // C'est tout l'intérêt : le son démarre pendant que la réponse s'écrit.
    const seg = creeSegmenteur({ premier: 20, suivant: 400 });
    const premier = depuisBac(seg.push('Voici une réponse, assez longue, '));
    assert.equal(premier.length, 1, 'le premier morceau aurait dû partir');
    const second = depuisBac(seg.push('qui continue encore un peu, '));
    assert.deepStrictEqual(second, [], 'le second attend un seuil bien plus haut');
});

t("un point d'abréviation ne coupe pas la phrase", () => {
    const seg = creeSegmenteur({ premier: 400, suivant: 400 });
    assert.deepStrictEqual(depuisBac(seg.push('M. Dupont arrive. ')),
        ['M. Dupont arrive.']);
});

t('une initiale isolée ne coupe pas non plus', () => {
    const seg = creeSegmenteur({ premier: 400, suivant: 400 });
    assert.deepStrictEqual(depuisBac(seg.push('J. Dupont arrive. ')),
        ['J. Dupont arrive.']);
});

t('un nombre décimal ne coupe pas la phrase', () => {
    const seg = creeSegmenteur({ premier: 400, suivant: 400 });
    assert.deepStrictEqual(depuisBac(seg.push('Il reste 3.14 litres dans le bidon. ')),
        ['Il reste 3.14 litres dans le bidon.']);
});

t('le guillemet fermant reste avec sa phrase', () => {
    // Typographie française : « Vraiment ? » — une espace avant la fermante.
    const seg = creeSegmenteur({ premier: 400, suivant: 400 });
    assert.deepStrictEqual(depuisBac(seg.push('« Vraiment ?! » dit-il. ')),
        ['« Vraiment ?! »', 'dit-il.']);
});

t("un bloc de code n'est jamais prononcé", () => {
    const seg = creeSegmenteur({ premier: 40, suivant: 160 });
    const tout = enFlux(seg, 'Voici le correctif.\n```python\nprint("secret")\n```\nEt voilà.').join(' ');
    assert.ok(tout.indexOf('print') < 0, 'du code est parti à la synthèse : ' + tout);
    assert.ok(tout.indexOf('secret') < 0);
    assert.ok(tout.indexOf('Voici le correctif.') >= 0);
    assert.ok(tout.indexOf('Et voilà.') >= 0);
});

t('une fence coupée en deux fragments est quand même reconnue', () => {
    // Le cas qui casse une détection naïve : les trois accents graves
    // arrivent à cheval sur deux tokens.
    const seg = creeSegmenteur({ premier: 40, suivant: 160 });
    const dit = [].concat(
        depuisBac(seg.push('Regarde bien ceci. ``')),
        depuisBac(seg.push('`js\nconst secret = 1;\n``')),
        depuisBac(seg.push('`\nTerminé. ')),
        depuisBac(seg.flush()));
    const tout = dit.join(' ');
    assert.ok(tout.indexOf('secret') < 0, 'la fence coupée a laissé passer du code : ' + tout);
    assert.ok(tout.indexOf('Terminé.') >= 0);
});

t('une fence jamais refermée ne libère pas le code au flush', () => {
    const seg = creeSegmenteur({ premier: 40, suivant: 160 });
    const tout = [].concat(depuisBac(seg.push('Voilà le début. ```py\nx = 1')),
                           depuisBac(seg.flush())).join(' ');
    assert.ok(tout.indexOf('x = 1') < 0, 'réponse coupée en plein bloc : ' + tout);
});

t('un long texte sans ponctuation finit par sortir', () => {
    // Sans garde-fou, le tampon grossirait indéfiniment et rien ne serait lu.
    const seg = creeSegmenteur({ premier: 20, suivant: 20 });
    const dit = depuisBac(seg.push('a'.repeat(200)));
    assert.ok(dit.length >= 1, 'rien ne sort : le tampon grossit sans fin');
});

t('le flush rend le reste même sans ponctuation finale', () => {
    const seg = creeSegmenteur({ premier: 400, suivant: 400 });
    assert.deepStrictEqual(depuisBac(seg.push('Une fin sans point')), []);
    assert.deepStrictEqual(depuisBac(seg.flush()), ['Une fin sans point']);
});

t('flush sur un tampon vide ne rend rien', () => {
    const seg = creeSegmenteur({ premier: 40, suivant: 160 });
    assert.deepStrictEqual(depuisBac(seg.flush()), []);
});

t('reset repart du seuil « premier morceau »', () => {
    const seg = creeSegmenteur({ premier: 20, suivant: 400 });
    seg.push('Une première réponse, déjà bien longue, ');
    seg.reset();
    const apres = depuisBac(seg.push('Un départ, puis une suite assez longue derrière. '));
    assert.ok(apres.length >= 1, "le seuil « premier morceau » n'a pas été rétabli");
});

t("le découpage en flux rend le même texte que d'un bloc", () => {
    const texte = 'Première phrase. Deuxième phrase ! Et une troisième ? Fin.';
    const a = enFlux(creeSegmenteur({ premier: 40, suivant: 160 }), texte, 3).join(' ');
    const b = enFlux(creeSegmenteur({ premier: 40, suivant: 160 }), texte, 999).join(' ');
    assert.equal(a.replace(/\s+/g, ' '), b.replace(/\s+/g, ' '));
});

t('« 1. » d\'une liste numérotée ne part pas seul', () => {
    const seg = creeSegmenteur({ premier: 400, suivant: 400 });
    const morceaux = enFlux(seg, '1. Ouvrez le fichier de configuration.\n2. Relancez le service. ');
    assert.ok(morceaux.every(function (m) { return !/^\d+\.$/.test(m); }),
        'un numéro de liste est parti seul : ' + JSON.stringify(morceaux));
});

t('un bloc ~~~ n\'est pas lu', () => {
    const seg = creeSegmenteur({ premier: 40, suivant: 160 });
    const morceaux = enFlux(seg, 'Voici la commande.\n~~~bash\nrm -rf /tmp/essai\n~~~\nC\'est tout. ', 3);
    assert.ok(morceaux.join(' ').indexOf('rm -rf') < 0, 'du code est lu : ' + JSON.stringify(morceaux));
    assert.ok(morceaux.join(' ').indexOf('tout') >= 0);
});

fin();
