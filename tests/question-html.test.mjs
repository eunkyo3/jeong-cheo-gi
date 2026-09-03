// tests/question-html.test.mjs — 문항 prompt/bodyHtml 화이트리스트 검증기 (보안 L-14)
//
// scripts/validate-data.mjs 의 lintQuestionHtml 을 직접 부른다. 현재 420문항이 통과하는 것은
// `npm run validate`(preflight ②)가 보장하므로 여기서는 **거절해야 하는 입력**을 고정한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lintQuestionHtml, HTML_ALLOWED_TAGS } from '../scripts/validate-data.mjs';

const rules = (html) => lintQuestionHtml(html).map((v) => v.rule);

test('허용 태그·속성만 쓴 문항 HTML 은 통과한다', () => {
  assert.deepEqual(rules('<div class="hint">힌트</div><pre class="code">x</pre><table class="tbl"><tr><th>a</th><td>b</td></tr></table><br><b>굵게</b><u>밑줄</u>'), []);
  // 데이터에 이미 있는 flex 래퍼 6건은 렌더러가 클래스로 바꾸므로 그 값 하나만 허용
  assert.deepEqual(rules('<div style="display:flex; gap:30px; flex-wrap:wrap;"><pre class="code">a</pre></div>'), []);
  // "테이블 <A>, <B>" 표기(2026-2#13·#14)는 태그가 아니다
  assert.deepEqual(rules('다음 <A>, <B> 테이블과 SQL문을 참고하여'), []);
  assert.ok(rules('<A href="x">').includes('html-tag-not-allowed'));
});

test('스크립트·이벤트 핸들러·javascript: URL 은 거절한다', () => {
  assert.ok(rules('<script>alert(1)</script>').includes('html-forbidden-tag'));
  assert.ok(rules('<img src=x onerror=alert(1)>').includes('html-tag-not-allowed'));
  assert.ok(rules('<div onclick="x()">a</div>').includes('html-event-handler'));
  assert.ok(rules('<div class="javascript:alert(1)">a</div>').includes('html-url-scheme'));
  assert.ok(rules('<b>a</b><!-- c -->').includes('html-comment'));
  assert.ok(rules('<iframe srcdoc="<script>1</script>"></iframe>').includes('html-forbidden-tag'));
});

test('허용 목록 밖 태그·속성·style 은 거절한다', () => {
  assert.ok(rules('<a href="https://x">링크</a>').includes('html-tag-not-allowed'));
  assert.ok(rules('<div id="x">a</div>').includes('html-attr-not-allowed'));
  assert.ok(rules('<div style="color:red">a</div>').includes('html-style-attr'));
  assert.ok(rules('<pre style="display:flex; gap:30px; flex-wrap:wrap;">a</pre>').includes('html-style-attr'));
  assert.ok(rules('<svg onload=alert(1)>').includes('html-forbidden-tag'));
  assert.equal(HTML_ALLOWED_TAGS.has('script'), false);
});
