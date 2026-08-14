const {
  SlashCommandBuilder,
  PermissionFlagsBits,
  MessageFlags,
  InteractionContextType,
} = require('discord.js');
const reader = require('../tts/reader');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('그만')
    .setDescription('읽어주기를 멈추고 음성방에서 나갑니다.')
    .addBooleanOption((option) =>
      option.setName('건너뛰기만').setDescription('나가지 않고 지금 읽는 것만 건너뛰기'),
    )
    .setContexts(InteractionContextType.Guild),

  async execute(interaction) {
    const guildId = interaction.guild.id;
    if (!reader.isActive(guildId)) {
      await interaction.reply({
        content: '지금 읽어주는 중이 아니에요.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    // 듣고 있는 사람들 것을 밖에서 아무나 끊으면 안 된다
    const here = reader.voiceChannelOf(guildId);
    const mine = interaction.member?.voice?.channelId;
    if (here && mine !== here && !interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      await interaction.reply({
        content: `<#${here}>에 들어와 있는 사람만 멈출 수 있어요.`,
        flags: MessageFlags.Ephemeral,
        allowedMentions: { parse: [] },
      });
      return;
    }

    if (interaction.options.getBoolean('건너뛰기만')) {
      const skipped = reader.skipAll(guildId);
      await interaction.reply({
        content: `⏭️ 지금 읽던 것과 대기 중 ${skipped}개를 건너뛰었어요.`,
      });
      return;
    }

    reader.leave(guildId, '명령으로');
    await interaction.reply({ content: '👋 읽어주기를 멈추고 나왔어요.' });
  },
};
