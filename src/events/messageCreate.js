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

    // 봇이 들어가 있는 음성방의 채팅만 읽는다.
    // (디스코드 음성 채널은 자체 텍스트 채팅을 갖고 있고, 그 메시지의 channelId가 음성방 ID다)
    // 채팅마다 도는 코드라 가장 싼 검사를 맨 앞에 둔다.
    const room = reader.voiceChannelOf(message.guild.id);
    if (!room || message.channelId !== room) return;

    if (isSkippable(message.content)) return;

    // Message Content Intent가 꺼져 있으면 content가 빈 문자열로 온다
    if (!message.content) return;

    const body = toSpeech(message.cleanContent || message.content, {
      maxChars: settings.maxChars(),
    });
    if (!body) return;

    // 화자 이름은 reader가 읽는 시점에 붙인다 (큐에서 순서가 밀릴 수 있어서)
    const speaker =
      message.member?.displayName || message.author.displayName || message.author.username;
    reader.enqueue(message.guild.id, body, speaker);
  },
};
