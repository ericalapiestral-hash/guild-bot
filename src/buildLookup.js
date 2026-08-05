// /파괴신 · /공성전 빌드 검색의 공통 로직 (자동완성 + 조회)
'use strict';

const { MessageFlags } = require('discord.js');
const builds = require('./builds');
const { buildEmbed, notFoundMessage } = require('./buildEmbed');

/** 디스코드 자동완성 한도 */
const MAX_CHOICES = 25;
const MAX_CHOICE_LEN = 100;

/** 검색 결과와 함께 보여줄 "다른 결과" 최대 개수 */
const MAX_OTHERS = 5;

function weekdayOf(interaction, optionName) {
  if (!optionName) return null;
  try {
    return interaction.options.getString(optionName) || null;
  } catch {
    return null;
  }
}

/**
 * 자동완성 응답. 3초 안에 끝나야 하고 최대 25개까지만 보낼 수 있다.
 * discord.js가 개수를 검사해주지 않으므로 여기서 직접 자른다.
 *
 * value에는 라벨이 아니라 빌드 고유 키(#해시)를 넣는다 — 라벨은 100자에서 잘리거나
 * 주차가 다른 동명 빌드끼리 겹쳐서, 고른 것과 다른 빌드가 뜰 수 있다.
 */
async function respondAutocomplete(interaction, category, { weekdayOption } = {}) {
  const focused = interaction.options.getFocused() ?? '';
  const weekday = weekdayOf(interaction, weekdayOption);
  const found = builds.search(category, focused, { weekday, limit: MAX_CHOICES });

  await interaction.respond(
    found.slice(0, MAX_CHOICES).map((b) => ({
      name: (b.label || b.name || '이름 없음').slice(0, MAX_CHOICE_LEN),
      value: String(b.id || b.label || b.name || '').slice(0, MAX_CHOICE_LEN),
    })),
  );
}

/** 검색어 없이 실행했을 때 — 빌드 하나를 채널에 뿌리지 말고 목록만 보여준다. */
async function replyWithList(interaction, category, weekday) {
  const list = builds.search(category, '', { weekday, limit: MAX_CHOICES });
  const state = builds.status();

  if (list.length === 0) {
    await interaction.reply({
      content: notFoundMessage(category, '', state),
      allowedMentions: { parse: [] },
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const header = `**${category}** 빌드 ${state.byCategory[category]}개${
    weekday ? ` · ${weekday}요일` : ''
  } — 이름을 일부만 쳐도 찾아져요.`;
  const body = list.map((b) => `· ${b.label}`).join('\n');
  const more = state.byCategory[category] > list.length ? '\n… (검색어를 넣으면 좁혀져요)' : '';

  await interaction.reply({
    content: `${header}\n${body}${more}`.slice(0, 1900),
    allowedMentions: { parse: [] },
    flags: MessageFlags.Ephemeral,
  });
}

/** 빌드를 찾아 임베드로 답한다. */
async function replyWithBuild(interaction, category, { weekdayOption } = {}) {
  const query = (interaction.options.getString('빌드') || '').trim();
  const weekday = weekdayOf(interaction, weekdayOption);

  if (!query) {
    await replyWithList(interaction, category, weekday);
    return;
  }

  const state = builds.status();

  // 자동완성에서 고른 경우 — 고유 키로 정확히 집는다
  const picked = builds.findById(category, query);
  if (picked) {
    await interaction.reply({
      embeds: [buildEmbed(picked, [], state)],
      allowedMentions: { parse: [] },
    });
    return;
  }

  const found = builds.search(category, query, { weekday, limit: MAX_OTHERS + 1 });
  if (found.length === 0) {
    await interaction.reply({
      content: notFoundMessage(category, query, state),
      allowedMentions: { parse: [] },
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const [top, ...others] = found;
  await interaction.reply({
    embeds: [buildEmbed(top, others.slice(0, MAX_OTHERS), state)],
    allowedMentions: { parse: [] },
  });
}

module.exports = { respondAutocomplete, replyWithBuild };
