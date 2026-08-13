// ==========================================
// CSV EXPORT
// ==========================================
function generateCSV(recs) {
  // Calculate encounter number per patient (by MRN, ordered by date)
  const encounterNumMap = {};
  const sortedForNum = [...recs].sort((a, b) => (a.date || '').localeCompare(b.date || ''));
  const encNumLookup = {};
  sortedForNum.forEach(r => {
    const mrn = r.mrn || r.id;
    if (!encounterNumMap[mrn]) encounterNumMap[mrn] = 0;
    encounterNumMap[mrn]++;
    encNumLookup[r.id] = encounterNumMap[mrn];
  });
  const cols = ['MRN', 'EncounterNum', 'Date', 'Site', 'GivenName', 'FamilyName', 'Sex', 'DOB', 'Phone', 'Pregnant', 'Breastfeeding', 'Temp', 'BP', 'Weight_kg', 'Allergies', 'CurrentMeds', 'PMH', 'ChiefConcern'];
  // Add columns for all lab tests
  DEFAULT_LAB_TESTS.forEach(t => {
    const safe = t.name.replace(/[^a-zA-Z0-9]/g, '');
    if (t.type === 'toggle') {
      cols.push('Lab_' + safe + '_Ordered', 'Lab_' + safe + '_Result');
    } else if (t.type === 'numeric') {
      cols.push('Lab_' + safe + '_Value', 'Lab_' + safe + '_Unit', 'Lab_' + safe + '_Interp');
    }
  });
  UA_PARAMS.forEach(p => cols.push('UA_' + p));
  cols.push('EncounterForm', 'LabComments', 'Diagnosis', 'ICD10', 'Medications', 'Procedures', 'TreatmentNotes', 'ReferralType', 'Provider', 'Notes', 'AgeEstimated', 'SavedAt');
  // Custom (admin-defined) fields — one column each, appended after the standard columns
  let customFieldDefs = [];
  try {
    if (window.FormSchema) {
      // Union of custom fields across ALL templates (records may use any of them).
      (window.FormSchema.getTemplates() || []).forEach((t) => {
        window.FormSchema.getEffectiveSchema(t.id).sections
          .filter((s) => !s.builtin)
          .forEach((s) => (s.fields || []).forEach((f) => {
            if (!customFieldDefs.find((x) => x.id === f.id)) customFieldDefs.push(f);
          }));
      });
    }
  } catch (e) { /* schema unavailable */ }
  customFieldDefs.forEach((f) => cols.push('Custom_' + String(f.label || f.id).replace(/[^a-zA-Z0-9]/g, '')));
  const csvEsc = (val) => {
    let s = String(val == null ? '' : val);
    // Formula-injection guard: a value beginning with = + - @ (or tab/CR) can be
    // executed as a formula by Excel/Sheets. Prefix a single quote to neutralize it.
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return (s.includes(',') || s.includes('"') || s.includes('\n')) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  let csv = cols.map(csvEsc).join(',') + '\n';
  recs.forEach(r => {
    const gn = r.givenName || (r.name ? r.name.split(' ')[0] : '');
    const fn = r.familyName || (r.name ? r.name.split(' ').slice(1).join(' ') : '');
    const row = [r.mrn, encNumLookup[r.id] || 1, r.date, r.site, gn, fn, r.sex, r.dob, r.phone, r.pregnant, r.breastfeeding, r.temp, r.bp, r.weight, r.allergies, r.currentMeds, r.pmh, r.chiefConcern];
    DEFAULT_LAB_TESTS.forEach(t => {
      const lab = r.labs && r.labs[t.name] ? r.labs[t.name] : {};
      if (t.type === 'toggle') {
        row.push(lab.ordered ? 'Yes' : 'No', lab.result || 'N/A');
      } else if (t.type === 'numeric') {
        row.push(lab.value || (t.id === 'blood_glucose' && r.bloodGlucose ? r.bloodGlucose : ''), lab.unit || t.unit || '', lab.interpretation || '');
      }
    });
    UA_PARAMS.forEach(p => row.push(r.urinalysis ? r.urinalysis[p] : ''));
    row.push((r.templateName || r.templateId || ''), r.labComments, r.diagnosis, (r.diagnosisCodes || []).map((c) => c.code).join('; '), r.treatment || '', r.procedures ? r.procedures.join('; ') : '', r.treatmentNotes, r.referralType || 'None', r.provider, r.notes, r.ageEstimated ? 'Yes' : 'No', r.savedAt);
    customFieldDefs.forEach((f) => { const v = r.customFields ? r.customFields[f.id] : ''; row.push(Array.isArray(v) ? v.join('; ') : (v != null ? v : '')); });
    csv += row.map(csvEsc).join(',') + '\n';
  });
  return csv;
}
async function exportCSV(filteredRecords) { await window.electronAPI.exportCSV(generateCSV(filteredRecords || records)); }
