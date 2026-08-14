const {
  SlashCommandBuilder,
  PermissionFlagsBits,
  MessageFlags,
  InteractionContextType,
  ChannelType,
  EmbedBuilder,
} = require('discord.js');
const settings = require('../tts/settings');
const provider = require('../tts/provider');
const reader = require('../tts/reader');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('읽기설정')
    .setDescription('읽어주기(TTS) 설정을 관리합니다.')
    .addSubcommand((sub) =>
      sub
        .setName('설정')
        .setDescription('읽어줄 텍스트 채널을 고정합니다.')
        .addChannelOption((option) =>
          option
            .setName('채널')
            .setDescription('이 채널의 채팅만 읽어줘요')
            .addChannelTypes(ChannelType.GuildText)
            .setRequired(true),
        ),
    )
    .addSubcommand((sub) =>
      sub.setName('해제').setDescription('채널 고정을 풀어요 (/읽어줘를 실행한 채널을 읽어요).'),
    )
    .addSubcommand((sub) => sub.setName('확인').setDescription('지금 설정과 상태를 봅니다.'))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setContexts(InteractionContextType.Guild),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();
    const guildId = interaction.guild.id;

    if (sub === '설정') {
      const channel = interaction.options.getChannel('채널');

      // 봇이 못 보는 채널을 고정하면 읽어주기가 조용히 멈춘다 — 미리 막는다
      const botPerms = channel.permissionsFor(interaction.guild.members.me);
      if (!botPerms?.has(PermissionFlagsBits.ViewChannel)) {
        await interaction.reply({
          content: `${channel}을(를) 봇이 볼 수 없어요. 그 채널에 봇의 **채널 보기** 권한을 먼저 주세요.`,
          flags: MessageFlags.Ephemeral,
          allowedMentions: { parse: [] },
        });
        return;
      }

      const ok = settings.setChannel(guildId, channel.id);
      await interaction.reply({
        content: ok
          ? `✅ 이제 ${channel}의 채팅만 읽어줘요.`
          : `${channel}로 설정했지만 **파일에 저장하지 못했어요.** 봇을 다시 켜면 사라집니다.`,
        allowedMentions: { parse: [] },
      });
      return;
    }

    if (sub === '해제') {
      const ok = settings.setChannel(guildId, null);
      await interaction.reply({
        content: ok
          ? '채널 고정을 풀었어요. `/읽어줘`를 실행한 채널의 채팅을 읽어줍니다.'
          : '고정을 풀었지만 **파일에 저장하지 못했어요.** 봇을 다시 켜면 되돌아갑니다.',
      });
      return;
    }

    // 확인
    const fixed = settings.channelId(guildId);
    const status = reader.statusOf(guildId);
    const configured = provider.isConfigured();

    const embed = new EmbedBuilder()
      .setTitle('🔊 읽어주기 설정')
      .setColor(configured ? 0x57f287 : 0xed4245)
      .addFields(
        {
          name: 'TTS 서버',
          value: configured
            ? '연결됨 (`TTS_URL` 설정 완료)'
            : '❌ 없음 — `.env`에 `TTS_URL`을 넣어주세요',
        },
        { name: '읽을 채널', value: fixed ? `<#${fixed}>` : '고정 안 함 (/읽어줘 실행한 채널)' },
        { name: '한 번에 읽을 최대 글자', value: `${settings.maxChars()}자`, inline: true },
      );

    if (status) {
      embed.addFields(
        { name: '지금 들어가 있는 방', value: `<#${status.channelId}>`, inline: true },
        { name: '대기 중', value: `${status.queued}개`, inline: true },
      );
      if (status.lastError) {
        embed.addFields({ name: '최근 오류', value: String(status.lastError).slice(0, 1000) });
      }
    } else {
      embed.addFields({ name: '상태', value: '음성방에 들어가 있지 않아요 (`/읽어줘`로 부르세요)' });
    }

    const hasContent = interaction.client.options.intents.has(
      require('discord.js').GatewayIntentBits.MessageContent,
    );
    if (!hasContent) {
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
