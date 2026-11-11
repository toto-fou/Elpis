// SPDX-License-Identifier: MIT
/** tests/frontend/reel/profils-moteurs-reel-verify.mjs — profils de moteur contre le core TS réel : moteur intégré vLLM puis SGLang (faux serveurs fidèles), choix du modèle dans le chat (menu du modèle : pas de chargement, jauge KV, contexte), console (type, clé masquée, Capacités, « Tester », conseils), connecteur SGLang */
// Recette : ELPIS_NODE_MODULES=…/browser-service/node_modules PLAYWRIGHT_BROWSERS_PATH=… ELPIS_FRONT_BUILD=0 node tests/frontend/reel/profils-moteurs-reel-verify.mjs [dossier-captures]
import path from 'node:path';

import { demarrerCoreReel, lancerNavigateur, contexteConnecte, attendreMontage, verifications, Client, apparait } from '../lib/core-reel.mjs';
import { demarrerFauxMoteur } from '../lib/faux-moteurs.mjs';

const CAPTURES = process.argv[2] || '';
const CLE = 'cle-du-moteur-jamais-affichee';
const v = verifications('profils-moteurs-reel');
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const capture = async (page, nom) => { if (CAPTURES) await page.screenshot({ path: path.join(CAPTURES, `${nom}.png`) }); };
// Comptes de jetons abrégés comme l'interface (« 12,3 k »).
const k = (n) => (n >= 1000 ? `${(n / 1000).toLocaleString('fr-FR', { maximumFractionDigits: n >= 1e5 ? 0 : 1 })} k` : String(n));

const nav = await lancerNavigateur();
try {
    for (const type of ['vllm', 'sglang']) {
        const libelle = type === 'vllm' ? 'vLLM' : 'SGLang';
        const moteur = await demarrerFauxMoteur({ type, cleApi: CLE, contexte: 8192, metriques: true, detailsJetons: false, parseurOutils: type === 'sglang' ? null : 'qwen25' });
        const connecteur = type === 'vllm' ? await demarrerFauxMoteur({ type: 'sglang', contexte: 16384, modele: 'Qwen/Qwen3-4B', detailsJetons: true }) : null;
        const llama = { engine: type, url: moteur.url, api_key: CLE, model: moteur.options.modele };
        const core = await demarrerCoreReel({
            envSup: { LLAMA_URL: moteur.url, LLAMA_ENGINE: type, LLAMA_MODEL: moteur.options.modele },
            configSup: { llama },
        });
        try {
            const journal = () => core.journaux.main.join('');
            await pause(500);
            v.ok(`${type} : sonde du démarrage journalisée (type, version, modèle, contexte)`, new RegExp(`\\[moteur\\] ${libelle} ${type === 'vllm' ? '0\\.31\\.0' : '0\\.5\\.21'} sur ${moteur.url.replace(/[.]/g, '\\.')}.*modèle ${moteur.options.modele.replace(/[/.]/g, '\\$&')}, contexte 8192 jetons`).test(journal()), journal().split('\n').filter((l) => l.includes('[moteur]')).join(' | ').slice(0, 400));
            v.ok(`${type} : la clé n'apparaît dans aucun journal`, !journal().includes(CLE) && !core.journaux.admin.join('').includes(CLE));
            v.ok(`${type} : chaque appel au moteur porte la clé`, moteur.etat.requetes.length > 0 && moteur.etat.requetes.every((r) => r.autorisation === `Bearer ${CLE}`), JSON.stringify(moteur.etat.requetes.filter((r) => r.autorisation !== `Bearer ${CLE}`).map((r) => r.url)));

            let idConnecteur = null;
            if (connecteur) {
                const adminApi = new Client(core.urlAdmin);
                await adminApi.req('POST', '/api/login-lite', core.comptes.admin);
                const cree = await adminApi.req('POST', '/api/admin/llm/connectors', { provider_type: 'sglang', base_url: `${connecteur.url}/v1`, label: 'SGLang du labo' });
                idConnecteur = cree && cree.id;
            }

            // ── Chat : menu du modèle ──
            const compte = new Client(core.urlMain);
            await compte.req('POST', '/api/login-lite', core.comptes.user);
            await compte.req('PUT', '/api/settings', { chat_workflow: 'timeline' });
            const ctx = await contexteConnecte(nav, core.urlMain, core.comptes.user);
            const page = await ctx.newPage();
            const erreurs = [];
            page.on('pageerror', (e) => erreurs.push(String(e.message || e)));
            await page.goto(core.urlMain + '/');
            await attendreMontage(page);
            const bouton = page.locator('[data-model-manager] > button').first();
            await bouton.waitFor({ timeout: 15000 });
            await page.waitForFunction((m) => { const b = document.querySelector('[data-model-manager]'); return !!b && (b.textContent.includes(m) || !!b.querySelector('[title]')?.getAttribute('title')?.includes(m)); }, moteur.options.modele, { timeout: 15000 }).catch(() => {});
            await bouton.click();
            const menu = page.locator('[data-model-manager] [role="listbox"]');
            await menu.waitFor({ timeout: 10000 });
            const jauge = page.locator('[data-jauge-kv]');
            const vueJauge = await apparait(jauge, 15000);
            const totalKv = type === 'vllm' ? moteur.options.blocsKv * moteur.options.tailleBloc : moteur.options.jetonsKv;
            const option = (id) => menu.locator(`[role="option"][data-modele="${id}"]`);
            // Entrées du « ⋯ » d'une ligne (aucune si la ligne n'en a pas), refermé par Échap.
            const actionsDe = async (id) => {
                const bouton = page.locator(`[data-model-manager] [role="option"][data-modele="${id}"] + [data-actions]`);
                if (!(await bouton.count())) return [];
                await bouton.click();
                const entrees = (await page.locator('[data-menu-actions] [role="menuitem"]').allTextContents()).map((t) => t.trim());
                await page.keyboard.press('Escape');
                return entrees;
            };
            v.ok(`${type} : menu — le modèle servi est listé, identifiant en infobulle`, (await option(moteur.options.modele).getAttribute('title').catch(() => '')) === moteur.options.modele);
            const actions = await actionsDe(moteur.options.modele);
            v.ok(`${type} : menu — « ⋯ » : la fiche du modèle en mémoire, ni « Charger » ni « Décharger »`, actions.join('|') === 'Fiche du modèle', actions.join('|'));
            v.ok(`${type} : menu — cache du moteur lu sur ses métriques`, vueJauge && (await jauge.innerText()).includes(`/ ${k(totalKv)}`), vueJauge ? await jauge.innerText() : 'absente');
            v.ok(`${type} : menu — charge du moteur (requêtes en cours) en infobulle du cache`, ((await page.locator('[data-cache-moteur]').getAttribute('title').catch(() => '')) || '').includes('en cours'));
            const groupe = menu.locator('[data-groupe-modeles="builtin"]');
            const etat = await groupe.locator('[data-etat-serveur]').innerText().catch(() => '');
            const detail = await groupe.locator('span[title]').first().getAttribute('title').catch(() => '');
            const contexte = await option(moteur.options.modele).locator('[data-capacite]').evaluateAll((l) => l.map((e) => e.getAttribute('title') || ''));
            v.ok(`${type} : menu — serveur en ligne, type du moteur et contexte max_model_len du modèle`, /En ligne/.test(etat) && detail === libelle && contexte.some((t) => /Contexte de 8[\s  ]192 jetons/.test(t)), `${etat} · ${detail} · ${contexte.join(',')}`);
            await capture(page, `selecteur-${type}`);
            if (connecteur) {
                const groupeConn = menu.locator('[data-groupe-modeles^="conn:"]');
                v.ok('connecteur SGLang : groupe et modèle listés', (await groupeConn.innerText().catch(() => '')).includes('SGLang du labo') && (await option(connecteur.options.modele).count()) > 0);
                const actionsConn = await actionsDe(connecteur.options.modele);
                v.ok('connecteur SGLang : ni « Charger » ni « Décharger »', !actionsConn.some((t) => /Charger|Décharger/.test(t)), actionsConn.join('|'));
                await option(connecteur.options.modele).click();
                await pause(400);
                await bouton.click();
                await menu.waitFor({ timeout: 10000 });
                await page.waitForFunction((id) => [...document.querySelectorAll(`[data-model-manager] [role="option"][data-modele="${id}"] [data-capacite]`)].some((e) => /16[\s  ]384/.test(e.getAttribute('title') || '')), connecteur.options.modele, { timeout: 15000 }).catch(() => {});
                const ctxConn = await option(connecteur.options.modele).locator('[data-capacite]').evaluateAll((l) => l.map((e) => e.getAttribute('title') || ''));
                v.ok('connecteur SGLang : contexte max_model_len et cache du connecteur', ctxConn.some((t) => /16[\s  ]384/.test(t)) && (await jauge.innerText().catch(() => '')).includes(`/ ${k(connecteur.options.jetonsKv)}`), `${ctxConn.join(',')} · ${await jauge.innerText().catch(() => '')}`);
                await capture(page, 'selecteur-connecteur-sglang');
                await option(moteur.options.modele).click();
                await pause(300);
            } else {
                await page.keyboard.press('Escape');
            }

            // ── Chat : une réponse du moteur (clé envoyée, modèle servi) ──
            await page.keyboard.press('Escape').catch(() => {});
            // Hors file d'Elpis, le titre de la conversation part en même temps que le tour : même réponse pour tous.
            moteur.options.parDefaut = `Bonjour depuis ${libelle}.`;
            const ta = page.locator('textarea[placeholder]').last();
            await ta.fill('Bonjour');
            await page.locator('button:has(i.ph-paper-plane-right)').last().click();
            const repondu = await page.waitForFunction((t) => [...document.querySelectorAll('.markdown-body')].some((n) => n.textContent.includes(t)), `Bonjour depuis ${libelle}.`, { timeout: 30000 }).then(() => true, () => false);
            const completions = moteur.etat.requetes.filter((r) => r.url === '/v1/chat/completions');
            const derniere = completions.pop();
            await capture(page, `chat-${type}`);
            const bulles = await page.locator('.markdown-body').allInnerTexts().catch(() => []);
            v.ok(`${type} : réponse du moteur affichée dans le chat`, repondu, `${completions.length + (derniere ? 1 : 0)} complétion(s) ; bulles : ${JSON.stringify(bulles).slice(0, 300)}`);
            v.ok(`${type} : la complétion part avec la clé et le modèle servi`, !!derniere && derniere.autorisation === `Bearer ${CLE}` && derniere.corps && derniere.corps.model === moteur.options.modele);
            if (type === 'vllm') v.ok('vllm : usage sans jetons en cache observé, option conseillée au journal', /\[moteur\].*jetons repris du cache non rapportés, ajoutez --enable-prompt-tokens-details/.test(journal()));
            v.ok(`${type} : aucune erreur de page`, erreurs.length === 0, erreurs.join(' | '));
            await ctx.close();

            // ── Console : Inférence › Capacités, « Tester », clé masquée ──
            const actx = await contexteConnecte(nav, core.urlAdmin, core.comptes.admin);
            const apage = await actx.newPage();
            const aerreurs = [];
            apage.on('pageerror', (e) => aerreurs.push(String(e.message || e)));
            await apage.goto(core.urlAdmin + '/#inference');
            await attendreMontage(apage);
            const bloc = apage.locator('[data-capacites-moteur]').first();
            await bloc.waitFor({ timeout: 20000 });
            await apage.waitForFunction(() => !!document.querySelector('[data-etat-moteur]'), null, { timeout: 20000 }).catch(() => {});
            const texteBloc = await bloc.innerText();
            v.ok(`${type} : console — type déclaré sélectionné`, (await apage.locator('#cnx-llama-engine').inputValue()) === type);
            v.ok(`${type} : console — capacités détectées (joignable, version, modèle, contexte)`, texteBloc.includes('Joignable') && texteBloc.includes(`${libelle} ${type === 'vllm' ? '0.31.0' : '0.5.21'}`) && texteBloc.includes(moteur.options.modele) && /8[\s  ]192 jetons/.test(texteBloc), texteBloc.replace(/\s+/g, ' ').slice(0, 300));
            v.ok(`${type} : console — concurrence gérée par le moteur, pas de réglage de slots`, (await apage.locator('[data-concurrence-moteur]').count()) === 1 && (await apage.locator('[data-field="config:llama.max_concurrency"]').count()) === 0);
            await apage.locator('details:has(#cnx-llama-key) > summary').first().click().catch(() => {});
            v.ok(`${type} : console — clé affichée masquée, jamais en clair dans la page`, (await apage.locator('#cnx-llama-key').inputValue()) === '********' && !(await apage.content()).includes(CLE));
            await apage.locator('[data-tester-moteur]').click();
            const conseil = type === 'vllm' ? 'jetons_en_cache' : 'outils';
            const vu = await apparait(apage.locator(`[data-conseil="${conseil}"]`), 30000);
            const message = vu ? await apage.locator(`[data-conseil="${conseil}"]`).innerText() : '';
            v.ok(`${type} : « Tester » — conseil avec le drapeau exact`, vu && message.includes(type === 'vllm' ? '--enable-prompt-tokens-details' : '--tool-call-parser'), message);
            v.ok(`${type} : console — aucune erreur de page`, aerreurs.length === 0, aerreurs.join(' | '));
            await capture(apage, `console-${type}`);
            if (connecteur && idConnecteur) {
                await apage.locator(`[role="option"]:has-text("SGLang du labo")`).first().click();
                await apage.locator('.adm-drawer button:has-text("Tester")').click();
                const ok = await apparait(apage.locator('.adm-drawer [data-capacites-moteur] [data-etat-moteur]'), 20000);
                const txt = ok ? await apage.locator('.adm-drawer [data-capacites-moteur]').innerText() : '';
                v.ok('console — test du connecteur SGLang : rapport du profil (version, contexte)', ok && txt.includes('SGLang 0.5.21') && /16[\s  ]384 jetons/.test(txt), txt.replace(/\s+/g, ' ').slice(0, 300));
                await capture(apage, 'console-connecteur-sglang');
            }
            await actx.close();
        } finally {
            await core.arreter();
            await moteur.arreter();
            if (connecteur) await connecteur.arreter();
        }
    }
} finally {
    await nav.close();
}
process.exit(v.bilan());
