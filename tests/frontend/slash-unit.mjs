// SPDX-License-Identifier: MIT
// ============================================================
//  tests/frontend/slash-unit.mjs
//  Lancer : node tests/frontend/slash-unit.mjs
//
//  Cible : frontend/js/chat/_slash.js — le menu « / » du composeur et
//  la résolution des commandes à l'envoi.
//
//  POURQUOI CE TEST
//  ================
//  Le module a DEUX points d'entrée qui doivent rester d'accord :
//  le menu (frappe → contexte → liste) et ``slashResolve`` (Entrée →
//  commande). Sans le second, « /plan on » suivi d'Entrée partirait au
//  modèle comme un message ordinaire.
//
//  Trois pièges valent un verrou :
//
//   1. « /srv/projet » NE DOIT PAS ouvrir le menu ni être résolu
//      comme une commande. Le régime TÊTE exige ``^\/[\w.\-]*`` et
//      s'arrête au premier « / » suivant — un chemin absolu collé en
//      début de composeur est un cas de tous les jours.
//
//   2. Une commande INCONNUE part au modèle (``slashResolve`` rend
//      ``null``), tout comme ``/skills`` et ``/prompt`` qui sont des
//      MENUS et non des actions. Si l'un des deux se mettait à
//      « s'exécuter », taper /skills enverrait un ordre au lieu
//      d'ouvrir une liste.
//
//   3. Le tri de ``_pack`` fait DEUX paquets : les préfixes d'abord,
//      les sous-chaînes ensuite, chacun trié. Inverser les deux rend
//      le menu inutilisable au clavier — la première rangée, celle
//      que valide Entrée, n'est plus celle qu'on vise.
//
//  Enfin, le menu « @mention » est PRIORITAIRE sur « / » : les deux
//  listes se superposeraient sinon.
// ============================================================

import { t, ta, fin, assert } from './lib/harnais.js';
import { charger, depuisBac } from './lib/charger.js';
import { vueMini, refsDeclares, ctxMuet, reponseJson, elementFactice } from './lib/stubs.js';

const C = charger('chat/_slash.js');

const SKILLS = [
    { name: 'rediger', domain: 'texte', description: 'Rédiger un document', tags: ['doc'] },
    { name: 'auditer', domain: 'code', description: 'Auditer du code', tags: ['revue'] },
    { name: 'creatif', domain: 'texte', description: 'Idées créatives', tags: [] },
];
const PROMPTS = [
    { title: 'Résumé', content: 'Résume ce texte' },
    { title: 'Traduction', content: 'Traduis en anglais' },
];

/** Monte le module avec un composeur contrôlé. */
function monter(options) {
    const o = options || {};
    const zone = elementFactice({ selectionStart: 0 });
    const refs = refsDeclares({
        inputRef: zone,
        inputMessage: '',
        showMentionDropdown: o.mention || false,
    });
    const ctx = ctxMuet({
        env: o.env || { planMode: false, admin: true },
        fetchAuth: async (url) => {
            // Formes RÉELLES des deux routes : /api/skills rend
            // { skills: [...] }, /api/prompts rend { items: [...] }.
            if (url.includes('skill')) return reponseJson({ skills: SKILLS });
            if (url.includes('prompt')) return reponseJson({ items: PROMPTS });
            return reponseJson({});
        },
    });
    const api = C.fabrique('setupChatSlash', [vueMini(), refs, ctx]);

    return {
        api, refs, ctx, zone,
        /** Simule la frappe de `texte`, curseur en fin (ou à `curseur`). */
        taper(texte, curseur) {
            refs.inputMessage.value = texte;
            zone.selectionStart = curseur === undefined ? texte.length : curseur;
            api.onInput();
            return depuisBac(api.slashRaw.value);
        },
        /** Noms des rangées actuellement proposées. */
        rangees() {
            return depuisBac(api.slashList.value).map((x) => x.name || x.title || x.value);
        },
    };
}

/** Laisse tourner les promesses en attente (chargements paresseux). */
const souffler = () => new Promise((r) => setTimeout(r, 0));

// ── Le contexte de saisie ────────────────────────────────────

t('« / » seul ouvre le menu en régime TÊTE', () => {
    const v = monter();
    const c = v.taper('/');
    assert.equal(c.head, true);
    assert.equal(c.name, '');
    assert.equal(c.hasSpace, false);
});

t('« /pl » capture le nom partiel', () => {
    const v = monter();
    assert.equal(v.taper('/pl').name, 'pl');
});

t('un espace après le nom ouvre le régime « arguments »', () => {
    const v = monter();
    const c = v.taper('/plan ');
    assert.equal(c.name, 'plan');
    assert.equal(c.hasSpace, true);
    assert.equal(c.trailing, true, 'espace final = on commence un NOUVEL argument');
    assert.deepStrictEqual(c.words, []);
});

t('les arguments tapés sont découpés en mots', () => {
    const v = monter();
    const c = v.taper('/plan on extra');
    assert.deepStrictEqual(c.words, ['on', 'extra']);
    assert.equal(c.raw, 'on extra');
    assert.equal(c.trailing, false);
});

t('PIÈGE : « /srv/projet » n\'ouvre PAS le menu', () => {
    const v = monter();
    assert.equal(v.taper('/srv/projet'), null);
    assert.equal(v.taper('/usr/local/bin'), null);
});

t('un « / » au fil du texte ouvre le régime INLINE, sans argument', () => {
    const v = monter();
    const c = v.taper('explique-moi /redi');
    assert.equal(c.head, false);
    assert.equal(c.name, 'redi');
    assert.equal(c.hasSpace, false);
    assert.deepStrictEqual(c.words, [], 'le régime inline ne prend pas d\'argument');
});

t('le régime INLINE borne bien le fragment à remplacer', () => {
    const v = monter();
    const c = v.taper('explique-moi /redi');
    assert.equal('explique-moi /redi'.slice(c.start, c.end), '/redi');
});

t('un « / » collé à un mot n\'ouvre rien', () => {
    const v = monter();
    assert.equal(v.taper('et/ou'), null);
    assert.equal(v.taper('a/b'), null);
});

t('un saut de ligne termine la commande et referme le menu', () => {
    // [^\n] dans le régime TÊTE : un Maj+Entrée fait retomber en texte libre.
    const v = monter();
    assert.equal(v.taper('/plan on\nsuite'), null);
});

t('le contexte suit le CURSEUR, pas la fin du texte', () => {
    const v = monter();
    const c = v.taper('/pl', 2);         // curseur entre « / » et « l »
    assert.equal(c.name, 'p');
});

t('sans zone de saisie montée, aucun contexte', () => {
    const v = monter();
    v.refs.inputRef.value = null;
    assert.equal(v.taper('/'), null);
});

// ── _pack : préfixes d'abord, sous-chaînes ensuite ───────────

t('TRI : les correspondances par PRÉFIXE passent avant les sous-chaînes', () => {
    const v = monter();
    v.taper('/p');
    const noms = v.rangees();
    const prefixes = noms.filter((n) => n.startsWith('p'));
    const dedans = noms.filter((n) => !n.startsWith('p'));
    assert.ok(prefixes.length > 0, 'aucun préfixe trouvé : ' + noms.join(', '));
    const dernierPrefixe = noms.lastIndexOf(prefixes[prefixes.length - 1]);
    for (const d of dedans) {
        assert.ok(noms.indexOf(d) > dernierPrefixe,
            '« ' + d + ' » (sous-chaîne) passe avant un préfixe — ordre : ' + noms.join(', '));
    }
});

t('TRI : chaque paquet est trié alphabétiquement', () => {
    const v = monter();
    v.taper('/');
    const noms = v.rangees();
    const trie = noms.slice().sort((a, b) => a.localeCompare(b));
    assert.deepStrictEqual(noms, trie, 'sans requête, tout est préfixe : la liste doit être triée');
});

t('sans requête, toutes les commandes sont proposées', () => {
    const v = monter();
    v.taper('/');
    assert.ok(v.rangees().length >= 3, 'reçu : ' + v.rangees().join(', '));
});

t('la recherche est insensible à la casse', () => {
    const v = monter();
    v.taper('/PL');
    assert.ok(v.rangees().includes('plan'), 'reçu : ' + v.rangees().join(', '));
});

// ── slashLevel : la cascade ──────────────────────────────────

t('sans contexte, le niveau est « commands »', () => {
    const v = monter();
    assert.equal(v.api.slashLevel.value, 'commands');
});

t('une requête qui matche une commande reste en « commands »', () => {
    const v = monter();
    v.taper('/pl');
    assert.equal(v.api.slashLevel.value, 'commands');
});

t('une commande + espace bascule en « values » — mais SEULEMENT si elle a des arguments', () => {
    const v = monter();
    // `settings` déclare un argument « onglet » avec une liste de valeurs.
    v.taper('/settings ');
    assert.equal(v.api.slashLevel.value, 'values');
    assert.ok(depuisBac(v.api.slashList.value).length > 0, 'la liste de valeurs doit être peuplée');
});

t('une commande SANS argument reste en « commands » même suivie d\'un espace', () => {
    // `plan` bascule immédiatement à la sélection : pas de sous-menu on/off.
    const v = monter();
    v.taper('/plan ');
    assert.equal(v.api.slashLevel.value, 'commands');
});

t('les valeurs d\'argument sont filtrées par ce qui est tapé', () => {
    const v = monter();
    v.taper('/settings ');
    const toutes = depuisBac(v.api.slashList.value).map((x) => x.value);
    assert.ok(toutes.length > 1, 'reçu : ' + toutes.join(', '));
    const cible = toutes[0];
    v.taper('/settings ' + cible.slice(0, 2));
    const filtrees = depuisBac(v.api.slashList.value).map((x) => x.value);
    assert.ok(filtrees.includes(cible), 'reçu : ' + filtrees.join(', '));
    assert.ok(filtrees.length <= toutes.length);
});

await ta('une requête qui ne matche AUCUNE commande bascule sur les skills', async () => {
    // Rétrocompatibilité « muscle memory » du menu /skill historique.
    const v = monter();
    v.taper('/crea');
    assert.equal(v.api.slashLevel.value, 'skills');
    await souffler();
    assert.ok(v.rangees().includes('creatif'), 'reçu : ' + v.rangees().join(', '));
});

await ta('les skills proposés sont triés par domaine puis par nom', async () => {
    const v = monter();
    v.taper('/zzzz');              // aucune commande ne matche → skills
    await souffler();
    v.taper('/e');                 // « e » : présent dans les trois skills
    await souffler();
    const liste = depuisBac(v.api.slashList.value);
    if (v.api.slashLevel.value === 'skills' && liste.length > 1) {
        const cle = (x) => (x.domain || '') + ' | ' + (x.name || '');
        for (let i = 1; i < liste.length; i++) {
            assert.ok(cle(liste[i - 1]) <= cle(liste[i]),
                'tri rompu entre ' + liste[i - 1].name + ' et ' + liste[i].name);
        }
    }
});

// ── showSlash : les conditions d'affichage ───────────────────

t('le menu ne s\'affiche pas sans contexte', () => {
    const v = monter();
    assert.equal(v.api.showSlash.value, false);
});

t('le menu s\'affiche dès qu\'il y a des rangées', () => {
    const v = monter();
    v.taper('/');
    assert.equal(v.api.showSlash.value, true);
});

t('ÉCHAP ferme sans détruire l\'état, la frappe suivante RÉARME', () => {
    const v = monter();
    v.taper('/');
    assert.equal(v.api.showSlash.value, true);
    v.api.slashDismiss();
    assert.equal(v.api.showSlash.value, false);
    assert.notEqual(v.api.slashRaw.value, null, 'l\'état ne doit pas être détruit');
    v.taper('/p');
    assert.equal(v.api.showSlash.value, true, 'la frappe suivante doit réarmer');
});

t('@mention est PRIORITAIRE : le menu « / » s\'efface', () => {
    const v = monter({ mention: true });
    v.taper('/');
    assert.equal(v.api.showSlash.value, false, 'les deux listes se superposeraient');
});

t('resetSlash remet tout à zéro', () => {
    const v = monter();
    v.taper('/');
    v.api.resetSlash();
    assert.equal(v.api.slashRaw.value, null);
    assert.equal(v.api.showSlash.value, false);
});

// ── slashResolve : la résolution à l'envoi ───────────────────

t('une commande connue est résolue, avec ses arguments', () => {
    const v = monter();
    const r = depuisBac(v.api.slashResolve('/plan on'));
    assert.equal(r.cmd.name, 'plan');
    assert.equal(r.raw, 'on');
    assert.deepStrictEqual(r.args, ['on']);
});

t('une commande sans argument est résolue avec args vide', () => {
    const v = monter();
    const r = depuisBac(v.api.slashResolve('/plan'));
    assert.equal(r.cmd.name, 'plan');
    assert.deepStrictEqual(r.args, []);
});

t('plusieurs arguments sont découpés', () => {
    const v = monter();
    const r = depuisBac(v.api.slashResolve('/plan  on   force '));
    assert.deepStrictEqual(r.args, ['on', 'force']);
});

t('la casse de la commande est ignorée', () => {
    const v = monter();
    assert.equal(depuisBac(v.api.slashResolve('/PLAN on')).cmd.name, 'plan');
});

t('une commande INCONNUE n\'est pas résolue : elle part au modèle', () => {
    const v = monter();
    assert.equal(v.api.slashResolve('/nexistepas'), null);
    assert.equal(v.api.slashResolve('/nexistepas avec args'), null);
});

t('PIÈGE : « /srv/projet » n\'est pas résolu comme une commande', () => {
    const v = monter();
    assert.equal(v.api.slashResolve('/srv/projet'), null);
});

t('du texte ordinaire n\'est jamais résolu', () => {
    const v = monter();
    for (const txt of ['bonjour', '', null, undefined, 'un / au milieu', '  ']) {
        assert.equal(v.api.slashResolve(txt), null, 'texte : ' + JSON.stringify(txt));
    }
});

t('une commande précédée de texte n\'est pas résolue', () => {
    const v = monter();
    assert.equal(v.api.slashResolve('explique /plan on'), null);
});

t('les espaces autour sont tolérés', () => {
    const v = monter();
    assert.equal(depuisBac(v.api.slashResolve('  /plan on  ')).cmd.name, 'plan');
});

// ── Les menus ne sont pas des actions ────────────────────────

t('les commandes MENU (/skills, /prompt) ne sont jamais « exécutées »', () => {
    // Sinon taper /skills enverrait un ordre au lieu d'ouvrir une liste.
    const v = monter();
    for (const nom of ['skills', 'prompt']) {
        assert.equal(v.api.slashResolve('/' + nom), null,
            '/' + nom + ' ne doit pas être résolu comme une action');
    }
});

// ── Disponibilité contextuelle ───────────────────────────────

t('slashCmdOk vaut vrai pour une commande sans condition', () => {
    const v = monter();
    assert.equal(v.api.slashCmdOk({ name: 'x' }), true);
});

t('slashCmdOk consulte la condition avec l\'environnement', () => {
    const v = monter({ env: { admin: false } });
    assert.equal(v.api.slashCmdOk({ name: 'x', when: (e) => !!e.admin }), false);
    assert.equal(v.api.slashCmdOk({ name: 'x', when: (e) => !e.admin }), true);
});

t('une condition qui JETTE laisse la commande disponible', () => {
    // Un garde cassé ne doit pas faire disparaître une commande.
    const v = monter();
    assert.equal(v.api.slashCmdOk({ name: 'x', when: () => { throw new Error('boum'); } }), true);
});

t('slashCmdOk sur null vaut vrai (pas de crash de rendu)', () => {
    const v = monter();
    assert.equal(v.api.slashCmdOk(null), true);
});

// ── Affichage des rangées ────────────────────────────────────

t('promptPreview tronque à 90 caractères avec des points de suspension', () => {
    // Il prend le PROMPT, pas son texte : c'est la rangée qu'on lui passe.
    const v = monter();
    const long = v.api.promptPreview({ content: 'a'.repeat(200) });
    assert.equal(long.length, 91);
    assert.ok(long.endsWith('…'));
    assert.equal(v.api.promptPreview({ content: 'court' }), 'court');
});

t('promptPreview aplatit les blancs pour tenir sur une ligne', () => {
    const v = monter();
    assert.equal(v.api.promptPreview({ content: '  a\n\n  b\t c  ' }), 'a b c');
});

t('promptPreview encaisse null, undefined et un prompt sans contenu', () => {
    const v = monter();
    assert.equal(v.api.promptPreview(null), '');
    assert.equal(v.api.promptPreview(undefined), '');
    assert.equal(v.api.promptPreview({}), '');
});

t('slashRowKey produit une clé distincte par rangée', () => {
    const v = monter();
    v.taper('/');
    const liste = depuisBac(v.api.slashList.value);
    const cles = liste.map((item, i) => v.api.slashRowKey(item, i));
    assert.equal(new Set(cles).size, cles.length, 'clés dupliquées : ' + cles.join(', '));
});

t('slashRowTitle d\'une commande indisponible donne la RAISON, pas la description', () => {
    const v = monter();
    v.taper('/');
    const indispo = { name: 'x', desc: 'description', whenLabel: 'réservé aux administrateurs',
        when: () => false };
    assert.equal(v.api.slashRowTitle(indispo), 'réservé aux administrateurs');
});

t('slashRowTitle d\'une commande disponible donne la description', () => {
    const v = monter();
    v.taper('/');
    assert.equal(v.api.slashRowTitle({ name: 'x', desc: 'description' }), 'description');
});

// ── Navigation clavier ───────────────────────────────────────

t('flèche bas puis haut déplacent la sélection sans déborder', () => {
    const v = monter();
    v.taper('/');
    const n = depuisBac(v.api.slashList.value).length;
    const touche = (key) => v.api.slashKeydown({ key, preventDefault() {} });

    assert.equal(v.api.slashIdx.value, 0);
    assert.equal(touche('ArrowDown'), true, 'la touche doit être consommée');
    assert.equal(v.api.slashIdx.value, 1);
    for (let i = 0; i < n + 5; i++) touche('ArrowDown');
    assert.equal(v.api.slashIdx.value, n - 1, 'la sélection ne doit pas déborder en bas');
    for (let i = 0; i < n + 5; i++) touche('ArrowUp');
    assert.equal(v.api.slashIdx.value, 0, 'ni en haut');
});

t('les touches ne sont pas consommées quand le menu est fermé', () => {
    const v = monter();
    assert.equal(v.api.slashKeydown({ key: 'ArrowDown', preventDefault() {} }), false);
});

fin();
