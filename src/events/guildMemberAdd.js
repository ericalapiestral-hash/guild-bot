const { Events } = require('discord.js');
const store = require('../store');

module.exports = {
  name: Events.GuildMemberAdd,
  async execute(member) {
    const roleId = store.get('autoRoleId');
    if (!roleId) return;
    if (member.user.bot) return;

    const role =
      member.guild.roles.cache.get(roleId) ??
      (await member.guild.roles.fetch(roleId).catch(() => null));
    if (!role) {
      console.warn(`[자동역할] 설정된 역할(${roleId})을 찾을 수 없어요. /자동역할 설정으로 다시 지정해주세요.`);
      return;
    }

    try {
      await member.roles.add(role, '입장 자동 역할 부여');
      console.log(`[자동역할] ${member.user.tag} → ${role.name} 부여 완료`);
    } catch (error) {
      console.error(`[자동역할] ${member.user.tag}에게 부여 실패:`, error.message);
    }
  },
};
