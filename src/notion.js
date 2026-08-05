// 노션 공식 API로 "PVE 빌드 도감" 페이지를 읽어 마크다운 한 덩어리로 만든다.
// 읽기 전용 — 노션 내용을 절대 수정하지 않는다.
//
// 블록 API(blocks/{id}/children)를 재귀로 훑는다. 하위 페이지는 만난 자리에 그대로 펼쳐 넣기
// 때문에 상위 헤딩(공성전/파괴신) 문맥이 유지된다. 그래서 도감이 "한 페이지 안 헤딩" 구조든
// "빌드마다 하위 페이지" 구조든 똑같이 처리된다.
'use strict';

/** blocks API는 이 버전에서 오래 안정적이었다. 필요하면 환경변수로 바꿀 수 있다. */
const NOTION_VERSION = (process.env.NOTION_VERSION || '2022-06-28').trim();
const API_BASE = 'https://api.notion.com/v1';

/** 노션 rate limit은 평균 초당 3회 — 요청 사이 간격을 둔다. */
const MIN_INTERVAL_MS = 350;

/** 폭주 방지 상한 */
const MAX_PAGES = 300;
const MAX_HEADING_LEVEL = 6;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let nextAllowedAt = 0;
async function throttle() {
  const now = Date.now();
  const startAt = Math.max(now, nextAllowedAt);
  nextAllowedAt = startAt + MIN_INTERVAL_MS;
  const wait = startAt - now;
  if (wait > 0) await sleep(wait);
}

/**
 * 노션 URL이나 ID 문자열에서 32자리 페이지 ID를 뽑아 대시 형식으로 정규화한다.
 * URL의 다른 글자(brand-inq 등)를 16진수로 오인하지 않도록 "정확히 32자리" 패턴만 찾는다.
 */
function normalizePageId(raw) {
  const m = String(raw ?? '').match(
    /[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}/i,
  );
  if (!m) return null;
  const hex = m[0].replace(/-/g, '').toLowerCase();
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** 사용자가 바로 고칠 수 있게 노션 오류를 한국어로 풀어준다. */
function explain(status, body) {
  const code = body && body.code;
  const raw = (body && body.message) || `HTTP ${status}`;
  if (status === 401) {
    return '노션 토큰이 올바르지 않아요. NOTION_TOKEN 값을 다시 확인해주세요.';
  }
  if (status === 404 || code === 'object_not_found') {
    return (
      '노션 페이지를 찾을 수 없어요. 도감 페이지에서 ••• → 연결(Connections)로 봇 연결을 추가했는지 확인해주세요. ' +
      '(연결을 추가하지 않으면 토큰이 맞아도 404가 납니다)'
    );
  }
  if (status === 403) {
    return '노션 연결에 읽기 권한이 없어요. 연결 설정에서 콘텐츠 읽기 권한을 켜주세요.';
  }
  if (status === 400 && /Notion-Version/i.test(raw)) {
    return `노션이 API 버전(${NOTION_VERSION})을 거부했어요: ${raw}`;
  }
  return `노션 API 오류: ${raw}`;
}

/** 429/5xx는 Retry-After를 존중하며 재시도한다. */
async function request(pathname, { searchParams, timeoutMs = 15_000, attempts = 4 } = {}) {
  const token = (process.env.NOTION_TOKEN || '').trim();
  if (!token) {
    throw new Error(
      'NOTION_TOKEN이 설정되지 않았어요. 노션 연결 토큰(ntn_...)을 환경변수에 넣어주세요.',
    );
  }

  const qs = searchParams && searchParams.size ? `?${searchParams}` : '';
  const url = `${API_BASE}${pathname}${qs}`;
  let lastError = null;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    await throttle();

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    let response;
    try {
      response = await fetch(url, {
        headers: {
          Authorization: `Bearer ${token}`,
          'Notion-Version': NOTION_VERSION,
        },
        signal: ac.signal,
      });
    } catch (e) {
      lastError =
        e && e.name === 'AbortError'
          ? new Error(`노션 API가 응답하지 않아요 (${timeoutMs / 1000}초 초과).`)
          : e;
      if (attempt < attempts - 1) {
        await sleep(Math.min(2 ** attempt, 8) * 1000);
        continue;
      }
      throw lastError;
    } finally {
      clearTimeout(timer);
    }

    // 일시적 오류 — 재시도 대상
    if (response.status === 429 || response.status === 529 || response.status >= 500) {
      const retryAfter = Number(response.headers.get('retry-after'));
      const waitSec = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 2 ** attempt;
      lastError = new Error(`노션 API 일시 오류 (HTTP ${response.status})`);
      if (attempt < attempts - 1) {
        await sleep(Math.min(waitSec, 15) * 1000);
        continue;
      }
      throw lastError;
    }

    const body = await response.json().catch(() => null);
    if (!response.ok) throw new Error(explain(response.status, body));
    return body;
  }

  throw lastError || new Error('노션 API 요청에 실패했어요.');
}

/** 한 블록의 자식 전체를 페이지네이션 끝까지 모은다. */
async function fetchChildren(blockId) {
  const out = [];
  let cursor = null;
  do {
    const params = new URLSearchParams({ page_size: '100' });
    if (cursor) params.set('start_cursor', cursor);
    const body = await request(`/blocks/${blockId}/children`, { searchParams: params });
    if (Array.isArray(body.results)) out.push(...body.results);
    cursor = body.has_more && body.next_cursor ? body.next_cursor : null;
  } while (cursor);
  return out;
}

/** rich_text 배열 → 디스코드에서 그대로 쓸 수 있는 마크다운 문자열 */
function richText(arr) {
  if (!Array.isArray(arr)) return '';
  return arr
    .map((t) => {
      let s = t.plain_text ?? '';
      if (!s.trim()) return s;
      const a = t.annotations || {};
      if (a.code) s = `\`${s}\``;
      if (a.bold) s = `**${s}**`;
      if (a.italic) s = `*${s}*`;
      if (a.strikethrough) s = `~~${s}~~`;
      const href = t.href || (t.text && t.text.link && t.text.link.url);
      if (href) s = `[${s}](${href})`;
      return s;
    })
    .join('');
}

/** 페이지 제목 (properties에서 title 타입을 찾는다) */
function pageTitle(page) {
  const props = (page && page.properties) || {};
  for (const value of Object.values(props)) {
    if (value && value.type === 'title') {
      const t = richText(value.title).trim();
      if (t) return t;
    }
  }
  return '(제목 없음)';
}

/** image/video/file 블록에서 URL을 뽑는다. 노션 내부 파일은 만료되는 서명 URL이다. */
function fileUrl(node) {
  if (!node) return '';
  if (node.type === 'external') return (node.external && node.external.url) || '';
  if (node.type === 'file') return (node.file && node.file.url) || '';
  return (node.external && node.external.url) || (node.file && node.file.url) || '';
}

/** 헤딩 줄은 들여쓰기를 붙이면 안 된다 (파서가 못 알아본다) */
const isHeadingLine = (line) => /^#{1,6}\s/.test(line);

/**
 * 하위 페이지 하나를 현재 위치에 펼쳐 넣는다.
 * @returns {Promise<string|null>} 제목 헤딩 + 본문 마크다운
 */
async function inlinePage(pageId, title, titleLevel, ctx) {
  const id = normalizePageId(pageId);
  if (!id || ctx.seen.has(id)) return null;
  if (ctx.pageCount >= MAX_PAGES) {
    if (!ctx.warnedLimit) {
      ctx.warnedLimit = true;
      console.warn(`[노션] 페이지가 ${MAX_PAGES}개를 넘어 나머지는 건너뛰었어요.`);
    }
    return null;
  }
  ctx.seen.add(id);
  ctx.pageCount += 1;

  try {
    const name = title || pageTitle(await request(`/pages/${id}`));
    const heading = `${'#'.repeat(Math.min(MAX_HEADING_LEVEL, Math.max(1, titleLevel)))} ${name}`;
    if (titleLevel >= MAX_HEADING_LEVEL) return heading; // 더 깊이는 안 들어간다
    const children = await fetchChildren(id);
    const body = await renderBlocks(children, ctx, { headingLevel: titleLevel });
    return body ? `${heading}\n${body}` : heading;
  } catch (e) {
    console.warn(`[노션] 하위 페이지 읽기 실패 (${title || id}): ${e.message}`);
    return null;
  }
}

/**
 * 블록 목록을 마크다운 줄로 바꾼다.
 * @param {object} opts.headingLevel 이 페이지가 몇 단계 안쪽인지 (루트 0). 헤딩 레벨을 이만큼 민다.
 */
async function renderBlocks(blocks, ctx, { headingLevel, indent = '' }) {
  const lines = [];
  let numbering = 0;
  // 하위 페이지 제목을 어느 깊이에 놓을지 정하려고 직전 헤딩 레벨을 기억해둔다.
  let lastHeadingLevel = headingLevel;

  for (const block of blocks) {
    const type = block.type;
    if (type !== 'numbered_list_item') numbering = 0;

    let line = null;
    let renderChildren = true;
    let noIndent = false;

    switch (type) {
      case 'paragraph':
        line = richText(block.paragraph.rich_text);
        break;
      case 'heading_1':
      case 'heading_2':
      case 'heading_3': {
        const own = Number(type.slice(-1));
        const level = Math.min(MAX_HEADING_LEVEL, headingLevel + own);
        const text = richText(block[type].rich_text).trim();
        if (text) {
          line = `${'#'.repeat(level)} ${text}`;
          lastHeadingLevel = level;
          noIndent = true;
        } else {
          line = '';
        }
        break;
      }
      case 'bulleted_list_item':
        line = `- ${richText(block.bulleted_list_item.rich_text)}`;
        break;
      case 'numbered_list_item':
        numbering += 1;
        line = `${numbering}. ${richText(block.numbered_list_item.rich_text)}`;
        break;
      case 'to_do':
        line = `- ${block.to_do.checked ? '[x]' : '[ ]'} ${richText(block.to_do.rich_text)}`;
        break;
      case 'toggle':
        line = `- ${richText(block.toggle.rich_text)}`;
        break;
      case 'quote':
        line = `> ${richText(block.quote.rich_text)}`;
        break;
      case 'callout': {
        const icon =
          block.callout.icon && block.callout.icon.type === 'emoji'
            ? `${block.callout.icon.emoji} `
            : '';
        line = `> ${icon}${richText(block.callout.rich_text)}`;
        break;
      }
      case 'code': {
        const lang = block.code.language === 'plain text' ? '' : block.code.language || '';
        line = `\`\`\`${lang}\n${richText(block.code.rich_text)}\n\`\`\``;
        break;
      }
      case 'equation':
        line = `\`${(block.equation && block.equation.expression) || ''}\``;
        break;
      case 'divider':
        line = '---';
        break;
      case 'image': {
        const url = fileUrl(block.image);
        const caption = richText(block.image.caption).trim();
        line = url ? `![${caption || '이미지'}](${url})` : '';
        break;
      }
      case 'video':
      case 'file':
      case 'pdf': {
        const url = fileUrl(block[type]);
        line = url ? `[첨부](${url})` : '';
        break;
      }
      case 'bookmark':
      case 'embed':
      case 'link_preview': {
        const url = (block[type] && block[type].url) || '';
        line = url ? `<${url}>` : '';
        break;
      }
      case 'table': {
        renderChildren = false;
        const rows = block.has_children ? await fetchChildren(block.id) : [];
        line = rows
          .filter((r) => r.type === 'table_row')
          .map((r) =>
            (r.table_row.cells || []).map((cell) => richText(cell).trim() || '-').join(' | '),
          )
          .join('\n');
        break;
      }
      case 'child_page': {
        // 자리 그대로 펼쳐 넣어야 상위 헤딩(공성전/파괴신) 문맥이 유지된다.
        renderChildren = false;
        noIndent = true;
        const title = (block.child_page && block.child_page.title) || null;
        line = await inlinePage(block.id, title, lastHeadingLevel + 1, ctx);
        break;
      }
      case 'child_database':
        renderChildren = false;
        line = `*(노션 데이터베이스: ${(block.child_database && block.child_database.title) || ''} — 봇이 읽지 못해요)*`;
        break;
      case 'link_to_page': {
        renderChildren = false;
        const target = block.link_to_page || {};
        if (target.page_id) {
          noIndent = true;
          line = await inlinePage(target.page_id, null, lastHeadingLevel + 1, ctx);
        } else {
          line = '';
        }
        break;
      }
      case 'column_list':
      case 'column':
      case 'synced_block':
        line = null; // 컨테이너 — 자식만 펼친다
        break;
      case 'table_of_contents':
      case 'breadcrumb':
      case 'unsupported':
        line = null;
        break;
      default: {
        // 모르는 블록이라도 rich_text가 있으면 살려둔다
        const node = block[type];
        line = node && Array.isArray(node.rich_text) ? richText(node.rich_text) : null;
        break;
      }
    }

    if (line) {
      const useIndent = indent && !noIndent;
      lines.push(
        useIndent
          ? line
              .split('\n')
              .map((l) => (isHeadingLine(l) ? l : indent + l))
              .join('\n')
          : line,
      );
    }

    if (renderChildren && block.has_children) {
      const isContainer = type === 'column_list' || type === 'column' || type === 'synced_block';
      const childIndent = isContainer || !line ? indent : `${indent}  `;
      const children = await fetchChildren(block.id);
      const sub = await renderBlocks(children, ctx, { headingLevel, indent: childIndent });
      if (sub) lines.push(sub);
    }
  }

  return lines.join('\n');
}

/**
 * 도감 페이지 전체(하위 페이지 포함)를 마크다운 한 덩어리로 만든다.
 * @returns {Promise<{title: string, markdown: string, pageCount: number, pageUrl: string}>}
 */
async function fetchDocument(rawPageId) {
  const rootId = normalizePageId(rawPageId);
  if (!rootId) {
    throw new Error('NOTION_PAGE_ID가 올바르지 않아요. 노션 페이지 주소나 32자리 ID를 넣어주세요.');
  }

  const rootPage = await request(`/pages/${rootId}`);
  const ctx = { seen: new Set([rootId]), pageCount: 1, warnedLimit: false };

  const rootBlocks = await fetchChildren(rootId);
  const markdown = await renderBlocks(rootBlocks, ctx, { headingLevel: 0 });

  return {
    title: pageTitle(rootPage),
    markdown,
    pageCount: ctx.pageCount,
    pageUrl: (rootPage && rootPage.url) || `https://www.notion.so/${rootId.replace(/-/g, '')}`,
  };
}

module.exports = { fetchDocument, normalizePageId, NOTION_VERSION };
