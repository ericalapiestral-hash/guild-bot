# CLAUDE.md — 길드봇

> 이 파일은 포맷으로 날아간 대화 기록을 대신해, 저장소 현재 상태(README·git 로그·소스 구조)에서 복원한 프로젝트 맥락입니다. 사실과 다른 부분이 있으면 바로 고쳐 주세요.

## 이 프로젝트가 뭔가

낭만주의 길드 전용 **디스코드 봇**. 세븐나이츠 리버스 길드 운영 도구다.

패키지명 `guild-bot`. Node >= 18.

## 스택

discord.js 14 + @discordjs/voice + dotenv. 빌드 도구 없음, 순수 CommonJS/Node.

## 명령어

```bash
npm install
npm start             # 봇 실행 (슬래시 명령은 시작할 때 자동 등록)
npm test              # 파서·검색 자체 점검 (builds/notion/voice/tts)
npm run notion:dump   # 노션에서 읽은 원본을 data/notion-dump.md로 저장
npm run deploy        # 슬래시 명령 수동 등록 (보통 불필요)
npm run release       # 배포용 exe·apk를 release/ 한 곳에 모은다
```

## 배포 (release/)

`npm run release` 하나만 돌리면 `release/`를 비우고 최신본으로 다시 채운다.
**이름이 항상 같아서** 받아 둔 파일이 어느 버전인지 헷갈리지 않는다 —
대신 `release/버전.txt`에 커밋 해시와 만든 시각을 적어 둔다.

```
release/
  guild-overlay-pc.exe        ← 스크립트가 그 자리에서 빌드한다
  guild-overlay-android.apk   ← CI에서 받아 둔 것을 찾아서 넣는다
  버전.txt
```

- **APK는 로컬에서 못 만든다** (Android SDK가 없다). GitHub Actions에서 받아
  다운로드 폴더나 `release-src/`에 두면 스크립트가 알아서 집어 온다.
  경로를 직접 주려면 `npm run release -- --apk "경로"`.
- exe는 그대로 두고 APK만 갈아끼우려면 `npm run release -- --skip-exe`.
- `release/`는 커밋하지 않는다 (산출물).

## 기능 · 슬래시 명령

| 명령어 | 설명 | 권한 |
|---|---|---|
| `/파괴신 빌드:…` | 파괴신 빌드 찾기 | — |
| `/공성전 요일:수 빌드:…` | 공성전 빌드 (요일 필터) | — |
| `/통계 공성전 [요일] [주차]` | 공성전 순위표 | — |
| `/통계 파괴신 [시즌]` | 파괴신 순위표 | — |
| `/음성 시간 [멤버]` · `/음성 순위 [기간]` | 음성방 체류시간 | — |
| `/읽어줘 [내용]` · `/그만` · `/읽기상태` | TTS 읽어주기 | — |
| `/청소 개수 [멤버] [사유]` | 메시지 삭제 (최대 1000) | 메시지 관리 |
| `/로그설정 설정\|해제\|확인` | 로그 채널 | 서버 관리 |
| `/빌드갱신` | 노션 도감 재로딩 | 서버 관리 |
| `/자동역할 설정\|해제\|확인` | 입장 자동역할 | 역할 관리 |

빌드 검색은 자동완성 + **초성(`ㅍㅇㅅㅇ`)** + **띄어쓰기 무시(`파이세인4턴`)** 를 지원한다.

## 구조

```
src/
  index.js            진입점 — 클라이언트 · 자동 로딩
  deploy-commands.js  슬래시 명령 등록
  store.js            설정 저장 get/set → config.json
  logger.js           서버 로그
  notion.js           노션 도감 읽기 (21KB)
  dump-notion.js      도감 원본 덤프
  builds.js           빌드 색인 · 검색 (20KB — 초성/공백무시 매칭)
  buildLookup.js  buildEmbed.js
  statsApi.js         길드 사이트 통계 API 연동
  voiceTime.js        음성 체류시간 집계
  commands/           공성전 파괴신 통계 음성 읽어줘 그만 읽기상태
                      청소 로그설정 빌드갱신 자동역할
  events/             ready messageCreate messageUpdate messageDelete
                      messageDeleteBulk guildMemberAdd guildMemberRemove
                      voiceStateUpdate
  tts/                provider.js reader.js text.js settings.js
overlay/              PC 게임 오버레이 (별도 Electron 앱, 자체 package.json)
data/                 voice.json  builds.json (캐시, 커밋 안 함)
test/
```

**기능 추가는 파일만 놓으면 자동 로드된다.**

- 명령어: `src/commands/`에 `data`(SlashCommandBuilder) + `execute` 내보내기. 자동완성 쓰면 `autocomplete`도.
- 이벤트: `src/events/`에 `name`(Events.~) + `execute` 내보내기
- 설정 저장: `src/store.js`의 `get`/`set`

**명령어 파일명은 한국어**(`공성전.js`, `읽어줘.js`) — 슬래시 명령 이름과 맞춘 관례다.

## 노션 도감 구조

```
PVE 구분 (DB)
├─ 공성전        → 공성전 리스트 (DB) → 빌드 행들   ← /공성전
├─ 강림 - 파괴신  → 파괴신 구분 (DB)  → 빌드 행들   ← /파괴신
├─ 강림 - 구사황  → (DB)                            (아직 명령어 없음)
└─ 기타          → (DB)                            (아직 명령어 없음)
```

- 데이터베이스 **3중 구조**. 바깥 DB의 행이 묶음, 안쪽 DB의 행이 빌드.
- **카테고리**는 묶음 이름에 `공성전`/`파괴신`이 들어 있으면 붙는다. 없으면 색인에는 남지만 검색은 안 된다.
- **요일**은 빌드 이름 앞부분에서 읽는다 (`월요일 - 루디 / 쥬리…` → 월). `월·목요일`, `월~수요일` 표기도 인식.
- **본문**은 빌드 행 페이지를 통째로 마크다운으로 변환 (헤딩·불릿·콜아웃·표).
- 헤딩만으로 된 페이지도 예비 경로로 지원 — DB가 하나도 없으면 헤딩 기준으로 자른다.
- 시작 시 1회 + 30분마다 재로딩. 즉시 반영은 `/빌드갱신`.
- 결과는 `data/builds.json`에 캐시 — 노션이 막혀도 마지막 내용으로 계속 답한다. **캐시는 커밋하지 않는다.**

> 노션 연동 시 **도감 페이지에서 `•••` → 연결(Connections) → 만든 내부 연결 추가**를 빠뜨리면 토큰이 맞아도 404가 난다. 부모 페이지에 추가하면 하위로 상속된다.

## TTS 읽어주기

봇은 TTS 엔진을 갖고 있지 않다. `.env`로 둘 중 하나를 붙인다.

```
# ① 로컬 프로그램
TTS_COMMAND=piper --model ko_KR.onnx --output_file {{out}}
# ② HTTP
TTS_URL=http://localhost:5000/tts?text={{text}}
TTS_METHOD=POST
TTS_HEADERS={"Content-Type":"application/json"}
TTS_BODY={"text":"{{text}}","format":"ogg_opus"}
```

- `{{out}}` 있으면 임시 파일 경로를 넣고 끝난 뒤 읽는다. 없으면 표준출력을 오디오로 받는다.
- 문장은 기본 **표준입력**으로, `{{text}}`를 쓰면 인자로 넘어간다.
- **셸을 거치지 않는다** — 채팅에 명령어를 심어도 실행되지 않는다. 이 설계를 깨지 말 것.
- ⚠️ **결과는 반드시 Ogg/Opus(48kHz)여야 한다.** MP3/WAV를 주면 ffmpeg이 필요해지고, 무료 호스팅 128MB에서 메모리가 터진다. 형식이 틀리면 재생하지 않고 무슨 형식을 받았는지 알려준다.
- 읽는 범위는 **그 음성방 자체의 채팅창만**. 다른 텍스트 채널은 읽지 않는다.
- 전처리: 링크·코드블록·이모지 제거, 늘인 글자(`ㅋㅋㅋㅋ`) 축약, 150자 초과 자르기, 같은 사람 연속이면 이름 한 번만.
- 방에 아무도 없거나 5분 조용하면 자동 퇴장.
- 신경망 TTS 모델은 무료 호스팅에서 못 돌린다 — PC 실행이거나 ② 방식이어야 한다.

## 알아둘 것

- **디스코드 인텐트 2개** 필요: Server Members Intent(자동역할·입퇴장 로그), Message Content Intent(메시지 내용 로그 + 채팅 자동 읽기). 후자가 꺼져 있어도 봇은 돌아가되 "내용을 알 수 없어요"로만 남고, TTS는 `/읽어줘 내용:…` 직접 입력만 된다.
- 봇 역할을 **부여할 역할들보다 위로** 올려야 자동역할이 동작한다.
- **14일 지난 메시지는 지울 수 없다** (디스코드 API 제한, 우회 불가). 그 벽에 닿으면 멈추고 몇 개 남았는지 알려준다. 고정 메시지는 건드리지 않는다. 채널을 통째로 비울 땐 **채널 복제 후 원본 삭제**가 빠르다.
- `/청소`는 최대 1000개 — 디스코드가 100개씩만 지워서 내부적으로 나눠 돌린다.
- 음성 시간은 `data/voice.json`에 쌓이고 **재배포하면 사라질 수 있다.** 봇이 꺼진 동안은 집계 안 되고, 잠수(AFK) 채널은 뺀다. 주간 기록은 **한국시간 월요일 0시** 초기화.
- 슬래시 명령은 시작 시 자동 등록된다 — 추방→재초대로 명령이 지워져도 자가 복구된다.

## 호스팅

[디스호스트](https://dishost.kr/) 무료 플랜 24시간 구동. Git URL(`https://github.com/ericalapiestral-hash/guild-bot.git`)로 배포, 환경변수는 패널에서 설정.

> ⚠️ **7일마다 대시보드에서 연장 버튼**을 눌러야 인스턴스가 유지된다.

## 오버레이 — PC (overlay/) · 안드로이드 (android/)

게임 위에 띄우는 빌드 오버레이. 도감의 스킬 순서를 3개씩 보여주고, 게임 화면의 턴 숫자를 OCR로 읽어 자동으로 다음 단계로 넘긴다. **두 벌이 같은 파서를 쓴다** — `overlay/lib/steps.js` ↔ `android/…/Steps.kt`. 한쪽을 고치면 다른 쪽도 고치고, 테스트도 양쪽에 있다.

**PC (Electron)**

- Ctrl+Alt+R 턴 위치 지정 · Ctrl+Alt+O 숨기기 · Ctrl+Alt+L 클릭 통과 · Ctrl+Alt+←→ 수동 이동
- 자동 모드는 700ms마다 지정 영역을 읽는다. 첫 실행은 인식 엔진 다운로드로 1분쯤.
- `data/builds.json`을 직접 읽으므로 구사황·기타 묶음도 전부 보인다.
- 게임은 **테두리 없는 창모드**여야 한다.
- **배포용 exe**: `cd overlay && npm run dist` → `dist/guild-overlay-0.1.0.exe` (포터블 76MB, 설치 불필요).
  CI로도 만든다 (`.github/workflows/windows.yml`).
  - 도감을 찾는 순서: 앱에서 고른 경로 → **exe 옆 `data/builds.json`** → exe 옆 `builds.json` → 안에 넣어 둔 스냅샷.
    포장할 때 그 시점의 `data/builds.json`이 같이 들어간다(CI 빌드에는 없다 — 캐시를 커밋하지 않으므로).
  - 포장하면 `__dirname`이 `app.asar` 안이 된다. 도감 경로와 인식 캐시(`userData/ocr-cache`)를 그래서 따로 잡는다 —
    **상대경로로 되돌리지 말 것.** tesseract는 `asarUnpack`으로 빼 둬야 워커가 뜬다.
  - 윈도우에서 `npm run dist`가 winCodeSign 심볼릭 링크 오류로 멈추면, 그 캐시 폴더에
    macOS 부분을 뺀 채(`-xr'!darwin'`) 직접 풀어 두면 지나간다. 개발자 모드를 켜도 된다.
  - 정리는 **`npm run clean`** (`-- --keep dist4` 처럼 하나만 남길 수 있다). 백신이 갓 만든
    `app.asar`를 붙들고 있으면 `rm -rf`는 그 하나 때문에 통째로 실패한다 — 이 스크립트는
    지울 수 있는 것부터 지우고 남은 것만 알려준다.
- **턴 인식은 메인 프로세스에서 돈다.** `nodeIntegration`이 켜져 있어 tesseract가 Node 빌드를
  고르는데, Electron 렌더러는 Node 워커(`worker_threads`)를 지원하지 않아 렌더러에서 띄우면
  "does not support creating Workers"로 죽는다. 캡처·전처리만 렌더러(캔버스 필요)에 두고
  인식은 `ocr:recognize` IPC로 넘긴다 — **렌더러로 되돌리지 말 것.**

**안드로이드 (Kotlin)** — 자세한 건 [android/README.md](android/README.md)

- 전역 단축키가 없어 창에 버튼을 달았다. 캡처는 MediaProjection, 인식은 APK에 들어 있는 ML Kit(다운로드 없음).
- 도감은 파일에서 직접 못 읽는다 — 앱에서 `builds.json`을 한 번 불러와 앱 안에 복사해 쓴다.
- **APK는 GitHub Actions가 만든다** (`.github/workflows/android.yml`). 로컬에 Android SDK가 없어도 Actions → Artifacts에서 받으면 된다.
- 최소 안드로이드 8.0. 자동 인식은 켤 때마다 시스템 동의창이 한 번 뜬다.
- iOS는 오버레이가 불가능하다 — 봇 명령어로 커버.

## 최근 작업 흐름 (git 로그 기준, 최신순)

안드로이드 오버레이 APK → 읽어주기: 음성방 자체 채팅만 읽기 + 로컬 TTS 실행 지원 → 채팅 TTS 추가 → PC 빌드 오버레이 추가 → /청소 상한 1000 → 서버 로그·음성 시간·청소 → 노션 DB 구조 지원 → 도감 코드 리뷰 25건 수정 → 노션 도감 연동
