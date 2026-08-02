const {
  SlashCommandBuilder,
  PermissionFlagsBits,
  MessageFlags,
  InteractionContextType,
} = require('discord.js');
const store = require('../store');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('자동역할')
    .setDescription('새로 들어오는 멤버에게 자동으로 줄 역할을 관리합니다.')
    .addSubcommand((sub) =>
      sub
        .setName('설정')
        .setDescription('자동으로 부여할 역할을 설정합니다.')
        .addRoleOption((option) =>
          option.setName('역할').setDescription('입장 시 자동으로 줄 역할').setRequired(true),
        ),
    )
    .addSubcommand((sub) => sub.setName('해제').setDescription('자동 역할 부여를 끕니다.'))
    .addSubcommand((sub) => sub.setName('확인').setDescription('현재 자동역할 설정을 확인합니다.'))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles)
    .setContexts(InteractionContextType.Guild),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();

    if (sub === '설정') {
      const role = interaction.options.getRole('역할');

      if (role.id === interaction.guild.id) {
        return interaction.reply({
          content: '@everyone은 자동역할로 설정할 수 없어요.',
          flags: MessageFlags.Ephemeral,
        });
      }
      if (role.managed) {
        return interaction.reply({
          content: `**${role.name}** 역할은 봇/연동 전용 역할이라 부여할 수 없어요.`,
          flags: MessageFlags.Ephemeral,
        });
      }
      const botHighest = interaction.guild.members.me.roles.highest;
      if (role.position >= botHighest.position) {
        return interaction.reply({
          content: `**${role.name}** 역할이 봇의 최고 역할보다 높거나 같아서 부여할 수 없어요. 서버 설정 → 역할에서 봇 역할을 더 위로 올려주세요.`,
          flags: MessageFlags.Ephemeral,
        });
      }

      store.set('autoRoleId', role.id);
      return interaction.reply({
        content: `✅ 이제 새로 들어오는 멤버에게 **${role.name}** 역할을 자동으로 부여해요.`,
      });
    }

    if (sub === '해제') {
      if (!store.get('autoRoleId')) {
        return interaction.reply({
          content: '자동역할이 설정되어 있지 않아요.',
          flags: MessageFlags.Ephemeral,
        });
      }
      store.set('autoRoleId', null);
      return interaction.reply({ content: '자동 역할 부여를 껐어요.' });
    }

    // 확인
    const roleId = store.get('autoRoleId');
    if (!roleId) {
      return interaction.reply({
        content: '자동역할이 설정되어 있지 않아요. `/자동역할 설정`으로 지정할 수 있어요.',
        flags: MessageFlags.Ephemeral,
      });
    }
    const role = interaction.guild.roles.cache.get(roleId);
    return interaction.reply({
      content: role
        ? `현재 자동역할: **${role.name}**`
        : `설정된 역할(ID: ${roleId})이 서버에서 삭제된 것 같아요. \`/자동역할 설정\`으로 다시 지정해주세요.`,
      flags: MessageFlags.Ephemeral,
    });
  },
};
