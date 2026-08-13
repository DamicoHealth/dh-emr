/**
 * ICD-10: curated offline subset, ported from packages/pwa/icd10.js in the
 * previous implementation.
 *
 * A focused, field-clinic-oriented set of ICD-10 codes (not the full 70k) so
 * search stays fast and fully offline. Lets clinicians attach one or more
 * coded diagnoses to an encounter ALONGSIDE the free-text diagnosis, which
 * makes exports research-grade and is the basis for FHIR/DHIS2 mapping.
 * Stored on the record as diagnosisCodes: [{ code, term }].
 */

export interface Icd10Entry {
  code: string
  term: string
}

export const ICD10_CODES: Icd10Entry[] = [
  // Infectious & parasitic
  { code: 'B54', term: 'Malaria, unspecified' },
  { code: 'B50', term: 'Plasmodium falciparum malaria' },
  { code: 'A09', term: 'Diarrhoea & gastroenteritis, infectious' },
  { code: 'A01.0', term: 'Typhoid fever' },
  { code: 'A06', term: 'Amoebiasis' },
  { code: 'A03', term: 'Shigellosis' },
  { code: 'A08', term: 'Viral gastroenteritis' },
  { code: 'B20', term: 'HIV disease' },
  { code: 'A15', term: 'Respiratory tuberculosis' },
  { code: 'B19', term: 'Viral hepatitis, unspecified' },
  { code: 'A53.9', term: 'Syphilis, unspecified' },
  { code: 'A59', term: 'Trichomoniasis' },
  { code: 'B35', term: 'Dermatophytosis (tinea)' },
  { code: 'B37.3', term: 'Candidiasis, vulvovaginal' },
  { code: 'B86', term: 'Scabies' },
  { code: 'B76', term: 'Hookworm disease' },
  { code: 'B82', term: 'Intestinal parasitism, unspecified' },
  { code: 'B02', term: 'Herpes zoster (shingles)' },
  { code: 'B07', term: 'Viral warts' },
  { code: 'A90', term: 'Dengue fever' },
  { code: 'A75', term: 'Typhus fever' },
  // Respiratory
  { code: 'J00', term: 'Common cold (acute nasopharyngitis)' },
  { code: 'J06.9', term: 'Upper respiratory infection, acute' },
  { code: 'J18.9', term: 'Pneumonia, unspecified' },
  { code: 'J20', term: 'Acute bronchitis' },
  { code: 'J45', term: 'Asthma' },
  { code: 'J44', term: 'COPD' },
  { code: 'J02', term: 'Acute pharyngitis' },
  { code: 'J03', term: 'Acute tonsillitis' },
  { code: 'J32', term: 'Chronic sinusitis' },
  { code: 'H66', term: 'Otitis media (suppurative)' },
  { code: 'H65', term: 'Otitis media, non-suppurative' },
  // Gastrointestinal & dental
  { code: 'K29', term: 'Gastritis & duodenitis' },
  { code: 'K21', term: 'Gastro-oesophageal reflux (GERD)' },
  { code: 'K30', term: 'Functional dyspepsia' },
  { code: 'K59.0', term: 'Constipation' },
  { code: 'K92.2', term: 'Gastrointestinal haemorrhage' },
  { code: 'K02', term: 'Dental caries' },
  { code: 'K05', term: 'Gingivitis & periodontal disease' },
  { code: 'K04', term: 'Dental pulp / periapical disease' },
  { code: 'B37.0', term: 'Oral candidiasis (thrush)' },
  { code: 'K80', term: 'Cholelithiasis (gallstones)' },
  // Cardiovascular & blood
  { code: 'I10', term: 'Essential hypertension' },
  { code: 'I50', term: 'Heart failure' },
  { code: 'I25', term: 'Chronic ischaemic heart disease' },
  { code: 'I63', term: 'Cerebral infarction (stroke)' },
  { code: 'I83', term: 'Varicose veins of lower limb' },
  { code: 'D50', term: 'Iron deficiency anaemia' },
  { code: 'D64', term: 'Anaemia, unspecified' },
  { code: 'D57', term: 'Sickle-cell disorder' },
  // Endocrine / metabolic / nutrition
  { code: 'E11', term: 'Type 2 diabetes mellitus' },
  { code: 'E10', term: 'Type 1 diabetes mellitus' },
  { code: 'E05', term: 'Thyrotoxicosis (hyperthyroidism)' },
  { code: 'E03', term: 'Hypothyroidism' },
  { code: 'E66', term: 'Obesity' },
  { code: 'E43', term: 'Severe acute malnutrition' },
  { code: 'E44', term: 'Moderate protein-energy malnutrition' },
  { code: 'E46', term: 'Protein-energy malnutrition, unspecified' },
  { code: 'E50', term: 'Vitamin A deficiency' },
  { code: 'E86', term: 'Volume depletion (dehydration)' },
  // Genitourinary & reproductive
  { code: 'N39.0', term: 'Urinary tract infection' },
  { code: 'N30', term: 'Cystitis' },
  { code: 'N18', term: 'Chronic kidney disease' },
  { code: 'N73', term: 'Pelvic inflammatory disease' },
  { code: 'N76', term: 'Vaginitis / vulvovaginitis' },
  { code: 'N91', term: 'Absent / scanty menstruation' },
  { code: 'N94', term: 'Pelvic & menstrual pain' },
  { code: 'N40', term: 'Benign prostatic hyperplasia' },
  // Pregnancy & postpartum
  { code: 'Z34', term: 'Supervision of normal pregnancy' },
  { code: 'O26', term: 'Pregnancy-related condition' },
  { code: 'O80', term: 'Single spontaneous delivery' },
  { code: 'Z39', term: 'Postpartum care' },
  { code: 'O03', term: 'Spontaneous abortion (miscarriage)' },
  // Musculoskeletal & injury
  { code: 'M54', term: 'Back pain (dorsalgia)' },
  { code: 'M25.5', term: 'Joint pain (arthralgia)' },
  { code: 'M79.1', term: 'Myalgia' },
  { code: 'M06', term: 'Rheumatoid arthritis' },
  { code: 'M17', term: 'Osteoarthritis of knee' },
  { code: 'S52', term: 'Fracture of forearm' },
  { code: 'S61', term: 'Open wound of wrist/hand' },
  { code: 'S01', term: 'Open wound of head' },
  { code: 'T14.9', term: 'Injury, unspecified' },
  { code: 'T30', term: 'Burn, unspecified site' },
  { code: 'W57', term: 'Bitten/stung by insect (non-venomous)' },
  { code: 'T63', term: 'Venom (snake/insect) toxic effect' },
  // Neuro / mental health
  { code: 'R51', term: 'Headache' },
  { code: 'G43', term: 'Migraine' },
  { code: 'G40', term: 'Epilepsy' },
  { code: 'F32', term: 'Depressive episode' },
  { code: 'F41', term: 'Anxiety disorder' },
  { code: 'F29', term: 'Psychosis, unspecified' },
  { code: 'F10', term: 'Alcohol use disorder' },
  // Skin
  { code: 'L30', term: 'Dermatitis, unspecified' },
  { code: 'L23', term: 'Allergic contact dermatitis' },
  { code: 'L03', term: 'Cellulitis' },
  { code: 'L02', term: 'Cutaneous abscess / boil' },
  { code: 'L08', term: 'Local skin infection' },
  { code: 'L50', term: 'Urticaria (hives)' },
  { code: 'L70', term: 'Acne' },
  { code: 'L20', term: 'Atopic dermatitis (eczema)' },
  // Eye / ENT
  { code: 'H10', term: 'Conjunctivitis' },
  { code: 'H57', term: 'Eye / adnexa disorder' },
  { code: 'H92', term: 'Earache / ear discharge' },
  { code: 'J34', term: 'Nasal disorder' },
  // Symptoms & signs (when no specific diagnosis)
  { code: 'R50', term: 'Fever, unspecified' },
  { code: 'R05', term: 'Cough' },
  { code: 'R10', term: 'Abdominal & pelvic pain' },
  { code: 'R11', term: 'Nausea & vomiting' },
  { code: 'R42', term: 'Dizziness & giddiness' },
  { code: 'R53', term: 'Malaise & fatigue' },
  { code: 'R60', term: 'Oedema (swelling)' },
  { code: 'R07', term: 'Chest pain' },
  { code: 'R21', term: 'Rash & skin eruption' },
  { code: 'R63.4', term: 'Abnormal weight loss' },
  // General / preventive
  { code: 'Z00', term: 'General medical examination' },
  { code: 'Z23', term: 'Immunization encounter' },
  { code: 'Z01', term: 'Special examination' },
  { code: 'R69', term: 'Illness, unspecified / unknown' },
]

/**
 * Prefix matches rank before contains matches; already-selected codes are
 * excluded; capped at 12 results. Pure port of the legacy search().
 */
export function searchIcd10(query: string, selectedCodes: readonly string[] = []): Icd10Entry[] {
  const q = (query || '').toLowerCase().trim()
  if (!q) return []
  const starts: Icd10Entry[] = []
  const contains: Icd10Entry[] = []
  for (const e of ICD10_CODES) {
    if (selectedCodes.includes(e.code)) continue
    const code = e.code.toLowerCase()
    const term = e.term.toLowerCase()
    if (code.startsWith(q) || term.startsWith(q)) starts.push(e)
    else if (code.includes(q) || term.includes(q)) contains.push(e)
  }
  return starts.concat(contains).slice(0, 12)
}
