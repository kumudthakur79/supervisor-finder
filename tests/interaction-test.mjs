import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

class ClassList {
  constructor(...names) { this.names = new Set(names); }
  add(...names) { names.forEach(x => this.names.add(x)); }
  remove(...names) { names.forEach(x => this.names.delete(x)); }
  contains(name) { return this.names.has(name); }
  toggle(name, force) {
    const next = force === undefined ? !this.contains(name) : force;
    next ? this.add(name) : this.remove(name);
    return next;
  }
}

const elements = new Map();
const defaults = { universityFilter: 'all', evidenceFilter: 'all', sortSelect: 'fit-desc' };
const inputIds = new Set(['searchInput','professorId','professorName','professorUniversity','professorAreas','evidenceSource','directionInterests','authUsername','authPassword']);
const selectIds = new Set(['universityFilter','evidenceFilter','sortSelect','aiRating','cyberRating','intersectionRating','fundingRating']);

class MockElement {
  constructor(id) {
    this.id = id;
    this.value = defaults[id] ?? '';
    this.textContent = '';
    this.classList = new ClassList(...(/Modal$/.test(id) || ['appShell','emptyState','compareBar','toast','formError','weightsError','deleteProfessorBtn','importBanner','authError','registerHint','syncWarning'].includes(id) ? ['hidden'] : []));
    this.style = {};
    this.dataset = {};
    this.listeners = {};
    this.disabled = false;
    this.tagName = inputIds.has(id) ? 'INPUT' : selectIds.has(id) ? 'SELECT' : 'DIV';
    this._innerHTML = '';
  }
  set innerHTML(value) {
    this._innerHTML = String(value);
    for (const match of this._innerHTML.matchAll(/id="([^"]+)"[^>]*?(?:value="([^"]*)")?/g)) {
      const child = getElement(match[1]);
      const valueMatch = match[0].match(/value="([^"]*)"/);
      if (valueMatch) child.value = valueMatch[1];
    }
  }
  get innerHTML() { return this._innerHTML; }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  async trigger(type, event = {}) {
    for (const fn of this.listeners[type] || []) await fn({ preventDefault() {}, target: this, ...event });
  }
  setAttribute() {}
  querySelector() { return null; }
  focus() {}
}
function getElement(id) {
  if (!elements.has(id)) elements.set(id, new MockElement(id));
  return elements.get(id);
}

const documentListeners = {};
const document = {
  body: { style: {} }, getElementById: getElement,
  querySelectorAll: () => [],
  addEventListener(type, fn) { (documentListeners[type] ||= []).push(fn); }
};
const storage = new Map();
const localStorage = {
  getItem: key => storage.get(key) ?? null,
  setItem: (key, value) => storage.set(key, value),
  removeItem: key => storage.delete(key)
};
const accounts = new Map();
let currentUser = null;
const emptyState = () => ({
  professors: [], weights: { ai:25, cyber:25, intersection:35, funding:15 },
  direction: { interests:['AI','Cybersecurity'], text:'Research direction' }
});
const reply = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type':'application/json' } });
async function fetch(path, options = {}) {
  const body = options.body ? JSON.parse(options.body) : {};
  if (path === '/api/me') return currentUser ? reply({ username: currentUser }) : reply({ error:'Sign in' },401);
  if (path === '/api/register') {
    if (accounts.has(body.username)) return reply({error:'Taken'},409);
    accounts.set(body.username, { password:body.password, data:emptyState(), revision:0 });
    currentUser = body.username; return reply({username:currentUser},201);
  }
  if (path === '/api/login') {
    const account = accounts.get(body.username);
    if (!account || account.password !== body.password) return reply({error:'Incorrect username or password'},401);
    currentUser = body.username; return reply({username:currentUser});
  }
  if (path === '/api/logout') { currentUser = null; return reply({ok:true}); }
  if (path === '/api/analyze-profile') return reply({
    suggestions: {
      name:'Dr. Profile Example', university:'Example University',
      areas:['adversarial machine learning','machine learning'],
      ai:4, cyber:3, intersection:4, funding:null,
      profileUrl:body.url, source:body.url,
      notes:'Suggested from public profile.'
    },
    evidence: { ai:['machine learning'], cyber:['cybersecurity'], intersection:['adversarial machine learning'], funding:[] },
    method:'Matched specific phrases. Review before saving.'
  });
  if (path === '/api/workspace') {
    if (!currentUser) return reply({error:'Sign in'},401);
    const account = accounts.get(currentUser);
    if (options.method === 'PUT') {
      if (body.revision !== account.revision) return reply({error:'Workspace changed elsewhere'},409);
      account.data = JSON.parse(JSON.stringify(body.data)); account.revision++;
      return reply({revision:account.revision});
    }
    return reply({data:account.data, revision:account.revision});
  }
  return reply({error:'Not found'},404);
}
vm.runInNewContext(fs.readFileSync('app.js', 'utf8'), {
  document, localStorage, fetch, Response, crypto: globalThis.crypto, console,
  setTimeout: () => 1, clearTimeout: () => {},
  Number, JSON, Math, Date, String, Object, Array, Set
});
await new Promise(setImmediate);
assert.equal(getElement('appShell').classList.contains('hidden'), true, 'Workspace should be hidden before sign-in');
await getElement('registerTab').trigger('click');
getElement('authUsername').value = 'test_user';
getElement('authPassword').value = 'safe password for testing';
await getElement('authForm').trigger('submit');
assert.equal(getElement('appShell').classList.contains('hidden'), false, 'Registration should show workspace');
assert.equal(getElement('allCount').textContent, 0, 'New account should start empty');

await getElement('addBtn').trigger('click');
getElement('professorProfileUrl').value = 'https://faculty.example.edu/profile';
await getElement('analyzeProfileBtn').trigger('click');
assert.equal(getElement('professorName').value, 'Dr. Profile Example', 'Profile name suggestion missing');
assert.equal(getElement('fundingRating').value, '', 'Unknown funding should stay unscored');
assert.match(getElement('profileEvidence').innerHTML, /adversarial machine learning/);
getElement('professorName').value = 'Professor Alpha';
getElement('professorUniversity').value = 'Test University';
await getElement('professorForm').trigger('submit');
await new Promise(setImmediate);
assert.equal(accounts.get('test_user').data.professors[0].profileUrl, 'https://faculty.example.edu/profile');

async function addCandidate(name) {
  await getElement('addBtn').trigger('click');
  getElement('professorName').value = name;
  getElement('professorUniversity').value = 'Test University';
  getElement('professorAreas').value = 'AI, cybersecurity';
  getElement('aiRating').value = '5';
  getElement('cyberRating').value = '5';
  getElement('intersectionRating').value = '5';
  getElement('fundingRating').value = '5';
  await getElement('professorForm').trigger('submit');
  await new Promise(setImmediate);
}
await addCandidate('Professor Beta');
assert.equal(getElement('allCount').textContent, 2);
assert.match(getElement('candidateGrid').innerHTML, /<strong>100<\/strong>/, 'Fit score did not render');
const ids = [...getElement('candidateGrid').innerHTML.matchAll(/data-id="([^"]+)"/g)].map(match => match[1]);
function delegatedAction(actionName, id) {
  const card = { dataset: { id } };
  const action = { dataset: { action: actionName }, closest: selector => selector === '[data-id]' ? card : null };
  const target = { classList: new ClassList(), closest: selector => selector === '[data-action]' ? action : null };
  (documentListeners.click || []).forEach(fn => fn({ target }));
}
delegatedAction('shortlist', ids[0]);
await new Promise(setImmediate);
assert.equal(getElement('shortlistCount').textContent, 1);
delegatedAction('compare', ids[0]); delegatedAction('compare', ids[1]);
assert.equal(getElement('openCompareBtn').disabled, false);
await getElement('openCompareBtn').trigger('click');
assert.match(getElement('comparisonGrid').innerHTML, /Professor Alpha/);

await getElement('accountBtn').trigger('click');
assert.equal(getElement('appShell').classList.contains('hidden'), true, 'Sign out should hide workspace');
getElement('authUsername').value = 'test_user';
getElement('authPassword').value = 'safe password for testing';
await getElement('authForm').trigger('submit');
assert.equal(getElement('allCount').textContent, 2, 'Sign in did not restore account workspace');
assert.equal(getElement('shortlistCount').textContent, 1, 'Shortlist was not restored');
console.log('PASS: sign-up, profile suggestions, workspace save, scoring, shortlist, comparison, sign-out, sign-in');
