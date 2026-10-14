# Reference notes

Free-text notes shown on the calculator's Reference pages, under an item's or a machine's
heading. Add one by creating a file named after the game's key for it:

- `items/<item key>.md`, e.g. `items/WorldTreeSeed.md`
- `machines/<building key>.md`, e.g. `machines/WorldTreeNursery.md`

The key is the one in the page's address (`reference?item=WorldTreeSeed`). Items shown together
on one page (the tiers of refined sand, in `web/src/lib/referenceGroups.ts`) share that page's
note: `items/RefinedSand.md`. A note for a machine
also shows on its mirrored copy. Notes are optional: most pages have none.

## What a note can use

A small part of Markdown, drawn by the calculator itself:

- Paragraphs: lines run together until a blank line.
- Headings: `##` and `###` (the page already has the `#` title).
- Lists: `-`, `*` or `1.` at the start of a line. Indent a line to continue the item above it;
  lists can't be nested.
- `**bold**`, `*italic*` or `_italic_`, `` `code` ``, and `\` before a character to show it as is.
- Links: `[text](item:Key)` and `[text](machine:Key)` go to another Reference page;
  `[text](https://…)` opens a web page.

Anything else (quotes, code blocks, tables, images, HTML) is refused. The tests read every note
and fail on anything they can't place, on a file whose name isn't an item or machine, and on a
link to one that doesn't exist, so a mistake never reaches the site.

Notes are shown whatever the player's research tier, so keep what a note says to the item or
machine it's about.
