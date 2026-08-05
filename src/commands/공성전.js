const { SlashCommandBuilder, InteractionContextType } = require('discord.js');
const { respondAutocomplete, replyWithBuild } = require('../buildLookup');

const CATEGORY = '공성전';
const WEEKDAYS = ['월', '화', '수', '목', '금', '토', '일'];

module.exports = {
  data: new SlashCommandBuilder()
    .setName('공성전')
    .setDescription('공성전 빌드를 도감에서 찾아 보여줍니다.')
    .addStringOption((option) =>
      option
        .setName('요일')
        .setDescription('요일로 먼저 걸러내기 (선택)')
        .addChoices(...WEEKDAYS.map((d) => ({ name: `${d}요일`, value: d }))),
    )
    .addStringOption((option) =>
      option
        .setName('빌드')
        .setDescription('빌드 이름 (비우면 목록이 뜹니다)')
        .setAutocomplete(true),
    )
    .setContexts(InteractionContextType.Guild),

  async autocomplete(interaction) {
    await respondAutocomplete(interaction, CATEGORY, { weekdayOption: '요일' });
  },

  async execute(interaction) {
    await replyWithBuild(interaction, CATEGORY, { weekdayOption: '요일' });
  },
};
