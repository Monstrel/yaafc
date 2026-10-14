An Advanced Athanor runs every [Athanor](machine:Athanor) recipe, at the Athanor's heat cost, as
well as recipes of its own. Like the Athanor, recipes that fail part of the time work through a
fixed pattern of outcomes, one step per craft, rather than failing at random.

It's the only machine catalysts work in. Load them with the ingredients, and they change what each
craft of a recipe that can fail gives.

## The four catalysts

- [Unstable Catalyst](item:Catalyst1): the recipe follows a second pattern instead. It isn't
  always better (see below).
- [Fertile Catalyst](item:Catalyst2): every product of the craft comes out twice over.
- [Resonant Catalyst](item:Catalyst3): every craft gives the product **and** every failed
  product.
- [Eternal Catalyst](item:Catalyst4): the craft uses no ingredients.

Catalysts work together: load several, and every one applies to each craft. Resonant and Fertile
together give every outcome, twice.

## Charges

A catalyst isn't used up all at once. Each one holds charges (Unstable 180, Fertile 240, Resonant
1,500, Eternal 99,999), and each craft of a recipe spends that recipe's charge cost from every
catalyst applied to it: from 1 a craft for Coke up to 1,000 for Gold Dust. Each kind keeps its own
charges, using a new item when they run low. A catalyst the Advanced Athanor doesn't hold enough of
for a craft sits that craft out, spending nothing, and the craft runs without it.

## What Unstable does to each recipe

The share of crafts giving the product, normally → with an Unstable Catalyst:

- [Coke](item:Coke) (1 charge): 50% → 75%; the rest is Charcoal.
- [Salt](item:Salt) (2): 33% → 67%; the rest is Sand.
- [Steel Ingot](item:SteelIngot) (4): 25% → 50%; the rest is Iron Ingots.
- [Copper Powder](item:CopperPowder2) (18): 50% → **0%**: every craft gives
  [Impure Copper Powder](item:CopperPowder).
- [Malachite](item:Malachite) (36): 50% → 100%; no more Crude Shards.
- [Silver Powder](item:SilverPowder3) (150): 20% → 50%; the rest is Crude Silver Powder.
- [Obsidian](item:Obsidian) (420): 50% → 100%; no more Marble.
- [Lapis Lazuli](item:LapisLazuli) (550): 33% → 50%; the rest is Shattered Crystals, and no more
  Crude Shards.
- [Gold Dust](item:GoldDust3) (1,000): 10% → 20%; the rest is Impure Gold Dust, and no more Crude
  Gold Dust.
