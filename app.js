/* 학부모 연락처 3D
 * 전화번호부(연락처)와 문자 메시지를 분석해 학생 이름으로 학부모 번호를 찾아 3D로 보여줍니다.
 * 모든 처리는 브라우저 안에서만 이루어집니다.
 */
(() => {
  'use strict';

  const $ = (s) => document.querySelector(s);
  const STORE_KEY = 'parentfinder3d.data.v1';
  const PERSIST_KEY = 'parentfinder3d.persist';

  /* ------------------------------------------------------------------ *
   * 전화번호 유틸
   * ------------------------------------------------------------------ */
  function normPhone(p) {
    let d = String(p || '').replace(/\D/g, '');
    if (d.startsWith('82') && d.length >= 11) d = d.slice(2).startsWith('0') ? d.slice(2) : '0' + d.slice(2);
    return d;
  }
  function fmtPhone(d) {
    if (d.startsWith('02')) {
      if (d.length === 9) return d.replace(/(\d{2})(\d{3})(\d{4})/, '$1-$2-$3');
      if (d.length === 10) return d.replace(/(\d{2})(\d{4})(\d{4})/, '$1-$2-$3');
    }
    if (d.length === 11) return d.replace(/(\d{3})(\d{4})(\d{4})/, '$1-$2-$3');
    if (d.length === 10) return d.replace(/(\d{3})(\d{3})(\d{4})/, '$1-$2-$3');
    return d;
  }
  const PHONE_RE = /(?:\+?82[\s-]?)?0?1[016789][\s.-]?\d{3,4}[\s.-]?\d{4}|0\d{1,2}[\s.-]\d{3,4}[\s.-]\d{4}/g;
  const isValidPhone = (d) => d.length >= 9 && d.length <= 12;

  const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const escHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /* ------------------------------------------------------------------ *
   * 데이터 상태
   * ------------------------------------------------------------------ */
  const state = { contacts: [], messages: [] };
  let phoneToName = new Map();
  const contactKeys = new Set();
  const messageKeys = new Set();

  function addContact(name, phones) {
    name = String(name || '').trim();
    const list = [...new Set((phones || []).map(normPhone).filter(isValidPhone))];
    if (!name || !list.length) return false;
    const key = name + '|' + list.join(',');
    if (contactKeys.has(key)) return false;
    contactKeys.add(key);
    state.contacts.push({ name, phones: list });
    return true;
  }
  function addMessage(address, body, opts = {}) {
    const a = normPhone(address);
    body = String(body || '').trim();
    if (!isValidPhone(a) || !body) return false;
    const key = a + '|' + (opts.date || '') + '|' + body.slice(0, 80);
    if (messageKeys.has(key)) return false;
    messageKeys.add(key);
    state.messages.push({ address: a, body, date: opts.date || 0, dir: opts.dir || 'in' });
    return true;
  }
  function rebuildIndex() {
    phoneToName = new Map();
    for (const c of state.contacts) for (const p of c.phones) if (!phoneToName.has(p)) phoneToName.set(p, c.name);
  }
  function resetData() {
    state.contacts = []; state.messages = [];
    contactKeys.clear(); messageKeys.clear(); rebuildIndex();
  }

  /* ------------------------------------------------------------------ *
   * 파서: vCard / CSV / SMS Backup XML / 일반 텍스트
   * ------------------------------------------------------------------ */
  function qpDecode(str, charset) {
    const bytes = [];
    for (let i = 0; i < str.length; i++) {
      if (str[i] === '=' && /^[0-9A-Fa-f]{2}$/.test(str.substr(i + 1, 2))) { bytes.push(parseInt(str.substr(i + 1, 2), 16)); i += 2; }
      else bytes.push(str.charCodeAt(i) & 0xff);
    }
    try { return new TextDecoder(charset || 'utf-8').decode(new Uint8Array(bytes)); }
    catch (e) { return new TextDecoder('utf-8').decode(new Uint8Array(bytes)); }
  }
  function vUnescape(s) { return s.replace(/\\n/gi, ' ').replace(/\\([,;:\\])/g, '$1'); }

  function parseVCF(text) {
    const raw = text.replace(/\r\n?/g, '\n').split('\n');
    const lines = [];
    for (const l of raw) {
      const prev = lines[lines.length - 1];
      if (prev !== undefined && /QUOTED-PRINTABLE/i.test(prev) && prev.endsWith('=')) lines[lines.length - 1] = prev.slice(0, -1) + l;
      else if (prev !== undefined && /^[ \t]/.test(l)) lines[lines.length - 1] = prev + l.slice(1);
      else lines.push(l);
    }
    let cur = null, added = 0;
    for (const line of lines) {
      const ci = line.indexOf(':');
      if (ci < 0) continue;
      const left = line.slice(0, ci), value = line.slice(ci + 1);
      const parts = left.split(';');
      const prop = parts[0].replace(/^.*\./, '').toUpperCase();
      const params = parts.slice(1).join(';').toUpperCase();
      if (prop === 'BEGIN' && /VCARD/i.test(value)) { cur = { fn: '', n: '', tels: [] }; continue; }
      if (!cur) continue;
      if (prop === 'END') {
        if (addContact(cur.fn || cur.n, cur.tels)) added++;
        cur = null; continue;
      }
      let v = value;
      if (/QUOTED-PRINTABLE/.test(params)) {
        const cs = (params.match(/CHARSET=([\w-]+)/) || [])[1];
        v = qpDecode(v, cs);
      }
      v = vUnescape(v);
      if (prop === 'FN') cur.fn = v.trim();
      else if (prop === 'N') {
        const [fam = '', given = '', mid = ''] = v.split(';');
        const g = [given, mid].filter(Boolean).join(' ');
        cur.n = /^[가-힣]+$/.test(fam) && /^[가-힣]/.test(g) ? fam + g : [g, fam].filter(Boolean).join(' ');
      } else if (prop === 'TEL') cur.tels.push(v);
    }
    return added;
  }

  function parseCSVRows(text) {
    const rows = []; let row = [], f = '', q = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (q) {
        if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; }
        else f += c;
      } else if (c === '"') q = true;
      else if (c === ',') { row.push(f); f = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        row.push(f); rows.push(row); row = []; f = '';
      } else f += c;
    }
    if (f || row.length) { row.push(f); rows.push(row); }
    return rows.filter((r) => r.some((x) => x.trim()));
  }
  function parseCSV(text) {
    const rows = parseCSVRows(text.replace(/^﻿/, ''));
    if (rows.length < 2) return 0;
    const h = rows[0].map((x) => x.trim().toLowerCase());
    const find = (re) => h.findIndex((x) => re.test(x));
    const iName = find(/^(name|이름|full name|display name|표시 이름|성명|별칭|nickname)$/);
    const iFirst = find(/^(first name|given name|이름\(名\))$/);
    const iLast = find(/^(last name|family name|성)$/);
    const phoneCols = h.map((x, i) => (/(phone|전화|휴대|mobile|tel|핸드폰|연락처)/.test(x) && !/(type|label|유형|종류)/.test(x) ? i : -1)).filter((i) => i >= 0);
    if (!phoneCols.length) return 0;
    let added = 0;
    for (const r of rows.slice(1)) {
      let name = iName >= 0 ? r[iName] : '';
      if (!name) {
        const last = iLast >= 0 ? (r[iLast] || '').trim() : '';
        const first = iFirst >= 0 ? (r[iFirst] || '').trim() : '';
        name = /^[가-힣]+$/.test(last) && /^[가-힣]/.test(first) ? last + first : [first, last].filter(Boolean).join(' ');
      }
      const phones = [];
      for (const i of phoneCols) for (const p of String(r[i] || '').split(/:::|[,;\/]/)) phones.push(p);
      if (addContact(name, phones)) added++;
    }
    return added;
  }

  function parseSmsXML(text) {
    const doc = new DOMParser().parseFromString(text, 'application/xml');
    if (doc.querySelector('parsererror')) throw new Error('XML 형식이 올바르지 않습니다');
    let msgs = 0, contacts = 0;
    for (const el of doc.querySelectorAll('sms')) {
      const address = el.getAttribute('address');
      const dir = el.getAttribute('type') === '2' ? 'out' : 'in';
      if (addMessage(address, el.getAttribute('body'), { date: +el.getAttribute('date') || 0, dir })) msgs++;
      const cn = el.getAttribute('contact_name');
      if (cn && !/unknown/i.test(cn) && addContact(cn, [address])) contacts++;
    }
    for (const el of doc.querySelectorAll('mms')) {
      const address = el.getAttribute('address') || '';
      if (address.includes('~')) continue; // 단체 문자는 제외
      const body = [...el.querySelectorAll('part')].map((p) => p.getAttribute('text') || '').filter((t) => t && t !== 'null').join(' ');
      const dir = el.getAttribute('msg_box') === '2' ? 'out' : 'in';
      if (addMessage(address, body, { date: +el.getAttribute('date') || 0, dir })) msgs++;
      const cn = el.getAttribute('contact_name');
      if (cn && !/unknown/i.test(cn) && addContact(cn, [address])) contacts++;
    }
    return { msgs, contacts };
  }

  // 붙여넣은 텍스트: 번호가 나오면 그 번호를 '현재 발신자'로 보고, 이후 줄을 그 번호의 문자로 간주
  function parsePlainMessages(text) {
    let current = '', added = 0;
    for (const line of text.replace(/\r/g, '').split('\n')) {
      const found = line.match(PHONE_RE);
      if (found) current = found[found.length - 1];
      const body = line.replace(PHONE_RE, ' ').replace(/^[\s:：\-–>]+/, '').trim();
      if (current && body && addMessage(current, body, { date: Date.now() + added })) added++;
    }
    return added;
  }

  /* ------------------------------------------------------------------ *
   * 검색 로직
   * ------------------------------------------------------------------ */
  const ROLE_WORDS = [
    ['할아버지', '할아버지'], ['할머니', '할머니'], ['학부모', '학부모'], ['보호자', '보호자'], ['부모님', '학부모'],
    ['어머님', '어머니'], ['어머니', '어머니'], ['아버님', '아버지'], ['아버지', '아버지'],
    ['엄마', '어머니'], ['아빠', '아버지'], ['부모', '학부모'], ['mom', '어머니'], ['dad', '아버지'],
    ['맘', '어머니'], ['母', '어머니'], ['父', '아버지'], ['이모', '보호자'], ['고모', '보호자'], ['삼촌', '보호자'],
  ];
  const ROLE_ALT = ROLE_WORDS.map((w) => escRe(w[0])).join('|');
  const roleOfWord = (w) => (ROLE_WORDS.find((r) => r[0] === w.toLowerCase()) || [])[1];
  function roleOf(text) {
    const t = text.toLowerCase();
    for (const [w, role] of ROLE_WORDS) if (t.includes(w)) return role;
    return null;
  }

  function nameVariants(q) {
    const v = [{ v: q, full: true }];
    if (/^[가-힣]{3,4}$/.test(q)) v.push({ v: q.slice(1), full: false });
    if (/^[가-힣]{4}$/.test(q)) v.push({ v: q.slice(2), full: false });
    return v;
  }

  function matchContactName(name, variants) {
    const lower = name.toLowerCase();
    const tight = lower.replace(/\s+/g, '');
    for (const { v, full } of variants) {
      const idx = tight.indexOf(v);
      if (idx < 0) continue;
      const rest = (tight.slice(0, idx) + ' ' + tight.slice(idx + v.length)).replace(/[()[\]{}<>\-_.,/·|]/g, ' ');
      let role = roleOf(rest);
      if (!role) {
        // "김민수(모)", "김민수 부", "김민수모" 같은 한 글자 표기
        const m = tight.slice(idx + v.length).match(/^[\s(\[]*([모부])(?:[)\]]|$|[^가-힣])/);
        if (m) role = m[1] === '모' ? '어머니' : '아버지';
      }
      if (role) return { score: full ? 100 : 75, role, full };
      if (full) return { score: 35, role: '관련', full };
    }
    return null;
  }

  function snippetAround(body, start, len) {
    const s = Math.max(0, start - 28), e = Math.min(body.length, start + len + 36);
    return (s > 0 ? '…' : '') + body.slice(s, e) + (e < body.length ? '…' : '');
  }

  function matchMessage(body, variants) {
    for (const { v, full } of variants) {
      const re = new RegExp(escRe(v) + '\\s*(?:이|이의|의|군|양|학생|학생의)?\\s*(' + ROLE_ALT + ')', 'i');
      const m = body.match(re);
      if (m) return { score: full ? 90 : 65, role: roleOfWord(m[1]) || '학부모', snippet: snippetAround(body, m.index, m[0].length), hit: m[0] };
    }
    const full = variants[0].v;
    const i = body.replace(/\s+/g, '').indexOf(full) >= 0 ? body.indexOf(full) : -1;
    if (i >= 0) return { score: 30, role: '관련', snippet: snippetAround(body, i, full.length), hit: full };
    return null;
  }

  function search(query) {
    const q = query.replace(/\s+/g, '').toLowerCase();
    if (!q) return [];
    const variants = nameVariants(q);
    const hits = new Map();
    const add = (phone, ev) => {
      let h = hits.get(phone);
      if (!h) { h = { phone, best: 0, role: '관련', roleScore: -1, evidence: [], contactName: '' }; hits.set(phone, h); }
      h.evidence.push(ev);
      if (ev.score > h.best) h.best = ev.score;
      if (ev.role !== '관련' && ev.score > h.roleScore) { h.role = ev.role; h.roleScore = ev.score; }
      if (ev.source === 'contact' && ev.score >= (h.contactScore || 0)) { h.contactName = ev.text; h.contactScore = ev.score; }
    };
    for (const c of state.contacts) {
      const r = matchContactName(c.name, variants);
      if (r) for (const p of c.phones) add(p, { source: 'contact', score: r.score, role: r.role, text: c.name, hit: '' });
    }
    for (const m of state.messages) {
      const r = matchMessage(m.body, variants);
      if (r) add(m.address, { source: 'message', score: r.score, role: r.role, text: r.snippet, hit: r.hit, date: m.date, dir: m.dir });
    }
    const out = [];
    for (const h of hits.values()) {
      h.evidence.sort((a, b) => b.score - a.score || (b.date || 0) - (a.date || 0));
      const strong = h.evidence.filter((e) => e.score >= 60).length;
      h.score = Math.min(100, h.best + Math.max(0, strong - 1) * 4);
      h.name = h.contactName || phoneToName.get(h.phone) || '';
      h.msgCount = h.evidence.filter((e) => e.source === 'message').length;
      h.hasContact = h.evidence.some((e) => e.source === 'contact');
      h.student = query.trim();
      out.push(h);
    }
    out.sort((a, b) => b.score - a.score || b.evidence.length - a.evidence.length);
    return out;
  }
  const confLabel = (s) => (s >= 90 ? '매우 높음' : s >= 65 ? '높음' : s >= 40 ? '보통' : '낮음');

  /* ------------------------------------------------------------------ *
   * 저장
   * ------------------------------------------------------------------ */
  const safeGet = (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } };
  const safeSet = (k, v) => { try { localStorage.setItem(k, v); return true; } catch (e) { return false; } };
  const safeDel = (k) => { try { localStorage.removeItem(k); } catch (e) { /* noop */ } };

  function save() {
    if ($('#persist').checked) {
      if (!safeSet(STORE_KEY, JSON.stringify(state))) toast('저장 공간이 부족해 이 기기에 저장하지 못했어요');
    } else safeDel(STORE_KEY);
  }
  function load() {
    const persist = safeGet(PERSIST_KEY) === '1';
    $('#persist').checked = persist;
    if (!persist) return;
    try {
      const d = JSON.parse(safeGet(STORE_KEY) || 'null');
      if (!d) return;
      for (const c of d.contacts || []) addContact(c.name, c.phones);
      for (const m of d.messages || []) addMessage(m.address, m.body, m);
    } catch (e) { /* 손상된 저장값은 무시 */ }
  }

  /* ------------------------------------------------------------------ *
   * 샘플 데이터 (가상의 인물/번호)
   * ------------------------------------------------------------------ */
  function loadSample() {
    const C = [
      ['김민수 어머니', '010-2481-3301'], ['민수아빠', '010-2481-3302'], ['이서연(모)', '010-5512-0071'],
      ['박지호 학부모', '010-7730-4419'], ['최유진', '010-3321-8800'], ['정하준 아버님', '010-9045-1123'],
      ['한소율맘', '010-6620-7780'], ['교무실', '02-555-1234'], ['윤도현 할머니', '010-4410-2290'],
      ['강예린 엄마', '010-8123-5567'], ['조은우', '010-2256-9031'], ['오시우 보호자', '010-3367-4402'],
      ['장하린 母', '010-7781-1290'], ['임지안 아빠', '010-1180-6643'], ['서준혁 어머님', '010-6034-2218'],
      ['학원 원장님', '010-9911-0001'], ['배수아(부)', '010-4545-7721'], ['신태윤 학부모', '010-2007-3348'],
    ];
    const M = [
      ['010-3321-8811', '선생님 안녕하세요. 최유진 엄마입니다. 내일 체험학습 동의서 오늘 보낼게요!', 'in'],
      ['010-3321-8811', '유진이가 감기 기운이 있어서 오늘 조퇴 가능할까요?', 'in'],
      ['010-2481-3301', '민수 어머님, 다음 주 화요일 상담 일정 확인 부탁드립니다.', 'out'],
      ['010-5090-2234', '안녕하세요 조은우 아버지입니다. 은우 방과후 신청 관련 문의드려요.', 'in'],
      ['010-4410-2290', '도현이 할머니예요. 오늘 도현이 제가 데리러 갑니다.', 'in'],
      ['010-8123-5567', '예린이 엄마입니다~ 준비물 알려주셔서 감사해요', 'in'],
      ['010-7777-1212', '선생님 김민수 학생 이번 주 숙제 관련해서 여쭤봅니다 - 민수 아빠', 'in'],
    ];
    let c = 0, m = 0;
    for (const [n, p] of C) if (addContact(n, [p])) c++;
    M.forEach(([a, b, dir], i) => { if (addMessage(a, b, { dir, date: Date.now() - i * 3600e3 })) m++; });
    dataChanged();
    toast(`샘플: 연락처 ${c}개 · 문자 ${m}개를 불러왔어요`);
    $('#q').value = '김민수';
    doSearch();
  }

  /* ------------------------------------------------------------------ *
   * UI
   * ------------------------------------------------------------------ */
  let toastTimer = 0;
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg; t.classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
  }

  function dataChanged() {
    rebuildIndex();
    $('#statContacts').textContent = state.contacts.length.toLocaleString();
    $('#statMessages').textContent = state.messages.length.toLocaleString();
    $('#dataBadge').textContent = (state.contacts.length + state.messages.length).toLocaleString();
    updateHint();
    save();
    Scene.setContacts(state.contacts);
  }

  let results = [];
  let current = 0;

  function updateHint() {
    if (!state.contacts.length && !state.messages.length) $('#hint').innerHTML = '먼저 <b>📥 데이터</b>에서 연락처·문자를 불러오세요.';
    else if (!results.length && !$('#q').value.trim()) $('#hint').textContent = `연락처 ${state.contacts.length}개 · 문자 ${state.messages.length}개에서 검색합니다.`;
  }

  function doSearch() {
    const q = $('#q').value.trim();
    results = q ? search(q).slice(0, 12) : [];
    current = 0;
    renderList(q);
    Scene.showResults(results);
    updatePager();
  }

  function renderList(q) {
    const box = $('#results');
    if (!q) {
      box.innerHTML = '';
      updateHint();
      return;
    }
    if (!state.contacts.length && !state.messages.length) {
      box.innerHTML = '<div class="empty-msg">아직 불러온 데이터가 없어요. 상단 <b>📥 데이터</b>를 눌러 연락처나 문자를 불러오세요.</div>';
      $('#hint').textContent = '';
      return;
    }
    if (!results.length) {
      box.innerHTML = `<div class="empty-msg">‘${escHtml(q)}’ 학생의 학부모 번호를 찾지 못했어요. 이름(성 제외)으로도 검색해 보세요.</div>`;
      $('#hint').textContent = '';
      return;
    }
    const top = results.filter((r) => r.role !== '관련').length;
    $('#hint').textContent = top ? `학부모로 보이는 번호 ${top}개를 찾았어요` : '학부모 표기는 없지만 관련된 번호가 있어요';
    box.innerHTML = results.map((r, i) => `
      <button class="row-item${i === current ? ' active' : ''}" data-i="${i}" type="button">
        <span class="role-pill role-${escHtml(r.role)}">${escHtml(r.role === '관련' ? '관련' : r.role)}</span>
        <span><span class="phone">${fmtPhone(r.phone)}</span><br><span class="sub">${escHtml(r.name || '저장 안 된 번호')} · ${r.hasContact ? '📇' : ''}${r.msgCount ? ' 💬' + r.msgCount : ''}</span></span>
        <span class="conf">${confLabel(r.score)}<br><a class="call-mini" href="tel:${r.phone}" data-call="1">📞 전화</a></span>
      </button>`).join('');
  }

  function updatePager() {
    const nav = $('#carouselNav');
    nav.hidden = results.length < 2;
    $('#pager').textContent = `${current + 1} / ${results.length}`;
    document.querySelectorAll('.row-item').forEach((el, i) => el.classList.toggle('active', i === current));
  }
  function focusResult(i) {
    if (!results.length) return;
    current = (i + results.length) % results.length;
    Scene.focus(current);
    updatePager();
    const el = document.querySelector(`.row-item[data-i="${current}"]`);
    if (el) el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  function highlight(text, hit) {
    const safe = escHtml(text);
    if (!hit) return safe;
    const h = escHtml(hit);
    return safe.split(h).join(`<mark>${h}</mark>`);
  }

  function openSheet(i) {
    const r = results[i];
    if (!r) return;
    const role = $('#sheetRole');
    role.textContent = r.role === '관련' ? '관련 번호' : r.role;
    role.className = 'role-pill role-' + r.role;
    $('#sheetTitle').textContent = `${r.student} 학생 ${r.role === '관련' ? '관련 연락처' : r.role}`;
    $('#sheetName').textContent = `${r.name ? '저장된 이름: ' + r.name : '연락처에 저장되지 않은 번호'} · 신뢰도 ${confLabel(r.score)} (${r.score}%)`;
    const ph = fmtPhone(r.phone);
    $('#sheetPhone').textContent = ph;
    $('#sheetPhone').href = 'tel:' + r.phone;
    $('#actCall').href = 'tel:' + r.phone;
    $('#actSms').href = 'sms:' + r.phone;
    $('#actCopy').onclick = () => {
      const done = () => toast(`${ph} 복사했어요`);
      if (navigator.clipboard) navigator.clipboard.writeText(ph).then(done, () => toast(ph));
      else toast(ph);
    };
    $('#sheetEvidence').innerHTML = r.evidence.slice(0, 15).map((e) => {
      const src = e.source === 'contact' ? '📇 전화번호부' : `💬 ${e.dir === 'out' ? '보낸' : '받은'} 문자${e.date ? ' · ' + new Date(e.date).toLocaleDateString('ko-KR') : ''}`;
      return `<li><span class="src">${src}</span>${highlight(e.text, e.hit)}</li>`;
    }).join('');
    $('#sheet').hidden = false;
  }

  /* ---------- 파일 읽기 ---------- */
  async function readFileText(file) {
    const buf = await file.arrayBuffer();
    let text = new TextDecoder('utf-8').decode(buf);
    if (text.includes('�')) { // 한국어 윈도우(EUC-KR/CP949) 파일 대응
      try { text = new TextDecoder('euc-kr').decode(buf); } catch (e) { /* noop */ }
    }
    return text;
  }
  async function importFiles(files) {
    let c = 0, m = 0;
    for (const file of files) {
      try {
        const text = await readFileText(file);
        const name = file.name.toLowerCase();
        if (/BEGIN:VCARD/i.test(text)) c += parseVCF(text);
        else if (name.endsWith('.xml') || /<smses|<sms /.test(text)) { const r = parseSmsXML(text); m += r.msgs; c += r.contacts; }
        else if (name.endsWith('.csv')) c += parseCSV(text);
        else m += parsePlainMessages(text);
      } catch (e) {
        toast(`${file.name}: ${e.message || '읽지 못했어요'}`);
      }
    }
    dataChanged();
    toast(`연락처 ${c}개 · 문자 ${m}개 추가됨`);
    if ($('#q').value.trim()) doSearch();
  }

  function bindUI() {
    $('#searchForm').addEventListener('submit', (e) => { e.preventDefault(); $('#q').blur(); doSearch(); });
    let deb = 0;
    $('#q').addEventListener('input', () => { clearTimeout(deb); deb = setTimeout(doSearch, 250); });

    $('#openData').onclick = () => { $('#dataPanel').hidden = false; };
    document.querySelectorAll('[data-close]').forEach((b) => { b.onclick = () => { $('#' + b.dataset.close).hidden = true; }; });
    ['#sheet', '#dataPanel'].forEach((id) => $(id).addEventListener('click', (e) => { if (e.target === e.currentTarget) e.currentTarget.hidden = true; }));
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { $('#sheet').hidden = true; $('#dataPanel').hidden = true; }
      if (document.activeElement === $('#q')) return;
      if (e.key === 'ArrowRight') focusResult(current + 1);
      if (e.key === 'ArrowLeft') focusResult(current - 1);
      if (e.key === 'Enter' && results.length && $('#sheet').hidden && $('#dataPanel').hidden) openSheet(current);
    });

    $('#results').addEventListener('click', (e) => {
      if (e.target.closest('[data-call]')) return; // 전화 링크는 그대로 동작
      const row = e.target.closest('.row-item');
      if (!row) return;
      const i = +row.dataset.i;
      if (i === current) openSheet(i); else focusResult(i);
    });
    $('#prev').onclick = () => focusResult(current - 1);
    $('#next').onclick = () => focusResult(current + 1);

    // 연락처 선택 API (안드로이드 크롬 등)
    const hasPicker = 'contacts' in navigator && 'ContactsManager' in window;
    if (!hasPicker) {
      $('#pickContacts').disabled = true;
      $('#pickContacts').style.opacity = 0.45;
      $('#pickNote').innerHTML = '이 브라우저는 연락처 직접 가져오기를 지원하지 않아요 (안드로이드 크롬 + HTTPS 필요). 대신 연락처 앱에서 <b>내보내기(.vcf)</b> 한 파일을 불러오세요.';
    }
    $('#pickContacts').onclick = async () => {
      try {
        const picked = await navigator.contacts.select(['name', 'tel'], { multiple: true });
        let n = 0;
        for (const p of picked) if (addContact((p.name || [])[0] || '', p.tel || [])) n++;
        dataChanged();
        toast(`연락처 ${n}개를 가져왔어요`);
        if ($('#q').value.trim()) doSearch();
      } catch (e) { toast('연락처를 가져오지 못했어요'); }
    };

    $('#fileContacts').onchange = (e) => { importFiles([...e.target.files]); e.target.value = ''; };
    $('#fileMessages').onchange = (e) => { importFiles([...e.target.files]); e.target.value = ''; };
    $('#pasteAdd').onclick = () => {
      const text = $('#pasteBox').value;
      const looksContacts = /BEGIN:VCARD/i.test(text);
      const n = looksContacts ? parseVCF(text) : parsePlainMessages(text);
      if (!n) { toast('전화번호가 포함된 문자를 찾지 못했어요'); return; }
      $('#pasteBox').value = '';
      dataChanged();
      toast(looksContacts ? `연락처 ${n}개 추가됨` : `문자 ${n}개 추가됨`);
      if ($('#q').value.trim()) doSearch();
    };
    $('#persist').onchange = (e) => { safeSet(PERSIST_KEY, e.target.checked ? '1' : '0'); save(); toast(e.target.checked ? '이 기기에 저장합니다' : '저장된 데이터를 지웠어요'); };
    $('#loadSample').onclick = () => { $('#dataPanel').hidden = true; loadSample(); };
    $('#clearData').onclick = () => {
      if (!confirm('불러온 연락처와 문자를 모두 지울까요?')) return;
      resetData(); safeDel(STORE_KEY); results = []; renderList($('#q').value.trim()); Scene.showResults([]); updatePager(); dataChanged();
      toast('모두 지웠어요');
    };
  }

  /* ------------------------------------------------------------------ *
   * 3D 장면 (three.js)
   * ------------------------------------------------------------------ */
  const ROLE_COLORS = {
    어머니: ['#ff7eb6', '#7a2a58'], 아버지: ['#5ec8ff', '#1d4a7a'], 학부모: ['#b18cff', '#45307a'],
    보호자: ['#b18cff', '#45307a'], 할머니: ['#ffc46b', '#7a5420'], 할아버지: ['#ffc46b', '#7a5420'], 관련: ['#a3adc9', '#323b58'],
  };
  const FONT = '"Noto Sans KR", "Apple SD Gothic Neo", "Malgun Gothic", sans-serif';

  function roundRect(x, X, Y, w, h, r) {
    x.beginPath();
    x.moveTo(X + r, Y); x.arcTo(X + w, Y, X + w, Y + h, r); x.arcTo(X + w, Y + h, X, Y + h, r);
    x.arcTo(X, Y + h, X, Y, r); x.arcTo(X, Y, X + w, Y, r); x.closePath();
  }
  function fitText(x, text, maxW, size, weight) {
    let s = size;
    do { x.font = `${weight} ${s}px ${FONT}`; s -= 2; } while (x.measureText(text).width > maxW && s > 12);
  }

  const Scene = (() => {
    const api = { setContacts() {}, showResults() {}, focus() {} };
    if (!window.THREE) return api;
    const T = window.THREE;
    let renderer;
    try {
      renderer = new T.WebGLRenderer({ canvas: $('#scene'), antialias: true, alpha: true });
    } catch (e) { return api; }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    const scene = new T.Scene();
    scene.fog = new T.Fog(0x0b1020, 14, 34);
    const camera = new T.PerspectiveCamera(50, 1, 0.1, 100);
    camera.position.set(0, 0.6, 16);
    const maxAniso = renderer.capabilities.getMaxAnisotropy();

    // 별 입자
    const starGeo = new T.BufferGeometry();
    const N = 900, pos = new Float32Array(N * 3);
    for (let i = 0; i < N; i++) {
      const r = 18 + Math.random() * 30, th = Math.random() * Math.PI * 2, ph = Math.acos(2 * Math.random() - 1);
      pos[i * 3] = r * Math.sin(ph) * Math.cos(th); pos[i * 3 + 1] = r * Math.cos(ph) * 0.6; pos[i * 3 + 2] = r * Math.sin(ph) * Math.sin(th) - 10;
    }
    starGeo.setAttribute('position', new T.BufferAttribute(pos, 3));
    const stars = new T.Points(starGeo, new T.PointsMaterial({ color: 0x9fb4ff, size: 0.09, transparent: true, opacity: 0.8 }));
    scene.add(stars);

    // 바닥 링
    const floor = new T.Mesh(new T.RingGeometry(7.6, 7.75, 96), new T.MeshBasicMaterial({ color: 0x7c9cff, transparent: true, opacity: 0.25, side: T.DoubleSide }));
    floor.rotation.x = -Math.PI / 2; floor.position.y = -5.2;
    scene.add(floor);

    const ring = new T.Group();
    scene.add(ring);
    const resultGroup = new T.Group();
    scene.add(resultGroup);

    function tex(w, h, draw) {
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      draw(c.getContext('2d'), w, h);
      const t = new T.CanvasTexture(c);
      t.anisotropy = maxAniso;
      if ('colorSpace' in t) t.colorSpace = T.SRGBColorSpace; else t.encoding = T.sRGBEncoding;
      return t;
    }
    function disposeGroup(g) {
      for (const m of [...g.children]) { g.remove(m); m.geometry.dispose(); m.material.map && m.material.map.dispose(); m.material.dispose(); }
    }

    const ringGeo = new T.PlaneGeometry(1.6, 1);
    function ringCardTexture(name, phone) {
      return tex(256, 160, (x, w, h) => {
        const g = x.createLinearGradient(0, 0, w, h);
        g.addColorStop(0, 'rgba(60,80,160,0.95)'); g.addColorStop(1, 'rgba(25,32,70,0.95)');
        roundRect(x, 4, 4, w - 8, h - 8, 18); x.fillStyle = g; x.fill();
        x.strokeStyle = 'rgba(160,185,255,0.6)'; x.lineWidth = 3; x.stroke();
        x.fillStyle = '#eef2ff'; fitText(x, name, w - 36, 30, 700); x.fillText(name, 18, 64);
        x.fillStyle = '#9fb0e0'; x.font = `400 22px ${FONT}`; x.fillText(phone, 18, 112);
      });
    }

    let ringCards = [];
    api.setContacts = (contacts) => {
      disposeGroup(ring);
      const list = contacts.length
        ? contacts.slice(0, 140).map((c, i) => ({ name: c.name, phone: c.phones[0] ? fmtPhone(c.phones[0]).replace(/-(\d{3,4})-/, '-••••-') : '', idx: i }))
        : Array.from({ length: 36 }, (_, i) => ({ name: i % 3 ? '연락처' : '학부모', phone: '010-••••-••••', idx: -1 }));
      const n = list.length, turns = Math.max(1.2, n / 34);
      ringCards = list.map((c, i) => {
        const m = new T.Mesh(ringGeo, new T.MeshBasicMaterial({ map: ringCardTexture(c.name, c.phone), transparent: true, opacity: 0.9, depthWrite: false }));
        const a = (i / n) * Math.PI * 2 * turns;
        const y = n > 1 ? -4.2 + (i / (n - 1)) * 8.4 : 0;
        const r = 7.6;
        m.position.set(Math.sin(a) * r, y, Math.cos(a) * r);
        m.rotation.y = a; // 바깥쪽을 향함
        m.userData = { base: m.position.clone(), contact: c, baseOpacity: 0.9, targetOpacity: 0.9, targetScale: 1 };
        ring.add(m);
        return m;
      });
      api.showResults(lastResults, true);
    };

    const resultGeo = new T.PlaneGeometry(4.2, 2.62);
    function resultTexture(r) {
      const [c1, c2] = ROLE_COLORS[r.role] || ROLE_COLORS.관련;
      return tex(1024, 640, (x, w, h) => {
        const g = x.createLinearGradient(0, 0, w, h);
        g.addColorStop(0, c2); g.addColorStop(1, '#0f1430');
        roundRect(x, 8, 8, w - 16, h - 16, 48); x.fillStyle = g; x.fill();
        x.lineWidth = 6; x.strokeStyle = c1; x.stroke();
        // 빛 반사
        const gl = x.createLinearGradient(0, 0, 0, h * 0.5);
        gl.addColorStop(0, 'rgba(255,255,255,0.16)'); gl.addColorStop(1, 'rgba(255,255,255,0)');
        roundRect(x, 8, 8, w - 16, h * 0.5, 48); x.fillStyle = gl; x.fill();
        // 역할 배지
        const label = r.role === '관련' ? '관련 번호' : r.role;
        x.font = `700 40px ${FONT}`;
        const bw = x.measureText(label).width + 56;
        roundRect(x, 56, 52, bw, 70, 35); x.fillStyle = c1; x.fill();
        x.fillStyle = '#0b1020'; x.fillText(label, 84, 101);
        // 신뢰도
        x.font = `700 32px ${FONT}`; x.fillStyle = '#dfe6ff'; x.textAlign = 'right';
        x.fillText(`신뢰도 ${confLabel(r.score)}`, w - 60, 100); x.textAlign = 'left';
        // 학생
        x.fillStyle = '#ffffff'; fitText(x, `${r.student} 학생`, w - 120, 64, 900); x.fillText(`${r.student} 학생`, 60, 210);
        // 번호
        x.fillStyle = '#ffffff'; fitText(x, fmtPhone(r.phone), w - 120, 118, 900); x.fillText(fmtPhone(r.phone), 56, 362);
        // 이름 / 근거
        x.fillStyle = 'rgba(230,236,255,0.85)';
        const sub = `${r.name ? '📇 ' + r.name : '저장 안 된 번호'}${r.msgCount ? '   💬 문자 ' + r.msgCount + '건' : ''}`;
        fitText(x, sub, w - 120, 40, 400); x.fillText(sub, 60, 450);
        // 신뢰도 막대
        roundRect(x, 60, 500, w - 120, 18, 9); x.fillStyle = 'rgba(255,255,255,0.15)'; x.fill();
        roundRect(x, 60, 500, Math.max(18, (w - 120) * r.score / 100), 18, 9); x.fillStyle = c1; x.fill();
        x.fillStyle = 'rgba(230,236,255,0.7)'; x.font = `400 30px ${FONT}`;
        x.fillText('카드를 눌러 전화 · 문자', 60, 580);
      });
    }

    let resultCards = [];
    let lastResults = [];
    let focusIdx = 0;
    const isPortrait = () => window.innerWidth / window.innerHeight < 0.9;

    function layout() {
      const portrait = isPortrait();
      const zBase = portrait ? 5.2 : 4.4;
      const yBase = portrait ? 1.4 : 0.6;
      resultCards.forEach((m, i) => {
        const d = i - focusIdx, ad = Math.abs(d), s = Math.sign(d);
        const spread = portrait ? 2.6 : 4.4;
        m.userData.tPos = new T.Vector3(d === 0 ? 0 : s * (spread + (ad - 1) * 1.1), yBase - ad * 0.12, zBase - ad * 1.8);
        m.userData.tRotY = -s * Math.min(0.75, ad * 0.75);
        m.userData.tScale = d === 0 ? 1 : 0.82;
        m.userData.tOpacity = ad > 3 ? 0 : d === 0 ? 1 : 0.75;
        m.renderOrder = 100 - ad;
      });
    }

    api.showResults = (results, keepCards) => {
      lastResults = results;
      if (!keepCards) {
        disposeGroup(resultGroup);
        resultCards = results.map((r, i) => {
          const m = new T.Mesh(resultGeo, new T.MeshBasicMaterial({ map: resultTexture(r), transparent: true, opacity: 0, depthWrite: false }));
          // 해당 번호의 링 카드 위치에서 날아오기
          const src = ringCards.find((c) => c.userData.contact.idx >= 0 && state.contacts[c.userData.contact.idx].phones.includes(r.phone));
          if (src) { src.getWorldPosition(m.position); } else m.position.set((Math.random() - 0.5) * 14, (Math.random() - 0.5) * 8, -8);
          m.rotation.y = Math.PI * (i % 2 ? 1 : -1);
          m.scale.setScalar(0.3);
          m.userData.index = i;
          resultGroup.add(m);
          return m;
        });
        focusIdx = 0;
        layout();
      }
      const phones = new Set(results.map((r) => r.phone));
      for (const c of ringCards) {
        const ct = c.userData.contact;
        const hit = ct.idx >= 0 && state.contacts[ct.idx] && state.contacts[ct.idx].phones.some((p) => phones.has(p));
        c.userData.targetOpacity = results.length ? (hit ? 1 : 0.16) : c.userData.baseOpacity;
        c.userData.targetScale = hit ? 1.35 : 1;
      }
    };
    api.focus = (i) => { focusIdx = i; layout(); };

    // 크기
    function resize() {
      const w = window.innerWidth, h = window.innerHeight;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.fov = w / h < 0.7 ? 62 : 50;
      camera.position.z = w / h < 0.7 ? 17 : 16;
      camera.updateProjectionMatrix();
      layout();
    }
    window.addEventListener('resize', resize);
    resize();

    // 입력: 탭 / 스와이프 / 드래그로 회전
    const ray = new T.Raycaster();
    const ndc = new T.Vector2();
    const pointer = { x: 0, y: 0 };
    let down = null, spin = 0, dragVel = 0;
    const canvas = renderer.domElement;
    canvas.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY, t: performance.now(), lx: e.clientX }; });
    window.addEventListener('pointermove', (e) => {
      pointer.x = (e.clientX / window.innerWidth) * 2 - 1;
      pointer.y = (e.clientY / window.innerHeight) * 2 - 1;
      if (down && !resultCards.length) { dragVel = (e.clientX - down.lx) * 0.004; spin += dragVel; down.lx = e.clientX; }
    });
    window.addEventListener('pointerup', (e) => {
      if (!down) return;
      const dx = e.clientX - down.x, dy = e.clientY - down.y;
      const quick = performance.now() - down.t < 600;
      down = null;
      if (resultCards.length && Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy) && quick) {
        window.dispatchEvent(new CustomEvent('scene:swipe', { detail: dx < 0 ? 1 : -1 }));
        return;
      }
      if (Math.hypot(dx, dy) > 8 || e.target !== canvas) return;
      ndc.set((e.clientX / window.innerWidth) * 2 - 1, -(e.clientY / window.innerHeight) * 2 + 1);
      ray.setFromCamera(ndc, camera);
      const hit = ray.intersectObjects(resultCards.filter((m) => m.material.opacity > 0.3))[0];
      if (hit) window.dispatchEvent(new CustomEvent('scene:pick', { detail: hit.object.userData.index }));
    });

    const clock = new T.Clock();
    const lookTarget = new T.Vector3(0, 0, 0);
    function tick() {
      const dt = Math.min(clock.getDelta(), 0.05);
      const k = 1 - Math.pow(0.0015, dt); // 부드러운 보간 계수
      const t = clock.elapsedTime;

      spin += (resultCards.length ? 0.04 : 0.12) * dt;
      ring.rotation.y = spin;
      for (const c of ring.children) {
        const u = c.userData;
        c.material.opacity += (u.targetOpacity - c.material.opacity) * k;
        const s = c.scale.x + (u.targetScale - c.scale.x) * k;
        c.scale.setScalar(s);
      }
      for (const m of resultCards) {
        const u = m.userData;
        m.position.lerp(u.tPos, k);
        m.rotation.y += (u.tRotY - m.rotation.y) * k;
        const s = m.scale.x + (u.tScale - m.scale.x) * k;
        m.scale.setScalar(s);
        m.material.opacity += (u.tOpacity - m.material.opacity) * k;
        if (u.index === focusIdx) { m.position.y += Math.sin(t * 1.6) * 0.004; m.rotation.x = pointer.y * 0.08; m.rotation.y += pointer.x * 0.002; }
      }
      stars.rotation.y = t * 0.01;
      camera.position.x += (pointer.x * 0.9 - camera.position.x) * 0.04;
      camera.position.y += (0.6 - pointer.y * 0.5 - camera.position.y) * 0.04;
      camera.lookAt(lookTarget);
      renderer.render(scene, camera);
      requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
    return api;
  })();

  window.addEventListener('scene:swipe', (e) => focusResult(current + e.detail));
  window.addEventListener('scene:pick', (e) => {
    const i = e.detail;
    if (i === current) openSheet(i); else focusResult(i);
  });

  /* ------------------------------------------------------------------ *
   * 시작
   * ------------------------------------------------------------------ */
  bindUI();
  load();
  const start = () => dataChanged();
  // 한글 웹폰트가 준비된 뒤 3D 카드 글자를 그림
  if (document.fonts && document.fonts.ready) Promise.race([document.fonts.ready, new Promise((r) => setTimeout(r, 1500))]).then(start);
  else start();

  // 테스트용 노출
  window.__parentFinder = { search, parseVCF, parseCSV, parseSmsXML, parsePlainMessages, state, resetData, rebuildIndex };
})();
