/**
 * Built-in diagnosis presets, ported from packages/pwa/state.js in the
 * previous implementation. Orgs override the flat list through the
 * `customDxPresets` config key; hiding individual entries goes through
 * hiddenPresets.diagnoses (by name).
 */
import type { DxPreset } from '../types'

export const DX_PRESETS: DxPreset[] = [
  'Malaria', 'URTI', 'Pneumonia', 'UTI', 'PUD/GERD', 'Typhoid', 'Cellulitis', 'MSK Pain',
  'Allergic Reaction', 'H. pylori', 'Scabies', 'Tinea/Fungal', 'Candidiasis', 'Viral URTI',
  'GC/Chlamydia', 'Syphilis', 'HIV', 'Hypertension',
  'Diabetes', 'Pregnancy', 'Helminth Infection', 'Nutritional Deficiency',
  'Dental Pain', 'Mental Health', 'Conjunctivitis', 'Otitis Media', 'PID',
  'Gastroenteritis', 'Dehydration', 'Asthma/Wheeze', 'Abscess',
]

/** System grouping for the "by system" sort mode. */
export const DX_SYSTEMS: Record<string, string[]> = {
  Infectious: ['Malaria', 'Typhoid', 'Helminth Infection'],
  Respiratory: ['URTI', 'Viral URTI', 'Pneumonia', 'Asthma/Wheeze'],
  GI: ['PUD/GERD', 'H. pylori', 'Gastroenteritis', 'Dehydration'],
  Skin: ['Cellulitis', 'Scabies', 'Tinea/Fungal', 'Candidiasis', 'Abscess'],
  'GU/STI': ['UTI', 'GC/Chlamydia', 'Syphilis', 'PID'],
  MSK: ['MSK Pain'],
  Allergy: ['Allergic Reaction'],
  'ENT/Eye': ['Conjunctivitis', 'Otitis Media', 'Dental Pain'],
  Chronic: ['HIV', 'Hypertension', 'Diabetes'],
  'OB/GYN': ['Pregnancy'],
  Other: ['Nutritional Deficiency', 'Mental Health'],
}

/** Which Rx presets a selected diagnosis suggests. Keys and values are preset NAMES. */
export const DX_TO_RX_MAP: Record<string, string[]> = {
  Malaria: ['Malaria'],
  URTI: ['URTI/Pneumonia', 'Viral URTI'],
  Pneumonia: ['URTI/Pneumonia'],
  UTI: ['UTI'],
  'PUD/GERD': ['PUD/GERD', 'H. pylori Triple Therapy'],
  'H. pylori': ['H. pylori Triple Therapy'],
  Cellulitis: ['Skin/Cellulitis'],
  Abscess: ['Skin/Cellulitis'],
  'MSK Pain': ['MSK Pain'],
  'Allergic Reaction': ['Allergic Reaction'],
  'Tinea/Fungal': ['Tinea/Fungal'],
  Candidiasis: ['Candidiasis'],
  'Viral URTI': ['Viral URTI'],
  'GC/Chlamydia': ['GC/Chlamydia'],
  PID: ['GC/Chlamydia'],
  Syphilis: ['Syphilis RPR+'],
  Typhoid: ['Typhoid'],
  Pregnancy: ['Pregnancy Pack'],
  'Helminth Infection': ['Anti-helminthic'],
  Gastroenteritis: ['Anti-helminthic'],
  Dehydration: ['Vitamin Therapy'],
}
