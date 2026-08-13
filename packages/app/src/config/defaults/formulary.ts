/**
 * The built-in formulary, ported from packages/pwa/state.js
 * (DEFAULT_FORMULARY) in the previous implementation. Cross-checked against
 * the generated pwa-react constants.ts copy: byte-identical, 39 entries.
 *
 * Ids are LOAD-BEARING: prescriptions on saved records store medId, so these
 * ids must never change or be reused.
 */
import type { FormularyEntry } from '../types'

export const DEFAULT_FORMULARY: FormularyEntry[] = [
  { id: 'abx-amox500', name: 'Amoxicillin 500mg', dose: '500mg', unit: 'caps', category: 'Antibiotics', controlled: false },
  { id: 'abx-amox250', name: 'Amoxicillin 250mg', dose: '250mg', unit: 'caps', category: 'Antibiotics', controlled: false },
  { id: 'abx-azithro250', name: 'Azithromycin 250mg', dose: '500mg', unit: 'tabs', category: 'Antibiotics', controlled: false },
  { id: 'abx-azithro1g', name: 'Azithromycin 1g single dose', dose: '1g', unit: 'tabs', category: 'Antibiotics', controlled: false },
  { id: 'abx-cipro', name: 'Ciprofloxacin 500mg', dose: '500mg', unit: 'tabs', category: 'Antibiotics', controlled: false },
  { id: 'abx-doxy', name: 'Doxycycline 100mg', dose: '100mg', unit: 'caps', category: 'Antibiotics', controlled: false },
  { id: 'abx-metro', name: 'Metronidazole 200mg', dose: '400mg', unit: 'tabs', category: 'Antibiotics', controlled: false },
  { id: 'abx-ceph', name: 'Cephalexin 250mg', dose: '500mg', unit: 'caps', category: 'Antibiotics', controlled: false },
  { id: 'abx-levo', name: 'Levofloxacin 500mg', dose: '500mg', unit: 'tabs', category: 'Antibiotics', controlled: false },
  { id: 'abx-nitro', name: 'Nitrofurantoin 100mg', dose: '100mg', unit: 'tabs', category: 'Antibiotics', controlled: false },
  { id: 'abx-ceftri', name: 'Ceftriaxone 500mg IM', dose: '500mg', unit: 'vial', category: 'Antibiotics', controlled: false },
  { id: 'abx-benza', name: 'Benzathine Penicillin 2.4MU IM', dose: '2.4MU', unit: 'vial', category: 'Antibiotics', controlled: false },
  { id: 'am-artefan', name: 'Artemether-Lumefantrine 20/120mg Artefan', dose: '4 tabs', unit: 'tabs', category: 'Antimalarials', controlled: false },
  { id: 'am-artesunate', name: 'Artesunate Inj 60mg', dose: '60mg', unit: 'vial', category: 'Antimalarials', controlled: false },
  { id: 'af-griseo', name: 'Griseofulvin 500mg', dose: '500mg', unit: 'tabs', category: 'Antifungals', controlled: false },
  { id: 'af-fluco', name: 'Fluconazole 200mg', dose: '150mg', unit: 'caps', category: 'Antifungals', controlled: false },
  { id: 'af-clotrim', name: 'Clotrimazole cream 1%', dose: 'apply', unit: 'cream', category: 'Antifungals', controlled: false },
  { id: 'af-nystatin', name: 'Nystatin suspension 500k IU', dose: '1ml', unit: 'drops', category: 'Antifungals', controlled: false },
  { id: 'ap-alben', name: 'Albendazole 400mg', dose: '400mg', unit: 'tabs', category: 'Antiparasitic', controlled: false },
  { id: 'ap-iverm', name: 'Ivermectin 3mg', dose: '200mcg/kg', unit: 'tabs', category: 'Antiparasitic', controlled: false },
  { id: 'ap-prazi', name: 'Praziquantel 600mg', dose: '600mg', unit: 'tabs', category: 'Antiparasitic', controlled: false },
  { id: 'an-ibu', name: 'Ibuprofen 200mg', dose: '400mg', unit: 'tabs', category: 'Analgesics', controlled: false },
  { id: 'an-para500', name: 'Paracetamol 500mg', dose: '1g', unit: 'tabs', category: 'Analgesics', controlled: false },
  { id: 'an-parasyr', name: 'Paracetamol 120mg/5ml syrup', dose: '5ml', unit: 'ml', category: 'Analgesics', controlled: false },
  { id: 'gi-omep', name: 'Omeprazole 20mg', dose: '20mg', unit: 'caps', category: 'GI', controlled: false },
  { id: 'gi-loper', name: 'Loperamide 2mg', dose: '4mg', unit: 'caps', category: 'GI', controlled: false },
  { id: 'gi-ors', name: 'ORS 1L sachet', dose: '1', unit: 'sachet', category: 'GI', controlled: false },
  { id: 'as-cetir', name: 'Cetirizine 10mg', dose: '10mg', unit: 'tabs', category: 'Allergy/Steroid', controlled: false },
  { id: 'as-pred', name: 'Prednisolone 5mg', dose: '40mg', unit: 'tabs', category: 'Allergy/Steroid', controlled: false },
  { id: 'as-dexa', name: 'Dexamethasone 8mg Inj', dose: '8mg', unit: 'vial', category: 'Allergy/Steroid', controlled: false },
  { id: 'av-acyclo', name: 'Acyclovir 200mg', dose: '400mg', unit: 'tabs', category: 'Antiviral', controlled: false },
  { id: 'vit-prenatal', name: 'Prenatal Vitamins', dose: '1 tab', unit: 'tabs', category: 'Vitamins', controlled: false },
  { id: 'vit-multi', name: 'Multivitamin', dose: '1 tab', unit: 'tabs', category: 'Vitamins', controlled: false },
  { id: 'sp-ketamine', name: 'Ketamine Inj 50mg/ml', dose: '1-2mg/kg', unit: 'vial', category: 'Surgical/Procedural', controlled: true },
  { id: 'sp-lido', name: 'Lidocaine 2% 30ml', dose: '2ml', unit: 'vial', category: 'Surgical/Procedural', controlled: false },
  { id: 'sp-adrenaline', name: 'Adrenaline Inj', dose: '0.5ml', unit: 'vial', category: 'Surgical/Procedural', controlled: false },
  { id: 'sp-diaz', name: 'Diazepam Inj', dose: '10mg', unit: 'vial', category: 'Surgical/Procedural', controlled: true },
  { id: 'sp-ns', name: 'Normal Saline 500ml', dose: '500ml', unit: 'vial', category: 'Surgical/Procedural', controlled: false },
]

/** Unit choices offered by the formulary editor. Only tabs/caps/sachet are counted units. */
export const FORMULARY_UNITS = ['tabs', 'caps', 'sachet', 'ml', 'vial', 'ampoule', 'tube', 'drops'] as const
