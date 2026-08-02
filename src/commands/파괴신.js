const { SlashCommandBuilder, InteractionContextType } = require('discord.js');
const { fetchStats, buildDestroyerEmbed } = require('../statsApi');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('파괴신')
    .setDescription('길드 사이트의 파괴신 통계를 순위표로 보여줍니다 (전 시즌·중간집계 대비 포함).')
    .addStringOption((option) =>
      option
        .setName('시즌')
        .setDescription('시즌 검색어 (예: 7월 2분기 — 비우면 기록이 있는 최근 시즌)'),
    )
    .setContexts(InteractionContextType.Guild),

  async execute(interaction) {
    // API 응답이 3초를 넘길 수 있으니 먼저 응답을 예약
    await interaction.deferReply();
    try {
      const stats = await fetchStats('/api/destroyer', {
        season: interaction.options.getString('시즌'),
      });
      await interaction.editReply({ embeds: [buildDestroyerEmbed(stats)] });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // 오류 문구가 사용자 입력(검색어)을 되풀이할 수 있으니 멘션은 전부 차단
      await interaction.editReply({
        content: `⚠️ ${msg}`.slice(0, 1900),
        allowedMentions: { parse: [] },
      });
    }
  },
};
