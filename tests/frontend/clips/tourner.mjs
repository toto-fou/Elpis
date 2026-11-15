// SPDX-License-Identifier: MIT
/** tests/frontend/clips/tourner.mjs — tourne les clips de l'aide (`scenes/*.mjs`) contre le core réel et les écrit dans docs/media/aide ; échoue si un clip ou le dossier dépasse son budget */
// Usage : ELPIS_NODE_MODULES=…/browser-service/node_modules node tests/frontend/clips/tourner.mjs [filtre de scène ou de clip] [--dossier=/chemin]
import fs from 'node:fs';
import path from 'node:path';
import { BUDGET, DOSSIER_CLIPS, ouvrirPlateau, poidsTotal, revenirAuDepart, tourner } from './lib/tournage.mjs';

const ici = path.dirname(new URL(import.meta.url).pathname);
const args = process.argv.slice(2);
const filtre = args.find((a) => !a.startsWith('--')) || '';
const dossier = (args.find((a) => a.startsWith('--dossier=')) || '').slice(10) || DOSSIER_CLIPS;
const scenes = fs.readdirSync(path.join(ici, 'scenes')).filter((n) => n.endsWith('.mjs')).sort();
const bilan = [];
const vus = new Set();

for (const fichier of scenes) {
    // Une scène qui ne se charge pas ou ne s'ouvre pas est comptée en échec, sans arrêter les autres.
    let scene, plateau;
    try {
        ({ default: scene } = await import(path.join(ici, 'scenes', fichier)));
    } catch (e) {
        if (!filtre || fichier.includes(filtre)) { console.log(`✗ ${fichier} : ${String(e && e.message).split('\n')[0]}`); bilan.push({ nom: fichier, ok: false }); }
        continue;
    }
    const clips = scene.clips.filter((c) => fichier.includes(filtre) || c.nom.includes(filtre));
    if (!clips.length) continue;
    console.log(`▶ ${fichier}`);
    try {
        plateau = await (scene.ouvrir ? scene.ouvrir() : ouvrirPlateau());
    } catch (e) {
        console.log(`  ✗ ouverture : ${String(e && e.message).split('\n')[0]}`);
        for (const c of clips) bilan.push({ nom: c.nom, ok: false });
        continue;
    }
    try {
        for (const clip of clips) {
            if (vus.has(clip.nom)) throw new Error(`clip en double : ${clip.nom}`);
            vus.add(clip.nom);
            try {
                // Réponses scriptées d'un clip précédent, échoué en route : jamais servies au suivant.
                for (const file of ['file', 'titres', 'annexes']) plateau.core.llm.etat[file].length = 0;
                await revenirAuDepart(plateau);
                if (clip.preparer) await clip.preparer(plateau);
                bilan.push(await tourner(plateau.page, clip.nom, { cadre: clip.cadre, max: clip.max, tenue: clip.tenue, dossier }, (outils) => clip.jouer(plateau, outils)));
            } catch (e) {
                console.log(`  ✗ ${clip.nom} : ${String(e && e.message).split('\n')[0]}`);
                bilan.push({ nom: clip.nom, ok: false });
            }
        }
    } finally {
        await plateau.fermer();
    }
}

const ko = bilan.filter((b) => !b.ok);
const total = poidsTotal(dossier);
console.log(`\n${bilan.length - ko.length}/${bilan.length} clips OK — dossier : ${(total / 1024).toFixed(0)} Ko (plafond ${BUDGET.octetsTotal / 1000} Ko)`);
if (total > BUDGET.octetsTotal) console.log('✗ dossier au-dessus du plafond');
process.exit(ko.length || !bilan.length || total > BUDGET.octetsTotal ? 1 : 0);
