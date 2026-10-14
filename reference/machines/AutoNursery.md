A Nursery grows the plant of the seed it's set to, from fertilizer alone. The seed is only its
setting: it isn't used up, and changing the setting gives it back. (A
[Seed Plot](machine:SeedPlot), worked by hand, uses its seed up.)

## How fertilizer works

Every plant needs a fixed number of nutrients, shown in its recipe below: 24 for
[Flax](item:Flax), 2,160 for [Lavender](item:Lavender). Fertilizer is where those nutrients come
from, and each kind has two separate numbers:

- **Nutrients**: how many nutrients one item supplies. This decides how much fertilizer a plant
  uses. Fertilizer Efficiency raises it.
- **Speed**: how many nutrients a second the Nursery turns into plant while it runs on that
  fertilizer. This decides how fast plants grow. Factory Efficiency raises it.

So a better fertilizer doesn't only last longer: it makes the Nursery grow faster. At base
upgrades:

- Flax on [Basic Fertilizer](item:BasicFertilizer) (144 nutrients, 12/s) grows one every 2
  seconds, 30 a minute, using 5 Basic Fertilizer a minute.
- Flax on [Advanced Fertilizer](item:AdvancedFertilizer) (720 nutrients, 144/s) could grow 360 a
  minute, but a Nursery never outpaces its output belt, so it grows 60, using 2 Advanced
  Fertilizer a minute.
- Lavender on Basic Fertilizer takes 3 minutes a plant and 15 Basic Fertilizer each. On
  [Growth Potion](item:GrowthPotion) (6,480 nutrients, 2,160/s) it grows one a second, using 20
  Growth Potions a minute.

How much fertilizer a plant uses depends only on the plant and the fertilizer's nutrients, never
on the speed: a faster fertilizer only gets the same nutrients in sooner.

## Mixing fertilizers

A Nursery uses its fertilizer one item at a time: when it needs more nutrients, it takes one item
and runs at that item's speed until its nutrients are spent. So it can be fed several kinds, and
each runs at its own speed while it lasts.

## By-products

[Gentian](item:Gentian) grows [Gentian Nectar](item:GentianNectar) too. A Nursery growing it
strictly alternates one Gentian, one Gentian Nectar, and each costs a full plant's nutrients.
