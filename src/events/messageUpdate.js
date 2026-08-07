const { Events } = require('discord.js');
const { sendLog, makeEmbed, clamp, userLine, isLogChannel } = require('../logger');

module.exports = {
  name: Events.MessageUpdate,
  async execute(oldMessage, newMessage) {
    const guild = (newMessage && newMessage.guild) || (oldMessage && oldMessage.guild);
    if (!guild) return;
    if (isLogChannel(newMessage.channelId)) return;
    if (newMessage.author && newMessage.author.bot) return;

    // 링크 미리보기가 붙어도 update 이벤트가 온다 — 내용이 그대로면 무시
    const before = oldMessage && !oldMessage.partial ? (oldMessage.content ?? '') : null;
    const after = newMessage && !newMessage.partial ? (newMessage.content ?? '') : '';
    if (before !== null && before === after) return;

    const embed = makeEmbed('수정', '✏️ 메시지 수정됨')
      .addFields({ name: '채널', value: `<#${newMessage.channelId}>` })
      .addFields({
        name: '수정 전',
        value: before === null ? '*(봇이 켜지기 전 내용이라 알 수 없어요)*' : clamp(before, 1000) || '*(내용 없음)*',
      })
      .addFields({ name: '수정 후', value: clamp(after, 1000) || '*(내용 없음)*' });

    if (newMessage.author) {
      embed.addFields({ name: '작성자', value: clamp(userLine(newMessage.author), 1000) });
    }
    if (newMessage.url) {
      embed.addFields({ name: '바로가기', value: newMessage.url });
    }

    await sendLog(guild, embed);
  },
};
