// SPDX-License-Identifier: MIT
// Vérif de la page « Remote code » v5 (route-mock, sans backend ni CLI opencode) :
//   PERF_PORT=8906 node tests/frontend/code-server.mjs &
//   PERF_PORT=8906 node tests/frontend/code-verify.mjs            # motion normal
//   PERF_PORT=8906 REDUCED=1 node tests/frontend/code-verify.mjs  # reduced-motion OS
// Couvre : landing groupée connecté/historique (méta enrichies, renommage),
// ouverture d'une session plein écran + retour, transcript riche (markdown,
// thinking, tool + diffs sur toutes les surfaces : edit, ```diff, bash-diff,
// patch), jauge ctx, notes de commandes, composer parité chat (stop ↔ envoyer,
// largeur chat_width), /model, /session, permissions, questions (v14), écho optimiste, busy,
// déconnexion propre (client.disconnected).
import { launch, gotoApp, BASE_URL } from '../perf/lib/harness.mjs';

const checks = [];
const ok = (name, cond) => { checks.push([cond ? 'PASS' : 'FAIL', name]); if (!cond) console.log('  ✗ ' + name); };
const inject = (ev) => fetch(BASE_URL + '/__inject', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(ev) });

const { browser, page, errors } = await launch(process.env.REDUCED ? { reducedMotion: 'reduce' } : {});
const root = () => page.locator('.elpis-code-page');
const bodyHas = async (re) => re.test(await root().innerText().catch(() => ''));
const htmlHas = async (re) => re.test(await root().innerHTML().catch(() => ''));

try {
    page.setDefaultTimeout(8000);
    await gotoApp(page, '/');

    // ── Landing : liste centrée des sessions, groupée connecté/historique ──
    await page.locator('button[title^="Remote code"]:visible').first().click();
    await page.waitForTimeout(800);
    ok('menu sidebar renommé Remote code', await page.locator('body').innerText().then(t => /Remote code/.test(t)));
    ok('landing : titre Sessions', await bodyHas(/Sessions/));
    ok('landing : groupes Connectées / Historique', await bodyHas(/connectées/i) && await bodyHas(/historique/i));
    ok('landing : session connectée listée', await bodyHas(/Refactor auth/) && await bodyHas(/connecté/));
    ok('landing : historique hors ligne listé', await bodyHas(/Vieille session/) && await bodyHas(/hors ligne/));
    ok('landing : directory + temps relatif', await bodyHas(/\/home\/dev\/webapp/) && await bodyHas(/il y a 3 j/));
    ok('landing : méta enrichies (messages + modèle)', await bodyHas(/2 messages/) && await bodyHas(/qwen3-32b/));
    ok('landing : aperçu du dernier échange', await bodyHas(/vérifié par hash/));
    ok('landing : pas de transcript affiché', !(await htmlHas(/data-code-think/)));

    // ── Renommage inline (plugin v5) ────────────────────────────────────
    await root().locator('div[role="button"]:has-text("Refactor auth")').hover();
    await root().locator('button[title="Renommer la session"]').first().click();
    await page.waitForTimeout(200);
    const renameInput = root().locator('#code-rename-input');
    ok('renommage : input inline ouvert', await renameInput.count() === 1);
    await renameInput.fill('Refonte auth v2');
    await renameInput.press('Enter');
    await page.waitForTimeout(300);
    const sentR = await (await fetch(BASE_URL + '/__sent')).json();
    ok('renommage : POST /rename envoyé', sentR.sent.some(s => s.kind === 'rename' && s.sid === 's1' && s.title === 'Refonte auth v2'));
    ok('renommage : toast de confirmation', /Renommage envoyé/.test(await page.locator('body').innerText()));

    // ── Ouverture d'une session (plein écran) ──────────────────────────
    await root().locator('div[role="button"]:has-text("Refactor auth")').first().click();
    await page.waitForTimeout(500);
    ok('session : header = titre + directory', await bodyHas(/Refactor auth[\s\S]*\/home\/dev\/webapp/));
    ok('session : badge connecté', await bodyHas(/connecté/));
    ok('session : markdown assistant rendu', await htmlHas(/<strong>le correctif<\/strong>/));
    const think = root().locator('details[data-code-think]').first();
    ok('session : thinking présent et replié', await think.count() === 1 && !(await think.getAttribute('open')));
    ok('session : carte diff +3/−2', await bodyHas(/\+3[\s\S]*−2/));
    // avatars = parité chat classique (ronds ; fallbacks ph-user / ph-robot bleu)
    ok('avatars parité chat (rond user + rond assistant)', await root().locator('.rounded-full .ph-user').count() >= 1
        && await root().locator('.rounded-full.bg-blue-600 .ph-robot').count() >= 1);

    // ── Jauge ctx (52k / 200k = 26 %) + tokens par action retirés ───────
    ok('jauge ctx : chip 26% dans le header', await bodyHas(/26% ctx/));
    ok('jauge ctx : tooltip détaillé', await htmlHas(/52k \/ 200k tokens/));
    ok('tokens par étape retirés (plus de « N tk »)', !(await bodyHas(/\b\d+(\.\d+)?k? tk\b/)));

    // ── Diffs « comme opencode » sur toutes les surfaces ────────────────
    ok('bloc ```diff markdown → carte diff (docs/notes.md)', await bodyHas(/docs\/notes\.md/)
        && await bodyHas(/\+1[\s\S]*−1/) && !(await htmlHas(/language-diff/)));
    // pill patch dépliable → cartes issues du diff de l'outil edit
    const patchPill = root().locator('button:has-text("patch · 1 fichier")');
    ok('part patch : pill présente', await patchPill.count() === 1);
    const cardsBefore = await root().locator('.diff-file-block').count();
    await patchPill.click();
    await page.waitForTimeout(200);
    ok('part patch : dépliée en cartes diff', await root().locator('.diff-file-block').count() > cardsBefore);
    await patchPill.click();
    // sortie bash qui EST un diff → cartes dans le panneau Résultat.
    // La ligne d'outil n'est plus un bouton : le repli (paramètres + sortie
    // brute) est un caret secondaire, le contenu utile est déjà à l'écran.
    const gitDiffRow = root().locator('.elpis-code-tool-row').filter({ hasText: 'git diff' }).first();
    await gitDiffRow.locator('button').click();
    await page.waitForTimeout(250);
    ok('sortie bash-diff : cartes dans le panneau Résultat',
        await root().locator('.diff-file-block:visible').count() > cardsBefore);
    await gitDiffRow.locator('button').click();
    await page.waitForTimeout(200);
    // la LIGNE entière reste cliquable (la pastille l'était) — pas seulement le caret
    await gitDiffRow.click({ position: { x: 40, y: 10 } });
    await page.waitForTimeout(250);
    ok('ligne d\'outil : le clic sur la ligne ouvre le détail',
        await root().locator('.diff-file-block:visible').count() > cardsBefore);
    await gitDiffRow.locator('button').click();

    // ── La ligne d'outil dit ce que l'outil a fait (parité TUI) ─────────
    const toolRow = (txt) => root().locator('.elpis-code-tool-row').filter({ hasText: txt }).first();
    ok('outil edit : chemin + compteurs de opencode (filediff)',
        await toolRow('app/api.py').count() === 1
        && /\+7\s*−2/.test(await toolRow('app/api.py').innerText()));
    ok('outil write : carte diff fabriquée (opencode n\'en fournit pas)',
        await root().locator('.diff-file-block').filter({ hasText: 'app/new.py' }).count() === 1);
    ok('outil bash : commande réelle + code de sortie',
        /npm test/.test(await toolRow('npm test').innerText())
        && /exit 1/.test(await toolRow('npm test').innerText())
        && await toolRow('npm test').locator('.elpis-code-metric-err').count() === 1);
    ok('outil grep : motif + nombre de résultats',
        /check_hash/.test(await toolRow('check_hash').innerText())
        && /4 résultats/.test(await toolRow('check_hash').innerText()));
    ok('outil todowrite : la liste elle-même + avancement',
        /1\/3/.test(await toolRow('todowrite').innerText())
        && await bodyHas(/Lire le module/) && await bodyHas(/Corriger le hash/));
    // diffs visibles SANS clic : c'est le résultat du tour, pas un détail
    ok('diffs affichés sans dépliage', await root().locator('.diff-file-block:visible').count() >= 3);

    // ── Parts opencode 1.18 : rendues, ou volontairement masquées ────────
    ok('part subtask : sous-agent nommé + description',
        await bodyHas(/explore/) && await bodyHas(/Cartographier le module auth/));
    ok('part compaction : la compaction est dite', await bodyHas(/Contexte compacté/));
    ok('part retry : tentative signalée', await bodyHas(/Tentative 2/));
    ok('parts internes masquées (snapshot, mention @agent)',
        !(await bodyHas(/\bsnapshot\b/i)));
    ok('erreur de tour visible dans le transcript',
        await bodyHas(/ProviderAuthError/) && await bodyHas(/quota dépassé/));
    ok('message de compaction marqué « Résumé »', await bodyHas(/Résumé/i));

    // ── Trace de commande persistée (note « /review HEAD~1 ») ───────────
    ok('note : pill /review dans le transcript', await bodyHas(/\/review/) && await bodyHas(/HEAD~1/));

    // ── Largeur : transcript + composer suivent chat_width (%) ──────────
    const widthStyles = await root().locator('[style*="max-width"]')
        .evaluateAll(els => els.map(e => e.getAttribute('style') || ''));
    ok('largeur : transcript + composer en % (chat_width)',
        widthStyles.filter(s => /max-width:\s*\d+(\.\d+)?%/.test(s)).length >= 2);

    // ── Retour à la liste ───────────────────────────────────────────────
    await root().locator('button[title="Retour aux sessions"]').click();
    await page.waitForTimeout(300);
    ok('retour : landing réaffichée', await bodyHas(/Vieille session/) && !(await htmlHas(/data-code-think/)));

    // ── /model : commande app dans le dropdown « / » ────────────────────
    await root().locator('div[role="button"]:has-text("Refactor auth")').first().click();
    await page.waitForTimeout(400);
    const input = root().locator('textarea');
    await input.click();
    await input.fill('/');
    await page.waitForTimeout(300);
    ok('dropdown / : commandes app natives listées', await bodyHas(/\/model/) && await bodyHas(/\/undo/)
        && await bodyHas(/\/compact/) && await bodyHas(/\/share/) && await bodyHas(/\/init/) && await bodyHas(/\bapp\b/));
    ok('dropdown / : commandes CLI toujours là', await bodyHas(/review/) && await bodyHas(/⟨args⟩/));
    // action native : /undo tapé à la main → POST /action (relayé par le plugin)
    await input.fill('/undo');
    await input.press('Escape');          // ferme le dropdown, garde le texte
    await input.press('Enter');
    await page.waitForTimeout(300);
    const sentA = await (await fetch(BASE_URL + '/__sent')).json();
    ok('action /undo POSTée (kind action)', sentA.sent.some(s => s.kind === 'action' && s.action === 'undo'));
    ok('toast de confirmation action', /Commande \/undo envoyée/.test(await page.locator('body').innerText()));
    // Sélection au clavier dans le dropdown. On FILTRE au lieu de compter sur la
    // position : le tri est alphabétique et la liste s'enrichit (les modes
    // /build et /plan s'y sont ajoutés, /build passant avant /compact).
    await input.fill('/comp');
    await page.waitForTimeout(250);
    await input.press('Enter');           // 1re entrée filtrée = /compact → action directe
    await page.waitForTimeout(300);
    const sentB = await (await fetch(BASE_URL + '/__sent')).json();
    ok('sélection dropdown /compact → action POSTée', sentB.sent.some(s => s.kind === 'action' && s.action === 'compact'));
    await input.fill('/model');
    await page.waitForTimeout(250);
    await input.press('Enter');           // /model → ouvre le sélecteur
    await page.waitForTimeout(300);
    ok('sélecteur modèle ouvert (groupes provider)', await bodyHas(/Modèle de la session/)
        && await bodyHas(/Elpis \(llama\.cpp\)/) && await bodyHas(/Anthropic/));
    ok('sélecteur : entrée « par défaut » + badge défaut CLI', await bodyHas(/Modèle par défaut de la session/)
        && await bodyHas(/défaut/));
    await input.press('ArrowDown');       // idx 1 = Qwen3 32B
    await input.press('Enter');
    await page.waitForTimeout(300);
    ok('chip modèle affichée (Qwen3 32B)', await bodyHas(/Qwen3 32B/) && !(await bodyHas(/Modèle de la session/)));

    // envoi : le modèle choisi part avec le prompt
    await input.fill('utilise ce modèle');
    await input.press('Enter');
    await page.waitForTimeout(400);
    const sent = await (await fetch(BASE_URL + '/__sent')).json();
    // dernier envoi correspondant (et pas le premier) : /__sent s'accumule si le
    // serveur mock est réutilisé entre deux exécutions de cette vérif
    const lastSent = (list, text) => list.filter(s => s.kind === 'prompt' && s.text === text).at(-1);
    const withModel = lastSent(sent.sent, 'utilise ce modèle');
    ok('prompt POSTé avec model {elpis, qwen3-32b}', !!withModel && withModel.model
        && withModel.model.providerID === 'elpis' && withModel.model.modelID === 'qwen3-32b');
    // ── Modes plan / build (agents opencode, greffon v12) ───────────────
    // Aucun choix explicite ⇒ AUCUN champ agent : le mode courant du TUI
    // (touche tab) ne doit pas être écrasé par la page.
    ok('prompt sans choix de mode : aucun agent imposé', !!withModel && !('agent' in withModel));
    // indicateur permanent = pastille du mode courant (header ET barre de saisie)
    const modeChip = () => root().locator('button[title^="Mode "]').first();
    const modeBadge = () => root().locator('span[title^="Mode "]').first();
    ok('indicateur de mode dans la barre de saisie', await modeChip().isVisible());
    ok('indicateur de mode dans le header', await modeBadge().isVisible());
    ok('mode par défaut = Build', /Build/.test(await modeChip().innerText()));
    // ── bascule par COMMANDE : /plan et /build listées dans le dropdown « / » ──
    await input.fill('/pl');
    await page.waitForTimeout(300);
    ok('dropdown / : /plan proposé', await bodyHas(/\/plan/));
    await input.fill('/plan');
    await input.press('Escape');          // ferme le dropdown, garde le texte
    await input.press('Enter');
    await page.waitForTimeout(350);
    ok('/plan bascule le mode', /Plan/.test(await modeChip().innerText()));
    ok('/plan : indicateur du header suivi', /Plan/.test(await modeBadge().innerText()));
    ok('/plan confirmé par un toast', /Mode Plan/.test(await page.locator('body').innerText()));
    ok('/plan jamais parti comme prompt au modèle',
        !(await (await fetch(BASE_URL + '/__sent')).json()).sent
            .some(s => s.kind === 'prompt' && /^\/plan/.test(s.text || '')));
    await input.fill('plan seulement');
    await input.press('Enter');
    await page.waitForTimeout(400);
    const sentAg = await (await fetch(BASE_URL + '/__sent')).json();
    const withAgent = lastSent(sentAg.sent, 'plan seulement');
    ok('prompt POSTé avec agent=plan', !!withAgent && withAgent.agent === 'plan');
    ok('le modèle choisi reste transmis avec le mode', !!withAgent && withAgent.model
        && withAgent.model.modelID === 'qwen3-32b');
    // retour en Build par la commande, puis par la pastille (raccourci = tab du TUI)
    await input.fill('/build');
    await input.press('Escape');
    await input.press('Enter');
    await page.waitForTimeout(350);
    ok('/build revient en mode Build', /Build/.test(await modeChip().innerText()));
    await modeChip().click();
    await page.waitForTimeout(300);
    ok('clic sur la pastille = mode suivant', /Plan/.test(await modeChip().innerText()));
    await modeChip().click();
    await page.waitForTimeout(300);
    ok('clic à nouveau : cycle complet', /Build/.test(await modeChip().innerText()));
    // /model tapé à la main rouvre le sélecteur
    await input.fill('/model');
    await input.press('Enter');
    await page.waitForTimeout(250);
    ok('« /model » manuel rouvre le sélecteur', await bodyHas(/Modèle de la session/));
    await input.press('Escape');
    // retire le modèle via le x de la chip
    await root().locator('button[title="Revenir au modèle par défaut"]').click();
    await page.waitForTimeout(200);
    ok('chip modèle retirée', !(await bodyHas(/Qwen3 32B/)));

    // ── Écho optimiste + busy (stop remplace envoyer) ───────────────────
    await inject({ type: 'session.idle', properties: { sessionID: 's1' } });
    await page.waitForTimeout(200);
    ok('au repos : bouton Envoyer visible, pas Stop', await root().locator('button[title="Envoyer"]').count() === 1
        && await root().locator('button[title^="Interrompre"]').count() === 0);
    await input.fill('ajoute des tests');
    await input.press('Enter');
    await page.waitForTimeout(300);
    ok('écho pending (horloge)', await htmlHas(/ph-clock/) && await bodyHas(/ajoute des tests/));
    await inject({ type: 'message.updated', properties: { info: {
        id: 'm3', role: 'user', sessionID: 's1', time: { created: Date.now() } } } });
    await inject({ type: 'message.part.updated', properties: { part: {
        id: 'm3p1', type: 'text', text: 'ajoute des tests', messageID: 'm3', sessionID: 's1',
        time: { start: Date.now() } } } });
    await inject({ type: 'message.updated', properties: { info: {
        id: 'm4', role: 'assistant', sessionID: 's1', time: { created: Date.now() } } } });
    await page.waitForTimeout(500);
    ok('pending confirmé + session busy', !(await htmlHas(/ph-clock/)) && await bodyHas(/Génération/));
    ok('busy : UN seul indicateur d\'activité', await root().locator('[data-code-status]').count() === 1);
    ok('busy : Stop remplace Envoyer (parité chat)', await root().locator('button[title^="Interrompre"]').count() === 1
        && await root().locator('button[title="Envoyer"]').count() === 0);
    // thinking live : REPLIÉ par défaut (pas d'auto-ouverture), activité = shimmer
    await inject({ type: 'message.part.updated', properties: { part: {
        id: 'm4think', type: 'reasoning', text: 'Je réfléchis aux cas limites…',
        messageID: 'm4', sessionID: 's1', time: { start: Date.now() } } } });
    await page.waitForTimeout(400);
    const liveThink = root().locator('details[data-code-think]').last();
    ok('thinking live REPLIÉ par défaut', (await liveThink.getAttribute('open')) === null);
    ok('thinking live : libellé animé (mem-wave)', await liveThink.locator('summary .mem-wave').count() === 1);
    ok('statut : phase RÉELLE (réflexion en cours)',
        /Réflexion/.test(await root().locator('[data-code-status]').innerText()));
    // Le statut vit DANS la colonne du message : son alignement se mesure, il
    // ne se règle pas au padding (l'ancienne ligne détachée était 8 px trop à
    // gauche de la colonne des messages).
    await inject({ type: 'message.part.updated', properties: { part: {
        id: 'm4p1', type: 'text', text: 'Je commence par les cas limites.',
        messageID: 'm4', sessionID: 's1', time: { start: Date.now() } } } });
    await page.waitForTimeout(400);
    ok('statut : phase suit la rédaction',
        /Rédaction/.test(await root().locator('[data-code-status]').innerText()));
    const alignLeft = await page.evaluate(() => {
        const st = document.querySelector('[data-code-status]');
        const col = st && st.closest('.flex-1');
        const md = col && col.querySelector('.markdown-body');
        if (!st || !md) return null;
        return [st.getBoundingClientRect().left, md.getBoundingClientRect().left];
    });
    ok('statut aligné sur le texte du message (même colonne)',
        !!alignLeft && Math.abs(alignLeft[0] - alignLeft[1]) < 1);
    await inject({ type: 'session.idle', properties: { sessionID: 's1' } });
    await page.waitForTimeout(300);
    ok('idle : Envoyer revient', await root().locator('button[title="Envoyer"]').count() === 1);
    ok('idle : plus aucun indicateur d\'activité', await root().locator('[data-code-status]').count() === 0);

    // ── /undo côté CLI : le message retiré disparaît de la page ─────────
    ok('avant retrait : le message user est là', await bodyHas(/ajoute des tests/));
    await inject({ type: 'message.removed', properties: { sessionID: 's1', messageID: 'm3' } });
    await page.waitForTimeout(300);
    ok('message.removed : le message disparaît du transcript',
        !(await bodyHas(/ajoute des tests/)));

    // ── Session hors ligne : lecture seule assumée ──────────────────────
    await root().locator('button[title="Retour aux sessions"]').click();
    await page.waitForTimeout(300);
    await root().locator('div[role="button"]:has-text("Vieille session")').first().click();
    await page.waitForTimeout(400);
    ok('hors ligne : badge dans le header', await bodyHas(/hors ligne/));
    ok('hors ligne : composer désactivé + explication', await root().locator('textarea').isDisabled()
        && await htmlHas(/CLI hors ligne — relancez opencode/));

    // ── Échap : session → liste → chat ──────────────────────────────────
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    ok('Échap : retour à la liste', await bodyHas(/Refactor auth/) && await bodyHas(/connecté/));

    // ── /session : reprendre une autre session de la même CLI ───────────
    await root().locator('div[role="button"]:has-text("Refactor auth")').first().click();
    await page.waitForTimeout(400);
    const input2 = root().locator('textarea');
    await input2.click();
    await input2.fill('/session');
    await page.waitForTimeout(250);
    await input2.press('Enter');          // app cmd /session → picker
    await page.waitForTimeout(300);
    ok('/session : picker ouvert', await bodyHas(/Reprendre une session/));
    ok('/session : liste = sessions connectées de la même CLI',
        await bodyHas(/Autre chantier/) && !(await bodyHas(/Vieille session/)));
    await input2.press('Enter');          // idx 0 = s3
    await page.waitForTimeout(400);
    ok('/session : bascule vers la session choisie', await bodyHas(/Autre chantier/)
        && !(await bodyHas(/Reprendre une session/)));

    // ── Trace de commande live (SSE code.note) ──────────────────────────
    await inject({ type: 'code.note', properties: { sessionID: 's3', note: {
        info: { id: 'note-live', role: 'note', sessionID: 's3', time: { created: Date.now() },
                note: { kind: 'action', label: '/undo', detail: '' } }, parts: [] } } });
    await page.waitForTimeout(300);
    ok('note live : pill /undo apparue', await bodyHas(/\/undo/));

    // ── Permissions : bannière → réponse → disparition ──────────────────
    await inject({ type: 'permission.updated', properties: {
        id: 'permA', type: 'bash', pattern: 'rm -rf *', sessionID: 's3',
        title: 'Exécuter rm -rf ?', time: { created: Date.now() } } });
    await page.waitForTimeout(300);
    ok('permission : bannière affichée (titre + type · pattern)',
        await bodyHas(/Exécuter rm -rf \?/) && await bodyHas(/bash · rm -rf \*/));
    await root().locator('button:has-text("Autoriser")').first().click();
    await page.waitForTimeout(300);
    const sentP = await (await fetch(BASE_URL + '/__sent')).json();
    ok('permission : POST once envoyé', sentP.sent.some(s => s.kind === 'permission'
        && s.sid === 's3' && s.pid === 'permA' && s.response === 'once'));
    ok('permission : bannière retirée (optimiste)', !(await bodyHas(/Exécuter rm -rf \?/)));
    // répondu côté TUI → permission.replied retire aussi la bannière
    await inject({ type: 'permission.updated', properties: {
        id: 'permB', type: 'edit', sessionID: 's3', title: 'Modifier x.py ?',
        time: { created: Date.now() } } });
    await page.waitForTimeout(250);
    ok('permission : 2e demande affichée', await bodyHas(/Modifier x\.py \?/));
    await inject({ type: 'permission.replied', properties: {
        sessionID: 's3', permissionID: 'permB', response: 'reject' } });
    await page.waitForTimeout(250);
    ok('permission : replied (TUI) retire la bannière', !(await bodyHas(/Modifier x\.py \?/)));

    // ── Questions (outil `question`, greffon v14) : bannière → réponse → disparition ──
    await inject({ type: 'question.asked', properties: { id: 'queA', sessionID: 's3', questions: [
        { question: 'Quelle base de données ?', header: 'Base', multiple: false, custom: true,
          options: [{ label: 'Postgres', description: 'prod' }, { label: 'SQLite', description: 'dev' }] },
        { question: 'Que générer ?', header: 'Livrables', multiple: true, custom: false,
          options: [{ label: 'tests', description: '' }, { label: 'docs', description: '' }] },
    ] } });
    await page.waitForTimeout(300);
    const qBox = () => root().locator('[data-code-questions]');
    const qReply = () => qBox().locator('button:has-text("Répondre")').first();
    ok('question : bannière affichée (questions + en-tête)',
        await bodyHas(/Quelle base de données \?/) && await bodyHas(/Que générer \?/) && await bodyHas(/livrables/i));
    ok('question : options rendues', await bodyHas(/Postgres/) && await bodyHas(/SQLite/) && await bodyHas(/docs/));
    ok('question : saisie libre seulement si custom', await qBox().locator('input[type="text"]').count() === 1);
    ok('question : Répondre désactivé sans réponse', await qReply().isDisabled());
    await qBox().locator('button:has-text("Postgres")').click();
    await page.waitForTimeout(150);
    ok('question : Répondre encore désactivé (2e question sans réponse)', await qReply().isDisabled());
    await qBox().locator('button:has-text("tests")').click();
    await qBox().locator('button:has-text("docs")').click();
    await page.waitForTimeout(150);
    ok('question : Répondre activé quand chaque question a une réponse', !(await qReply().isDisabled()));
    await qBox().locator('button:has-text("SQLite")').click();   // choix unique : remplace Postgres
    await page.waitForTimeout(150);
    await qReply().click();
    await page.waitForTimeout(300);
    const sentQ = await (await fetch(BASE_URL + '/__sent')).json();
    const qa = sentQ.sent.find(s => s.kind === 'question' && s.qid === 'queA');
    ok('question : POST answers (choix unique remplacé, multiple cumulé)',
        !!qa && qa.sid === 's3' && JSON.stringify(qa.answers) === JSON.stringify([['SQLite'], ['tests', 'docs']]));
    ok('question : bannière retirée (optimiste)', !(await bodyHas(/Quelle base de données \?/)));
    // saisie libre : Entrée envoie le texte comme libellé
    await inject({ type: 'question.asked', properties: { id: 'queB', sessionID: 's3', questions: [
        { question: 'Nom du module ?', header: '', multiple: false, custom: true, options: [] } ] } });
    await page.waitForTimeout(250);
    ok('question : 2e demande (saisie libre) affichée', await bodyHas(/Nom du module \?/));
    const qFree = qBox().locator('input[type="text"]').first();
    await qFree.fill('auth_core');
    await qFree.press('Enter');
    await page.waitForTimeout(300);
    const sentQ2 = await (await fetch(BASE_URL + '/__sent')).json();
    const qb = sentQ2.sent.find(s => s.kind === 'question' && s.qid === 'queB');
    ok('question : saisie libre envoyée comme libellé', !!qb && JSON.stringify(qb.answers) === JSON.stringify([['auth_core']]));
    // refus depuis la page
    await inject({ type: 'question.asked', properties: { id: 'queC', sessionID: 's3', questions: [
        { question: 'On continue ?', header: '', multiple: false, custom: false, options: [{ label: 'oui', description: '' }] } ] } });
    await page.waitForTimeout(250);
    await qBox().locator('button:has-text("Refuser")').first().click();
    await page.waitForTimeout(300);
    const sentQ3 = await (await fetch(BASE_URL + '/__sent')).json();
    ok('question : Refuser → POST reject', sentQ3.sent.some(s => s.kind === 'question' && s.qid === 'queC' && s.reject === true));
    ok('question : bannière retirée après refus', !(await bodyHas(/On continue \?/)));
    // répondu côté TUI → question.replied retire aussi la bannière
    await inject({ type: 'question.asked', properties: { id: 'queD', sessionID: 's3', questions: [
        { question: 'Depuis le TUI ?', header: '', multiple: false, custom: true, options: [] } ] } });
    await page.waitForTimeout(250);
    ok('question : 4e demande affichée', await bodyHas(/Depuis le TUI \?/));
    await inject({ type: 'question.replied', properties: { sessionID: 's3', questionID: 'queD' } });
    await page.waitForTimeout(250);
    ok('question : replied (TUI) retire la bannière', !(await bodyHas(/Depuis le TUI \?/)));

    // ── Déconnexion propre (bye → client.disconnected) ──────────────────
    await fetch(BASE_URL + '/__cli?down=1');
    await inject({ type: 'client.disconnected', properties: { client: 'c1' } });
    await page.waitForTimeout(500);
    ok('déconnexion : badge hors ligne immédiat', await bodyHas(/hors ligne/));
    ok('déconnexion : composer désactivé', await root().locator('textarea').isDisabled());
    await fetch(BASE_URL + '/__cli?down=0');

    // ── /new et /exit visent la CLI, pas la session ─────────────────────
    // Régression : routées en « action de session », elles partaient sans cible
    // → le serveur choisissait le destinataire par propriétaire de session et,
    // avec deux opencode connectés, pouvait créer la session dans le mauvais
    // (invisible pour l'utilisateur). Et « /exit », absent des commandes app,
    // tombait dans le cas « inconnue » et partait comme PROMPT au modèle.
    // on revient à la liste (l'étape précédente laisse une session ouverte)
    await page.keyboard.press('Escape');
    await page.waitForTimeout(400);
    await root().locator('div[role="button"]:has-text("Refactor auth")').first().click();
    await page.waitForTimeout(600);
    await root().locator('textarea').fill('/new');
    await page.waitForTimeout(250);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(500);
    let sentNow = await fetch(BASE_URL + '/__sent').then(r => r.json()).then(d => d.sent);
    ok('/new : envoyé sur /api/code/new avec la CLI ciblée',
       sentNow.some(s => s.kind === 'new' && s.client === 'c1'));
    ok('/new : jamais envoyé en prompt ni en action de session',
       !sentNow.some(s => s.kind === 'prompt' && /\/new/.test(s.text || ''))
       && !sentNow.some(s => s.kind === 'action' && s.action === 'new'));

    await root().locator('textarea').fill('/exit');
    await page.waitForTimeout(250);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(400);
    ok('/exit : confirmation demandée avant de fermer la CLI',
       await page.locator('body').innerText().then(t => /Fermer opencode/.test(t)));
    await page.locator('button:has-text("Confirmer"), button:has-text("Oui"), button:has-text("Fermer opencode")')
        .last().click().catch(() => {});
    await page.waitForTimeout(500);
    sentNow = await fetch(BASE_URL + '/__sent').then(r => r.json()).then(d => d.sent);
    ok('/exit : envoyé sur /api/code/clients/{cid}/exit',
       sentNow.some(s => s.kind === 'exit' && s.client === 'c1'));
    ok('/exit : jamais parti comme prompt au modèle',
       !sentNow.some(s => s.kind === 'prompt' && /\/exit/.test(s.text || '')));

    // ── Drawer « Connecter » : appairage par code ────────────────────────
    // (on est encore en vue session : le bloc ci-dessous remonte à la liste,
    //  où vit le bouton « Connecter ». Un Échap de trop fermerait la PAGE.)
    // La CLI (/remote login) renvoie l'utilisateur vers ce panneau. Il annonçait
    // une saisie qui n'existait pas : l'endpoint pair/confirm était injoignable
    // depuis l'UI, donc le device flow ne pouvait pas aboutir.
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
    await root().locator('button:has-text("Connecter")').first().click();
    await page.waitForTimeout(300);
    ok('drawer : champ de code d\'appairage présent',
       await root().locator('input[aria-label="Code d\'appairage"]').isVisible());
    ok('drawer : les 3 étapes restent lisibles',
       await bodyHas(/Installer opencode/) && await bodyHas(/Appairer le poste/) && await bodyHas(/Piloter/));

    // code refusé (404) → message explicite, champ conservé pour corriger
    await root().locator('input[aria-label="Code d\'appairage"]').fill('zzz-999');
    await root().locator('button:has-text("Appairer")').click();
    await page.waitForTimeout(400);
    ok('appairage : code invalide signalé', await page.locator('body').innerText()
        .then(t => /inconnu ou expiré/i.test(t)));

    // code valide (tiret + minuscules tolérés) → normalisé côté client
    await root().locator('input[aria-label="Code d\'appairage"]').fill('abc-123');
    await root().locator('button:has-text("Appairer")').click();
    await page.waitForTimeout(400);
    const pairSent = await fetch(BASE_URL + '/__sent').then(r => r.json())
        .then(d => d.sent.filter(s => s.kind === 'pair'));
    ok('appairage : code normalisé (tiret/minuscules retirés)',
       pairSent.some(p => p.code === 'ABC123'));
    ok('appairage : champ vidé après succès',
       (await root().locator('input[aria-label="Code d\'appairage"]').inputValue()) === '');

    // ── CLI connectée mais AUCUNE session publiée ────────────────────────
    // opencode ne matérialise la session qu'au premier message : la page
    // affichait « CLI connectée » au-dessus d'une liste vide, sans explication.
    await fetch(BASE_URL + '/__nosession?on=1');
    await page.locator('button[title^="Remote code"]:visible').first().click();
    await page.waitForTimeout(900);
    ok('CLI sans session : la page le DIT', await bodyHas(/CLI connectée, aucune session ouverte/i));
    ok('CLI sans session : la raison est donnée',
        await bodyHas(/ne crée la session qu.au premier message/i));
    ok('CLI sans session : le répertoire identifie la CLI', await bodyHas(/\/home\/dev\/webapp/));
    ok('CLI sans session : pas le message « lancez opencode » (déjà fait)',
        !(await bodyHas(/Aucune session pour l.instant/i)));
    const nBefore = (await (await fetch(BASE_URL + '/__sent')).json()).sent.length;
    await root().locator('button:has-text("Nouvelle session")').first().click();
    await page.waitForTimeout(500);
    const sentNew = (await (await fetch(BASE_URL + '/__sent')).json()).sent;
    ok('CLI sans session : « Nouvelle session » cible CETTE CLI',
        sentNew.length > nBefore && sentNew.at(-1).kind === 'new' && sentNew.at(-1).client === 'c1');
    await fetch(BASE_URL + '/__nosession?on=0');


    ok('aucune erreur JS de page', errors.length === 0);
    if (errors.length) console.log('  erreurs:', errors.slice(0, 5));
} catch (e) {
    ok('exécution sans exception', false);
    console.log('  ! ' + String(e && e.message || e).split('\n')[0]);
} finally {
    await browser.close();
}

const pass = checks.filter(c => c[0] === 'PASS').length;
console.log(`\n${pass}/${checks.length} checks PASS`);
checks.forEach(([s, n]) => console.log(`  ${s === 'PASS' ? '✓' : '✗'} ${n}`));
process.exit(pass === checks.length ? 0 : 1);
