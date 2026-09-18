EASY SECOND CHAT V2 — Cloudflare Workers 프로젝트

구조
EASY_SECOND_CHAT_V2_FINAL/
├─ src/
│  └─ index.js
├─ wrangler.jsonc
├─ package.json
└─ README.md

배포
1. 이 폴더를 GitHub에 올린다.
2. Cloudflare Workers 프로젝트의 루트 디렉터리로 사용한다.
3. 터미널에서:
   npm install
   npx wrangler deploy

중요
- 사용자는 WebSocket 주소를 직접 입력하지 않는다.
- 현재 접속한 사이트의 /ws로 자동 연결한다.
- HTTPS에서는 wss://, HTTP에서는 ws://를 자동 선택한다.
- WebSocket 연결이 끊기면 1.5초 후 자동 재연결한다.
- 같은 방 코드는 같은 Durable Object 방으로 연결된다.
- 닉네임 중복, 욕설, 메시지 도배 제한, 세션 토큰 검증을 유지한다.
- /api/health에서 서버 상태를 확인할 수 있다.

이번 수정의 핵심
- 기존 wrangler.jsonc의 main이 "src_index.js"였는데 실제 프로젝트를 폴더형으로 배포할 때 파일 위치가 어긋나 Wrangler가 "src_index.js에 있는 진입점 파일을 찾을 수 없습니다"라고 실패하는 문제를 제거했다.
- 진입점은 표준적인 src/index.js로 통일했다.
- Durable Object SQLite 마이그레이션을 명시했다.
- 브라우저 WebSocket 중복 연결/재연결 경쟁 상태를 방지했다.
