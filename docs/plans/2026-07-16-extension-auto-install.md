# 확장 자동설치 (관리자 스크립트 방식) — 구현 기록

> 요청: "exe 설치하면 크롬 확장도 자동 설치되게".
> 코드 착수 전 `andrej-karpathy-guidelines` 스킬 호출함(CLAUDE.md 규칙).

## 핵심 발견 (설계를 바꾼 사실)

크롬/엣지의 **강제설치 정책(ExtensionInstallForcelist)** 만이 스토어 없는 확장을 자동설치할 수 있다(개발자모드 "압축해제 로드"는 자동화 불가, 로컬 CRX의 `Extensions\<id>\path` 방식은 2014년부터 스토어 확장에만 허용).
그런데 이 PC에서 확인한 결과:

```
HKCU\Software\Policies ACL = SYSTEM·Administrators FullControl (일반 사용자 쓰기 불가)
```

즉 **HKCU라도 `Software\Policies` 하위는 관리자만 씀** → 강제설치는 **관리자 권한 1회 필수**(HKLM도 당연). "관리자 불필요"는 불가능으로 판명.

**사용자 결정:** exe 설치기는 per-user 그대로 두고, 확장은 **별도 `받냥이-확장설치.bat`(우클릭 없이 더블클릭 → 자기 자신을 UAC로 재실행)** 1회로 켠다.

## 구성

| 파일 | 역할 |
|---|---|
| `build/extension-key.pem` | 확장 서명키(**gitignore, 비밀·백업 필요**). ID 고정용 |
| `extension/manifest.json` | `"key"`(공개키 → ID 고정) + `"storage.managed_schema"` 추가. 확장 ID = `hcaehgnpahddjceeamipjimeokagpgno` |
| `extension/managed_schema.json` | 정책으로 주입할 `bridgeToken` 스키마 |
| `extension/background.js`·`options.js` | 토큰 = local(사용자 입력) 우선, 없으면 `chrome.storage.managed`(설치기 주입) |
| `scripts/pack-crx.js` | Chrome `--pack-extension`으로 `build/downcat-ext.crx` 생성(임시 프로필로 안전) |
| `scripts/downcat-ext-policy.ps1` | update.xml 생성 + 강제설치 정책(Chrome+Edge) + 토큰 managed 정책·config.json 시드. `-Uninstall`로 제거. **UTF-8 BOM**(PS 5.1이 한글 안 깨지게) |
| `받냥이-확장설치.bat` / `받냥이-확장제거.bat` | `net session`으로 관리자 확인 → 없으면 자기 UAC 재실행 → PS 호출 |
| `package.json` | `dist`가 CRX 먼저 패킹, `build/downcat-ext.crx`를 설치본에 포함 |

## 데이터 흐름 (자동 페어링)

1. 설치 bat(관리자) → PS가 config.json에서 토큰 읽음(없으면 생성해 config.json에 시드).
2. 같은 토큰을 `HKCU\...\3rdparty\extensions\<ID>\policy` `bridgeToken`에 씀(Chrome+Edge).
3. 강제설치 정책이 CRX를 자동설치 → 확장이 `chrome.storage.managed`로 토큰을 읽어 **손 안 대고 페어링**.
4. 받냥이 실행 시 같은 config.json 토큰을 씀 → 브리지 인증 일치.

## 검증

**내가 확인한 것:**
- CRX 패킹 성공(`build/downcat-ext.crx`, 9.9KB). ⚠️ Chrome은 **PKCS#8** 키만 받음 — 키를 pkcs8로 재출력(ID 불변 확인).
- 확장 ID 계산·불변(`hcaeh…pgno`), manifest `key`/`managed_schema` 유효.
- PS 파싱(BOM 추가로 PS 5.1 한글 파서 에러 해결), 토큰·경로 로직.
- `node --check` 확장 JS 전부.

**막혀서 사용자 검증으로 남긴 것:**
- 실제 정책 레지스트리 쓰기 = 관리자 필요 → **`받냥이-확장설치.bat` 더블클릭(UAC 예)**가 그 검증.
- 크롬이 **file:// update_url**로 강제설치를 실제 수행하는지 = bat 실행 후 크롬 재시작해 툴바에 아이콘 뜨는지로 확인. (안 되면 대안: 받냥이 브리지가 `http://127.0.0.1:47653/ext/update.xml`로 서빙 — 다음 단계.)

## 사용법

1. `받냥이-확장설치.bat` 더블클릭 → UAC "예".
2. 크롬/엣지 **완전 종료 후 재시작** → 툴바에 받냥이 아이콘.
3. 토큰은 자동(managed). 아이콘 → 팝업 "받냥이 연결됨 ✅" 확인.
4. 끄려면 `받냥이-확장제거.bat`.

## 알아둘 점

- `build/extension-key.pem`을 잃으면 ID가 바뀌어 재설치 필요 — 백업할 것.
- 강제설치라 확장에 "조직이 설치함" 배너 + 사용자가 크롬에서 직접 못 지움(제거 bat으로 제거). 개인용이라 OK.
