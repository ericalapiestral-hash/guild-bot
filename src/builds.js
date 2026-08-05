// 노션 도감 마크다운 → 빌드 목록으로 쪼개고, 한글 검색으로 찾아준다.
// 결과는 data/builds.json에 캐시해서 노션이 막히거나 토큰이 없어도 봇이 계속 답하게 한다.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { fetchDocument } = require('./notion');

const CACHE_PATH = path.join(__dirname, '..', 'data', 'builds.json');

/** 카테고리 판별에 쓰는 키워드 (헤딩 경로에서 찾는다) */
const CATEGORY_KEYWORDS = {
  파괴신: ['파괴신', '파신'],
  공성전: ['공성전', '공성'],
};

const WEEKDAYS = ['월', '화', '수', '목', '금', '토', '일'];

// ─────────────────────────────── 한글 검색 유틸

const CHOSUNG = [
  'ㄱ', 'ㄲ', 'ㄴ', 'ㄷ', 'ㄸ', 'ㄹ', 'ㅁ', 'ㅂ', 'ㅃ', 'ㅅ',
  'ㅆ', 'ㅇ', 'ㅈ', 'ㅉ', 'ㅊ', 'ㅋ', 'ㅌ', 'ㅍ', 'ㅎ',
];

/**
 * 비교용 정규화: 소문자 + 공백/구두점 제거.
 * 자동완성이 돌려주는 값에는 경로 구분자(›)가 섞여 오므로 그것까지 함께 걷어낸다.
 */
function norm(s) {
  return String(s ?? '')
    .toLowerCase()
    .replace(/[\s`*_~[\]()#>|/\\.,!?:;'"+\-›»→▸▶•·—–~]/g, '');
}

/** "파이 세인" → "ㅍㅇㅅㅇ" (초성 검색용) */
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

// ─────────────────────────────── 마크다운 → 빌드 목록

/** 마크다운 이미지 첫 번째 URL */
function firstImage(text) {
  const m = String(text).match(/!\[[^\]]*\]\((https?:\/\/[^)\s]+)\)/);
  return m ? m[1] : null;
}

/** 본문에서 이미지 마크다운을 걷어낸다 (임베드 설명에는 링크만 남긴다) */
function stripImages(text) {
  return String(text).replace(/!\[[^\]]*\]\((https?:\/\/[^)\s]+)\)/g, '').replace(/\n{3,}/g, '\n\n');
}

/** 헤딩 경로에서 카테고리를 고른다. 더 깊은(가까운) 헤딩이 우선. */
function detectCategory(pathParts) {
  for (let i = pathParts.length - 1; i >= 0; i -= 1) {
    const part = pathParts[i];
    for (const [category, keywords] of Object.entries(CATEGORY_KEYWORDS)) {
      if (keywords.some((k) => part.includes(k))) return category;
    }
  }
  return null;
}

/** 헤딩 경로에서 요일을 찾는다 ("수요일", "수" 둘 다 인식) */
function detectWeekday(pathParts) {
  for (let i = pathParts.length - 1; i >= 0; i -= 1) {
    const part = pathParts[i];
    const full = part.match(/([월화수목금토일])\s*요일/);
    if (full) return full[1];
  }
  for (let i = pathParts.length - 1; i >= 0; i -= 1) {
    const part = pathParts[i].trim();
    if (WEEKDAYS.includes(part)) return part;
  }
  return null;
}

/**
 * 헤딩 기준으로 마크다운을 섹션(빌드 후보)으로 쪼갠다.
 * 도감이 "한 페이지 헤딩" 구조든 "빌드마다 하위 페이지" 구조든 동일하게 동작한다.
 */
function parseSections(markdown) {
  const lines = String(markdown ?? '').split('\n');
  const sections = [];
  const stack = []; // { level, title, index }
  let preamble = [];
  let inCodeFence = false;

  const push = (level, title) => {
    while (stack.length > 0 && stack[stack.length - 1].level >= level) stack.pop();
    const parents = stack.map((s) => s.title);
    const section = {
      level,
      name: title,
      path: parents,
      bodyLines: [],
      hasChildHeading: false,
    };
    for (const ancestor of stack) sections[ancestor.index].hasChildHeading = true;
    stack.push({ level, title, index: sections.length });
    sections.push(section);
  };

  for (const line of lines) {
    if (/^\s*```/.test(line)) inCodeFence = !inCodeFence;

    const heading = inCodeFence ? null : line.match(/^(#{1,6})\s+(.+?)\s*$/);
    if (heading) {
      push(heading[1].length, heading[2].trim());
      continue;
    }
    if (stack.length === 0) {
      preamble.push(line);
    } else {
      // 현재 열려 있는 모든 조상 섹션에 본문을 함께 쌓는다 (부모를 검색해도 내용이 보이게)
      for (const s of stack) sections[s.index].bodyLines.push(line);
    }
  }

  return { sections, preamble: preamble.join('\n').trim() };
}

/** 섹션 목록 → 검색 가능한 빌드 목록 */
function buildsFromMarkdown(markdown, { pageUrl } = {}) {
  const { sections } = parseSections(markdown);
  const builds = [];

  for (const section of sections) {
    const body = section.bodyLines.join('\n').trim();
    const category = detectCategory([...section.path, section.name]);
    if (!category) continue; // 공성전/파괴신 어디에도 안 걸리는 섹션은 제외
    // 카테고리 이름 자체인 최상위 섹션은 빌드가 아니다
    const isCategoryRoot =
      section.path.length === 0 &&
      CATEGORY_KEYWORDS[category].some((k) => norm(section.name) === norm(k));
    if (isCategoryRoot) continue;
    if (!body && section.hasChildHeading) continue; // 목차 역할만 하는 중간 헤딩

    const weekday = detectWeekday([...section.path, section.name]);
    const label = [...section.path.slice(1), section.name].filter(Boolean).join(' › ');

    builds.push({
      name: section.name,
      label: label || section.name,
      path: section.path,
      category,
      weekday,
      isLeaf: !section.hasChildHeading,
      image: firstImage(body),
      body: stripImages(body).trim(),
      url: pageUrl || null,
    });
  }

  return builds.map(prepare);
}

/** 검색용 정규화 필드를 미리 계산해 둔다 */
function prepare(build) {
  const nameText = build.name;
  const fullText = `${build.path.join(' ')} ${build.name}`;
  return {
    ...build,
    _name: norm(nameText),
    _full: norm(fullText),
    _nameCho: norm(chosung(nameText)),
    _fullCho: norm(chosung(fullText)),
    _body: norm(build.body).slice(0, 4000),
  };
}

// ─────────────────────────────── 검색

/**
 * 빌드 하나에 점수를 매긴다. 0이면 후보에서 제외.
 * 이름 > 경로 > 본문 순으로 가중치를 준다.
 */
function score(build, query) {
  const q = norm(query);
  if (!q) return 1; // 검색어가 없으면 전부 통과 (자동완성 초기 목록)

  const tokens = String(query).trim().split(/\s+/).map(norm).filter(Boolean);
  let total = 0;
  let matchedAll = true;

  for (const token of tokens) {
    const cho = isChosungOnly(token);
    let hit = 0;
    if (build._name.includes(token)) hit = 60;
    else if (cho && build._nameCho.includes(token)) hit = 45;
    else if (build._full.includes(token)) hit = 30;
    else if (cho && build._fullCho.includes(token)) hit = 22;
    else if (build._body.includes(token)) hit = 10;

    if (hit === 0) matchedAll = false;
    total += hit;
  }

  if (!matchedAll) return 0;

  if (build._name === q) total += 1000;
  else if (build._name.startsWith(q)) total += 300;
  else if (build._name.includes(q)) total += 180;
  else if (build._full.includes(q)) total += 60;

  if (build.isLeaf) total += 25;
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
    return raw;
  } catch {
    return null;
  }
}

function writeCache(payload) {
  try {
    fs.mkdirSync(path.dirname(CACHE_PATH), { recursive: true });
    // 검색용 파생 필드(_로 시작)는 저장하지 않는다 — 불러올 때 다시 만든다
    const slim = payload.builds.map(({ _name, _full, _nameCho, _fullCho, _body, ...rest }) => rest);
    fs.writeFileSync(
      CACHE_PATH,
      JSON.stringify({ ...payload, builds: slim }, null, 2),
      'utf8',
    );
  } catch (e) {
    console.warn(`[빌드] 캐시 저장 실패: ${e.message}`);
  }
}

/** 캐시 파일을 색인에 올린다 (노션 동기화 전 즉시 응답 가능하게) */
function loadCache() {
  const cached = readCache();
  if (!cached) return false;
  index.builds = cached.builds.map(prepare);
  index.title = cached.title || null;
  index.pageUrl = cached.pageUrl || null;
  index.syncedAt = cached.syncedAt || null;
  index.source = 'cache';
  return true;
}

/**
 * 노션에서 도감을 다시 읽어 색인을 갱신한다.
 * 실패해도 기존 색인은 그대로 두고 오류만 기록한다.
 */
async function sync() {
  const pageId = process.env.NOTION_PAGE_ID;
  if (!pageId) throw new Error('NOTION_PAGE_ID가 설정되지 않았어요.');

  const doc = await fetchDocument(pageId);
  const builds = buildsFromMarkdown(doc.markdown, { pageUrl: doc.pageUrl });

  if (builds.length === 0) {
    throw new Error(
      '도감에서 빌드를 하나도 찾지 못했어요. 헤딩(제목) 안에 "공성전"·"파괴신"이 들어있는지 확인해주세요.',
    );
  }

  index.builds = builds;
  index.title = doc.title;
  index.pageUrl = doc.pageUrl;
  index.syncedAt = new Date().toISOString();
  index.source = 'notion';
  index.error = null;

  writeCache({
    title: index.title,
    pageUrl: index.pageUrl,
    syncedAt: index.syncedAt,
    pageCount: doc.pageCount,
    builds,
  });

  return { count: builds.length, pageCount: doc.pageCount, title: doc.title };
}

/** 시작 시 호출 — 캐시를 먼저 올리고, 노션 동기화는 조용히 시도한다. */
async function init() {
  const hadCache = loadCache();
  if (!process.env.NOTION_TOKEN || !process.env.NOTION_PAGE_ID) {
    if (!hadCache) {
      console.warn('[빌드] 노션 설정(NOTION_TOKEN·NOTION_PAGE_ID)이 없고 캐시도 없어요. 빌드 검색은 비어 있습니다.');
    } else {
      console.log(`[빌드] 노션 설정이 없어 캐시(${index.builds.length}개)만 사용합니다.`);
    }
    return;
  }
  try {
    const r = await sync();
    console.log(`[빌드] 노션 동기화 완료 — 빌드 ${r.count}개 (페이지 ${r.pageCount}개)`);
  } catch (e) {
    index.error = e.message;
    console.warn(`[빌드] 노션 동기화 실패: ${e.message}`);
    if (hadCache) console.warn(`[빌드] 캐시 ${index.builds.length}개로 계속 동작합니다.`);
  }
}

/**
 * 카테고리 안에서 검색어에 맞는 빌드를 점수순으로 돌려준다.
 * @param {'공성전'|'파괴신'} category
 */
function search(category, query, { weekday, limit = 25 } = {}) {
  const candidates = index.builds.filter((b) => {
    if (b.category !== category) return false;
    if (weekday && b.weekday && b.weekday !== weekday) return false;
    if (weekday && !b.weekday) return false;
    return true;
  });

  return candidates
    .map((b) => ({ build: b, s: score(b, query) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || a.build.label.localeCompare(b.build.label, 'ko'))
    .slice(0, limit)
    .map((x) => x.build);
}

function status() {
  return {
    count: index.builds.length,
    byCategory: {
      공성전: index.builds.filter((b) => b.category === '공성전').length,
      파괴신: index.builds.filter((b) => b.category === '파괴신').length,
    },
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
  status,
  // 테스트용 노출
  buildsFromMarkdown,
  parseSections,
  score,
  norm,
  chosung,
};
