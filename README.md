# EASY SECOND CHAT V2 - Netlify

## GitHub → Netlify 배포

1. 이 폴더 전체를 GitHub 저장소에 올립니다.
2. Netlify에서 GitHub 저장소를 연결합니다.
3. Build command는 비워 두고 Publish directory는 `.`로 둡니다. `netlify.toml`이 있으면 자동 설정됩니다.
4. Netlify 환경변수에 다음을 추가합니다.
   - `ADMIN_PASSWORD` : 관리자 닉네임용 비밀번호
   - `ROOM_AUTH_SECRET` : 방 인증 토큰 서명용 긴 랜덤 문자열
5. 재배포합니다.

## 중요한 변경점

Cloudflare Durable Objects/WebSocket은 Netlify 구조로 그대로 이전할 수 없으므로 Netlify Functions + Netlify Blobs 기반으로 변경했습니다.
채팅은 WebSocket 대신 1초 간격 HTTP 폴링으로 새 메시지와 참여자를 확인합니다.

유지되는 주요 기능:
- 방 만들기 / 방 들어가기
- 12자 이상 방 비밀번호
- PBKDF2 비밀번호 저장
- 24시간 방 초기화
- 방 목록 검색
- 최대 50명
- 관리자 보호 닉네임
- 욕설 닉네임/메시지 차단
- 최근 100개 메시지 저장
- 모바일 대응
