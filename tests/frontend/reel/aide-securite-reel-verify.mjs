// SPDX-License-Identifier: MIT
/** tests/frontend/reel/aide-securite-reel-verify.mjs — fenêtre d'aide attaquée contre le core TS réel : un guide piégé (scripts, gestionnaires, adresses javascript: et distantes, clips et ancres forgés) est servi par l'instance jetable, tout est cliqué ; puis la route des clips reçoit des noms forgés. */
// Recette : ELPIS_NODE_MODULES=…/browser-service/node_modules node tests/frontend/reel/aide-securite-reel-verify.mjs
import fs from 'node:fs';
import path from 'node:path';
import { DEPOT, attendreMontage, contexteConnecte, demarrerCoreReel, lancerNavigateur, verifications } from '../lib/core-reel.mjs';

const arbre = DEPOT;
const v = verifications('aide-securite-reel');
const ok = (nom, cond, detail = '') => v.ok(nom, cond, String(typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 300));

const X = (nom) => `window.__xss=(window.__xss||[]).concat('${nom}')`;
const GUIDE = [
    '# Guide',
    '',
    '## Attaques',
    '<!-- aide: chat -->',
    '',
    `<script>${X('script')}</script>`,
    '',
    `<img src=x onerror="${X('img-onerror')}">`,
    '',
    `<svg onload="${X('svg-onload')}"><script>${X('svg-script')}</script><a xlink:href="javascript:${X('svg-lien')}"><text y="20">svg</text></a></svg>`,
    '',
    `<iframe src="javascript:parent.${X('iframe')}"></iframe>`,
    '',
    `<a href="javascript:${X('lien-js')}" data-essai="lien-js">lien js brut</a>`,
    '',
    `[lien js markdown](javascript:${X('md-js')})`,
    '',
    `[lien data](data:text/html,<script>parent.${X('data')}</script>)`,
    '',
    `<details open ontoggle="${X('ontoggle')}"><summary>détails</summary>texte</details>`,
    '',
    `<video src="https://exemple.invalid/v.webm" onerror="${X('video-onerror')}" autoplay></video>`,
    '',
    '<img src="https://exemple.invalid/pixel.png" alt="pixel distant">',
    '',
    '<style>body{background:url(https://exemple.invalid/fond.png)}</style>',
    '',
    '<form action="https://exemple.invalid/"><input name="a"><button>envoyer</button></form>',
    '',
    `<math><mtext><table><mglyph><style><!--</style><img title="--&gt;&lt;img src=1 onerror=${X('mxss')}&gt;">`,
    '',
    `<a href="#" onclick="${X('onclick')}" data-essai="onclick">clic piégé</a>`,
    '',
    `<p style="position:fixed;inset:0;background:url(https://exemple.invalid/style.png)" data-essai="style">style piégé</p>`,
    '',
    '## Clips',
    '<!-- aide: clips -->',
    '',
    `[Clip aux guillemets](../media/aide/x.webm" onerror="${X('clip-attribut')})`,
    '',
    '[Clip qui remonte](../media/aide/..%2F..%2Ffr%2Fuser-guide.webm)',
    '',
    '[Clip distant](https://exemple.invalid/media/aide/chat-envoyer.webm)',
    '',
    '[Clip valide](../media/aide/chat-envoyer.webm)',
    '',
    `[<img src=x onerror="${X('legende')}">Légende piégée](../media/aide/chat-envoyer.webm)`,
    '',
    `[Ancre piégée](#"><img src=x onerror=${X('ancre')}>)`,
    '',
    '[Lien relatif](../../etc/passwd)',
    '',
    `### Sous-titre <img src=x onerror="${X('sous-titre')}">`,
    '',
    'Fin de la première section.',
    '',
    `## <img src=x onerror="${X('titre-section')}"> Section <b onmouseover="${X('titre-gras')}">deux</b>`,
    `<!-- aide: "><script>${X('cle')}</script> -->`,
    '',
    'Texte de la seconde section.',
    '',
].join('\n');

const core = await demarrerCoreReel({ tokParS: 80 });
const nav = await lancerNavigateur();
try {
    // Le dossier docs de l'instance jetable (un lien vers l'arbre) est remplacé par un guide piégé et un seul vrai clip.
    const docs = path.join(core.dossier, 'racine', 'docs');
    fs.rmSync(docs, { force: true });
    fs.mkdirSync(path.join(docs, 'fr'), { recursive: true });
    fs.mkdirSync(path.join(docs, 'media', 'aide'), { recursive: true });
    fs.writeFileSync(path.join(docs, 'fr', 'user-guide.md'), GUIDE);
    fs.copyFileSync(path.join(arbre, 'docs/media/aide/chat-envoyer.webm'), path.join(docs, 'media', 'aide', 'chat-envoyer.webm'));
    fs.writeFileSync(path.join(docs, 'media', 'secret.webm'), 'secret hors du dossier des clips');

    const ctx = await contexteConnecte(nav, core.urlMain, core.comptes.user, { viewport: { width: 1280, height: 800 }, reducedMotion: 'no-preference' });
    await ctx.addInitScript(() => { window.__csp = []; document.addEventListener('securitypolicyviolation', (e) => window.__csp.push(`${e.violatedDirective} ${e.blockedURI}`)); });
    const page = await ctx.newPage();
    const dialogues = [];
    page.on('dialog', (d) => { dialogues.push(d.message()); d.dismiss().catch(() => {}); });
    const dehors = [];
    page.on('request', (r) => { if (!r.url().startsWith(core.urlMain) && !/^(data|blob|about):/.test(r.url())) dehors.push(r.url()); });
    const erreurs = [];
    page.on('pageerror', (e) => erreurs.push(String(e.message)));
    await page.goto(core.urlMain + '/');
    await attendreMontage(page);
    await page.locator('text=alice').first().click();
    await page.locator('[role=menuitem]:has-text("Aide")').click();
    await page.waitForSelector('[role=dialog][aria-label="Aide"] .markdown-body h2', { timeout: 15000 });
    await page.waitForTimeout(800);
    const corps = '[role=dialog][aria-label="Aide"] .markdown-body';
    const releve = () => page.evaluate((sel) => {
        const c = document.querySelector(sel);
        const fenetre = document.querySelector('[role=dialog][aria-label="Aide"]');
        const attributs = [...fenetre.querySelectorAll('*')].flatMap((el) => [...el.attributes].filter((a) => /^on/i.test(a.name)).map((a) => `${el.tagName}.${a.name}`));
        const adresse = (el) => el.getAttribute('href') ?? el.getAttribute('src') ?? el.getAttribute('action') ?? el.getAttribute('xlink:href') ?? '';
        const tous = [...fenetre.querySelectorAll('[href],[src],[action],[xlink\\:href]')];
        // Un lien externe explicite (nouvel onglet, sans accès à la page d'origine) est admis ; rien d'autre ne peut pointer hors de l'application.
        const externeAdmis = (el) => el.tagName === 'A' && el.getAttribute('target') === '_blank' && /noopener/.test(el.getAttribute('rel') || '') && /^https?:/i.test(adresse(el));
        const liens = tous.filter((el) => /^\s*(javascript|data|vbscript):/i.test(adresse(el)) || (/exemple\.invalid/.test(adresse(el)) && !externeAdmis(el))).map((el) => `${el.tagName} ${adresse(el)}`);
        const externes = tous.filter(externeAdmis).map(adresse);
        return {
            xss: window.__xss || [],
            interdits: ['script', 'iframe', 'style', 'form', 'object', 'embed', 'base', 'meta', 'link'].filter((t) => c.querySelector(t)),
            attributs,
            liens,
            fixes: [...c.querySelectorAll('*')].filter((el) => getComputedStyle(el).position === 'fixed').length,
            videos: [...fenetre.querySelectorAll('video')].map((v) => v.getAttribute('src') || v.dataset.src || ''),
            entrees: [...document.querySelectorAll('[data-aide-entree]')].map((e) => e.innerHTML.trim()),
            csp: window.__csp,
            externes,
        };
    }, corps);
    let r = await releve();
    console.log('— rendu du guide piégé');
    ok('aucun script du guide ne s\'est exécuté', r.xss.length === 0, r.xss);
    ok('aucune boîte de dialogue', dialogues.length === 0, dialogues);
    ok('balises dangereuses absentes du rendu (script, iframe, style, form…)', r.interdits.length === 0, r.interdits);
    ok('aucun attribut d\'événement dans la fenêtre', r.attributs.length === 0, r.attributs);
    ok('aucune adresse javascript: ou data:, aucune ressource distante chargée ; les liens externes ouvrent un nouvel onglet sans accès à la page', r.liens.length === 0, r.liens);
    const externesAdmis = r.externes;
    ok('aucun élément en position fixe venu du guide', r.fixes === 0, r.fixes);
    ok('titres du sommaire affichés comme du texte', r.entrees.every((e) => !/<(img|b|script)/i.test(e)), r.entrees);
    ok('la vidéo distante du guide a perdu son adresse et son gestionnaire', r.videos.every((v) => v === '' || v.startsWith('/api/help/media/')), r.videos);
    await page.locator('[data-aide-entree]:has-text("Clips")').first().click();
    await page.waitForTimeout(700);
    r = await releve();
    const lecteurs = await page.evaluate(() => [...document.querySelectorAll('[role=dialog][aria-label="Aide"] figure.aide-clip')].map((f) => ({ src: f.querySelector('video').dataset.src || f.querySelector('video').getAttribute('src'), legende: f.querySelector('figcaption').innerHTML })));
    ok('seul un lien vers le dossier des clips devient un lecteur, à l\'adresse du serveur (ni guillemets, ni remontée, ni adresse distante)', lecteurs.length >= 1 && lecteurs.every((l) => /^\/api\/help\/media\/[a-z0-9-]{1,64}\.webm$/.test(l.src)), JSON.stringify(lecteurs));
    ok('la légende d\'un clip est posée comme du texte', lecteurs.every((l) => !/<(img|script|b)\b/i.test(l.legende)), JSON.stringify(lecteurs.map((l) => l.legende)));
    ok('section des clips : aucun script exécuté, aucun attribut d\'événement, aucune adresse dangereuse', r.xss.length === 0 && r.attributs.length === 0 && r.liens.length === 0, JSON.stringify([r.xss, r.attributs, r.liens]));
    console.log('— clics sur tout ce qui se clique');
    const url = page.url();
    const nbSections = await page.locator('[data-aide-entree]').count();
    for (let i = 0; i < nbSections; i++) {
        await page.locator('[data-aide-entree]').nth(i).click().catch(() => {});
        await page.waitForTimeout(400);
        const nbLiens = await page.locator(`${corps} a`).count();
        for (let k = 0; k < nbLiens; k++) {
            // Un lien suivi peut changer de section : revenir à celle qu'on parcourt avant le suivant.
            await page.locator('[data-aide-entree]').nth(i).click().catch(() => {});
            await page.waitForTimeout(150);
            await page.locator(`${corps} a`).nth(k).click({ timeout: 2000, force: true }).catch(() => {});
            await page.waitForTimeout(150);
        }
        for (const sel of ['[data-essai="onclick"]', '[data-essai="style"]', 'figure.aide-clip button', 'summary']) {
            for (const el of await page.locator(`[role=dialog][aria-label="Aide"] ${sel}`).all()) await el.click({ timeout: 2000, force: true }).catch(() => {});
        }
    }
    await page.waitForTimeout(500);
    const onglets = (await ctx.pages()).filter((p) => p !== page).map((p) => p.url());
    ok('la page d\'aide n\'a pas bougé ; seuls les liens externes explicites ont ouvert un onglet', page.url() === url && onglets.every((u) => externesAdmis.some((e) => u.startsWith(e) || u === 'about:blank' || u.startsWith('chrome-error:'))), `${page.url()} · ${onglets.join(' , ')}`);
    for (const p of (await ctx.pages()).filter((q) => q !== page)) await p.close().catch(() => {});
    for (const e of await page.locator('[data-aide-entree]').all()) { await e.click().catch(() => {}); await page.waitForTimeout(250); }
    const champ = page.locator('[data-aide-recherche]');
    await champ.fill(`<img src=x onerror="${X('recherche')}">`);
    await page.waitForTimeout(300);
    await champ.fill('');
    r = await releve();
    ok('après les clics, la recherche piégée et le tour des sections : toujours aucun script exécuté', r.xss.length === 0 && dialogues.length === 0, [...r.xss, ...dialogues]);
    ok('aucune requête hors de l\'application', dehors.length === 0, dehors);
    // Témoin : analyser un attribut d'événement dans un document inerte, comme le fait le purificateur, suffit-il à produire un signalement ?
    const temoin = await page.evaluate(async () => {
        const avant = window.__csp.length;
        new DOMParser().parseFromString('<img src="x" onerror="1">', 'text/html');
        await new Promise((f) => setTimeout(f, 200));
        return window.__csp.length - avant;
    });
    console.log(`    (témoin : analyse inerte d'un attribut d'événement → ${temoin} signalement ; relevés pendant l'attaque : ${r.csp.length}, tous « ${[...new Set(r.csp)].join(' | ')} »)`);
    ok('la politique de sécurité de contenu n\'a signalé que des gestionnaires en ligne refusés, rien d\'autre', r.csp.every((v) => v === 'script-src-attr inline'), [...new Set(r.csp)]);
    ok('aucune erreur JS', erreurs.length === 0, erreurs);
    console.log('— route des clips, avec la session du compte');
    const essais = await page.evaluate(async () => {
        const noms = ['chat-envoyer.webm', '..%2Fsecret.webm', '%2e%2e%2fsecret.webm', '..%252Fsecret.webm', '....//secret.webm', 'chat-envoyer.webm%00.md', 'chat-envoyer.webm%2F', 'CHAT-ENVOYER.webm', 'chat-envoyer.webm%0d%0aX-Injecte:1', '%2e%2e%2f%2e%2e%2ffr%2fuser-guide.md', 'chat-envoyer.WEBM', 'ｃhat-envoyer.webm', 'a'.repeat(300) + '.webm', 'chat-envoyer.webm/../../fr/user-guide.md'];
        const sortie = [];
        for (const n of noms) {
            const rep = await fetch('/api/help/media/' + n).catch((e) => ({ status: 'erreur ' + e.message, headers: new Headers() }));
            sortie.push({ n: n.slice(0, 60), statut: rep.status, type: rep.headers.get('content-type'), nosniff: rep.headers.get('x-content-type-options'), cache: rep.headers.get('cache-control'), injecte: rep.headers.get('x-injecte') });
        }
        const reference = await (await fetch('/api/help/media/chat-envoyer.webm')).arrayBuffer();
        for (const e of sortie.slice(1)) {
            if (e.statut !== 200) continue;
            const corps = await (await fetch('/api/help/media/' + noms.find((n) => n.slice(0, 60) === e.n))).arrayBuffer();
            e.memeClip = corps.byteLength === reference.byteLength;
        }
        const plage = await fetch('/api/help/media/chat-envoyer.webm', { headers: { range: 'bytes=0-9' } });
        sortie.push({ n: 'plage 0-9', statut: plage.status, type: plage.headers.get('content-type'), taille: (await plage.arrayBuffer()).byteLength });
        return sortie;
    });
    const valide = essais[0];
    ok('le clip valide est servi en video/webm, sans mise en cache partagée, type non deviné', valide.statut === 200 && valide.type === 'video/webm' && /private/.test(valide.cache || '') && valide.nosniff === 'nosniff', JSON.stringify(valide));
    const autres = essais.slice(1, -1);
    ok('tout autre nom est refusé (404) ou rend ce même clip (barre finale ignorée par le routeur) ; aucun en-tête injecté', autres.every((e) => (e.statut === 404 || (e.statut === 200 && e.memeClip)) && !e.injecte), JSON.stringify(autres.filter((e) => !(e.statut === 404 || e.memeClip) || e.injecte)));
    console.log(`    (variantes servies comme le clip valide : ${autres.filter((e) => e.statut === 200).map((e) => e.n).join(' , ') || 'aucune'})`);
    ok('une plage d\'octets rend exactement les octets demandés', essais.at(-1).statut === 206 && essais.at(-1).taille === 10, JSON.stringify(essais.at(-1)));
    const anonyme = await fetch(core.urlMain + '/api/help/media/chat-envoyer.webm');
    const anonymeGuide = await fetch(core.urlMain + '/api/help/readme');
    const dev = await page.evaluate(async () => (await (await fetch('/api/help/readme?doc=dev')).json()).content.slice(0, 20));
    ok('sans session : 401 pour le clip et pour le guide', anonyme.status === 401 && anonymeGuide.status === 401, `${anonyme.status} ${anonymeGuide.status}`);
    ok('?doc=dev ne sert plus que le guide utilisateur', dev.startsWith('# Guide'), dev);
    await ctx.close();
} finally { await nav.close(); await core.arreter(); }
process.exit(v.bilan());
