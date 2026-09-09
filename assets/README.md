# Assets

Binary assets referenced by `.codex-plugin/plugin.json` are not included in this
repo — they need to be produced and dropped in here with these exact filenames.

## Required files

- `icon.png` — 512x512 PNG, square, transparent or solid background. Used as the
  composer icon in ChatGPT. Should read clearly at small sizes (down to ~32px).
- `logo.png` — Tallied logo, PNG, used in the directory listing card. Same square
  512x512 treatment as the icon unless the brand logo is wordmark-shaped, in
  which case use a comfortable aspect ratio (e.g. 3:1) at at least 1000px wide.
- `screenshot-week-grid.png` — screenshot of the `time.report` week-grid app
  response (group_by "day"). At least 1000px wide, cropped tightly to the app
  response card, not the whole chat window.
  - Prompt that produced it: "How many hours did I log this week?"
- `screenshot-invoice.png` — screenshot of the `invoice.preview_draft` or
  `invoice.get` invoice preview app response. At least 1000px wide, cropped to
  the card.
  - Prompt that produced it: "Invoice Acme for last month"
- `screenshot-catch-up.png` — screenshot of a `time.propose_entries` proposal
  presented to the user (grouped by day, with confidence and unmatched items
  visible). At least 1000px wide, cropped to the relevant chat turn.
  - Prompt that produced it: "I forgot to log anything this week, can you
    figure it out from my calendar?"

## Notes

- 3-5 screenshots total is the target; the three above are the minimum. Add a
  fourth/fifth (e.g. `screenshot-invoice-list.png` for "Which clients owe me
  money?") if useful.
- Keep every screenshot's chrome (browser/app frame) out of the crop — capture
  just the assistant's response card.
- Do not commit placeholder or stock images; leave this directory without the
  PNGs until real captures exist rather than substituting something generic.
