A Purchasing Portal buys the item it's set to with the coins fed into it. It takes any mix of
[copper](item:CopperCoin), [silver](item:SilverCoin) and [gold](item:GoldCoin), adding up their
value, and takes more only while it holds less than the item's price. Once it holds the price, it
pays, keeps the change, and puts one of the item on its belt. Nothing is lost, and there's no
limit on how much it can buy.

It takes no time, heat or Factory Efficiency. Its belts are its only limit: one belt entry of
coins in, one purchase out, per belt slot. Coins travel 50 to an entry, so **the coin you pay
with sets its speed**:

- [Iron Ore](item:IronOre) costs 1,200 copper. An entry of 50 copper pays for 1/24 of one, so a
  portal paid in copper buys 2.5 Iron Ore a minute at base Logistics Efficiency.
- An entry of 50 silver pays for 41 at once, and the portal works through them before it takes
  more coins: its output belt sets the pace, 60 a minute.

Bulk items come whole: one purchase of [Logs](item:Wood) is one Logs item, which a [Table Saw](machine:TableSaw)
cuts into 200 Planks.
