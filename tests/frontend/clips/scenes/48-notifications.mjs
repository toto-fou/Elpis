// SPDX-License-Identifier: MIT
/** tests/frontend/clips/scenes/48-notifications.mjs — clip du bloc « Notifications » : une routine se termine, la cloche et son panneau, la routine ouverte depuis sa notification */
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ARCHIVAGE, TICKETS, VEILLE, ouvrirAvecOutils, repartir } from './40-routines.mjs';

const PANNEAU = '.elpis-notif-pop';

// Notifications déjà lues des jours passés, écrites en base : la veille pour les tickets, l'avant-veille pour un échec de la veille des dépendances.
function semerNotifications(core, routines) {
    const base = new DatabaseSync(path.join(core.dossier, 'racine/user_db/app.db'));
    try {
        base.exec('PRAGMA busy_timeout = 5000');
        const { owner_user_id: compte } = base.prepare('SELECT owner_user_id FROM editor_routines WHERE id=?').get(routines[VEILLE.name]);
        const ilYA = (jours, heure, minute) => { const d = new Date(); d.setDate(d.getDate() - jours); d.setHours(heure, minute, 9, 0); return d.getTime() / 1000; };
        const ajout = base.prepare('INSERT INTO notifications(owner_user_id, kind, title, body, ref_type, ref_id, read_at, created_at) VALUES(?,?,?,?,?,?,?,?)');
        ajout.run(compte, 'routine_error', `Routine « ${VEILLE.name} » en échec`, 'génération interrompue (erreur LLM) — réponse partielle conservée', 'routine', routines[VEILLE.name], ilYA(2, 9, 12), ilYA(2, 7, 0));
        ajout.run(compte, 'routine_ok', `Routine « ${TICKETS.name} » terminée`, 'Douze tickets ouverts cette semaine, dont deux urgents à traiter avant vendredi.', 'routine', routines[TICKETS.name], ilYA(1, 9, 4), ilYA(1, 8, 30));
    } finally {
        base.close();
    }
}

export default {
    ouvrir: () => ouvrirAvecOutils(),
    clips: [
        {
            nom: 'notifications',
            max: 7,
            async preparer(plateau) {
                const { core, page } = plateau;
                const { routines } = await repartir(plateau, [ARCHIVAGE, TICKETS, VEILLE]);
                semerNotifications(core, routines);
                core.llm.scripter('Rien à signaler : toutes les dépendances du projet sont à jour.');
                plateau.veille = routines[VEILLE.name];
                await page.reload();
                await page.locator('button[title="Notifications"]:visible').first().waitFor();
                await page.mouse.move(1276, 796);
                await page.waitForTimeout(500);
            },
            async jouer({ api, page, veille }, { pause }) {
                await pause(400);
                await api.req('POST', `/api/routines/${veille}/run-now`);
                const cloche = page.locator('button[title*="non lue"]:visible').first();
                await cloche.waitFor({ timeout: 20000 });
                await page.locator('button:has-text("Voir"):visible').first().waitFor();
                await pause(400);
                await cloche.hover();
                await pause(300);
                await cloche.click();
                const recue = page.locator(`${PANNEAU} [role="button"]`).first();
                await recue.waitFor();
                await pause(400);
                await recue.hover();
                await pause(350);
                await recue.click();
                await page.locator('.elpis-routines-page [data-run-row]').first().waitFor();
            },
        },
    ],
};
