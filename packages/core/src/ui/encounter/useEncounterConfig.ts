/**
 * The org's synced configuration as the encounter form consumes it: sites,
 * providers, formulary, lab panel, procedures, referral destinations and
 * complaint pills.
 *
 * Read through the kernel config KV so the form sees exactly what the sync
 * engine wrote, with the documented fallback chain (src/config): the kernel
 * returns null for a key the org has never customized, and the built-in
 * defaults apply. Without those fallbacks the Site select is empty, which
 * blocks every save, and the formulary is empty, which blocks all prescribing.
 */
import { useEffect, useState } from 'react'
import { config as configKv } from '../../kernel'
import { getConfig, resolveFormulary, resolveStringList, visiblePresets } from '../../config/keys'
import { resolveStations } from '../../domain/flow'
import type { CustomLabTest, FormularyEntry, HiddenPresets } from '../../config/types'
import { resolveLabTests, visibleLabTests } from '../../config/defaults/labTests'
import {
  DEFAULT_COMPLAINTS,
  DEFAULT_PHYSICIANS,
  DEFAULT_PROCEDURES,
  DEFAULT_REFERRAL_TYPES,
  DEFAULT_SITES,
  defaultHiddenPresets,
} from '../../config/defaults/lists'

export interface EncounterConfig {
  sites: string[]
  providers: string[]
  formulary: FormularyEntry[]
  labTests: CustomLabTest[]
  procedures: string[]
  referralTypes: string[]
  complaints: string[]
  /** The board's station list (Clinic): decides who may enter lab results. */
  stations: string[]
  loading: boolean
}

const EMPTY: EncounterConfig = {
  sites: [],
  providers: [],
  formulary: [],
  labTests: [],
  procedures: [],
  referralTypes: [],
  complaints: [],
  stations: resolveStations(null),
  loading: true,
}

export function useEncounterConfig(): EncounterConfig {
  const [cfg, setCfg] = useState<EncounterConfig>(EMPTY)

  useEffect(() => {
    let alive = true
    void (async () => {
      let next: EncounterConfig
      try {
        const [sites, providers, formulary, labTests, procedures, referralTypes, complaints, hiddenStored, stations] =
          await Promise.all([
            getConfig(configKv, 'sites'),
            getConfig(configKv, 'providers'),
            getConfig(configKv, 'formulary'),
            getConfig(configKv, 'customLabTests'),
            getConfig(configKv, 'procedures'),
            getConfig(configKv, 'referralTypes'),
            getConfig(configKv, 'complaints'),
            getConfig(configKv, 'hiddenPresets'),
            getConfig(configKv, 'flowStations'),
          ])
        // A never-customized org still hides the default-off lab tests, the
        // way the legacy first run seeded hiddenPresets.
        const hidden: HiddenPresets = hiddenStored ?? defaultHiddenPresets()
        next = {
          sites: resolveStringList(sites, DEFAULT_SITES),
          providers: resolveStringList(providers, DEFAULT_PHYSICIANS),
          formulary: resolveFormulary(formulary),
          labTests: visibleLabTests(resolveLabTests(labTests), hidden),
          procedures: visiblePresets(
            resolveStringList(procedures, DEFAULT_PROCEDURES),
            hidden,
            'procedures',
          ),
          // The referral select hardcodes its leading 'None' option, so the
          // stored list's own 'None' entry must not render twice.
          referralTypes: visiblePresets(
            resolveStringList(referralTypes, DEFAULT_REFERRAL_TYPES),
            hidden,
            'referralTypes',
          ).filter((r) => r !== 'None'),
          complaints: visiblePresets(
            resolveStringList(complaints, DEFAULT_COMPLAINTS),
            hidden,
            'complaints',
          ),
          stations: resolveStations(stations),
          loading: false,
        }
      } catch {
        // A failed config read must not brick the form: fall back to the
        // built-in defaults, exactly like a never-customized device.
        next = {
          sites: [...DEFAULT_SITES],
          providers: [...DEFAULT_PHYSICIANS],
          formulary: resolveFormulary(null),
          labTests: visibleLabTests(resolveLabTests(null), defaultHiddenPresets()),
          procedures: [...DEFAULT_PROCEDURES],
          referralTypes: DEFAULT_REFERRAL_TYPES.filter((r) => r !== 'None'),
          complaints: [...DEFAULT_COMPLAINTS],
          stations: resolveStations(null),
          loading: false,
        }
      }
      if (alive) setCfg(next)
    })()
    return () => {
      alive = false
    }
  }, [])

  return cfg
}
