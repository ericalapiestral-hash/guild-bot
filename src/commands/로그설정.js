const {
  SlashCommandBuilder,
  PermissionFlagsBits,
  MessageFlags,
  InteractionContextType,
  ChannelType,
} = require('discord.js');
const store = require('../store');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('로그설정')
    .setDescription('메시지·음성·입퇴장 로그를 남길 채널을 관리합니다.')
    .addSubcommand((sub) =>
      sub
        .setName('설정')
        .setDescription('로그를 남길 채널을 지정합니다.')
        .addChannelOption((option) =>
          option
            .setName('채널')
            .setDescription('로그가 쌓일 채널')
            .addChannelTypes(ChannelType.GuildText)
            .setRequired(true),
        ),
    )
    .addSubcommand((sub) => sub.setName('해제').setDescription('로그 기록을 끕니다.'))
    .addSubcommand((sub) => sub.setName('확인').setDescription('현재 로그 설정을 확인합니다.'))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setContexts(InteractionContextType.Guild),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();

    if (sub === '설정') {
      const channel = interaction.options.getChannel('채널');

      const me = interaction.guild.members.me;
      const perms = channel.permissionsFor(me);
      const missing = [];
      if (!perms?.has(PermissionFlagsBits.ViewChannel)) missing.push('채널 보기');
      if (!perms?.has(PermissionFlagsBits.SendMessages)) missing.push('메시지 보내기');
      if (!perms?.has(PermissionFlagsBits.EmbedLinks)) missing.push('링크 첨부');
      if (missing.length > 0) {
        return interaction.reply({
          content: `${channel}에 봇 권한이 부족해요: **${missing.join(', ')}**\n권한을 준 뒤 다시 설정해주세요.`,
          flags: MessageFlags.Ephemeral,
        });
      }

      store.set('logChannelId', channel.id);
      return interaction.reply({
        content: `✅ 이제 ${channel}에 로그를 남겨요.\n· 삭제·수정된 메시지\n· 음성방 입장·퇴장·이동\n· 서버 입장·탈퇴`,
      });
    }

    if (sub === '해제') {
      if (!store.get('logChannelId')) {
        return interaction.reply({
          content: '로그 채널이 설정되어 있지 않아요.',
          flags: MessageFlags.Ephemeral,
        });
      }
      store.set('logChannelId', null);
      return interaction.reply({ content: '로그 기록을 껐어요. (음성 시간 집계는 계속됩니다)' });
    }

    const id = store.get('logChannelId');
    return interaction.reply({
      content: id
        ? `현재 로그 채널: <#${id}>`
        : '로그 채널이 설정되어 있지 않아요. `/로그설정 설정`으로 지정할 수 있어요.',
      flags: MessageFlags.Ephemeral,
      allowedMentions: { parse: [] },
    });
  },
};
