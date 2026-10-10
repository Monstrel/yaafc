# Alchemy Calculator

Production-chain planner for **Alchemy Factory** whose key feature is using your saved
cauldron recipes as steps in production chains, including self-feeding loops.

- **Cauldron**: mix ingredients (normal: 3, advanced: 2), or find every recipe that makes a
  target. Star a recipe to save it. Ingredient preferences filter the finder: mark items preferred
  (ranked first, or the only ones allowed) or avoided (never used), one at a time or by preset.
  The presets are Nursery-grown and Portal goods (each ± one processing step), Cauldron products,
  the in-game categories, and what your active plan makes or overflows.
- **Saved recipes**: a table of your starred mixes, with names and notes. Each one is offered as
  a ★ producer for its item in the planner.
- **Planner**: set targets in items/min. The planner works backward to every step's rate and
  (fractional) machine count, and shows it as a foldable production tree. Any step's producer can
  be a game recipe, a nursery, a saved ★ cauldron recipe, or a purchase, picked per branch (a
  row and the rows of its item below it) or for every row at once. For items cauldrons make,
  "Find a new Cauldron recipe" opens the Cauldron finder on that item. Whenever the open plan
  makes a recipe's item, Use on the Cauldron page saves the recipe and puts it on that row (or
  on the one picked, when there are several). Each row's machines feed the
  row above them, as built in the factory; only by-products cross branches, going to the nearest
  rows that use them. Loops are solved with a linear program. When a chain can't be met, the
  shortfall is reported where it breaks, and everything above it is still sized. Each plan has a
  research tier (I–IX): default recipes, machines and fuel stick to what it unlocks, and steps
  beyond it are flagged, so you can plan ahead for a tier you haven't reached. Once you've found
  a way you like to make something, "use as my default" (the bookmark on a row) remembers the
  recipe, machine and catalysts for that row and everything below it, for every plan.

Saved recipes and plans live in the browser (localStorage). Use Export/Import to back them up.

## Running the web app

```sh
cd web
npm install
npm run dev      # http://localhost:5173
npm test         # engine tests (cauldron math + solver)
npm run build    # static site in web/dist
```

Every push to `main` deploys to GitHub Pages. Before pushing, add a section for the update to
[CHANGELOG.md](CHANGELOG.md), which the app shows on its Changelog page; `git log origin/main..HEAD`
lists what's going out. Its format is at the top of the file, and `npm test` checks it.

The deploy doesn't run the tests (the heavier solver tests are too slow on GitHub's runners); a
pre-push hook runs them on your machine instead. Turn it on once per clone with
`git config core.hooksPath .githooks`; `git push --no-verify` skips it.

## Refreshing game data after a game update

Game data is read straight from your install by `tools/extractor` (C#, CUE4Parse):

```sh
cd tools/extractor
dotnet run -- export     # writes web/src/data/game-data.json and web/public/icons/
```

- The game is UE 5.7 with unversioned properties, so parsing needs `mappings/Mappings.usmap`.
  If a patch changes the game's data structures and the export fails, dump a fresh one. Install
  UE4SS (experimental) into `...\Alchemy Factory\AlchemyFactory\Binaries\Win64`, launch the game,
  go to the UE4SS window → Dumpers → "Generate .usmap file", copy the file over
  `mappings/Mappings.usmap`, then remove UE4SS (`dwmapi.dll` and the `ue4ss` folder).
- Other commands: `dotnet run -- list <regex>` and `dotnet run -- dump <regex> <outDir>` (raw JSON).
- Override paths with `AF_PAKS` / `AF_MAPPINGS` environment variables.

### Where the data comes from

| Data | Game asset |
| --- | --- |
| Items, cauldron values/targets, heat & nutrient values | `DataTables/DT_Enemies` (the game's internal name for items) |
| Recipes | `DataTables/DT_EnemyCrafting` |
| Machines, heat cost | `DataTables/DT_Buildings` + each building's blueprint (`FactoryCraftType`, `GrindingSpeed`) |
| Nursery growth | `DataTables/DT_PlantSeedConfig` |
| Upgrades | `DataTables/DT_Improvements`, `DT_UpgradePoints` |
| Research tiers (machines, recipes, portal stock) | `DataTables/DT_SkillMerge` (`Tier` + 1 = I–IX), `DT_Workbench` (buildings tied to a research node) |
| License-gated recipes | `DataTables/DT_License` (`UnlockItems`) |
| English names | `Localization/Game/en/Game.locres` |

### Modelling assumptions (not in the data tables)

- Value-based cauldron **craft time and heat** are computed in C++. The app uses a piecewise-linear
  curve over the output's target value (values 1/100/1k/10k/1M → 3/6/12/24/60 s and
  1/20/200/1.5k/10k P/s). This reproduces every fixed cauldron recipe time in the game data.
  Advanced cauldrons use the same curve.
- Thermal Extractor output grows with the height it's built at (the inspect panel's "Height", set
  per tree row): × (1 + height / 128), up to ×3 (from `UExtractFacilityComponent` in the game
  binary). Alchemy Skill multiplies Extractor/Alembic output.
- Recipe outcomes follow each recipe's `ProductSequence` (0 = product, k = fail product k; e.g.
  Steel [1,1,1,0] = 75% fail), averaged per craft.
- Advanced Athanor: it runs Athanor recipes with the standard Athanor's heat, as its description
  says. Catalysts are toggled per tree row. Unstable uses `UnstableSequence`, Fertile doubles every
  output, Resonant yields every product each craft, and Eternal consumes no materials. Each
  catalyst uses the recipe's `CatalystCost` charges per craft, out of 180 / 240 / 1500 / 99999
  charges per item. Those counts come from an int32 table in the game executable. Catalysts are belt
  inputs, so they count against the Advanced Athanor's 3 input belts.
- Nursery: one plant costs its seed's nutrient value. Growth speed = the fertilizer's nutrient speed.
- Fuel Efficiency multiplies the heat obtained from burned fuel. Steam isn't a fuel: a Steam Boiler
  draws 20 P of heat per Steam from the fuel burned under it, and a Steam Heating Pad turns each
  Steam back into 20 P, with no Fuel Efficiency. Boiler settings are native code
  (`USteamBoilerComponent::SetBoilingPower`): Low 30 Steam / 6 s, Medium 100 / 4 s, High 300 / 2 s,
  so 100 / 500 / 3000 P/s, scaled by Factory Efficiency. The planner shows how many boilers on
  each setting would carry the plan's heat.
- Bank Portal (`UBankFacilityComponent`, native code): it converts any coin into another. Each belt
  entry adds its coins' value to a buffer. Whenever the buffer holds a stack's worth of the output
  coin, it puts one stack on its belt and keeps the remainder, so no value is lost. The stack size is
  the panel's "Conversion Amount", set per tree row: 1–50, 1 in a new portal, 50 in the planner. It
  has no craft time, heat or Factory Efficiency, so only its belts limit it. Its output belt carries
  one stack per slot, and its input belt carries full stacks of 50. Changing coins up (silver → gold)
  is held back by the input belt, and breaking them down by the output belt. It's offered as a way
  to make coins, but never picked by default: coins are a plan input. A row fed by Bank Portals set
  below 50 takes their smaller stacks. Its input belts carry fewer coins, and a Paradox Crucible gets
  less value per entry, so it runs slower. The row says so. Same-coin conversion isn't offered: it
  would only throttle the belt.
- Knowledge Altar (`UShrineFacilityComponent`, native code): it breaks down whatever its one input
  belt brings, for EXP. Any item gives 0.0002 × `BaseCost` EXP over 0.1676 × `BaseCost`^0.518 s, one
  unit per cycle (a bundle item is that many units: a log is 200). The seven planets (relics) have
  fixed cycles from a table in the game binary. Each cycle takes a fifth of a planet, e.g. 15 of
  Mars's 75 units for 25.2 EXP in 24 s, and only relics get the Relic Knowledge upgrade (+10% per
  level). Cycle times scale with Factory Efficiency. "Outputs" shows each output's EXP/min
  and how many altars it would take (a belt each), once the plan's research tier has the altar (V).
  Liquids can't reach it.

### Money, fuel and fertilizer

These are the factory's base resources, usually brought in from elsewhere in the factory. The planner never expands the
production chain of the preferred fuel or fertilizer. It reports how much the plan needs. With
"feed back" on, the plan's own output of that item covers the need first, and the net surplus or
shortfall is shown. Other raw inputs are bought at purchasing portals. Their price is the item's
`StockCost` (1 silver = 1,000 copper, 1 gold = 100 silver). Bulk raw materials are bundles: one Iron
Ore costs 1,200 copper and smelts into 100 ingots.

### Conveyor logistics

Belt speed is `ConveyerSpeed` (60/min base) plus the Logistics Efficiency upgrade. Machine ports
come from each building's `InOutList`. Belts connect per side, so the Arcane Processor's single
three-sided cell is three inputs. Pipe cells carry liquids, which are left out of the belt check.
Coins ride belts in stacks: machines and containers (and plan inputs) emit full stacks of 50. A Bank
Portal's stacks are its row's "Conversion amount" (1–50).

- **Outputs:** machines throttle to what their output belts carry. This was observed in game: a
  Redcurrant nursery on Fertile Catalyst reports exactly 75/min at Logistics 1 and 90/min at
  Logistics 2. The cap is built into machine counts and "machines" targets, and there's no warning.
- **Inputs:** each ingredient is fed on its own belt(s), so the Shaper's 6 inputs can take
  Plank ×2 + Gear ×3 + Pulley ×1. When the ingredients need more belts than the machine has, it
  runs starved. The planner warns and reports how many machines that takes.
- Factory Efficiency and Logistics Efficiency scale by the same proportion per level. With equal
  levels no recipe is input-starved; starvation only appears when Factory Efficiency is ahead.
