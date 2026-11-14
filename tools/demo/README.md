# README demo

Records the presentation in `docs/media/elpis-demo.gif` with no GPU and no real data: an isolated
instance (root `.instance/`, ports 38001, 38765 and 38080) answers through a fake engine that replays the
scenario in `scenes/presentation.mts`, Chromium runs in an Xvfb screen and ffmpeg films losslessly.

```sh
npm run build                              # at the root: core, tool host and interface
cd tools/demo && npm ci
npx playwright-core install chromium       # the full Chromium, if Playwright 1.64's is missing
sudo npx playwright-core install-deps chromium   # its system libraries and Xvfb
node record.mts                            # → out/presentation.gif, .mp4 and .png
cp out/presentation.gif ../../docs/media/elpis-demo.gif
```

Prerequisites: Docker and the `elpis/sandbox` image, `Xvfb`, `ffmpeg`, and the full Chromium with its system
libraries: the recorder opens a window, while `install.sh` and its `navigateur` apt group only install the
headless shell of the browser service and what it loads. Likewise, performance baselines measured with the
full Chromium are not comparable with runs on the headless shell. The demo sandbox belongs only to the
`alex` account (id 4242, container `elpis-sb-alex`), deleted at the end; no other container is touched.
A busy machine gives a choppy capture: record on an idle machine.
