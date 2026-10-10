# Row sourcing redesign

Status: draft for review, 2026-10-10. Replaces the cost-and-cap rules that decide where each row's
supply comes from with an explicit priority order.

## Why

A Gold Dust plan asked for Crude Silver Powder as a plan input. The planner has two habits that
together made that happen:

- An item made only by failed crafts gets no recipe by default ("aren't run for: they're reused,
  else brought in", `defaultProducer` in processes.ts), and a row with no recipe silently takes its
  item from plan inputs (`resolveChoice` in unfold.ts).
- Who gets a row's outputs is settled by costs, caps measured in extra trial solves (`overflowShare`,
  `localShare`, `held.shares`), and the "only excess" constraints. Here the recovery cap was
  measured in a trial solve with no recovery and was wrong once recovery slowed the Athanors.

A first stopgap (an extra LP stage putting direct users before recovery, uncommitted) contradicts
the locality rule below and should be dropped in favor of this design.

## Rules

1. **All outputs are equal.** The planner never treats a recipe's main product differently from
   its side or failed outputs. Any recipe that outputs an item is a way to make that item.
2. **Locality.** Branches and loops resolve close to where they start. A row's outputs go to its
   own recovery first; only what that can't take goes to other rows, usually further away.
3. **Leftovers before anything else.** A row takes leftovers from other rows (nearest first) before
   importing or making its item. Unused leftovers stall machines.
4. **Declared inputs only.** Money, fuel and fertilizer are always available. That's per use, not
   per item: a row that pays with coins, burns a fuel or spreads a fertilizer (a row under a Money,
   Heat or Nutrients row, `isBurned` in unfold.ts) keeps today's per-row choice between outside
   and made in the plan, and heat networks keep their source picks. Coke Powder burned under a Steel
   Athanor can come from outside while its Coke Powder ingredient is made. Other items come from
   outside only when the player declares them as plan inputs, or feeds back a plan output.
   An item the plan can't make that isn't declared is a shortfall, shown as one.
5. **Inputs are per item.** A declared item is imported wherever the plan uses it (after
   leftovers), never also made by a recipe there. A target's own row always makes its item: the
   target is what the plan makes. Declaring an item that loops back into its own chain cuts the loop
   there (the inner rows import it).
6. **Caps size only "as much as possible" targets.** For rate, net or machine-count targets the plan
   takes what it needs, and a warning shows how far past the cap it goes.
7. **One recipe per row.** A row has one configured recipe; leftovers and recovery can cover part
   of it.
8. **Rows run for the row they feed.** A row's machines run only as hard as the row above it needs,
   after leftovers and recovery. Other rows take what's left over and never make it run harder.
   This is the old "only excess" rule restated without "main product".
   Exceptions as today: rows held to whole machines (round-up floors) or to their crafts for
   overflow and supply targets, and rows running the same process.

Hidden recipes (`hidden: true` in the game data) stay out of the planner.

## Where a row's supply comes from

In order, for each row:

| # | Source | Notes |
|---|---|---|
| 1 | Its own recovery | Chains turning the row's own outputs back into its item |
| 2 | Leftovers of other rows | Nearest first in the tree (tie-break, not strict) |
| 3 | Plan input or fed-back output | Only if the item is declared or fed back |
| 4 | Its recipe | Only if the item isn't declared as an input |
| 5 | Shortfall | Flagged, with a way to declare the item as an input |

From each output's side, the order is: the row's own recovery, then other rows that use the item
(nearest first), then other rows' recovery, then overflow (warned in the output panel).

## Solver

Keep the LP over tree rows. Replace the caps and trial solves with priority stages, each solved and
then held at its optimum (the existing shortfall stage already works this way):

1. **Shortfalls.** Minimize the depth-weighted shortfall (unchanged).
2. **Own recovery** (`leaving`). Minimize what leaves a row (to other rows or overflow) of an output
   its own recovery chain could take.
3. **Direct users before other rows' recovery** (`spill`). Minimize leftovers going to other rows'
   recovery or overflowing. A row's own surplus counts 1000 times, so no row runs harder (or takes
   more than it needs) to soak leftovers up.
4. **Costs.** Crafts, imports, and the distance tie-break for nearest-first. Leftovers cost almost
   nothing to take here (their source runs no harder for them), so rows take them before importing
   or making their item.

Rule 8 stays a hard constraint, as the `ex:`/`e:` rows are now, but applies to every output.

Built (step 1, branch `row-sourcing`). Differences from the first draft:
- The draft's "unused leftovers" stage counted items, so turning 2 leftover items into 1 unused one
  looked like progress: it ran machines whose every output was left over. Stage 3 above replaces
  it; stage 4 covers "leftovers before importing or making".
- Each held stage leaves the solver a little room (about one millionth). Flows, recovery and
  overflow smaller than that room are treated as noise in what the tree shows; balances keep the
  raw numbers.
- Gentian Nectar with a Gentian target: the Nectar row now runs its own Gentian nurseries and
  overflows their Gentian, rather than the Gentian row running extra for the Nectar (rule 8).

Removed: the `overflowShare` and `localShare` trial solves, `held.shares`, the `firstTaken` stage,
`contested`/`strays`, the `failOnly` producer list and the "aren't run for" default exception,
import columns on rows of undeclared items, and shortfall-past-cap pricing of capped inputs.

Stages 2 and 3 cost one LP solve each; they replace up to two trial solves per round, so solve time
should be about the same or better.

### Rows of declared items

A declared item's rows have no recipe: leftovers, then the import. Undeclared rows have no import
column at all. A cap adds no constraint unless a supply target uses that input; after the solve,
`drawn − cap` gives the warning amount.

## Worked example: 10 Gold Dust a minute

25 Gold Dust Athanor crafts a minute need 25 Silver Powder and 450 Mercury; Mercury needs 45 Crude
Silver Powder. Silver Powder crafts yield 20% Silver Powder, 80% Crude Silver Powder.

- **Silver Powder row** (under Gold Dust): its own recovery takes all its Crude Silver Powder and
  refines it back up (4 Crude make 1 Silver Powder). It also gets Silver Powder left over from the
  Mercury branch (below). It runs 34.4 crafts a minute at 0.4 Silver Powder a craft: 13.75 of its own plus 11.25 left
  over from Mercury's branch makes the 25 needed.
- **Crude Silver Powder row** (under Mercury): no leftovers reach it, so its recipe runs: the same
  Silver Powder recipe, 56.25 crafts a minute for 45 Crude. Its 11.25 Silver Powder are leftovers
  and go to the nearest row using them, the Silver Powder row above.

Total 90.6 crafts a minute (the same as today's stopgap), in two groups of Athanors, with Silver
Powder crossing between branches instead of Crude Silver Powder. No plan input, no shortfall.
Whether the two groups are built apart or together is the player's call, with the planner's
existing "build separately" grouping.

## Plans this could break

- **Self-feeding fertilizer (Fertile Catalyst from a saved cauldron recipe, spread by its own
  nurseries).** Unaffected: the nurseries' Fertile Catalyst is a fertilizer use (rule 4), from
  outside or covered by feeding the target back, as today; the target row still makes it (rule 5).
  The engine.test.ts "a loop where a saved cauldron recipe makes its own fertilizer" tests should
  pass unchanged.
- **Recipes that output their own input** (Steel Ingot returns Iron Ingot; Lapis Lazuli returns
  Shattered Crystal). Unaffected: the returned item is the row's own leftover, taken first.
- **The same item from outside in one branch and made in another.** This is the real loss. Today a
  player can take Iron Ingot from outside under one row and make it under another; per-item inputs
  can't say that, and a cap no longer means "import this much, make the rest" (that never existed
  past a cap anyway: it was a shortfall). The fallback is a separate plan for the part made from
  outside.

## Plan model and migration

- `Plan.inputs: Record<item, { cap?: number }>` replaces per-row `'bus'` picks (`branches[...]`,
  `producers[item] === 'bus'`) and `busSupply`.
- Migration: `producers[item] === 'bus'` and every item with a branch `'bus'` pick become declared
  inputs; `busSupply[item]` becomes that input's cap. (Open question below.)
- Fuel, fertilizer and coin rows keep coming from outside by default; "make in plan" stays as it is.

## Interface

- The row's recipe menu loses "From the plan inputs". The plan inputs panel gains "Add an input"
  (item picker), and each input line keeps its cap box.
- A row of a declared item shows as an input row, as now.
- A shortfall row for an item nothing can make offers "Take it from plan inputs" (one click, one
  undo step).
- Cap warnings sit on the input line: "needs 45/min, 30/min available".

## Tests that encode old rules

These change on purpose:

- engine.test.ts "lets a row make its own instead of reusing a by-product, and go back"
  (Impure Copper Powder defaulting to plan inputs).
- engine.test.ts "takes any row from the bus instead of making it", "lets rows take up to what the
  bus carries, and falls short past it", and other per-row bus-pick tests.
- recovery.test.ts "never runs a row harder to feed another item's recovery" (numbers move under
  rule 1, intent stays).
- recovery.test.ts "feeds the rows using it first" (the stopgap's test) becomes the worked example.

Found while trying rule 1 alone on today's code: the overflow-target test "takes only what the rest
of the plan leaves once it has recovered what it can" became infeasible. Rows were held to crafts
measured with recovery shares that no longer fit. That machinery goes away here, and the test
should pass under the new stages. The Sol "every fuel" test only got slower (about 5.4 s against a
5 s limit), from more recovery chains now that more rows have leftovers.

## Steps

1. Solver stages and rule 1 together (rule 1 alone breaks the held-crafts machinery). Done.
2. Declared inputs: plan model, migration, no import on undeclared rows, shortfalls instead. Done:
   a declared input is `producers[item] = 'bus'` (`isInput` in unfold.ts, which also reads plans
   saved with per-row picks; `migrateInputs` moves those when the plan opens). Picking "Plan input"
   on a row declares the item; picking a recipe on a row of a declared item makes it everywhere.
   Rows paying, burning or spreading keep per-row picks; a target's own row always makes its item.
   An item nothing makes and the plan doesn't take in is a shortfall row (`unsupplied`) with a
   "Take it in as a plan input" action. Caps bind only for supply targets; elsewhere the ledger's
   `overCap` warns. Not done: flagging a migrated plan once, and an "Add an input" picker in the
   inputs panel (rows' menus declare inputs instead).
3. Interface: inputs panel, shortfall action, cap warnings; recipe menu without plan inputs.
4. Changelog, then deploy.

## Decided

- **Migrating per-row plan-input picks:** picks under Money, Heat and Nutrients rows stay as they
  are (rule 4). For other items, the item becomes a declared input, even where other rows of it
  were making it; the plan is flagged once and the changelog says so. Losing "from outside in one
  branch, made in another" is accepted.
- **The "reuse by-products first" switch is gone.** Rows always take leftovers first. The opt-out
  is at the source: a row can send one of its other outputs to Knowledge Altars as it comes out
  (`Plan.altarOutputs`). Nothing else takes it then, its own recovery included, so rows using the
  item make their own. This is the in-game choice of not building a complex by-product route.
  Built on the branch with step 1.
