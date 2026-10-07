# Changelog

What changed in each update of the calculator, newest first. The app shows this file on its
Changelog page.

Each update is a `## ` heading with the time it went live in UTC (`YYYY-MM-DDTHH:MMZ`), followed by
`- ` bullets written for players. A bullet can wrap onto indented lines. Add a section before each
deployment: everything pushed to `main` deploys, so `git log origin/main..HEAD` lists what's going
out.

## 2026-10-07T20:45Z

- A new flow chart shows a row and everything that goes into it, left to right from raw
  materials to product. Open it with the flow chart button at the end of any row with
  ingredients. Lines are thicker the more they carry, and are coloured like the game's output
  arrows: gold for a machine's product, blue for its other outputs (such as an Athanor's failed
  products), grey for what comes off the bus.
- Loops and by-products that cross between branches run in lanes of their own, so they never
  hide behind a box. Each loop is marked, and the side panel lists what it takes in and gives out.
- Items built separately join the chart wherever they're built in the plan, with a tag for how
  much they send to other parts of the plan.
- The chart opens 4 levels deep; Levels −/+/All shows more or less, and "more rows" on a box
  opens the chart from there. Drag to pan, Ctrl + scroll or pinch to zoom, and click a box to
  find its row in the plan.

## 2026-10-07T19:08Z

- A new 🔥 Heat layer, next to Items above the plan, shows the plan's heat by network: the
  machines heated by one fuel from one place, biggest first. Changing what a network burns, or
  where its fuel comes from, changes it for every machine on it at once.
- Paradox Crucibles can also refine the by-products of the machines making their input, such as
  Gentian Nectar from Gentian nurseries, so those machines run only for what's left instead of
  overflowing. Switch it on per crucible row; the row shows the blend and how many crucibles each
  input gets. "Use as my default" saves it, and a row can turn it off for itself.
- Rows and panels glide to where a change puts them, and the row you just clicked stays in place
  on screen while the plan re-sorts around it. Building a row separately follows it to where it's
  gathered.
- Each row's ingredients are listed smallest branch first.
- Fuel a row takes straight off the bus now shows on that row's line, next to what it burns,
  instead of as a row of its own.
- A target's amount and unit sit under its item, so the Rate column is narrower and shows the
  target's rate like any other row.
- A target's row is now called "… target" where a by-product feeds it.
- Fixed: building fuel rows separately now gathers them.

## 2026-10-07T03:31Z

- The sand tiers a Refiner makes now have their own names. The game calls them all "Refined Sand",
  so the chain to shards looked like a loop. They now read Refined, Twice Refined, Thrice Refined,
  Quadruply Refined and Quintuply Refined Sand, then Fully Refined Sand.

## 2026-10-06T22:15Z

- Undo and Redo, next to Export and Import, or Ctrl+Z and Ctrl+Shift+Z (⌘ on a Mac). They step
  back through changes to your plans, saved recipes, defaults and upgrades, and each step says what
  it was, such as "Delete plan “My factory”". A deleted plan comes back where it was. Typing in a
  box counts as one step, and a page reload keeps the history. A change made in another tab clears
  this tab's history, so undo never takes back what you did there.

## 2026-10-06T21:00Z

- Any row can now take its item from the bus. Fuel and fertilizer rows do by default. "Import" now
  means only buying at a portal.
- Heat and nutrients run through the plan: what a machine burns or spreads is picked on its own row,
  and the fuel or fertilizer shows with its ingredients, marked burned or spread. Each branch can
  burn a different fuel or spread a different fertilizer, and nurseries grow at their own row's
  speed.
- Steam Boilers are rows in the plan, and Steam can be a target. Machines on heating pads take Steam
  from the bus like any fuel, and "Make in plan" adds a Steam target. A plan heating with Steam can
  pick what its boilers burn.
- The bus panel always shows the plan's default fuel and fertilizer. Changing a default leaves rows
  that picked their own alone.
- Buying is now the Purchasing Portal's recipe, paid with coins off the bus. The coin it's paid in
  sets its pace. Each plan has a default coin, the largest one prices are written in at its research
  tier (copper up to IV, silver from V, gold from VIII), and each portal row can pick its own.
  Portals paid with smaller coin stacks from a Bank Portal run slower.
- You can cap how much of an item the bus carries. Rows share it and fall short past it. "Use the
  rest…" adds a target sized to take what the other rows leave, and a standard target can switch
  to "Size it by…" the bus's leftover supply or an overflow.
- A new plan starts with a blank target row, so its bus and defaults show right away. "+ Add
  target" highlights the blank one instead of adding another.
- The plan selector sits at the top of the plan's column, and the Upgrades and Defaults sidebar can
  be collapsed.
- The bus panel hides inputs that the plan's own fed-back output fully covers.

## 2026-10-06T17:06Z

- The bus panel reads as a flow: what goes in on the left, what goes out on the right, and fed-back
  items as banners across both.
- Fixed: Paradox Crucible craft times now follow the game.

## 2026-10-06T15:58Z

- Each page has its own address, so the tabs are links you can open in a new browser tab.
- Open tabs stay in sync with each other, while each keeps its own page, plan and search.
- Reusing by-products is a switch of its own: picking a producer for the rest no longer turns reuse
  off. A row partly covered by by-products shows them on a line above it.
- Units can split a row below evenly, not just the row itself.

## 2026-10-05T21:18Z

- "Out to the bus" shows the Knowledge Altar EXP each output would earn and how many altars that
  takes, including Relic Knowledge for planets.
- An overflowing line in the plan can add a target that uses its overflow, as on the bus panel.

## 2026-10-05T19:42Z

- Build checklist: mark rows built as you build them in game. Marking a row marks its branch, and
  rows that point to machines elsewhere tick themselves once those are built.
- Machine counts show whole machines to build, with how much of them is used in parentheses.
- Nursery rows show which plant they grow, with its seed's icon.
- Added the Bank Portal for converting coins, with its conversion amount set per row.
- A link to several rows opens a list of them to choose from.
- The Seed Plot is no longer offered, since belts and pipes can't reach it.
- Items built separately under a row are shaded like targets, inside their own bracket.

## 2026-10-05T17:43Z

- "Build shared separately" gathers every item made in several rows under their nearest common
  row, and "Merge single uses" puts back items gathered for just one use.
- An item built separately can be moved from its row's menu: to the top of the plan, to any row
  above all its uses, or merged back.
- Rows keep their picks, catalysts, heights, rounding and units when they're moved.
- The tree toolbar's controls are grouped into View and Organize menus.

## 2026-10-05T15:32Z

- A row reusing a by-product makes the rest with its own producer, instead of running the
  by-product's source harder.

## 2026-10-04T17:04Z

- Thermal Extractor output follows the height it's built at, set per row.

## 2026-10-04T16:32Z

- Targets are chosen and managed right in the production tree.
- Overflow targets: a target can be sized to use all of an item's overflow, from the bus panel or
  from an existing target.
- Overflowing items on the bus link to the rows they overflow from.
- In the cauldron's results, you can change ingredient preferences straight from the list.

## 2026-10-03T19:15Z

- Plan production lines in units: split a row into identical lines of machines.
- Fixed: missing bracket for top-level items built separately.

## 2026-10-03T15:30Z

- Added the Miniature World Tree. The World Tree now requires research tier III.
- The Cauldron page remembers its state between visits.
- High-rate rows show how many belts they need.

## 2026-10-03T14:30Z

- Heat, fertilizer and money come together in one bus panel: what goes into the plan, and what it
  sends out to the bus, one line per item.

## 2026-10-02T22:50Z

- Imports ask whether to add the file's plans next to yours or replace everything.
- Damaged backups or stored data can no longer break the app. If something does go wrong, it offers
  to download your data and start over.

## 2026-10-02T22:33Z

- Reorganized the heat and fertilizer panels around the bus: what goes into the plan's machines,
  and what goes out to the bus.

## 2026-10-02T21:46Z

- Fuel and fertilizer can be fed back per item and per target, and targets can be reordered.
- Net-surplus targets size themselves to cover the plan's own heat or fertilizer and still deliver
  their rate.
- "Provide from this plan" adds a target that covers the heat or fertilizer the bus would supply.
- See what a plan costs to buy and what its output sells for.
- A row can be rounded up to whole machines, with the extra output overflowing.
- Each steam boiler line names the fuel it burns, and boilers are capped at one belt of it.
- The plan header and Buildings panel count whole buildings.

## 2026-10-02T18:22Z

- Upgrades are shared by all your plans instead of set per plan.
- Steam is no longer a fuel choice. Heat-hungry plans report the Steam Boilers they need, burning
  your chosen fuel.
- By-product reuse is optional, and used by-products and overflow are counted more accurately.
- Saving preferred recipe chains works better.
- The Saved recipes page is a table.
- Automatic Cashier and Steam are no longer offered as targets.
- Tidier fuel and fertilizer options, cauldron recipe labels and plan summaries.
- Item names use the right singular or plural.
- Fixed: the target search box was too narrow, and the production tree scrolled on its own.

## 2026-10-01T22:25Z

- Fixed: item label alignment.

## 2026-10-01T22:10Z

- Diagnostic notes moved into tooltips.

## 2026-10-01T20:56Z

- Choose recipes per branch: a row and the rows of its item below it.
- Research tiers: each plan has a tier (I–IX). Defaults stick to what it unlocks, and anything
  beyond it is flagged.
- "Use as my default" saves how you like to make an item, down the whole chain, for every plan.
- The planner uses the full browser width, and remembers which branches are collapsed.
- The planner is much faster.

## 2026-10-01T18:05Z

- "Build separately" works at any level of the tree.
- A new machine picker replaces the plain dropdown.
- Fixed: barrel products (beverages) are no longer suggested as cauldron ingredients.

## 2026-10-01T00:24Z

- "Build separately" option in the planner.
- Links to find where by-products are used.
- Fixed: World Tree Nurseries are set up correctly throughout the tree.

## 2026-09-30T23:48Z

- The app tells you when a new version is available.

## 2026-09-30T23:42Z

- Fixed: the planner held on to recipe choices for items that had left the plan.

## 2026-09-30T23:28Z

- Fixed: the solver gave up on recipes with extreme heat costs.

## 2026-09-30T22:58Z

- Fixed: World Tree Nursery output rates.

## 2026-09-30T22:31Z

- Refreshed the Cauldron page. When a search finds nothing, it suggests filter changes that would
  find recipes.

## 2026-09-30T21:25Z

- Upgrades show their icons and what each level does.
- Fixed: upgrade level caps beyond level 13.

## 2026-09-30T17:24Z

- Full Paradox Crucible support.
- New home page.

## 2026-09-29T22:06Z

- First release: the Cauldron recipe finder, Saved recipes, and the Planner.
