# EASY SECOND CHAT V2 — Cloudflare Workers

## 프로젝트 구조
```text
repository/
├─ src/
│  └─ index.js
├─ wrangler.jsonc
├─ package.json
└─ README.md
```

## 배포
1. 이 폴더의 내용물을 GitHub 저장소 루트에 올립니다.
2. Cloudflare Workers에서 해당 저장소를 연결합니다.
3. 필요하면 터미널에서 `npm install` 후 `npx wrangler deploy`를 실행합니다.

## 중요
이 Worker는 Durable Object를 `exports` 방식으로 관리합니다. `wrangler.jsonc`에 `migrations`를 추가하지 마세요.

## 이번 수정
브라우저의 `Unexpected string` 오류를 일으키던 `esc()` 함수의 template literal 이스케이프 문제를 수정했습니다.
기존 채팅 기능은 유지했습니다.
