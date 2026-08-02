const fs = require('node:fs');
const path = require('node:path');
const { Events, REST, Routes } = require('discord.js');

module.exports = {
  name: Events.ClientReady,
  once: true,
  async execute(client) {
    console.log(`로그인 완료: ${client.user.tag}`);

    // 시작할 때마다 슬래시 명령을 자동 등록 —
    // 봇을 서버에서 내보냈다 다시 초대하면 길드 명령이 전부 지워지는데,
    // 이렇게 하면 봇이 켜질 때 스스로 복구한다. (npm run deploy를 따로 안 돌려도 됨)
    try {
      const guildId = (process.env.GUILD_ID || '').trim();
      if (!guildId) {
        console.warn('[명령 등록] GUILD_ID가 없어 자동 등록을 건너뜁니다.');
        return;
      }
      const commands = [];
      const commandsPath = path.join(__dirname, '..', 'commands');
      for (const file of fs.readdirSync(commandsPath).filter((f) => f.endsWith('.js'))) {
        const command = require(path.join(commandsPath, file));
        if (command.data) commands.push(command.data.toJSON());
      }
      const rest = new REST().setToken(client.token);
      const res = await rest.put(
        Routes.applicationGuildCommands(client.application.id, guildId),
        { body: commands },
      );
      console.log(`[명령 등록] 슬래시 명령 ${res.length}개 자동 등록 완료`);
    } catch (error) {
      console.error('[명령 등록] 자동 등록 실패:', error.message);
    }
  },
};
