// codefmt.test.mjs — `public/js/codefmt.js` (window.CodeFmt) 단위 검증.
//
// codefmt.js 는 브라우저용 IIFE 라 window(없으면 globalThis)에 붙는다. node 에서는
// createRequire 로 그냥 불러오면 globalThis.CodeFmt 가 생긴다 — 별도 빌드가 없다.
//
// 검사 축
//   ① 공통 정규화 — 탭(열 기준) · 줄 끝 공백 · 공통 들여쓰기 · 앞뒤 빈 줄
//   ② c/java 재들여쓰기 — 실제 지저분한 기출 블록 · case 라벨 · 중괄호 없는 몸통 ·
//      문자열/주석 안의 중괄호 면역 · 이어지는 괄호
//   ③ python/미분류 — 줄 구조를 절대 바꾸지 않는다
//   ④ 멱등성 (합성 + 실제 data/rounds 전 블록)
//   ⑤ detect()
//   ⑥ applyTo() — jsdom DOM 위에서, "자식 엘리먼트 있으면 건너뛰기" 포함
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// window 가 없는 환경이므로 globalThis 에 붙는다.
require(path.join(ROOT, 'public', 'js', 'codefmt.js'));
const CodeFmt = globalThis.CodeFmt;

const { JSDOM } = require('jsdom');

/** 여러 줄 문자열을 읽기 쉽게 쓰기 위한 도우미 (배열 → 개행 결합). */
const L = (...lines) => lines.join('\n');

// 실제 회차 데이터의 코드 블록 — 여러 스위트가 함께 쓴다.
const ROUNDS_DIR = path.join(ROOT, 'data', 'rounds');
const LANGS_DIR = path.join(ROOT, 'data', 'langs');
const PRE_RE = /<pre class="code">([\s\S]*?)<\/pre>/g;

function decodeEntities(s) {
  return String(s)
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
}

function allBlocks() {
  if (!fs.existsSync(ROUNDS_DIR)) return [];
  const out = [];
  for (const f of fs.readdirSync(ROUNDS_DIR).filter((x) => x.endsWith('.json'))) {
    const round = f.replace(/\.json$/, '');
    let data;
    try { data = JSON.parse(fs.readFileSync(path.join(ROUNDS_DIR, f), 'utf8')); } catch { continue; }
    let langs = {};
    try {
      const j = JSON.parse(fs.readFileSync(path.join(LANGS_DIR, `${round}.json`), 'utf8'));
      if (j && j.langs) langs = j.langs;
    } catch { /* langs 오버레이는 아직 없을 수 있다 */ }
    for (const q of data.questions || []) {
      PRE_RE.lastIndex = 0;
      let m;
      let k = 0;
      while ((m = PRE_RE.exec(String(q.bodyHtml || ''))) !== null) {
        k++;
        const text = decodeEntities(m[1]);
        out.push({ id: `${q.id}[${k}]`, text, lang: langs[q.id] || CodeFmt.detect(text) });
      }
    }
  }
  return out;
}

const DATA_BLOCKS = allBlocks();

/** 원문 한 줄의 선행 공백을 "열"로 환산한다 (탭 정지 4칸) — 검증용 독립 구현. */
function indentColumns(line) {
  let col = 0;
  for (const ch of line) {
    if (ch === ' ') col += 1;
    else if (ch === '\t') col += 4 - (col % 4);
    else break;
  }
  return col;
}

describe('모듈 계약', () => {
  test('CodeFmt 가 노출되고 API 가 갖춰져 있다', () => {
    assert.ok(CodeFmt, 'globalThis.CodeFmt 가 있어야 한다');
    assert.deepEqual(Object.keys(CodeFmt).sort(), ['LANGS', 'applyTo', 'detect', 'normalize']);
    assert.deepEqual(CodeFmt.LANGS, ['c', 'java', 'python']);
    for (const k of ['detect', 'normalize', 'applyTo']) {
      assert.equal(typeof CodeFmt[k], 'function', k);
    }
  });

  test('빈 값·null 은 빈 문자열', () => {
    assert.equal(CodeFmt.normalize('', 'c'), '');
    assert.equal(CodeFmt.normalize(null, 'c'), '');
    assert.equal(CodeFmt.normalize(undefined), '');
    assert.equal(CodeFmt.normalize('   \n\n  \n'), '');
  });
});

// ------------------------------------------------------------- ① 공통 정규화

describe('공통 정규화 — 탭 · 공백 · 빈 줄', () => {
  test('탭은 탭 정지 4칸 기준으로 편다 (무조건 4칸이 아니다)', () => {
    // 선행 공백 1칸 뒤의 탭은 3칸만 채워 4열에 맞춘다.
    assert.equal(CodeFmt.normalize(L('a', ' \tb'), 'python'), L('a', '    b'));
    // 0열의 탭은 4칸.
    assert.equal(CodeFmt.normalize(L('a', '\tb'), 'python'), L('a', '    b'));
    // 3칸 뒤의 탭은 1칸.
    assert.equal(CodeFmt.normalize(L('a', '   \tb'), 'python'), L('a', '    b'));
    // 줄 중간의 탭도 열 기준 — 'ab' 는 2열이므로 2칸만 채운다.
    assert.equal(CodeFmt.normalize(L('ab\tc', 'x'), 'python'), L('ab  c', 'x'));
    // 탭 2개 연속: 0→4, 4→8.
    assert.equal(CodeFmt.normalize(L('a', '\t\tb'), 'python'), L('a', '        b'));
  });

  test('CRLF 는 LF 로, 줄 끝 공백은 사라진다', () => {
    assert.equal(CodeFmt.normalize('a  \r\nb\t\r\nc', 'python'), L('a', 'b', 'c'));
  });

  test('공통 선행 들여쓰기를 걷어낸다 (상대 들여쓰기는 유지)', () => {
    assert.equal(
      CodeFmt.normalize(L('    a', '      b', '    c'), 'python'),
      L('a', '  b', 'c')
    );
    // 빈 줄은 공통 들여쓰기 계산에 끼지 않는다.
    assert.equal(
      CodeFmt.normalize(L('  a', '', '    b'), 'python'),
      L('a', '', '  b')
    );
  });

  test('앞뒤 빈 줄은 잘리고 가운데 빈 줄은 남는다', () => {
    assert.equal(CodeFmt.normalize(L('', '  ', 'a', '', 'b', '   ', ''), 'python'), L('a', '', 'b'));
  });
});

// ------------------------------------------------- ② c/java 중괄호 재들여쓰기

describe('c/java 재들여쓰기 — 실제 기출 블록', () => {
  // 2020-1#12 원문 그대로 (탭·공백 혼용, 닫는 중괄호가 제멋대로).
  const MESSY_2020_1_12 = L(
    ' #include <stdio.h>',
    ' void main(){',
    ' \tint i,j;',
    '    int temp;',
    '    int a[5] = {75,95,85,100,50};',
    '',
    '    for(i=0; i<4; i++){',
    '    \tfor(j=0; j<4-i; j++){',
    '        \tif(a[j] > a[j+1]){',
    '            \ttemp=a[j];',
    '                a[j] = a[j+1];',
    '                a[j+1] = temp;',
    '             }',
    '           }',
    '        }',
    '',
    '       \tfor(i=0; i<5; i++){',
    '        \tprintf("%d", a[i]);',
    '        }',
    '  }'
  );

  const CLEAN_2020_1_12 = L(
    '#include <stdio.h>',
    'void main(){',
    '    int i,j;',
    '    int temp;',
    '    int a[5] = {75,95,85,100,50};',
    '',
    '    for(i=0; i<4; i++){',
    '        for(j=0; j<4-i; j++){',
    '            if(a[j] > a[j+1]){',
    '                temp=a[j];',
    '                a[j] = a[j+1];',
    '                a[j+1] = temp;',
    '            }',
    '        }',
    '    }',
    '',
    '    for(i=0; i<5; i++){',
    '        printf("%d", a[i]);',
    '    }',
    '}'
  );

  test('2020-1#12 이 4칸 계단으로 정리된다', () => {
    assert.equal(CodeFmt.normalize(MESSY_2020_1_12, 'c'), CLEAN_2020_1_12);
  });

  test('lang 을 안 줘도 detect 가 c 로 잡아 같은 결과를 낸다', () => {
    assert.equal(CodeFmt.normalize(MESSY_2020_1_12), CLEAN_2020_1_12);
    assert.equal(CodeFmt.normalize(MESSY_2020_1_12, null), CLEAN_2020_1_12);
  });

  test('그 결과를 다시 넣어도 그대로다 (멱등)', () => {
    assert.equal(CodeFmt.normalize(CLEAN_2020_1_12, 'c'), CLEAN_2020_1_12);
  });

  test('전처리기는 언제나 0열', () => {
    const out = CodeFmt.normalize(L('void f(){', '  #define X 1', '  int a;', '}'), 'c');
    assert.equal(out, L('void f(){', '#define X 1', '    int a;', '}'));
  });

  test('배열 초기화의 중괄호는 한 줄에서 열고 닫히므로 깊이가 안 변한다', () => {
    const out = CodeFmt.normalize(L('int main(){', 'int a[2] = {1,2};', 'int b = 0;', '}'), 'c');
    assert.equal(out, L('int main(){', '    int a[2] = {1,2};', '    int b = 0;', '}'));
  });

  test('} else { 와 }; 는 먼저 내어쓴다', () => {
    const out = CodeFmt.normalize(
      L('void f(){', 'if(a){', 'x();', '} else {', 'y();', '}', 'struct S {', 'int v;', '};', '}'),
      'c'
    );
    assert.equal(out, L(
      'void f(){',
      '    if(a){',
      '        x();',
      '    } else {',
      '        y();',
      '    }',
      '    struct S {',
      '        int v;',
      '    };',
      '}'
    ));
  });

  test('do { } while (…); 의 꼬리도 내어쓴다', () => {
    const out = CodeFmt.normalize(L('void f(){', 'do {', 'i++;', '} while (i < 3);', 'return;', '}'), 'c');
    assert.equal(out, L(
      'void f(){',
      '    do {',
      '        i++;',
      '    } while (i < 3);',
      '    return;',
      '}'
    ));
  });
});

describe('c/java 재들여쓰기 — case / default 라벨', () => {
  test('라벨은 switch 몸체 깊이, 그 뒤 문장은 한 칸 더', () => {
    const out = CodeFmt.normalize(L(
      'int main(){',
      'switch(a) {',
      'case 1:',
      'b += 1;',
      'case 11:',
      'b += 2;',
      'default:',
      'b += 3;',
      'break;',
      '}',
      'return 0;',
      '}'
    ), 'c');
    assert.equal(out, L(
      'int main(){',
      '    switch(a) {',
      '        case 1:',
      '            b += 1;',
      '        case 11:',
      '            b += 2;',
      '        default:',
      '            b += 3;',
      '            break;',
      '    }',
      '    return 0;',
      '}'
    ));
  });

  test('case 안에서 블록이 중첩돼도 라벨이 더한 한 칸이 따라간다', () => {
    const out = CodeFmt.normalize(L(
      'switch(x){',
      'case 1:',
      'if(y){',
      'z();',
      '}',
      'break;',
      '}'
    ), 'c');
    assert.equal(out, L(
      'switch(x){',
      '    case 1:',
      '        if(y){',
      '            z();',
      '        }',
      '        break;',
      '}'
    ));
  });

  test('switch 를 닫으면 case 보정이 사라진다', () => {
    const out = CodeFmt.normalize(L('void f(){', 'switch(x){', 'case 1: a();', '}', 'b();', '}'), 'c');
    assert.equal(out, L(
      'void f(){',
      '    switch(x){',
      '        case 1: a();',
      '    }',
      '    b();',
      '}'
    ));
  });
});

describe('c/java 재들여쓰기 — 중괄호 없는 제어문 몸통', () => {
  test('if 뒤 한 줄만 +1, 그 다음 줄은 되돌아온다', () => {
    const out = CodeFmt.normalize(L('void f(){', 'if (a)', 'x();', 'y();', '}'), 'c');
    assert.equal(out, L('void f(){', '    if (a)', '        x();', '    y();', '}'));
  });

  test('중첩된 머리는 누적된다 (if → for → 문장)', () => {
    const out = CodeFmt.normalize(L('void f(){', 'if (a)', 'for (i=0;i<3;i++)', 'x();', 'y();', '}'), 'c');
    assert.equal(out, L(
      'void f(){',
      '    if (a)',
      '        for (i=0;i<3;i++)',
      '            x();',
      '    y();',
      '}'
    ));
  });

  test('else 홀로 선 줄도 머리다', () => {
    const out = CodeFmt.normalize(L('void f(){', 'if (a)', 'x();', 'else', 'y();', 'z();', '}'), 'c');
    assert.equal(out, L(
      'void f(){',
      '    if (a)',
      '        x();',
      '    else',
      '        y();',
      '    z();',
      '}'
    ));
  });

  test('한 줄에 몸통까지 있으면(;로 끝) 다음 줄은 안 밀린다', () => {
    const out = CodeFmt.normalize(L('void f(){', 'if (a) x();', 'y();', '}'), 'c');
    assert.equal(out, L('void f(){', '    if (a) x();', '    y();', '}'));
  });

  test('머리 뒤에 여는 중괄호가 오면(Allman) 몸통이 두 번 밀리지 않는다', () => {
    const out = CodeFmt.normalize(L('if (a)', '{', 'x();', '}', 'y();'), 'c');
    assert.equal(out, L('if (a)', '{', '    x();', '}', 'y();'));
  });

  test('while (…); 은 머리가 아니다 (do-while 꼬리)', () => {
    const out = CodeFmt.normalize(L('void f(){', 'do', 'x();', 'while (a);', 'y();', '}'), 'c');
    assert.equal(out, L('void f(){', '    do', '        x();', '    while (a);', '    y();', '}'));
  });
});

// 교차 리뷰(H1~H3 · M1~M4)에서 나온 결함의 회귀 검사. 항목마다 한 덩이씩.
describe('교차 리뷰 회귀 — H1/M1 머리 판정은 "닫는 괄호가 줄 끝" 일 때만', () => {
  test('H1 · 세미콜론이 빠진 한 줄 몸통(2023-1#9)은 머리가 아니다', () => {
    const out = CodeFmt.normalize(L(
      'int main() {',
      'while (1) {',
      'if (input == 0) break',
      'else {',
      'sum = sum + 1;',
      '}',
      '}',
      '}'
    ), 'c');
    assert.equal(out, L(
      'int main() {',
      '    while (1) {',
      '        if (input == 0) break',
      '        else {',
      '            sum = sum + 1;',
      '        }',
      '    }',
      '}'
    ));
  });

  test('H1 · 실제 2023-1#9 블록에서 else 가 if 와 같은 열에 선다', () => {
    const src = L(
      'int main() {',
      '    while (1) {',
      '        if (input == 0) break',
      '        else {',
      '          sum = sum + (input (a)(b)) * di;',
      '             di = di * 2;',
      '        }',
      '    }',
      '}'
    );
    const lines = CodeFmt.normalize(src, 'c').split('\n');
    const ifLine = lines.find((x) => x.includes('if (input'));
    const elseLine = lines.find((x) => x.trim().startsWith('else'));
    assert.equal(elseLine.search(/\S/), ifLine.search(/\S/), '들여쓰기가 같아야 한다');
    assert.equal(ifLine.search(/\S/), 8);
  });

  test('M1 · 한 줄에 다 들어간 if (x) { a(); } 뒤는 밀리지 않는다', () => {
    const out = CodeFmt.normalize(L('void f(){', 'if (x) { a(); }', 'b();', '}'), 'c');
    assert.equal(out, L('void f(){', '    if (x) { a(); }', '    b();', '}'));
  });

  test('머리 판정 — 조건 뒤에 뭐가 붙으면 전부 머리가 아니다', () => {
    for (const head of ['if (a) return 1', 'if (a) x = 1', 'while (a) i++', 'for (i=0;i<3;i++) n++']) {
      const out = CodeFmt.normalize(L('void f(){', head, 'z();', '}'), 'c');
      assert.equal(out, L('void f(){', `    ${head}`, '    z();', '}'), head);
    }
  });

  test('머리 판정 — 조건 괄호로 끝나면 여전히 머리다 (줄 끝 주석 포함)', () => {
    const out = CodeFmt.normalize(L('void f(){', 'if (a) // 주석', 'x();', 'y();', '}'), 'c');
    assert.equal(out, L('void f(){', '    if (a) // 주석', '        x();', '    y();', '}'));
  });
});

describe('교차 리뷰 회귀 — H2 detect 는 리터럴에 속지 않고 Python 을 먼저 본다', () => {
  test('H2 · Python 문자열 안의 printf( 는 C 신호가 아니다', () => {
    const src = 'def f():\n    print("printf(")\n    return 0';
    assert.equal(CodeFmt.detect(src), 'python');
    assert.equal(CodeFmt.normalize(src), src, '구조가 그대로여야 한다');
  });

  test('H2 · Python 문자열 안의 System.out 은 Java 신호가 아니다', () => {
    const src = 's = "System.out"\nif s:\n    print(s);';
    assert.equal(CodeFmt.detect(src), 'python');
    assert.equal(CodeFmt.normalize(src), src);
  });

  test('H2 · 주석 안의 언어 신호도 무시된다', () => {
    assert.equal(CodeFmt.detect('a = 1\n// public class Foo\nfor x in [a]:\n    print(x)'), 'python');
  });

  test('H2 · 진짜 Java/C 는 여전히 제대로 잡힌다', () => {
    assert.equal(CodeFmt.detect('public class A {\n  int x;\n}'), 'java');
    assert.equal(CodeFmt.detect('#include <stdio.h>\nint main(){ printf("x"); }'), 'c');
  });

  test('H2 방어선 · 여는 중괄호가 없으면 lang=c/java 여도 재들여쓰기하지 않는다', () => {
    const py = 'def f():\n    if x:\n        return 1\n    return 0';
    assert.equal(CodeFmt.normalize(py, 'c'), py);
    assert.equal(CodeFmt.normalize(py, 'java'), py);
  });
});

describe('교차 리뷰 회귀 — R1 분류가 틀려도 Python 은 파괴하지 않는다', () => {
  // data/langs 는 사람이 손보는 오버레이라 언젠가 c/java 로 잘못 붙을 수 있다.
  // 그때도 Python 의 줄 구조는 지켜져야 한다 (되돌릴 수 없는 손상이므로).
  const PY_WITH_BRACES = L(
    'def f(x):',
    '    d = {"a": 1, "b": 2}',
    '    if x:',
    '        print(d["a"])',
    '    else:',
    '        print(d)',
    '    return d'
  );

  test('R1 · lang 이 c/java 로 잘못 붙어도 줄 구조가 그대로다', () => {
    // 중괄호(dict 리터럴)가 있어서 H2/H3 방어선만으로는 안 걸린다 — R1 봉인이 필요한 경우.
    assert.equal(PY_WITH_BRACES.includes('{'), true, '중괄호가 있어야 이 검사가 의미 있다');
    assert.equal(CodeFmt.normalize(PY_WITH_BRACES, 'c'), PY_WITH_BRACES);
    assert.equal(CodeFmt.normalize(PY_WITH_BRACES, 'java'), PY_WITH_BRACES);
    // 올바른 분류(python)·미분류와도 결과가 같아야 한다.
    assert.equal(CodeFmt.normalize(PY_WITH_BRACES, 'python'), PY_WITH_BRACES);
    assert.equal(CodeFmt.normalize(PY_WITH_BRACES, null), PY_WITH_BRACES);
  });

  test('R1 · 봉인은 Python 특유 줄이 2개 이상일 때만 (한 줄로는 안 걸린다)', () => {
    // `print(` 한 줄뿐 + 세미콜론 있음 → 평범한 C 로 보고 정상 재들여쓰기한다.
    const c = L('void f(){', 'print(1);', 'g();', '}');
    assert.equal(CodeFmt.normalize(c, 'c'), L('void f(){', '    print(1);', '    g();', '}'));
  });

  test('R1 · 세미콜론으로 끝나는 줄이 있으면 봉인하지 않는다 (진짜 C/Java 보호)', () => {
    const java = L(
      'class A {',
      'void f(int x){',
      'if (x > 0)',
      'g();',
      '}',
      '}'
    );
    assert.equal(CodeFmt.normalize(java, 'java'), L(
      'class A {',
      '    void f(int x){',
      '        if (x > 0)',
      '            g();',
      '    }',
      '}'
    ));
  });

  test('R1 · 실데이터 c/java 119블록 중 봉인에 걸리는 것이 하나도 없다', () => {
    // (아래 ⑦ 스위트가 로드하는 것과 같은 블록 집합을 쓴다)
    let checked = 0;
    for (const b of DATA_BLOCKS) {
      if (b.lang !== 'c' && b.lang !== 'java') continue;
      checked++;
      const out = CodeFmt.normalize(b.text, b.lang);
      const base = CodeFmt.normalize(b.text, 'python');
      // 중괄호가 있는 블록인데 결과가 기준선과 똑같다면 = 재들여쓰기를 안 탔다는 뜻.
      // 그런 블록은 "원래 이미 정돈돼 있던" 경우뿐이어야 하고, 봉인 오탐이면 안 된다.
      if (/\{/.test(base) && out === base) {
        // 봉인이 걸렸는지 직접 확인: python 특유 줄이 2개 이상이면 오탐이다.
        const pyish = base.split('\n').filter((x) =>
          /^[ \t]*def\s+\w/.test(x) ||
          /^[ \t]*class\s+\w[\w.,()[\] ]*:[ \t]*$/.test(x) ||
          /^[ \t]*(?:if|for|while|elif|else)\b.*:[ \t]*$/.test(x) ||
          /^[ \t]*print\s*\(/.test(x)
        ).length;
        assert.ok(pyish < 2, `${b.id} 가 Python 으로 오판됐다 (pyish=${pyish})`);
      }
    }
    assert.ok(checked > 100, `c/java 블록이 너무 적다: ${checked}`);
  });
});

describe('교차 리뷰 회귀 — H3 세미콜론만으로는 코드로 보지 않는다', () => {
  test('H3 · 의사코드 순서도 안의 PRINT X; 가 있어도 그림이 평탄해지지 않는다', () => {
    const art = L(
      '   +---> [1] X = 0',
      '   |         |',
      '   |         v',
      '   |    < 2 > X > K ?  ----YES----> [3] PRINT X;',
      '   |         |',
      '   +---------+'
    );
    const out = CodeFmt.normalize(art, 'c');
    assert.equal(out, L(
      '+---> [1] X = 0',
      '|         |',
      '|         v',
      '|    < 2 > X > K ?  ----YES----> [3] PRINT X;',
      '|         |',
      '+---------+'
    ));
  });

  test('H3 · 리터럴/주석 안에만 있는 중괄호는 코드 신호가 아니다', () => {
    const art = L('  A -> B   // { 여기는 주석 }', '    B -> C', '      C -> D');
    assert.equal(CodeFmt.normalize(art, 'c'), L('A -> B   // { 여기는 주석 }', '  B -> C', '    C -> D'));
  });
});

describe('교차 리뷰 회귀 — M2 한 줄에 여는 중괄호가 둘', () => {
  test('M2 · `if (a) { if (b) {` 는 두 칸 깊어진다', () => {
    const out = CodeFmt.normalize(L('void f(){', 'if (a) { if (b) {', 'x();', '}', '}', '}'), 'c');
    assert.equal(out, L(
      'void f(){',
      '    if (a) { if (b) {',
      '            x();',
      '        }',
      '    }',
      '}'
    ));
  });

  test('M2 · 한 줄에서 열고 닫는 중괄호는 깊이를 남기지 않는다', () => {
    const out = CodeFmt.normalize(L('void f(){', 'if (a) { x(); } else { y(); }', 'z();', '}'), 'c');
    assert.equal(out, L('void f(){', '    if (a) { x(); } else { y(); }', '    z();', '}'));
  });
});

describe('교차 리뷰 회귀 — M3 닫는 중괄호는 연 줄과 같은 열', () => {
  test('M3 · case 몸체가 블록이면 닫는 } 가 case 와 같은 열에 선다', () => {
    const out = CodeFmt.normalize(L(
      'void f(){',
      'switch (x) {',
      'case 1: {',
      'a();',
      '}',
      'break;',
      'default:',
      'b();',
      '}',
      '}'
    ), 'c');
    assert.equal(out, L(
      'void f(){',
      '    switch (x) {',
      '        case 1: {',
      '            a();',
      '        }',
      // `}` 는 `case 1: {` 와 같은 열(M3). 그 뒤의 break 는 여전히 case 몸체의 문장이라 +1 이다.
      '            break;',
      '        default:',
      '            b();',
      '    }',
      '}'
    ));
  });

  test('M3 · case 안의 일반 블록은 여전히 case 몸체 깊이에서 닫힌다', () => {
    const out = CodeFmt.normalize(L('switch(x){', 'case 1:', 'if(y){', 'z();', '}', 'break;', '}'), 'c');
    assert.equal(out, L(
      'switch(x){',
      '    case 1:',
      '        if(y){',
      '            z();',
      '        }',
      '        break;',
      '}'
    ));
  });
});

describe('교차 리뷰 회귀 — M4 람다/콜백의 괄호 연속', () => {
  test('M4 · `list.forEach(x -> {` 몸통은 +1, `});` 는 원래 열로', () => {
    const out = CodeFmt.normalize(L(
      'void f(){',
      'list.forEach(x -> {',
      'System.out.println(x);',
      '});',
      'done();',
      '}'
    ), 'java');
    assert.equal(out, L(
      'void f(){',
      '    list.forEach(x -> {',
      '        System.out.println(x);',
      '    });',
      '    done();',
      '}'
    ));
  });

  test('M4 · 괄호가 여러 줄에 걸친 뒤 여는 중괄호가 와도 몸통은 한 칸만', () => {
    const out = CodeFmt.normalize(L(
      'void f(){',
      'if (a &&',
      'b) {',
      'x();',
      '}',
      'y();',
      '}'
    ), 'c');
    assert.equal(out, L(
      'void f(){',
      '    if (a &&',
      '        b) {',
      '        x();',
      '    }',
      '    y();',
      '}'
    ));
  });

  test('M4 · 중괄호가 없는 인자 이어쓰기는 예전대로 +1 을 유지한다', () => {
    const out = CodeFmt.normalize(L('void f(){', 'g(a,', 'b);', 'h();', '}'), 'c');
    assert.equal(out, L('void f(){', '    g(a,', '        b);', '    h();', '}'));
  });
});

describe('교차 리뷰 회귀 — 여는 중괄호가 빠진 클래스 머리 (2020-2#5)', () => {
  test('`class parent` 아래 멤버가 0열로 평탄해지지 않는다', () => {
    const out = CodeFmt.normalize(L(
      'class parent',
      'public void show(){',
      'system.out.println("Parent");',
      '}',
      '}',
      '',
      'class Child extends Parent{',
      'public void show(){',
      'system.out.println("Child");',
      '}',
      '}'
    ), 'java');
    assert.equal(out, L(
      'class parent',
      '    public void show(){',
      '        system.out.println("Parent");',
      '    }',
      '}',
      '',
      'class Child extends Parent{',
      '    public void show(){',
      '        system.out.println("Child");',
      '    }',
      '}'
    ));
  });

  test('Allman 스타일(다음 줄에 `{`)은 가상 블록이 끼어들지 않는다', () => {
    const out = CodeFmt.normalize(L('class Foo', '{', 'int x;', '}'), 'java');
    assert.equal(out, L('class Foo', '{', '    int x;', '}'));
  });

  test('중괄호가 제대로 있는 클래스는 아무 영향이 없다', () => {
    const out = CodeFmt.normalize(L('class A {', 'int x;', '}', 'class B {', 'int y;', '}'), 'java');
    assert.equal(out, L('class A {', '    int x;', '}', 'class B {', '    int y;', '}'));
  });

  test('가상 블록은 다음 클래스 머리에서 닫힌다 (닫는 } 가 아예 없어도)', () => {
    const out = CodeFmt.normalize(L(
      'class A',
      'void f(){',
      'x();',
      '}',
      'class B',
      'void g(){',
      'y();',
      '}'
    ), 'java');
    assert.equal(out, L(
      'class A',
      '    void f(){',
      '        x();',
      '    }',
      'class B',
      '    void g(){',
      '        y();',
      '    }'
    ));
  });
});

describe('c/java 재들여쓰기 — 리터럴·주석 안의 중괄호는 세지 않는다', () => {
  test('문자열·문자 리터럴 안의 중괄호는 깊이를 바꾸지 않는다', () => {
    const out = CodeFmt.normalize(L(
      'int main(){',
      'printf("{");',
      'printf("}");',
      'char c = \'{\';',
      'printf("\\"}{\\"");',
      'int x = 1;',
      '}'
    ), 'c');
    assert.equal(out, L(
      'int main(){',
      '    printf("{");',
      '    printf("}");',
      '    char c = \'{\';',
      '    printf("\\"}{\\"");',
      '    int x = 1;',
      '}'
    ));
  });

  test('// 줄 주석 안의 중괄호도 무시된다', () => {
    const out = CodeFmt.normalize(L('int main(){', '// } } }', 'int x = 1;', '}'), 'c');
    assert.equal(out, L('int main(){', '    // } } }', '    int x = 1;', '}'));
  });

  test('한 줄짜리 블록 주석 안의 중괄호도 무시된다', () => {
    const out = CodeFmt.normalize(L('int main(){', '/* } { */', 'int x = 1;', '}'), 'c');
    assert.equal(out, L('int main(){', '    /* } { */', '    int x = 1;', '}'));
  });

  test('여러 줄 블록 주석은 상태가 이어지고 본문의 상대 들여쓰기가 유지된다', () => {
    const out = CodeFmt.normalize(L(
      'int main(){',
      '/* 여는 주석 {',
      '   가운데 줄 }',
      '     더 들어간 줄',
      '*/',
      'int x = 1;',
      '}'
    ), 'c');
    assert.equal(out, L(
      'int main(){',
      '    /* 여는 주석 {',
      '       가운데 줄 }',
      '         더 들어간 줄',
      '    */',
      '    int x = 1;',
      '}'
    ));
    // 주석 본문이 다시 흘러가지 않는지 (상대 간격 3칸·5칸 유지) 한 번 더 못박는다.
    const lines = out.split('\n');
    assert.equal(lines[3].search(/\S/) - lines[2].search(/\S/), 2);
  });

  test('문자열 안의 여는 주석 기호는 주석이 아니다', () => {
    const out = CodeFmt.normalize(L('int main(){', 'printf("/*");', 'int x = 1;', '}'), 'c');
    assert.equal(out, L('int main(){', '    printf("/*");', '    int x = 1;', '}'));
  });

  test('괄호가 안 닫힌 줄의 다음 줄은 이어지는 줄로 한 칸 더 들어간다', () => {
    const out = CodeFmt.normalize(L(
      'void f(){',
      'g(a,',
      'b);',
      'h();',
      '}'
    ), 'c');
    assert.equal(out, L('void f(){', '    g(a,', '        b);', '    h();', '}'));
  });
});

describe('c/java 재들여쓰기 — 코드가 아닌 블록은 건드리지 않는다', () => {
  test('중괄호도 세미콜론도 없는 ASCII 순서도는 구조가 보존된다', () => {
    // 2025-1#15 둘째 블록처럼 코드 문항 안에 그림이 들어 있는 경우.
    const art = L(
      '   [ 1 ]',
      '     |',
      '     v',
      '  +-- < 2 > --+',
      '  |           |',
      ' (거짓)      (참)'
    );
    const out = CodeFmt.normalize(art, 'c');
    // 공통 들여쓰기(1칸)만 빠지고 상대 정렬은 그대로다.
    assert.equal(out, L(
      '  [ 1 ]',
      '    |',
      '    v',
      ' +-- < 2 > --+',
      ' |           |',
      '(거짓)      (참)'
    ));
  });
});

// ------------------------------------------------- ③ python / 미분류는 그대로

describe('python · 미분류 — 줄 구조를 절대 바꾸지 않는다', () => {
  const PY = L(
    'class Good:',
    '\tli = ["seoul", "kyeonggi"]',
    '',
    '\tdef go(self):',
    '\t\tfor x in self.li:',
    '\t\t\tprint(x)',
    '\t\treturn 0'
  );

  test('탭만 공백으로 펴고 계단은 그대로 둔다', () => {
    assert.equal(CodeFmt.normalize(PY, 'python'), L(
      'class Good:',
      '    li = ["seoul", "kyeonggi"]',
      '',
      '    def go(self):',
      '        for x in self.li:',
      '            print(x)',
      '        return 0'
    ));
  });

  test('중괄호가 들어 있어도 python 이면 재들여쓰기하지 않는다', () => {
    const src = L('d = {', '  "a": 1,', '     "b": 2,', '}');
    assert.equal(CodeFmt.normalize(src, 'python'), src);
  });

  test('줄 수와 상대 들여쓰기 차이가 보존된다', () => {
    const before = PY.split('\n');
    const after = CodeFmt.normalize(PY, 'python').split('\n');
    assert.equal(before.length, after.length);
    for (let i = 0; i < before.length; i++) {
      assert.equal(before[i].trim(), after[i].trim(), `본문이 바뀌면 안 된다: ${i}`);
    }
  });

  test('미분류(detect 실패)도 python 과 같은 최소 정규화만 한다', () => {
    const art = L('    +---> [1]', '    |      |', '    |      v', '    +--- [2]');
    assert.equal(CodeFmt.normalize(art, null), L('+---> [1]', '|      |', '|      v', '+--- [2]'));
    assert.equal(CodeFmt.detect(art), null);
  });

  test('허용되지 않는 lang 값은 detect 로 떨어진다', () => {
    const c = L('int main(){', 'int x;', '}');
    assert.equal(CodeFmt.normalize(c, 'C'), CodeFmt.normalize(c, 'c'));
    assert.equal(CodeFmt.normalize(c, 'ruby'), CodeFmt.normalize(c, 'c'));
  });
});

// ------------------------------------------------------------------ ④ 멱등성

describe('멱등성', () => {
  const SAMPLES = [
    ['c', L('void main(){', '\tint a[3]={1,2,3};', '  if(a[0])', '   printf("{");', ' }')],
    ['c', L('switch(x){', 'case 1:', 'a();', 'default:', 'b();', '}')],
    ['java', L('public class A{', 'public static void main(String[] args){', 'System.out.print(1);', '}', '}')],
    ['java', L('class A {', '/* 여러', '   줄 주석 */', 'int x;', '}')],
    ['python', L('def f():', '\tif a:', '\t\treturn 1', '\treturn 0')],
    [null, L('   +---+', '   | a |', '   +---+')],
  ];

  test('합성 샘플 — normalize(normalize(x)) === normalize(x)', () => {
    for (const [lang, src] of SAMPLES) {
      const once = CodeFmt.normalize(src, lang);
      assert.equal(CodeFmt.normalize(once, lang), once, `lang=${lang}\n${once}`);
    }
  });
});

// ------------------------------------------------------------------- ⑤ detect

describe('detect', () => {
  test('C 스니펫', () => {
    assert.equal(CodeFmt.detect('#include <stdio.h>\nint main(){ return 0; }'), 'c');
    assert.equal(CodeFmt.detect('void main(){\n  printf("hi");\n}'), 'c');
    assert.equal(CodeFmt.detect('int main(void) {\n  scanf("%d", &a);\n}'), 'c');
  });

  test('Java 스니펫 — C 보다 먼저 본다', () => {
    assert.equal(CodeFmt.detect('public class A {\n  int x;\n}'), 'java');
    assert.equal(CodeFmt.detect('public static void main(String[] args) {}'), 'java');
    assert.equal(CodeFmt.detect('class A { void f(){ System.out.println(1); } }'), 'java');
    // Java 에도 printf 는 흔하다 — C 로 새면 안 된다.
    assert.equal(CodeFmt.detect('class A {\n  void f(){ System.out.printf("%d", 1); }\n}'), 'java');
  });

  test('Python 스니펫', () => {
    assert.equal(CodeFmt.detect('def f(x):\n    return x'), 'python');
    assert.equal(CodeFmt.detect('a = [1,2]\nfor x in a:\n    print(x)'), 'python');
    assert.equal(CodeFmt.detect('import sys\nprint(sys.argv)'), 'python');
    assert.equal(CodeFmt.detect('class Good:\n    li = []'), 'python');
    // printf( 는 print( 로 오인되면 안 된다 (여기선 C 로 잡혀야 한다).
    assert.equal(CodeFmt.detect('printf("%d", 1);'), 'c');
  });

  test('애매하면 null', () => {
    assert.equal(CodeFmt.detect(''), null);
    assert.equal(CodeFmt.detect(null), null);
    assert.equal(CodeFmt.detect('SELECT * FROM 학생;'), null);
    assert.equal(CodeFmt.detect('+---+\n| a |\n+---+'), null);
    assert.equal(CodeFmt.detect('1 4 7 10 13'), null);
  });
});

// ------------------------------------------------------------------ ⑥ applyTo

describe('applyTo — DOM 제자리 교체', () => {
  function dom(html) {
    return new JSDOM(`<!doctype html><body>${html}</body>`).window.document;
  }

  test('root 아래의 pre.code 를 정규화하고 바뀐 개수를 돌려준다', () => {
    const doc = dom(
      '<div id="r">' +
      '<pre class="code">void main(){\n\tint a;\n }</pre>' +
      '<pre class="code">int f(){\nreturn 1;\n}</pre>' +
      '</div>'
    );
    const root = doc.getElementById('r');
    assert.equal(CodeFmt.applyTo(root, 'c'), 2);
    const pres = root.querySelectorAll('pre.code');
    assert.equal(pres[0].textContent, L('void main(){', '    int a;', '}'));
    assert.equal(pres[1].textContent, L('int f(){', '    return 1;', '}'));
    // 이미 정규화된 뒤에는 바뀌는 게 없다.
    assert.equal(CodeFmt.applyTo(root, 'c'), 0);
  });

  test('root 자신이 pre.code 여도 처리한다 (중복 처리하지 않는다)', () => {
    const doc = dom('<pre class="code" id="p">void main(){\nint a;\n}</pre>');
    const pre = doc.getElementById('p');
    assert.equal(CodeFmt.applyTo(pre, 'c'), 1);
    assert.equal(pre.textContent, L('void main(){', '    int a;', '}'));
    assert.equal(CodeFmt.applyTo(pre, 'c'), 0);
  });

  test('자식 엘리먼트가 있는 블록은 건너뛴다 (마크업 보존)', () => {
    const doc = dom(
      '<div id="r">' +
      '<pre class="code">void f(){\n<span class="hl">int a;</span>\n}</pre>' +
      '<pre class="code">void g(){\nint b;\n}</pre>' +
      '</div>'
    );
    const root = doc.getElementById('r');
    assert.equal(CodeFmt.applyTo(root, 'c'), 1, '자식 있는 블록은 세지 않는다');
    assert.equal(root.querySelectorAll('pre.code span').length, 1, 'span 이 살아 있어야 한다');
    assert.equal(root.querySelectorAll('pre.code')[1].textContent, L('void g(){', '    int b;', '}'));
  });

  test('pre.code 가 아닌 것은 건드리지 않는다', () => {
    const doc = dom(
      '<div id="r">' +
      '<pre>void f(){\nint a;\n}</pre>' +
      '<pre class="boki">void f(){\nint a;\n}</pre>' +
      '<code class="code">void f(){\nint a;\n}</code>' +
      '</div>'
    );
    const root = doc.getElementById('r');
    assert.equal(CodeFmt.applyTo(root, 'c'), 0);
    assert.equal(root.querySelector('pre').textContent, 'void f(){\nint a;\n}');
  });

  test('class 가 여러 개여도 code 가 있으면 대상이다', () => {
    const doc = dom('<div id="r"><pre class="code wide">void f(){\nint a;\n}</pre></div>');
    assert.equal(CodeFmt.applyTo(doc.getElementById('r'), 'c'), 1);
  });

  test('lang 을 생략하면 블록마다 detect 로 판단한다', () => {
    const doc = dom(
      '<div id="r">' +
      '<pre class="code">#include &lt;stdio.h&gt;\nint main(){\nint a;\n}</pre>' +
      '<pre class="code">def f():\n\treturn 1</pre>' +
      '</div>'
    );
    const root = doc.getElementById('r');
    assert.equal(CodeFmt.applyTo(root), 2);
    const pres = root.querySelectorAll('pre.code');
    assert.equal(pres[0].textContent, L('#include <stdio.h>', 'int main(){', '    int a;', '}'));
    assert.equal(pres[1].textContent, L('def f():', '    return 1'));
  });

  test('DOM 이 없거나 이상한 인자에도 던지지 않는다', () => {
    assert.equal(CodeFmt.applyTo(null, 'c'), 0);
    assert.equal(CodeFmt.applyTo(undefined), 0);
    assert.equal(CodeFmt.applyTo('문자열', 'c'), 0);
    assert.equal(CodeFmt.applyTo({}, 'c'), 0);
    assert.equal(CodeFmt.applyTo({ nodeType: 1, tagName: 'PRE', className: 'code' }, 'c'), 0);
  });
});

// -------------------------------------------- ⑦ 실제 데이터 전 블록 안전성

describe('실제 data/rounds 블록 — 멱등 · python/미분류 구조 보존', () => {
  const BLOCKS = DATA_BLOCKS;

  test('블록이 실제로 로드된다', () => {
    assert.ok(BLOCKS.length > 100, `코드 블록이 너무 적다: ${BLOCKS.length}`);
  });

  test('전 블록이 멱등이다', () => {
    for (const b of BLOCKS) {
      const once = CodeFmt.normalize(b.text, b.lang);
      assert.equal(CodeFmt.normalize(once, b.lang), once, `${b.id} (lang=${b.lang})`);
    }
  });

  test('어느 블록도 줄 수가 늘거나 줄지 않는다 (앞뒤 빈 줄 제외)', () => {
    for (const b of BLOCKS) {
      const before = CodeFmt.normalize(b.text, 'python').split('\n');   // 공통 정규화만 한 기준선
      const after = CodeFmt.normalize(b.text, b.lang).split('\n');
      assert.equal(after.length, before.length, `${b.id} 줄 수가 바뀌었다`);
      for (let i = 0; i < before.length; i++) {
        assert.equal(after[i].trim(), before[i].trim(), `${b.id}:${i + 1} 본문이 바뀌었다`);
      }
    }
  });

  test('python 블록은 상대 들여쓰기까지 그대로다', () => {
    let n = 0;
    for (const b of BLOCKS) {
      if (b.lang !== 'python') continue;
      n++;
      // 원문의 들여쓰기를 (탭 정지 4칸으로) 열로 환산한 값과, 출력의 들여쓰기가
      // **일정한 상수만큼**만 차이 나야 한다 = 공통 들여쓰기 제거 외에 아무것도 안 했다.
      const src = b.text.replace(/\r\n?/g, '\n').split('\n');
      const out = CodeFmt.normalize(b.text, 'python').split('\n');
      const si = src.filter((x) => x.trim()).map(indentColumns);
      const oi = out.filter((x) => x.trim()).map((x) => x.search(/\S/));
      assert.equal(oi.length, si.length, `${b.id} 줄 수`);
      const drop = si.length ? si[0] - oi[0] : 0;
      for (let i = 0; i < si.length; i++) {
        assert.equal(oi[i], si[i] - drop, `${b.id} 비코드줄 ${i + 1} 의 들여쓰기가 옮겨졌다`);
      }
    }
    assert.ok(n > 0, 'python 블록이 하나도 없다 (data/langs 확인)');
  });

  test('c/java 블록의 들여쓰기는 전부 4의 배수다', () => {
    let n = 0;
    for (const b of BLOCKS) {
      if (b.lang !== 'c' && b.lang !== 'java') continue;
      const out = CodeFmt.normalize(b.text, b.lang);
      // 중괄호도 세미콜론도 없는 블록(그림)은 재들여쓰기 대상이 아니다.
      if (!/[{};]/.test(out)) continue;
      n++;
      const lines = out.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (!lines[i].trim()) continue;
        const indent = lines[i].search(/\S/);
        assert.equal(indent % 4, 0, `${b.id}:${i + 1} 들여쓰기 ${indent}\n${lines[i]}`);
      }
    }
    assert.ok(n > 50, `c/java 블록이 너무 적다: ${n}`);
  });
});
