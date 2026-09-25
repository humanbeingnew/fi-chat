# EASY SECOND CHAT V8 FINAL

Netlify Functions + Netlify Blobs 기반 소규모 친구용 채팅입니다.

## 최종 구조

- `netlify/functions/api.mjs`: API 서버
- `index.html`: 화면
- `@netlify/blobs` 11.1.1 고정
- Node.js 22.12.0 고정
- `getStore()`는 요청 핸들러에서 생성
- `export default async (req, context)` 사용
- 방 메타데이터 / 접속자 / 메시지 / 검색 디렉터리를 별도 store로 분리
- 메시지는 방 객체의 배열에 저장하지 않고 메시지마다 별도 Blob으로 저장
- 접속자도 사용자별 Blob으로 저장
- 방 생성은 `onlyIfNew` 또는 만료 방의 `onlyIfMatch`로 원자적 조건부 저장
- 비밀번호 업그레이드 등 방 메타데이터 변경은 `onlyIfMatch` CAS 재시도
- 서버 내부 오류의 상세 내용은 클라이언트에 노출하지 않음
- PBKDF2-SHA256 비밀번호 저장
- 관리자 닉네임은 `ADMIN_PASSWORD`로 별도 인증
- 1초 HTTP polling 방식

## Netlify 환경변수

필수:

- `ROOM_AUTH_SECRET`: 길고 예측하기 어려운 랜덤 문자열
- `ADMIN_PASSWORD`: 관리자 닉네임을 사용할 때 필요한 관리자 비밀번호

GitHub 코드에 비밀번호를 넣지 마세요.

## Netlify 설정

- Branch: `main`
- Base directory: 비워두기
- Build command: 비워두기
- Publish directory: `.`
- Functions directory: `netlify/functions`

## 배포 후 테스트

먼저:

`https://사이트주소.netlify.app/api/health`

정상이면 `ok:true`, `version:8`, `blobs:true`가 표시됩니다.

그 다음:

1. 새 방 만들기
2. 방 들어가기
3. 서로 다른 브라우저에서 동시에 입장
4. 동시에 메시지 보내기
5. 새로고침해서 메시지가 유지되는지 확인

## 중요한 한계

Netlify Blobs는 관계형 데이터베이스가 아닙니다. V8 FINAL은 공유 배열을 동시에 덮어쓰는 문제를 피하기 위해 메시지와 접속자를 개별 키로 분리했습니다. 그래도 대규모 실시간 서비스에는 전용 데이터베이스와 WebSocket/실시간 서비스가 더 적합합니다.

기존 V3~V7 Blobs를 자동으로 읽어오지 않습니다. 이전 SDK에서 만든 store가 새 SDK에서 접근 불가능할 수 있기 때문에, 최종 버전은 깨끗한 FINAL 전용 store를 사용합니다.
