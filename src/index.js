require('dotenv').config();
const fs = require('node:fs');
const path = require('node:path');
const {
  Client,
  Collection,
  GatewayIntentBits,
  Partials,
  Events,
  MessageFlags,
} = require('discord.js');
const voice = require('./voiceTime');

/** 메시지 내용 없이도 돌아가는 최소 인텐트 */
const BASE_INTENTS = [
  GatewayIntentBits.Guilds,
  GatewayIntentBits.GuildMembers,
  GatewayIntentBits.GuildMessages,
  GatewayIntentBits.GuildVoiceStates,
];

/**
 * 캐시에 없던 메시지·멤버도 이벤트를 받으려면 partial을 켜야 한다.
 * (안 켜면 오래된 메시지 삭제는 아예 감지되지 않는다)
 */
const PARTIALS = [Partials.Message, Partials.Channel, Partials.GuildMember, Partials.User];

function loadModules(dir) {
  const full = path.join(__dirname, dir);
  if (!fs.existsSync(full)) return [];
  return fs
    .readdirSync(full)
    .filter((f) => f.endsWith('.js'))
    .map((f) => ({ file: f, mod: require(path.join(full, f)) }));
}

function createClient(intents) {
  const client = new Client({ intents, partials: PARTIALS });

  // src/commands 폴더의 명령어 자동 로드
  client.commands = new Collection();
  for (const { file, mod } of loadModules('commands')) {
    if (mod.data && mod.execute) {
      client.commands.set(mod.data.name, mod);
    } else {
      console.warn(`[경고] commands/${file}에 data 또는 execute가 없어 건너뜁니다.`);
    }
  }

  // src/events 폴더의 이벤트 핸들러 자동 로드
  for (const { file, mod } of loadModules('events')) {
    if (!mod.name || !mod.execute) {
      console.warn(`[경고] events/${file}에 name 또는 execute가 없어 건너뜁니다.`);
      continue;
    }
    const run = async (...args) => {
      try {
        await mod.execute(...args);
      } catch (error) {
        console.error(`[오류] ${mod.name} 처리 중:`, error);
      }
    };
    if (mod.once) client.once(mod.name, run);
    else client.on(mod.name, run);
  }

  client.on(Events.InteractionCreate, async (interaction) => {
    // 자동완성은 별도 인터랙션 타입 — 3초 안에 respond()로만 답할 수 있고 오류 메시지를 보낼 수 없다.
    if (interaction.isAutocomplete()) {
      const command = client.commands.get(interaction.commandName);
      if (!command || !command.autocomplete) return;
      try {
        await command.autocomplete(interaction);
      } catch (error) {
        console.error(`[오류] /${interaction.commandName} 자동완성:`, error);
        await interaction.respond([]).catch(() => {});
      }
      return;
    }

    if (!interaction.isChatInputCommand()) return;

    const command = client.commands.get(interaction.commandName);
    if (!command) return;

    try {
      await command.execute(interaction);
    } catch (error) {
      console.error(`[오류] /${interaction.commandName} 실행 중:`, error);
      const reply = { content: '명령어 실행 중 오류가 발생했어요.', flags: MessageFlags.Ephemeral };
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp(reply).catch(() => {});
      } else {
        await interaction.reply(reply).catch(() => {});
      }
    }
  });

  client.on(Events.Error, (e) => console.error('[디스코드]', e.message));

  return client;
}

/** 특권 인텐트가 꺼져 있어서 로그인이 거부된 경우인지 */
function isDisallowedIntents(error) {
  return (
    error &&
    (error.code === 'DisallowedIntents' ||
      /disallowed intents|privileged intent/i.test(String(error.message)))
  );
}

let current = null;

async function login(intents, withContent) {
  const client = createClient(intents);
  try {
    await client.login(process.env.DISCORD_TOKEN);
    current = client;
    if (!withContent) {
      console.warn(
        '[경고] Message Content Intent가 꺼져 있어 삭제·수정된 메시지의 **내용**은 기록되지 않아요.\n' +
          '        개발자 포털 → Bot → Message Content Intent를 켜고 봇을 다시 시작하면 내용까지 남아요.',
      );
    }
    return client;
  } catch (e) {
    await client.destroy().catch(() => {});
    throw e;
  }
}

(async () => {
  try {
    await login([...BASE_INTENTS, GatewayIntentBits.MessageContent], true);
  } catch (e) {
    if (!isDisallowedIntents(e)) {
      console.error('로그인 실패:', e.message);
      process.exit(1);
    }
    // 내용 없이라도 봇이 돌아가게 한다 — 인텐트 하나 때문에 봇 전체가 죽으면 안 된다
    console.warn('[경고] 특권 인텐트가 거부됐어요. 메시지 내용 없이 다시 접속합니다.');
    try {
      await login(BASE_INTENTS, false);
    } catch (e2) {
      console.error('로그인 실패:', e2.message);
      process.exit(1);
    }
  }
})();

/** 종료할 때 진행 중인 통화 시간을 저장하고 나간다 */
let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n${signal} — 정리하고 종료합니다.`);
  try {
    voice.flushAll();
  } catch (e) {
    console.warn('[음성] 종료 시 저장 실패:', e.message);
  }
  const done = () => process.exit(0);
  if (current) current.destroy().then(done, done);
  else done();
  setTimeout(done, 5000).unref?.();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
