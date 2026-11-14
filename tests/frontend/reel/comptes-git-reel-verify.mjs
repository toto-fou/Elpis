// SPDX-License-Identifier: MIT
/** tests/frontend/reel/comptes-git-reel-verify.mjs — comptes git et jetons contre le core TS réel : parties « Jetons MCP » et « Remote » séparées ; partie « Comptes Git » de Paramètres › Secrets (ancien lien compris), portée d'un compte (niveaux proposés, doublon refusé, compte le plus précis), fenêtre « Ajouter un dépôt » de l'éditeur (liste d'un compte ou URL, récapitulatif, compte qui servira, identifiants saisis sur place et leur portée, dépôt neuf initialisé). */
// Recette : ELPIS_NODE_MODULES=…/browser-service/node_modules [ELPIS_CAPTURES=dossier] node tests/frontend/reel/comptes-git-reel-verify.mjs
import fs from 'node:fs';
import path from 'node:path';

import * as bac from '../aides-bac.mjs';
import { demarrerCoreReel, lancerNavigateur, attendreMontage, verifications, contexteConnecte } from '../lib/core-reel.mjs';

const v = verifications('comptes-git-reel');
const core = await demarrerCoreReel();
const nav = await lancerNavigateur();
const CAPTURES = process.env.ELPIS_CAPTURES || '';
const clones = [];
const inits = [];
let refuser = true;

const DEPOTS = [
    { full_name: 'acme/api', clone_url: 'https://github.com/acme/api.git', private: true, description: 'API interne' },
    { full_name: 'acme/site', clone_url: 'https://github.com/acme/site.git', private: false, description: '' },
];

/** Bac et forge simulés au niveau réseau : aucun dépôt local, liste des dépôts d'un compte, clone refusé une fois faute d'accès. */
async function simuler(page) {
    await page.route('**/api/sandbox/**', async (route) => {
        const req = route.request();
        const p = new URL(req.url()).pathname;
        const json = (corps, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(corps) });
        if (p === '/api/sandbox/tree') return json(bac.arbre([]));
        if (p === '/api/sandbox/quota') return json(bac.quota({ used_mb: 1, quota_mb: 5120 }));
        if (p === '/api/sandbox/me') return json(bac.moi());
        if (p === '/api/sandbox/check-mtimes') return json(bac.etats());
        if (p === '/api/sandbox/git/repos') return json({ repos: [] });
        if (p === '/api/sandbox/git/status') return json({ is_repo: false });
        if (p === '/api/sandbox/git/init') {
            inits.push(JSON.parse(req.postData() || '{}'));
            return json({ ok: true, repo: 'mon-projet', message: 'Dépôt initialisé' });
        }
        if (p === '/api/sandbox/git/clone') {
            clones.push(JSON.parse(req.postData() || '{}'));
            // Ce que dit git dans le bac devant un dépôt qui demande des identifiants : il ne peut pas les demander.
            if (refuser) return json({ detail: "fatal: could not read Username for 'https://forge.lan': terminal prompts disabled" }, 400);
            return json({ ok: true, repo: 'outil', message: 'Cloné dans outil/', credentials_saved: true });
        }
        return json({});
    });
    await page.route('**/api/git/connectors/*/repos', (route) =>
        route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, host: 'github.com', repos: DEPOTS }) }));
}

const capture = async (page, nom) => {
    if (!CAPTURES) return;
    fs.mkdirSync(CAPTURES, { recursive: true });
    // Une fenêtre qui s'ouvre encore serait prise à moitié fondue.
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(CAPTURES, `${nom}.png`) });
};

try {
    const ctx = await contexteConnecte(nav, core.urlMain, core.comptes.user);
    const page = await ctx.newPage();
    const erreurs = [];
    page.on('pageerror', (e) => erreurs.push(String(e.message || e)));
    await simuler(page);
    await page.goto(core.urlMain + '/');
    await attendreMontage(page);

    // ── Paramètres › Secrets › Comptes Git
    await page.locator('button[title="Paramètres"]:visible').first().click();
    const dialogue = page.locator('[role="dialog"][aria-label="Paramètres"]');
    await dialogue.waitFor({ timeout: 10000 }).catch(() => {});
    const rail = dialogue.getByRole('navigation', { name: 'Sections des paramètres' });
    v.ok('rail : « Secrets » seul, plus d\'entrée « Comptes Git »',
        (await rail.getByRole('button', { name: 'Secrets', exact: true }).count()) === 1 &&
        (await rail.getByRole('button', { name: 'Comptes Git', exact: true }).count()) === 0);
    await rail.getByRole('button', { name: 'Secrets', exact: true }).click();
    const parties = dialogue.locator('[data-sous-menu] [data-section]');
    v.ok('Secrets : quatre parties, les jetons MCP et Remote séparés',
        JSON.stringify(await parties.evaluateAll((l) => l.map((e) => e.dataset.section))) === '["web","git","jetons","remote"]' &&
        JSON.stringify(await parties.evaluateAll((l) => l.map((e) => e.textContent.trim()))) === '["Secrets web","Comptes Git","Jetons MCP","Remote"]');
    await dialogue.locator('[data-sous-menu] [data-section="git"]').click();
    const git = dialogue.locator('[data-onglet-git]');
    await git.waitFor({ timeout: 10000 }).catch(() => {});
    v.ok('partie Comptes Git affichée, vide, avec la règle des comptes multiples',
        (await git.textContent() || '').includes('Aucun compte Git') && ((await git.locator('[data-regle]').textContent()) || '').includes('le plus précis est pris'));

    const ajouter = async ({ url, niveau, jeton, libelle }) => {
        await git.getByRole('button', { name: 'Ajouter un compte' }).click();
        const champUrl = git.locator('[data-url]');
        await champUrl.fill(url);
        // Les niveaux sont proposés dès la saisie ; le serveur reconnaît ensuite le type et l'API.
        const aussitot = await git.locator('[data-niveau]').count();
        const analyse = page.waitForResponse((r) => r.url().endsWith('/api/git/connectors/parse'), { timeout: 10000 }).catch(() => null);
        await champUrl.blur();
        await analyse;
        const niveaux = await git.locator('[data-niveau] .font-mono').evaluateAll((l) => l.map((e) => e.textContent.trim()));
        if (niveau) await git.locator('[data-niveau]', { has: page.locator('.font-mono', { hasText: new RegExp(`^${niveau.replaceAll('.', '\\.')}$`) }) }).click();
        await git.locator('#git-jeton').fill(jeton);
        if (libelle) await git.locator('#git-nom').fill(libelle);
        const portee = ((await git.locator('[data-niveau][aria-checked="true"] .font-mono').textContent()) || '').trim();
        const libelles = await git.locator('label, #git-portee-lbl').evaluateAll((l) => l.map((e) => e.textContent.trim()));
        const rep = page.waitForResponse((r) => r.url().endsWith('/api/git/connectors') && r.request().method() === 'POST', { timeout: 10000 }).catch(() => null);
        await git.getByRole('button', { name: 'Ajouter', exact: true }).click();
        const r = await rep;
        return { niveaux, portee, aussitot, libelles, statut: r ? r.status() : 0 };
    };

    const hote = await ajouter({ url: 'https://github.com/Acme/API.git', jeton: 'jeton-perso', libelle: 'perso' });
    v.ok('URL collée : trois niveaux proposés aussitôt, tout le serveur par défaut',
        JSON.stringify(hote.niveaux) === '["github.com","github.com/acme","github.com/acme/api"]' && hote.aussitot === 3 && hote.portee === 'github.com' && hote.statut === 200,
        JSON.stringify(hote));
    v.ok('formulaire : des libellés qui disent ce qu\'ils sont',
        JSON.stringify(hote.libelles) === '["URL","Utiliser ce compte pour","Type de serveur","Identifiant","Jeton d\'accès","Nom du compte (facultatif)"]',
        JSON.stringify(hote.libelles));
    await capture(page, '1-comptes-git-liste');
    const org = await ajouter({ url: 'https://github.com/Acme/API.git', niveau: 'github.com/acme', jeton: 'jeton-robot', libelle: 'robot' });
    v.ok('second compte du même hôte, pour l\'organisation', org.portee === 'github.com/acme' && org.statut === 200, JSON.stringify(org));
    const lignes = async () => git.locator('[data-portee-compte]').evaluateAll((l) => l.map((e) => e.textContent.replace(/\s+/g, ' ').trim()));
    await page.waitForFunction(() => document.querySelectorAll('[data-portee-compte]').length === 2, null, { timeout: 10000 }).catch(() => {});
    v.ok('liste : chaque compte avec ce à quoi il s\'applique',
        JSON.stringify(await lignes()) === '["github.com · perso","github.com/acme · robot"]', JSON.stringify(await lignes()));
    const double = await ajouter({ url: 'https://github.com/autre/depot.git', jeton: 'jeton-3' });
    v.ok('même portée une seconde fois : refusée (409)', double.statut === 409, JSON.stringify(double));
    await capture(page, '2-comptes-git-formulaire');
    // URL que le serveur lit autrement que la saisie (organisation seule, hôte avec port sans schéma) : les niveaux et le choix restent ceux de la saisie.
    const relue = async (url, niveau) => {
        const champUrl = git.locator('[data-url]');
        await champUrl.fill(url);
        const analyse = page.waitForResponse((r) => r.url().endsWith('/api/git/connectors/parse'), { timeout: 10000 }).catch(() => null);
        await git.locator('[data-niveau]', { has: page.locator('.font-mono', { hasText: new RegExp(`^${niveau.replaceAll('.', '\\.')}$`) }) }).click();
        await analyse;
        await page.waitForTimeout(150);
        return {
            niveaux: await git.locator('[data-niveau] .font-mono').evaluateAll((l) => l.map((e) => e.textContent.trim())),
            choisi: ((await git.locator('[data-niveau][aria-checked="true"] .font-mono').textContent().catch(() => '')) || '').trim(),
        };
    };
    const organisation = await relue('https://github.com/acme', 'github.com/acme');
    v.ok('URL d\'une organisation : ses deux niveaux restent proposés, le choix de l\'organisation est gardé après l\'analyse',
        JSON.stringify(organisation) === '{"niveaux":["github.com","github.com/acme"],"choisi":"github.com/acme"}', JSON.stringify(organisation));
    const port = await relue('git.exemple.lan:3000/equipe/outil', 'git.exemple.lan:3000/equipe');
    v.ok('hôte avec port, sans schéma : le port reste dans les niveaux et le choix',
        JSON.stringify(port) === '{"niveaux":["git.exemple.lan:3000","git.exemple.lan:3000/equipe","git.exemple.lan:3000/equipe/outil"],"choisi":"git.exemple.lan:3000/equipe"}', JSON.stringify(port));
    await git.getByRole('button', { name: 'Annuler' }).click();

    // Ancien lien : l'identifiant d'onglet « connectors » ouvre la partie.
    await dialogue.locator('[data-sous-menu] [data-section="web"]').click();
    await page.evaluate(() => window.__racine().openSettingsTab('connectors'));
    await git.waitFor({ timeout: 10000 }).catch(() => {});
    v.ok('ancien lien « connectors » : la partie Comptes Git s\'ouvre, comptes chargés', (await git.locator('[data-portee-compte]').count()) === 2);

    // ── Jetons MCP et Remote : chaque partie n'a que les siens.
    const nomsDe = (zone) => zone.locator('[data-jeton] .text-sm').evaluateAll((l) => l.map((e) => e.textContent.replace(/\s+/g, ' ').trim().replace(/ …\S+$/, '')));
    const creer = async (zone, nom) => {
        await zone.locator('[data-nouveau-jeton]').click();
        await zone.locator('[data-nom-jeton]').fill(nom);
        await zone.getByRole('button', { name: 'Créer', exact: true }).click();
        await zone.locator('[data-jeton-montre]').waitFor({ timeout: 10000 }).catch(() => {});
        return ((await zone.locator('[data-jeton-montre]').textContent().catch(() => '')) || '').replace(/\s+/g, ' ');
    };
    await dialogue.locator('[data-sous-menu] [data-section="jetons"]').click();
    const mcp = dialogue.locator('[data-jetons="tools"]');
    await mcp.waitFor({ timeout: 10000 }).catch(() => {});
    const montreMcp = await creer(mcp, 'client de test');
    v.ok('Jetons MCP : formulaire sans choix de type, jeton d\'outils montré une fois',
        (await mcp.locator('select').count()) === 0 && /ept_[A-Za-z0-9_-]{20,}/.test(montreMcp) && JSON.stringify(await nomsDe(mcp)) === '["client de test"]', JSON.stringify(await nomsDe(mcp)));
    await dialogue.locator('[data-sous-menu] [data-section="remote"]').click();
    const remote = dialogue.locator('[data-jetons="opencode"]');
    await remote.waitFor({ timeout: 10000 }).catch(() => {});
    v.ok('Remote : une partie à elle, vide, sans le jeton d\'outils ni les applications autorisées',
        (await remote.textContent() || '').includes('Aucun poste relié.') && !(await remote.textContent() || '').includes('client de test') &&
        !(await remote.textContent() || '').includes('Applications autorisées') && (await mcp.count()) === 0);
    if (await remote.locator('[data-nouveau-jeton]').isDisabled()) {
        v.ok('Remote désactivé sur ce serveur : dit, création fermée', ((await remote.locator('[data-desactive]').textContent()) || '').includes('Remote est désactivé'));
    } else {
        const montreRemote = await creer(remote, 'poste de test');
        v.ok('Remote : jeton de poste montré une fois avec sa commande, listé ici seulement',
            /\/remote pcr_[A-Za-z0-9_-]{20,}/.test(montreRemote) && JSON.stringify(await nomsDe(remote)) === '["poste de test"]', JSON.stringify(await nomsDe(remote)));
        await capture(page, '6-remote');
        await dialogue.locator('[data-sous-menu] [data-section="jetons"]').click();
        await mcp.waitFor({ timeout: 10000 }).catch(() => {});
        const encoreMontre = ((await mcp.locator('[data-jeton-montre]').textContent().catch(() => '')) || '');
        v.ok('Jetons MCP : toujours le seul jeton d\'outils, encore montré ; le jeton Remote n\'y est pas',
            JSON.stringify(await nomsDe(mcp)) === '["client de test"]' && /ept_[A-Za-z0-9_-]{20,}/.test(encoreMontre) && !encoreMontre.includes('pcr_'), JSON.stringify(await nomsDe(mcp)));
    }
    await page.keyboard.press('Escape');
    await dialogue.waitFor({ state: 'hidden', timeout: 10000 }).catch(() => {});

    // ── Fenêtre de clonage de l'éditeur
    await page.locator('button[title*="Sandbox"]:visible').first().click();
    await page.evaluate(() => { const r = window.__racine(); r.gitOpenTab(); r.loadGitConnectors(); });
    // Le nom accessible du bouton porte le glyphe de son icône : il est cherché par son texte.
    await page.locator('[data-ajouter-depot]').click();
    const clone = page.locator('[data-modale-clonage]');
    await clone.waitFor({ timeout: 10000 }).catch(() => {});
    v.ok('un seul bouton « Ajouter un dépôt » : la fenêtre s\'ouvre avec ses trois façons',
        (await clone.isVisible()) &&
        JSON.stringify(await clone.locator('[role=tab]').evaluateAll((l) => l.map((e) => e.textContent.trim()))) === '["Mes dépôts","Depuis une URL","Nouveau dépôt"]');
    await clone.locator('[data-depot]').first().waitFor({ timeout: 10000 }).catch(() => {});
    const texte = async (s) => ((await clone.locator(s).textContent()) || '').replace(/\s+/g, ' ').trim();
    const haut = async () => Math.round((await clone.boundingBox())?.y ?? -1);
    v.ok('« Mes dépôts » d\'abord : un choix de compte libellé, les dépôts listés sans geste, pas de champ d\'URL',
        (await clone.locator('[data-source="depots"]').getAttribute('aria-selected')) === 'true' &&
        (await clone.locator('#clone-compte option').count()) === 2 && (await texte('label[for=clone-compte]')) === 'Compte' && (await clone.locator('[data-depot]').count()) === 2 &&
        (await clone.locator('#clone-url').count()) === 0);
    v.ok('rien de choisi : le récapitulatif le dit, « Cloner » n\'est pas offert',
        (await texte('[data-depot-lu]')) === 'Choisissez un dépôt dans la liste' && (await clone.locator('[data-cloner]').isDisabled()));
    v.ok('fond de la fenêtre sans flou',
        (await clone.evaluate((e) => getComputedStyle(e.parentElement).backdropFilter)) === 'none');
    await clone.locator('[data-depot]').first().click();
    v.ok('dépôt choisi : lu dans le récapitulatif, compte le plus précis annoncé, dossier proposé',
        (await texte('[data-depot-lu]')) === 'acme/api sur github.com' &&
        (await texte('[data-acces]')).includes('Compte github.com/acme · robot (le plus précis pour cette URL)') &&
        (await clone.locator('#clone-dossier').getAttribute('placeholder')) === 'api',
        await texte('[data-acces]'));
    await capture(page, '3-clonage-liste');
    const avant = await haut();
    await clone.locator('[data-source="url"]').click();
    v.ok('onglet « Depuis une URL » : le champ porte l\'URL du dépôt choisi, la fenêtre ne bouge pas',
        (await clone.locator('#clone-url').inputValue()) === 'https://github.com/acme/api.git' &&
        (await clone.locator('[data-mes-depots]').count()) === 0 && (await haut()) === avant,
        `${avant} → ${await haut()}`);
    await clone.locator('#clone-url').fill('git@github.com:acme/api.git');
    v.ok('URL SSH : refusée avec la raison, « Cloner » n\'est pas offert',
        (await texte('[data-aide]')).includes('URL SSH non prise en charge') && (await clone.locator('[data-cloner]').isDisabled()));
    await clone.locator('#clone-url').fill('https://github.com/autre/depot.git');
    v.ok('autre organisation : le compte de tout l\'hôte', (await texte('[data-acces]')).includes('Compte github.com · perso'));
    await capture(page, '3-clonage-url');
    await clone.locator('#clone-url').fill('https://forge.lan/equipe/outil.git');
    v.ok('hôte sans compte : dit, avec la saisie d\'identifiants proposée',
        (await clone.locator('[data-acces]').getAttribute('data-etat')) === 'aucun' && (await clone.locator('[data-saisir]').count()) === 1);
    await clone.locator('[data-cloner]').click();
    await clone.locator('[data-erreur]').waitFor({ timeout: 10000 }).catch(() => {});
    v.ok('clone refusé faute d\'accès : dit en clair, la saisie s\'ouvre sur place',
        ((await clone.locator('[data-erreur]').textContent()) || '').includes('Accès refusé') && (await clone.locator('[data-identifiants]').count()) === 1);
    v.ok('portées proposées pour les identifiants : de l\'hôte au dépôt, tout l\'hôte d\'office',
        JSON.stringify(await clone.locator('#clone-portee option').evaluateAll((l) => l.map((e) => e.textContent.trim()))) === '["forge.lan","forge.lan/equipe","forge.lan/equipe/outil"]' &&
        (await clone.locator('#clone-portee').inputValue()) === '');
    await clone.locator('#clone-identifiant').fill('bob');
    await clone.locator('#clone-jeton').fill('jeton-forge');
    await clone.locator('#clone-portee').selectOption('equipe');
    v.ok('identifiants saisis : la ligne d\'accès le dit à la place du compte',
        ((await clone.locator('[data-acces]').textContent()) || '').replace(/\s+/g, ' ').includes('Identifiants saisis pour forge.lan'));
    await capture(page, '4-clonage-identifiants');
    // Autre hôte : ce qui a été saisi pour forge.lan est oublié, rien ne part vers github.com.
    await clone.locator('[data-source="depots"]').click();
    await clone.locator('[data-depot]').first().click();
    v.ok('changer d\'hôte oublie les identifiants saisis',
        (await clone.locator('[data-identifiants]').count()) === 0 &&
        ((await clone.locator('[data-acces]').textContent()) || '').replace(/\s+/g, ' ').includes('Compte github.com/acme · robot'));
    await clone.locator('[data-source="url"]').click();
    await clone.locator('#clone-url').fill('https://forge.lan/equipe/outil.git');
    await clone.locator('[data-saisir]').click();
    v.ok('la saisie rouverte est vide', (await clone.locator('#clone-jeton').inputValue()) === '' && (await clone.locator('#clone-identifiant').inputValue()) === '');
    await clone.locator('#clone-identifiant').fill('bob');
    await clone.locator('#clone-jeton').fill('jeton-forge');
    await clone.locator('#clone-portee').selectOption('equipe');
    refuser = false;
    await clone.locator('#clone-jeton').press('Enter');
    await clone.waitFor({ state: 'hidden', timeout: 10000 }).catch(() => {});
    const dernier = clones.at(-1) || {};
    v.ok('clone relancé avec les identifiants et la portée choisie ; fenêtre fermée',
        !(await clone.isVisible()) && dernier.cred_user === 'bob' && dernier.cred_token === 'jeton-forge' && dernier.cred_scope === 'equipe' && clones[0].cred_token === undefined,
        JSON.stringify({ ...dernier, cred_token: dernier.cred_token ? '…' : undefined }));
    // Dépôt neuf : même fenêtre, onglet « Nouveau dépôt ».
    await page.locator('[data-ajouter-depot]').click();
    await clone.waitFor({ timeout: 10000 }).catch(() => {});
    await clone.locator('[data-source="nouveau"]').click();
    v.ok('« Nouveau dépôt » : le dossier seulement, l\'attribution des commits annoncée comme automatique, « Initialiser » à la place de « Cloner »',
        (await clone.locator('[data-recap]').count()) === 0 && (await texte('[data-cloner]')) === 'Initialiser' && !(await clone.locator('[data-cloner]').isDisabled()) &&
        (await clone.locator('[data-nouveau] input').count()) === 1 && (await texte('[data-attribution]')).includes('(Elpis agent)'));
    await clone.locator('#init-dossier').fill('mon-projet');
    await capture(page, '5-nouveau-depot');
    await clone.locator('#init-dossier').press('Enter');
    await clone.waitFor({ state: 'hidden', timeout: 10000 }).catch(() => {});
    v.ok('dépôt initialisé dans le dossier saisi, sans identité imposée ; fenêtre fermée',
        !(await clone.isVisible()) && inits.length === 1 && JSON.stringify(inits[0]) === '{"dir":"mon-projet"}', JSON.stringify(inits));
    v.ok('aucune erreur de page', erreurs.length === 0, erreurs.join(' | '));
} finally {
    await nav.close();
    await core.arreter();
}
process.exit(v.bilan());
