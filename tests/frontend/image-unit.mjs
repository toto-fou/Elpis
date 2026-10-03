// SPDX-License-Identifier: MIT
// ============================================================
//  tests/frontend/image-unit.mjs
//  Lancer : node tests/frontend/image-unit.mjs
//
//  Cible : frontend/js/chat/_image.js — génération d'images du chat
//  (plan docs/generation-images-design-2026-10-02.md, § 6 et § 11).
//
//  Invariants verrouillés :
//   * UNE liste des champs d'image (IMAGE_MSG_KEYS) : la projection de
//     persistance, la réhydratation et l'instantané de session la
//     partagent — un champ oublié à un seul endroit est effacé EN BASE.
//   * Les préférences du compte sont ramenées à ce que le moteur permet
//     (ratio proposé, côté sous le plafond, nombre ≤ max_n).
//   * « Variantes » renvoie la même demande SANS graine.
//   * /image : ratio et nombre en tête, description intacte ensuite.
//   * Le nom de fichier est le même partout : <description>-<graine>.<ext>.
//   * Les options avancées ne partent que si le moteur les comprend.
//   * Aucun pourcentage inventé : seul un avancement publié s'affiche en %.
// ============================================================

import { t, ta, fin, assert } from './lib/harnais.js';
import { charger, depuisBac } from './lib/charger.js';
import { vueMini, ctxMuet, reponseJson } from './lib/stubs.js';

const C = charger(['chat/_image.js']);
const g = (n) => C.g(n);

// ── Champs d'un message ─────────────────────────────────────

t('copyImageFields recopie les seuls champs d\'image non vides', () => {
    const src = {
        role: 'assistant', content: 'x', image_request: { size: '1024x1024', n: 1 },
        generated_images: [{ id: 'a1' }], tool_images: [], revised_prompt: '',
        image_meta: { model: 'm' }, image_error: null, autre: 1,
    };
    assert.deepStrictEqual(depuisBac(g('copyImageFields')(src, {})), {
        image_request: { size: '1024x1024', n: 1 },
        generated_images: [{ id: 'a1' }],
        image_meta: { model: 'm' },
    });
});

t('IMAGE_MSG_KEYS couvre les six champs du contrat', () => {
    assert.deepStrictEqual(depuisBac(Array.from(g('IMAGE_MSG_KEYS'))).sort(), [
        'generated_images', 'image_error', 'image_meta', 'image_request', 'revised_prompt', 'tool_images',
    ]);
});

t('aller-retour persistance → réhydratation : rien ne se perd', () => {
    const copie = g('copyImageFields');
    const live = { role: 'assistant', content: '[Image générée : « x »]',
                   generated_images: [{ id: 'a1', url: '/api/images/a1', width: 1024, height: 576, seed: 4 }],
                   revised_prompt: 'A lighthouse', image_meta: { model: 'Qwen', duration_s: 12 },
                   image_error: { code: 'timeout', message: '', retryable: true } };
    const persiste = copie(live, { role: 'assistant', content: live.content });
    const relu = copie(JSON.parse(JSON.stringify(persiste)), { role: 'assistant' });
    for (const k of ['generated_images', 'revised_prompt', 'image_meta', 'image_error']) {
        assert.deepStrictEqual(depuisBac(relu[k]), depuisBac(live[k]), k);
    }
});

t('isImageMessage : tour image, résultat ou échec — pas une réponse avec images d\'outil', () => {
    const f = g('isImageMessage');
    assert.equal(f({ role: 'assistant', _imageTurn: true }), true);
    assert.equal(f({ role: 'assistant', generated_images: [{ id: 'a' }] }), true);
    assert.equal(f({ role: 'assistant', image_error: { code: 'timeout' } }), true);
    assert.equal(f({ role: 'assistant', content: 'texte', tool_images: [{ id: 'b' }] }), false);
    assert.equal(f({ role: 'assistant', content: 'texte' }), false);
});

// ── Formats et préférences ──────────────────────────────────

t('imageSizeFor : côté long au pas de 64, orientation respectée', () => {
    const f = (r, s) => depuisBac(g('imageSizeFor')(r, s, 64));
    assert.deepStrictEqual(f('16:9', 1024), { w: 1024, h: 576 });
    assert.deepStrictEqual(f('9:16', 1024), { w: 576, h: 1024 });
    assert.deepStrictEqual(f('1:1', 768), { w: 768, h: 768 });
    assert.deepStrictEqual(f('21:9', 1024), { w: 1024, h: 448 });
    assert.deepStrictEqual(f('n\'importe', 512), { w: 512, h: 512 });
});

t('imageCellStyle : même boîte pour la tuile et l\'image, plus petite en lot', () => {
    const f = g('imageCellStyle');
    assert.deepStrictEqual(depuisBac(f(1024, 576, 1)), { width: '360px', aspectRatio: '1024 / 576' });
    assert.deepStrictEqual(depuisBac(f(576, 1024, 1)), { width: '203px', aspectRatio: '576 / 1024' });
    assert.equal(f(1024, 1024, 3).width, '208px');
});

const STATUT = {
    ready: true, available: true, ratios: ['1:1', '4:3', '3:4', '3:2', '2:3', '16:9', '9:16'],
    sides: [512, 768, 1024, 1536, 2048], default_side: 1024, max_side: 1536, step: 64, max_n: 3,
    size_policy: 'free', sizes: [], features: { seed: true, negative: true, steps: true, strength: true },
    prefs: { ratio: '16:9', side: 1024, n: 2, enhance: true }, enhance_enabled: true,
};

t('normalizeImagePrefs ramène les préférences aux limites du moteur', () => {
    const f = (p, st) => depuisBac(g('normalizeImagePrefs')(p, st || STATUT));
    assert.deepStrictEqual(f({ ratio: '16:9', side: 1024, n: 2, enhance: true }),
                           { ratio: '16:9', side: 1024, n: 2, enhance: true });
    // Ratio retiré, côté au-dessus du plafond, nombre au-dessus de max_n.
    assert.deepStrictEqual(f({ ratio: '21:9', side: 2048, n: 9 }),
                           { ratio: '1:1', side: 1536, n: 3, enhance: false });
    // Côté inconnu : le plus proche en dessous.
    assert.equal(f({ side: 900 }).side, 768);
    // Enrichir coupé par l'administrateur : la préférence ne s'applique pas.
    assert.equal(f({ enhance: true }, Object.assign({}, STATUT, { enhance_enabled: false })).enhance, false);
    // Préférences absentes ou illisibles : défauts du moteur.
    assert.deepStrictEqual(f(null), { ratio: '1:1', side: 1024, n: 1, enhance: false });
});

t('imagePickFixed : taille fixe la plus proche du ratio puis du côté', () => {
    const f = g('imagePickFixed');
    const tailles = ['1024x1024', '1536x1024', '1024x1536'];
    assert.equal(f(tailles, '16:9', 1024), '1536x1024');
    assert.equal(f(tailles, '9:16', 1024), '1024x1536');
    assert.equal(f(tailles, '1:1', 512), '1024x1024');
    assert.equal(f([], '1:1', 512), '');
});

// ── /image, variantes, nom de fichier, libellés ─────────────

t('parseImageCommand : ratio et nombre en tête, dans les deux ordres', () => {
    const f = (raw, st) => depuisBac(g('parseImageCommand')(raw, st || STATUT));
    assert.deepStrictEqual(f('16:9 x2 un phare  sous l\'orage'),
                           { prompt: 'un phare  sous l\'orage', ratio: '16:9', n: 2, error: '' });
    assert.deepStrictEqual(f('x3 4:3 chat'), { prompt: 'chat', ratio: '4:3', n: 3, error: '' });
    assert.deepStrictEqual(f('portrait un arbre'), { prompt: 'un arbre', ratio: '2:3', n: null, error: '' });
    // Le nombre est borné par max_n ; un « 16:9 » au milieu reste du texte.
    assert.equal(f('×9 une ville en 16:9').n, 3);
    assert.equal(f('×9 une ville en 16:9').prompt, 'une ville en 16:9');
    assert.deepStrictEqual(f(''), { prompt: '', ratio: null, n: null, error: '' });
    assert.match(f('5:4 un pont').error, /Format non proposé/);
});

t('imageVariantRequest : même demande, SANS graine', () => {
    const req = { size: '1024x576', n: 2, seed: 42, steps: 8, ref_image_id: 'ab12', enhance: true };
    const v = depuisBac(g('imageVariantRequest')(req));
    assert.deepStrictEqual(v, { size: '1024x576', n: 2, steps: 8, ref_image_id: 'ab12', enhance: true });
    assert.equal(req.seed, 42, 'la demande d\'origine n\'est pas modifiée');
});

t('imageFileName : <description>-<graine>.<ext>, id court à défaut', () => {
    const f = g('imageFileName');
    assert.equal(f({ id: 'abcdef1234', seed: 4812, mime: 'image/png' }, 'Un phare, sous l\'orage !'),
                 'Un-phare-sous-l-orage-4812.png');
    assert.equal(f({ id: 'abcdef1234', mime: 'image/jpeg' }, ''), 'image-abcdef12.jpg');
    assert.equal(f({ id: 'x1', seed: 0, mime: 'image/webp' }, 'é'), 'é-0.webp');
    assert.equal(f({ id: 'x1', seed: 1 }, 'a'.repeat(80)).length, 40 + '-1.png'.length);
});

t('imageSizeLabel et imageRequestLabel', () => {
    assert.equal(g('imageSizeLabel')('1024x576'), '16:9 · 1024×576');
    assert.equal(g('imageSizeLabel')('1024x1024'), 'Carré · 1024×1024');
    assert.equal(g('imageSizeLabel')('1000x300'), '1000×300');
    assert.equal(g('imageRequestLabel')({ size: '576x1024', n: 2, seed: 7, enhance: true, ref_image_id: 'a1' }),
                 '9:16 · 576×1024 · ×2 · graine 7 · modification · enrichie');
});

t('imageProgressText : file, durée estimée « ≈ », % seulement s\'il est publié', () => {
    const f = g('imageProgressText');
    assert.equal(f({ state: 'queued', queue_position: 2 }), 'En file · 2e');
    assert.equal(f({ state: 'queued', queue_position: 1 }), 'En file · 1re');
    assert.equal(f({ state: 'queued' }), 'En file');
    assert.equal(f({ state: 'waiting' }), 'En attente d’un créneau');
    assert.equal(f({ state: 'generating', eta_s: 30 }, 12), 'Génération · 12 s / ≈30 s');
    assert.equal(f({ state: 'generating' }, 75), 'Génération · 1 min 15 s');
    // Pourcentage estimé (pct_real faux) : JAMAIS affiché.
    assert.equal(f({ state: 'generating', pct: 40, pct_real: false }, 5), 'Génération · 5 s');
    assert.equal(f({ state: 'generating', pct: 40.4, pct_real: true }, 5), 'Génération · 40 %');
});

t('imageErrorText : message du serveur, sinon libellé du code', () => {
    const f = g('imageErrorText');
    assert.equal(f({ code: 'timeout', message: '' }), 'Délai dépassé');
    assert.equal(f({ code: 'engine', message: 'Moteur saturé' }), 'Moteur saturé');
    assert.equal(f({ code: 'inconnu' }), 'Erreur du moteur d’images');
    assert.equal(f('texte libre'), 'texte libre');
});

// ── Usine : demande envoyée et mode ─────────────────────────

function monter(statut, reglages) {
    const vue = vueMini();
    const settings = vue.ref(Object.assign({ image_ready: true, image_enabled: true }, reglages || {}));
    const attachedFiles = vue.ref([]);
    const isStreaming = vue.ref(false);
    const toasts = [];
    const appels = [];
    const ctx = ctxMuet({
        fetchAuth: async (url, opts) => { appels.push([url, opts && opts.body]); return reponseJson(statut || STATUT); },
        showToast: (m, k) => toasts.push([m, k]),
        focusInput: () => {},
    });
    const api = C.fabrique('setupChatImage', [vue, { settings, isStreaming, attachedFiles }, ctx]);
    return { api, settings, toasts, appels, attachedFiles };
}

await ta('le mode applique les préférences du compte et borne la demande', async () => {
    const { api } = monter();
    assert.equal(await api.toggleImageMode(true), true);
    assert.equal(api.imageMode.value, true);
    const req = depuisBac(api.buildImageRequest(false));
    assert.deepStrictEqual(req, { n: 2, size: '1024x576', ratio: '16:9', side: 1024, enhance: true });
});

await ta('options avancées envoyées SEULEMENT si le moteur les comprend', async () => {
    const { api } = monter();
    await api.toggleImageMode(true);
    Object.assign(api.imageOpts, { seed: '42', steps: '8', negative_prompt: ' flou ', strength: 0.6 });
    const avec = depuisBac(api.buildImageRequest(true));
    assert.equal(avec.seed, 42);
    assert.equal(avec.steps, 8);
    assert.equal(avec.negative_prompt, 'flou');
    assert.equal(avec.strength, 0.6);
    // Sans image source, pas de force.
    assert.equal(depuisBac(api.buildImageRequest(false)).strength, undefined);

    const o = monter(Object.assign({}, STATUT, { features: {} }));
    await o.api.toggleImageMode(true);
    Object.assign(o.api.imageOpts, { seed: '42', steps: '8', negative_prompt: 'flou' });
    const sans = depuisBac(o.api.buildImageRequest(true));
    assert.equal(sans.seed, undefined);
    assert.equal(sans.steps, undefined);
    assert.equal(sans.negative_prompt, undefined);
    assert.equal(sans.strength, undefined);
});

await ta('/image : ratio et nombre propres à la demande, préférences intactes', async () => {
    const { api } = monter();
    await api.loadImageStatus(true);
    const req = depuisBac(api.buildImageRequest(false, { ratio: '3:4', n: 3 }));
    assert.equal(req.size, '768x1024');
    assert.equal(req.n, 3);
    assert.equal(api.imageOpts.ratio, '16:9');
    assert.equal(api.imageOpts.n, 2);
});

await ta('politique « fixed » : la taille fixe la plus proche part, sans ratio', async () => {
    const st = Object.assign({}, STATUT, { size_policy: 'fixed', sizes: ['1024x1024', '1536x1024', '1024x1536'] });
    const { api } = monter(st);
    await api.toggleImageMode(true);
    const req = depuisBac(api.buildImageRequest(false));
    assert.equal(req.size, '1536x1024');
    assert.equal(req.ratio, undefined);
    api.setImageFixed('1024x1536');
    assert.equal(depuisBac(api.buildImageRequest(false)).size, '1024x1536');
    assert.equal(api.imageOpts.ratio, '2:3');
});

await ta('changer le format écrit la préférence du compte (PUT ciblé)', async () => {
    const { api, appels, settings } = monter();
    await api.toggleImageMode(true);
    api.setImageRatio('4:3');
    assert.deepStrictEqual(depuisBac(settings.value.image_prefs), { ratio: '4:3', side: 1024, n: 2, enhance: true });
    await new Promise((r) => setTimeout(r, 700));
    const put = appels.find(([u, b]) => u === '/api/settings' && b);
    assert.ok(put, 'PUT /api/settings envoyé');
    assert.deepStrictEqual(JSON.parse(put[1]), { image_prefs: { ratio: '4:3', side: 1024, n: 2, enhance: true } });
    // L'orientation se garde d'un format à l'autre.
    api.flipImageRatio();
    assert.equal(api.imageOpts.ratio, '3:4');
    api.setImageRatio('16:9');
    assert.equal(api.imageOpts.ratio, '9:16');
});

await ta('mode refusé : toast et pas d\'activation', async () => {
    const { api, toasts } = monter({ ready: false, available: false });
    assert.equal(await api.toggleImageMode(true), false);
    assert.equal(api.imageMode.value, false);
    assert.match(toasts[0][0], /Aucun moteur/);
});

t('entrée « Images » : suit la case des Paramètres en direct', () => {
    const { api, settings } = monter();
    assert.equal(api.imageAvailable.value, true);
    settings.value.image_enabled = false;
    assert.equal(api.imageAvailable.value, false);
    settings.value = { image_ready: false, image_enabled: true };
    assert.equal(api.imageAvailable.value, false);
});

await ta('Échap : popover d\'abord, puis sortie du mode sur une saisie vide', async () => {
    const { api } = monter();
    await api.toggleImageMode(true);
    api.toggleImagePop('more');
    assert.equal(api.imageEscape(true, true), true);
    assert.equal(api.imagePop.value, '');
    assert.equal(api.imageMode.value, true);
    assert.equal(api.imageEscape(false, true), false, 'texte en cours : on garde le mode');
    assert.equal(api.imageEscape(true, false), false, 'focus ailleurs : on garde le mode');
    assert.equal(api.imageEscape(true, true), true);
    assert.equal(api.imageMode.value, false);
});

await ta('Modifier une image : mode Images et image désignée, pièce jointe retirée', async () => {
    const { api, attachedFiles } = monter();
    attachedFiles.value = [{ name: 'a.png', isImage: true }];
    await api.editGeneratedImage({ id: 'ab12', url: '/api/images/ab12', thumb_url: '/api/images/ab12?thumb=1' });
    assert.equal(api.imageMode.value, true);
    assert.equal(api.imageEditRef.value.id, 'ab12');
    assert.equal(attachedFiles.value.length, 0);
    assert.equal(depuisBac(api.buildImageRequest(false)).ref_image_id, 'ab12');
});

fin();
