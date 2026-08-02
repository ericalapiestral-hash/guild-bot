// 낭만주의 길드 사이트(Cloudflare Worker)의 통계 API를 읽어 임베드로 만드는 공용 모듈.
// 읽기 전용 — 길드 데이터를 수정하지 않는다.
const { EmbedBuilder } = require('discord.js');

const API_BASE = (process.env.STATS_API_BASE || 'https://sena-guild-search.ericalapiestral.workers.dev').replace(/\/+$/, '');

/** 임베드 설명 한도(4096)보다 여유 있게 */
const DESC_LIMIT = 4000;

/** 10초 타임아웃 fetch + API 오류 메시지 통일 */
async function fetchStats(pathname, params = {}) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') qs.set(k, v);
  }
  const url = `${API_BASE}${pathname}${qs.size ? `?${qs}` : ''}`;

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 10_000);
  try {
    const r = await fetch(url, { signal: ac.signal });
    let body = null;
    try {
      body = await r.json();
    } catch {
      if (ac.signal.aborted) throw new Error('통계 API가 응답하지 않아요 (10초 초과).');
      body = null;
    }
    if (!r.ok || !body || body.ok === false) {
      throw new Error((body && body.error) || `통계 API 오류 (HTTP ${r.status})`);
    }
    return body;
  } catch (e) {
    if (e instanceof Error && e.name === 'AbortError') {
      throw new Error('통계 API가 응답하지 않아요 (10초 초과).');
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

const fmt = (n) => (typeof n === 'number' ? n.toLocaleString('ko-KR') : '-');

/** ▲/▼ 등락 표시 (null이면 —) */
function pct(p) {
  if (typeof p !== 'number') return '—';
  if (p === 0) return '0%';
  return `${p > 0 ? '▲' : '▼'}${Math.abs(p).toFixed(1)}%`;
}

/** 순위 줄들을 임베드 한도에 맞게 자른다. */
function clampLines(lines) {
  let out = '';
  for (const line of lines) {
    if (out.length + line.length + 1 > DESC_LIMIT) {
      out += '\n… (이하 생략)';
      break;
    }
    out += (out ? '\n' : '') + line;
  }
  return out || '(기록 없음)';
}

/** 공성전 순위표 임베드 */
function buildSiegeEmbed(s) {
  const lines = s.entries.map(
    (e) => `**${e.rank}.** ${e.name} — ${fmt(e.value)} (${pct(e.deltaPct)})${e.fail ? ' ⛔' : ''}`,
  );
  const footer = [
    `${s.count}명 · 합계 ${fmt(s.total)}`,
    typeof s.cutline === 'number' ? `커트라인 ${fmt(s.cutline)} 이하 미달 ${s.failCount}명` : '',
    s.prevWeek ? `전주 대비: ${s.prevWeek}` : '',
  ]
    .filter(Boolean)
    .join(' · ');
  return new EmbedBuilder()
    .setTitle(`🏰 공성전 — ${s.week} · ${s.day}요일`.slice(0, 256))
    .setDescription(clampLines(lines))
    .setColor(0x5865f2)
    .setFooter({ text: footer.slice(0, 2048) });
}

/** 파괴신 순위표 임베드 (전 시즌·중간집계 대비 포함) */
function buildDestroyerEmbed(s) {
  const lines = s.entries.map((e) => {
    const deltas = `전시즌 ${pct(e.deltaPrevPct)}${
      e.mid !== null && e.value !== null ? ` · 중간대비 ${pct(e.deltaMidPct)}` : ''
    }`;
    const tier = e.tier ? ` [${e.tier}]` : '';
    return `**${e.rank}.** ${e.name}${tier} — ${fmt(e.eff)} (${deltas})${e.fail ? ' ⛔' : ''}`;
  });
  const cutParts = Object.entries(s.tierCutlines || {}).map(([t, v]) => `${t} ${fmt(v)}`);
  if (typeof s.cutline === 'number') cutParts.push(`기본 ${fmt(s.cutline)}`);
  const footer = [
    `${s.count}명 · 합계 ${fmt(s.total)}`,
    `중간 ${s.midCount} · 최종 ${s.finalCount}`,
    cutParts.length ? `커트라인 ${cutParts.join(' / ')} 이하 미달 ${s.failCount}명` : '',
    s.prevSeason ? `전 시즌: ${s.prevSeason}` : '',
  ]
    .filter(Boolean)
    .join(' · ');
  return new EmbedBuilder()
    .setTitle(`🔥 파괴신 — ${s.season}`.slice(0, 256))
    .setDescription(clampLines(lines))
    .setColor(0xed4245)
    .setFooter({ text: footer.slice(0, 2048) });
}

module.exports = { fetchStats, buildSiegeEmbed, buildDestroyerEmbed };
