// SPDX-License-Identifier: MIT
/** tests/frontend/lib/services-rag.mjs — services du RAG pour les parcours réels : vrai Qdrant (ELPIS_QDRANT_BIN), vrai extracteur Python (ELPIS_RAG_PY), faux serveur d'embeddings déterministe, documents de démonstration (PDF, Word, Markdown, HTML, texte) */
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { DEPOT } from './core-reel.mjs';

export const QDRANT = process.env.ELPIS_QDRANT_BIN || '';
export const PYTHON = process.env.ELPIS_RAG_PY || '';
export const SERVICES_DISPONIBLES = !!QDRANT && !!PYTHON && fs.existsSync(QDRANT) && fs.existsSync(PYTHON);
export const JETON_EXTRACTEUR = 'jeton-parcours-rag';
export const MODELE_EMBED = 'bge-test';
const DIM = 64;

function portsLibres(n) {
    return Promise.all(Array.from({ length: n }, () => new Promise((resolve, reject) => {
        const s = net.createServer();
        s.once('error', reject);
        s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
    })));
}

const attendre = (ms) => new Promise((r) => setTimeout(r, ms));

/** Sac de mots haché, normalisé : deux textes qui partagent des mots ont des vecteurs proches. */
export function vecteur(texte) {
    const v = new Array(DIM).fill(0);
    const mots = String(texte).normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().match(/[a-z0-9]+/g) || [];
    for (const m of mots) {
        let h = 2166136261;
        for (let i = 0; i < m.length; i++) { h ^= m.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
        v[h % DIM] += 1;
    }
    if (!v.some((x) => x !== 0)) v[0] = 1;
    const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
    return v.map((x) => x / n);
}

async function demarrerFauxEmbeddings() {
    // `delai` : attente (ms) avant chaque réponse, pour garder une indexation assez longue à observer.
    const stats = { appels: 0, delai: 0 };
    const serveur = http.createServer((req, res) => {
        let corps = '';
        req.on('data', (c) => { corps += c; });
        req.on('end', () => {
            stats.appels++;
            let d = {};
            try { d = JSON.parse(corps); } catch { d = {}; }
            const entrees = Array.isArray(d.input) ? d.input : [String(d.input ?? '')];
            setTimeout(() => {
                if (res.destroyed) return;
                res.writeHead(200, { 'content-type': 'application/json' });
                res.end(JSON.stringify({ data: entrees.map((t, index) => ({ index, embedding: vecteur(t) })) }));
            }, stats.delai);
        });
    });
    await new Promise((r) => serveur.listen(0, '127.0.0.1', r));
    return { url: `http://127.0.0.1:${serveur.address().port}`, stats, arreter: () => new Promise((r) => { serveur.closeAllConnections(); serveur.close(() => r()); }) };
}

async function arreterProcessus(p) {
    if (!p || p.exitCode !== null || p.signalCode !== null) return;
    const fin = new Promise((r) => p.once('exit', () => r()));
    p.kill('SIGTERM');
    const force = setTimeout(() => p.kill('SIGKILL'), 10000);
    await fin;
    clearTimeout(force);
}

/** Lance Qdrant, l'extracteur et le faux serveur d'embeddings dans `dossier` ; rend la configuration `rag` du core, les variables d'environnement et l'arrêt. */
export async function demarrerServicesRag(dossier) {
    const [http_, grpc, api] = await portsLibres(3);
    const journal = [];
    const trace = (p) => { for (const f of [p.stdout, p.stderr]) f?.on('data', (m) => { journal.push(String(m)); if (journal.length > 60) journal.shift(); }); };
    fs.mkdirSync(path.join(dossier, 'qdrant'), { recursive: true });
    const qdrant = spawn(QDRANT, [], {
        cwd: path.join(dossier, 'qdrant'),
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, QDRANT__SERVICE__HOST: '127.0.0.1', QDRANT__SERVICE__HTTP_PORT: String(http_), QDRANT__SERVICE__GRPC_PORT: String(grpc), QDRANT__STORAGE__STORAGE_PATH: path.join(dossier, 'qdrant', 'storage'), QDRANT__STORAGE__SNAPSHOTS_PATH: path.join(dossier, 'qdrant', 'snapshots'), QDRANT__TELEMETRY_DISABLED: 'true' },
    });
    trace(qdrant);
    const magasin = path.join(dossier, 'magasin');
    const cache = path.join(dossier, 'cache');
    fs.mkdirSync(magasin, { recursive: true });
    fs.mkdirSync(cache, { recursive: true });
    fs.cpSync(path.join(DEPOT, 'rag_app'), path.join(dossier, 'rag_app'), { recursive: true, filter: (s) => !s.includes('__pycache__') });
    const uvicorn = spawn(PYTHON, ['-m', 'uvicorn', 'app:app', '--host', '127.0.0.1', '--port', String(api)], {
        cwd: path.join(dossier, 'rag_app'),
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, RAG_STORE_DIR: magasin, RAG_CACHE_DIR: cache, RAG_SERVICE_TOKEN: JETON_EXTRACTEUR, PYTHONDONTWRITEBYTECODE: '1', LLAMA_IP: '127.0.0.1', LLAMA_PORT: '1' },
    });
    trace(uvicorn);
    const embeddings = await demarrerFauxEmbeddings();
    const arreter = async () => {
        await arreterProcessus(uvicorn);
        await arreterProcessus(qdrant);
        await embeddings.arreter();
    };
    const limite = Date.now() + 90000;
    try {
        for (;;) {
            if (qdrant.exitCode !== null || uvicorn.exitCode !== null) throw new Error(`service arrêté :\n${journal.join('').slice(-3000)}`);
            const q = await fetch(`http://127.0.0.1:${http_}/healthz`).then((r) => r.ok).catch(() => false);
            const e = q && await fetch(`http://127.0.0.1:${api}/api/health`).then((r) => r.ok).catch(() => false);
            if (q && e) break;
            if (Date.now() > limite) throw new Error(`services pas prêts :\n${journal.join('').slice(-3000)}`);
            await attendre(300);
        }
    } catch (e) {
        await arreter();
        throw e;
    }
    const urlExtracteur = `http://127.0.0.1:${api}`;
    const urlQdrant = `http://127.0.0.1:${http_}`;
    return {
        magasin, urlQdrant, urlExtracteur, embeddings,
        // Configuration du core : la config JSON porte les clés, l'environnement l'emporte sur l'adresse et le jeton du service.
        configRag: { rag: { store_dir: magasin, qdrant_url: urlQdrant, embed: { url: embeddings.url, model: MODELE_EMBED, timeout_s: 10 }, indexation: { concurrence: 2, par_compte: 1 } } },
        env: { RAG_SERVICE_URL: urlExtracteur, RAG_SERVICE_TOKEN: JETON_EXTRACTEUR, RAG_STORE_DIR: magasin },
        collectionsQdrant: async () => (await (await fetch(`${urlQdrant}/collections`)).json()).result.collections.map((c) => c.name),
        arreter,
    };
}

const GENERATEUR = String.raw`
import sys
from pathlib import Path
from fpdf import FPDF
from docx import Document
sortie = Path(sys.argv[1])
pdf = FPDF(unit="pt", format="A4")
pages = [
    ("Certificats et PKI", "Les certificats importes peuvent etre associes a un correspondant IPsec par son identifiant ; le pare-feu verifie la chaine complete a chaque negociation."),
    ("Listes de revocation", "Publiez la nouvelle liste de revocation avant de retirer l'ancien certificat, sinon les correspondants refusent la negociation."),
    ("Supervision des tunnels", "Controlez l'etat des tunnels VPN dans la supervision : la phase 2 doit afficher le nouveau numero de serie."),
]
sujets = ["Sauvegarde des configurations", "Supervision des liens", "Inventaire du materiel", "Comptes d'administration", "Journalisation", "Changements planifies"]
for i in range(15):
    pages.append((sujets[i % len(sujets)], "Chaque equipement est suivi dans l'inventaire et revu chaque trimestre par l'equipe d'exploitation, avec la date de la derniere intervention et le nom de l'intervenant. Reference interne %d." % (i + 1)))
for titre, texte in pages:
    pdf.add_page()
    pdf.set_font("Helvetica", "B", 20)
    pdf.text(72, 100, titre)
    pdf.set_font("Helvetica", "", 11)
    pdf.set_xy(72, 130)
    pdf.multi_cell(420, 14, (texte + " ") * 6)
pdf.output(str(sortie / "guide-administration.pdf"))
doc = Document()
doc.add_heading("Procedure VPN IPsec inter-sites", level=1)
doc.add_heading("3.2 Renouvellement des certificats", level=2)
doc.add_paragraph("Avant tout renouvellement, verifiez que le profil de chiffrement du correspondant accepte la nouvelle autorite. Le tunnel reste monte pendant l'operation si les deux certificats sont presents.")
doc.add_heading("3.3 Retour arriere", level=2)
doc.add_paragraph("Si le site distant ne remonte pas apres le renouvellement, rebasculez sur l'ancien certificat depuis la console du pare-feu.")
for i in range(28):
    doc.add_heading("Annexe %d" % (i + 1), level=2)
    doc.add_paragraph("Les parametres de supervision et de sauvegarde de cette annexe sont revus avec l'equipe d'exploitation a chaque changement planifie. Reference interne %d." % (i + 1))
doc.save(str(sortie / "procedure-vpn-ipsec-sites.docx"))
`;

// Sections de remplissage : des sujets d'exploitation sans les mots des recherches de test, pour que les documents aient des dizaines de passages.
const SUJETS = [
    ['Sauvegarde des configurations', 'Exportez la configuration du pare-feu chaque nuit vers le serveur de sauvegarde, puis conservez trente jours d’historique. Vérifiez chaque semaine que la restauration d’un export récent fonctionne sur la maquette du laboratoire.'],
    ['Supervision des liens', 'La supervision interroge chaque lien toutes les minutes et alerte l’astreinte au-delà de trois pertes consécutives. Les seuils de latence sont réglés par site selon le débit souscrit auprès de l’opérateur.'],
    ['Inventaire du matériel', 'Chaque équipement figure dans l’inventaire avec son numéro de série, sa date d’achat et son emplacement. Une revue trimestrielle compare l’inventaire au parc réellement branché dans les baies.'],
    ['Comptes d’administration', 'Les comptes d’administration sont nominatifs et protégés par une authentification à deux facteurs. Les droits sont revus à chaque départ ou changement de poste, et les accès partagés sont proscrits.'],
    ['Journalisation', 'Les journaux des pare-feu sont envoyés en continu vers le collecteur central, conservés six mois, puis archivés. Les alertes de sécurité sont corrélées avec les connexions des comptes d’administration.'],
    ['Changements planifiés', 'Tout changement de règle passe par une demande validée par un second administrateur. La fenêtre de maintenance est annoncée aux utilisateurs deux jours avant, avec le plan de retour arrière.'],
    ['Mises à jour du micrologiciel', 'Les mises à jour sont d’abord appliquées sur le pare-feu de secours, puis sur le principal après une semaine d’observation. Le numéro de version installé est consigné dans l’inventaire.'],
    ['Plan de reprise', 'Le plan de reprise décrit la bascule vers le site de secours, les contacts à prévenir et l’ordre de remise en service des applications. Un exercice grandeur nature a lieu chaque année.'],
];
const remplissage = (n, graine) => Array.from({ length: n }, (_, i) => {
    const [titre, texte] = SUJETS[(i + graine) % SUJETS.length];
    return `Point ${i + 1}. ${titre}\n\n${texte} Référence interne ${graine}-${i + 1}.`;
}).join('\n\n');

const TEXTES = {
    'renouvellement-certificats.md': `# Renouvellement des certificats\n\n## Tunnels IPsec\n\nLe certificat du tunnel IPsec entre Lyon et le siège expire tous les 12 mois. Générez la demande depuis la PKI interne, puis importez le certificat signé dans le pare-feu de Lyon avant la date d’expiration.\n\n## Vérifications\n\nContrôlez l’état du tunnel dans Supervision : la phase 2 doit afficher le nouveau numéro de série. En cas d’échec, réactivez l’ancien certificat et ouvrez un ticket réseau.\n\n## Annexes\n\n${remplissage(36, 1)}\n`,
    'checklist-mise-en-production.md': `# Mise en production\n\n## Avant\n\nSauvegardez la configuration des pare-feu et prévenez l’exploitation.\n\n## Après\n\nVérifiez la supervision pendant une heure.\n\n## Rappels\n\n${remplissage(10, 2)}\n`,
    'faq-wifi-invites.html': `<html><body><h1>Wi-Fi invités</h1><h2>Accès</h2><p>Les invités se connectent au réseau dédié avec un code temporaire fourni à l’accueil.</p><h2>Durée</h2><p>Le code expire au bout de huit heures.</p>${Array.from({ length: 24 }, (_, i) => `<h2>Question ${i + 1}</h2><p>${SUJETS[(i + 3) % SUJETS.length][1]} Réponse ${i + 1}.</p>`).join('')}</body></html>`,
    'plan-adressage-2026.txt': `Plan d’adressage 2026\n\nLe siège utilise le réseau 10.0.0.0/16, le site de Lyon 10.1.0.0/16 et le site de Lille 10.2.0.0/16.\n\n${remplissage(16, 4)}\n`,
};

/** Écrit les documents de démonstration dans `dossier` (le PDF et le Word par Python) ; rend les chemins utiles. */
export function ecrireDocuments(dossier) {
    fs.mkdirSync(dossier, { recursive: true });
    execFileSync(PYTHON, ['-I', '-c', GENERATEUR, dossier], { stdio: 'pipe' });
    for (const [nom, contenu] of Object.entries(TEXTES)) fs.writeFileSync(path.join(dossier, nom), contenu);
    fs.writeFileSync(path.join(dossier, 'virus.exe'), 'MZ-contenu-sans-importance');
    fs.writeFileSync(path.join(dossier, 'vide.md'), '');
    const dir = path.join(dossier, 'dossier-reseau', 'sous');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'notes-reseau.md'), '# Notes réseau\n\n## Sites\n\nLe site de Lille est relié au siège par un tunnel IPsec redondant.\n');
    fs.writeFileSync(path.join(dossier, 'dossier-reseau', '.cache-cache.md'), 'fichier caché ignoré');
    return {
        pdf: path.join(dossier, 'guide-administration.pdf'),
        docx: path.join(dossier, 'procedure-vpn-ipsec-sites.docx'),
        textes: Object.keys(TEXTES).map((n) => path.join(dossier, n)),
        exe: path.join(dossier, 'virus.exe'),
        vide: path.join(dossier, 'vide.md'),
        dossier: path.join(dossier, 'dossier-reseau'),
    };
}
