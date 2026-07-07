# 🎙️ English Coach — 발음 트레이너 + 회화 수업 (PWA)

완전 정적 웹앱 — PC·폰 어디서나 브라우저로 사용. 서버 불필요 (GitHub Pages 배포 가능).

두 가지 학습 모드 + 연결 루프:
- **🔤 발음 연습** — Azure Pronunciation Assessment로 문장을 **음소 단위** 채점, 취약 음소 누적 추적
- **💬 회화 수업** — Gemini Live API로 원어민 선생님(Emma)과 실시간 음성 대화, 수업 후 교정 리포트
- **🗂 오답 은행** — 수업에서 교정받은 문장 → "고쳐 말하기" 발음 훈련 → 80점×3회 졸업
- **📊 통계** — 점수 추이, 취약 음소 순위, 연속 학습일, 수업 시간 누적

## 사용 방법

### PC (로컬)
```
python server.py    # 또는 start.bat 더블클릭
```
→ http://localhost:8735 (로컬 서버는 edge-tts 원어민 음성 + config.json 키 백업 제공)

### 폰 (GitHub Pages 배포 후)
1. https://spring1277.github.io/english-coach/ 접속 (배포 후)
2. ⚙️ 설정에서 Azure·Gemini 키 입력 (기기별 1회, localStorage 저장)
3. Chrome 메뉴 → **홈 화면에 추가** → 앱처럼 사용

## API 키 (모두 무료 티어)

| 키 | 용도 | 발급 |
|---|---|---|
| Azure Speech (F0, 월 5시간) | 발음 채점 + TTS | portal.azure.com → Speech 리소스 → 키 및 엔드포인트 |
| Gemini | 회화 수업 + 리포트 | aistudio.google.com/apikey |

키는 브라우저 localStorage(기기별)에만 저장. PC 로컬 서버 사용 시 config.json에서 자동 이관.

## 기술 메모

- **발음 채점은 Azure Speech JS SDK(브라우저 직접 연결)** — REST 단문 API는 koreacentral 등에서 Pronunciation-Assessment 헤더를 400 거부함. GradingSystem enum은 `HundredMark`
- **Gemini Live 모델명은 자주 바뀜** — 연결 실패 시 ListModels(bidiGenerateContent 지원)로 재조회해 app.js `LIVE_MODELS` 갱신. 리포트는 `gemini-flash-latest`, 429/503 시 자동 폴백
- 마이크는 HTTPS(또는 localhost)에서만 동작 → 폰 사용은 GitHub Pages(HTTPS) 필수
- 서비스워커는 네트워크 우선(항상 최신 코드), 오프라인 시 캐시 폴백
- 학습 데이터: localStorage (ec_cfg, ec_history, ec_phonemes, ec_wrongbank, ec_reports, ec_daily, ec_sessions)

## 배포 (GitHub Pages)

my-apps 저장소에서 서브트리 푸시:
```
git remote add ec https://github.com/spring1277/english-coach.git   # 최초 1회
git subtree push --prefix english-coach ec main
```
GitHub 저장소 Settings → Pages → Deploy from a branch → main / (root)
