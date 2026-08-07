const { Events } = require('discord.js');
const { sendLog, makeEmbed, clamp, userLine } = require('../logger');
const voice = require('../voiceTime');

module.exports = {
  name: Events.GuildMemberRemove,
  async execute(member) {
    if (!member.guild) return;

    // 통화 중에 나갔으면 그때까지의 시간은 적립해준다
    if (voice.isActive(member.id)) voice.end(member.id);

    const embed = makeEmbed('퇴장', '👋 서버 나감').addFields({
      name: '멤버',
      value: clamp(userLine(member.user), 1000),
    });

    if (member.joinedTimestamp) {
      embed.addFields({
        name: '들어온 날',
        value: `<t:${Math.floor(member.joinedTimestamp / 1000)}:D>`,
      });
    }

    const roles = member.roles?.cache?.filter((r) => r.id !== member.guild.id);
    if (roles && roles.size > 0) {
      embed.addFields({
        name: '가지고 있던 역할',
        value: clamp([...roles.values()].map((r) => r.name).join(', '), 1000),
      });
    }

    await sendLog(member.guild, embed);
  },
};
