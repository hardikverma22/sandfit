# The demo video

`sandfit-demo.mp4` (and the `sandfit-demo.gif` shown in the main README) is a
[HyperFrames](https://github.com/heygen-com/hyperframes) project: HTML and GSAP animations
rendered to video, frame by frame, so every render is identical.

| File | What it is |
|---|---|
| `sample-history.ts` | Writes a realistic sample week of Claude Code history into a throwaway folder, runs the real sandfit CLI on it, and saves the output to `output/` |
| `output/*.txt` | That output. The terminal scene in the video copies its lines from `output/summary.txt` |
| `video/index.html` | The film: five scenes, 29 seconds, 1920×1080, silent (it plays as a README animation) |
| `video/compositions/*.html` | One file per scene: hook, terminal, policy, proof, call to action |

The numbers in the "proof" scene come from [BENCHMARKS.md](../BENCHMARKS.md).

## Re-make it

You need Node.js 22+ and FFmpeg.

```bash
npm run build && npx tsx demo/sample-history.ts   # refresh the real output
cd demo/video
npx hyperframes check                              # lint, layout, contrast
npx hyperframes preview                            # live preview in the browser
npx hyperframes render --quality looks --output ../sandfit-demo.mp4
```

Then the GIF for the README:

```bash
ffmpeg -y -i demo/sandfit-demo.mp4 -vf "fps=15,scale=960:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=96:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle" demo/sandfit-demo.gif
```

If sandfit's output or the benchmark numbers change, update the text in
`video/compositions/terminal.html` and `video/compositions/proof.html` to match.
