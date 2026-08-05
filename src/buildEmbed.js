// 빌드 하나를 디스코드 임베드로 만든다. 임베드 한도(설명 4096 / 전체 6000)를 넘지 않게 자른다.
'use strict';

const { EmbedBuilder } = require('discord.js');

const DESC_LIMIT = 3800;
const FIELD_LIMIT = 1000;
/** 디스코드가 거부하는 임베드 전체 합계(6000)보다 여유 있게 */
const TOTAL_LIMIT = 5500;

/** 노션 내부 이미지 URL은 서명이 만료되므로, 동기화한 지 오래되면 붙이지 않는다. */
const IMAGE_FRESH_MS = 40 * 60 * 1000;

const COLORS = { 공성전: 0x5865f2, 파괴신: 0xed4245 };

function clamp(text, limit) {
  const s = String(text ?? '').trim();
  if (s.length <= limit) return s;
  return `${s.slice(0, Math.max(0, limit - 20)).trimEnd()}\n… (이하 생략)`;
}

function isFresh(syncedAt) {
  if (!syncedAt) return false;
  const t = Date.parse(syncedAt);
  return Number.isFinite(t) && Date.now() - t < IMAGE_FRESH_MS;
}

function weekdayText(build) {
  const list = Array.isArray(build.weekdays) ? build.weekdays : [];
  if (list.length === 0) return null;
  return `${list.join('·')}요일`;
}

/**
 * @param {object} build  builds.search()가 돌려준 빌드
 * @param {object[]} others  같이 걸린 다른 빌드들 (안내용)
 * @param {object} state  builds.status() 결과
 */
function buildEmbed(build, others, state) {
  const icon = build.category === '파괴신' ? '🔥' : '🏰';
  const where = [build.category, weekdayText(build)].filter(Boolean).join(' · ');

  const title = clamp(`${icon} ${build.name}`, 250) || `${icon} 빌드`;
  const embed = new EmbedBuilder().setTitle(title).setColor(COLORS[build.category] ?? 0x5865f2);

  // 임베드 전체 합계(6000)는 discord.js가 검사하지 않는다 — 직접 예산을 잡는다.
  let budget = TOTAL_LIMIT - title.length;

  const body = String(build.body || '').trim();
  const description = body
    ? clamp(body, Math.min(DESC_LIMIT, Math.max(200, budget)))
    : '*(노션에 적힌 내용이 없어요)*';
  embed.setDescription(description);
  budget -= description.length;

  if (build.label && build.label !== build.name && budget > 200) {
    const value = clamp(build.label, Math.min(FIELD_LIMIT, budget - 100));
    if (value) {
      embed.addFields({ name: '위치', value });
      budget -= value.length + 2;
    }
  }

  if (others && others.length > 0 && budget > 200) {
    const value = clamp(
      others.map((b) => `· ${b.label}`).join('\n'),
      Math.min(FIELD_LIMIT, budget - 100),
    );
    if (value) {
      embed.addFields({ name: `다른 결과 ${others.length}개`, value });
      budget -= value.length + 12;
    }
  }

  if (build.image && isFresh(state && state.syncedAt)) {
    embed.setImage(build.image);
  }

  // 제목 링크는 걸지 않는다 — 도감이 비공개라 눌러도 권한 없음 화면만 나온다.

  const footerParts = [where];
  if (state && state.syncedAt) {
    const d = new Date(state.syncedAt);
    if (!Number.isNaN(d.getTime())) {
      footerParts.push(
        `노션 기준 ${d.toLocaleString('ko-KR', {
          timeZone: 'Asia/Seoul',
          dateStyle: 'short',
          timeStyle: 'short',
        })}`,
      );
    }
  }
  const footer = footerParts.filter(Boolean).join(' · ');
  if (footer && budget > 0) embed.setFooter({ text: clamp(footer, Math.min(2040, budget)) });

  return embed;
}

/** 검색 결과가 없을 때 보여줄 안내 문구 */
function notFoundMessage(category, query, state) {
  const q = String(query || '').slice(0, 80);
  const lines = [
    q
      ? `⚠️ **${category}** 빌드에서 \`${q}\`을(를) 찾지 못했어요.`
      : `⚠️ **${category}** 빌드가 아직 없어요.`,
  ];
  const count = state && state.byCategory ? state.byCategory[category] : 0;

  if (!count) {
    lines.push(
      state && state.error
        ? `도감을 읽지 못하고 있어요 — ${state.error}`
        : '아직 도감에서 읽어온 빌드가 없어요. 서버 관리자가 `/빌드갱신`으로 다시 불러올 수 있어요.',
    );
  } else {
    lines.push(`검색어를 비우고 실행하면 ${category} 빌드 목록을 볼 수 있어요.`);
  }
  return lines.join('\n');
}

module.exports = { buildEmbed, notFoundMessage, clamp };
