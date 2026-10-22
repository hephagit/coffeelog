const DB_NAME = 'coffee-brew-journal';
const DB_VERSION = 2;
const STORE_NAME = 'entries';
const OPTIONS_STORE = 'options';
const BACKUP_VERSION = 2;
const DEFAULT_TOOLS = ['Hario V60 Switch', 'AeroPress', 'Aoutinn Nano Basket Plus'];

const form = document.querySelector('#entryForm');
const dialog = document.querySelector('#backupDialog');
const recordsElement = document.querySelector('#records');
const toastElement = document.querySelector('#toast');
let database;
let toastTimer;
let activeFilterCategory = 'all';
let activeFilterValue = 'all';

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(OPTIONS_STORE)) {
        const options = db.createObjectStore(OPTIONS_STORE, { keyPath: 'id' });
        DEFAULT_TOOLS.forEach(name => options.put({ id: crypto.randomUUID(), type: 'tool', name }));
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function requestFrom(storeName, mode, action) {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(storeName, mode);
    const request = action(transaction.objectStore(storeName));
    let result;
    request.onsuccess = () => { result = request.result; };
    request.onerror = () => reject(request.error);
    transaction.oncomplete = () => resolve(result);
    transaction.onerror = () => reject(transaction.error || new Error('저장 작업에 실패했습니다.'));
    transaction.onabort = () => reject(transaction.error || new Error('저장 작업이 취소되었습니다.'));
  });
}

function storeRequest(mode, action) { return requestFrom(STORE_NAME, mode, action); }
function optionRequest(mode, action) { return requestFrom(OPTIONS_STORE, mode, action); }

async function getEntries() {
  const entries = await storeRequest('readonly', store => store.getAll());
  return entries.sort((a, b) => b.date.localeCompare(a.date) || (b.updatedAt || 0) - (a.updatedAt || 0));
}

async function getOptions(type) {
  const options = await optionRequest('readonly', store => store.getAll());
  return options.filter(option => !type || option.type === type).sort((a, b) => a.name.localeCompare(b.name, 'ko'));
}

function showToast(message) {
  toastElement.textContent = message;
  toastElement.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastElement.classList.remove('show'), 2600);
}

function dateLabel(value) {
  const [year, month, day] = value.split('-').map(Number);
  return new Intl.DateTimeFormat('ko-KR', { dateStyle: 'long' }).format(new Date(year, month - 1, day));
}

function grindValue(value) {
  return String(value || '').replace(/\s*(?:클릭|clicks?)\s*$/i, '').trim();
}

function formatBrewTime(value) {
  const totalSeconds = Number(value) || 0;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Math.floor(totalSeconds % 60);
  return minutes === 0 ? `${seconds}초` : `${minutes}분 ${seconds}초`;
}

function updateDateDisplay() {
  const value = document.querySelector('#date').value;
  const display = document.querySelector('#dateDisplay');
  if (!value) { display.textContent = '날짜 선택'; return; }
  const [year, month, day] = value.split('-').map(Number);
  const weekday = ['일', '월', '화', '수', '목', '금', '토'][new Date(year, month - 1, day).getDay()];
  display.textContent = `${value} (${weekday})`;
}

function renderRecord(entry) {
  const card = document.createElement('article');
  card.className = 'record-card';
  const details = document.createElement('div');
  const date = document.createElement('p');
  date.className = 'record-date';
  date.textContent = dateLabel(entry.date);
  const title = document.createElement('h3');
  title.className = 'record-title';
  title.textContent = entry.beans;
  const meta = document.createElement('div');
  meta.className = 'record-meta';
  const isIncomplete = entry.yield == null || entry.time == null;
  let status = null;
  if (isIncomplete) {
    status = document.createElement('p');
    status.className = 'record-status';
    status.textContent = '추출 결과 미입력';
  }
  [entry.tool, `${entry.dose}g 투입`, `${grindValue(entry.grind)} 클릭`, entry.yield == null ? '' : `${entry.yield}g 추출`, entry.time == null ? '' : formatBrewTime(entry.time)].filter(Boolean).forEach(text => {
    const item = document.createElement('span');
    item.textContent = text;
    meta.append(item);
  });
  const rating = document.createElement('div');
  rating.className = 'record-rating';
  rating.textContent = `${'★'.repeat(Number(entry.rating) || 0)}${'☆'.repeat(5 - (Number(entry.rating) || 0))}`;
  const review = document.createElement('div');
  review.className = 'record-review';
  review.append(rating);
  if (entry.feedback) {
    const feedback = document.createElement('p');
    feedback.className = 'record-feedback';
    feedback.textContent = entry.feedback;
    review.append(feedback);
  }
  details.append(date, title);
  if (status) details.append(status);
  details.append(meta, review);
  const actions = document.createElement('div');
  actions.className = 'card-actions';
  const edit = document.createElement('button');
  edit.className = 'text-button';
  edit.type = 'button';
  edit.textContent = '수정';
  edit.addEventListener('click', () => beginEdit(entry));
  const remove = document.createElement('button');
  remove.className = 'text-button delete';
  remove.type = 'button';
  remove.textContent = '삭제';
  remove.addEventListener('click', () => deleteEntry(entry.id));
  actions.append(edit, remove);
  card.append(details, actions);
  return card;
}

async function refreshFilterOptions() {
  const menu = document.querySelector('#filterOptions');
  document.querySelectorAll('.filter-category-button').forEach(button => {
    const selected = button.dataset.category === activeFilterCategory;
    button.classList.toggle('active', selected);
    button.setAttribute('aria-pressed', String(selected));
  });
  if (activeFilterCategory === 'all') {
    menu.hidden = true;
    document.querySelector('#filterSelectionLabel').textContent = '전체 기록';
    return;
  }
  const categoryLabel = activeFilterCategory === 'tool' ? '추출 도구' : '원두 종류';
  const values = [...new Set((await getEntries()).map(entry => entry[activeFilterCategory]).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ko'));
  if (activeFilterValue !== 'all' && !values.includes(activeFilterValue)) activeFilterValue = 'all';
  menu.replaceChildren();
  const options = [{ label: `전체 ${categoryLabel}`, value: 'all' }, ...values.map(value => ({ label: value, value }))];
  options.forEach(option => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'filter-option-button';
    button.textContent = option.label;
    button.setAttribute('aria-pressed', String(activeFilterValue === option.value));
    button.addEventListener('click', async () => {
      activeFilterValue = option.value;
      menu.hidden = true;
      await refreshFilterOptions();
      await refreshList();
    });
    menu.append(button);
  });
  document.querySelector('#filterSelectionLabel').textContent = activeFilterValue === 'all' ? `전체 ${categoryLabel}` : `${categoryLabel}: ${activeFilterValue}`;
}

async function refreshList() {
  const entries = await getEntries();
  const filtered = activeFilterCategory === 'all' || activeFilterValue === 'all' ? entries : entries.filter(entry => entry[activeFilterCategory] === activeFilterValue);
  recordsElement.replaceChildren(...filtered.map(renderRecord));
  document.querySelector('#recordCount').textContent = String(entries.length);
  document.querySelector('#tabRecordCount').textContent = String(entries.length);
  document.querySelector('#emptyState').hidden = filtered.length > 0;
  document.querySelector('#emptyState').innerHTML = entries.length ? '선택한 분류에 기록이 없습니다.' : '아직 기록이 없습니다.<br>첫 추출을 저장해 보세요.';
}

function showPage(page) {
  const pages = { entry: ['entryPage', 'entryTab'], records: ['recordsPage', 'recordsTab'], settings: ['settingsPage', 'settingsTab'] };
  Object.entries(pages).forEach(([name, [pageId, tabId]]) => {
    const selected = name === page;
    document.querySelector(`#${pageId}`).hidden = !selected;
    const tab = document.querySelector(`#${tabId}`);
    tab.classList.toggle('active', selected);
    tab.setAttribute('aria-selected', String(selected));
  });
}

function setRating(value) {
  document.querySelector('#rating').value = value ? String(value) : '';
  document.querySelectorAll('.star-button').forEach(button => {
    const active = Number(button.dataset.rating) <= value;
    button.textContent = active ? '★' : '☆';
    button.classList.toggle('selected', active);
    button.setAttribute('aria-checked', String(Number(button.dataset.rating) === value));
  });
}

async function populateEntryOptions(selectedTool = '', selectedBeans = '') {
  const [tools, beans] = await Promise.all([getOptions('tool'), getOptions('beans')]);
  const fill = (selector, options, selected) => {
    const select = document.querySelector(selector);
    select.replaceChildren(new Option('목록에서 선택', ''));
    options.forEach(option => select.add(new Option(option.name, option.name)));
    if (selected && !options.some(option => option.name === selected)) select.add(new Option(selected, selected));
    select.value = selected;
  };
  fill('#tool', tools, selectedTool);
  fill('#beans', beans, selectedBeans);
}

async function refreshOptionLists() {
  const [tools, beans] = await Promise.all([getOptions('tool'), getOptions('beans')]);
  const render = (listId, options, type) => {
    const list = document.querySelector(listId);
    list.replaceChildren();
    if (!options.length) {
      const empty = document.createElement('li');
      empty.className = 'option-empty';
      empty.textContent = '등록된 항목이 없습니다.';
      list.append(empty);
      return;
    }
    options.forEach(option => {
      const row = document.createElement('li');
      row.className = 'option-row';
      const name = document.createElement('span');
      name.textContent = option.name;
      const actions = document.createElement('div');
      actions.className = 'option-actions';
      const edit = document.createElement('button');
      edit.type = 'button'; edit.className = 'text-button'; edit.textContent = '수정';
      edit.addEventListener('click', () => editOption(option, row));
      const remove = document.createElement('button');
      remove.type = 'button'; remove.className = 'text-button delete'; remove.textContent = '삭제';
      remove.addEventListener('click', () => deleteOption(option));
      actions.append(edit, remove);
      row.append(name, actions);
      list.append(row);
    });
  };
  render('#toolOptions', tools, 'tool');
  render('#beanOptions', beans, 'beans');
  await populateEntryOptions(document.querySelector('#tool').value, document.querySelector('#beans').value);
}

function currentFormEntry() {
  const hourInput = document.querySelector('#timeHours').value.trim();
  const minuteInput = document.querySelector('#timeMinutes').value.trim();
  const secondInput = document.querySelector('#timeSeconds').value.trim();
  const timeProvided = Boolean(hourInput || minuteInput || secondInput);
  const hours = Number(hourInput) || 0;
  const minutes = Number(minuteInput) || 0;
  const seconds = Number(secondInput) || 0;
  const totalSeconds = hours * 3600 + minutes * 60 + seconds;
  document.querySelector('#time').value = timeProvided ? totalSeconds : '';
  return {
    id: document.querySelector('#entryId').value || crypto.randomUUID(),
    date: document.querySelector('#date').value,
    tool: document.querySelector('#tool').value,
    beans: document.querySelector('#beans').value,
    dose: Number(document.querySelector('#dose').value),
    grind: grindValue(document.querySelector('#grind').value),
    yield: document.querySelector('#yield').value === '' ? null : Number(document.querySelector('#yield').value),
    time: timeProvided ? totalSeconds : null,
    rating: Number(document.querySelector('#rating').value),
    feedback: document.querySelector('#feedback').value.trim(),
    updatedAt: Date.now()
  };
}

function resetForm() {
  form.reset();
  document.querySelector('#entryId').value = '';
  document.querySelector('#date').value = new Date().toLocaleDateString('sv-SE');
  updateDateDisplay();
  document.querySelector('#formTitle').textContent = '오늘의 커피';
  document.querySelector('#saveButton').textContent = '기록 저장';
  document.querySelector('#cancelEdit').hidden = true;
  setRating(0);
}

async function beginEdit(entry) {
  showPage('entry');
  await populateEntryOptions(entry.tool, entry.beans);
  document.querySelector('#entryId').value = entry.id;
  document.querySelector('#date').value = entry.date;
  updateDateDisplay();
  document.querySelector('#dose').value = entry.dose;
  document.querySelector('#grind').value = grindValue(entry.grind);
  document.querySelector('#yield').value = entry.yield ?? '';
  const totalSeconds = Number(entry.time) || 0;
  document.querySelector('#timeHours').value = Math.floor(totalSeconds / 3600) || '';
  document.querySelector('#timeMinutes').value = Math.floor((totalSeconds % 3600) / 60) || '';
  document.querySelector('#timeSeconds').value = entry.time == null ? '' : String(totalSeconds % 60);
  document.querySelector('#feedback').value = entry.feedback || '';
  setRating(Number(entry.rating));
  document.querySelector('#formTitle').textContent = '기록 수정';
  document.querySelector('#saveButton').textContent = '수정 내용 저장';
  document.querySelector('#cancelEdit').hidden = false;
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

async function deleteEntry(id) {
  if (!window.confirm('이 추출 기록을 삭제할까요?')) return;
  await storeRequest('readwrite', store => store.delete(id));
  await refreshFilterOptions();
  await refreshList();
  showToast('기록을 삭제했습니다.');
}

function isValidEntry(entry) {
  return entry && typeof entry.id === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(entry.date)
    && typeof entry.tool === 'string' && entry.tool.trim() && typeof entry.beans === 'string' && entry.beans.trim()
    && Number.isFinite(Number(entry.dose)) && Number(entry.dose) >= 0
    && typeof entry.grind === 'string' && entry.grind.trim()
    && (entry.yield == null || (Number.isFinite(Number(entry.yield)) && Number(entry.yield) >= 0))
    && (entry.time == null || (Number.isFinite(Number(entry.time)) && Number(entry.time) >= 0))
    && Number.isInteger(Number(entry.rating)) && Number(entry.rating) >= 0 && Number(entry.rating) <= 5
    && (entry.feedback === undefined || typeof entry.feedback === 'string');
}

function isValidOption(option) {
  return option && typeof option.id === 'string' && ['tool', 'beans'].includes(option.type) && typeof option.name === 'string' && option.name.trim();
}

async function replaceBackupData(entries, options) {
  await new Promise((resolve, reject) => {
    const transaction = database.transaction([STORE_NAME, OPTIONS_STORE], 'readwrite');
    const entryStore = transaction.objectStore(STORE_NAME);
    const optionsStore = transaction.objectStore(OPTIONS_STORE);
    entryStore.clear();
    optionsStore.clear();
    entries.forEach(entry => entryStore.put({ ...entry, feedback: entry.feedback || '', dose: Number(entry.dose), yield: entry.yield == null ? null : Number(entry.yield), time: entry.time == null ? null : Number(entry.time), rating: Number(entry.rating), updatedAt: Number(entry.updatedAt) || Date.now() }));
    options.forEach(option => optionsStore.put({ ...option, name: option.name.trim() }));
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error || new Error('복원 작업이 취소되었습니다.'));
  });
}

async function addOption(type, name) {
  const normalized = name.trim();
  const options = await getOptions(type);
  if (!normalized || options.some(option => option.name.toLocaleLowerCase() === normalized.toLocaleLowerCase())) {
    showToast(normalized ? '같은 이름이 이미 목록에 있습니다.' : '항목 이름을 입력해 주세요.');
    return false;
  }
  await optionRequest('readwrite', store => store.add({ id: crypto.randomUUID(), type, name: normalized }));
  return true;
}

function editOption(option, row) {
  const form = document.createElement('form');
  form.className = 'option-inline-edit';
  const input = document.createElement('input');
  input.type = 'text';
  input.value = option.name;
  input.maxLength = 120;
  input.setAttribute('aria-label', '수정할 항목 이름');
  input.required = true;
  const save = document.createElement('button');
  save.type = 'submit';
  save.className = 'button button-primary';
  save.textContent = '저장';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'button button-light';
  cancel.textContent = '취소';
  cancel.addEventListener('click', () => refreshOptionLists());
  form.append(input, save, cancel);
  row.replaceChildren(form);
  input.focus();
  input.select();

  form.addEventListener('submit', async event => {
    event.preventDefault();
    const normalized = input.value.trim();
    if (!normalized) { showToast('항목 이름을 입력해 주세요.'); input.focus(); return; }
    try {
      const options = await getOptions(option.type);
      if (options.some(item => item.id !== option.id && item.name.toLocaleLowerCase() === normalized.toLocaleLowerCase())) {
        showToast('같은 이름이 이미 목록에 있습니다.');
        input.focus();
        return;
      }
      await new Promise((resolve, reject) => {
        const transaction = database.transaction([OPTIONS_STORE, STORE_NAME], 'readwrite');
        transaction.objectStore(OPTIONS_STORE).put({ ...option, name: normalized });
        const entries = transaction.objectStore(STORE_NAME);
        const request = entries.getAll();
        request.onsuccess = () => request.result.filter(entry => entry[option.type] === option.name).forEach(entry => {
          entry[option.type] = normalized;
          entries.put(entry);
        });
        transaction.oncomplete = resolve;
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error || new Error('수정 작업이 취소되었습니다.'));
      });
      await refreshOptionLists();
      await refreshFilterOptions();
      await refreshList();
      showToast('항목 이름을 수정했습니다.');
    } catch {
      showToast('항목을 수정하지 못했습니다. 다시 시도해 주세요.');
    }
  });
}

async function deleteOption(option) {
  if (!window.confirm(`'${option.name}' 항목을 목록에서 삭제할까요? 이미 저장한 기록에는 이름이 유지됩니다.`)) return;
  await optionRequest('readwrite', store => store.delete(option.id));
  await refreshOptionLists();
  showToast('목록에서 항목을 삭제했습니다.');
}

document.querySelectorAll('.star-button').forEach(button => button.addEventListener('click', () => {
  const clickedRating = Number(button.dataset.rating);
  const currentRating = Number(document.querySelector('#rating').value) || 0;
  setRating(currentRating === clickedRating ? clickedRating - 1 : clickedRating);
}));
document.querySelector('#starRating').addEventListener('keydown', event => {
  if (!['ArrowLeft', 'ArrowDown', 'ArrowRight', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  const current = Number(document.querySelector('#rating').value) || 0;
  const next = event.key === 'Home' ? 1 : event.key === 'End' ? 5 : Math.min(5, Math.max(1, current + (['ArrowRight', 'ArrowUp'].includes(event.key) ? 1 : -1)));
  setRating(next);
  document.querySelector(`[data-rating="${next}"]`).focus();
});
document.querySelector('#cancelEdit').addEventListener('click', resetForm);
document.querySelector('#date').addEventListener('change', updateDateDisplay);
document.querySelector('.time-inputs').addEventListener('click', event => {
  if (event.target instanceof HTMLInputElement) return;
  event.preventDefault();
  document.querySelector('#timeSeconds').focus();
});
document.querySelector('#copyPreviousButton').addEventListener('click', async () => {
  try {
    const entries = await getEntries();
    const previous = entries[0];
    if (!previous) { showToast('복사할 기록이 없습니다.'); return; }
    await populateEntryOptions(previous.tool, previous.beans);
    document.querySelector('#tool').value = previous.tool;
    document.querySelector('#beans').value = previous.beans;
    document.querySelector('#grind').value = grindValue(previous.grind);
    document.querySelector('#dose').value = previous.dose;
    showToast('기록 탭의 가장 최근 날짜에서 추출 도구·원두 종류·원두 투입량·분쇄도를 가져왔습니다.');
  } catch {
    showToast('직전 기록을 불러오지 못했습니다.');
  }
});
document.querySelector('.date-picker').addEventListener('click', () => {
  const dateInput = document.querySelector('#date');
  dateInput.focus({ preventScroll: true });
  try {
    if (typeof dateInput.showPicker === 'function') dateInput.showPicker();
    else { dateInput.focus(); dateInput.click(); }
  } catch {
    dateInput.focus();
    dateInput.click();
  }
});
document.querySelector('#entryTab').addEventListener('click', () => showPage('entry'));
document.querySelector('#recordsTab').addEventListener('click', () => showPage('records'));
document.querySelector('#settingsTab').addEventListener('click', () => showPage('settings'));
document.querySelectorAll('.filter-category-button').forEach(button => button.addEventListener('click', async () => {
  activeFilterCategory = button.dataset.category;
  activeFilterValue = 'all';
  const menu = document.querySelector('#filterOptions');
  menu.hidden = activeFilterCategory === 'all';
  await refreshFilterOptions();
  await refreshList();
}));
document.querySelectorAll('.add-option-button').forEach(button => button.addEventListener('click', () => {
  const form = document.querySelector(button.dataset.type === 'tool' ? '#toolAddForm' : '#beanAddForm');
  form.hidden = false;
  form.querySelector('input').focus();
}));
document.querySelectorAll('.cancel-option-button').forEach(button => button.addEventListener('click', () => {
  const form = button.closest('form');
  form.reset();
  form.hidden = true;
}));
[['toolAddForm', 'tool', 'toolName'], ['beanAddForm', 'beans', 'beanName']].forEach(([formId, type, inputId]) => {
  document.querySelector(`#${formId}`).addEventListener('submit', async event => {
    event.preventDefault();
    const submitForm = event.currentTarget;
    try {
      const added = await addOption(type, document.querySelector(`#${inputId}`).value);
      if (!added) return;
      submitForm.reset();
      submitForm.hidden = true;
      await refreshOptionLists();
      showToast('목록에 항목을 추가했습니다.');
    } catch {
      showToast('항목을 저장하지 못했습니다. 다시 시도해 주세요.');
    }
  });
});
document.querySelector('#backupButton').addEventListener('click', () => dialog.showModal());
document.querySelector('#closeDialog').addEventListener('click', () => dialog.close());
document.querySelector('#exportButton').addEventListener('click', async () => {
  try {
    const backup = { app: 'coffee-brew-journal', version: BACKUP_VERSION, exportedAt: new Date().toISOString(), entries: await getEntries(), options: await getOptions() };
    const url = URL.createObjectURL(new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `coffee-records-${new Date().toLocaleDateString('sv-SE')}.json`;
    link.click();
    URL.revokeObjectURL(url);
    showToast('JSON 백업 파일을 만들었습니다.');
  } catch { showToast('백업 파일을 만들지 못했습니다.'); }
});
document.querySelector('#importFile').addEventListener('change', async event => {
  const file = event.target.files[0];
  if (!file) return;
  try {
    const backup = JSON.parse(await file.text());
    if (backup.app !== 'coffee-brew-journal' || ![1, BACKUP_VERSION].includes(backup.version) || !Array.isArray(backup.entries) || !backup.entries.every(isValidEntry)) throw new Error('형식 오류');
    let options = backup.options;
    if (!Array.isArray(options) && backup.version === 1) {
      options = [...new Set([...DEFAULT_TOOLS, ...backup.entries.map(entry => entry.tool)])].map(name => ({ id: crypto.randomUUID(), type: 'tool', name }));
      [...new Set(backup.entries.map(entry => entry.beans))].forEach(name => options.push({ id: crypto.randomUUID(), type: 'beans', name }));
    }
    if (!Array.isArray(options) || !options.every(isValidOption)) throw new Error('목록 형식 오류');
    if (!window.confirm(`백업의 ${backup.entries.length}개 기록과 선택 목록으로 현재 데이터를 교체할까요?`)) return;
    await replaceBackupData(backup.entries, options);
    await refreshOptionLists();
    await refreshFilterOptions();
    await refreshList();
    dialog.close();
    showToast(`${backup.entries.length}개 기록과 목록을 복원했습니다.`);
  } catch { showToast('백업 파일을 읽지 못했습니다. 올바른 커피 기록 JSON인지 확인해 주세요.'); }
  finally { event.target.value = ''; }
});
form.addEventListener('submit', async event => {
  event.preventDefault();
  const entry = currentFormEntry();
  if (!isValidEntry(entry)) { showToast('날짜, 추출 도구, 원두 종류, 도징량, 분쇄도를 확인해 주세요.'); return; }
  try {
    await storeRequest('readwrite', store => store.put(entry));
    await refreshFilterOptions();
    await refreshList();
    resetForm();
    showPage('records');
    showToast(entry.yield == null || entry.time == null ? '추출 전 기록을 저장했습니다. 추출 후 수정해 주세요.' : '추출 기록을 저장했습니다.');
  } catch { showToast('기록을 저장하지 못했습니다.'); }
});

async function start() {
  document.querySelector('#date').value = new Date().toLocaleDateString('sv-SE');
  updateDateDisplay();
  try {
    database = await openDatabase();
    const entries = await getEntries();
    const options = await getOptions();
    for (const entry of entries) {
      for (const [type, name] of [['tool', entry.tool], ['beans', entry.beans]]) {
        if (name && !options.some(option => option.type === type && option.name === name)) {
          await optionRequest('readwrite', store => store.add({ id: crypto.randomUUID(), type, name }));
          options.push({ type, name });
        }
      }
    }
    await refreshOptionLists();
    await refreshFilterOptions();
    await refreshList();
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('./service-worker.js').catch(() => {});
  } catch {
    showToast('기록 저장소를 열지 못했습니다. 브라우저 설정을 확인해 주세요.');
  }
}
start();
