# Mascots

The characters of the welcome screen and avatars, in pixel art.

| Folder | Character |
|---|---|
| `elpis/` | the laurel-crowned bust |
| `boite_or/` | a chest |
| `flamme/`, `flamme_bleue/` | a flame |
| `fantome/` | a ghost |
| `kiki/`, `kiki_face/`, `kiki_dodo/`, `kiki_guerriere/` | the welcome scene of the `kiki` skin |

## Files served to the browser

- `socle-mascottes.css`: one animated CSS sheet per character and per state.
  Usage: `<span class="socle-mascotte" data-perso="elpis" data-etat="repos"></span>`.
  States: `repos`, `reflexion`, `parole`, `sommeil`, `salut`, `erreur`,
  `chantier`, `reveil`.
- `socle-mascottes.json`: the same description, as data (window, states,
  animations of each character).
- `<perso>/source.json`: the images and anchor points read by the welcome-screen
  engine (`src/features/mascotte/accueil.ts`).
- `<perso>/*.png`, `<perso>/atlas.webp`: the sprite sheets. Each sheet carries a
  copy of its first frame at the end, which makes the animation independent of
  the display size.
- `kiki/marionnette.json`: the articulated limbs of the Kiki scene.
- `accueil.css` (the engine is in `src/features/mascotte/`): the animated welcome screen (the word
  ELPIS and the mascot that lives in it).

## Usage constraint

The drawing fits in a window of 24 or 48 pixels. It stays sharp at
**integer multiples** (48, 96, 144, 192). In between, the browser invents
pixels and the rendering becomes uneven.

## Activation

Mascots are off by default: the welcome screen shows the logo until the account has chosen
one (`welcome_mascot_on`, Settings › Appearance › Mascot). A skin that brings its own
(`mascot`) shows it until the account turns it off.

## Registry

`mascottes.json` is the SINGLE list of mascots offered on the welcome screen
(`id`, `label`, in display order; `"apercu": false` excludes it from the
preview characters of the console). The server uses it to validate the
`welcome_mascot` setting (`shared_infra/appearance/skins.py`) and serves it to the
interface (`mascottes_catalogue` in `GET /api/settings`); the console
reads it statically. Mascots specific to a skin (`kiki`) are not listed there:
they come from the `mascot` field of the skin registry
(`frontend/css/skins/skins.json`).

## Adding a character

1. Drop its folder here (`<id>/`, sheets and `source.json`).
2. Add its rules to `socle-mascottes.css` and its entry to
   `socle-mascottes.json`.
3. Add `{"id": "<id>", "label": "<Name>"}` to `mascottes.json`.

The server refuses any identifier absent from `mascottes.json`
(`tests/shared_infra/test_skins_plugins_2026_09_28.py` checks that each
entry has its folder, its CSS sheet and its entry in `socle-mascottes.json`).

## Origin and license

- Pixel art (chest, flames, ghost, Elpis bust): drawn by script from
  the grids in `source.json`, under the project license (MIT).
- Elpis logo (`frontend/elpis-*.png`) and Kiki skin illustrations
  (`kiki*/`, cut out with the tools in the folder): produced by image
  generation. Their copyright protection is uncertain: no right
  is claimed, and they are placed under CC0-1.0 (`REUSE.toml`).

Caveat: the resemblance of the generated images to existing works is not
checked. The Kiki skin is disabled by default; a sensitive deployment
can keep only the script-drawn images.
