const {
  SlashCommandBuilder,
  PermissionFlagsBits,
  MessageFlags,
  InteractionContextType,
} = require('discord.js');
const reader = require('../tts/reader');
const provider = require('../tts/provider');
const { toSpeech } = require('../tts/text');
const settings = require('../tts/settings');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('읽어줘')
    .setDescription('음성방에 들어와서 그 방의 채팅을 읽어줍니다.')
    .addStringOption((option) =>
      option.setName('내용').setDescription('이 문장만 바로 읽기 (선택)').setMaxLength(300),
    )
    .setContexts(InteractionContextType.Guild),

  async execute(interaction) {
    const voiceChannel = interaction.member?.voice?.channel;
    if (!voiceChannel) {
      await interaction.reply({
        content: '먼저 음성방에 들어가 주세요.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (!provider.isConfigured()) {
      await interaction.reply({
        content:
          '⚠️ TTS가 아직 연결되지 않았어요.\n`.env`에 `TTS_URL`(또는 `TTS_COMMAND`)을 넣어주세요.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    // 다른 방에서 듣고 있는 사람이 있으면 봇을 빼앗아 가지 않는다
    const busy = reader.voiceChannelOf(interaction.guild.id);
    if (busy && busy !== voiceChannel.id) {
      const room = interaction.guild.channels.cache.get(busy);
      const listeners = room ? room.members.filter((m) => !m.user.bot).size : 0;
      if (listeners > 0) {
        await interaction.reply({
          content: `지금 <#${busy}>에서 ${listeners}명이 듣고 있어요. 그 방이 빌 때까지 기다리거나, 거기 있는 분이 \`/그만\`을 해주셔야 해요.`,
          flags: MessageFlags.Ephemeral,
          allowedMentions: { parse: [] },
        });
        return;
      }
    }

    const me = interaction.guild.members.me;
    const perms = voiceChannel.permissionsFor(me);
    const missing = [];
    if (!perms?.has(PermissionFlagsBits.ViewChannel)) missing.push('채널 보기');
    if (!perms?.has(PermissionFlagsBits.Connect)) missing.push('연결');
    if (!perms?.has(PermissionFlagsBits.Speak)) missing.push('말하기');
    if (missing.length > 0) {
      await interaction.reply({
        content: `${voiceChannel}에서 봇 권한이 부족해요: **${missing.join(', ')}**`,
        flags: MessageFlags.Ephemeral,
        allowedMentions: { parse: [] },
      });
      return;
    }

    // 연결에 시간이 걸릴 수 있다
    await interaction.deferReply();

    try {
      await reader.join(voiceChannel);
    } catch (e) {
      await interaction.editReply({
        content: `⚠️ ${e.message}`.slice(0, 1900),
        allowedMentions: { parse: [] },
      });
      return;
    }

    const once = interaction.options.getString('내용');
    if (once) {
      const body = toSpeech(once, { maxChars: settings.maxChars() });
      if (body) {
        const speaker = interaction.member.displayName || interaction.user.username;
        reader.enqueue(interaction.guild.id, body, speaker);
      }
    }

    // 음성 채널의 내장 채팅을 읽는다 — 그 방 사람들끼리 친 채팅만 나간다
    const sameRoom = interaction.channelId === voiceChannel.id;
    const guide = sameRoom
      ? '이 방 채팅창에 쓰면 읽어드릴게요.'
      : `**${voiceChannel.name}** 음성방 안의 채팅창에 써주세요. (음성방을 누르면 오른쪽에 채팅이 열려요)`;

    await interaction.editReply({
      content: `🔊 ${voiceChannel}에 들어왔어요. ${guide}\n그만하려면 \`/그만\`.`,
      allowedMentions: { parse: [] },
    });
  },
};
