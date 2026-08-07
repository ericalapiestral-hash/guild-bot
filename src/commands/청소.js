const {
  SlashCommandBuilder,
  PermissionFlagsBits,
  MessageFlags,
  InteractionContextType,
} = require('discord.js');
const { sendLog, makeEmbed, clamp, userLine } = require('../logger');

/** 디스코드는 14일이 지난 메시지를 일괄 삭제하지 못한다 */
const BULK_LIMIT_MS = 14 * 24 * 60 * 60 * 1000 - 60_000;

module.exports = {
  data: new SlashCommandBuilder()
    .setName('청소')
    .setDescription('이 채널의 최근 메시지를 지웁니다.')
    .addIntegerOption((option) =>
      option
        .setName('개수')
        .setDescription('지울 메시지 수 (1~100)')
        .setMinValue(1)
        .setMaxValue(100)
        .setRequired(true),
    )
    .addUserOption((option) =>
      option.setName('멤버').setDescription('이 멤버의 메시지만 지우기 (선택)'),
    )
    .addStringOption((option) =>
      option.setName('사유').setDescription('로그에 남길 사유 (선택)').setMaxLength(200),
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
    .setContexts(InteractionContextType.Guild),

  async execute(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const amount = interaction.options.getInteger('개수');
    const target = interaction.options.getUser('멤버');
    const reason = interaction.options.getString('사유');
    const channel = interaction.channel;

    const me = interaction.guild.members.me;
    if (!channel || !channel.permissionsFor(me)?.has(PermissionFlagsBits.ManageMessages)) {
      await interaction.editReply('이 채널에서 봇에게 **메시지 관리** 권한이 없어요.');
      return;
    }

    try {
      // 멤버로 거를 때는 넉넉히 가져와서 그중 조건에 맞는 것만 고른다
      const fetched = await channel.messages.fetch({ limit: 100 });
      const cutoff = Date.now() - BULK_LIMIT_MS;

      const targets = [...fetched.values()]
        .filter((m) => m.createdTimestamp > cutoff)
        .filter((m) => !m.pinned) // 고정된 메시지는 건드리지 않는다
        .filter((m) => !target || m.author.id === target.id)
        .slice(0, amount);

      if (targets.length === 0) {
        await interaction.editReply(
          target
            ? `최근 100개 중 ${target}님의 지울 수 있는 메시지가 없어요. (14일이 지난 메시지는 지울 수 없어요)`
            : '지울 수 있는 메시지가 없어요. (14일이 지난 메시지는 지울 수 없어요)',
        );
        return;
      }

      const deleted = await channel.bulkDelete(targets, true);

      const skipped = targets.length - deleted.size;
      const lines = [`✅ 메시지 **${deleted.size}개**를 지웠어요.`];
      if (target) lines.push(`대상: ${target}`);
      if (skipped > 0) lines.push(`${skipped}개는 너무 오래돼서 건너뛰었어요.`);
      await interaction.editReply({ content: lines.join('\n'), allowedMentions: { parse: [] } });

      const embed = makeEmbed('청소', '🧽 /청소 실행됨')
        .addFields({ name: '실행자', value: clamp(userLine(interaction.user), 1000) })
        .addFields({ name: '채널', value: `<#${channel.id}>` })
        .addFields({ name: '지운 개수', value: `${deleted.size}개`, inline: true });
      if (target) {
        embed.addFields({ name: '대상 멤버', value: clamp(userLine(target), 1000), inline: true });
      }
      if (reason) embed.addFields({ name: '사유', value: clamp(reason, 1000) });
      await sendLog(interaction.guild, embed);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await interaction.editReply({
        content: `⚠️ 지우지 못했어요: ${msg}`.slice(0, 1900),
        allowedMentions: { parse: [] },
      });
    }
  },
};
