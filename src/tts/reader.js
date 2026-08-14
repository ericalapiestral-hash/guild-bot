// 음성 채널 연결 + 읽어주기 큐.
//
// 무료 호스팅(128MB) 제약을 지키려고 정한 규칙:
//  - 길드당 음성 연결 1개, 큐 길이 상한 있음 (넘치면 오래된 걸 버린다)
//  - 오디오는 Ogg/Opus 그대로 흘린다 (inlineVolume 금지 — opus 인코더가 강제된다)
//  - 아무도 없거나 오래 조용하면 알아서 나간다
//
// 비동기 중에 세션이 바뀔 수 있어서(나갔다 다시 들어오기, 건너뛰기) 세션 객체 동일성과
// 세대 번호(gen)를 함께 확인한다. 안 그러면 죽은 세션의 플레이어에 재생이 걸려
// 구독자 0인 채로 전역 오디오 루프에 영원히 남는다.
'use strict';

const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  entersState,
  getVoiceConnection,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  NoSubscriberBehavior,
  StreamType,
} = require('@discordjs/voice');
const { synthesize } = require('./provider');
const { withSpeaker } = require('./text');

/** 대기 중인 문장 최대 개수 — 채팅이 쏟아져도 메모리가 늘지 않게 */
const MAX_QUEUE = 6;
/** 아무 말도 안 읽은 채로 이만큼 지나면 나간다 */
const IDLE_LEAVE_MS = 5 * 60 * 1000;
/** 음성 연결이 준비되기까지 기다리는 시간 */
const READY_TIMEOUT_MS = 20_000;

/** guildId → 세션 */
const sessions = new Map();

function session(guildId) {
  return sessions.get(guildId) || null;
}

function isActive(guildId) {
  return sessions.has(guildId);
}

function armIdleTimer(s) {
  if (s.idleTimer) clearTimeout(s.idleTimer);
  s.idleTimer = setTimeout(() => {
    if (sessions.get(s.guildId) === s) leave(s.guildId, '오래 조용해서');
  }, IDLE_LEAVE_MS);
  s.idleTimer.unref?.();
}

/**
 * 음성 채널에 들어간다. 이미 다른 방에 있으면 그 방으로 옮긴다.
 * @param {import('discord.js').VoiceBasedChannel} channel
 * @param {{textChannelId?: string}} [opts] 읽어줄 텍스트 채널
 */
async function join(channel, { textChannelId } = {}) {
  const guildId = channel.guild.id;
  const existing = session(guildId);

  // 같은 방에 이미 있으면 연결은 그대로 두되 읽을 채널·유휴 타이머는 갱신해야 한다
  if (existing && existing.channelId === channel.id) {
    if (textChannelId) existing.textChannelId = textChannelId;
    armIdleTimer(existing);
    return existing;
  }

  const connection = joinVoiceChannel({
    channelId: channel.id,
    guildId,
    adapterCreator: channel.guild.voiceAdapterCreator,
    selfDeaf: true, // 들을 필요가 없으니 수신을 끈다 (대역폭·CPU 절약)
    selfMute: false,
  });

  const player =
    existing?.player ??
    createAudioPlayer({
      behaviors: { noSubscriber: NoSubscriberBehavior.Pause },
    });

  const s = existing ?? {
    guildId,
    channelId: channel.id,
    textChannelId: textChannelId || null,
    connection,
    player,
    queue: [],
    speaking: false,
    lastSpeaker: null,
    dropped: 0,
    gen: 0,
    idleTimer: null,
  };
  s.connection = connection;
  s.channelId = channel.id;
  if (textChannelId) s.textChannelId = textChannelId;
  sessions.set(guildId, s);

  if (!existing) {
    player.on('error', (e) => console.warn(`[읽기] 재생 오류: ${e.message}`));
    player.on(AudioPlayerStatus.Idle, () => {
      if (sessions.get(guildId) !== s) return;
      s.speaking = false;
      pump(s).catch((e) => console.warn(`[읽기] 큐 처리 실패: ${e.message}`));
    });
  }

  // 끊겼을 때 — 방을 옮긴 것뿐일 수 있으니 잠깐 기다려보고 안 되면 정리한다.
  // 이 커넥션이 아직 현재 세션의 것인지 반드시 확인한다 (그 사이 재입장했을 수 있다).
  const mine = connection;
  connection.on(VoiceConnectionStatus.Disconnected, async () => {
    try {
      await Promise.race([
        entersState(mine, VoiceConnectionStatus.Signalling, 5000),
        entersState(mine, VoiceConnectionStatus.Connecting, 5000),
      ]);
    } catch {
      const current = sessions.get(guildId);
      if (current && current.connection === mine) {
        leave(guildId, '연결이 끊겨서');
      } else {
        try {
          mine.destroy();
        } catch {
          /* 이미 정리됨 */
        }
      }
    }
  });

  try {
    await entersState(connection, VoiceConnectionStatus.Ready, READY_TIMEOUT_MS);
  } catch {
    const current = sessions.get(guildId);
    if (current && current.connection === connection) {
      leave(guildId, '연결 실패');
    } else {
      try {
        connection.destroy();
      } catch {
        /* 이미 정리됨 */
      }
    }
    throw new Error('음성 채널에 연결하지 못했어요. 봇에게 "연결"·"말하기" 권한이 있는지 확인해주세요.');
  }

  connection.subscribe(player);
  armIdleTimer(s);
  return s;
}

/** 음성 채널에서 나간다 */
function leave(guildId, reason) {
  const s = session(guildId);
  sessions.delete(guildId);
  if (s) {
    s.gen += 1; // 진행 중인 합성 결과를 무효화한다
    if (s.idleTimer) clearTimeout(s.idleTimer);
    s.queue.length = 0;
    try {
      s.player.stop(true);
    } catch {
      /* 무시 */
    }
    s.player.removeAllListeners();
  }
  const connection = getVoiceConnection(guildId);
  if (connection) {
    try {
      connection.destroy();
    } catch {
      /* 이미 끊겼으면 무시 */
    }
  }
  if (reason) console.log(`[읽기] 음성방에서 나감 (${reason})`);
}

/** 큐에서 하나 꺼내 읽는다 */
async function pump(s) {
  if (s.speaking || s.queue.length === 0) return;
  if (sessions.get(s.guildId) !== s) return; // 이미 죽은 세션

  const item = s.queue.shift();
  s.speaking = true;
  armIdleTimer(s);

  // 화자 이름은 **읽는 시점에** 정한다. 큐에 넣을 때 정하면 대화가 겹칠 때
  // 다른 사람 말이 앞사람 말로 이어 들린다.
  const line = withSpeaker(item.speaker, item.text, s.lastSpeaker);
  const gen = s.gen;

  try {
    const { stream, format } = await synthesize(line);

    // 합성하는 사이에 나갔거나 건너뛰었으면 버린다 (죽은 플레이어에 재생을 걸면 안 된다)
    if (sessions.get(s.guildId) !== s || s.gen !== gen) {
      s.speaking = false;
      stream.destroy?.();
      return;
    }

    const resource = createAudioResource(stream, {
      inputType: format === 'webm' ? StreamType.WebmOpus : StreamType.OggOpus,
      inlineVolume: false, // ⚠️ true로 두면 opus 인코더가 필요해진다
    });
    s.player.play(resource);
    s.lastSpeaker = item.speaker ?? s.lastSpeaker;
  } catch (e) {
    s.speaking = false;
    s.lastError = e.message;
    console.warn(`[읽기] "${String(item.text).slice(0, 20)}…" 실패: ${e.message}`);
    // 하나 실패했다고 멈추지 않고 다음 걸 시도한다 (세션이 아직 살아 있을 때만)
    if (sessions.get(s.guildId) === s && s.gen === gen && s.queue.length > 0) {
      setImmediate(() => pump(s).catch(() => {}));
    }
  }
}

/**
 * 읽을 문장을 큐에 넣는다. 화자 이름은 읽는 시점에 붙는다.
 * @returns {boolean} 큐에 들어갔는지 (음성방에 없으면 false)
 */
function enqueue(guildId, text, speaker) {
  const s = session(guildId);
  if (!s || !text) return false;

  if (s.queue.length >= MAX_QUEUE) {
    s.queue.shift(); // 오래된 것부터 버린다 — 최신 대화를 따라가는 게 낫다
    s.dropped += 1;
  }
  s.queue.push({ text, speaker });
  pump(s).catch((e) => console.warn(`[읽기] 큐 처리 실패: ${e.message}`));
  return true;
}

/** 지금 읽는 것과 대기 중인 것을 전부 버린다 */
function skipAll(guildId) {
  const s = session(guildId);
  if (!s) return 0;
  const n = s.queue.length;
  s.queue.length = 0;
  s.gen += 1; // 합성 중인 것도 무효화
  s.speaking = false;
  try {
    s.player.stop(true);
  } catch {
    /* 무시 */
  }
  return n;
}

/** 직전에 읽은 사람 */
function lastSpeakerOf(guildId) {
  return session(guildId)?.lastSpeaker ?? null;
}

/** /읽어줘를 실행한 텍스트 채널 */
function textChannelOf(guildId) {
  return session(guildId)?.textChannelId ?? null;
}

/** 봇이 들어가 있는 음성 채널 */
function voiceChannelOf(guildId) {
  return session(guildId)?.channelId ?? null;
}

/** 관리자가 봇을 다른 방으로 끌어다 놓았을 때 세션을 맞춰준다 */
function syncChannel(guildId, channelId) {
  const s = session(guildId);
  if (s && channelId && s.channelId !== channelId) s.channelId = channelId;
}

function statusOf(guildId) {
  const s = session(guildId);
  if (!s) return null;
  return {
    channelId: s.channelId,
    textChannelId: s.textChannelId,
    queued: s.queue.length,
    speaking: s.speaking,
    dropped: s.dropped,
    lastError: s.lastError || null,
  };
}

/** 봇 종료 시 — 음성방에 유령으로 남지 않게 전부 끊는다 */
function destroyAll() {
  for (const guildId of [...sessions.keys()]) leave(guildId, null);
}

module.exports = {
  join,
  leave,
  enqueue,
  skipAll,
  isActive,
  lastSpeakerOf,
  textChannelOf,
  voiceChannelOf,
  syncChannel,
  statusOf,
  destroyAll,
  MAX_QUEUE,
};
