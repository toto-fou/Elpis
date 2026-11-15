// SPDX-License-Identifier: MIT
/** tests/frontend/clips/scenes/30-editeur.mjs — clips du bloc « La sandbox et l'éditeur de code » : ouvrir, modifier, ouverture rapide, actions IA, aperçus, Git, ajout d'un dépôt, snapshots ; le bac (conteneur absent de l'instance jetable) est simulé au niveau réseau, simulation reprise par 35-terminal.mjs. */
import crypto from 'node:crypto';
import * as bac from '../../aides-bac.mjs';
import { attendreMontage } from '../../lib/core-reel.mjs';
import { ouvrirPlateau } from '../lib/tournage.mjs';

const CALCUL = `"""Calcul des montants d'une facture."""
from decimal import Decimal

from .modeles import Facture

TAUX_TVA = Decimal("0.20")


def total_ht(facture: Facture) -> Decimal:
    """Somme hors taxes des lignes de la facture."""
    lignes = (l.quantite * l.prix_unitaire for l in facture.lignes)
    return sum(lignes, Decimal("0"))


def montant_tva(facture: Facture, taux: Decimal = TAUX_TVA) -> Decimal:
    return (total_ht(facture) * taux).quantize(Decimal("0.01"))


def total_ttc(facture: Facture, taux: Decimal = TAUX_TVA) -> Decimal:
    return total_ht(facture) + montant_tva(facture, taux)
`;

const REMISE = `def appliquer_remise(montant: Decimal, pourcentage: Decimal) -> Decimal:
    """Montant après remise, arrondi au centime."""
    reste = Decimal("100") - pourcentage
    return (montant * reste / Decimal("100")).quantize(Decimal("0.01"))


`;
const MODELES = `"""Modèles de données de la facturation."""
from dataclasses import dataclass, field
from datetime import date
from decimal import Decimal


@dataclass
class Ligne:
    libelle: str
    quantite: Decimal
    prix_unitaire: Decimal


@dataclass
class Facture:
    numero: str
    client: str
    emise_le: date
    lignes: list[Ligne] = field(default_factory=list)
`;

const EXPORT = `"""Export des factures au format CSV."""
import csv
from pathlib import Path

from .calcul import total_ht, total_ttc
from .modeles import Facture

COLONNES = ["numero", "client", "emise_le", "total_ht", "total_ttc"]


def exporter(factures: list[Facture], destination: Path) -> int:
    """Écrit une ligne par facture et rend le nombre de lignes écrites."""
    with destination.open("w", newline="", encoding="utf-8") as sortie:
        ecrivain = csv.writer(sortie, delimiter=";")
        ecrivain.writerow(COLONNES)
        for f in factures:
            ecrivain.writerow([f.numero, f.client, f.emise_le, total_ht(f), total_ttc(f)])
    return len(factures)
`;

const TESTS = `from datetime import date
from decimal import Decimal

from src.calcul import montant_tva, total_ht, total_ttc
from src.modeles import Facture, Ligne


def facture_exemple() -> Facture:
    lignes = [
        Ligne("Audit comptable", Decimal("2"), Decimal("450.00")),
        Ligne("Formation", Decimal("1"), Decimal("300.00")),
    ]
    return Facture("F-2026-041", "Atelier Dumont", date(2026, 11, 3), lignes)


def test_total_ht():
    assert total_ht(facture_exemple()) == Decimal("1200.00")


def test_montant_tva():
    assert montant_tva(facture_exemple()) == Decimal("240.00")


def test_total_ttc():
    assert total_ttc(facture_exemple()) == Decimal("1440.00")
`;

const LISEZMOI = `# Facturation

Service de calcul et d'export des factures de l'atelier.

## Installation

\`\`\`bash
pip install -e .
pytest -q
\`\`\`

## Modules

| Module | Rôle |
|---|---|
| \`src/calcul.py\` | Totaux HT, TVA et TTC |
| \`src/modeles.py\` | Factures et lignes |
| \`src/export.py\` | Export CSV pour la comptabilité |

## Règles de calcul

- La TVA est à **20 %** par défaut.
- Les montants sont arrondis au centime.
`;

const PROJET_TOML = `[project]
name = "facturation"
version = "1.4.0"
description = "Calcul et export des factures"
requires-python = ">=3.11"

[tool.pytest.ini_options]
testpaths = ["tests"]
`;

const PAGE = `<!doctype html>
<html lang="fr">
<head>
  <meta charset="utf-8">
  <title>Factures de novembre</title>
  <link rel="stylesheet" href="style.css">
</head>
<body>
  <h1>Factures de novembre</h1>
  <table>
    <tr><th>Numéro</th><th>Client</th><th>Total TTC</th></tr>
    <tr><td>F-2026-041</td><td>Atelier Dumont</td><td>1 440,00 €</td></tr>
    <tr><td>F-2026-042</td><td>Librairie du Port</td><td>864,00 €</td></tr>
    <tr><td>F-2026-043</td><td>Cabinet Morel</td><td>2 310,00 €</td></tr>
  </table>
  <p class="total">Total du mois : 4 614,00 €</p>
</body>
</html>
`;

const STYLE = `body { font-family: system-ui, sans-serif; margin: 2rem; color: #1f2933; }
h1 { font-size: 1.5rem; }
table { border-collapse: collapse; width: 100%; }
th, td { text-align: left; padding: 0.5rem 0.75rem; border-bottom: 1px solid #d9e2ec; }
th { background: #f0f4f8; }
.total { margin-top: 1rem; font-weight: 600; }
`;

/** Version de travail : la remise ajoutée avant le calcul de la TVA. */
const CALCUL_MODIFIE = CALCUL.replace('def montant_tva', REMISE + 'def montant_tva');
const DIFF_INDEXE = `diff --git a/src/calcul.py b/src/calcul.py
--- a/src/calcul.py
+++ b/src/calcul.py
@@ -12,6 +12,12 @@ def total_ht(facture: Facture) -> Decimal:
${REMISE.trimEnd().split('\n').map((l) => '+' + l).join('\n')}
diff --git a/src/export.py b/src/export.py
new file mode 100644
--- /dev/null
+++ b/src/export.py
${EXPORT.trimEnd().split('\n').map((l) => '+' + l).join('\n')}
`;

/** Projet du bac au dernier commit : un service Python de facturation, cloné dans son dossier. */
const DEPOT = 'facturation';
const TETE = {
    'README.md': LISEZMOI,
    'pyproject.toml': PROJET_TOML,
    'src/calcul.py': CALCUL,
    'src/modeles.py': MODELES,
    'tests/test_calcul.py': TESTS,
    'web/index.html': PAGE,
    'web/style.css': STYLE,
};
const MIME = { html: 'text/html; charset=utf-8', css: 'text/css; charset=utf-8', js: 'text/javascript; charset=utf-8' };
const INVITE = '\x1b[1;32melpis@sandbox\x1b[0m:\x1b[1;34m~/facturation\x1b[0m$ ';
const SORTIES = {
    pytest: [
        '\x1b[1m============================= test session starts ==============================\x1b[0m',
        'platform linux -- Python 3.12.3, pytest-8.3.2, pluggy-1.5.0',
        'rootdir: /work/facturation',
        'configfile: pyproject.toml',
        'testpaths: tests',
        '\x1b[1mcollected 3 items\x1b[0m',
        '',
        'tests/test_calcul.py \x1b[32m...                                                 [100%]\x1b[0m',
        '',
        '\x1b[32m============================== \x1b[1m3 passed\x1b[0m\x1b[32m in 0.08s ===============================\x1b[0m',
        '',
    ].join('\r\n'),
    ls: 'README.md  pyproject.toml  \x1b[1;34msrc\x1b[0m  \x1b[1;34mtests\x1b[0m  \x1b[1;34mweb\x1b[0m\r\n',
};
const DEPOTS_FORGE = [
    { full_name: 'compta/facturation', clone_url: 'https://forge.atelier.lan/compta/facturation.git', private: true, description: 'Calcul et export des factures' },
    { full_name: 'compta/rapports-mensuels', clone_url: 'https://forge.atelier.lan/compta/rapports-mensuels.git', private: true, description: 'Rapports de clôture' },
    { full_name: 'compta/outils-internes', clone_url: 'https://forge.atelier.lan/compta/outils-internes.git', private: false, description: 'Scripts partagés' },
];

const sha = (texte) => crypto.createHash('sha256').update(texte, 'utf8').digest('hex');

// Lignes ajoutées et retirées entre deux textes (multiensembles de lignes), pour les compteurs de la vue Git.
function ecart(avant, apres) {
    const reste = new Map();
    for (const l of avant.split('\n')) reste.set(l, (reste.get(l) || 0) + 1);
    let add = 0;
    for (const l of apres.split('\n')) {
        if (reste.get(l)) reste.set(l, reste.get(l) - 1);
        else add += 1;
    }
    return { add, del: [...reste.values()].reduce((s, n) => s + n, 0) };
}

// Arbre du bac à partir des chemins de fichiers, dossiers d'abord.
function arbre(chemins) {
    const racine = [];
    const dossiers = new Map();
    const enfants = (d) => {
        if (!d) return racine;
        if (!dossiers.has(d)) {
            const noeud = { name: d.split('/').pop(), path: d, type: 'folder', children: [] };
            enfants(d.includes('/') ? d.slice(0, d.lastIndexOf('/')) : '').push(noeud);
            dossiers.set(d, noeud);
        }
        return dossiers.get(d).children;
    };
    for (const p of [...chemins].sort()) enfants(p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '').push({ name: p.split('/').pop(), path: p, type: 'file' });
    const trier = (noeuds) => {
        noeuds.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'folder' ? -1 : 1));
        for (const n of noeuds) if (n.children) trier(n.children);
    };
    trier(racine);
    return racine;
}

/** Bac simulé au niveau réseau : fichiers, Git, snapshots, aperçu, complétion et terminal d'un compte, avec un état remis à neuf par clip. */
export async function simulerBac(page) {
    const e = { fichiers: {}, tete: {}, indexes: new Set(), depots: [], snapshots: [], horloge: 0, sessions: [], infill: '' };
    const dans = (rel) => `${DEPOT}/${rel}`;
    const reinitialiser = ({ travail = false, depot = true, snapshots = [] } = {}) => {
        e.tete = depot ? { ...TETE } : {};
        e.fichiers = Object.fromEntries(Object.entries(TETE).map(([p, c]) => [dans(p), c]));
        if (!depot) e.fichiers = { 'notes.md': '# Notes\n\n- Reprendre le dépôt de facturation\n' };
        if (travail) {
            e.fichiers[dans('src/calcul.py')] = CALCUL_MODIFIE;
            e.fichiers[dans('src/export.py')] = EXPORT;
        }
        e.indexes = new Set();
        e.depots = depot ? [{ path: DEPOT, name: DEPOT, branch: 'main' }] : [];
        e.snapshots = snapshots.map((s) => ({ duration_sec: 0.4, file_count: 7, src_bytes: 5200, archive_bytes: 2300, ...s }));
        e.horloge = 1_700_000_000;
        e.sessions = [];
        e.infill = '';
    };
    reinitialiser();

    // État Git du dépôt : comparaison des fichiers du bac avec le dernier commit.
    const statut = () => {
        const staged = [];
        const modified = [];
        const untracked = [];
        for (const [chemin, contenu] of Object.entries(e.fichiers)) {
            if (!chemin.startsWith(DEPOT + '/')) continue;
            const rel = chemin.slice(DEPOT.length + 1);
            const avant = e.tete[rel];
            if (avant === contenu) continue;
            const fiche = avant === undefined ? { path: rel, status: 'A', ...ecart('', contenu) } : { path: rel, status: 'M', ...ecart(avant, contenu) };
            if (e.indexes.has(rel)) staged.push(fiche);
            else if (avant === undefined) untracked.push({ path: rel });
            else modified.push(fiche);
        }
        return { is_repo: true, repo: DEPOT, branch: 'main', ahead: 0, behind: 0, remote_url: 'https://forge.atelier.lan/compta/facturation.git', staged, modified, untracked, conflicted: [], truncated: false };
    };

    // Flux NDJSON d'un snapshot ou d'une restauration, livré d'un bloc.
    const flux = (route, phase, fin) => {
        const n = Object.keys(e.fichiers).length;
        const lignes = [
            { event: 'preparing', phase },
            { event: 'start', phase, total_files: n, total_bytes: 5200 },
            { event: 'progress', phase: phase === 'snapshot' ? 'snapshot' : 'extract', files_done: n, total_files: n, bytes_done: 5200, total_bytes: 5200, pct: 100, current_file: dans('web/style.css') },
            { event: 'done', phase, ...fin },
        ];
        return route.fulfill({ status: 200, contentType: 'application/x-ndjson', body: lignes.map((l) => JSON.stringify(l)).join('\n') + '\n' });
    };

    await page.route('**/api/sandbox/**', async (route) => {
        const req = route.request();
        const url = new URL(req.url());
        const p = url.pathname.slice('/api/sandbox/'.length);
        const json = (corps, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(corps) });
        const corps = () => JSON.parse(req.postData() || '{}');
        if (p === 'tree') return json(bac.arbre(arbre(Object.keys(e.fichiers))));
        if (p === 'download') {
            const chemin = url.searchParams.get('path') || '';
            if (!(chemin in e.fichiers)) return json({ detail: 'Fichier introuvable' }, 404);
            return route.fulfill({ status: 200, contentType: 'text/plain; charset=utf-8', headers: { 'X-Mtime': String(e.horloge), 'X-Sha256': sha(e.fichiers[chemin]) }, body: e.fichiers[chemin] });
        }
        if (p === 'save') {
            const c = corps();
            e.fichiers[c.path] = c.content;
            e.horloge += 5;
            return json(bac.sauvegarde({ size: Buffer.byteLength(c.content), mtime: e.horloge, sha256: sha(c.content) }));
        }
        if (p === 'quota') return json(bac.quota({ used_mb: 312, quota_mb: 5120, pct: 6, used_bytes: 327_155_712, quota_bytes: 5_368_709_120, remaining_bytes: 5_041_553_408 }));
        if (p === 'me') return json(req.method() === 'POST' ? bac.choix() : bac.moi());
        if (p === 'check-mtimes') return json(bac.etats());
        if (p === 'lint') return json({ diagnostics: [] });
        if (p === 'preview-token') return json({ token: 'apercu', expires: 9_999_999_999 });
        if (p.startsWith('pv/')) {
            const chemin = decodeURIComponent(p.split('/').slice(2).join('/'));
            if (!(chemin in e.fichiers)) return route.fulfill({ status: 404, contentType: 'text/plain', body: 'introuvable' });
            return route.fulfill({ status: 200, contentType: MIME[chemin.split('.').pop()] || 'text/plain; charset=utf-8', body: e.fichiers[chemin] });
        }
        if (p === 'snapshots') return json({ items: e.snapshots, max: 10, last_restore_incomplete: null });
        if (p === 'snapshots/create') {
            const cliche = { id: `s${e.snapshots.length + 1}`, name: corps().name || 'Snapshot', ts: Math.floor(Date.now() / 1000), duration_sec: 0.4, file_count: Object.keys(e.fichiers).length, src_bytes: 5200, archive_bytes: 2300 };
            e.snapshots = [cliche, ...e.snapshots];
            return flux(route, 'snapshot', { snapshot: cliche });
        }
        if (/^snapshots\/[^/]+\/restore$/.test(p)) {
            e.fichiers = Object.fromEntries(Object.entries(TETE).map(([c, t]) => [dans(c), t]));
            e.indexes = new Set();
            return flux(route, 'restore', { files_restored: Object.keys(e.fichiers).length, bytes_restored: 5200, conflicts: 0 });
        }
        if (p === 'git/repos') return json({ repos: e.depots });
        if (p === 'git/status') return json(e.depots.length ? statut() : { is_repo: false });
        if (p === 'git/branches') return json({ current: 'main', local: ['main', 'agent/export-csv'], remote: ['origin/main'] });
        if (p === 'git/tree') return json({ items: arbre(Object.keys(e.tete)), truncated: false });
        if (p === 'git/log') return json({ commits: [] });
        if (p === 'git/show-file') {
            const rel = url.searchParams.get('path') || '';
            return rel in e.tete ? json({ content: e.tete[rel] }) : json({ detail: 'Absent du dernier commit' }, 404);
        }
        if (p === 'git/stage') {
            const voulus = corps().paths || [];
            const s = statut();
            for (const f of [...s.modified, ...s.untracked]) if (!voulus.length || voulus.includes(f.path)) e.indexes.add(f.path);
            return json({ ok: true, message: '' });
        }
        if (p === 'git/unstage') {
            const voulus = corps().paths || [];
            for (const rel of [...e.indexes]) if (!voulus.length || voulus.includes(rel)) e.indexes.delete(rel);
            return json({ ok: true, message: '' });
        }
        if (p === 'git/commit') {
            for (const rel of e.indexes) e.tete[rel] = e.fichiers[dans(rel)];
            e.indexes = new Set();
            return json({ ok: true, message: '[main 4f2a91c] ' + corps().message });
        }
        if (p === 'git/diff') return json({ diff: e.indexes.size ? DIFF_INDEXE : '', truncated: false });
        if (p === 'git/clone') {
            e.tete = { ...TETE };
            for (const [rel, texte] of Object.entries(TETE)) e.fichiers[dans(rel)] = texte;
            e.depots = [{ path: DEPOT, name: DEPOT, branch: 'main' }];
            return json({ ok: true, repo: DEPOT, message: `Cloné dans ${DEPOT}/`, credentials_saved: false });
        }
        if (p === 'git/init') return json({ ok: true, repo: corps().dir || '.', message: 'Dépôt initialisé' });
        return json({});
    });
    // Complétion du moteur : la réponse préparée par le clip, après le temps d'une génération courte.
    await page.route('**/api/llm/infill', async (route) => {
        await attendre(700);
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, content: e.infill }) });
    });
    await page.route('**/api/git/connectors/*/repos', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, host: 'forge.atelier.lan', repos: DEPOTS_FORGE }) }));

    // Sessions de terminal du compte : liste, création, renommage, fermeture.
    await page.route('**/api/terminal/**', async (route) => {
        const req = route.request();
        const p = new URL(req.url()).pathname;
        const json = (corps, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(corps) });
        const m = /^\/api\/terminal\/sessions\/([^/]+)$/.exec(p);
        if (p === '/api/terminal/sessions' && req.method() === 'GET') return json({ sessions: e.sessions, max: 4 });
        if (p === '/api/terminal/sessions') {
            const n = e.sessions.length + 1;
            const session = { id: `t${n}`, uid: 2, tid: null, name: `Terminal ${n}`, created_at: Date.now() / 1000, last_connected_at: Date.now() / 1000 };
            e.sessions.push(session);
            return json({ ok: true, session, max: 4 });
        }
        if (m && req.method() === 'DELETE') e.sessions = e.sessions.filter((s) => s.id !== m[1]);
        if (m && req.method() === 'PATCH') for (const s of e.sessions) if (s.id === m[1]) s.name = JSON.parse(req.postData() || '{}').name || s.name;
        return json({ ok: true });
    });
    // Shell d'une session : invite, écho des frappes, sortie des commandes connues.
    await page.routeWebSocket(/\/ws\/terminal\//, (ws) => {
        let saisie = '';
        const ecrire = (texte) => ws.send(Buffer.from(texte, 'utf8'));
        ws.send(JSON.stringify({ type: 'hello', fresh_shell: true }));
        ecrire(INVITE);
        ws.onMessage((message) => {
            if (typeof message === 'string') return;
            for (const c of message.toString('utf8')) {
                if (c === '\r') {
                    const commande = saisie.trim();
                    ecrire('\r\n' + (SORTIES[commande] ?? (commande ? `bash: ${commande.split(' ')[0]}: commande introuvable\r\n` : '')) + INVITE);
                    saisie = '';
                } else if (c === '\x7f') {
                    if (saisie) { saisie = saisie.slice(0, -1); ecrire('\b \b'); }
                } else if (c >= ' ') {
                    saisie += c;
                    ecrire(c);
                }
            }
        });
    });
    return { etat: e, reinitialiser };
}

const SANDBOX = 'button[title="Sandbox"]:visible';
/** Éditeur de 960 px dans la page de 1280 (barre latérale repliée) : le cadre du haut le montre net, au pixel près. */
const RATIO_LARGE = (960 / 1232) * 100;
export const CADRE_HAUT = [320, 0, 960, 600];
const attendre = (ms) => new Promise((r) => setTimeout(r, ms));
const element = (page, nom) => page.locator(`[role="treeitem"][aria-label="${nom}"]`).first();
const ligne = (page, texte) => page.locator('#monaco-editor .view-line', { hasText: texte }).first();
const menuPlus = (page) => page.locator('[data-editor-root] .elpis-ed-barre button[aria-label="Plus d\'actions"]');
const entree = (page, libelle) => page.locator(`[data-editor-root] .ed2-menu__item:has(.ed2-menu__libelle:text-is("${libelle}"))`);

// Point d'une ligne de code : abscisse en pixels depuis le début du texte, à mi-hauteur.
const abscisse = (x) => ({ position: { x, y: 11 } });

// Attend que Monaco affiche `texte` dans l'éditeur principal.
export async function attendreCode(page, texte) {
    await page.waitForFunction((t) => (document.querySelector('#monaco-editor .view-lines')?.textContent || '').replace(/\u00a0/g, ' ').includes(t), texte, { timeout: 15000 });
}

/** Remet le bac et le navigateur à neuf (réglages du compte, mémoire locale de l'éditeur) puis recharge la page ; la mémoire se vide depuis une page neutre de la même origine, car la page l'écrit en partant. */
export async function preparerBac(plateau, { reglages = {}, ...etat } = {}) {
    const { page, api, core } = plateau;
    plateau.bac.reinitialiser(etat);
    await api.req('PUT', '/api/settings', { editor_ratio: 50, enable_preview: false, ...reglages });
    await page.goto(core.urlMain + '/api/public-config');
    await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
    await page.goto(core.urlMain + plateau.chemin);
    await attendreMontage(page);
}

// Déplie dans l'arbre les dossiers d'un chemin du bac.
export async function deplier(page, dossiers) {
    for (const dossier of dossiers.split('/')) {
        const rangee = element(page, `Dossier ${dossier}`);
        await rangee.waitFor({ timeout: 15000 });
        if ((await rangee.getAttribute('aria-expanded')) !== 'true') await rangee.click();
    }
}

// Déplie les dossiers d'un chemin du bac puis ouvre le fichier dans un onglet.
export async function ouvrirFichier(page, chemin, texte) {
    const parties = chemin.split('/');
    await deplier(page, parties.slice(0, -1).join('/'));
    await element(page, `Fichier ${parties.at(-1)}`).click();
    await page.locator(`[role="tab"][data-path="${chemin}"][aria-selected="true"]`).waitFor({ timeout: 15000 });
    if (texte) await attendreCode(page, texte);
}

/** Ouvre l'éditeur en grand (960 px, barre latérale repliée) sur un bac remis à neuf, avec les fichiers demandés en onglets. */
export async function ouvrirEditeur(plateau, { fichiers = [], reglages = {}, ...etat } = {}) {
    const { page } = plateau;
    await preparerBac(plateau, { ...etat, reglages: { editor_ratio: RATIO_LARGE, ...reglages } });
    await page.locator(SANDBOX).first().click();
    await page.locator('button[title="Réduire le panneau"]:visible').first().click();
    await page.waitForFunction(() => {
        const r = document.querySelector('[data-editor-root]')?.getBoundingClientRect();
        return !!r && Math.round(r.x) === 320 && Math.round(r.width) === 960;
    }, null, { timeout: 15000 });
    await page.locator('.elpis-ed-explorateur').first().waitFor({ timeout: 15000 });
    for (const [chemin, texte] of fichiers) await ouvrirFichier(page, chemin, texte);
    await reposer(page);
}

// Pointeur hors du cadre et interface au repos avant le tournage.
export async function reposer(page) {
    await page.mouse.move(1276, 796);
    await attendre(500);
}

const CALCUL_PY = [`${DEPOT}/src/calcul.py`, 'TAUX_TVA'];
const VUE_GIT = '.elpis-ed-vues button[aria-label^="Git"]';
const MODIFIE = '.elpis-ed-explorateur [title="src/calcul.py — voir le diff"]';
const NON_ENREGISTRE = '[role="tab"] [title="Modifications non sauvegardées"]';
const PAGE_HTML = [`${DEPOT}/web/index.html`, 'Factures de novembre'];

// Replie l'explorateur : le code, l'aperçu ou le terminal prennent toute la largeur de l'éditeur.
export async function replierExplorateur(page) {
    await page.locator('button[aria-label="Basculer l\'explorateur de fichiers"]').click();
    await page.locator('.elpis-ed-explorateur').first().waitFor({ state: 'hidden' });
    await reposer(page);
}

export default {
    async ouvrir() {
        const plateau = await ouvrirPlateau();
        plateau.page.setDefaultTimeout(15000);
        plateau.bac = await simulerBac(plateau.page);
        await plateau.api.req('POST', '/api/git/connectors', { provider_type: 'gitea', host: 'forge.atelier.lan', token: 'jeton-de-la-forge', label: 'alice', username: 'alice' });
        return plateau;
    },
    clips: [
        {
            nom: 'editeur-ouvrir',
            max: 7,
            async preparer(plateau) {
                const { page } = plateau;
                await preparerBac(plateau);
                // Le dossier du projet reste déplié d'une visite à l'autre : on le déplie, puis on referme l'éditeur.
                await page.locator(SANDBOX).first().click();
                await deplier(page, DEPOT);
                await element(page, 'Dossier src').waitFor();
                await page.locator('button[title="Sandbox — ouvert"]:visible').first().click();
                await page.locator('[data-editor-root]').waitFor({ state: 'hidden' });
                await reposer(page);
            },
            async jouer({ page }, { pause }) {
                await pause(300);
                await page.locator(SANDBOX).first().click();
                await element(page, 'Dossier src').waitFor();
                await pause(400);
                await element(page, 'Dossier src').click();
                await pause(300);
                await element(page, 'Fichier calcul.py').click();
                await attendreCode(page, 'TAUX_TVA');
                await page.locator('.elpis-ed-explorateur').first().waitFor({ state: 'hidden' });
                await pause(250);
            },
        },
        {
            nom: 'editeur-modifier',
            cadre: CADRE_HAUT,
            max: 7,
            async preparer(plateau) {
                await ouvrirEditeur(plateau, { fichiers: [CALCUL_PY] });
            },
            async jouer({ page }, { pause }) {
                await pause(300);
                await ligne(page, 'TAUX_TVA = Decimal').click(abscisse(420));
                await page.keyboard.press('Enter');
                await page.keyboard.type('TAUX_REDUIT = Decimal("0.055")', { delay: 20 });
                await page.locator(NON_ENREGISTRE).waitFor();
                await pause(400);
                await menuPlus(page).click();
                await entree(page, 'Enregistrer').waitFor();
                await pause(300);
                await entree(page, 'Enregistrer').click();
                await page.locator(NON_ENREGISTRE).waitFor({ state: 'detached' });
                await pause(250);
            },
        },
        {
            nom: 'editeur-ouverture-rapide',
            cadre: CADRE_HAUT,
            max: 5,
            async preparer(plateau) {
                await ouvrirEditeur(plateau, { fichiers: [CALCUL_PY] });
            },
            async jouer({ page }, { pause }) {
                await pause(300);
                await page.keyboard.press('Control+p');
                const champ = page.locator('#elpis-quickopen-input');
                await champ.waitFor();
                await pause(400);
                await champ.pressSequentially('test', { delay: 80 });
                const trouve = page.locator('.cursor-pointer:has-text("test_calcul.py"):visible').first();
                await trouve.waitFor();
                await pause(300);
                await trouve.click();
                await attendreCode(page, 'facture_exemple');
                await pause(250);
            },
        },
        {
            nom: 'editeur-ia',
            max: 8,
            async preparer(plateau) {
                await ouvrirEditeur(plateau, { fichiers: [CALCUL_PY] });
                plateau.bac.etat.infill = 'Calcule la TVA due sur le total hors taxes de la facture,\narrondie au centime.';
            },
            async jouer({ page }, { pause }) {
                const fin = ligne(page, 'return (total_ht(facture) * taux)');
                const proposition = page.locator('.elpis-editor-banner--ai');
                await pause(300);
                await ligne(page, 'def montant_tva').click(abscisse(2));
                await fin.click({ ...abscisse(560), modifiers: ['Shift'] });
                await pause(400);
                await fin.click({ ...abscisse(260), button: 'right' });
                const expliquer = page.locator('.elpis-ed-menu-code button:has-text("Expliquer ce code")');
                await expliquer.waitFor();
                await pause(300);
                await expliquer.click();
                await proposition.waitFor();
                await pause(400);
                await proposition.locator('.elpis-banner-btn--primary').click();
                await proposition.waitFor({ state: 'detached' });
                await attendreCode(page, 'EXPLICATION');
                await pause(400);
            },
        },
        {
            nom: 'editeur-apercu',
            cadre: CADRE_HAUT,
            max: 9,
            async preparer(plateau) {
                await ouvrirEditeur(plateau, { reglages: { enable_preview: true }, fichiers: [PAGE_HTML] });
                await replierExplorateur(plateau.page);
            },
            async jouer({ page }, { pause }) {
                const rendu = page.frameLocator('iframe[title="Aperçu de la page"]');
                await pause(300);
                await menuPlus(page).click();
                await entree(page, 'Aperçu à côté').waitFor();
                await pause(300);
                await entree(page, 'Aperçu à côté').click();
                await rendu.locator('h1').waitFor();
                await pause(400);
                await page.locator('[data-editor-root] button[aria-pressed]:has-text("Live"):visible').click();
                await ligne(page, '<h1>Factures de novembre</h1>').click(abscisse(300));
                for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowLeft');
                await page.keyboard.type(' 2026', { delay: 60 });
                await rendu.locator('h1:has-text("2026")').waitFor();
                await pause(250);
            },
        },
        {
            nom: 'editeur-apercu-markdown',
            cadre: CADRE_HAUT,
            max: 5,
            async preparer(plateau) {
                await ouvrirEditeur(plateau, { fichiers: [[`${DEPOT}/README.md`, 'Facturation']] });
                await replierExplorateur(plateau.page);
            },
            async jouer({ page }, { pause }) {
                await pause(300);
                await menuPlus(page).click();
                await entree(page, 'Aperçu Markdown').waitFor();
                await pause(300);
                await entree(page, 'Aperçu Markdown').click();
                await page.locator('[data-editor-root] .markdown-body h1').waitFor();
                await pause(250);
            },
        },
        {
            nom: 'editeur-git',
            cadre: CADRE_HAUT,
            max: 5,
            async preparer(plateau) {
                await ouvrirEditeur(plateau, { travail: true });
                await deplier(plateau.page, `${DEPOT}/src`);
                await element(plateau.page, 'Fichier export.py').waitFor();
                await reposer(plateau.page);
            },
            async jouer({ page }, { pause }) {
                await pause(300);
                await page.locator(VUE_GIT).click();
                await page.locator(MODIFIE).waitFor();
                await pause(400);
                await page.locator(MODIFIE).click();
                await page.waitForFunction(() => (document.querySelector('#monaco-diff-editor.active .modified .view-lines')?.textContent || '').includes('appliquer_remise'), null, { timeout: 15000 });
                await pause(300);
            },
        },
        {
            nom: 'editeur-git-commit',
            cadre: CADRE_HAUT,
            max: 7,
            async preparer(plateau) {
                const { page } = plateau;
                await ouvrirEditeur(plateau, { travail: true, fichiers: [CALCUL_PY] });
                plateau.bac.etat.infill = 'Ajoute la remise et l\'export CSV';
                await page.locator(VUE_GIT).click();
                await page.locator(MODIFIE).waitFor();
                await reposer(page);
            },
            async jouer({ page }, { pause }) {
                const git = page.locator('.elpis-ed-explorateur');
                await pause(300);
                await git.locator('button:text-is("Tout indexer")').click();
                await git.locator('text=Indexés').waitFor();
                await pause(300);
                await git.locator('button[aria-label="Proposer un message de commit"]').click();
                await page.waitForFunction(() => !!document.querySelector('.elpis-ed-explorateur textarea')?.value, null, { timeout: 15000 });
                await pause(400);
                await git.locator('button:has-text("Commit (2)")').click();
                await git.locator('text=Aucune modification').waitFor();
                await pause(250);
            },
        },
        {
            nom: 'editeur-depot',
            max: 7,
            async preparer(plateau) {
                const { page } = plateau;
                await ouvrirEditeur(plateau, { depot: false });
                await page.locator(VUE_GIT).click();
                await page.locator('[data-ajouter-depot]').waitFor();
                await reposer(page);
            },
            async jouer({ page }, { pause }) {
                const fenetre = page.locator('[data-modale-clonage]');
                await pause(300);
                await page.locator('[data-ajouter-depot]').click();
                await fenetre.locator('[data-depot]').first().waitFor();
                await pause(400);
                await fenetre.locator('[data-depot]').first().click();
                await fenetre.locator('[data-depot-lu][data-etat="lue"]').waitFor();
                await pause(400);
                await fenetre.locator('[data-cloner]').click();
                await fenetre.waitFor({ state: 'hidden' });
                await page.locator('.elpis-ed-explorateur >> text=Aucune modification').waitFor();
                await pause(400);
            },
        },
        {
            nom: 'editeur-snapshots',
            cadre: CADRE_HAUT,
            max: 7,
            async preparer(plateau) {
                await ouvrirEditeur(plateau, { snapshots: [{ id: 's1', name: 'Avant refonte des exports', ts: Math.floor(Date.now() / 1000) - 3 * 86400 - 5400 }] });
                await deplier(plateau.page, `${DEPOT}/src`);
                await element(plateau.page, 'Fichier calcul.py').waitFor();
                await reposer(plateau.page);
            },
            async jouer({ page }, { pause }) {
                const panneau = page.locator('.elpis-ed-instantanes');
                await pause(300);
                await menuPlus(page).click();
                await entree(page, 'Snapshots').waitFor();
                await pause(300);
                await entree(page, 'Snapshots').click();
                await panneau.locator('text=Avant refonte des exports').waitFor();
                await pause(300);
                await panneau.locator('input').click();
                await panneau.locator('input').pressSequentially('Avant mise à jour', { delay: 20 });
                await pause(300);
                await panneau.locator('button:has-text("Créer une snapshot")').click();
                await panneau.locator('text=Avant mise à jour').waitFor();
                await pause(250);
            },
        },
        {
            nom: 'editeur-snapshot-restaurer',
            cadre: CADRE_HAUT,
            max: 6,
            async preparer(plateau) {
                const { page } = plateau;
                const maintenant = Math.floor(Date.now() / 1000);
                await ouvrirEditeur(plateau, {
                    travail: true,
                    snapshots: [{ id: 's2', name: 'Avant mise à jour', ts: maintenant - 7200 }, { id: 's1', name: 'Avant refonte des exports', ts: maintenant - 3 * 86400 - 5400 }],
                });
                await deplier(page, `${DEPOT}/src`);
                await element(page, 'Fichier export.py').waitFor();
                await menuPlus(page).click();
                await entree(page, 'Snapshots').click();
                await page.locator('.elpis-ed-instantanes >> text=Avant mise à jour').waitFor();
                await reposer(page);
            },
            async jouer({ page }, { pause }) {
                const panneau = page.locator('.elpis-ed-instantanes');
                await pause(300);
                await panneau.locator('button[title="Restaurer"]').first().click();
                const confirmer = page.getByRole('button', { name: 'Restaurer', exact: true }).last();
                await confirmer.waitFor();
                await pause(400);
                await confirmer.click();
                await element(page, 'Fichier export.py').waitFor({ state: 'detached' });
                await page.locator('.elpis-ed-explorateur .elpis-git-m').first().waitFor({ state: 'detached' });
                await page.locator('.elpis-ed-vues .ed2-compte').waitFor({ state: 'detached' });
                await pause(250);
            },
        },
    ],
};
