Some Athanor recipes fail part of the time, giving back something else instead:
[Steel Ingots](item:SteelIngot), for one, give [Iron Ingots](item:IronIngot) three crafts out of
four. The product leaves by its first output, the one with the gold arrow; failed products leave
by the other.

## Failures aren't random

Each of these recipes has a fixed pattern of outcomes, and the Athanor works through it in order,
one step per craft, then starts it again. Steel Ingot's pattern is fail, fail, fail, succeed: the
fourth craft of every four is the Steel. Choosing a recipe starts its pattern from the beginning.
Over time, the shares match the pattern: 25% Steel, 75% Iron Ingots.

The [Advanced Athanor](machine:AdvancedAthanor) runs these recipes too, and can change their
outcomes with catalysts.
