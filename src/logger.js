// 로그 채널로 임베드를 보내는 공용 모듈.
// 채널이 없거나 권한이 없으면 조용히 넘어간다 — 로그 때문에 봇이 멈추면 안 된다.
'use strict';

const { EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const store = require('./store');

const COLORS = {
  삭제: 0xed4245,
  수정: 0xfee75c,
  입장: 0x57f287,
  퇴장: 0x99aab5,
  음성: 0x5865f2,
  청소: 0xeb459e,
};

/** 임베드 필드/설명 한도에 맞게 자른다 */
function clamp(text, limit) {
  const s = String(text ?? '').trim();
  if (!s) return '';
  if (s.length <= limit) return s;
  return `${s.slice(0, Math.max(0, limit - 4))} …`;
}

/** 설정된 로그 채널 ID */
function logChannelId() {
  return store.get('logChannelId') || null;
}

/** 로그 채널에서 일어난 일인지 (로그가 로그를 부르는 것 방지) */
function isLogChannel(channelId) {
  const id = logChannelId();
  return Boolean(id) && id === channelId;
}

/**
 * /청소는 여러 번 나눠 지우기 때문에 일괄삭제 이벤트가 여러 개 뜬다.
 * 명령이 스스로 요약 로그를 남기므로, 그동안의 일괄삭제 이벤트는 건너뛴다.
 */
const commandBulkUntil = new Map();

function markCommandBulk(channelId, ms = 20_000) {
  commandBulkUntil.set(channelId, Date.now() + ms);
}

function isCommandBulk(channelId) {
  const until = commandBulkUntil.get(channelId);
  if (!until) return false;
  if (Date.now() > until) {
    commandBulkUntil.delete(channelId);
    return false;
  }
  return true;
}

/** 로그 채널을 가져온다. 없거나 못 쓰면 null. */
async function resolveChannel(guild) {
  const id = logChannelId();
  if (!id || !guild) return null;

  const channel =
    guild.channels.cache.get(id) ?? (await guild.channels.fetch(id).catch(() => null));
  if (!channel || !channel.isTextBased()) return null;

  const me = guild.members.me;
  if (me) {
    const perms = channel.permissionsFor(me);
    if (
      !perms ||
      !perms.has([
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.EmbedLinks,
      ])
    ) {
      return null;
    }
  }
  return channel;
}

/**
 * 로그 임베드를 보낸다.
 * 로그 내용에 @everyone 같은 게 섞여 있어도 멘션이 실제로 나가지 않게 전부 막는다.
 */
async function sendLog(guild, embed) {
  try {
    const channel = await resolveChannel(guild);
    if (!channel) return;
    await channel.send({ embeds: [embed], allowedMentions: { parse: [] } });
  } catch (e) {
    console.warn(`[로그] 전송 실패: ${e.message}`);
  }
}

/** 로그 임베드 뼈대 */
function makeEmbed(kind, title) {
  return new EmbedBuilder()
    .setTitle(clamp(title, 250))
    .setColor(COLORS[kind] ?? 0x5865f2)
    .setTimestamp(new Date());
}

/** 사용자 표기 — 태그와 ID를 함께 남겨 나중에 추적 가능하게 */
function userLine(user) {
  if (!user) return '(알 수 없음)';
  return `${user} · \`${user.tag ?? user.username ?? '?'}\` (${user.id})`;
}

module.exports = {
  sendLog,
  makeEmbed,
  clamp,
  userLine,
  isLogChannel,
  logChannelId,
  markCommandBulk,
  isCommandBulk,
};
