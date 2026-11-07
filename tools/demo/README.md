# README demo

Records the presentation in `docs/media/elpis-demo.gif` with no GPU and no real data: an isolated
instance (root `.instance/`, ports 38001, 38765 and 38080) answers through a fake engine that replays the
scenario in `scenes/presentation.mts`, Chromium runs in an Xvfb screen and ffmpeg films losslessly.

```sh
npm run build                              # at the root: core, tool host and interface
cd tools/demo && npm ci
npx playwright-core install chromium       # if Playwright 1.64's Chromium is missing
node record.mts                            # → out/presentation.gif, .mp4 and .png
cp out/presentation.gif ../../docs/media/elpis-demo.gif
```

Prerequisites: Docker and the `elpis/sandbox` image, `Xvfb`, `ffmpeg`. The demo sandbox belongs only to the
`alex` account (id 4242, container `elpis-sb-alex`), deleted at the end; no other container is touched.
A busy machine gives a choppy capture: record on an idle machine.
