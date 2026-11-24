# Claude Code × Microsoft Copilot SDK — Gemini 4 실습

GitHub Copilot의 **Gemini 4 모델 4종**(Argon · Carbon · Hydrogen · Neon)을 Claude Code에서 쓰는 실습 저장소입니다. 로컬 브리지가 Claude Code의 Anthropic Messages API 요청을 Microsoft Copilot SDK(`@microsoft/copilot-sdk`, 구 GitHub Copilot SDK) 호출로 바꿔 줍니다. 경로는 두 가지이고, 가이드도 두 개입니다.

| 경로 | 가이드 (웹에서 바로 열림) | 시작 명령 |
|---|---|---|
| 노트북 → 브리지 → Copilot SDK → Gemini 4 (직접) | **[직접 연결 가이드](https://junwoojeong100.github.io/cc-mscp-sdk-v2-gemini/guide.html)** · [▶ 영상 바로 재생](https://junwoojeong100.github.io/cc-mscp-sdk-v2-gemini/guide.html#video) | `claude-gemini` |
| 노트북 → **LiteLLM** → 브리지 → Copilot SDK → Gemini 4 | **[LiteLLM 경유 가이드](https://junwoojeong100.github.io/cc-mscp-sdk-v2-gemini/guide-litellm.html)** · [▶ 영상 바로 재생](https://junwoojeong100.github.io/cc-mscp-sdk-v2-gemini/guide-litellm.html#video) | `gemini-litellm up` 후 `claude-gemini-litellm` |

**👉 위 링크를 누르면 GitHub Pages에서 바로 열립니다.** 두 가이드를 한곳에서 고르려면 [랜딩 페이지](https://junwoojeong100.github.io/cc-mscp-sdk-v2-gemini/)로 가세요. 화면 캡처와 영상으로 된 1페이지 실습 가이드이고, `main` 에 푸시하면 두 가이드를 다시 만들어 자동으로 배포합니다. 내려받아 로컬에서 볼 때는 `guide.html` · `guide-litellm.html` 을 직접 여세요. 영상은 `assets/` 를 같은 위치에 두면 그 파일을, 없으면 위 주소의 영상을 재생합니다.

```bash
npm ci
export PATH="$PWD/bin:$PATH"

copilot login                 # 처음 한 번
gemini-doctor && gemini-models
claude-gemini --ghcp-model gemini-4-neon -p "안녕하세요"

# LiteLLM 경로
gemini-litellm setup          # LiteLLM 설치 (처음 한 번, 해시 고정)
gemini-litellm up
claude-gemini-litellm --litellm-model gemini-4-neon -p "안녕하세요"
gemini-litellm down
```

| 폴더·파일 | 내용 |
|---|---|
| `guide.html` · `guide-litellm.html` | 실습 가이드 (한 페이지, 캡처 내장) — `guide/template.html` · `guide/litellm.template.html` 에서 `npm run guide` · `npm run guide:litellm` 로 생성 |
| `site/` · `.github/workflows/pages.yml` · `scripts/build-site.mjs` | GitHub Pages: 랜딩 페이지, 배포 워크플로, 사이트 조립 스크립트. `main` 에 푸시하면 두 가이드를 다시 만들어 영상과 함께 배포합니다 (`npm run site` → `_site/`) |
| `assets/` · `assets/litellm/` | 가이드의 영상 `demo.mp4` 와 화면 캡처 `shots/` (`npm run media:build` · `media:build:litellm` 로 생성) |
| `bin/` · `src/` | 런처와 브리지. `claude-gemini`, `claude-gemini-litellm`, `gemini-litellm`, `gemini-models`, `gemini-doctor`, `gemini-lab` … |
| `examples/litellm-gemini.yaml` | LiteLLM 설정: 별칭 4개, 브리지로의 연결(토큰은 `x-api-key` 헤더로), 헤더 전달 |
| `.npmrc` | `package-lock.json` 에 레지스트리 주소(`resolved`)를 넣지 않는 설정 — 사내 피드든 공개 npm이든 같은 락 파일로 `npm ci` 됩니다 (`test/rename.test.mjs` 가 지킵니다) |
| `labs/` | 실습 파일: `01-fix-the-bug`(실패하는 테스트), `02-read-an-image`(이미지 읽기) |
| `verification/results.json` · `results-litellm.json` | 실제 호출 검증 결과 (`npm run verify -- --publish` · `npm run verify:litellm -- --publish` 로 생성) |
| `scripts/verify/` | 검증 하네스 · `scripts/media/` 캡처·영상 제작 도구 · `scripts/setup-litellm.sh` LiteLLM 설치기 |
| `test/` | 오프라인 단위 테스트 (`npm test`) |

> **비공식 구성입니다.** Anthropic도 GitHub도 이 조합을 지원하지 않고, LiteLLM 설정도 LiteLLM이 보증하는 구성이 아닙니다. 이 저장소의 브리지는 [`claude-code-ghcp-sdk`](https://github.com/junwoojeong100/claude-code-ghcp-sdk) 에서 가져와 Gemini 4용으로 고친 것입니다.

> `.media/`(git 제외)에는 캡처·영상을 만든 **원본 녹화**가 있습니다. 계정명 등을 가리기 전의 원본이므로 이 폴더는 공유하지 마세요. 가이드와 `assets/` 의 결과물에서는 가려져 있습니다. `.runtime/`(git 제외)에는 설치한 LiteLLM과 그 **마스터 키**가 있으니 역시 공유하지 마세요.

> **`examples/litellm-gemini.yaml` 에 `api_key` 를 추가하지 마세요.** LiteLLM은 `anthropic/` 경로에 `api_key` 가 있으면 Claude Code의 토큰 수 계산 요청(`/v1/messages/count_tokens`)을 설정한 브리지가 아니라 `api.anthropic.com` 으로 보내, 대화 전체와 그 키가 외부로 나갑니다. 그래서 브리지 토큰은 `extra_headers` 의 `x-api-key` 로만 보내고, 그러면 LiteLLM이 토큰 수를 자체 추정값으로 답합니다(`test/litellm.test.mjs` 와 `gateway` 검증 시나리오가 확인). LiteLLM은 `gemini-litellm up` 으로만 시작하세요(`GHCP_BRIDGE_URL` 을 넣어 줍니다).

## 자주 쓰는 명령

```bash
npm test                              # 단위 테스트 (모델 호출 없음)
npm run verify:plan                   # 검증 계획만 출력 (직접 경로)
npm run verify -- --publish           # 실제 호출 검증 후 결과 게시 (약 15분, Copilot 사용량 소비)
npm run verify:report                 # 기록된 검증 결과 표
npm run verify:litellm:plan           # LiteLLM 경로의 검증 계획
npm run verify:litellm -- --publish   # LiteLLM 경유 실제 호출 검증 (약 15분)
npm run verify:litellm:report         # LiteLLM 경로의 검증 결과 표
npm run media:record                  # 데모 세션 녹화 (Copilot 사용량 소비)
npm run media:build                   # 캡처와 영상 만들기
npm run guide                         # guide.html 다시 만들기
npm run media:record:litellm          # LiteLLM 경로 녹화 (LiteLLM 을 새로 설치해 보여 줍니다)
npm run media:build:litellm           # 〃 캡처와 영상 → assets/litellm/
npm run guide:litellm                 # guide-litellm.html 다시 만들기
npm run site                          # Pages용 사이트 조립 → _site/ (가이드를 먼저 만들어 두세요)
```

## SDK 버전

브리지는 `@microsoft/copilot-sdk` **2.0.0** 을 정확히 고정해 씁니다(런타임 1.0.113, SDK 프로토콜 4). SDK 2는 기본으로 런타임을 호출한 프로세스 안에서 실행하지만, 브리지는 `RuntimeConnection.forSpawnedStdio` 로 자식 프로세스에 둡니다(`src/copilot-client.mjs`). `COPILOT_CLI_PATH` 가 설정돼 있으면 SDK가 번들 런타임 대신 그 CLI를 실행하므로, 이 저장소의 검증·녹화는 항상 그 변수를 지운 환경에서 돌립니다. 더 새 SDK가 나오면 `npm install --save-exact @microsoft/copilot-sdk@<버전>` 후 `npm test` 와 `npm run verify -- --publish` 를 다시 돌리세요.

## 저장소 이름을 바꿀 때

저장소(폴더) 이름은 `package.json` 의 `name` 과 `homepage`(GitHub Pages 주소), 그리고 그 주소를 쓰는 README 링크에만 적혀 있습니다(`test/rename.test.mjs` 가 지킵니다). 가이드의 `cd …` 와 가이드 사이 링크, 브리지의 캐시 폴더 이름은 `package.json` 에서 따라옵니다. 이름을 바꾸려면

```bash
claude-gemini-stop && gemini-litellm down     # 1. 떠 있는 브리지·게이트웨이 종료
cd .. && mv <옛 이름> <새 이름> && cd <새 이름>
# 2. package.json 의 "name" 과 "homepage"(https://<계정>.github.io/<새 이름>/) 를 고친다
npm install --package-lock-only               # 3. package-lock.json 의 이름 갱신
npm run guide && npm run guide:litellm        # 4. 가이드의 cd 줄과 가이드 사이 링크 갱신
# 5. README 의 github.io 링크를 새 주소로 고친다
npm test                                      # 6. 어긋난 곳이 있으면 알려 줍니다
```

`.runtime/`(LiteLLM)은 폴더를 옮겨도 그대로 동작합니다(LiteLLM을 `litellm` 스크립트가 아니라 venv 의 `python -m` 으로 실행하기 때문). 브리지의 캐시 폴더(`~/Library/Caches/<이름>`)는 새 이름으로 새로 만들어지고, 옛 폴더는 지워도 됩니다.

GitHub에서 저장소 이름을 바꾸면 GitHub Pages 주소도 따라 바뀌고 옛 주소는 연결되지 않습니다. 위 2~5번을 새 주소로 맞추고, 저장소 오른쪽 위의 **Website** 링크는 `gh repo edit --homepage https://<계정>.github.io/<새 이름>/` 로 고치세요. 랜딩 페이지의 저장소 링크는 주소에서 계산하므로 손댈 곳이 없습니다.
