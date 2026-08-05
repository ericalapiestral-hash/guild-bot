const { SlashCommandBuilder, InteractionContextType } = require('discord.js');
const { respondAutocomplete, replyWithBuild } = require('../buildLookup');

const CATEGORY = '파괴신';

module.exports = {
  data: new SlashCommandBuilder()
    .setName('파괴신')
    .setDescription('파괴신 빌드를 도감에서 찾아 보여줍니다.')
    .addStringOption((option) =>
      option
        .setName('빌드')
        .setDescription('빌드 이름 (예: 파이 세인 4턴 — 비우면 목록이 뜹니다)')
        .setAutocomplete(true),
    )
    .setContexts(InteractionContextType.Guild),

  async autocomplete(interaction) {
    await respondAutocomplete(interaction, CATEGORY);
  },

  async execute(interaction) {
    await replyWithBuild(interaction, CATEGORY);
  },
};
