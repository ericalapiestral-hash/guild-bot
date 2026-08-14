const { Events } = require('discord.js');
const reader = require('../tts/reader');
const { toSpeech, isSkippable } = require('../tts/text');
const settings = require('../tts/settings');

module.exports = {
  name: Events.MessageCreate,
  async execute(message) {
    if (!message.guild) return; // DM은 읽지 않는다
    if (message.author.bot) return; // 봇끼리 읽어주다 무한루프 나는 걸 방지
    if (message.system) return;

    // 봇이 음성방에 없으면 아무것도 안 한다 (채팅마다 도는 코드라 이 검사를 제일 앞에)
    if (!reader.isActive(message.guild.id)) return;

    // 읽을 채널: /읽기설정으로 못박아둔 곳 > 없으면 /읽어줘를 실행한 채널
    const target = settings.channelId(message.guild.id) || reader.textChannelOf(message.guild.id);
    if (target && message.channelId !== target) return;

    if (isSkippable(message.content)) return;

    // Message Content Intent가 꺼져 있으면 content가 빈 문자열로 온다
    if (!message.content) return;

    const body = toSpeech(message.cleanContent || message.content, {
      maxChars: settings.maxChars(),
    });
    if (!body) return;

    // 화자 이름은 reader가 읽는 시점에 붙인다 (큐에서 순서가 밀릴 수 있어서)
    const speaker = message.member?.displayName || message.author.displayName || message.author.username;
    reader.enqueue(message.guild.id, body, speaker);
  },
};
