# Megh Lad — Portfolio

Personal portfolio site. Static, dependency-free, no build step — plain HTML, CSS
and JavaScript, deployable to any static host.

**Live:** https://meghlad.github.io

## Structure

```
.
├── index.html          # markup and content — the only file with copy in it
├── css/
│   └── style.css       # design tokens + all styling, organised by section
├── js/
│   ├── scene.js        # canvas backdrop: rotating globe, satellite, swarm
│   └── ui.js           # sticky nav, scroll-spy, reveal-on-scroll, project tabs
├── assets/
│   └── resume.pdf      # linked from the Timeline — replace this file to update
└── README.md
```

**Updating the résumé:** drop a new PDF over `assets/resume.pdf`, keeping the
name. The Timeline card links to that path, so nothing else needs changing —
commit and push and the live link serves the new file.

Content and presentation are kept apart: everything you'd want to reword lives in
`index.html`, everything you'd want to restyle lives in `css/style.css`.

## Running it locally

Open the file directly:

```bash
open index.html
```

Or serve it, which is closer to production:

```bash
python3 -m http.server 8000
# then visit http://localhost:8000
```

The scripts are classic (non-module) scripts loaded with `defer`, so the page
works over `file://` as well as over HTTP.

## Editing

**Theme** — every colour, font and metric is a custom property at the top of
`css/style.css` under *Design tokens*. Changing `--accent` or `--bg` re-themes the
whole page.

**Adding a project** — copy an `<article class="card proj">` block inside the
relevant `.panel` in `index.html`, and bump the `.tab__count` on that tab.

**Adding a timeline entry** — copy a `.tl-item` block. Entries alternate sides
automatically on wide screens via `:nth-child(odd|even)`.

**The backdrop animation** — tuning values (particle counts, swarm size, scan
interval, colours) are in the `CONFIG` object at the top of `js/scene.js`.

## Accessibility & performance

- Semantic landmarks (`header`, `main`, `section`, `footer`) and an ARIA tablist
  with arrow-key navigation for the project switcher.
- Decorative SVGs are `aria-hidden`; the canvas backdrop is inert.
- `prefers-reduced-motion` is honoured — animations are disabled and the canvas
  renders a single static frame.
- The animation loop suspends via `IntersectionObserver` once the hero scrolls
  out of view, so it costs nothing while the rest of the page is read.

## Deploying

Any static host works. For GitHub Pages, push to a repo named
`Meghlad.github.io` and Pages serves `main` at the root automatically.

```bash
git add -A
git commit -m "Update portfolio"
git push
```
