(function () {
  'use strict';

  const STORAGE_KEY = 'supervisor-fit-lab-v1';
  const BALANCED_WEIGHTS = { ai: 25, cyber: 25, intersection: 35, funding: 15 };
  const defaultState = {
    professors: [],
    weights: { ...BALANCED_WEIGHTS },
    direction: {
      interests: ['Artificial intelligence', 'Cybersecurity', 'AI × cybersecurity'],
      text: 'Intended PhD direction: research at the intersection of artificial intelligence and cybersecurity, while keeping both fields individually relevant.'
    }
  };

  let state = clone(defaultState);
  let revision = 0;
  let saveQueue = Promise.resolve();
  let authMode = 'login';
  let signedIn = false;
  let activeView = 'all';
  let compareIds = [];
  let toastTimer;

  const $ = (id) => document.getElementById(id);
  const els = {
    grid: $('candidateGrid'), empty: $('emptyState'), allCount: $('allCount'), shortlistCount: $('shortlistCount'),
    search: $('searchInput'), university: $('universityFilter'), evidence: $('evidenceFilter'), sort: $('sortSelect'), summary: $('summaryStrip'),
    compareBar: $('compareBar'), compareCount: $('compareCount'), openCompare: $('openCompareBtn'), comparisonGrid: $('comparisonGrid'),
    professorModal: $('professorModal'), weightsModal: $('weightsModal'), directionModal: $('directionModal'), compareModal: $('compareModal'), toast: $('toast')
  };

  function clone(value) { return JSON.parse(JSON.stringify(value)); }
  async function api(path, options = {}) {
    const response = await fetch(path, { credentials: 'same-origin', ...options });
    let data;
    try { data = await response.json(); } catch (_) { throw new Error('The server returned an unexpected response.'); }
    if (!response.ok) {
      if (response.status === 401 && path !== '/api/login') showAuth();
      throw new Error(data.error || 'Request failed.');
    }
    return data;
  }
  function saveState() {
    const snapshot = clone(state);
    saveQueue = saveQueue.catch(() => {}).then(async () => {
      const data = await api('/api/workspace', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ revision, data: snapshot })
      });
      revision = data.revision;
    });
    return saveQueue.catch(error => {
      showToast(error.message);
      if (/changed elsewhere/.test(error.message)) {
        $('syncWarning').classList.remove('hidden');
      }
      throw error;
    });
  }
  function showAuth() {
    signedIn = false;
    state = clone(defaultState);
    compareIds = [];
    $('appShell').classList.add('hidden');
    $('authScreen').classList.remove('hidden');
    $('importBanner').classList.add('hidden');
  }
  async function startWorkspace(username) {
    const workspace = await api('/api/workspace');
    state = workspace.data;
    revision = workspace.revision;
    signedIn = true;
    $('accountName').textContent = username;
    $('authScreen').classList.add('hidden');
    $('appShell').classList.remove('hidden');
    $('authPassword').value = '';
    $('authError').classList.add('hidden');
    updateImportBanner();
    render();
  }
  async function checkSession() {
    try {
      const account = await api('/api/me');
      await startWorkspace(account.username);
    } catch (_) { showAuth(); }
  }
  function setAuthMode(mode) {
    authMode = mode;
    const registering = mode === 'register';
    $('authTitle').textContent = registering ? 'Create your workspace' : 'Welcome back';
    $('authSubtitle').textContent = registering ? 'Your professor notes stay in your account.' : 'Sign in to your professor matcher.';
    $('authSubmit').textContent = registering ? 'Create account' : 'Sign in';
    $('authPassword').autocomplete = registering ? 'new-password' : 'current-password';
    $('registerHint').classList.toggle('hidden', !registering);
    $('loginTab').classList.toggle('active', !registering);
    $('registerTab').classList.toggle('active', registering);
    $('loginTab').setAttribute('aria-selected', registering ? 'false' : 'true');
    $('registerTab').setAttribute('aria-selected', registering ? 'true' : 'false');
    $('authError').classList.add('hidden');
  }
  async function submitAuth(event) {
    event.preventDefault();
    const username = $('authUsername').value.trim();
    const password = $('authPassword').value;
    $('authError').classList.add('hidden');
    $('authSubmit').disabled = true;
    try {
      const account = await api(authMode === 'register' ? '/api/register' : '/api/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password })
      });
      await startWorkspace(account.username);
    } catch (error) {
      $('authError').textContent = error.message;
      $('authError').classList.remove('hidden');
    } finally { $('authSubmit').disabled = false; }
  }
  async function signOut() {
    try {
      await saveQueue.catch(() => {});
      await api('/api/logout', { method: 'POST' });
    } catch (error) { showToast(error.message); return; }
    showAuth(); setAuthMode('login');
    showToast('Signed out.');
  }
  function previousWorkspace() {
    try {
      const old = JSON.parse(localStorage.getItem(STORAGE_KEY));
      return old && Array.isArray(old.professors) && old.professors.length ? old : null;
    } catch (_) { return null; }
  }
  function updateImportBanner() {
    $('importBanner').classList.toggle('hidden', !(previousWorkspace() && state.professors.length === 0));
  }
  async function importPreviousWorkspace() {
    const old = previousWorkspace();
    if (!old || state.professors.length) return;
    state = {
      professors: old.professors.map(p => ({
        id: String(p.id || crypto.randomUUID()), name: String(p.name || 'Unknown'),
        university: String(p.university || 'Unknown'), areas: Array.isArray(p.areas) ? p.areas : ['Unknown'],
        ai: p.ai ?? null, cyber: p.cyber ?? null, intersection: p.intersection ?? null,
        funding: p.funding ?? null, source: String(p.source || ''), notes: String(p.notes || ''),
        profileUrl: String(p.profileUrl || ''),
        shortlisted: Boolean(p.shortlisted)
      })),
      weights: { ...BALANCED_WEIGHTS, ...(old.weights || {}) },
      direction: { ...defaultState.direction, ...(old.direction || {}) }
    };
    render();
    try {
      await saveState();
      localStorage.removeItem(STORAGE_KEY);
      updateImportBanner();
      showToast('Previous workspace imported.');
    } catch (_) { /* Keep the browser copy available for retry. */ }
  }
  function escapeHtml(value) { return String(value ?? '').replace(/[&<>'"]/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#39;', '"':'&quot;' }[c])); }
  function parseRating(value) { return value === '' || value == null ? null : Number(value); }
  function initials(name) { return name.replace(/^(Dr\.|Professor|Prof\.)\s*/i, '').split(/\s+/).filter(Boolean).slice(0,2).map(x => x[0]).join('').toUpperCase() || '?'; }
  function criterionValues(p) { return { ai: p.ai, cyber: p.cyber, intersection: p.intersection, funding: p.funding }; }
  function scoreProfessor(p) {
    const values = criterionValues(p);
    let knownWeight = 0, points = 0;
    Object.keys(state.weights).forEach(key => {
      const value = values[key];
      if (value !== null && value !== '' && value !== undefined && Number.isFinite(Number(value))) {
        knownWeight += Number(state.weights[key]);
        points += (Number(value) / 5) * Number(state.weights[key]);
      }
    });
    return { score: knownWeight ? Math.round((points / knownWeight) * 100) : null, coverage: Math.round(knownWeight), known: Object.values(values).filter(v => v !== null && v !== '' && v !== undefined).length };
  }
  function fundingLabel(value) {
    const labels = { 0:'No visible funding signal', 2:'Weak funding signal', 3:'Possible funding', 4:'Positive funding signal', 5:'Strong funding signal' };
    return value === null || value === '' || value === undefined ? 'Funding unknown' : (labels[value] || 'Funding noted');
  }
  function ratingLabel(value) { return value === null || value === '' || value === undefined ? 'Unknown' : `${value}/5`; }
  function showToast(message) { clearTimeout(toastTimer); els.toast.textContent = message; els.toast.classList.remove('hidden'); toastTimer = setTimeout(() => els.toast.classList.add('hidden'), 2600); }
  function openModal(id) { $(id).classList.remove('hidden'); document.body.style.overflow = 'hidden'; setTimeout(() => $(id).querySelector('input,button,select,textarea')?.focus(), 30); }
  function closeModal(id) { $(id).classList.add('hidden'); document.body.style.overflow = ''; }

  function renderDirection() {
    $('interestTags').innerHTML = state.direction.interests.map(x => `<span>${escapeHtml(x)}</span>`).join('');
    $('directionNote').textContent = state.direction.text;
  }
  function renderUniversities() {
    const current = els.university.value || 'all';
    const universities = [...new Set(state.professors.map(p => p.university).filter(Boolean))].sort();
    els.university.innerHTML = '<option value="all">All universities</option>' + universities.map(u => `<option value="${escapeHtml(u)}">${escapeHtml(u)}</option>`).join('');
    els.university.value = universities.includes(current) ? current : 'all';
  }
  function filteredProfessors() {
    const q = els.search.value.trim().toLowerCase();
    let list = state.professors.filter(p => {
      const score = scoreProfessor(p);
      const haystack = [p.name, p.university, ...(p.areas || []), p.notes, p.profileUrl || ''].join(' ').toLowerCase();
      return (activeView !== 'shortlist' || p.shortlisted) &&
        (!q || haystack.includes(q)) &&
        (els.university.value === 'all' || p.university === els.university.value) &&
        (els.evidence.value === 'all' || (els.evidence.value === 'scored' ? score.score !== null : score.score === null));
    });
    list.sort((a,b) => {
      const sa = scoreProfessor(a), sb = scoreProfessor(b);
      if (els.sort.value === 'name-asc') return a.name.localeCompare(b.name);
      if (els.sort.value === 'coverage-desc') return sb.coverage - sa.coverage || (sb.score ?? -1) - (sa.score ?? -1);
      return (sb.score ?? -1) - (sa.score ?? -1) || sb.coverage - sa.coverage || a.name.localeCompare(b.name);
    });
    return list;
  }
  function renderCard(p) {
    const s = scoreProfessor(p);
    const areas = (p.areas || []).filter(Boolean);
    const areaHtml = areas.length && !areas.every(x => x.toLowerCase() === 'unknown')
      ? areas.slice(0,4).map(x => `<span class="area-chip">${escapeHtml(x)}</span>`).join('')
      : '<span class="area-chip unknown">Research areas unknown</span>';
    const isCompared = compareIds.includes(p.id);
    return `<article class="candidate-card" data-id="${escapeHtml(p.id)}">
      <div class="candidate-top">
        <div class="avatar" aria-hidden="true">${escapeHtml(initials(p.name))}</div>
        <div class="candidate-identity"><h3 title="${escapeHtml(p.name)}">${escapeHtml(p.name)}</h3><p title="${escapeHtml(p.university)}">${escapeHtml(p.university)}</p></div>
        <button class="shortlist-btn ${p.shortlisted ? 'active' : ''}" data-action="shortlist" aria-label="${p.shortlisted ? 'Remove from' : 'Add to'} shortlist" title="${p.shortlisted ? 'Remove from shortlist' : 'Add to shortlist'}">${p.shortlisted ? '★' : '☆'}</button>
      </div>
      <div class="score-row">
        <div class="score-ring ${s.score === null ? 'unscored' : ''}" style="--score:${s.score ?? 0}"><div class="score-value">${s.score === null ? '<strong>Unscored</strong><span>fit</span>' : `<strong>${s.score}</strong><span>fit score</span>`}</div></div>
        <div class="score-meta"><h4>${s.score === null ? 'Needs verified evidence' : s.score >= 80 ? 'Strong current alignment' : s.score >= 60 ? 'Promising current alignment' : 'Limited current alignment'}</h4><p>${s.score === null ? 'Unknown criteria are excluded from ranking.' : `Calculated from ${s.known} known ${s.known === 1 ? 'criterion' : 'criteria'}.`}</p><div class="coverage"><div class="coverage-head"><span>Evidence coverage</span><span>${s.coverage}%</span></div><div class="coverage-track"><div class="coverage-fill" style="width:${s.coverage}%"></div></div></div></div>
      </div>
      <div class="area-list">${areaHtml}${p.profileUrl?.startsWith('https://') ? `<a class="profile-link" href="${escapeHtml(p.profileUrl)}" target="_blank" rel="noopener noreferrer">View profile ↗</a>` : ''}</div>
      <div class="card-footer"><span class="funding-badge ${p.funding !== null && p.funding !== '' ? 'known' : ''}">${escapeHtml(fundingLabel(p.funding))}</span><div class="card-buttons"><button class="small-button" data-action="edit">Edit</button><button class="small-button ${isCompared ? 'selected' : ''}" data-action="compare">${isCompared ? 'Selected' : 'Compare'}</button></div></div>
    </article>`;
  }
  function render() {
    if (!signedIn) return;
    renderDirection();
    renderUniversities();
    const list = filteredProfessors();
    els.grid.innerHTML = list.map(renderCard).join('');
    els.grid.classList.toggle('hidden', list.length === 0);
    els.empty.classList.toggle('hidden', list.length > 0);
    if (state.professors.length === 0) {
      $('emptyTitle').textContent = 'Start with a professor';
      $('emptyText').textContent = 'Add a candidate to begin building your shortlist.';
      $('clearFiltersBtn').classList.add('hidden');
    } else {
      $('emptyTitle').textContent = 'No candidates match these filters';
      $('emptyText').textContent = 'Clear a filter or add a professor to continue your comparison.';
      $('clearFiltersBtn').classList.remove('hidden');
    }
    const shortlistCount = state.professors.filter(p => p.shortlisted).length;
    els.allCount.textContent = state.professors.length;
    els.shortlistCount.textContent = shortlistCount;
    const unscored = state.professors.filter(p => scoreProfessor(p).score === null).length;
    els.summary.innerHTML = `<span><strong>${list.length}</strong> shown</span><span><strong>${shortlistCount}</strong> shortlisted</span><span><strong>${unscored}</strong> need evidence</span>`;
    renderCompareBar();
  }
  function renderCompareBar() {
    const n = compareIds.length;
    els.compareBar.classList.toggle('hidden', n === 0);
    els.compareCount.textContent = `${n} selected`;
    els.openCompare.disabled = n < 2;
  }

  function openProfessorForm(id) {
    const p = id ? state.professors.find(x => x.id === id) : null;
    $('professorModalTitle').textContent = p ? 'Edit professor' : 'Add professor';
    $('professorId').value = p?.id || '';
    $('professorName').value = p?.name || '';
    $('professorUniversity').value = p?.university || '';
    $('professorAreas').value = p?.areas?.join(', ') || '';
    $('professorProfileUrl').value = p?.profileUrl || '';
    $('profileStatus').textContent = 'Paste a profile link to suggest details, then review them before saving.';
    $('profileEvidence').classList.add('hidden');
    $('profileEvidence').innerHTML = '';
    $('aiRating').value = p?.ai ?? '';
    $('cyberRating').value = p?.cyber ?? '';
    $('intersectionRating').value = p?.intersection ?? '';
    $('fundingRating').value = p?.funding ?? '';
    $('evidenceSource').value = p?.source || '';
    $('professorNotes').value = p?.notes || '';
    $('deleteProfessorBtn').classList.toggle('hidden', !p);
    $('formError').classList.add('hidden');
    openModal('professorModal');
  }
  function uniqueId(name) { return `${name.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'') || 'candidate'}-${Date.now().toString(36)}`; }
  async function analyzeProfileLink() {
    const url = $('professorProfileUrl').value.trim();
    if (!url.startsWith('https://')) {
      $('profileStatus').textContent = 'Enter a public HTTPS professor profile link.';
      return;
    }
    $('analyzeProfileBtn').disabled = true;
    $('profileStatus').textContent = 'Reading the profile page…';
    $('profileEvidence').classList.add('hidden');
    try {
      const result = await api('/api/analyze-profile', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url })
      });
      const p = result.suggestions;
      if (p.name) $('professorName').value = p.name;
      if (p.university) $('professorUniversity').value = p.university;
      if (p.areas?.length) $('professorAreas').value = p.areas.join(', ');
      ['ai','cyber','intersection','funding'].forEach(key => {
        const field = $(key === 'ai' ? 'aiRating' : key === 'cyber' ? 'cyberRating' : key === 'intersection' ? 'intersectionRating' : 'fundingRating');
        field.value = p[key] ?? '';
      });
      $('evidenceSource').value = p.source || '';
      $('professorNotes').value = p.notes || '';
      $('professorProfileUrl').value = p.profileUrl || url;
      const labels = { ai:'AI', cyber:'Cybersecurity', intersection:'AI × cyber', funding:'Funding' };
      $('profileEvidence').innerHTML = '<h4>Matched phrases on the page</h4>' +
        Object.entries(labels).map(([key,label]) => {
          const terms = result.evidence?.[key] || [];
          return `<p class="evidence-quote"><strong>${label}:</strong> ${terms.length ? terms.map(escapeHtml).join(', ') : 'No clear phrase found · Unknown'}</p>`;
        }).join('') + `<p>${escapeHtml(result.method)}</p>`;
      $('profileEvidence').classList.remove('hidden');
      $('profileStatus').textContent = 'Suggestions added. Check the name, university, scores, and funding before saving.';
    } catch (error) { $('profileStatus').textContent = error.message + ' You can still enter the profile manually.'; }
    finally { $('analyzeProfileBtn').disabled = false; }
  }
  function saveProfessor(event) {
    event.preventDefault();
    const name = $('professorName').value.trim(), university = $('professorUniversity').value.trim();
    if (!name || !university) { $('formError').textContent = 'Professor name and university are required.'; $('formError').classList.remove('hidden'); return; }
    const profileUrl = $('professorProfileUrl').value.trim();
    if (profileUrl && !/^https:\/\/[^\s]+$/i.test(profileUrl)) {
      $('formError').textContent = 'Use a valid HTTPS profile link or leave it blank.';
      $('formError').classList.remove('hidden');
      return;
    }
    const existingId = $('professorId').value;
    const duplicate = state.professors.some(p => p.id !== existingId && p.name.trim().toLowerCase() === name.toLowerCase() && p.university.trim().toLowerCase() === university.toLowerCase());
    if (duplicate) { $('formError').textContent = 'This professor already exists for that university.'; $('formError').classList.remove('hidden'); return; }
    const existing = state.professors.find(p => p.id === existingId);
    const areas = $('professorAreas').value.split(',').map(x => x.trim()).filter(Boolean);
    const record = { id: existingId || uniqueId(name), name, university, areas: areas.length ? areas : ['Unknown'], ai: parseRating($('aiRating').value), cyber: parseRating($('cyberRating').value), intersection: parseRating($('intersectionRating').value), funding: parseRating($('fundingRating').value), profileUrl, source: $('evidenceSource').value.trim(), notes: $('professorNotes').value.trim(), shortlisted: existing?.shortlisted || false };
    if (existing) state.professors[state.professors.findIndex(p => p.id === existingId)] = record; else state.professors.push(record);
    void saveState().catch(() => {}); closeModal('professorModal'); render(); showToast(existing ? 'Candidate updated.' : 'Candidate added.');
  }
  function deleteProfessor() {
    const id = $('professorId').value;
    if (!id) return;
    state.professors = state.professors.filter(p => p.id !== id);
    compareIds = compareIds.filter(x => x !== id);
    void saveState().catch(() => {}); closeModal('professorModal'); render(); showToast('Candidate deleted.');
  }

  function ratingOptions() { return '<option value="">Unknown</option>' + [0,1,2,3,4,5].map(n => `<option value="${n}">${n} — ${['No alignment','Very weak','Weak','Moderate','Strong','Direct match'][n]}</option>`).join(''); }
  ['aiRating','cyberRating','intersectionRating'].forEach(id => $(id).innerHTML = ratingOptions());

  const weightInfo = {
    ai: ['AI alignment','Match with AI/ML interests'], cyber: ['Cybersecurity alignment','Match with security interests'], intersection: ['AI × cybersecurity','Direct overlap is prioritized'], funding: ['Funding signal','Evidence of funded PhD capacity']
  };
  function renderWeightControls() {
    $('weightControls').innerHTML = Object.keys(weightInfo).map(key => `<div class="weight-control"><label for="weight-${key}"><strong>${weightInfo[key][0]}</strong><span>${weightInfo[key][1]}</span></label><input id="weight-${key}" data-weight="${key}" type="range" min="0" max="70" step="5" value="${state.weights[key]}"><span class="weight-number" id="weight-value-${key}">${state.weights[key]}%</span></div>`).join('');
    updateWeightTotal();
  }
  function updateWeightTotal() {
    const total = Object.keys(weightInfo).reduce((sum,key) => sum + Number($(`weight-${key}`)?.value || 0), 0);
    $('weightTotal').textContent = `${total}%`;
    $('weightTotal').style.color = total === 100 ? 'var(--green)' : 'var(--danger)';
    Object.keys(weightInfo).forEach(key => { if ($(`weight-value-${key}`)) $(`weight-value-${key}`).textContent = `${$(`weight-${key}`).value}%`; });
    return total;
  }
  function saveWeights(event) {
    event.preventDefault();
    if (updateWeightTotal() !== 100) { $('weightsError').textContent = 'Weights must total exactly 100%.'; $('weightsError').classList.remove('hidden'); return; }
    Object.keys(weightInfo).forEach(key => state.weights[key] = Number($(`weight-${key}`).value));
    void saveState().catch(() => {}); closeModal('weightsModal'); render(); showToast('Scoring model updated.');
  }
  function resetWeights() { Object.keys(BALANCED_WEIGHTS).forEach(key => $(`weight-${key}`).value = BALANCED_WEIGHTS[key]); $('weightsError').classList.add('hidden'); updateWeightTotal(); }

  function openDirectionForm() { $('directionInterests').value = state.direction.interests.join(', '); $('directionText').value = state.direction.text; openModal('directionModal'); }
  function saveDirection(event) { event.preventDefault(); const interests = $('directionInterests').value.split(',').map(x=>x.trim()).filter(Boolean); if (!interests.length) return; state.direction = { interests, text: $('directionText').value.trim() }; void saveState().catch(() => {}); closeModal('directionModal'); renderDirection(); showToast('Research direction updated.'); }

  function toggleCompare(id) {
    if (compareIds.includes(id)) compareIds = compareIds.filter(x => x !== id);
    else if (compareIds.length < 3) compareIds.push(id);
    else { showToast('Compare up to three candidates at a time.'); return; }
    render();
  }
  function openComparison() {
    if (compareIds.length < 2) return;
    const people = compareIds.map(id => state.professors.find(p => p.id === id)).filter(Boolean);
    const rows = [
      ['Candidate', p => `<div class="compare-cell head"><h3>${escapeHtml(p.name)}</h3><p>${escapeHtml(p.university)}</p></div>`],
      ['Fit score', p => { const s=scoreProfessor(p); return `<div class="compare-cell"><span class="compare-score">${s.score === null ? 'Unscored' : `${s.score}<small>/100</small>`}</span><div>Evidence coverage: ${s.coverage}%</div></div>`; }],
      ['AI alignment', p => criterionCell(p.ai)], ['Cybersecurity', p => criterionCell(p.cyber)], ['AI × cyber', p => criterionCell(p.intersection)],
      ['Funding', p => `<div class="compare-cell ${p.funding == null ? 'unknown-text' : ''}">${escapeHtml(fundingLabel(p.funding))}</div>`],
      ['Research areas', p => `<div class="compare-cell">${(p.areas||['Unknown']).map(escapeHtml).join(', ')}</div>`],
      ['Profile link', p => `<div class="compare-cell">${p.profileUrl?.startsWith('https://') ? `<a class="profile-link" href="${escapeHtml(p.profileUrl)}" target="_blank" rel="noopener noreferrer">Open professor profile ↗</a>` : '<span class="unknown-text">Unknown</span>'}</div>`],
      ['Evidence source', p => `<div class="compare-cell ${!p.source ? 'unknown-text' : ''}">${p.source ? escapeHtml(p.source) : 'Unknown'}</div>`],
      ['Notes', p => `<div class="compare-cell ${!p.notes ? 'unknown-text' : ''}">${p.notes ? escapeHtml(p.notes) : 'No notes yet'}</div>`]
    ];
    els.comparisonGrid.className = `comparison-grid cols-${people.length}`;
    els.comparisonGrid.innerHTML = rows.map(row => `<div class="compare-label">${row[0]}</div>${people.map(row[1]).join('')}`).join('');
    openModal('compareModal');
  }
  function criterionCell(value) { return value == null ? '<div class="compare-cell unknown-text">Unknown</div>' : `<div class="compare-cell"><strong>${ratingLabel(value)}</strong><div class="criterion-bar"><span style="width:${value*20}%"></span></div></div>`; }

  document.addEventListener('click', event => {
    const close = event.target.closest('[data-close]'); if (close) { closeModal(close.dataset.close); return; }
    if (event.target.classList.contains('modal-backdrop')) closeModal(event.target.id);
    const action = event.target.closest('[data-action]');
    if (action) { const card = action.closest('[data-id]'); const id = card?.dataset.id; if (action.dataset.action === 'edit') openProfessorForm(id); if (action.dataset.action === 'compare') toggleCompare(id); if (action.dataset.action === 'shortlist') { const p=state.professors.find(x=>x.id===id); p.shortlisted=!p.shortlisted; void saveState().catch(() => {}); render(); showToast(p.shortlisted ? 'Added to shortlist.' : 'Removed from shortlist.'); } }
  });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') document.querySelectorAll('.modal-backdrop:not(.hidden)').forEach(m => closeModal(m.id)); });
  document.querySelectorAll('.tab').forEach(tab => tab.addEventListener('click', () => { document.querySelectorAll('.tab').forEach(x => { x.classList.toggle('active', x===tab); x.setAttribute('aria-selected', x===tab ? 'true':'false'); }); activeView=tab.dataset.view; render(); }));
  [els.search, els.university, els.evidence, els.sort].forEach(el => el.addEventListener(el.tagName === 'INPUT' ? 'input':'change', render));
  $('addBtn').addEventListener('click', () => openProfessorForm());
  $('analyzeProfileBtn').addEventListener('click', analyzeProfileLink);
  $('weightsBtn').addEventListener('click', () => { renderWeightControls(); $('weightsError').classList.add('hidden'); openModal('weightsModal'); });
  $('editDirectionBtn').addEventListener('click', openDirectionForm);
  $('professorForm').addEventListener('submit', saveProfessor);
  $('deleteProfessorBtn').addEventListener('click', deleteProfessor);
  $('weightsForm').addEventListener('submit', saveWeights);
  $('weightControls').addEventListener('input', e => { if (e.target.matches('[data-weight]')) updateWeightTotal(); });
  $('resetWeightsBtn').addEventListener('click', resetWeights);
  $('directionForm').addEventListener('submit', saveDirection);
  $('clearCompareBtn').addEventListener('click', () => { compareIds=[]; render(); });
  $('openCompareBtn').addEventListener('click', openComparison);
  $('clearFiltersBtn').addEventListener('click', () => { els.search.value=''; els.university.value='all'; els.evidence.value='all'; render(); });
  $('loginTab').addEventListener('click', () => setAuthMode('login'));
  $('registerTab').addEventListener('click', () => setAuthMode('register'));
  $('authForm').addEventListener('submit', submitAuth);
  $('accountBtn').addEventListener('click', signOut);
  $('importBtn').addEventListener('click', importPreviousWorkspace);
  void checkSession();
})();
