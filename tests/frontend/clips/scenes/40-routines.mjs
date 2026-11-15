// SPDX-License-Identifier: MIT
/** tests/frontend/clips/scenes/40-routines.mjs — clips du bloc « Les routines » : assistant, création à la main, journal des exécutions, exécution immédiate, mise en pause */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DEPOT } from '../../lib/core-reel.mjs';
import { demarrerFauxMcp } from '../../lib/faux-mcp.mjs';
import { ouvrirPlateau, revenirAuDepart } from '../lib/tournage.mjs';

const PAGE = '.elpis-routines-page';
const EN_COURS = 'button[title="Arrêter la génération"]';
const RUN = '[data-run-row]';
/** L'entrée « Routines » du volet déployé (le rail réduit porte le même titre). */
const ENTREE_ROUTINES = 'button[title="Routines"].w-full:visible';
/** Volet réduit : la vue d'une routine seule, sous l'en-tête de la page. */
const CADRE_VUE = [368, 64, 912, 570];

const FAMILLES_HOTE = ['fs', 'shell', 'git', 'browser', 'office'];
const FAMILLES_CORE = ['chart', 'memory', 'skill', 'todo'];
const attendre = (ms) => new Promise((r) => setTimeout(r, ms));
const locaux = (categories) => [{ type: 'stdio', name: 'Outils Locaux', command: 'DEFAULT_LOCAL_PYTHON', filter_categories: categories }];

export const ARCHIVAGE = { name: 'Archivage mensuel', cron_expr: '0 18 1 * *', task_prompt: 'Range les comptes rendus du mois écoulé dans le dossier archives.', enabled: false, mcp_servers: locaux(['fs']) };
export const TICKETS = { name: 'Point hebdo des tickets', cron_expr: '30 8 * * 1', task_prompt: 'Résume les tickets ouverts cette semaine, classés par priorité.', enabled: true, mcp_servers: locaux(['fs']) };
export const VEILLE = { name: 'Veille des dépendances', cron_expr: '0 7 * * *', task_prompt: 'Vérifie les mises à jour des dépendances du projet et résume les changements importants dans un rapport.', enabled: true, mcp_servers: locaux(['fs', 'shell']) };

/** Conversations d'alice, de la plus ancienne à la plus récente. */
export const CONVERSATIONS = [
    { titre: 'Plan de tests de la version 2.4', question: 'Quels parcours faut-il couvrir avant la version 2.4 ?', reponse: 'Trois parcours suffisent pour cette version :\n\n1. Connexion et droits\n2. Import des données clients\n3. Export du rapport mensuel' },
    { titre: 'Compte rendu du comité de pilotage', question: 'Résume les décisions du comité de pilotage.', reponse: 'Le comité a pris **deux décisions** :\n\n- la mise en production est fixée au 2 décembre ;\n- la recette démarre lundi, avec l\'équipe support.' },
    { titre: 'Migration de la base clients', question: 'Par quoi commencer pour migrer la base clients ?', reponse: 'Commencez par une **sauvegarde complète**, puis migrez les tables une par une en vérifiant les volumes après chaque étape.' },
];

/** Journal semé de la veille quotidienne, du plus récent au plus ancien. */
const JOURNAL = [
    { statut: 'ok', ms: 52900, entree: 7340, sortie: 688, rapport: true, resume: 'Trois mises à jour, dont un correctif de sécurité.\n\n- **fastify** 5.2.2 → 5.3.0 (sécurité)\n- **vue** 3.5.12 → 3.5.13\n- **zod** 3.23 → 3.24\n\nÀ faire : passer `fastify` en 5.3.0.' },
    { statut: 'ok', ms: 38400, entree: 5980, sortie: 471, resume: 'Rien à signaler : toutes les dépendances sont à jour.' },
    { statut: 'error', ms: 30000, entree: 0, sortie: 0, erreur: 'génération interrompue (erreur LLM) — réponse partielle conservée' },
    { statut: 'ok', ms: 41200, entree: 6120, sortie: 512, resume: 'Deux mises à jour mineures, aucune rupture de compatibilité.' },
];

const QUESTIONS = [
    { q: 'Quels tickets faut-il résumer ?', options: ['Tous les tickets ouverts', 'Seulement les tickets urgents', 'Ceux qui me sont assignés'] },
    { q: 'Quand voulez-vous être prévenue ?', options: ['À chaque exécution', 'Seulement en cas d\'échec'] },
];

// Plateau d'une installation complète : hôte d'outils simulé servant les définitions réelles des familles fs, shell, git, browser et office, familles du compte servies par le core, champs natifs du navigateur en français.
export async function ouvrirAvecOutils(options = {}) {
    const definitions = (famille) => JSON.parse(fs.readFileSync(path.join(DEPOT, 'packages/outils-mcp/goldens', `${famille}.json`), 'utf8')).outils;
    const hote = await demarrerFauxMcp({ nom: 'elpis-toolhost', outils: FAMILLES_HOTE.flatMap(definitions) });
    const dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'elpis-clips-outils-'));
    const manifeste = path.join(dossier, 'mcp.json');
    fs.writeFileSync(manifeste, JSON.stringify({
        version: 1,
        mcpServers: {
            ...Object.fromEntries(FAMILLES_CORE.map((f) => [`elpis-${f}`, { type: 'inprocess', description: `famille ${f}`, 'x-elpis': { role: 'app', families: [f] } }])),
            'elpis-outils': { type: 'http', url: hote.url, description: 'outils du sandbox', 'x-elpis': { role: 'toolhost', host: 'main', families: ['fs'] } },
        },
        placement: { strategy: 'single', host: 'main' },
    }, null, 2));
    const menage = async () => { await hote.arreter(); fs.rmSync(dossier, { recursive: true, force: true }); };
    const langue = process.env.LANGUAGE;
    process.env.LANGUAGE = 'fr_FR';
    try {
        const plateau = await ouvrirPlateau({ ...options, envSup: { APP_MCP_MANIFEST: manifeste, LOCAL_MCP_URL: hote.url, ...options.envSup } });
        return { ...plateau, fermer: async () => { await plateau.fermer(); await menage(); } };
    } catch (e) {
        await menage();
        throw e;
    } finally {
        if (langue === undefined) delete process.env.LANGUAGE; else process.env.LANGUAGE = langue;
    }
}

// Vide les files du faux moteur : une réponse laissée par un clip interrompu ne sert jamais au suivant.
export function viderScript({ llm }) {
    for (const file of [llm.etat.file, llm.etat.titres, llm.etat.annexes]) file.length = 0;
}

// Runs passés d'une routine écrits en base : un par jour à 7 h, le dernier toujours dans le passé.
function semerJournal(core, routineId) {
    const base = new DatabaseSync(path.join(core.dossier, 'racine/user_db/app.db'));
    try {
        base.exec('PRAGMA busy_timeout = 5000');
        const { owner_user_id: compte } = base.prepare('SELECT owner_user_id FROM editor_routines WHERE id=?').get(routineId);
        const dernier = new Date();
        dernier.setHours(7, 0, 4, 0);
        if (dernier.getTime() > Date.now() - 600_000) dernier.setDate(dernier.getDate() - 1);
        const ajout = base.prepare('INSERT INTO editor_routine_runs(routine_id, owner_user_id, status, "trigger", started_at, ended_at, duration_ms, input_tokens, output_tokens, summary, error, files) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)');
        JOURNAL.forEach((r, i) => {
            const jour = new Date(dernier);
            jour.setDate(jour.getDate() - i);
            const t = jour.getTime() / 1000;
            const iso = `${jour.getFullYear()}-${String(jour.getMonth() + 1).padStart(2, '0')}-${String(jour.getDate()).padStart(2, '0')}`;
            ajout.run(routineId, compte, r.statut, 'schedule', t, t + r.ms / 1000, r.ms, r.entree, r.sortie, r.resume || '', r.erreur || null, JSON.stringify(r.rapport ? [`rapports/dependances-${iso}.md`] : []));
        });
    } finally {
        base.close();
    }
}

// Données d'alice remises à plat, puis accueil d'un nouveau chat (un rechargement rouvre sinon la conversation du clip précédent) : conversations professionnelles, routines voulues, journal semé pour la veille, aucune notification ; les créations sont espacées, deux dates égales à la milliseconde rendraient l'ordre des listes incertain.
export async function repartir(plateau, routines = []) {
    const { api, core, page } = plateau;
    viderScript(core);
    await api.req('POST', '/api/saved/chats/clear-all');
    const chats = {};
    for (const c of CONVERSATIONS) {
        const { id } = await api.req('POST', '/api/saved/chats/new', {});
        await api.req('PUT', `/api/saved/chats/${id}/save-messages`, { title: c.titre, messages: [{ role: 'user', content: c.question }, { role: 'assistant', content: c.reponse }] });
        chats[c.titre] = id;
        await attendre(15);
    }
    for (const r of (await api.req('GET', '/api/routines')).items) await api.req('DELETE', `/api/routines/${r.id}`);
    const ids = {};
    for (const d of routines) {
        ids[d.name] = (await api.req('POST', '/api/routines', d)).id;
        await attendre(15);
    }
    if (ids[VEILLE.name]) semerJournal(core, ids[VEILLE.name]);
    await api.req('POST', '/api/notifications/clear');
    await revenirAuDepart(plateau);
    await page.locator('button[title^="Nouveau chat"]:visible').first().click();
    await page.getByText('Comment puis-je vous aider').first().waitFor();
    await page.mouse.move(1276, 796);
    return { routines: ids, chats };
}

// Ouvre la page Routines sur la veille des dépendances et attend son journal ; `reduit` replie ensuite le volet de gauche et attend que la page ait pris sa place.
async function ouvrirRoutines(page, { reduit = false } = {}) {
    await page.locator(ENTREE_ROUTINES).click();
    await page.locator(`${PAGE} button`, { hasText: VEILLE.name }).first().click();
    await page.locator(`${PAGE} h3`, { hasText: VEILLE.name }).waitFor();
    await page.locator(RUN).nth(JOURNAL.length - 1).waitFor();
    if (reduit) {
        await page.locator('button[title="Réduire le panneau"]:visible').click();
        await page.waitForFunction((s) => document.querySelector(s)?.getBoundingClientRect().left < 60, PAGE);
    }
    await page.mouse.move(1276, 796);
    await page.waitForTimeout(400);
}

export default {
    ouvrir: () => ouvrirAvecOutils(),
    clips: [
        {
            nom: 'routines-assistant',
            max: 8,
            async preparer(plateau) {
                const { core, page } = plateau;
                await repartir(plateau);
                core.llm.scripterTitre('Routine des tickets');
                core.llm.scripter({ appels: [{ nom: 'ask_user', args: { questions: QUESTIONS } }] }, 'Deux questions, puis je vous montre le brouillon.');
                await page.locator(ENTREE_ROUTINES).click();
                await page.locator(PAGE, { hasText: 'Aucune routine planifiée.' }).waitFor();
                await page.mouse.move(1276, 796);
                await page.waitForTimeout(400);
            },
            async jouer({ page }, { pause }) {
                await page.locator(`${PAGE} button:has-text("Assistant")`).last().click();
                const objectif = page.locator('textarea[placeholder^="Résumer chaque matin"]');
                await objectif.click();
                await objectif.pressSequentially('Résumer les tickets ouverts chaque lundi', { delay: 20 });
                await pause(300);
                await page.locator('button:has-text("Commencer l\'entretien")').click();
                await page.locator('[data-ask-bloc]:visible').first().waitFor({ timeout: 30000 });
                await page.waitForSelector(EN_COURS, { state: 'detached', timeout: 30000 });
                await pause(400);
                await page.locator('.elpis-ask-opt:visible').first().click();
            },
        },
        {
            nom: 'routines-creer',
            max: 10,
            async preparer(plateau) {
                await repartir(plateau, [ARCHIVAGE, VEILLE]);
                await ouvrirRoutines(plateau.page);
            },
            async jouer({ page }, { pause }) {
                await page.locator(`${PAGE} header button:has-text("Nouvelle")`).click();
                const nom = page.locator(`${PAGE} input[placeholder="Veille quotidienne"]`);
                await nom.click();
                await nom.pressSequentially(TICKETS.name, { delay: 20 });
                await pause(200);
                await page.locator('[data-routine-tabs] button:has-text("Planification")').click();
                const frequence = page.locator(`${PAGE} select:has(option[value="weekly"])`);
                await frequence.hover();
                await pause(250);
                await frequence.selectOption('weekly');
                await pause(300);
                await page.locator(`${PAGE} button:text-is("Jeu")`).click();
                await pause(300);
                await page.locator('[data-routine-tabs] button:has-text("Tâche")').click();
                const tache = page.locator(`${PAGE} textarea[placeholder^="Liste les fichiers"]`);
                await tache.click();
                await tache.pressSequentially('Résume les tickets ouverts, classés par priorité.', { delay: 20 });
                await pause(250);
                await page.locator(`${PAGE} button:has-text("Créer")`).click();
                await page.locator(`${PAGE} h3`, { hasText: TICKETS.name }).waitFor();
            },
        },
        {
            nom: 'routines-suivi',
            cadre: CADRE_VUE,
            async preparer(plateau) {
                await repartir(plateau, [ARCHIVAGE, TICKETS, VEILLE]);
                await ouvrirRoutines(plateau.page, { reduit: true });
            },
            async jouer({ page }, { pause }) {
                const echec = page.locator(`${RUN}[data-run-status="error"]`);
                await echec.hover();
                await pause(300);
                await echec.click();
                await page.locator(`${PAGE} .bg-red-50`).waitFor();
                await pause(400);
                const dernier = page.locator(RUN).first();
                await dernier.hover();
                await pause(300);
                await dernier.click();
                await page.locator(`${PAGE} .markdown-body`).waitFor();
            },
        },
        {
            nom: 'routines-executer',
            cadre: CADRE_VUE,
            max: 9,
            async preparer(plateau) {
                await repartir(plateau, [ARCHIVAGE, TICKETS, VEILLE]);
                plateau.core.llm.scripter({ contenu: 'Rien à signaler : toutes les dépendances sont à jour.', attenteMs: 1600 });
                await ouvrirRoutines(plateau.page, { reduit: true });
            },
            async jouer({ page }, { pause }) {
                const executer = page.locator(`${PAGE} button:has-text("Exécuter")`).first();
                await executer.hover();
                await pause(350);
                await executer.click();
                await page.locator(`${RUN}[data-run-status="running"]`).waitFor({ timeout: 10000 });
                await page.locator(`${RUN}[data-run-status="running"]`).waitFor({ state: 'detached', timeout: 20000 });
                const termine = page.locator(RUN).first();
                await termine.hover();
                await pause(300);
                await termine.click();
                await page.locator(`${PAGE} .markdown-body`).waitFor();
            },
        },
        {
            nom: 'routines-pause',
            max: 6,
            async preparer(plateau) {
                await repartir(plateau, [ARCHIVAGE, TICKETS, VEILLE]);
                await ouvrirRoutines(plateau.page);
            },
            async jouer({ page }, { pause }) {
                const configurer = page.locator(`${PAGE} button:has-text("Configurer")`);
                await configurer.hover();
                await pause(300);
                await configurer.click();
                const active = page.locator(`${PAGE} label:has-text("Active")`);
                await active.hover();
                await pause(300);
                await active.click();
                await pause(300);
                const enregistrer = page.locator(`${PAGE} button:has-text("Enregistrer")`);
                await enregistrer.hover();
                await pause(250);
                await enregistrer.click();
                await page.locator(`${PAGE} h3 + span`, { hasText: 'En pause' }).waitFor();
            },
        },
    ],
};
