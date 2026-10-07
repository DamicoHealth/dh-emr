// ==========================================
// CUSTOM PROMPT (replaces window.prompt which is blocked in Electron)
// ==========================================
function customPrompt(title, defaultValue) {
  return new Promise((resolve) => {
    console.log('[customPrompt] opening modal for:', title);
    const modal = document.getElementById('customPromptModal');
    const input = document.getElementById('customPromptInput');
    const titleEl = document.getElementById('customPromptTitle');
    const extraEl = document.getElementById('customPromptExtra');
    if (!modal || !input || !titleEl) {
      console.error('[customPrompt] modal elements missing:', { modal: !!modal, input: !!input, titleEl: !!titleEl });
      resolve(null);
      return;
    }
    titleEl.textContent = title;
    input.value = defaultValue || '';
    extraEl.innerHTML = '';
    // Remove any stale listeners by cloning the buttons
    const okBtn = document.getElementById('customPromptOk');
    const cancelBtn = document.getElementById('customPromptCancel');
    const newOk = okBtn.cloneNode(true);
    const newCancel = cancelBtn.cloneNode(true);
    okBtn.parentNode.replaceChild(newOk, okBtn);
    cancelBtn.parentNode.replaceChild(newCancel, cancelBtn);
    modal.classList.add('open');
    input.focus();

    function cleanup() {
      modal.classList.remove('open');
      freshOk.removeEventListener('click', onOk);
      freshCancel.removeEventListener('click', onCancel);
      input.removeEventListener('keydown', onKey);
    }
    function onOk() { console.log('[customPrompt] OK clicked'); cleanup(); resolve(input.value); }
    function onCancel() { console.log('[customPrompt] Cancel clicked'); cleanup(); resolve(null); }
    function onKey(e) { if (e.key === 'Enter') onOk(); if (e.key === 'Escape') onCancel(); }

    const freshOk = document.getElementById('customPromptOk');
    const freshCancel = document.getElementById('customPromptCancel');
    freshOk.addEventListener('click', onOk);
    freshCancel.addEventListener('click', onCancel);
    input.addEventListener('keydown', onKey);
  });
}

// ==========================================
// HELPERS
// ==========================================
function formatDate(isoStr) {
  if (!isoStr || isoStr.length < 10) return isoStr || '';
  const parts = isoStr.split('-');
  if (parts.length !== 3) return isoStr;
  return parts[2] + '/' + parts[1] + '/' + parts[0];
}

function calcAge(dob) {
  if (!dob) return null;
  const d = new Date(dob);
  if (isNaN(d.getTime())) return null;
  const now = new Date();
  let age = now.getFullYear() - d.getFullYear();
  if (now.getMonth() < d.getMonth() || (now.getMonth() === d.getMonth() && now.getDate() < d.getDate())) age--;
  return age;
}

// Parse DD/MM/YYYY (or DDMMYYYY) into ISO yyyy-mm-dd. Returns '' if not parseable.
function parseDOBString(str) {
  if (!str) return '';
  const digits = str.replace(/\D/g, '');
  if (digits.length !== 8) return '';
  const dd = digits.slice(0, 2);
  const mm = digits.slice(2, 4);
  const yyyy = digits.slice(4, 8);
  // Sanity check
  const day = parseInt(dd, 10);
  const month = parseInt(mm, 10);
  const year = parseInt(yyyy, 10);
  if (day < 1 || day > 31 || month < 1 || month > 12 || year < 1900 || year > 2100) return '';
  return `${yyyy}-${mm}-${dd}`;
}

// Format DD/MM/YYYY auto as user types (returns formatted string)
function formatDOBInput(raw) {
  const digits = (raw || '').replace(/\D/g, '').slice(0, 8);
  let formatted = '';
  for (let i = 0; i < digits.length; i++) {
    if (i === 2 || i === 4) formatted += '/';
    formatted += digits[i];
  }
  return formatted;
}

// ISO yyyy-mm-dd -> DD/MM/YYYY
function isoToDOBString(iso) {
  if (!iso || iso.length < 10) return '';
  const parts = iso.split('-');
  if (parts.length !== 3) return '';
  return `${parts[2]}/${parts[1]}/${parts[0]}`;
}

// Escapes for safe interpolation into HTML — including inside double/single
// quoted attributes. The old version (textContent->innerHTML) did NOT escape
// quotes, so admin/synced config strings could break out of attributes and
// inject markup. Also faster: no detached DOM element allocated per call.
function esc(s) {
  if (s === null || s === undefined) return '';
  return String(s).replace(/[&<>"']/g, function (c) {
    return c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;';
  });
}

function quickFill(fieldId, value) { document.getElementById(fieldId).value = value; }

// Toggle button helpers
function getToggleValue(groupId) {
  const active = document.getElementById(groupId).querySelector('.btn-toggle.active');
  return active ? active.dataset.val : '';
}
function setToggleValue(groupId, val) {
  const group = document.getElementById(groupId);
  group.querySelectorAll('.btn-toggle').forEach(b => b.classList.remove('active'));
  if (val) { const btn = group.querySelector(`.btn-toggle[data-val="${val}"]`); if (btn) btn.classList.add('active'); }
}
function initToggleGroup(groupId, onChange) {
  document.getElementById(groupId).querySelectorAll('.btn-toggle').forEach(btn => {
    btn.addEventListener('click', () => {
      const group = document.getElementById(groupId);
      if (group.classList.contains('disabled')) return;
      group.querySelectorAll('.btn-toggle').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      if (onChange) onChange(btn.dataset.val);
    });
  });
}

// Sex-dependent field control
function updateSexDependentFields() {
  const sex = getToggleValue('sexToggle');
  const pregGroup = document.getElementById('pregnantToggle');
  const bfGroup = document.getElementById('bfToggle');
  if (sex === 'M') {
    setToggleValue('pregnantToggle', 'N/A');
    setToggleValue('bfToggle', 'N/A');
    pregGroup.classList.add('disabled');
    bfGroup.classList.add('disabled');
  } else {
    pregGroup.classList.remove('disabled');
    bfGroup.classList.remove('disabled');
  }
}

// MRN generation: First 2 letters of given + first 2 of family + DDMMYYYY (no dashes)
// Example: John Smith born 15 March 1990 -> JOSM15031990
function twoInitials(name) {
  // Same rule as packages/pwa-react/src/data/PatientRecord.ts - the two apps
  // must never disagree about an MRN.
  // STEP 1 is the ORIGINAL rule on the ORIGINAL string, so every MRN ever
  // generated still generates identically. Normalising first would re-key a
  // patient whose name STARTS with an accented letter and split their chart.
  const ascii = name.replace(/[^a-zA-Z]/g, '');
  if (ascii.length >= 2) return ascii.substring(0, 2).toUpperCase();
  // STEP 2 only runs where the original returned '' and the patient could not
  // be filed at all, so it cannot change an existing MRN.
  const flat = name.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const flatAscii = flat.replace(/[^a-zA-Z]/g, '');
  if (flatAscii.length >= 2) return flatAscii.substring(0, 2).toUpperCase();
  const letters = Array.from(flat).filter(ch => /\p{L}/u.test(ch));
  return letters.length >= 2 ? letters.slice(0, 2).join('').toUpperCase() : '';
}

function generateBaseMRN(given, family, dob) {
  if (!given || !family || !dob) return '';
  const g = twoInitials(given);
  const f = twoInitials(family);
  if (!g || !f) return '';
  const dobParts = dob.split('-');
  if (dobParts.length !== 3) return '';
  const dobStr = dobParts[2] + dobParts[1] + dobParts[0]; // DDMMYYYY
  return g + f + dobStr;
}

function updateMRN() {
  const given = document.getElementById('fGivenName').value.trim();
  const family = document.getElementById('fFamilyName').value.trim();
  // Use the hidden ISO date if present, else parse the typed DD/MM/YYYY
  const dobInput = document.getElementById('fDOB');
  let dob = '';
  if (dobInput) {
    if (dobInput.dataset && dobInput.dataset.iso) {
      dob = dobInput.dataset.iso;
    } else if (dobInput.type === 'date') {
      dob = dobInput.value;
    } else {
      dob = parseDOBString(dobInput.value);
    }
  }
  if (given && family && dob) {
    const baseMRN = generateBaseMRN(given, family, dob);
    // Check if this is a return patient (same base MRN AND same full name)
    const fullName = (given + ' ' + family).toLowerCase();
    const existingWithMRN = records.filter(r =>
      r.mrn && r.mrn.replace(/[A-Z]$/, '') === baseMRN && // strip any suffix for comparison
      r.id !== editingRecordId && !r.deleted
    );

    let mrn = baseMRN;
    if (existingWithMRN.length > 0) {
      // Check if any match is the SAME patient (same name)
      const samePatient = existingWithMRN.some(r => {
        const rName = (r.givenName + ' ' + r.familyName).toLowerCase().trim();
        return rName === fullName;
      });

      if (samePatient) {
        // Return patient — use the same MRN they already have
        const existing = existingWithMRN.find(r => {
          const rName = (r.givenName + ' ' + r.familyName).toLowerCase().trim();
          return rName === fullName;
        });
        mrn = existing.mrn;
      } else {
        // Different patient with same initials+DOB — add suffix B, C, D...
        const usedSuffixes = existingWithMRN.map(r => {
          const suffix = r.mrn.replace(baseMRN, '');
          return suffix || 'A'; // no suffix = first patient = "A"
        });
        const letters = 'BCDEFGHIJKLMNOPQRSTUVWXYZ';
        for (const letter of letters) {
          if (!usedSuffixes.includes(letter)) {
            mrn = baseMRN + letter;
            break;
          }
        }
      }
    }

    document.getElementById('fMRN').value = mrn;
    // Check for return patient (only in new encounter mode)
    if (panelMode === 'new') checkReturnPatient(baseMRN);
  } else {
    document.getElementById('fMRN').value = '';
    hideReturnPatientBanner();
  }
}

function checkReturnPatient(baseMRN) {
  // SAFETY: match by base MRN *and* full name. Base MRN is only initials + DOB,
  // so two different patients can share it — matching on MRN alone would carry
  // one patient's allergies/PMH/meds onto another. Require the name to match
  // before treating this as the same returning patient.
  const curGiven = (document.getElementById('fGivenName').value || '').trim().toLowerCase();
  const curFamily = (document.getElementById('fFamilyName').value || '').trim().toLowerCase();
  const curFull = (curGiven + ' ' + curFamily).trim();
  const matches = records.filter(r => {
    if (!r.mrn || r.id === editingRecordId || r.deleted) return false;
    const rBase = r.mrn.replace(/[A-Z]$/, '');
    if (rBase !== baseMRN) return false;
    const rFull = ((r.givenName || '') + ' ' + (r.familyName || '')).trim().toLowerCase();
    return rFull === curFull;
  });
  const banner = document.getElementById('returnPatientBanner');
  if (!banner) return;
  if (matches.length > 0) {
    const latest = matches.sort((a, b) => (b.date || '').localeCompare(a.date || ''))[0];
    const visitCount = matches.length;
    const name = latest.name || latest.givenName || 'Unknown';
    const lastDate = latest.date ? formatDate(latest.date) : 'Unknown date';
    const lastDx = latest.diagnosis || 'No diagnosis';
    // Problem list: dedup prior coded + free-text diagnoses across all visits
    const _probs = new Map();
    matches.forEach((r) => {
      (r.diagnosisCodes || []).forEach((c) => { if (c && c.code) _probs.set(c.code, (c.term || c.code) + ' (' + c.code + ')'); });
      if (r.diagnosis) String(r.diagnosis).split(/[,;\n]/).forEach((d) => { d = d.trim(); if (d && !_probs.has('t:' + d.toLowerCase())) _probs.set('t:' + d.toLowerCase(), d); });
    });
    const problems = [..._probs.values()].slice(0, 8);
    // Auto-carry persistent patient data from most recent visit
    if (latest.allergies && !document.getElementById('fAllergies').value) {
      document.getElementById('fAllergies').value = latest.allergies;
    }
    if (latest.pmh && !document.getElementById('fPMH').value) {
      document.getElementById('fPMH').value = latest.pmh;
    }
    if (latest.currentMeds && !document.getElementById('fCurrentMeds').value) {
      document.getElementById('fCurrentMeds').value = latest.currentMeds;
    }
    if (latest.phone && !document.getElementById('fPhone').value.replace('256', '')) {
      document.getElementById('fPhone').value = latest.phone;
    }
    banner.innerHTML = `
      <div class="return-patient-info">
        <strong>\ud83d\udd04 Return Patient Detected</strong> \u2014 ${esc(name)} has ${visitCount} previous visit(s).
        <span style="color:var(--gray-500);font-size:11px;">Last visit: ${lastDate} \u2014 ${esc(lastDx)}</span>
        <span style="color:var(--green);font-size:11px;">\u2705 Allergies, PMH, and meds auto-filled from last visit</span>
        ${problems.length ? `<span style="color:var(--gray-600);font-size:11px;">📋 Problem list: ${esc(problems.join(', '))}</span>` : ''}
      </div>
      <div class="return-patient-actions">
        <button class="btn btn-secondary btn-sm" onclick="viewPreviousVisits('${esc(baseMRN)}')">View Previous Visits</button>
        <button class="btn btn-primary btn-sm" onclick="prefillFromPrevious('${esc(latest.id)}')">Copy All Patient Info</button>
      </div>`;
    banner.style.display = 'block';
  } else {
    hideReturnPatientBanner();
  }
}

function hideReturnPatientBanner() {
  const banner = document.getElementById('returnPatientBanner');
  if (banner) banner.style.display = 'none';
}

function viewPreviousVisits(baseMRN) {
  const matches = records.filter(r => {
    if (!r.mrn || r.deleted) return false;
    const rBase = r.mrn.replace(/[A-Z]$/, '');
    return rBase === baseMRN;
  }).sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  let html = '<div style="max-height:300px;overflow-y:auto;">';
  matches.forEach(r => {
    html += `<div class="prev-visit-card" onclick="openRecord('${r.id}')">
      <strong>${formatDate(r.date || '')}</strong> — ${esc(r.diagnosis || 'No diagnosis')}
      <span style="color:var(--gray-400);font-size:11px;">${esc(r.site || '')} · ${esc(r.provider || '')}</span>
    </div>`;
  });
  html += '</div>';
  const banner = document.getElementById('returnPatientBanner');
  banner.innerHTML = `<div><strong>🔄 Previous Visits for MRN: ${esc(baseMRN)}</strong></div>${html}
    <button class="btn btn-secondary btn-sm" style="margin-top:8px;" onclick="hideReturnPatientBanner()">Close</button>`;
}

function prefillFromPrevious(recordId) {
  const prev = records.find(r => r.id === recordId);
  if (!prev) return;
  // Copy demographics only (not clinical data) — this is a NEW visit
  document.getElementById('fGivenName').value = prev.givenName || '';
  document.getElementById('fFamilyName').value = prev.familyName || '';
  setToggleValue('sexToggle', prev.sex || '');
  const dobInput = document.getElementById('fDOB');
  if (dobInput) {
    if (prev.dob) {
      dobInput.value = isoToDOBString(prev.dob);
      dobInput.dataset.iso = prev.dob;
    } else {
      dobInput.value = '';
      dobInput.dataset.iso = '';
    }
  }
  document.getElementById('fPhone').value = prev.phone || '';
  if (prev.ageEstimated) {
    dobUnknown = true;
    const cb = document.getElementById('fDOBUnknown');
    if (cb) cb.checked = true;
    if (dobInput) dobInput.style.display = 'none';
    const ageContainer = document.getElementById('ageInputContainer');
    if (ageContainer) ageContainer.style.display = 'block';
  }
  updateAgeDisplay();
  updateMRN();
  updateSexDependentFields();
  if (typeof renderWeightRanges === 'function') renderWeightRanges();
  // Pre-fill allergies and PMH from previous visit
  if (prev.allergies) document.getElementById('fAllergies').value = prev.allergies;
  if (prev.pmh) document.getElementById('fPMH').value = prev.pmh;
  if (prev.currentMeds) document.getElementById('fCurrentMeds').value = prev.currentMeds;
  hideReturnPatientBanner();
}

function updateAgeDisplay() {
  const dobInput = document.getElementById('fDOB');
  const el = document.getElementById('ageDisplay');
  if (!el || !dobInput) return;
  let iso = '';
  if (dobInput.dataset && dobInput.dataset.iso) iso = dobInput.dataset.iso;
  else if (dobInput.type === 'date') iso = dobInput.value;
  else iso = parseDOBString(dobInput.value);
  const age = iso ? calcAge(iso) : null;
  if (age !== null && !isNaN(age)) {
    el.textContent = `Age: ${age}y`;
    el.style.color = 'var(--green)';
  } else {
    el.textContent = '';
  }
}

// Wire DOB text input: auto-format as user types and update related state
function wireDOBTextInput() {
  const input = document.getElementById('fDOB');
  if (!input || input._dobWired) return;
  input._dobWired = true;
  input.addEventListener('input', () => {
    const formatted = formatDOBInput(input.value);
    if (formatted !== input.value) input.value = formatted;
    const iso = parseDOBString(input.value);
    input.dataset.iso = iso;
    updateAgeDisplay();
    updateMRN();
    if (typeof renderWeightRanges === 'function') renderWeightRanges();
  });
}

// Temperature interpretation for numeric temp input
// < 37.5: Normal (green); 37.5-38.4: Low-grade (yellow); 38.5-39.4: Fever (orange); >= 39.5: High (red)
function getTempInterpretation(tempStr) {
  const t = parseFloat(tempStr);
  if (!t || isNaN(t)) return null;
  if (t < 37.5) return { label: 'Normal', color: 'var(--green)' };
  if (t < 38.5) return { label: 'Low-grade', color: 'var(--amber)' };
  if (t < 39.5) return { label: 'Fever', color: '#fb923c' };
  return { label: 'High', color: 'var(--red)' };
}
function updateTempInterp() {
  const input = document.getElementById('fTemp');
  const interp = document.getElementById('tempInterp');
  if (!input || !interp) return;
  selectedTemp = input.value;
  const result = getTempInterpretation(input.value);
  if (result) {
    interp.innerHTML = `<span style="color:${result.color};font-weight:700;">${result.label}</span>`;
  } else {
    interp.innerHTML = '';
  }
}
// Legacy stub (older callers)
function highlightTempRange() { updateTempInterp(); }
function getTempRange(temp) {
  const t = parseFloat(temp);
  if (!t || isNaN(t)) return null;
  if (t < 37.5) return 'normal';
  if (t < 38.5) return 'lowgrade';
  if (t < 39.5) return 'fever';
  return 'high';
}

// ==========================================
// MULTI-SELECT PILL helpers (Access to Care)
// ==========================================
function renderMultiSelectPills(containerId, options, selectedSet, onChange) {
  const container = document.getElementById(containerId);
  if (!container) return;
  container.innerHTML = options.map(opt => {
    const sel = selectedSet.has(opt) ? ' selected' : '';
    return `<button type="button" class="pill-btn${sel}" data-val="${esc(opt)}">${esc(opt)}</button>`;
  }).join('');
  container.querySelectorAll('.pill-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const val = btn.dataset.val;
      if (selectedSet.has(val)) selectedSet.delete(val);
      else selectedSet.add(val);
      renderMultiSelectPills(containerId, options, selectedSet, onChange);
      if (typeof onChange === 'function') onChange();
    });
  });
}

function renderSingleSelectPills(containerId, options, currentVal, onSelect) {
  const container = document.getElementById(containerId);
  if (!container) return;
  container.innerHTML = options.map(opt => {
    const sel = currentVal === opt ? ' selected' : '';
    return `<button type="button" class="pill-btn${sel}" data-val="${esc(opt)}">${esc(opt)}</button>`;
  }).join('');
  container.querySelectorAll('.pill-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const val = btn.dataset.val;
      const newVal = (currentVal === val) ? null : val;
      if (typeof onSelect === 'function') onSelect(newVal);
    });
  });
}

// Pain level 0-10 buttons
function renderPainLevelButtons() {
  const container = document.getElementById('painLevelRow');
  if (!container) return;
  let html = '';
  for (let i = 0; i <= 10; i++) {
    const sel = (accessPainLevel === i) ? ' selected' : '';
    let cls = 'pain-btn';
    if (i <= 3) cls += ' pain-low';
    else if (i <= 6) cls += ' pain-mid';
    else cls += ' pain-high';
    html += `<button type="button" class="${cls}${sel}" data-level="${i}">${i}</button>`;
  }
  container.innerHTML = html;
  container.querySelectorAll('.pain-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const lvl = parseInt(btn.dataset.level);
      accessPainLevel = (accessPainLevel === lvl) ? null : lvl;
      renderPainLevelButtons();
    });
  });
}

// Weight range helpers
function getAgeBracket(dob) {
  if (!dob) return 'adult';
  const age = calcAge(dob);
  if (age < 1) return 'infant';
  if (age <= 4) return 'toddler';
  if (age <= 12) return 'child';
  if (age <= 17) return 'teen';
  return 'adult';
}
function getExpectedWeightIdx(dob, sex) {
  if (!dob) return -1;
  const age = calcAge(dob);
  const bracket = getAgeBracket(dob);
  const ranges = WEIGHT_RANGES[bracket];
  if (bracket === 'adult') return sex === 'F' ? 1 : 2;
  if (bracket === 'teen') return sex === 'F' ? 1 : 2;
  return Math.min(Math.floor(ranges.length / 2), ranges.length - 1);
}
function getWeightMidpoint() {
  // Prefer the numeric weight input; fallback to legacy selectedWeight string
  const wEl = document.getElementById('fWeight');
  const numFromInput = wEl ? parseFloat(wEl.value) : NaN;
  if (!isNaN(numFromInput) && numFromInput > 0) return numFromInput;
  if (!selectedWeight) return NaN;
  const direct = parseFloat(selectedWeight);
  if (!isNaN(direct) && direct > 0) return direct;
  const m = selectedWeight.match(/^(\d+)-(\d+)kg?$/);
  if (m) return Math.round((parseInt(m[1]) + parseInt(m[2])) / 2);
  const m2 = selectedWeight.match(/^(\d+)\+kg?$/);
  if (m2) return parseInt(m2[1]) + 10;
  return NaN;
}
// Legacy: weight is now a free-form numeric input; the old range row no longer exists.
function renderWeightRanges() {
  const container = document.getElementById('weightRangeRow');
  if (!container) return; // Quietly no-op if the legacy container isn't in the DOM
  container.innerHTML = '';
}

// Chief concern buttons
function renderComplaintButtons() {
  const grid = document.getElementById('complaintGrid');
  if (!grid) return;
  grid.innerHTML = COMMON_COMPLAINTS.map((c, i) => {
    if (isPresetHidden('complaints', c)) return '';
    const sel = selectedComplaints.has(i) ? ' selected' : '';
    return `<button type="button" class="complaint-btn${sel}" data-idx="${i}">${esc(c)}</button>`;
  }).join('');
  grid.querySelectorAll('.complaint-btn').forEach(btn => {
    btn.addEventListener('click', () => toggleComplaint(parseInt(btn.dataset.idx)));
  });
}
function toggleComplaint(idx) {
  const complaint = COMMON_COMPLAINTS[idx];
  const el = document.getElementById('fChiefConcern');
  if (selectedComplaints.has(idx)) {
    selectedComplaints.delete(idx);
    const parts = el.value.split('; ').filter(p => p !== complaint);
    el.value = parts.join('; ');
  } else {
    selectedComplaints.add(idx);
    el.value = el.value ? el.value + '; ' + complaint : complaint;
  }
  renderComplaintButtons();
}

// Procedure buttons
function renderProcedureButtons() {
  const procs = getProcedures().filter(p => !isPresetHidden('procedures', p));
  const grid = document.getElementById('procedureGrid');
  if (!grid) return;
  grid.innerHTML = procs.map(p => {
    const active = selectedProcedures.includes(p) ? ' active' : '';
    return `<button type="button" class="procedure-btn${active}" data-name="${esc(p)}">${esc(p)}</button>`;
  }).join('');
  grid.querySelectorAll('.procedure-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const name = btn.dataset.name;
      const idx = selectedProcedures.indexOf(name);
      if (idx >= 0) selectedProcedures.splice(idx, 1);
      else selectedProcedures.push(name);
      renderProcedureButtons();
    });
  });
}

// Provider buttons
function renderProviderButtons() {
  const providers = getProviders();
  const grid = document.getElementById('providerGrid');
  if (!grid) return;
  grid.innerHTML = providers.map(p => {
    const active = selectedProvider === p ? ' active' : '';
    return `<button type="button" class="provider-btn${active}" data-name="${esc(p)}">${esc(p)}</button>`;
  }).join('');
  grid.querySelectorAll('.provider-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      selectedProvider = selectedProvider === btn.dataset.name ? '' : btn.dataset.name;
      renderProviderButtons();
    });
  });
}

// Blood glucose interpretation \u2014 legacy stub (BG is now in the lab grid)
function updateBloodGlucoseInterp() {
  const input = document.getElementById('fBloodGlucose');
  const el = document.getElementById('bgInterpretation');
  if (!input || !el) return;
  const val = parseFloat(input.value);
  if (!val || isNaN(val)) { el.innerHTML = ''; return; }
  if (val < 140) { el.innerHTML = '<span class="bg-normal">Normal (<140 mg/dL)</span>'; }
  else if (val < 200) { el.innerHTML = '<span class="bg-elevated">Elevated (140-199 mg/dL)</span>'; }
  else { el.innerHTML = '<span class="bg-high">High (\u2265200 mg/dL)</span>'; }
}

// Referral type button grid
let selectedReferralType = 'None';
let selectedImagingType = '';

function renderReferralButtons() {
  const grid = document.getElementById('referralBtnGrid');
  if (!grid) return;
  const types = getReferralTypes().filter(t => !isPresetHidden('referralTypes', t));
  grid.innerHTML = types.map(t => {
    const active = selectedReferralType === t ? ' active' : '';
    return `<button type="button" class="referral-btn${active}" data-val="${esc(t)}">${esc(t)}</button>`;
  }).join('');
  grid.querySelectorAll('.referral-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      selectedReferralType = btn.dataset.val;
      renderReferralButtons();
      // Show/hide referral date picker
      const dateRow = document.getElementById('referralDateRow');
      if (dateRow) {
        dateRow.style.display = (selectedReferralType && selectedReferralType !== 'None') ? 'block' : 'none';
      }
    });
  });
}

// Keep for backward compat — now just re-renders buttons
function populateReferralSelect() { renderReferralButtons(); }

// BP range buttons
const BP_RANGES = [
  { label: '90/60', value: '90/60', range: 'low' },
  { label: '100/70', value: '100/70', range: 'normal' },
  { label: '110/70', value: '110/70', range: 'normal' },
  { label: '120/80', value: '120/80', range: 'normal' },
  { label: '130/85', value: '130/85', range: 'elevated' },
  { label: '140/90', value: '140/90', range: 'stage1' },
  { label: '150/95', value: '150/95', range: 'stage1' },
  { label: '160/100', value: '160/100', range: 'stage2' },
  { label: '180/110', value: '180/110', range: 'crisis' },
  { label: '200/120', value: '200/120', range: 'crisis' }
];
let selectedBP = '';

function renderBPRanges() {
  const container = document.getElementById('bpRangeRow');
  if (!container) return;
  container.innerHTML = BP_RANGES.map(bp => {
    const isActive = selectedBP === bp.value;
    let cls = 'bp-range-btn';
    if (isActive) {
      if (bp.range === 'normal') cls += ' active';
      else if (bp.range === 'elevated') cls += ' active';
      else if (bp.range === 'stage1') cls += ' active-fever';
      else if (bp.range === 'stage2' || bp.range === 'crisis') cls += ' active-high';
      else if (bp.range === 'low') cls += ' active-fever';
    }
    return `<button type="button" class="${cls}" data-val="${bp.value}" data-range="${bp.range}" title="${bp.value} mmHg">${bp.label}</button>`;
  }).join('');
  container.querySelectorAll('.bp-range-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      selectedBP = selectedBP === btn.dataset.val ? '' : btn.dataset.val;
      renderBPRanges();
    });
  });
}

// Dx-to-Rx suggestion logic removed per design — Rx presets are plain buttons now.
function getSuggestedRxPresetNames() { return new Set(); }
