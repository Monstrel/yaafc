import { useNoticeable } from '../lib/useNoticeable'
import { Spinner } from './Spinner'

/** Holds a page's place while its code downloads, with a spinner once that's slow. */
export function PageLoading() {
  const slow = useNoticeable(true)
  return <div className="page-loading">{slow && <Spinner label="Loading the page" />}</div>
}
