# 빌드 오버레이 (안드로이드)

`overlay/`의 PC판을 폰으로 옮긴 것. 게임 위에 떠서 스킬 순서를 3개씩 보여 주고,
화면의 턴 숫자를 읽어 자동으로 다음 단계로 넘어간다.

PC판과 **같은 파서**를 쓴다 — `overlay/lib/steps.js`를 `Steps.kt`로 옮겼고, 테스트도 같이 옮겼다.
둘 중 하나를 고치면 나머지도 같이 고쳐야 한다.

## APK 받기

로컬에 Android SDK를 깔지 않아도 된다. **GitHub Actions가 빌드해 준다.**

main에 올라갈 때마다 `latest` 릴리스가 갱신된다. 로그인 없이 이 주소에서 바로 받는다:

<https://github.com/ericalapiestral-hash/guild-bot/releases/latest/download/guild-overlay-android.apk>

폰으로 옮겨 설치하면 된다 (설치할 때 "출처를 알 수 없는 앱" 허용이 한 번 필요하다).
저장소 루트에서 `npm run release`를 돌리면 이 파일을 `release/`로 받아 온다.

빌드 중간 결과가 필요하면 Actions → `안드로이드 APK 빌드` → 최근 실행 → **Artifacts**
(이쪽은 GitHub 로그인이 필요하고 90일 뒤 사라진다). 손으로 돌리려면 **Run workflow**.

> PC용 exe는 릴리스에 올리지 않는다 — 포장할 때 길드 도감이 같이 들어가기 때문이다.
> APK에는 도감이 안 들어간다 (앱에서 직접 불러온다).

## 쓰는 법

1. **도감 불러오기** — 길드봇 폴더의 `data/builds.json`을 폰으로 옮기고 앱에서 *파일에서* 로 고른다.
   어딘가에 올려 뒀다면 *URL에서* 도 된다. 한 번 불러오면 앱 안에 복사되어 오프라인으로 쓴다.
2. **빌드 고르기** — 분류(공성전·파괴신·구사황·기타) → 빌드
3. **권한** — *다른 앱 위에 표시* 허용
4. **오버레이 켜기** → 게임으로 넘어가면 창이 따라온다

창에서:

| | |
|---|---|
| 제목줄 끌기 | 위치 옮기기 |
| `▾` | 접기/펼치기 |
| `🔒` | 창이 터치를 안 먹게 (해제는 `🔓`) |
| `◀ ▶` | 손으로 단계 이동 (자동은 잠시 꺼진다) |
| `턴 위치` | 화면에서 턴 숫자가 보이는 자리를 드래그로 지정 |
| `자동` | 턴을 읽어 자동 진행 — 화면 읽기 동의가 한 번 필요 |
| `빌드` | 앱을 열어 다른 빌드로 바꾸기 |

## 알아둘 것

- **최소 안드로이드 8.0(API 26)** — 떠 있는 창 API가 그때부터다.
- 자동 인식은 **화면 읽기(MediaProjection)** 를 쓴다. 켤 때마다 시스템 동의창이 한 번 뜬다.
  앱을 껐다 켜면 다시 물어본다 — 안드로이드가 그렇게 만들어 놨다.
- 인식 모델은 **APK에 들어 있다.** 첫 실행에 뭘 받지 않고, 인터넷 없이 돈다.
  (PC판은 tesseract 언어 데이터를 1분쯤 받는다 — 그 단계가 없어졌다)
- 화면을 돌리면 지정한 턴 위치가 어긋난다. 가로/세로를 바꿔 플레이하면 다시 지정해야 한다.
- 게임이 화면 보호(FLAG_SECURE)를 걸어 두면 캡처가 검게 나온다. 그때는 자동을 못 쓰고
  `◀ ▶`로 넘기면 된다.
- 배터리 최적화가 서비스를 재우는 기기가 있다. 자동이 자꾸 끊기면 앱을 배터리 최적화 예외로 둔다.

## 구조

```
app/src/main/java/kr/guildbot/overlay/
  Steps.kt                  스킬 순서 파서 (overlay/lib/steps.js 포팅)
  BuildsRepository.kt       builds.json 읽기 · 가져오기 · 캐시
  Prefs.kt                  설정 저장 (빌드 · 창 위치 · 턴 영역)
  MainActivity.kt           도감 불러오기 · 빌드 고르기 · 권한 · 켜기
  OverlayService.kt         떠 있는 창 (PC판 renderer/overlay.js)
  RegionPickerView.kt       턴 위치 드래그 지정 (PC판 renderer/picker.js)
  TurnCapture.kt            화면 캡처 + 턴 숫자 인식 (desktopCapturer + tesseract 자리)
  ProjectionRequestActivity.kt  화면 읽기 동의창 껍데기
app/src/test/                 Steps.kt 테스트 (overlay/test/steps.test.js 포팅)
```

## 직접 빌드하려면

Android Studio로 `android/` 폴더를 열면 된다 (Gradle 래퍼는 스튜디오가 만들어 준다).
명령줄이면 Gradle 8.9+ · JDK 17이 필요하다:

```bash
cd android && gradle assembleDebug
```
