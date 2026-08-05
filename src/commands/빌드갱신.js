const {
  SlashCommandBuilder,
  PermissionFlagsBits,
  InteractionContextType,
  EmbedBuilder,
} = require('discord.js');
const builds = require('../builds');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('빌드갱신')
    .setDescription('노션 도감을 다시 읽어 빌드 목록을 최신으로 맞춥니다.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setContexts(InteractionContextType.Guild),

  async execute(interaction) {
    // 노션 전체를 훑으므로 3초를 넘긴다
    await interaction.deferReply();
    try {
      const r = await builds.sync();
      const state = builds.status();
      const embed = new EmbedBuilder()
        .setTitle('📘 도감 갱신 완료')
        .setDescription(`**${r.title}** — 노션 페이지 ${r.pageCount}개를 읽었어요.`)
        .addFields(
          { name: '공성전 빌드', value: `${state.byCategory.공성전}개`, inline: true },
          { name: '파괴신 빌드', value: `${state.byCategory.파괴신}개`, inline: true },
        )
        .setColor(0x57f287);
      if (state.pageUrl) embed.setURL(state.pageUrl);
      await interaction.editReply({ embeds: [embed] });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await interaction.editReply({
        content: `⚠️ 갱신 실패: ${msg}`.slice(0, 1900),
        allowedMentions: { parse: [] },
      });
    }
  },
};
