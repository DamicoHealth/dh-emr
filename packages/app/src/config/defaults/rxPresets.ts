/**
 * Built-in prescription presets, ported from packages/pwa/state.js
 * (RX_PRESETS) in the previous implementation. Orgs override through the
 * `rxPresets` config key; sync carries the full list.
 *
 * The '\u00d7' escapes are the multiplication sign in the legacy rx strings;
 * they are kept as escapes so the stored values stay byte-identical.
 */
import type { RxPreset } from '../types'

export const RX_PRESETS: RxPreset[] = [
  { name: 'H. pylori Triple Therapy', rx: 'Amoxicillin 1g q12h 14d + Metronidazole 400mg q12h 14d + Omeprazole 20mg q12h 14d', meds: [
    { medId: 'abx-amox500', dose: '1g', freq: 'q12h', duration: '14d' },
    { medId: 'abx-metro', dose: '400mg', freq: 'q12h', duration: '14d' },
    { medId: 'gi-omep', dose: '20mg', freq: 'q12h', duration: '14d' },
  ] },
  { name: 'Malaria >35kg', rx: 'Artefan 4 tabs PO q12h \u00d7 3d', meds: [
    { medId: 'am-artefan', dose: '4 tabs', freq: 'q12h', duration: '3d' },
  ] },
  { name: 'Malaria 25-35kg', rx: 'Artefan 3 tabs PO q12h \u00d7 3d', meds: [
    { medId: 'am-artefan', dose: '3 tabs', freq: 'q12h', duration: '3d' },
  ] },
  { name: 'Malaria 15-25kg', rx: 'Artefan 2 tabs PO q12h \u00d7 3d', meds: [
    { medId: 'am-artefan', dose: '2 tabs', freq: 'q12h', duration: '3d' },
  ] },
  { name: 'Malaria 5-15kg', rx: 'Artefan 1 tab PO q12h \u00d7 3d', meds: [
    { medId: 'am-artefan', dose: '1 tab', freq: 'q12h', duration: '3d' },
  ] },
  { name: 'GC/Chlamydia', rx: 'Ceftriaxone 500mg IM once + Azithromycin 1g PO once', meds: [
    { medId: 'abx-ceftri', dose: '500mg', freq: 'once', duration: 'Single dose' },
    { medId: 'abx-azithro1g', dose: '1g', freq: 'once', duration: 'Single dose' },
  ] },
  { name: 'Syphilis RPR+', rx: 'Benzathine Penicillin 2.4MU IM once + Doxycycline 100mg q12h 14d', meds: [
    { medId: 'abx-benza', dose: '2.4MU', freq: 'once', duration: 'Single dose' },
    { medId: 'abx-doxy', dose: '100mg', freq: 'q12h', duration: '14d' },
  ] },
  { name: 'Anti-helminthic', rx: 'Albendazole 400mg PO once', meds: [
    { medId: 'ap-alben', dose: '400mg', freq: 'once', duration: 'Single dose' },
  ] },
  { name: 'Vitamin Therapy', rx: 'Multivitamin 1 tab PO q24h \u00d7 14d', meds: [
    { medId: 'vit-multi', dose: '1 tab', freq: 'q24h', duration: '14d' },
  ] },
  { name: 'Corticosteroid Joint Injection', rx: 'Lidocaine 2% 2ml + Dexamethasone 8mg', meds: [
    { medId: 'sp-lido', dose: '2ml', freq: 'once', duration: 'Single dose' },
    { medId: 'as-dexa', dose: '8mg', freq: 'once', duration: 'Single dose' },
  ], notes: 'Corticosteroid joint injection performed' },
  { name: 'Pregnancy Pack', rx: 'Prenatal Vitamins 1 tab PO q24h ongoing', meds: [
    { medId: 'vit-prenatal', dose: '1 tab', freq: 'q24h', duration: 'Ongoing' },
  ] },
  { name: 'PUD/GERD', rx: 'Omeprazole 20mg PO q12h \u00d7 14d', meds: [
    { medId: 'gi-omep', dose: '20mg', freq: 'q12h', duration: '14d' },
  ] },
  { name: 'UTI', rx: 'Nitrofurantoin 100mg PO q12h \u00d7 7d', meds: [
    { medId: 'abx-nitro', dose: '100mg', freq: 'q12h', duration: '7d' },
  ] },
  { name: 'URTI/Pneumonia', rx: 'Amoxicillin 500mg PO q8h \u00d7 7d', meds: [
    { medId: 'abx-amox500', dose: '500mg', freq: 'q8h', duration: '7d' },
  ] },
  { name: 'Skin/Cellulitis', rx: 'Cephalexin 250mg PO q8h \u00d7 7d', meds: [
    { medId: 'abx-ceph', dose: '250mg', freq: 'q8h', duration: '7d' },
  ] },
  { name: 'Tinea/Fungal', rx: 'Griseofulvin 500mg PO q24h \u00d7 14d', meds: [
    { medId: 'af-griseo', dose: '500mg', freq: 'q24h', duration: '14d' },
  ] },
  { name: 'Candidiasis', rx: 'Fluconazole 150mg PO once', meds: [
    { medId: 'af-fluco', dose: '150mg', freq: 'once', duration: 'Single dose' },
  ] },
  { name: 'Typhoid', rx: 'Ciprofloxacin 500mg PO q12h \u00d7 7d', meds: [
    { medId: 'abx-cipro', dose: '500mg', freq: 'q12h', duration: '7d' },
  ] },
  { name: 'Allergic Reaction', rx: 'Cetirizine 10mg PO q24h 7d + Prednisolone 5mg PO q24h 5d', meds: [
    { medId: 'as-cetir', dose: '10mg', freq: 'q24h', duration: '7d' },
    { medId: 'as-pred', dose: '5mg', freq: 'q24h', duration: '5d' },
  ] },
  { name: 'Viral URTI', rx: 'Paracetamol 500mg PO q8h 5d + Cetirizine 10mg PO q24h 5d', meds: [
    { medId: 'an-para500', dose: '500mg', freq: 'q8h', duration: '5d' },
    { medId: 'as-cetir', dose: '10mg', freq: 'q24h', duration: '5d' },
  ] },
  { name: 'MSK Pain', rx: 'Ibuprofen 400mg PO q8h \u00d7 5d', meds: [
    { medId: 'an-ibu', dose: '400mg', freq: 'q8h', duration: '5d' },
  ] },
]
