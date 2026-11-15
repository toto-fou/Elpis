// SPDX-License-Identifier: MIT
/** tests/frontend/clips/scenes/55-savoir.mjs — clips du bloc « Le savoir du compte » : skills (bibliothèque, épingle, création), mémoire long terme, prompts sauvegardés et gabarits */
import { ouvrirPlateau, revenirAuDepart } from '../lib/tournage.mjs';

const SAISIE = 'textarea[placeholder]';
const ENVOYER = 'button:has(i.ph-paper-plane-right)';
const EN_COURS = 'button[title="Arrêter la génération"]';
/** Fenêtre des Paramètres, au même cadre que les clips « Paramètres ». */
const FENETRE = [192, 76, 896, 560];
const CHAT = [264, 0, 1016, 635];
const SKILLS = 'div[aria-label="Gestion des skills"]';

const SKILLS_PERSO = [
    { name: 'deploiement-preprod', tags: 'deploiement, preprod', description: 'Déployer l’application en préproduction : construction, migration de la base, vérifications.', body: '# Déployer en préproduction\n\n1. Construire l’image depuis la branche `release`.\n2. Lancer la migration de la base.\n3. Vérifier la page de santé, puis prévenir l’équipe.\n' },
    { name: 'compte-rendu-incident', tags: 'incident', description: 'Rédiger le compte rendu d’un incident : chronologie, cause, actions correctives.', body: '# Compte rendu d’incident\n\n1. Chronologie, heure par heure.\n2. Cause retenue.\n3. Actions correctives, avec responsable et échéance.\n' },
];
const CORPS_ASTREINTE = '# Prise d’astreinte\n\n1. Lire le journal de la semaine.\n2. Contrôler les liaisons dans la supervision.\n3. Vérifier le téléphone d’astreinte.\n';
const PROFIL = ['Administratrice réseau, responsable des pare-feu et des VPN des sites.', 'Préfère des réponses courtes, avec les commandes à exécuter.'];
const NOTES = ['Fenêtre de maintenance : le jeudi de 20 h à 22 h.', 'Les certificats des tunnels IPsec sont renouvelés chaque année en mars.'];
const FAIT = 'L’astreinte réseau change le lundi à 9 h.';
const DEMANDE = 'Rédige le compte rendu de la réunion à partir de mes notes : décisions prises, actions avec responsable et échéance, points en suspens.';
const REPONSE = 'Voici le compte rendu.\n\n**Décisions**\n\n- La migration du pare-feu de Lyon est fixée au jeudi 12.\n\n**Actions**\n\n- Préparer le plan de retour arrière — équipe réseau, avant mardi.\n\n**Points en suspens**\n\n- Le budget des liaisons de secours reste à valider.';
const GABARIT = { name: 'resume', title: 'Résumé de document', content: 'Résume le document joint pour {{destinataire | placeholder="ex. la direction"}}, en {{longueur | select:options=["5 lignes","10 lignes","une page"]}}, sur un ton {{ton | select:options=["neutre","formel"]}}.' };

// Remet le compte à zéro pour ce bloc : conversations des clips, skills personnels, prompts, gabarits, mémoire.
async function vider({ api, core }) {
    const fixes = new Set(core.chats.map((c) => c.id));
    for (const c of (await api.req('GET', '/api/saved/chats')).items.filter((x) => !fixes.has(x.id))) await api.req('DELETE', `/api/saved/chats/${c.id}`);
    for (const s of (await api.req('GET', '/api/skills?scope=user')).skills) await api.req('DELETE', `/api/skills/${encodeURIComponent(s.name)}?scope=user`);
    for (const p of (await api.req('GET', '/api/prompts')).items) await api.req('DELETE', `/api/prompts/${p.id}`);
    for (const g of (await api.req('GET', '/api/prompt-templates')).items) await api.req('DELETE', `/api/prompt-templates/${g.id}`);
    for (const genre of ['user', 'memory']) await api.req('PUT', `/api/memory/state/${genre}`, { entries: [] });
}

// Quitte la conversation ouverte, vide le compte, pose ce que le clip demande, puis recharge l'écran d'accueil.
async function poser(plateau, { skills = false, memoire = false, prompts = [], gabarit = false } = {}) {
    const { api } = plateau;
    await accueil(plateau.page);
    await vider(plateau);
    if (skills) for (const s of SKILLS_PERSO) await api.req('POST', '/api/skills', { scope: 'user', ...s });
    await api.req('PUT', '/api/settings', { memory_enabled: memoire });
    if (memoire) {
        await api.req('PUT', '/api/memory/state/user', { entries: PROFIL });
        await api.req('PUT', '/api/memory/state/memory', { entries: NOTES });
    }
    for (const p of prompts) await api.req('POST', '/api/prompts', p);
    if (gabarit) await api.req('POST', '/api/prompt-templates', GABARIT);
    await revenirAuDepart(plateau);
    await accueil(plateau.page);
}

// L'application rouvre la dernière conversation : « Nouveau chat » ramène l'écran d'accueil.
async function accueil(page) {
    await page.locator('button:has-text("Nouveau chat"):visible').first().click();
    await page.getByText('Comment puis-je vous aider').waitFor();
    await page.mouse.move(1276, 796);
}

// Ouvre les Paramètres sur un onglet du rail, pointeur écarté.
async function ouvrirParametres(page, onglet) {
    await page.locator('button[title="Paramètres"]:visible').first().click();
    await page.locator(`aside button:has-text("${onglet}"):visible`).first().click();
    await page.mouse.move(1276, 796);
}

export default {
    async ouvrir() { return ouvrirPlateau({ outilsEnProcessus: true }); },
    clips: [
        {
            nom: 'skills-bibliotheque',
            cadre: FENETRE,
            async preparer(plateau) {
                await poser(plateau, { skills: true });
                await ouvrirParametres(plateau.page, 'Skills');
                await plateau.page.locator(`${SKILLS} [role="tree"]`).first().waitFor();
            },
            async jouer({ page }, { pause }) {
                await pause(400);
                await page.locator('[data-sous-menu] [data-section="perso"]').click();
                const ligne = page.locator(SKILLS).getByText('deploiement-preprod', { exact: true }).first();
                await ligne.waitFor();
                await pause(400);
                await pause(300);
                await ligne.click();
                const etape = page.locator(SKILLS).getByText('Lancer la migration de la base.');
                await etape.waitFor();
                await pause(400);
                await etape.hover();
            },
        },
        {
            nom: 'skills-epingler',
            cadre: CHAT,
            async preparer(plateau) { await poser(plateau, { skills: true }); },
            async jouer({ page }, { pause }) {
                const saisie = page.locator(SAISIE).last();
                await saisie.click();
                await saisie.pressSequentially('/skills', { delay: 20 });
                await pause(300);
                await saisie.press('Enter');
                const lignes = page.locator('[data-slash-level="skills"] li[data-slash-row]');
                await lignes.first().waitFor();
                await pause(400);
                await saisie.pressSequentially('dep', { delay: 40 });
                await page.waitForFunction(() => document.querySelectorAll('[data-slash-level="skills"] li[data-slash-row]').length === 1);
                await pause(300);
                await lignes.first().click();
                const epingle = page.locator('.elpis-compose-card').getByText('deploiement-preprod');
                await epingle.waitFor();
                await epingle.hover();
            },
        },
        {
            nom: 'skills-creer',
            max: 7,
            async preparer(plateau) {
                await poser(plateau, { skills: true });
                await ouvrirParametres(plateau.page, 'Skills');
                await plateau.page.locator('[data-sous-menu] [data-section="perso"]').click();
                await plateau.page.locator(SKILLS).getByText('deploiement-preprod', { exact: true }).first().waitFor();
                await plateau.page.mouse.move(1276, 796);
            },
            async jouer({ page }, { pause }) {
                const zone = page.locator(SKILLS);
                await zone.locator('button:has-text("Nouveau")').first().click();
                const nom = zone.locator('input[placeholder="deploy-staging"]');
                await nom.click();
                await nom.pressSequentially('prise-astreinte', { delay: 20 });
                const description = zone.locator('input[placeholder^="Quand et comment"]');
                await description.click();
                await description.pressSequentially('Prendre l’astreinte réseau : contrôles du lundi.', { delay: 20 });
                await zone.locator('textarea').fill(CORPS_ASTREINTE);
                await pause(400);
                await zone.locator('button:has-text("Créer")').first().click();
                const cree = zone.getByText('prise-astreinte', { exact: true }).first();
                await cree.waitFor();
                await cree.hover();
            },
        },
        {
            nom: 'memoire',
            async preparer(plateau) { await poser(plateau, { memoire: true }); },
            async jouer({ page }, { pause }) {
                const saisie = page.locator(SAISIE).last();
                await saisie.click();
                await saisie.pressSequentially('/memory', { delay: 20 });
                await pause(400);
                await saisie.press('Enter');
                await page.locator('[data-mem-text]').first().waitFor();
                await pause(400);
                await page.locator('[data-mem-edit]').hover();
            },
        },
        {
            nom: 'memoire-chat',
            cadre: CHAT,
            max: 7,
            async preparer(plateau) {
                await poser(plateau, { memoire: true });
                plateau.core.llm.scripterTitre('Astreinte réseau');
                plateau.core.llm.scripter({ appels: [{ nom: 'memory', args: { action: 'add', store: 'memory', content: FAIT } }] }, 'C’est noté : l’astreinte réseau change le lundi à 9 h. Je m’en souviendrai dans nos prochaines conversations.');
            },
            async jouer({ page }, { pause }) {
                const saisie = page.locator(SAISIE).last();
                await saisie.click();
                await saisie.pressSequentially('Retiens que l’astreinte réseau change le lundi à 9 h.', { delay: 20 });
                await pause(200);
                await page.locator(ENVOYER).last().click();
                await page.waitForSelector(EN_COURS, { timeout: 15000 });
                await page.waitForSelector(EN_COURS, { state: 'detached', timeout: 30000 });
                const effet = page.locator('[data-effects] > .elpis-effect .elpis-effect-head').first();
                await effet.waitFor();
                await pause(400);
                await effet.click();
                await page.locator('[data-effect-added]').first().waitFor();
                await page.locator('[data-effect-undo]').first().waitFor();
                await page.locator('[data-effect-added]').first().hover();
            },
        },
        {
            nom: 'memoire-editer',
            cadre: FENETRE,
            max: 6,
            async preparer(plateau) {
                await poser(plateau, { memoire: true });
                await ouvrirParametres(plateau.page, 'Mémoire');
                await plateau.page.locator('[data-mem-text]').first().waitFor();
            },
            async jouer({ page }, { pause }) {
                await page.locator('[data-mem-edit]').click();
                await page.locator('[data-mem-add-user]').click();
                const entree = page.locator('[data-mem-entry-user]').last();
                await entree.pressSequentially('Assure l’astreinte réseau une semaine sur quatre.', { delay: 20 });
                await pause(300);
                await page.locator('[data-mem-save]').click();
                const ajoutee = page.locator('[data-mem-text]', { hasText: 'astreinte réseau' });
                await ajoutee.waitFor();
                await ajoutee.hover();
            },
        },
        {
            nom: 'prompts-sauvegarder',
            max: 8,
            async preparer(plateau) {
                const { api, page } = plateau;
                await poser(plateau);
                const { id } = await api.req('POST', '/api/saved/chats/new', {});
                await api.req('PUT', `/api/saved/chats/${id}/save-messages`, { title: 'Réunion d’exploitation', messages: [{ role: 'user', content: DEMANDE }, { role: 'assistant', content: REPONSE }] });
                await revenirAuDepart(plateau);
                await page.locator('[data-chat-row]', { hasText: 'Réunion d’exploitation' }).first().click();
                await page.getByText('Voici le compte rendu.').waitFor();
                await page.mouse.move(1276, 796);
            },
            async jouer({ page }, { pause }) {
                await page.getByText(DEMANDE).hover();
                await pause(300);
                await page.locator('button[title="Sauvegarder"]').first().click();
                const boite = page.locator('[role="dialog"]', { hasText: 'Sauvegarder' });
                await boite.locator('input').pressSequentially('Compte rendu de réunion', { delay: 20 });
                await pause(200);
                await boite.locator('button:has-text("Valider")').click();
                await boite.waitFor({ state: 'hidden' });
                const saisie = page.locator(SAISIE).last();
                await saisie.click();
                await saisie.pressSequentially('/prompt', { delay: 20 });
                await pause(300);
                await saisie.press('Enter');
                const ligne = page.locator('[data-slash-level="prompts"] li[data-slash-row]', { hasText: 'Compte rendu de réunion' });
                await ligne.waitFor();
                await pause(400);
                await ligne.click();
                await page.waitForFunction((t) => document.querySelector('.elpis-compose-card textarea')?.value === t, DEMANDE);
                await saisie.hover();
            },
        },
        {
            nom: 'prompts-template',
            cadre: CHAT,
            max: 7,
            async preparer(plateau) { await poser(plateau, { gabarit: true }); },
            async jouer({ page }, { pause }) {
                const saisie = page.locator(SAISIE).last();
                await saisie.click();
                await saisie.pressSequentially('/template', { delay: 20 });
                await pause(300);
                await saisie.press('Enter');
                const ligne = page.locator('[data-slash-level="values"] li[data-slash-row]', { hasText: 'Résumé de document' });
                await ligne.waitFor();
                await pause(300);
                await ligne.click();
                await page.locator('[data-template-fill]').waitFor();
                const destinataire = page.locator('#tpl-f-destinataire');
                await destinataire.click();
                await destinataire.pressSequentially('la direction', { delay: 20 });
                await page.locator('#tpl-f-longueur').selectOption('10 lignes');
                await pause(400);
                await page.locator('[data-template-insert]').click();
                await page.waitForFunction(() => (document.querySelector('.elpis-compose-card textarea')?.value || '').includes('la direction'));
                await saisie.hover();
            },
        },
    ],
};
