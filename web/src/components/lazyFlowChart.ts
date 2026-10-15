import { lazyChunk } from '../lib/lazyChunk'
import { DialogFailed } from './ChunkFailed'

// The planner's flow chart is heavy and opened from a row now and then: it downloads when first wanted.
export const FlowChartView = lazyChunk(() => import('./FlowChartView').then((m) => m.FlowChartView), DialogFailed)
