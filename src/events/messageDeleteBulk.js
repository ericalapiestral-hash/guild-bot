const { Events } = require('discord.js');
const { sendLog, makeEmbed, clamp, isLogChannel } = require('../logger');

module.exports = {
  name: Events.MessageBulkDelete,
  async execute(messages, channel) {
    const guild = channel && channel.guild;
    if (!guild) return;
    if (isLogChannel(channel.id)) return;

    // /청소 명령은 스스로 자세한 로그를 남기므로 여기서는 요약만 남긴다
    const authors = new Map();
    for (const m of messages.values()) {
      if (m.partial || !m.author) continue;
      authors.set(m.author.id, (authors.get(m.author.id) || 0) + 1);
    }

    const embed = makeEmbed('삭제', `🧹 메시지 ${messages.size}개 일괄 삭제됨`).addFields({
      name: '채널',
      value: `<#${channel.id}>`,
    });

    if (authors.size > 0) {
      const lines = [...authors.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 15)
        .map(([id, n]) => `<@${id}> — ${n}개`);
      embed.addFields({ name: '작성자별', value: clamp(lines.join('\n'), 1000) });
    }

    await sendLog(guild, embed);
  },
};
