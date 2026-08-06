// 노션 도감을 읽어 빌드 목록으로 만들고, 한글 검색으로 찾아준다.
//
// 도감은 데이터베이스 구조다: PVE 구분(DB) → 공성전 리스트(DB) → 빌드 행.
// 그래서 데이터베이스를 훑는 경로가 기본이고, 헤딩으로만 된 페이지를 대비해
// 마크다운 헤딩 파서를 예비 경로로 함께 둔다.
//
// 결과는 data/builds.json에 캐시해서 노션이 잠깐 막혀도 봇이 계속 답하게 한다.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { fetchCatalog, fetchDocument } = require('./notion');

const CACHE_PATH = path.join(__dirname, '..', 'data', 'builds.json');

/** 카테고리 판별에 쓰는 키워드 (묶음 이름·헤딩 경로에서 찾는다) */
const CATEGORY_KEYWORDS = {
  파괴신: ['파괴신', '파신'],
  공성전: ['공성전', '공성'],
};

const WEEKDAYS = ['월', '화', '수', '목', '금', '토', '일'];

/** 검색용 본문은 이 길이까지만 본다 (128MB 호스팅 메모리 보호) */
const SEARCH_BODY_LIMIT = 8000;

// ─────────────────────────────── 한글 검색 유틸

const CHOSUNG = [
  'ㄱ', 'ㄲ', 'ㄴ', 'ㄷ', 'ㄸ', 'ㄹ', 'ㅁ', 'ㅂ', 'ㅃ', 'ㅅ',
  'ㅆ', 'ㅇ', 'ㅈ', 'ㅉ', 'ㅊ', 'ㅋ', 'ㅌ', 'ㅍ', 'ㅎ',
];

/**
 * 비교용 정규화: 소문자 + 공백/구두점 제거.
 * 경로 구분자(›)가 자동완성 값에 섞여 오므로 그것까지 함께 걷어낸다.
 */
function norm(s) {
  return String(s ?? '')
    .toLowerCase()
    .replace(/[\s`*_~[\]()#>|/\\.,!?:;'"+\-›»→▸▶•·—–]/g, '');
}

/** "파이 세인" → "ㅍㅇ ㅅㅇ" (초성 검색용) */
function chosung(s) {
  let out = '';
  for (const ch of String(s ?? '')) {
    const code = ch.codePointAt(0);
    if (code >= 0xac00 && code <= 0xd7a3) {
      out += CHOSUNG[Math.floor((code - 0xac00) / 588)];
    } else {
      out += ch;
    }
  }
  return out;
}

/** 검색어가 초성만으로 이뤄졌는지 (ㅍㅅ 같은 입력) */
function isChosungOnly(s) {
  return /^[ㄱ-ㅎ]+$/.test(s);
}

/** 글자가 순서대로만 나오면 매치 — "파이세인4턴"으로 "파이 세인 빌드 확정 4턴"을 찾게 해준다 */
const SUBSEQ_MIN = 4;
function isSubsequence(needle, hay) {
  let i = 0;
  for (let j = 0; j < hay.length && i < needle.length; j += 1) {
    if (hay[j] === needle[i]) i += 1;
  }
  return i === needle.length;
}

/** 자동완성 값으로 쓸 짧고 안정적인 키 (FNV-1a) */
function shortHash(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

// ─────────────────────────────── 마크다운 다듬기

/** 마크다운 이미지. 캡션에 대괄호·링크가 들어가도 마지막 ]( 를 기준으로 잡는다. */
const IMAGE_RE = /[ \t]*!\[(.*)\]\((https?:\/\/[^)\s]+)\)[ \t]*/;

function firstImage(text) {
  const m = String(text).match(IMAGE_RE);
  return m ? m[2] : null;
}

/** 본문에서 이미지 마크다운을 걷어낸다 (만료되는 서명 URL을 임베드 본문에 남기지 않는다) */
function stripImages(text) {
  return String(text)
    .replace(new RegExp(IMAGE_RE.source, 'g'), '')
    .replace(/^[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n');
}

// ─────────────────────────────── 분류

/**
 * 이름이 카테고리 그 자체인지 판단한다.
 * "공성전", "공성전 도감", "🏰 공성전"은 참 — 라벨에서 빼도 정보가 안 사라진다.
 * "강림 - 파괴신", "공성전 1주차"는 거짓 — 빼면 다른 묶음과 구분이 안 된다.
 */
function isPureCategoryLabel(text, keywords) {
  let rest = norm(text);
  for (const k of keywords) rest = rest.split(norm(k)).join('');
  rest = rest.replace(/도감|빌드|모음|목록|정리|공략|리스트|구분/g, '');
  return !/[\p{L}\p{N}]/u.test(rest);
}

/**
 * 경로에서 카테고리를 고른다. **얕은(상위) 쪽이 우선**이다.
 * 빌드 이름에 다른 모드 이름이 들어가도(공성전 묶음의 "파괴신 카운터 조합")
 * 상위가 정한 카테고리가 뒤집히지 않게 한다.
 * @returns {{category: string, index: number}|null}
 */
function detectCategory(parts) {
  for (let i = 0; i < parts.length; i += 1) {
    for (const [category, keywords] of Object.entries(CATEGORY_KEYWORDS)) {
      if (keywords.some((k) => String(parts[i]).includes(k))) return { category, index: i };
    }
  }
  return null;
}

/**
 * 경로에서 요일을 모두 찾는다.
 * "수요일", "월·목요일", "월, 목요일", "월~수요일", "월요일 - 루디 / 쥬리", 단독 "수"를 인식한다.
 */
function detectWeekdays(parts) {
  for (let i = parts.length - 1; i >= 0; i -= 1) {
    const part = String(parts[i]);

    // "월요일 - 루디 / 쥬리, 나타 딜러"처럼 뒤에 조합 이름이 붙어도 요일 부분만 본다.
    // (뒤까지 훑으면 캐릭터 이름 속 '일'·'수' 같은 글자를 요일로 잘못 읽는다)
    const last = part.lastIndexOf('요일');
    let cleaned;
    if (last >= 0) cleaned = part.slice(0, last).replace(/요일/g, '');
    else if (/^\s*[월화수목금토일]\s*$/.test(part)) cleaned = part.trim();
    else continue;

    const range = cleaned.match(/([월화수목금토일])\s*[~\-–—]\s*([월화수목금토일])/);
    if (range) {
      const from = WEEKDAYS.indexOf(range[1]);
      const to = WEEKDAYS.indexOf(range[2]);
      if (from >= 0 && to >= 0) {
        const out = [];
        for (let k = from; ; k = (k + 1) % WEEKDAYS.length) {
          out.push(WEEKDAYS[k]);
          if (k === to || out.length >= WEEKDAYS.length) break;
        }
        return out;
      }
    }

    const found = cleaned.match(/[월화수목금토일]/g);
    if (found) return [...new Set(found)];
  }
  return [];
}

/** 카테고리 이름만 걷어낸 표시·검색용 문자열 (빌드 이름은 항상 남긴다) */
function labelFrom(parts, found) {
  const dropIndex =
    found &&
    found.index !== parts.length - 1 &&
    isPureCategoryLabel(parts[found.index], CATEGORY_KEYWORDS[found.category])
      ? found.index
      : -1;
  return parts.filter((_, idx) => idx !== dropIndex).join(' › ');
}

/**
 * 한 카테고리의 빌드가 전부 같은 묶음에 있으면 라벨에서 묶음 이름을 뗀다.
 * (파괴신 빌드가 전부 "강림 - 파괴신" 안에 있으면 자동완성마다 그 접두사를 보일 이유가 없다)
 */
function simplifyLabels(list) {
  const groupsPerCategory = new Map();
  for (const b of list) {
    if (!b.category) continue;
    if (!groupsPerCategory.has(b.category)) groupsPerCategory.set(b.category, new Set());
    groupsPerCategory.get(b.category).add(b.group);
  }
  for (const b of list) {
    if (!b.category) continue;
    if (groupsPerCategory.get(b.category).size === 1) b.label = b.name;
  }
}

/** 자동완성 값으로 쓸 짧고 유일한 키를 붙인다 */
function assignIds(list) {
  const used = new Set();
  for (const b of list) {
    let bump = 0;
    let id = '#' + shortHash(String(b.category) + ' ' + b.label);
    while (used.has(id)) {
      bump += 1;
      id = '#' + shortHash(String(b.category) + ' ' + b.label + ' ' + bump);
    }
    used.add(id);
    b.id = id;
  }
}

// ─────────────────────────────── 데이터베이스 경로 (기본)

/**
 * 노션 데이터베이스에서 읽어온 목록 → 빌드 목록.
 * 도감이 "PVE 구분 → 공성전 리스트 → 빌드"처럼 데이터베이스로 되어 있을 때 쓴다.
 */
function buildsFromCatalog(catalog) {
  const out = [];

  for (const raw of (catalog && catalog.builds) || []) {
    const markdown = String(raw.markdown || '');
    const body = stripImages(markdown).trim();
    if (!body) continue;

    const groupPath = Array.isArray(raw.groupPath) ? raw.groupPath : [];
    const parts = [...groupPath, raw.name];
    const found = detectCategory(parts);

    out.push({
      name: raw.name,
      label: labelFrom(parts, found),
      path: groupPath,
      group: groupPath.join(' › '),
      category: found ? found.category : null,
      weekdays: detectWeekdays(parts),
      image: firstImage(markdown),
      body,
      url: raw.url || (catalog && catalog.pageUrl) || null,
    });
  }

  simplifyLabels(out);
  assignIds(out);
  return out.map(prepare);
}

// ─────────────────────────────── 헤딩 경로 (예비)

/**
 * 헤딩 기준으로 마크다운을 섹션으로 쪼갠다. 각 섹션은 **자기 줄만** 갖는다.
 * (상위에 자식 본문을 복사하면 목차 헤딩이 빌드로 잡히고 메모리도 몇 배로 든다)
 */
function parseSections(markdown) {
  const lines = String(markdown ?? '').split('\n');
  const sections = [];
  const stack = [];
  let inCodeFence = false;

  for (const line of lines) {
    if (/^\s*```/.test(line)) inCodeFence = !inCodeFence;

    const m = inCodeFence ? null : line.match(/^(#{1,6})\s+(.+?)\s*$/);
    // 표 행(| 조합 | 턴수)이 헤딩으로 오인되면 문서 구조가 통째로 무너진다.
    const isHeading = m && !m[2].startsWith('|') && !m[2].includes(' | ');

    if (isHeading) {
      const level = m[1].length;
      const name = m[2].trim();
      while (stack.length > 0 && stack[stack.length - 1].level >= level) stack.pop();
      const parent = stack.length > 0 ? stack[stack.length - 1].index : -1;

      const trail = [];
      for (let p = parent; p >= 0; p = sections[p].parent) trail.unshift(sections[p].name);

      stack.push({ level, index: sections.length });
      sections.push({ level, name, path: trail, parent, ownLines: [] });
      continue;
    }

    if (stack.length > 0) sections[stack[stack.length - 1].index].ownLines.push(line);
  }

  return sections;
}

/** 헤딩 섹션 목록 → 빌드 목록 */
function buildsFromMarkdown(markdown, { pageUrl } = {}) {
  const sections = parseSections(markdown);
  const n = sections.length;

  for (let i = 0; i < n; i += 1) {
    sections[i].hasChildHeading = i + 1 < n && sections[i + 1].level > sections[i].level;
    sections[i].ownBody = sections[i].ownLines.join('\n').trim();
    sections[i].ownLines = null;
  }

  const isBuild = new Array(n).fill(false);
  const out = [];

  for (let i = 0; i < n; i += 1) {
    const s = sections[i];
    if (!s.ownBody) continue; // 내용 없는 헤딩은 목차·묶음 역할

    const parts = [...s.path, s.name];
    const found = detectCategory(parts);
    if (!found) continue;

    // 카테고리를 자기 이름으로 정했는데 하위 헤딩까지 있으면 카테고리 묶음이다
    if (found.index === parts.length - 1 && s.hasChildHeading) continue;
    // 부모가 이미 빌드면 이 섹션은 그 빌드의 세부 항목이다 (1턴, 장비 등)
    if (s.parent >= 0 && isBuild[s.parent]) continue;

    isBuild[i] = true;

    const bodyParts = [s.ownBody];
    for (let j = i + 1; j < n && sections[j].level > s.level; j += 1) {
      if (sections[j].ownBody) {
        bodyParts.push('**' + sections[j].name + '**\n' + sections[j].ownBody);
      }
    }
    const raw = bodyParts.join('\n\n');

    out.push({
      name: s.name,
      label: labelFrom(parts, found),
      path: s.path,
      group: s.path.join(' › '),
      category: found.category,
      weekdays: detectWeekdays(parts),
      image: firstImage(raw),
      body: stripImages(raw).trim(),
      url: pageUrl || null,
    });
  }

  simplifyLabels(out);
  assignIds(out);
  return out.map(prepare);
}

/** 검색용 정규화 필드를 미리 계산해 둔다 (_ 로 시작하는 필드는 캐시에 저장하지 않는다) */
function prepare(build) {
  const label = build.label || build.name || '';
  return {
    ...build,
    _name: norm(build.name),
    _full: norm(label),
    _nameCho: norm(chosung(build.name)),
    _fullCho: norm(chosung(label)),
    // 정규화 전에 잘라서 원본 문자열 전체가 메모리에 붙들리지 않게 한다
    _body: norm(String(build.body || '').slice(0, SEARCH_BODY_LIMIT)),
  };
}

// ─────────────────────────────── 검색

/** 빌드 하나에 점수를 매긴다. 0이면 후보에서 제외. */
function score(build, query) {
  const q = norm(query);
  if (!q) return 1; // 검색어가 없으면 전부 통과 (목록 표시용)

  const tokens = String(query).trim().split(/\s+/).map(norm).filter(Boolean);
  let total = 0;

  for (const token of tokens) {
    const cho = isChosungOnly(token);
    let hit = 0;
    if (build._name.includes(token)) hit = 60;
    else if (cho && build._nameCho.includes(token)) hit = 45;
    else if (build._full.includes(token)) hit = 30;
    else if (cho && build._fullCho.includes(token)) hit = 22;
    else if (build._body.includes(token)) hit = 10;
    // 띄어쓰기를 통째로 붙여 쳤을 때 (파이세인4턴)
    else if (token.length >= SUBSEQ_MIN && isSubsequence(token, build._name)) hit = 25;
    else if (token.length >= SUBSEQ_MIN && isSubsequence(token, build._full)) hit = 14;

    if (hit === 0) return 0; // 토큰이 하나라도 어디에도 없으면 제외
    total += hit;
  }

  if (build._name === q) total += 1000;
  else if (build._name.startsWith(q)) total += 300;
  else if (build._name.includes(q)) total += 180;
  else if (build._full.includes(q)) total += 60;

  return total;
}

// ─────────────────────────────── 색인 상태 + 동기화

const index = {
  builds: [],
  title: null,
  pageUrl: null,
  syncedAt: null,
  source: null, // 'notion' | 'cache'
  error: null,
};

function readCache() {
  try {
    const raw = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
    if (!raw || !Array.isArray(raw.builds)) return null;
    // 예전 형식이나 손상된 항목이 섞여 있어도 시작을 막지 않게 걸러낸다
    const builds = raw.builds.filter(
      (b) => b && typeof b === 'object' && typeof b.name === 'string' && Array.isArray(b.path),
    );
    if (builds.length === 0) return null;
    return { ...raw, builds };
  } catch {
    return null;
  }
}

/** @returns {boolean} 저장 성공 여부 */
function writeCache(payload) {
  const tmp = CACHE_PATH + '.tmp';
  try {
    fs.mkdirSync(path.dirname(CACHE_PATH), { recursive: true });
    // 검색용 파생 필드(_로 시작)는 저장하지 않는다 — 불러올 때 다시 만든다
    const slim = payload.builds.map((b) => {
      const copy = {};
      for (const [k, v] of Object.entries(b)) if (!k.startsWith('_')) copy[k] = v;
      return copy;
    });
    // 쓰는 도중에 프로세스가 죽어도 기존 캐시가 남도록 임시 파일 → 이름 바꾸기
    fs.writeFileSync(tmp, JSON.stringify({ ...payload, builds: slim }), 'utf8');
    fs.renameSync(tmp, CACHE_PATH);
    return true;
  } catch (e) {
    console.warn(`[빌드] 캐시 저장 실패: ${e.message}`);
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* 지우기 실패는 무시 */
    }
    return false;
  }
}

/** 캐시 파일을 색인에 올린다 (노션 동기화 전에도 답할 수 있게) */
function loadCache() {
  const cached = readCache();
  if (!cached) return false;
  index.builds = cached.builds.map((b) => prepare({ weekdays: [], category: null, ...b }));
  index.title = cached.title || null;
  index.pageUrl = cached.pageUrl || null;
  index.syncedAt = cached.syncedAt || null;
  index.source = 'cache';
  return true;
}

let inFlight = null;

async function doSync() {
  const pageId = process.env.NOTION_PAGE_ID;
  if (!pageId) throw new Error('NOTION_PAGE_ID가 설정되지 않았어요.');

  // 기본: 데이터베이스 구조. 없으면 헤딩 구조로 넘어간다.
  const catalog = await fetchCatalog(pageId);
  let builds = catalog ? buildsFromCatalog(catalog) : [];
  let meta = catalog;

  if (builds.length === 0) {
    const doc = await fetchDocument(pageId);
    builds = buildsFromMarkdown(doc.markdown, { pageUrl: doc.pageUrl });
    meta = doc;
  }

  if (builds.length === 0) {
    throw new Error(
      '도감에서 빌드를 하나도 찾지 못했어요. 노션 페이지에 봇 연결이 추가돼 있는지 확인해주세요.',
    );
  }

  index.builds = builds;
  index.title = meta.title;
  index.pageUrl = meta.pageUrl;
  index.syncedAt = new Date().toISOString();
  index.source = 'notion';
  index.error = null;

  const cached = writeCache({
    title: index.title,
    pageUrl: index.pageUrl,
    syncedAt: index.syncedAt,
    pageCount: meta.pageCount,
    builds,
  });

  return { count: builds.length, pageCount: meta.pageCount, title: meta.title, cached };
}

/**
 * 노션에서 도감을 다시 읽어 색인을 갱신한다.
 * 이미 돌고 있으면 같은 작업을 공유한다 (/빌드갱신 연타 + 주기 동기화가 겹치는 것 방지).
 */
function sync() {
  if (inFlight) return inFlight;
  inFlight = doSync()
    .catch((e) => {
      index.error = e instanceof Error ? e.message : String(e);
      throw e;
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

/** 시작 시 호출 — 캐시를 먼저 올리고, 노션 동기화를 시도한다. */
async function init() {
  let hadCache = false;
  try {
    hadCache = loadCache();
  } catch (e) {
    console.warn(`[빌드] 캐시를 불러오지 못했어요: ${e.message}`);
  }

  if (!process.env.NOTION_TOKEN || !process.env.NOTION_PAGE_ID) {
    index.error = '노션 설정(NOTION_TOKEN·NOTION_PAGE_ID)이 없어요. 봇 환경변수를 확인해주세요.';
    console.warn(
      hadCache
        ? `[빌드] 노션 설정이 없어 캐시(${index.builds.length}개)만 사용합니다.`
        : '[빌드] 노션 설정이 없고 캐시도 없어요. 빌드 검색은 비어 있습니다.',
    );
    return;
  }

  try {
    const r = await sync();
    console.log(`[빌드] 노션 동기화 완료 — 빌드 ${r.count}개`);
  } catch (e) {
    console.warn(`[빌드] 노션 동기화 실패: ${e.message}`);
    if (hadCache) console.warn(`[빌드] 캐시 ${index.builds.length}개로 계속 동작합니다.`);
  }
}

/** 자동완성 값(#해시)으로 정확히 하나를 집어온다. */
function findById(category, id) {
  if (!id || typeof id !== 'string' || !id.startsWith('#')) return null;
  return index.builds.find((b) => b.id === id && b.category === category) || null;
}

/**
 * 카테고리 안에서 검색어에 맞는 빌드를 점수순으로 돌려준다.
 * 요일을 지정하면 그 요일 빌드 + 요일이 안 적힌 빌드를 보여준다
 * (도감이 요일로 안 묶여 있을 때 결과가 통째로 0이 되는 걸 막는다).
 */
function search(category, query, { weekday, limit = 25 } = {}) {
  const candidates = index.builds.filter((b) => {
    if (b.category !== category) return false;
    if (!weekday) return true;
    const list = Array.isArray(b.weekdays) ? b.weekdays : [];
    return list.length === 0 || list.includes(weekday);
  });

  return candidates
    .map((b) => ({ build: b, s: score(b, query) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || a.build.label.localeCompare(b.build.label, 'ko'))
    .slice(0, limit)
    .map((x) => x.build);
}

function status() {
  const groups = {};
  for (const b of index.builds) {
    const key = b.group || '(묶음 없음)';
    groups[key] = (groups[key] || 0) + 1;
  }
  return {
    count: index.builds.length,
    byCategory: {
      공성전: index.builds.filter((b) => b.category === '공성전').length,
      파괴신: index.builds.filter((b) => b.category === '파괴신').length,
    },
    groups,
    title: index.title,
    pageUrl: index.pageUrl,
    syncedAt: index.syncedAt,
    source: index.source,
    error: index.error,
  };
}

module.exports = {
  init,
  sync,
  search,
  findById,
  status,
  // 테스트용 노출
  buildsFromCatalog,
  buildsFromMarkdown,
  parseSections,
  detectWeekdays,
  score,
  norm,
  chosung,
};
