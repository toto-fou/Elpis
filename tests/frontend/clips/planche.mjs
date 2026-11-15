// SPDX-License-Identifier: MIT
/** tests/frontend/clips/planche.mjs — planche-contact d'un clip (n images réparties sur sa durée, empilées) pour juger cadrage et lisibilité sans lecteur vidéo */
// Usage : node tests/frontend/clips/planche.mjs <clip.webm> <planche.png> [n=4]
import { spawnSync } from 'node:child_process';

const [clip, sortie, n = '4'] = process.argv.slice(2);
if (!clip || !sortie) { console.error('usage : planche.mjs <clip.webm> <planche.png> [n]'); process.exit(2); }
const sonde = spawnSync('ffprobe', ['-v', 'error', '-count_frames', '-show_entries', 'stream=nb_read_frames', '-of', 'csv=p=0', clip], { encoding: 'utf8' });
const total = Number(sonde.stdout.trim());
if (!total) { console.error(`illisible : ${clip}`); process.exit(1); }
const choix = Array.from({ length: Number(n) }, (_, i) => Math.round((i * (total - 1)) / Math.max(1, Number(n) - 1)));
const filtre = `select='${choix.map((i) => `eq(n\\,${i})`).join('+')}',tile=1x${choix.length}`;
const r = spawnSync('ffmpeg', ['-v', 'error', '-y', '-i', clip, '-vf', filtre, '-frames:v', '1', sortie], { encoding: 'utf8' });
if (r.status !== 0) { console.error(r.stderr); process.exit(1); }
console.log(`${sortie} : images ${choix.join(', ')} sur ${total}`);
