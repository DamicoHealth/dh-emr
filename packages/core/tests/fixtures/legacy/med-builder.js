// ==========================================
// MEDICATION BUILDER
// ==========================================
function buildDrugSelect(selectedId) {
  const formulary = getFormulary();
  const categories = [...new Set(formulary.map(f => f.category))];
  let html = '<option value="">\u2014 Select medication \u2014</option>';
  categories.forEach(cat => {
    html += `<optgroup label="${esc(cat)}">`;
    formulary.filter(f => f.category === cat).forEach(med => {
      const sel = med.id === selectedId ? 'selected' : '';
      const ctrl = med.controlled ? ' \u26a0' : '';
      html += `<option value="${med.id}" ${sel}>${esc(med.name)}${ctrl}</option>`;
    });
    html += '</optgroup>';
  });
  return html;
}

function addMedLine(medId, dose, freq, duration) {
  const formulary = getFormulary();
  const med = medId ? formulary.find(f => f.id === medId) : null;
  const div = document.createElement('div');
  div.className = 'med-line';
  const doseVal = dose || (med ? med.dose : '');
  div.innerHTML = `
    <select class="med-drug-select">${buildDrugSelect(medId || '')}</select>
    <input type="text" class="med-dose-input" value="${esc(doseVal)}" placeholder="Dose">
    <select class="med-freq-select">${FREQUENCIES.map(f => `<option value="${f.value}" ${f.value === (freq||'') ? 'selected' : ''}>${f.label}</option>`).join('')}</select>
    <select class="med-dur-select">${DURATIONS.map(d => `<option ${d === (duration||'') ? 'selected' : ''}>${d}</option>`).join('')}</select>
    <button class="btn-remove" title="Remove">&times;</button>
    <div class="med-preview"></div>`;
  document.getElementById('medBuilder').appendChild(div);
  div.querySelector('.med-drug-select').addEventListener('change', function() {
    const selMed = formulary.find(f => f.id === this.value);
    if (selMed) div.querySelector('.med-dose-input').value = selMed.dose;
    updateMedPreview(div);
  });
  div.querySelector('.btn-remove').addEventListener('click', () => div.remove());
  ['.med-drug-select', '.med-dose-input', '.med-freq-select', '.med-dur-select'].forEach(sel => {
    div.querySelector(sel).addEventListener('change', () => updateMedPreview(div));
    if (sel === '.med-dose-input') div.querySelector(sel).addEventListener('input', () => updateMedPreview(div));
  });
  updateMedPreview(div);
}

function parseDoseToMg(str) {
  if (!str) return null;
  const m = str.match(/(\d+(?:\.\d+)?)\s*(mg|g|mcg)/i);
  if (!m) return null;
  const val = parseFloat(m[1]);
  const u = m[2].toLowerCase();
  if (u === 'g') return val * 1000;
  if (u === 'mcg') return val / 1000;
  return val;
}
const FREQ_DOSES_PER_DAY = { once: 1, q24h: 1, q12h: 2, q8h: 3, q6h: 4, qhs: 1, 'bid-topical': null, prn: null };
function calcMedQty(medId, dose, freqVal, duration) {
  const formulary = getFormulary();
  const med = formulary.find(f => f.id === medId);
  if (!med || !['tabs', 'caps', 'sachet'].includes(med.unit)) return null;
  const dpd = FREQ_DOSES_PER_DAY[freqVal];
  if (dpd == null) return null;
  let days = 1;
  if (duration === 'Ongoing') return null;
  const durMatch = duration.match(/^(\d+)d$/);
  if (durMatch) days = parseInt(durMatch[1]);
  else if (duration !== 'Single dose') return null;
  const tabsMatch = dose.match(/^(\d+)\s*tab/i);
  if (tabsMatch) return { qty: parseInt(tabsMatch[1]) * dpd * days, unit: med.unit, tabsPerDose: parseInt(tabsMatch[1]), dpd, days };
  const prescribedMg = parseDoseToMg(dose);
  // Strength can live in the NAME ("Paracetamol 500mg") or in a separate
  // `dose` field, which is what the config admin UI produces. Reading only the
  // name meant every drug in a config-defined formulary fell back to 1 unit
  // per dose. Kept identical to packages/pwa-react/src/clinical/medQty.ts.
  const unitMg = parseDoseToMg(med.name) || parseDoseToMg(med.dose || '');
  const tabsPerDose = (prescribedMg && unitMg && unitMg > 0) ? Math.ceil(prescribedMg / unitMg) : 1;
  return { qty: tabsPerDose * dpd * days, unit: med.unit, tabsPerDose, dpd, days };
}

function getWeightBasedSuggestion(med) {
  const weight = getWeightMidpoint();
  if (!weight || !med || !med.dose) return '';
  const m = med.dose.match(/(\d+(?:\.\d+)?)\s*(mcg|mg)\/kg/i);
  if (!m) return '';
  const perKg = parseFloat(m[1]);
  const unit = m[2].toLowerCase();
  const totalDose = perKg * weight;
  const doseStr = unit === 'mcg' && totalDose >= 1000 ? (totalDose / 1000).toFixed(1) + 'mg' : totalDose.toFixed(0) + unit;
  return ` <span class="weight-suggestion">(Suggested: ${doseStr} for ${weight}kg)</span>`;
}

function updateMedPreview(line) {
  const formulary = getFormulary();
  const medId = line.querySelector('.med-drug-select').value;
  const med = formulary.find(f => f.id === medId);
  const dose = line.querySelector('.med-dose-input').value;
  const freqVal = line.querySelector('.med-freq-select').value;
  const freq = FREQUENCIES.find(f => f.value === freqVal);
  const dur = line.querySelector('.med-dur-select').value;
  const preview = line.querySelector('.med-preview');
  if (!med) { preview.textContent = ''; return; }
  const ctrl = med.controlled ? '<span class="med-controlled"> \u26a0 CONTROLLED</span>' : '';
  const qtyInfo = calcMedQty(medId, dose, freqVal, dur);
  const qtyStr = qtyInfo ? ` <span style="color:var(--primary);font-weight:600;">\u2192 ${qtyInfo.qty} ${qtyInfo.unit}</span>` : '';
  const weightSug = getWeightBasedSuggestion(med);
  preview.innerHTML = `${esc(med.name)} ${esc(dose)} \u2014 ${freq ? freq.label : ''} \u00d7 ${dur}${qtyStr}${weightSug}${ctrl}`;
}
