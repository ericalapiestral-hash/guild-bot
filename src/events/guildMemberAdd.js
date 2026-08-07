const { Events } = require('discord.js');
const store = require('../store');
const { sendLog, makeEmbed, clamp, userLine } = require('../logger');

/** 자동역할 부여 결과를 로그에 함께 적는다 */
async function applyAutoRole(member) {
  const roleId = store.get('autoRoleId');
  if (!roleId) return null;

  const role =
    member.guild.roles.cache.get(roleId) ??
    (await member.guild.roles.fetch(roleId).catch(() => null));
  if (!role) {
    console.warn(`[자동역할] 설정된 역할(${roleId})을 찾을 수 없어요. /자동역할 설정으로 다시 지정해주세요.`);
    return '설정된 역할을 찾을 수 없어요';
  }

  try {
    await member.roles.add(role, '입장 자동 역할 부여');
    console.log(`[자동역할] ${member.user.tag} → ${role.name} 부여 완료`);
    return `**${role.name}** 부여 완료`;
  } catch (error) {
    console.error(`[자동역할] ${member.user.tag}에게 부여 실패:`, error.message);
    return `**${role.name}** 부여 실패 — ${error.message}`;
  }
}

module.exports = {
  name: Events.GuildMemberAdd,
  async execute(member) {
    if (member.user.bot) return;

    const autoRole = await applyAutoRole(member);

    const embed = makeEmbed('입장', '🎉 서버 들어옴').addFields({
      name: '멤버',
      value: clamp(userLine(member.user), 1000),
    });
    if (member.user.createdTimestamp) {
      embed.addFields({
        name: '계정 만든 날',
        value: `<t:${Math.floor(member.user.createdTimestamp / 1000)}:D>`,
      });
    }
    if (autoRole) embed.addFields({ name: '자동역할', value: clamp(autoRole, 1000) });

    await sendLog(member.guild, embed);
  },
};
