// SPDX-License-Identifier: MIT
/** tests/frontend/clips/lib/tournage.mjs — tournage des clips de l'aide : instance jetable du core réel, navigateur, capture des images de la page et encodage WebM VP9 sous budget */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEPOT, Client, attendreMontage, contexteConnecte, demarrerCoreReel, lancerNavigateur } from '../../lib/core-reel.mjs';

/** Fenêtre filmée : bureau 16:10, ramenée à la taille du clip. */
export const VUE = { width: 1280, height: 800 };
export const CLIP = { width: 960, height: 600, ips: 12 };
/** Plafonds : un geste tient en 5 s, un enchaînement en 12 s ; poids par clip et total du dossier. */
export const BUDGET = { geste: 5, enchainement: 12, octetsParClip: 120_000, octetsTotal: 3_000_000 };
export const DOSSIER_CLIPS = path.join(DEPOT, 'docs/media/aide');

const FFMPEG = process.env.ELPIS_FFMPEG || 'ffmpeg';
/** Qualité VP9 (plus grand = plus léger) ; ELPIS_CLIP_CRF sert aux essais de compression. */
const CRF = process.env.ELPIS_CLIP_CRF || '44';
const attendre = (ms) => new Promise((r) => setTimeout(r, ms));

/** Nom du modèle montré à l'écran (« Assistant Local » dans le sélecteur). */
export const MODELE = 'assistant-local';

// Instance, navigateur et page connectée du compte de démonstration, animations complètes.
export async function ouvrirPlateau({ compte = 'user', chemin = '/', contexte = {}, llm = {}, envSup = {}, configSup = {}, ...optionsCore } = {}) {
    const core = await demarrerCoreReel({
        tokParS: 60,
        ...optionsCore,
        llm: { modele: MODELE, ...llm },
        envSup: { LLAMA_MODEL: MODELE, ...envSup },
        configSup: { ...configSup, llama: { model: MODELE, ...(configSup.llama || {}) } },
    });
    core.llm.etat.titreParDefaut = 'Nouvelle conversation';
    const nav = await lancerNavigateur();
    const ctx = await contexteConnecte(nav, core.urlMain, core.comptes[compte], { viewport: VUE, reducedMotion: 'no-preference', locale: 'fr-FR', ...contexte });
    const page = await ctx.newPage();
    await page.goto(core.urlMain + chemin);
    await attendreMontage(page);
    const api = new Client(core.urlMain);
    await api.req('POST', '/api/login-lite', core.comptes[compte]);
    const fermer = async () => {
        await nav.close().catch(() => {});
        await core.arreter();
    };
    return { core, nav, ctx, page, api, chemin, fermer };
}

// Remet la page sur son écran de départ, montée et au repos, avant la préparation d'un clip.
export async function revenirAuDepart(plateau) {
    await plateau.page.goto(plateau.core.urlMain + plateau.chemin);
    await attendreMontage(plateau.page);
    await plateau.page.mouse.move(VUE.width - 4, VUE.height - 4);
    await attendre(300);
}

// Images JPEG horodatées → WebM VP9 : chaque image tient jusqu'à la suivante, la dernière pendant `tenue` secondes.
function encoder(images, sortie, { cadre, tenue }) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'elpis-clip-'));
    try {
        const lignes = [];
        images.forEach((im, i) => {
            const f = path.join(tmp, `i${String(i).padStart(5, '0')}.jpg`);
            fs.writeFileSync(f, im.data);
            const suivante = images[i + 1];
            if (suivante) lignes.push(`file '${f}'`, `duration ${Math.max(0.001, suivante.t - im.t).toFixed(3)}`);
            // Le démultiplexeur concat ignore la durée de la dernière entrée et reprend celle d'avant : la dernière image est écrite deux fois, chacune pour la moitié de sa tenue.
            else lignes.push(`file '${f}'`, `duration ${(tenue / 2).toFixed(3)}`, `file '${f}'`, `duration ${(tenue / 2).toFixed(3)}`);
        });
        const liste = path.join(tmp, 'liste.txt');
        fs.writeFileSync(liste, lignes.join('\n') + '\n');
        const [x, y, l, h] = cadre;
        const filtre = `crop=${l}:${h}:${x}:${y},scale=${CLIP.width}:${CLIP.height}:flags=lanczos,fps=${CLIP.ips}`;
        const r = spawnSync(FFMPEG, ['-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', liste, '-vf', filtre, '-an',
            '-c:v', 'libvpx-vp9', '-crf', CRF, '-b:v', '0', '-g', '240', '-row-mt', '1', '-deadline', 'good', '-cpu-used', '1',
            '-pix_fmt', 'yuv420p', sortie], { encoding: 'utf8' });
        if (r.status !== 0) throw new Error(`ffmpeg : ${r.stderr || r.error}`);
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
}

// Durée du fichier encodé, lue par ffprobe : c'est elle que le budget borne.
function dureeReelle(fichier) {
    const r = spawnSync(process.env.ELPIS_FFPROBE || 'ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', fichier], { encoding: 'utf8' });
    const d = Number(String(r.stdout).trim());
    if (r.status !== 0 || !Number.isFinite(d)) throw new Error(`ffprobe : ${r.stderr || r.error || 'durée illisible'}`);
    return d;
}

// Filme `jouer` sur `page` et écrit `docs/media/aide/<nom>.webm` ; `cadre` [x, y, largeur, hauteur] en 16:10, `max` en secondes.
export async function tourner(page, nom, { cadre = [0, 0, VUE.width, VUE.height], max = BUDGET.geste, tenue = 0.9, dossier = DOSSIER_CLIPS } = {}, jouer) {
    if (!/^[a-z0-9-]+$/.test(nom)) throw new Error(`nom de clip invalide : ${nom}`);
    if (Math.abs(cadre[2] / cadre[3] - 1.6) > 0.01) throw new Error(`${nom} : cadre hors 16:10`);
    const images = [];
    let debut = null;
    const actions = await page.screencast.showActions({ cursor: 'pointer', duration: 350, style: { title: 'display: none' } });
    let finJeu = 0;
    await page.screencast.start({ size: VUE, quality: 92, onFrame: ({ data, timestamp }) => { images.push({ data, t: timestamp / 1000, recu: Date.now() }); } });
    try {
        await attendre(150);
        debut = images.length ? images[images.length - 1].t : null;
        await jouer({ pause: attendre });
        finJeu = Date.now();
        // Le dernier état doit être peint puis reçu avant l'arrêt : deux images de la page, puis un court délai.
        await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))).catch(() => {});
        await attendre(300);
    } finally {
        await page.screencast.stop();
        await actions.dispose?.();
    }
    if (!images.length) throw new Error(`${nom} : aucune image reçue`);
    // La dernière image d'avant le départ ouvre le clip : le plan fixe initial ne dépend pas d'un repeint.
    const depart = debut === null ? 0 : Math.max(0, images.findLastIndex((im) => im.t <= debut));
    const plan = images.slice(depart);
    fs.mkdirSync(dossier, { recursive: true });
    const sortie = path.join(dossier, `${nom}.webm`);
    // L'écran immobile n'envoie plus d'image : le temps passé sans repeint à la fin du jeu s'ajoute à la tenue de la dernière.
    const immobile = Math.max(0, finJeu - plan[plan.length - 1].recu) / 1000;
    encoder(plan, sortie, { cadre, tenue: tenue + immobile });
    const duree = dureeReelle(sortie);
    const octets = fs.statSync(sortie).size;
    const alertes = [];
    if (duree > max + 0.05) alertes.push(`durée ${duree.toFixed(1)} s > ${max} s`);
    if (octets > BUDGET.octetsParClip) alertes.push(`poids ${octets} o > ${BUDGET.octetsParClip} o`);
    console.log(`  ${alertes.length ? '✗' : '✓'} ${nom}.webm  ${duree.toFixed(1)} s  ${(octets / 1024).toFixed(0)} Ko  ${plan.length} images${alertes.length ? '  — ' + alertes.join(', ') : ''}`);
    return { nom, duree, octets, ok: alertes.length === 0 };
}

// Poids du dossier des clips, à tenir sous le plafond du dépôt.
export function poidsTotal(dossier = DOSSIER_CLIPS) {
    if (!fs.existsSync(dossier)) return 0;
    return fs.readdirSync(dossier).filter((n) => n.endsWith('.webm')).reduce((s, n) => s + fs.statSync(path.join(dossier, n)).size, 0);
}
