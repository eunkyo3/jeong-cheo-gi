// explanations.test.mjs — 해설(explanationHtml) 의 "채점 전 비노출" 방어선 단위 검증.
//
// 핵심 불변식: 해설은 정답을 그대로 담고 있으므로 **채점 전에 클라이언트로 나가면 안 된다**.
// 클라이언트로 나가는 문항은 반드시 publicQuestion() 을 거치고, 그 함수는 둘 다
// 화이트리스트 방식이므로 explanationHtml 은 구조적으로 빠진다 — 그 성질을 못 박는다.
//
// 해설 마크업 린터(validate-explanations.mjs)의 화이트리스트 규칙도 함께 검증한다.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

import { lintHtml, MIN_LEN, MAX_LEN } from '../scripts/validate-explanations.mjs';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rounds = require(path.join(ROOT, 'server', 'rounds.js'));
const battle = require(path.join(ROOT, 'server', 'battle.js'));

const SECRET = '<p>정답은 <mark>결합도</mark>입니다.</p>';

/** 해설이 붙은 문항 한 개(실제 데이터의 유무와 무관하게 성립해야 한다). */
function questionWithExplanation() {
  return {
    id: '2026-2#1',
    num: 1,
    prompt: '문제 지문',
    bodyHtml: '<p>본문</p>',
    bodyText: '본문',
    answerMode: 'ordered',
    display: '결합도',
    fields: [{ label: '①', accept: ['결합도'], validator: 'exact', sampleAnswer: '결합도' }],
    explanationHtml: SECRET,
  };
}

describe('publicQuestion — 해설은 채점 전 문항 사본에 실리지 않는다', () => {
  test('rounds.publicQuestion 이 explanationHtml 을 제거한다', () => {
    const pub = rounds.publicQuestion(questionWithExplanation());
    assert.equal('explanationHtml' in pub, false, 'explanationHtml 키가 남아 있으면 안 된다');
    assert.equal(JSON.stringify(pub).includes('결합도'), false, '해설 본문이 직렬화 결과에 새면 안 된다');
    // 화이트리스트가 바뀌지 않았는지도 함께 못 박는다.
    assert.deepEqual(Object.keys(pub).sort(), ['bodyHtml', 'fields', 'id', 'num', 'prompt', 'type']);
  });

  test('battle.publicQuestion 이 explanationHtml 을 제거한다', () => {
    const pub = battle.publicQuestion(questionWithExplanation());
    assert.equal('explanationHtml' in pub, false, 'explanationHtml 키가 남아 있으면 안 된다');
    assert.equal(JSON.stringify(pub).includes('결합도'), false, '해설 본문이 직렬화 결과에 새면 안 된다');
    assert.deepEqual(
      Object.keys(pub).sort(),
      ['answerMode', 'bodyHtml', 'bodyText', 'fields', 'id', 'num', 'prompt', 'type']
    );
  });

  test('실제 로드된 문항에도 같은 규칙이 적용된다', () => {
    const round = rounds.getRound('2026-2');
    assert.ok(round, 'data/rounds/2026-2.json 이 로드되어야 한다');
    for (const q of round.questions) {
      assert.equal('explanationHtml' in rounds.publicQuestion(q), false, q.id);
      assert.equal('explanationHtml' in battle.publicQuestion(q), false, q.id);
    }
  });
});

describe('rounds.explanationOf', () => {
  test('없는 문항 id 는 빈 문자열', () => {
    assert.equal(rounds.explanationOf('없는#문항'), '');
    assert.equal(rounds.explanationOf(undefined), '');
  });

  test('로드된 문항은 문자열을 돌려준다(해설 미작성이면 빈 문자열)', () => {
    const html = rounds.explanationOf('2026-2#1');
    assert.equal(typeof html, 'string');
  });
});

describe('해설 마크업 린터 — 허용 태그만, 속성 금지', () => {
  test('허용 태그는 통과한다', () => {
    for (const html of [
      '<p>설명</p><b>핵심</b><mark>정답</mark>',
      '<ul><li>첫째</li><li>둘째</li></ul>',
      '<ol><li>단계</li></ol><br>',
      '<pre><code>a &lt; b</code></pre>',
      '<br/><br />',
      '<P>대소문자 무시</P>',
    ]) {
      assert.deepEqual(lintHtml(html), [], html);
    }
  });

  test('속성이 붙은 태그는 거부한다', () => {
    assert.deepEqual(lintHtml('<p class="x">a</p>').map((v) => v.rule), ['tag-attribute']);
    assert.deepEqual(lintHtml('<img src=x>').map((v) => v.rule), ['tag-attribute']);
  });

  test('화이트리스트 밖의 태그는 거부한다', () => {
    assert.ok(lintHtml('<div>a</div>').some((v) => v.rule === 'tag-not-allowed'));
    assert.ok(lintHtml('<span>a</span>').some((v) => v.rule === 'tag-not-allowed'));
  });

  test('script / javascript: 는 즉시 실패한다 (대소문자 무시)', () => {
    assert.ok(lintHtml('<script>alert(1)</script>').some((v) => v.rule === 'script-tag'));
    assert.ok(lintHtml('<SCRIPT >x').some((v) => v.rule === 'script-tag'));
    assert.ok(lintHtml('<p>JavaScript:alert(1)</p>').some((v) => v.rule === 'javascript-url'));
  });

  test('태그가 아닌 날 "<" 는 엔티티로 써야 한다', () => {
    assert.deepEqual(lintHtml('<p>3 < 5 입니다</p>').map((v) => v.rule), ['bad-tag']);
    assert.deepEqual(lintHtml('<p>3 &lt; 5 입니다</p>'), []);
  });

  test('길이 경계값이 계약대로다', () => {
    assert.equal(MIN_LEN, 150);
    assert.equal(MAX_LEN, 1500);
  });
});
