const { Events } = require('discord.js');
const { sendLog, makeEmbed, clamp, userLine, isLogChannel } = require('../logger');

module.exports = {
  name: Events.MessageDelete,
  async execute(message) {
    if (!message.guild) return; // DM은 기록하지 않는다
    if (isLogChannel(message.channelId)) return; // 로그 채널 자체는 제외

    const embed = makeEmbed('삭제', '🗑️ 메시지 삭제됨').addFields({
      name: '채널',
      value: `<#${message.channelId}>`,
    });

    // 봇 캐시에 없던 오래된 메시지는 작성자·내용을 알 수 없다
    if (message.partial || !message.author) {
      embed.setDescription('*(봇이 켜지기 전 메시지라 작성자와 내용을 알 수 없어요)*');
      await sendLog(message.guild, embed);
      return;
    }

    if (message.author.bot) return; // 봇 메시지는 소음이라 제외

    embed.addFields({ name: '작성자', value: clamp(userLine(message.author), 1000) });

    const content = message.content && message.content.trim();
    embed.setDescription(
      content
        ? clamp(content, 3800)
        : '*(텍스트 없음 — 이미지·스티커만 있었거나 내용을 읽을 수 없어요)*',
    );

    if (message.attachments && message.attachments.size > 0) {
      embed.addFields({
        name: `첨부 ${message.attachments.size}개`,
        value: clamp(
          [...message.attachments.values()].map((a) => a.name || a.url).join('\n'),
          1000,
        ),
      });
    }

    if (message.createdAt) {
      embed.addFields({
        name: '작성 시각',
        value: `<t:${Math.floor(message.createdTimestamp / 1000)}:f>`,
      });
    }

    await sendLog(message.guild, embed);
  },
};
