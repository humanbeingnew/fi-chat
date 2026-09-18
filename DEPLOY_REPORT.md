# EASY SECOND CHAT V2 오류 수정 보고서

## 1. 발생한 오류

Cloudflare 배포 시 다음 오류가 발생했다.

`This Worker was last deployed using the declarative exports flow; reverting to migrations is not supported. [code: 100403]`

## 2. 원인

이 프로젝트의 기존 `wrangler.jsonc`는 Durable Object를 선언형 `exports` 방식으로 관리하도록 되어 있었다.

그런데 이전 수정 과정에서 `migrations`를 추가했다.

즉 배포 이력이:

`기존 Worker: exports`
→ `수정된 설정: migrations`

로 바뀌었고, Cloudflare가 이미 `exports` 방식으로 관리 중인 Worker를 legacy `migrations` 방식으로 되돌리는 것을 거부했다.

Cloudflare 공식 문서상 `exports`와 `migrations`는 상호 배타적이며, 이미 `exports`로 배포된 Worker는 이후에도 `exports`를 계속 사용해야 한다.

## 3. 수정 내용

### wrangler.jsonc

삭제:
- `migrations`
- `v1` migration 설정

유지/복구:
- `durable_objects.bindings`
- `CHAT_ROOM` -> `ChatRoom`
- `exports.ChatRoom`
- `type: durable-object`
- `storage: sqlite`
- `main: src/index.js`

최종 핵심 설정:

```json
"durable_objects": {
  "bindings": [
    {
      "name": "CHAT_ROOM",
      "class_name": "ChatRoom"
    }
  ]
},
"exports": {
  "ChatRoom": {
    "type": "durable-object",
    "storage": "sqlite"
  }
}
```

## 4. 코드 기능 확인

`src/index.js`는 기존 채팅 기능을 유지했다.

- 닉네임 / 방 번호
- WebSocket 자동 연결
- HTTPS에서는 wss://
- HTTP에서는 ws://
- 자동 재연결
- 같은 방의 Durable Object 공유
- 닉네임 중복 방지
- 욕설 필터
- 메시지 도배 제한
- 세션 토큰
- 메시지 저장
- `/api/health`

또한 브라우저 측 WebSocket 중복 연결 방지와 stale socket 이벤트 무시 처리를 유지했다.

## 5. 수정 후 검증

검증 항목:

- `wrangler.jsonc` JSON 파싱: 통과
- `exports` 존재: 통과
- `migrations` 미존재: 통과
- `CHAT_ROOM` Durable Object binding 존재: 통과
- `ChatRoom` exports 선언 존재: 통과
- `src/index.js` 진입점 존재: 통과
- JavaScript 문법 검사(Node --check): 통과

## 6. 배포 주의사항

GitHub 저장소 루트가 다음과 같아야 한다.

```text
repository/
├── src/
│   └── index.js
├── wrangler.jsonc
├── package.json
├── README.md
└── DEPLOY_REPORT.md
```

`EASY_SECOND_CHAT_V2_FINAL_EXPORTS` 폴더 자체를 한 단계 더 넣는 식으로 중첩해서 올리지 않는 것이 좋다.

배포 명령:

```bash
npm install
npx wrangler deploy
```

이번 오류의 핵심은 `src/index.js`가 아니라 **Durable Object lifecycle 설정이 기존 배포 방식과 달랐던 것**이다.
