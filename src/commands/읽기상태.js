const {
  SlashCommandBuilder,
  EmbedBuilder,
  MessageFlags,
  InteractionContextType,
  GatewayIntentBits,
} = require('discord.js');
const settings = require('../tts/settings');
const provider = require('../tts/provider');
const reader = require('../tts/reader');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('읽기상태')
    .setDescription('읽어주기가 지금 어떤 상태인지 봅니다.')
    .setContexts(InteractionContextType.Guild),

  async execute(interaction) {
    const guildId = interaction.guild.id;
    const status = reader.statusOf(guildId);
    const configured = provider.isConfigured();

    const embed = new EmbedBuilder()
      .setTitle('🔊 읽어주기 상태')
      .setColor(configured ? 0x57f287 : 0xed4245)
      .addFields(
        {
          name: 'TTS',
          value: configured ? `연결됨 (${provider.describeTarget()})` : '❌ 없음 — `.env`에 `TTS_URL` 또는 `TTS_COMMAND`를 넣어주세요',
        },
        { name: '한 번에 읽을 최대 글자', value: `${settings.maxChars()}자`, inline: true },
      );

    if (status) {
      embed.addFields(
        { name: '들어가 있는 방', value: `<#${status.channelId}>`, inline: true },
        { name: '대기 중', value: `${status.queued}개`, inline: true },
        {
          name: '읽는 채팅',
          value: `<#${status.channelId}> 음성방 안의 채팅창`,
        },
      );
      if (status.lastError) {
        embed.addFields({ name: '최근 오류', value: String(status.lastError).slice(0, 1000) });
      }
    } else {
      embed.addFields({
        name: '상태',
        value: '음성방에 들어가 있지 않아요 — 음성방에 들어간 뒤 `/읽어줘`',
      });
    }

    if (!interaction.client.options.intents.has(GatewayIntentBits.MessageContent)) {
      embed.addFields({
        name: '⚠️ 채팅 자동 읽기가 꺼져 있어요',
        value:
          '개발자 포털 → Bot → **Message Content Intent**를 켜야 채팅 내용을 읽을 수 있어요.\n' +
          '지금은 `/읽어줘 내용:...`으로 문장을 직접 넣는 것만 됩니다.',
      });
    }

    await interaction.reply({
      embeds: [embed],
      flags: MessageFlags.Ephemeral,
      allowedMentions: { parse: [] },
    });
  },
};
