# 길드봇

길드 전용 디스코드 봇. 기능은 하나씩 추가 예정.

## 현재 기능

**입장 자동역할** — 새로 들어오는 멤버에게 설정해둔 역할을 자동으로 부여 (봇 계정은 제외)

| 명령어 | 설명 | 필요 권한 |
|---|---|---|
| `/자동역할 설정 역할` | 자동으로 부여할 역할 지정 | 역할 관리 |
| `/자동역할 해제` | 자동 부여 끄기 | 역할 관리 |
| `/자동역할 확인` | 현재 설정 확인 | 역할 관리 |

## 처음 설정 (1회)

1. [디스코드 개발자 포털](https://discord.com/developers/applications)에서 애플리케이션 생성
2. **Bot** 탭 → 토큰 발급(Reset Token), **Server Members Intent** 켜기
3. **OAuth2 → URL Generator** → `bot` + `applications.commands` 체크, Bot Permissions에서 `Manage Roles` 체크 → 생성된 URL로 봇을 서버에 초대
4. `.env.example`을 복사해 `.env` 만들고 토큰/ID 채우기
5. 서버 설정 → 역할에서 **봇 역할을 부여할 역할들보다 위로** 올리기

```
npm install
npm run deploy   # 슬래시 명령어 등록 (명령어 추가/수정 시마다 실행)
npm start        # 봇 실행
```

## 기능 추가 방법

- **명령어**: `src/commands/`에 `data`(SlashCommandBuilder)와 `execute`를 내보내는 `.js` 파일 추가 → `npm run deploy` 한 번 실행
- **이벤트**: `src/events/`에 `name`(Events.~)과 `execute`를 내보내는 `.js` 파일 추가 (재시작만 하면 됨)
- 설정 저장은 `src/store.js`의 `get`/`set` 사용 (`config.json`에 저장됨)
