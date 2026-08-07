const {
  SlashCommandBuilder,
  EmbedBuilder,
  InteractionContextType,
  MessageFlags,
} = require('discord.js');
const voice = require('../voiceTime');

const TOP = 15;

module.exports = {
  data: new SlashCommandBuilder()
    .setName('음성')
    .setDescription('음성방에 머문 시간을 봅니다.')
    .addSubcommand((sub) =>
      sub
        .setName('시간')
        .setDescription('음성방 체류시간을 봅니다 (이번 주 · 전체).')
        .addUserOption((option) =>
          option.setName('멤버').setDescription('볼 멤버 (비우면 본인)'),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('순위')
        .setDescription('음성방 체류시간 순위를 봅니다.')
        .addStringOption((option) =>
          option
            .setName('기간')
            .setDescription('비우면 이번 주')
            .addChoices(
              { name: '이번 주', value: 'week' },
              { name: '전체 누적', value: 'total' },
            ),
        ),
    )
    .setContexts(InteractionContextType.Guild),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();

    if (sub === '시간') {
      const user = interaction.options.getUser('멤버') || interaction.user;
      const t = voice.timeOf(user.id);

      if (t.total === 0) {
        await interaction.reply({
          content: `${user}님은 아직 기록된 음성방 시간이 없어요.`,
          allowedMentions: { parse: [] },
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      const embed = new EmbedBuilder()
        .setTitle(`🎧 ${user.displayName ?? user.username}님의 음성 시간`)
        .setColor(0x5865f2)
        .addFields(
          { name: '이번 주', value: voice.formatDuration(t.week), inline: true },
          { name: '전체 누적', value: voice.formatDuration(t.total), inline: true },
        )
        .setThumbnail(user.displayAvatarURL())
        .setFooter({ text: `주간 기록은 월요일 0시(한국시간)에 초기화돼요` });

      if (t.ongoing > 0) {
        embed.setDescription(`지금 통화 중 — ${voice.formatDuration(t.ongoing)}째 (실시간 포함)`);
      }

      await interaction.reply({ embeds: [embed], allowedMentions: { parse: [] } });
      return;
    }

    // 순위
    const period = interaction.options.getString('기간') || 'week';
    const rows = voice.ranking(period).slice(0, TOP);

    if (rows.length === 0) {
      await interaction.reply({
        content: '아직 기록된 음성방 시간이 없어요.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const medal = ['🥇', '🥈', '🥉'];
    const lines = rows.map((r, i) => {
      const rank = medal[i] ?? `**${i + 1}.**`;
      const live = r.ongoing > 0 ? ' 🔴' : '';
      return `${rank} <@${r.userId}> — ${voice.formatDuration(r.ms)}${live}`;
    });

    const embed = new EmbedBuilder()
      .setTitle(period === 'total' ? '🎧 음성 시간 순위 — 전체 누적' : '🎧 음성 시간 순위 — 이번 주')
      .setDescription(lines.join('\n').slice(0, 4000))
      .setColor(0x5865f2)
      .setFooter({
        text:
          period === 'total'
            ? '🔴 = 지금 통화 중'
            : '월요일 0시(한국시간)에 초기화 · 🔴 = 지금 통화 중',
      });

    await interaction.reply({ embeds: [embed], allowedMentions: { parse: [] } });
  },
};
