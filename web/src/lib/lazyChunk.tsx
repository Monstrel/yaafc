import { use, type ComponentType } from 'react'

/**
 * A component whose code downloads the first time it's shown, or earlier through `preload` (say,
 * when the pointer reaches a link to it). Until then it suspends; once downloaded it shows at once,
 * with no placeholder in between. A deploy replaces every chunk, so a tab opened before one can't
 * fetch the old chunks any more: it shows `Failed` instead, which offers a reload.
 */
export function lazyChunk<P extends object>(load: () => Promise<ComponentType<P>>, Failed: ComponentType<P>) {
  let loaded: ComponentType<P> | undefined
  let loading: Promise<unknown> | undefined
  const preload = () =>
    (loading ??= load().then(
      (c) => (loaded = c),
      () => (loaded = Failed),
    ))
  function Lazy(props: P) {
    if (!loaded) use(preload())
    const Loaded = loaded!
    return <Loaded {...props} />
  }
  return Object.assign(Lazy, { preload })
}
