const { Events } = require('discord.js');
const { sendLog, makeEmbed, clamp, userLine } = require('../logger');
const voice = require('../voiceTime');

module.exports = {
  name: Events.VoiceStateUpdate,
  async execute(oldState, newState) {
    const guild = newState.guild || oldState.guild;
    if (!guild) return;

    const member = newState.member || oldState.member;
    if (!member || member.user.bot) return;

    const afkId = guild.afkChannelId;
    // 잠수방은 체류시간에서 뺀다
    const from = oldState.channelId && oldState.channelId !== afkId ? oldState.channelId : null;
    const to = newState.channelId && newState.channelId !== afkId ? newState.channelId : null;

    // 같은 방에서 마이크·헤드셋만 껐다 켠 경우 — 기록할 게 없다
    if (from === to) return;

    const now = Date.now();
    const who = clamp(userLine(member.user), 1000);

    // 나가기 (또는 잠수방으로 이동)
    if (from && !to) {
      const stayed = voice.end(member.id, now);
      const embed = makeEmbed('음성', '🔇 음성방 나감')
        .addFields({ name: '멤버', value: who })
        .addFields({ name: '방', value: `<#${from}>` });
      if (stayed > 0) {
        embed.addFields({ name: '머문 시간', value: voice.formatDuration(stayed) });
      }
      if (newState.channelId === afkId) {
        embed.addFields({ name: '참고', value: '잠수방으로 이동 (시간 집계 제외)' });
      }
      await sendLog(guild, embed);
      return;
    }

    // 들어오기
    if (!from && to) {
      voice.begin(member.id, to, now);
      await sendLog(
        guild,
        makeEmbed('음성', '🔊 음성방 들어옴')
          .addFields({ name: '멤버', value: who })
          .addFields({ name: '방', value: `<#${to}>` }),
      );
      return;
    }

    // 방 이동 — 지금까지 머문 시간을 적립하고 새로 시작
    const stayed = voice.end(member.id, now);
    voice.begin(member.id, to, now);
    const embed = makeEmbed('음성', '🔀 음성방 이동')
      .addFields({ name: '멤버', value: who })
      .addFields({ name: '이동', value: `<#${from}> → <#${to}>` });
    if (stayed > 0) {
      embed.addFields({ name: '이전 방에 머문 시간', value: voice.formatDuration(stayed) });
    }
    await sendLog(guild, embed);
  },
};
