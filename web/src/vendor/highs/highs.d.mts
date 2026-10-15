// Types for the LP-only HiGHS built by tools/highs (see its README), borrowed from the highs package
// it's built from. Only the package's original solve() API is there: the build leaves out the C
// functions behind the rest, which fail if called.
import type { InitOptions, LegacyHighs } from 'highs'

export default function highsLoader(options?: InitOptions): Promise<LegacyHighs>
