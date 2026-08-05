const {
  SlashCommandBuilder,
  PermissionFlagsBits,
  InteractionContextType,
  EmbedBuilder,
} = require('discord.js');
const builds = require('../builds');

/** 인터랙션 토큰은 15분이면 만료된다 — 그 전에 끊어서 응답할 수 있게 한다. */
const SYNC_DEADLINE_MS = 10 * 60 * 1000;

module.exports = {
  data: new SlashCommandBuilder()
    .setName('빌드갱신')
    .setDescription('노션 도감을 다시 읽어 빌드 목록을 최신으로 맞춥니다.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setContexts(InteractionContextType.Guild),

  async execute(interaction) {
    // 노션 전체를 훑으므로 3초를 넘긴다
    await interaction.deferReply();

    let timer = null;
    try {
      const r = await Promise.race([
        builds.sync(),
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('노션 동기화가 너무 오래 걸려 중단했어요.')),
            SYNC_DEADLINE_MS,
          );
        }),
      ]);

      const state = builds.status();
      const embed = new EmbedBuilder()
        .setTitle('📘 도감 갱신 완료')
        .setDescription(`**${r.title}** — 노션 페이지 ${r.pageCount}개를 읽었어요.`)
        .addFields(
          { name: '공성전 빌드', value: `${state.byCategory.공성전}개`, inline: true },
          { name: '파괴신 빌드', value: `${state.byCategory.파괴신}개`, inline: true },
        )
        .setColor(0x57f287);
      if (r.cached === false) {
        embed.setFooter({ text: '캐시 저장에 실패했어요 — 봇을 재시작하면 목록이 비워집니다.' });
      }
      await interaction.editReply({ embeds: [embed] });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // 토큰이 이미 만료됐으면 이 응답도 실패한다 — 여기서 다시 던지지 않는다.
      await interaction
        .editReply({
          content: `⚠️ 갱신 실패: ${msg}`.slice(0, 1900),
          allowedMentions: { parse: [] },
        })
        .catch(() => {});
    } finally {
      if (timer) clearTimeout(timer);
    }
  },
};
