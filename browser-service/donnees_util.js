// SPDX-License-Identifier: MIT
// browser-service/donnees_util.js — dossier des données du service (captures, états, HAR, traces, vidéos, références) hors du dossier du code, privé (0700), et reprise des données d'avant laissées dans le code.
import fs from 'node:fs';
import path from 'node:path';

/** Sous-dossiers de données du service. */
export const DOSSIERS_DONNEES = ['screenshots', 'downloads', 'cookies', 'har', 'baselines', 'videos', 'traces'];

/** Déplace `de` vers `vers` (renommage, sinon copie puis retrait entre deux systèmes de fichiers). */
function deplacer(de, vers) {
    try { fs.renameSync(de, vers); }
    catch (e) {
        if (e.code !== 'EXDEV') throw e;
        fs.cpSync(de, vers, { recursive: true, preserveTimestamps: true, errorOnExist: true, force: false });
        fs.rmSync(de, { recursive: true, force: true });
    }
}

/**
 * Dossier de données ``donnees`` créé en 0700 ; chaque sous-dossier de ``DOSSIERS_DONNEES`` resté dans
 * ``code`` (installation d'avant) y est repris : déplacé s'il manque, sinon fusionné entrée par entrée
 * (une entrée déjà présente reste en place), puis retiré du code s'il est vide. → noms des dossiers repris.
 */
export function preparerDonnees(code, donnees, journal = () => {}) {
    fs.mkdirSync(donnees, { recursive: true, mode: 0o700 });
    fs.chmodSync(donnees, 0o700);
    const repris = [];
    if (path.resolve(code) === path.resolve(donnees)) return repris;
    for (const nom of DOSSIERS_DONNEES) {
        const ancien = path.join(code, nom);
        let st;
        try { st = fs.lstatSync(ancien); } catch (_) { continue; }
        if (!st.isDirectory()) continue;
        const neuf = path.join(donnees, nom);
        try {
            if (!fs.existsSync(neuf)) deplacer(ancien, neuf);
            else {
                for (const e of fs.readdirSync(ancien)) {
                    if (!fs.existsSync(path.join(neuf, e))) deplacer(path.join(ancien, e), path.join(neuf, e));
                }
                try { fs.rmdirSync(ancien); } catch (_) { journal(`${ancien} : entrées déjà présentes dans ${neuf}, laissées en place`); }
            }
            repris.push(nom);
        } catch (e) {
            journal(`${ancien} non repris dans ${donnees} : ${e.message}`);
        }
    }
    return repris;
}
