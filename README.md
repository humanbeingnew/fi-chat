EASY SECOND CHAT V2 — Cloudflare Workers / GitHub 배포용

프로젝트 구조
EASY_SECOND_CHAT_V2_FINAL_EXPORTS/
├─ src/
│  └─ index.js
├─ wrangler.jsonc
├─ package.json
├─ DEPLOY_REPORT.md
└─ README.md

배포
1. 이 폴더의 내용을 GitHub 저장소 루트에 올린다.
2. Cloudflare에서 해당 GitHub 저장소를 연결한다.
3. 터미널을 사용한다면:
   npm install
   npx wrangler deploy

중요
이 Worker는 이미 Cloudflare에서 Durable Object의 선언형 `exports` 방식을 사용해 배포된 상태를 기준으로 한다.
따라서 `wrangler.jsonc`에는 `migrations`를 넣으면 안 된다.
`exports`와 `migrations`는 같은 Worker에서 함께 사용할 수 없고, 이미 `exports`로 배포된 Worker를 `migrations`로 되돌릴 수 없다.

기능
- WebSocket 주소 직접 입력 불필요
- 현재 사이트 /ws 자동 연결
- HTTPS -> wss://, HTTP -> ws://
- WebSocket 1.5초 자동 재연결
- 같은 방 코드 -> 같은 Durable Object
- 닉네임 중복 방지
- 욕설 필터
- 메시지 도배 제한
- 세션 토큰 검증
- 최근 메시지 100개 저장
- /api/health 서버 상태 확인
