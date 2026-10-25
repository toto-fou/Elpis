// SPDX-License-Identifier: MIT
// tools/demo/record.mts — enregistre une scène : instance isolée, Chromium dans un écran Xvfb, capture ffmpeg sans perte, puis MP4, GIF et PNG.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, statSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { chromium, type Page } from "playwright-core";

import { SCRIPT_CURSEUR, deplacer, pause } from "./curseur.mts";
import { MODELE } from "./moteur.mts";
import { COMPTE, demarrerInstance, RACINE, URL_MAIN, type OptionsInstance } from "./instance.mts";

const LARGEUR = 1440;
const HAUTEUR = 900;
const ECRAN = ":97";
const GIF_LARGEUR = 1200;
// 25 i/s : délai GIF exact de 4 cs (les navigateurs ralentissent sous 2 cs).
const GIF_IPS = 25;
const VITESSE = 1.3;

const nom = process.argv[2] ?? "presentation";
const fichierScene = path.join(import.meta.dirname, "scenes", `${nom}.mts`);
const SORTIE = path.join(import.meta.dirname, "out");

function executer(argv: string[]): Promise<void> {
  return new Promise((ok, ko) => {
    const p = spawn(argv[0]!, argv.slice(1), { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    p.stderr.on("data", (d: Buffer) => (err = (err + d.toString()).slice(-2000)));
    p.on("exit", (c) => (c === 0 ? ok() : ko(new Error(`${argv[0]} ${c}\n${err}`))));
  });
}

async function attendreFichier(f: string, delai = 10_000): Promise<void> {
  const fin = Date.now() + delai;
  while (!existsSync(f)) {
    if (Date.now() > fin) throw new Error(`${f} absent`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** Capture sans perte de l'écran Xvfb ; « q » sur l'entrée standard la termine proprement. */
function capturer(brut: string): ChildProcess {
  return spawn(
    "ffmpeg",
    [
      "-y",
      "-loglevel",
      "error",
      "-f",
      "x11grab",
      "-draw_mouse",
      "0",
      "-video_size",
      `${LARGEUR}x${HAUTEUR}`,
      "-framerate",
      "30",
      "-i",
      `${ECRAN}.0+0,0`,
      "-c:v",
      "libx264rgb",
      "-crf",
      "0",
      "-preset",
      "ultrafast",
      brut,
    ],
    { stdio: ["pipe", "ignore", "inherit"] },
  );
}

async function monter(brut: string): Promise<void> {
  const mp4 = path.join(SORTIE, `${nom}.mp4`);
  const gif = path.join(SORTIE, `${nom}.gif`);
  const acceleration = `setpts=PTS/${VITESSE}`;
  await executer([
    "ffmpeg",
    "-y",
    "-i",
    brut,
    "-vf",
    acceleration,
    "-c:v",
    "libx264",
    "-crf",
    "20",
    "-preset",
    "slow",
    "-pix_fmt",
    "yuv420p",
    "-movflags",
    "+faststart",
    mp4,
  ]);
  // Deux passes (palette, puis encodage) : en une seule, split garde toutes les images en mémoire.
  const images = `${acceleration},fps=${GIF_IPS},scale=${GIF_LARGEUR}:-1:flags=lanczos`;
  const palette = path.join(SORTIE, `${nom}-palette.png`);
  await executer([
    "ffmpeg",
    "-y",
    "-i",
    brut,
    "-vf",
    `${images},palettegen=max_colors=256:stats_mode=diff`,
    palette,
  ]);
  await executer([
    "ffmpeg",
    "-y",
    "-i",
    brut,
    "-i",
    palette,
    "-lavfi",
    `${images}[v];[v][1:v]paletteuse=dither=sierra2_4a:diff_mode=rectangle`,
    gif,
  ]);
  for (const f of [mp4, gif]) console.log(`${f}  ${(statSync(f).size / 1e6).toFixed(1)} Mo`);
}

/** Chromium en fenêtre d'application dans l'écran Xvfb ; la capture couvre la scène seule. */
async function filmer(scene: { jouer(page: Page): Promise<void> }, brut: string): Promise<void> {
  // Fenêtre d'application (--app) : ni onglets ni barre d'adresse ; profil jetable sous .instance/.
  const ctx = await chromium.launchPersistentContext(path.join(RACINE, "chromium"), {
    headless: false,
    viewport: null,
    env: {
      ...Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== "WAYLAND_DISPLAY")),
      DISPLAY: ECRAN,
    },
    args: [
      "--ozone-platform=x11",
      `--app=${URL_MAIN}/`,
      `--window-size=${LARGEUR},${HAUTEUR}`,
      "--window-position=0,0",
      "--force-device-scale-factor=1",
      "--hide-scrollbars",
      "--disable-features=Translate,TranslateUI",
    ],
  });
  try {
    await ctx.addInitScript(SCRIPT_CURSEUR);
    const r = await ctx.request.post(`${URL_MAIN}/api/login-lite`, { data: COMPTE });
    if (!r.ok()) throw new Error(`connexion : ${r.status()}`);
    const page = ctx.pages()[0] ?? (await ctx.newPage());
    await page.goto(`${URL_MAIN}/`);
    const taille = await page.evaluate(() => [innerWidth, innerHeight]);
    if (taille[0] !== LARGEUR || taille[1] !== HAUTEUR)
      throw new Error(`fenêtre ${taille.join("x")}, attendu ${LARGEUR}x${HAUTEUR}`);
    // Liste des modèles parfois vide au premier chargement : la page est rechargée.
    for (let essai = 0; ; essai++) {
      await page.locator("textarea").first().waitFor();
      try {
        await page.locator(`button[title='${MODELE}']`).waitFor({ timeout: 10_000 });
        break;
      } catch (e) {
        if (essai >= 2) throw e;
        await page.reload();
      }
    }
    await deplacer(page, 980, 640);
    await pause(page, 1500);
    const ffmpeg = capturer(brut);
    const fini = new Promise((ok) => ffmpeg.on("exit", ok));
    try {
      await pause(page, 1200);
      await scene.jouer(page);
      ffmpeg.stdin!.end("q");
    } catch (e) {
      ffmpeg.kill("SIGKILL");
      throw e;
    }
    await fini;
    await page.screenshot({ path: path.join(SORTIE, `${nom}.png`) });
  } finally {
    await ctx.close();
  }
}

async function main(): Promise<void> {
  mkdirSync(SORTIE, { recursive: true });
  const scene = (await import(pathToFileURL(fichierScene).href)) as {
    jouer(page: Page): Promise<void>;
  } & OptionsInstance;
  // Écran plus grand que la fenêtre : à taille égale, X la rogne d'un pixel.
  const xvfb = spawn(
    "Xvfb",
    [ECRAN, "-screen", "0", `${LARGEUR + 64}x${HAUTEUR + 64}x24`, "-nolisten", "tcp"],
    { stdio: "ignore" },
  );
  const brut = path.join(SORTIE, `${nom}-brut.mkv`);
  try {
    await attendreFichier(`/tmp/.X11-unix/X${ECRAN.slice(1)}`);
    const instance = await demarrerInstance(fichierScene, scene);
    try {
      await filmer(scene, brut);
    } finally {
      await instance.arreter();
    }
  } finally {
    xvfb.kill();
  }
  await monter(brut);
}

await main();
