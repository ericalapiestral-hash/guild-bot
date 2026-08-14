// 읽어주기 텍스트 정리 점검. 디스코드·음성 없이 순수 함수만 돌린다.
//   node test/tts.test.js
'use strict';

const assert = require('node:assert');
const { toSpeech, withSpeaker, isSkippable, DEFAULT_MAX } = require('../src/tts/text');

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    console.error(`  ✗ ${name}\n    ${e.message}`);
    process.exitCode = 1;
  }
}

// ─── 기본

test('평범한 문장은 그대로 둔다', () => {
  assert.strictEqual(toSpeech('오늘 공성전 몇 시에 하나요'), '오늘 공성전 몇 시에 하나요');
});

test('빈 내용은 빈 문자열', () => {
  assert.strictEqual(toSpeech(''), '');
  assert.strictEqual(toSpeech('   '), '');
  assert.strictEqual(toSpeech(null), '');
  assert.strictEqual(toSpeech(undefined), '');
});

// ─── 읽으면 곤란한 것들

test('링크는 통째로 읽지 않고 "링크"로 바꾼다', () => {
  assert.strictEqual(
    toSpeech('이거 봐 https://www.notion.so/abc123?x=1 여기'),
    '이거 봐 링크 여기',
  );
});

test('코드 블록과 인라인 코드는 지운다', () => {
  assert.strictEqual(toSpeech('이거 ```const x = 1;\nconsole.log(x)``` 봐줘'), '이거 봐줘');
  assert.strictEqual(toSpeech('명령은 `npm start` 야'), '명령은 야');
});

test('커스텀 이모지는 이름만 남긴다', () => {
  assert.strictEqual(toSpeech('<:pepeLaugh:123456789> ㅋㅋ'), 'pepeLaugh ㅋㅋ');
  assert.strictEqual(toSpeech('<a:dance:987654321> 좋아'), 'dance 좋아');
});

test('유니코드 이모지는 지운다', () => {
  assert.strictEqual(toSpeech('좋아요 👍🔥 갑시다'), '좋아요 갑시다');
});

test('조합(ZWJ) 이모지만 있으면 읽지 않는다', () => {
  // 결합자(U+200D)가 남으면 눈에 안 보이는데 "읽을 게 있다"로 통과해버린다
  assert.strictEqual(toSpeech('👨‍💻'), '');
  assert.strictEqual(toSpeech('🏳️‍🌈'), '');
  assert.strictEqual(toSpeech('❤️‍🔥'), '');
});

test('기호만 남아도 읽지 않는다', () => {
  assert.strictEqual(toSpeech('‼™⌚Ⓜ'), '');
  assert.strictEqual(toSpeech('...'), '');
  assert.strictEqual(toSpeech('→→→'), '');
});

test('글자가 하나라도 있으면 읽는다', () => {
  assert.strictEqual(toSpeech('👨‍💻 코딩중'), '코딩중');
  assert.strictEqual(toSpeech('3'), '3');
});

test('마크다운 장식을 벗긴다', () => {
  assert.strictEqual(toSpeech('**중요** __밑줄__ ~~취소~~ ||스포||'), '중요 밑줄 취소 스포');
  assert.strictEqual(toSpeech('> 인용문이야'), '인용문이야');
  assert.strictEqual(toSpeech('## 제목'), '제목');
});

test('타임스탬프는 "시간"으로', () => {
  assert.strictEqual(toSpeech('<t:1700000000:F> 에 만나'), '시간 에 만나');
});

// ─── 반복 축약

test('길게 늘인 글자를 줄인다', () => {
  assert.strictEqual(toSpeech('ㅋㅋㅋㅋㅋㅋㅋㅋㅋㅋ'), 'ㅋㅋㅋ');
  assert.strictEqual(toSpeech('아니ㅠㅠㅠㅠㅠㅠ'), '아니ㅠㅠㅠ');
  assert.strictEqual(toSpeech('대박!!!!!!!'), '대박!!!');
});

test('3번까지는 그대로 둔다', () => {
  assert.strictEqual(toSpeech('ㅋㅋ'), 'ㅋㅋ');
  assert.strictEqual(toSpeech('ㅋㅋㅋ'), 'ㅋㅋㅋ');
});

// ─── 멘션 (cleanContent가 이미 이름으로 바꿔준 상태를 전제)

test('멘션 접두 기호를 뗀다', () => {
  assert.strictEqual(toSpeech('@밤초 님 보세요'), '밤초 님 보세요');
  assert.strictEqual(toSpeech('#공지 채널 확인'), '공지 채널 확인');
});

test('이메일·해시태그 같은 건 건드리지 않는다', () => {
  assert.ok(toSpeech('a@b.com 으로 보내').includes('a@b.com'));
});

// ─── 길이 제한

test('너무 길면 자르고 표시한다', () => {
  const long = '오늘 공성전 준비물 정리해서 올립니다 '.repeat(30); // 약 600자
  const out = toSpeech(long);
  assert.ok(out.length <= DEFAULT_MAX + 10, `길이 ${out.length}`);
  assert.ok(out.endsWith('이하 생략'), out.slice(-20));
});

test('maxChars를 넘기면 그 길이로 자른다', () => {
  const out = toSpeech('가나다라마바사아자차'.repeat(20), { maxChars: 10 });
  assert.ok(out.startsWith('가나다라마바사아자차'), out);
  assert.ok(out.endsWith('이하 생략'), out);
});

test('같은 글자만 잔뜩 치면 길이 제한 전에 압축된다', () => {
  assert.strictEqual(toSpeech('가'.repeat(500)), '가가가');
});

test('자르는 지점이 글자 한가운데를 쪼개지 않는다', () => {
  // UTF-16 인덱스로 자르면 서로게이트 페어가 반토막 나서 URL 인코딩에서 터진다
  const wide = '𝓪𝓫𝓬𝓭𝓮𝓯𝓰𝓱'.repeat(40); // 전부 non-BMP
  const out = toSpeech(`시작 ${wide}`, { maxChars: 51 });
  assert.ok(out.isWellFormed ? out.isWellFormed() : true, '잘린 서로게이트가 남음');
  assert.doesNotThrow(() => encodeURIComponent(out));
});

test('기본 길이 제한이 걸려 있다', () => {
  assert.strictEqual(typeof DEFAULT_MAX, 'number');
  assert.ok(DEFAULT_MAX > 0 && DEFAULT_MAX <= 300);
});

// ─── 화자 붙이기

test('처음 말한 사람은 이름을 붙인다', () => {
  assert.strictEqual(withSpeaker('밤초', '안녕', null), '밤초, 안녕');
});

test('연달아 말하면 이름을 생략한다', () => {
  assert.strictEqual(withSpeaker('밤초', '또 안녕', '밤초'), '또 안녕');
});

test('다른 사람이 말하면 다시 붙인다', () => {
  assert.strictEqual(withSpeaker('감탱이', '어서와', '밤초'), '감탱이, 어서와');
});

test('읽을 내용이 없으면 빈 문자열', () => {
  assert.strictEqual(withSpeaker('밤초', '', null), '');
});

// ─── 건너뛸 메시지

test('다른 봇 명령어는 건너뛴다', () => {
  assert.ok(isSkippable('!play 노래'));
  assert.ok(isSkippable('/도움말'));
  assert.ok(isSkippable('.ping'));
});

test('평범한 채팅은 안 건너뛴다', () => {
  assert.ok(!isSkippable('오늘 공성 가나요'));
  assert.ok(!isSkippable('ㅋㅋㅋ'));
});

test('빈 메시지는 건너뛴다 (이미지만 올린 경우)', () => {
  assert.ok(isSkippable(''));
  assert.ok(isSkippable('   '));
});

// ─── 실전에서 나올 법한 조합

test('실제 채팅 같은 문장', () => {
  assert.strictEqual(
    toSpeech('@감탱이 ㅋㅋㅋㅋㅋ 이거 봐 https://x.com/a **진짜** 웃김 😂'),
    '감탱이 ㅋㅋㅋ 이거 봐 링크 진짜 웃김',
  );
});

test('전부 걸러지면 빈 문자열 (읽지 않음)', () => {
  assert.strictEqual(toSpeech('😂😂😂'), '');
  assert.strictEqual(toSpeech('```js\ncode\n```'), '');
});

console.log(`\n${passed}개 통과${process.exitCode ? ' (실패 있음)' : ''}`);
