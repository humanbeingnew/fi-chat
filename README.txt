EASY SECOND CHAT V2 FINAL AUTO

핵심 변경:
- 사용자가 WebSocket 주소를 직접 입력하지 않음
- 현재 접속한 workers.dev 사이트 주소에서 /ws 주소를 자동 생성
- HTTPS 사이트면 wss://, HTTP 사이트면 ws://로 자동 선택
- 연결이 끊기면 1.5초 후 자동 재연결
- 같은 방 번호를 입력한 사용자는 같은 Durable Object 방에 연결
- 닉네임/메시지 욕설 필터
- 닉네임 중복 방지
- 메시지 도배 제한
- 세션 토큰으로 메시지 발신자 검증

배포 후 사용자는:
1. workers.dev 사이트 접속
2. 닉네임 입력
3. 같은 방 번호 입력
4. 방 입장

WebSocket 주소를 따로 입력할 필요가 없습니다.

Cloudflare 배포:
wrangler deploy

주의:
이 프로젝트는 순수 P2P가 아니라 Cloudflare Durable Object가 채팅방의 WebSocket 연결과 메시지를 중계하는 구조입니다.


[2026-09-18 FINAL FIX]
Cloudflare 배포 시 발생한 "세미콜론(;)이 예상되었지만 }가 발견되었습니다" 구문 오류를 수정했습니다.
원인은 page() 내부의 HTML 템플릿 문자열 안에 JavaScript 템플릿 리터럴(`...${...}`)을 다시 사용한 것이었습니다.
해당 부분을 일반 문자열 연결 방식으로 변경해 Cloudflare Wrangler/esbuild가 파싱할 수 있도록 했습니다.
