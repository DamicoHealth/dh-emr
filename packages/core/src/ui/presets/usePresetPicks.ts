/**
 * The org's Dx quick-picks and Rx presets as the encounter form consumes them:
 * resolved through the kernel config KV (so synced org config is honored),
 * fallen back to the vendored defaults, and filtered by hiddenPresets.
 *
 * Mirrors useEncounterConfig's read discipline: a failed config read must not
 * brick the form, so errors fall back to the defaults a never-customized
 * device runs on.
 */
import { useEffect, useState } from 'react'
import { config as configKv } from '../../kernel'
import { getConfig } from '../../config/keys'
import { defaultHiddenPresets } from '../../config/defaults/lists'
import type { HiddenPresets, RxPreset } from '../../config/types'
import {
  resolveDxPresets,
  resolveRxPresets,
  visibleDxPresets,
  visibleRxPresets,
} from './presetsModel'

export interface PresetPicks {
  dxPresets: string[]
  rxPresets: RxPreset[]
  loading: boolean
}

const EMPTY: PresetPicks = { dxPresets: [], rxPresets: [], loading: true }

export function usePresetPicks(): PresetPicks {
  const [picks, setPicks] = useState<PresetPicks>(EMPTY)

  useEffect(() => {
    let alive = true
    void (async () => {
      let next: PresetPicks
      try {
        const [dxStored, rxStored, hiddenStored] = await Promise.all([
          getConfig(configKv, 'customDxPresets'),
          getConfig(configKv, 'rxPresets'),
          getConfig(configKv, 'hiddenPresets'),
        ])
        const hidden: HiddenPresets = hiddenStored ?? defaultHiddenPresets()
        next = {
          dxPresets: visibleDxPresets(resolveDxPresets(dxStored), hidden),
          rxPresets: visibleRxPresets(resolveRxPresets(rxStored), hidden),
          loading: false,
        }
      } catch {
        const hidden = defaultHiddenPresets()
        next = {
          dxPresets: visibleDxPresets(resolveDxPresets(null), hidden),
          rxPresets: visibleRxPresets(resolveRxPresets(null), hidden),
          loading: false,
        }
      }
      if (alive) setPicks(next)
    })()
    return () => {
      alive = false
    }
  }, [])

  return picks
}
